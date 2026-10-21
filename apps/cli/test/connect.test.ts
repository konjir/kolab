// `konjir connect` (W3.7, D59): one command connects a harness to a kolab, one agent per entry.
// The config writing for both harnesses (merging, refusing to overwrite, --force, the diff,
// OpenCode's JSON with comments, and no token anywhere), and the done-when scenario: two OpenCode
// entries, product and engineer, each signing in as its own agent against a local Kolab with the
// stub identity provider. OpenCode's `opencode mcp auth` is played by the MCP SDK's own auth(), as
// OpenCode's McpOAuthProvider drives it, with the entry's oauth.scope as its client metadata's
// scope; the person's "browser" follows Kolab's redirects with its cookies and clicks Allow on the
// page as it arrives, preselected.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { auth, type OAuthClientProvider, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client';
import { StubIdentity, startServer } from '@konjir/server';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';
import { call, connect, main, personSession } from '../src/cli.js';
import { parseTree, valueOf } from '../src/jsonc.js';
import { connectHarness, mergeClaude, mergeOpencode, parseAgents, unifiedDiff, writeAtomically, type ConnectIO, type ConnectOptions, type Entry } from '../src/connect.js';

const URL_ = 'https://kolab.example/mcp';
const entry = (label: string, role: 'product' | 'engineer', over: Partial<Entry> = {}): Entry =>
  ({ name: `konjir-${label}`, agent: `ann-${label}`, label, role, kolab: 'anns', url: URL_, ...over });
/** What OpenCode reads in a file: JSON with comments and trailing commas. */
const jsonc = { parse: (text: string) => valueOf(parseTree(text)) };
const scratch = () => mkdtempSync(join(tmpdir(), 'konjir-connect-'));

// ---- the agents konjir connect is asked for ----

test('--agent <label>[:<role>]: by default product and engineer; a role\'s name is its own role; anything else says its role', () => {
  expect(parseAgents([])).toStrictEqual([{ label: 'product', role: 'product' }, { label: 'engineer', role: 'engineer' }]);
  expect(parseAgents(['pm:product', 'engineer', 'review:engineer'])).toStrictEqual([{ label: 'pm', role: 'product' }, { label: 'engineer', role: 'engineer' }, { label: 'review', role: 'engineer' }]);
  expect(() => parseAgents(['pm'])).toThrow(/say the agent's role, pm:product or pm:engineer/);
  expect(() => parseAgents(['pm:designer'])).toThrow(/say the agent's role/);
  expect(() => parseAgents(['Bad:product'])).toThrow(/up to 24 lowercase letters/);
  expect(() => parseAgents(['a:product:x'])).toThrow(/give <label>\[:<role>\]/);
  expect(() => parseAgents(['pm:product', 'pm:engineer'])).toThrow(/--agent pm is named twice/);
});

// ---- OpenCode's opencode.json ----

test('JSON with comments: plain JSON reads as JSON.parse reads it; comments and trailing commas are allowed; anything else is refused, naming its line', () => {
  for (const plain of ['{}', '[]', '"x"', '0', '-1.5e3', 'true', 'null', '{"a":[1,{"b":"\\u00e9\\n\\"q\\""}],"c":{}}', '{"a":1,"a":2}', '﻿{"x":1}']) {
    expect([plain, jsonc.parse(plain)]).toStrictEqual([plain, JSON.parse(plain.replace(/^﻿/, ''))]);
  }
  expect(jsonc.parse('// lead\n{ /* a */ "a": [1, 2,], // b\n "c": "//not a comment", }\n')).toStrictEqual({ a: [1, 2], c: '//not a comment' });
  for (const [bad, line] of [['{ "a": 1 "b": 2 }', 1], ['{\n "a": ,\n}', 2], ['{ "a": 1,, }', 1], ['[,]', 1], ['{ a: 1 }', 1], ['{ "a": 1 }\n x', 2], ['{ /* open', 1], ['{ "a": "b\n" }', 1], ['{ "a": 01 }', 1], ['', 1], ['{ "a": undefined }', 1]] as const) {
    expect(() => parseTree(bad)).toThrow(new RegExp(`on line ${line}$`));
  }
});

test('OpenCode: a new opencode.json has just the entries, each a remote server whose OAuth scope names its agent, kolab and role, and no token', () => {
  const out = mergeOpencode('opencode.json', '', [entry('product', 'product'), entry('engineer', 'engineer')], false);
  expect(JSON.parse(out)).toStrictEqual({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      'konjir-product': { type: 'remote', url: URL_, oauth: { scope: 'konjir kolab:anns role:product agent:ann-product' } },
      'konjir-engineer': { type: 'remote', url: URL_, oauth: { scope: 'konjir kolab:anns role:engineer agent:ann-engineer' } },
    },
  });
  expect(out).not.toMatch(/kj[src]_|token|bearer|authorization|headers/i);
});

test('OpenCode: merged into a file with comments, trailing commas, tabs and other servers, every other key, comment and line is kept', () => {
  const before = [
    '{',
    '\t// my settings',
    '\t"$schema": "https://opencode.ai/config.json",',
    '\t"model": "anthropic/claude", /* the default */',
    '\t"mcp": {',
    '\t\t"github": { "type": "remote", "url": "https://api.github.example/mcp" }, // keep me',
    '\t},',
    '}',
    '',
  ].join('\n');
  const out = mergeOpencode('opencode.json', before, [entry('product', 'product')], false);
  for (const line of before.split('\n').slice(0, 6)) expect(out).toContain(line);
  expect(out).toContain('\t\t"konjir-product": {\n\t\t\t"type": "remote",');   // the file's own tabs
  const parsed = jsonc.parse(out) as { model: string; mcp: Record<string, unknown> };
  expect(parsed.model).toBe('anthropic/claude');
  expect(Object.keys(parsed.mcp)).toStrictEqual(['github', 'konjir-product']);
  // A file without mcp gets one, at the file's own indentation (four spaces here).
  const plain = mergeOpencode('opencode.json', '{\n    "theme": "dark"\n}\n', [entry('engineer', 'engineer')], false);
  expect(plain).toContain('    "theme": "dark",\n    "mcp": {\n        "konjir-engineer": {');
  // Odd shapes still come out as JSON OpenCode reads, with the entry and nothing else changed.
  for (const odd of ['{}', '{ "mcp": {} }', '{"a": 1}', '{ "a": 1, }', '{ "a": 1 /* c */ }', '{\r\n  "a": 1\r\n}\r\n', '{\n  "mcp": {\n    // none yet\n  }\n}']) {
    const parsed = jsonc.parse(mergeOpencode('opencode.json', odd, [entry('product', 'product')], false)) as { mcp: Record<string, unknown>; a?: number };
    expect([odd, Object.keys(parsed.mcp), parsed.a]).toStrictEqual([odd, ['konjir-product'], odd.includes('"a"') ? 1 : undefined]);
  }
  expect(mergeOpencode('opencode.json', '{\r\n  "a": 1\r\n}\r\n', [entry('product', 'product')], false)).not.toMatch(/[^\r]\n/);
});

test('OpenCode: an entry already there is refused without --force, and replaced in place with it; a file OpenCode couldn\'t read is never touched', () => {
  const before = '{\n  "mcp": {\n    "konjir-product": { "type": "remote", "url": "https://old.example/mcp" },\n    "other": { "type": "local", "command": ["x"] }\n  }\n}\n';
  expect(() => mergeOpencode('opencode.json', before, [entry('product', 'product'), entry('engineer', 'engineer')], false))
    .toThrow(/opencode.json already has konjir-product. konjir connect won't overwrite it: pass --force to replace it/);
  const forced = jsonc.parse(mergeOpencode('opencode.json', before, [entry('product', 'product')], true)) as { mcp: Record<string, { url: string }> };
  expect(forced.mcp['konjir-product'].url).toBe(URL_);
  expect(Object.keys(forced.mcp)).toStrictEqual(['konjir-product', 'other']);
  expect(() => mergeOpencode('opencode.json', '{ "mcp": { ', [entry('product', 'product')], false)).toThrow(/isn't JSON that OpenCode reads \(.+ on line 1\), so konjir connect won't touch it/);
  expect(() => mergeOpencode('opencode.json', '[1]', [entry('product', 'product')], false)).toThrow(/not a JSON object/);
  expect(() => mergeOpencode('opencode.json', '{ "mcp": [] }', [entry('product', 'product')], false)).toThrow(/its "mcp" isn't an object/);
});

// ---- Claude Code's .mcp.json ----

test('Claude Code: .mcp.json exactly as `claude mcp add --scope project --transport http` writes it, with the scope in its OAuth settings; other servers kept', () => {
  const fresh = mergeClaude('.mcp.json', '', [entry('product', 'product')], false);
  // What claude mcp add --scope project --transport http konjir-product <url> writes, byte for byte, plus oauth.scopes.
  expect(fresh).toBe(`{\n  "mcpServers": {\n    "konjir-product": {\n      "type": "http",\n      "url": "${URL_}",\n      "oauth": {\n        "scopes": "konjir kolab:anns role:product agent:ann-product"\n      }\n    }\n  }\n}`);
  const before = JSON.stringify({ mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } }, other: 1 }, null, 2);
  const merged = JSON.parse(mergeClaude('.mcp.json', before, [entry('engineer', 'engineer')], false));
  expect(Object.keys(merged.mcpServers)).toStrictEqual(['sentry', 'konjir-engineer']);
  expect(merged.other).toBe(1);
  expect(() => mergeClaude('.mcp.json', fresh, [entry('product', 'product')], false)).toThrow(/already has konjir-product. konjir connect won't overwrite it/);
  expect(JSON.parse(mergeClaude('.mcp.json', fresh, [entry('product', 'engineer')], true)).mcpServers['konjir-product'].oauth.scopes).toBe('konjir kolab:anns role:engineer agent:ann-product');
  expect(() => mergeClaude('.mcp.json', '{ // no', [entry('product', 'product')], false)).toThrow(/isn't JSON/);
  expect(fresh).not.toMatch(/kj[src]_|token|bearer|authorization|headers/i);
});

test('the diff shows what is added and what is kept, and a file is written atomically: through a link, keeping its mode', () => {
  const before = '{\n  "a": 1\n}\n';
  const after = '{\n  "a": 1,\n  "mcp": {}\n}\n';
  expect(unifiedDiff('x.json', before, after, true)).toBe('--- x.json\n+++ x.json\n@@ -1,4 +1,5 @@\n {\n-  "a": 1\n+  "a": 1,\n+  "mcp": {}\n }\n ');
  expect(unifiedDiff('x.json', '', '{}', false)).toBe('--- /dev/null\n+++ x.json\n@@ -0,0 +1,1 @@\n+{}');

  const dir = scratch();
  mkdirSync(join(dir, 'real'));
  writeFileSync(join(dir, 'real', 'opencode.json'), '{}', { mode: 0o600 });
  symlinkSync(join(dir, 'real', 'opencode.json'), join(dir, 'opencode.json'));
  writeAtomically(join(dir, 'opencode.json'), '{"x":1}');
  expect(lstatSync(join(dir, 'opencode.json')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(dir, 'opencode.json'))).toBe(join(dir, 'real', 'opencode.json'));
  expect(readFileSync(join(dir, 'real', 'opencode.json'), 'utf8')).toBe('{"x":1}');
  expect(statSync(join(dir, 'real', 'opencode.json')).mode & 0o777).toBe(0o600);
});

// ---- end to end, against a local Kolab ----

/**
 * The person's browser at Kolab: follows its redirects with its cookies to the consent page, then
 * submits it. `form` says what to change; by default the page is submitted as it arrived, its
 * preselected choices untouched (the person checks them, then clicks Allow). Returns the page and
 * where Kolab sent the browser back to; with `deliver`, the browser goes there too (the CLI's own
 * loopback listener).
 */
async function consentAt(start: URL, form: Record<string, string> = {}, deliver = false): Promise<{ html: string; back: URL }> {
  const jar = new Map<string, string>();
  const go = async (url: URL, init: RequestInit = {}) => {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; jar.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)); }
    return res;
  };
  let url = start;
  let res = await go(url);
  while (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get('location')!, url); res = await go(url); }
  const html = await res.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  const csrf = field('csrf');
  if (!csrf) throw new Error(`no consent page at ${url.pathname}: ${res.status} ${html.slice(0, 300)}`);
  const shown = Object.fromEntries([...html.matchAll(/name="(as|kolab|role)" value="([^"]+)" checked/g)].map((m) => [m[1], m[2]]));
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, sign_in: field('sign_in') ?? '', decision: 'allow', ...shown, ...form }).toString(),
  });
  if (done.status !== 303) throw new Error(`the consent was refused: ${done.status} ${(await done.text()).slice(0, 400)}`);
  const back = new URL(done.headers.get('location')!);
  if (deliver) await (await fetch(back)).text();
  return { html, back };
}

/**
 * `opencode mcp auth <name>`, run in `cwd`: OpenCode reads the entry from opencode.json, and its
 * McpOAuthProvider (client name OpenCode, the loopback callback on 19876, the entry's oauth.scope
 * as its metadata's scope) signs in through the MCP SDK's auth(). Its tokens stay in OpenCode's own
 * store, here `store`, never in the project.
 */
function opencode(server: { url: string }, idp: StubIdentity, store: Map<string, StoredOAuthTokens>, pages: Map<string, string>) {
  return async (cwd: string, name: string): Promise<number> => {
    const config = jsonc.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')) as { mcp: Record<string, { type: string; url: string; oauth?: { scope?: string } }> };
    const e = config.mcp[name];
    if (e?.type !== 'remote') return 1;
    const redirectUrl = 'http://127.0.0.1:19876/mcp/oauth/callback';
    let info: StoredOAuthClientInformation | undefined;
    let verifier = '';
    let opened: URL | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() { return redirectUrl; },
      get clientMetadata() {
        return { redirect_uris: [redirectUrl], client_name: 'OpenCode', client_uri: 'https://opencode.ai', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(e.oauth?.scope ? { scope: e.oauth.scope } : {}) };
      },
      state: () => `state-${name}`,
      clientInformation: () => info,
      saveClientInformation: (i) => { info = i; },
      tokens: () => store.get(name),
      saveTokens: (t) => { store.set(name, t); },
      redirectToAuthorization: (u) => { opened = u; },
      saveCodeVerifier: (v) => { verifier = v; },
      codeVerifier: () => verifier,
    };
    expect(e.url).toBe(server.url);
    if (await auth(provider, { serverUrl: e.url }) !== 'REDIRECT') return 1;
    idp.next({ subject: '41', login: 'ann' });
    const { html, back } = await consentAt(opened!);
    pages.set(name, html);
    return await auth(provider, { serverUrl: e.url, authorizationCode: back.searchParams.get('code')!, iss: back.searchParams.get('iss') ?? undefined }) === 'AUTHORIZED' ? 0 : 1;
  };
}

const env = { ...process.env };
let out: string[];
beforeEach(() => {
  out = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  delete process.env.KONJIR_TOKEN;
  process.env.KONJIR_CREDENTIALS = join(scratch(), 'konjir', 'credentials.json');
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...env };
});

/** A local Kolab with the stub identity provider in GitHub's place, and Ann, new, about to sign in. */
async function local() {
  const kolab = await openKolab();
  const idp = new StubIdentity();
  const server = await startServer({ adminToken: 'connect-admin', kolab, identity: idp, webRoot: null });
  closeAtEnd(server);
  return { kolab, idp, server };
}

/** konjir connect's world: a terminal that says yes (or `answer`), the harnesses as `run`, and Ann's sign-in, `konjir login` first if need be. */
function world(server: { url: string }, idp: StubIdentity, run: ConnectIO['run'], o: { answer?: boolean; interactive?: boolean; asked?: string[] } = {}): ConnectIO & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (l) => lines.push(l),
    interactive: o.interactive ?? true,
    confirm: async (q) => { o.asked?.push(q); return o.answer ?? true; },
    run,
    person: () => personSession(server.url, undefined, {
      // konjir login, as yourself: Ann, new here, makes her first kolab on the way.
      open: (u) => { idp.next({ subject: '41', login: 'ann' }); void consentAt(u, { kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s' }, true); },
    }),
  };
}

const options = (server: { url: string }, cwd: string, over: Partial<ConnectOptions> = {}): ConnectOptions => ({
  harness: 'opencode', url: server.url, agents: parseAgents([]), global: false, force: false, yes: false, auth: true, cwd, env: {}, ...over,
});

test('done when: one command sets up two OpenCode agents, product and engineer, in a project, and each signs in as its own agent, with no hand-edited config', async () => {
  const { kolab, idp, server } = await local();
  const project = scratch();
  const store = new Map<string, StoredOAuthTokens>();
  const pages = new Map<string, string>();
  const auths: string[] = [];
  const signIn = opencode(server, idp, store, pages);
  const asked: string[] = [];
  const io = world(server, idp, async (cmd, args, { cwd }) => {
    auths.push([cmd, ...args].join(' '));
    expect(cmd).toBe('opencode');
    return signIn(cwd, args[2]);
  }, { asked });

  // konjir connect opencode: no sign-in yet, so konjir login first, as Ann herself.
  const entries = await connectHarness(options(server, project), io);
  expect(entries.map((e) => [e.name, e.agent, e.role, e.kolab])).toStrictEqual([['konjir-product', 'ann-product', 'product', 'anns'], ['konjir-engineer', 'ann-engineer', 'engineer', 'anns']]);
  // It showed the diff and asked before writing.
  expect(asked).toStrictEqual([`Make these agents and write ${join(project, 'opencode.json')}?`]);
  const diff = io.lines.join('\n');
  expect(diff).toContain(`--- /dev/null\n+++ ${join(project, 'opencode.json')}`);
  expect(diff).toContain('+    "konjir-product": {');
  expect(diff).toContain('Made your agent ann-product.');
  expect(diff).toContain('Made your agent ann-engineer.');
  // Each harness sign-in, one at a time, each as its own agent.
  expect(auths).toStrictEqual(['opencode mcp auth konjir-product', 'opencode mcp auth konjir-engineer']);
  expect(diff).toContain('Connected: each entry works as its own agent in anns.');

  // Kolab's page arrived with each entry's agent, kolab and role chosen.
  const checked = (html: string) => [...html.matchAll(/value="([^"]+)" checked/g)].map((m) => m[1]);
  expect(checked(pages.get('konjir-product')!)).toStrictEqual(['agent:ann-product', 'kolab:anns', 'product']);
  expect(checked(pages.get('konjir-engineer')!)).toStrictEqual(['agent:ann-engineer', 'kolab:anns', 'engineer']);
  expect(pages.get('konjir-product')).toContain('<strong>OpenCode</strong>');

  // Both work at once, each as its own agent, with what its owner lent it there (D30).
  const product = await connect(server.url, store.get('konjir-product')!.access_token);
  const engineer = await connect(server.url, store.get('konjir-engineer')!.access_token);
  closeAtEnd(product, engineer);
  expect(await call(product, 'whoami')).toMatchObject({ actor: 'ann-product', kind: 'agent', owner: 'ann', kolab: 'anns', role: 'product', access: { level: 'write', layers: ['functional', 'technical'] } });
  expect(await call(engineer, 'whoami')).toMatchObject({ actor: 'ann-engineer', kind: 'agent', owner: 'ann', kolab: 'anns', role: 'engineer' });
  await call(product, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' });
  expect(JSON.stringify(await call(engineer, 'list_nodes'))).toContain('checkout');
  // An agent's session makes no agents (D59).
  expect(await rejection(call(product, 'create_agent', { label: 'more' }))).toMatch(/ann-product is an agent: only a person makes agents/);

  // The project's config: the two entries, and no token anywhere in it, nor any secret Kolab issued.
  const text = readFileSync(join(project, 'opencode.json'), 'utf8');
  expect(JSON.parse(text).mcp).toStrictEqual({
    'konjir-product': { type: 'remote', url: server.url, oauth: { scope: 'konjir kolab:anns role:product agent:ann-product' } },
    'konjir-engineer': { type: 'remote', url: server.url, oauth: { scope: 'konjir kolab:anns role:engineer agent:ann-engineer' } },
  });
  const secrets = [...store.values()].flatMap((t) => [t.access_token, t.refresh_token!]);
  const cli = JSON.parse(readFileSync(process.env.KONJIR_CREDENTIALS!, 'utf8'))[server.url].tokens;
  for (const s of [...secrets, cli.access_token, cli.refresh_token]) expect(text).not.toContain(s);
  expect(text).not.toMatch(/kj[sr]_/);

  // Again: refused without --force, nothing changed and nothing made.
  expect(await rejection(connectHarness(options(server, project), world(server, idp, async () => 0)))).toMatch(/already has konjir-product, konjir-engineer. konjir connect won't overwrite them: pass --force/);
  expect(readFileSync(join(project, 'opencode.json'), 'utf8')).toBe(text);
  // With --force and --yes (a script): the same agents, found again, and the same file.
  const again = world(server, idp, async () => 0);
  await connectHarness(options(server, project, { force: true, yes: true, auth: false }), again);
  expect(again.lines).toContain('Using your agent ann-product.');
  expect(again.lines).toContain(`${join(project, 'opencode.json')} already says exactly this.`);
  expect(again.lines.join('\n')).toContain('opencode mcp auth konjir-engineer');
  expect((await kolab.listActors({ owner: 'ann' })).map((a) => a.id)).toStrictEqual(['ann-engineer', 'ann-product']);
});

test('nothing is written and no agent made until the person says yes: declined, or no terminal without --yes', async () => {
  const { kolab, idp, server } = await local();
  const project = scratch();
  writeFileSync(join(project, 'opencode.json'), '{\n  // mine\n  "theme": "dark"\n}\n');
  const no = world(server, idp, async () => 0, { answer: false });
  expect(await connectHarness(options(server, project), no)).toStrictEqual([]);
  expect(no.lines).toContain('Nothing written, and no agent made.');
  expect(await rejection(connectHarness(options(server, project), world(server, idp, async () => 0, { interactive: false })))).toMatch(/asks before it writes anything: run it in a terminal, or pass --yes/);
  expect(readFileSync(join(project, 'opencode.json'), 'utf8')).toBe('{\n  // mine\n  "theme": "dark"\n}\n');
  expect(await kolab.listActors({ owner: 'ann' })).toStrictEqual([]);
});

test('Claude Code: the project\'s .mcp.json, then the /mcp steps to sign each entry in; and --global OpenCode writes the person\'s own config', async () => {
  const { idp, server } = await local();
  const project = scratch();
  const io = world(server, idp, async () => { throw new Error('nothing to run for Claude Code'); });
  await connectHarness(options(server, project, { harness: 'claude', agents: parseAgents(['pm:product']), yes: true }), io);
  expect(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'))).toStrictEqual({
    mcpServers: { 'konjir-pm': { type: 'http', url: server.url, oauth: { scopes: 'konjir kolab:anns role:product agent:ann-pm' } } },
  });
  const said = io.lines.join('\n');
  expect(said).toContain('Run claude, and type /mcp.');
  expect(said).toContain('Choose konjir-pm, then Authenticate. Kolab\'s page arrives with ann-pm, kolab anns and product chosen');

  const home = scratch();
  const g = world(server, idp, async () => 0);
  await connectHarness(options(server, project, { global: true, yes: true, auth: false, env: { XDG_CONFIG_HOME: home } }), g);
  expect(Object.keys(JSON.parse(readFileSync(join(home, 'opencode', 'opencode.json'), 'utf8')).mcp)).toStrictEqual(['konjir-product', 'konjir-engineer']);
});

test('konjir connect refuses a sign-in that works as an agent: it makes agents as the person', async () => {
  const { kolab, idp, server } = await local();
  await kolab.signInWith({ provider: 'stub', subject: '41', login: 'ann' });
  await kolab.makeOwnKolab('ann', 'anns', 'Ann\'s');
  // konjir login, choosing a new agent of hers, as it offers by default.
  const { login } = await import('../src/login.js');
  await login(server.url, { log: () => undefined, open: (u) => { idp.next({ subject: '41', login: 'ann' }); void consentAt(u, { as: 'new-agent', agent_label: 'cli', kolab: 'kolab:anns' }, true); } });
  const project = scratch();
  expect(await rejection(connectHarness(options(server, project, { yes: true }), world(server, idp, async () => 0))))
    .toMatch(/your konjir sign-in to .* works as ann-cli, an agent of ann's. Run konjir login --self/);
  // The verb itself refuses the admin token: it has no person to make an agent for.
  const admin = await connect(server.url, 'connect-admin');
  closeAtEnd(admin);
  expect(await rejection(call(admin, 'create_agent', { label: 'x' }))).toMatch(/needs an agent session token, not the admin token/);
  expect(await kolab.listActors({ owner: 'ann' })).toMatchObject([{ id: 'ann-cli' }]);
  // And from the shell: konjir connect with a harness it doesn't know.
  expect(await rejection(main(['connect', 'codex']))).toMatch(/konjir connect opencode\|claude/);
});
