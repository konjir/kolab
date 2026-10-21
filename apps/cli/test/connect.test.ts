// `konjir connect` (W3.7, D59): one command connects a harness to a kolab, one agent per entry.
// The config writing for both harnesses (merging, refusing to overwrite, --force, the diff,
// OpenCode's JSON with comments, and no token anywhere), and the done-when scenario: two OpenCode
// entries, product and engineer, each signing in as its own agent against a local Kolab with the
// stub identity provider. OpenCode's `opencode mcp auth` is played by the MCP SDK's own auth(), as
// OpenCode's McpOAuthProvider drives it, with the entry's oauth.scope as its client metadata's
// scope; the person's "browser" follows Kolab's redirects with its cookies and clicks Allow on the
// page as it arrives, preselected.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { auth, type OAuthClientProvider, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client';
import { StubIdentity, startServer } from '@konjir/server';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';
import { StoredLogin, call, connect, login, main, personSession } from '../src/cli.js';
import { parse as ocParse, type ParseError } from 'jsonc-parser';
import { commentsOf, parseTree, valueOf } from '../src/jsonc.js';
import { MAX_CONFIG_BYTES, connectHarness, mcpUrl, mergeClaude, mergeOpencode, opencodeEntry, parseAgents, unifiedDiff, writeAtomically, type ConnectIO, type ConnectOptions, type Entry } from '../src/connect.js';

const URL_ = 'https://kolab.example/mcp';
const entry = (label: string, role: 'product' | 'engineer', over: Partial<Entry> = {}): Entry =>
  ({ name: `konjir-${label}`, agent: `ann-${label}`, label, role, kolab: 'anns', url: URL_, ...over });
/** What OpenCode reads in a file, as OpenCode's own parser reads it: JSON with comments and trailing commas. */
const jsonc = { parse: (text: string) => { const errors: ParseError[] = []; const v = ocParse(text, errors, { allowTrailingComma: true }); if (errors.length) throw new Error(`OpenCode can't read ${JSON.stringify(text)}`); return v as unknown; } };
const ours = (text: string) => valueOf(parseTree(text));
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
    expect([plain, ours(plain)]).toStrictEqual([plain, JSON.parse(plain.replace(/^﻿/, ''))]);
  }
  expect(ours('// lead\n{ /* a */ "a": [1, 2,], // b\n "c": "//not a comment", }\n')).toStrictEqual({ a: [1, 2], c: '//not a comment' });
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
  expect(() => mergeOpencode('opencode.json', '{ "mcp": [] }', [entry('product', 'product')], false)).toThrow(/its "mcp" is not an object/);
});

/**
 * The corpus, against OpenCode's own parser (jsonc-parser, a test-only dependency): every file
 * merged must read, to OpenCode, as the file before with just the entries set, keep every comment,
 * and keep all of its own text but for what is added.
 */
const CORPUS = [
  '{}', '{ }', '{\n}\n', '{ "mcp": {} }', '{"a": 1}', '{ "a": 1, }', '{ "a": 1 /* c */ }', '{\r\n  "a": 1\r\n}\r\n',
  '{\n  "mcp": {\n    // none yet\n  }\n}', '{ /* only */ }', '{"mcp": { // c\n}}',
  // The review's shapes: a block comment over lines after the last member, and a comma before a comment.
  '{\n  "a": 1 /* start\n  end */\n}\n', '{\n  "mcp": {\n    "x": {} /* a\n b */\n  }\n}\n', '{"a": 1, /* c */}', '{"mcp": {"x": 1, /* c */}}',
  '{\n  "a": 1, // trailing\n}\n', '{\n  "a": 1 // no comma\n}\n', '{\r\n  "a": 1 // crlf\r\n}\r\n', '{\n\t"a": [1, 2,],\n\t"mcp": {\n\t\t"x": { "type": "local" }, // keep\n\t},\n}\n',
  '// lead\n{\n  "a": "/* not a comment */"\n}\n// tail\n', '{"a":{"b":{"c":[{"d":null}]}},"mcp":{"y":true}}', '{"a": 12345678901234567890}',
];

function checkAgainstOpenCode(before: string, set: Entry[], force = false) {
  const after = mergeOpencode('opencode.json', before, set, force);
  const errors: ParseError[] = [];
  const read = ocParse(after, errors, { allowTrailingComma: true }) as Record<string, unknown>;
  expect([before, errors]).toStrictEqual([before, []]);
  const was = (before.trim() ? ocParse(before, [], { allowTrailingComma: true }) : { $schema: 'https://opencode.ai/config.json' }) as Record<string, unknown>;
  const want = { ...was, mcp: { ...(was.mcp as object | undefined), ...Object.fromEntries(set.map((e) => [e.name, opencodeEntry(e)])) } };
  expect([before, read]).toStrictEqual([before, want]);
  // Every comment kept, and every line of the file before still in it.
  for (const c of commentsOf(before)) expect([before, after.includes(c)]).toStrictEqual([before, true]);
  return after;
}

test('OpenCode, against its own parser: every corpus file merged reads as the file with just the entries set, every comment kept', () => {
  for (const before of CORPUS) {
    checkAgainstOpenCode(before, [entry('product', 'product')]);
    checkAgainstOpenCode(before, [entry('product', 'product'), entry('engineer', 'engineer')]);
  }
  // The review's three: nothing lands inside a comment, and no double comma.
  expect(mergeOpencode('opencode.json', '{\n  "a": 1 /* start\n  end */\n}\n', [entry('p', 'product')], false)).toMatch(/^\{\n {2}"a": 1, \/\* start\n {2}end \*\/\n {2}"mcp": \{/);
  expect(mergeOpencode('opencode.json', '{"a": 1, /* c */}', [entry('p', 'product')], false)).not.toMatch(/,\s*(\/\*.*?\*\/)?\s*,/);
  // An empty object keeps its comments.
  expect(mergeOpencode('opencode.json', '{\n  "mcp": {\n    // none yet\n  }\n}', [entry('p', 'product')], false)).toContain('    // none yet\n    "konjir-p": {');
  expect(mergeOpencode('opencode.json', '{ /* only */ }', [entry('p', 'product')], false)).toContain('/* only */');
});

test('OpenCode, against its own parser: random edits of the corpus either merge correctly or are refused, never written wrong', () => {
  let seed = 7;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const bits = ['//x\n', '/*y*/', ',', ' ', '\n', '"k": 1,', '{', '}', '[', ']'];
  let merged = 0;
  for (let i = 0; i < 1500; i++) {
    const base = CORPUS[rand(CORPUS.length)];
    const at = rand(base.length + 1);
    const text = base.slice(0, at) + bits[rand(bits.length)] + base.slice(at);
    let after: string;
    try { after = mergeOpencode('opencode.json', text, [entry('p', 'product')], true); } catch { continue; }
    merged++;
    const errors: ParseError[] = [];
    const read = ocParse(after, errors, { allowTrailingComma: true }) as { mcp?: Record<string, unknown> };
    expect([text, errors.length, read?.mcp?.['konjir-p']]).toStrictEqual([text, 0, opencodeEntry(entry('p', 'product'))]);
  }
  expect(merged).toBeGreaterThan(300);
});

test('OpenCode, with --force and a key there twice: every copy is replaced, so whichever a reader takes is the new one', () => {
  const twice = '{"mcp": {"konjir-p": {"url": "old1"}, "konjir-p": {"url": "old2"}}}';
  const after = checkAgainstOpenCode(twice, [entry('p', 'product')], true);
  expect(after).not.toMatch(/old[12]/);
  // A duplicate "mcp": the last is the one every reader takes, and the one edited.
  checkAgainstOpenCode('{"mcp": {"a": 1}, "mcp": {"b": 2}}', [entry('p', 'product')]);
});

test('JSON with comments: nesting past 512 levels is refused plainly, never a stack overflow', () => {
  expect(() => parseTree('['.repeat(200_000))).toThrow(/nesting deeper than 512 levels on line 1/);
  expect(() => mergeOpencode('opencode.json', `{"a": ${'['.repeat(600)}${']'.repeat(600)}}`, [entry('p', 'product')], false)).toThrow(/isn't JSON that OpenCode reads \(nesting deeper than 512 levels/);
  expect(ours(`${'['.repeat(500)}${']'.repeat(500)}`)).toBeTruthy();
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
async function consentAt(start: URL, form: Record<string, string> | ((html: string) => Record<string, string>) = {}, deliver = false): Promise<{ html: string; back: URL }> {
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
    body: new URLSearchParams({ csrf, sign_in: field('sign_in') ?? '', decision: 'allow', ...shown, ...(typeof form === 'function' ? form(html) : form) }).toString(),
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

/**
 * konjir connect's world: a terminal that says yes (or `answer`), the harnesses as `run`, and Ann's
 * sign-in as herself, in memory: on the page she chooses Yourself by hand, as the terminal tells
 * her (no client preselects it, D60), or `as` if given (Ann, new here, makes her first kolab on the
 * way). `logins` gets each of those consent pages, as they arrived.
 */
function world(server: { url: string }, idp: StubIdentity, run: ConnectIO['run'], o: { answer?: boolean; interactive?: boolean; asked?: string[]; logins?: string[]; as?: Record<string, string> } = {}): ConnectIO & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (l) => lines.push(l),
    interactive: o.interactive ?? true,
    confirm: async (q) => { o.asked?.push(q); return o.answer ?? true; },
    run,
    person: () => personSession(server.url, undefined, {
      log: (l) => lines.push(l),
      open: (u) => {
        idp.next({ subject: '41', login: 'ann' });
        void consentAt(u, (html): Record<string, string> => { o.logins?.push(html); return { ...(o.as ?? { as: 'self' }), ...(html.includes('value="kolab:anns"') ? {} : { kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s' }) }; }, true);
      },
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
  const logins: string[] = [];
  const io = world(server, idp, async (cmd, args, { cwd }) => {
    auths.push([cmd, ...args].join(' '));
    expect(cmd).toBe('opencode');
    // The sign-in as Ann ended before any harness signs in.
    expect((await kolab.db.query(`select 1 from oauth_grant where actor_id = 'ann' and revoked_at is null`)).rows).toStrictEqual([]);
    return signIn(cwd, args[2]);
  }, { asked, logins });

  // konjir connect opencode: Ann signs in as herself, in memory only. The page arrives with a new
  // agent chosen, never Yourself (D60): the terminal tells her to choose Yourself, and she does.
  const entries = await connectHarness(options(server, project), io);
  expect(logins).toHaveLength(1);
  expect(logins[0]).toMatch(/name="as" value="new-agent" checked/);
  expect(logins[0]).not.toMatch(/name="as" value="self" checked/);
  expect(logins[0]).not.toContain('asks to act as you');
  expect(io.lines.join('\n')).toContain('under "Work as", choose "Yourself" by hand');
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
  for (const s of secrets) expect(text).not.toContain(s);
  expect(text).not.toMatch(/kj[sr]_/);
  // The sign-in as Ann was kept nowhere, and was revoked once the agents were made, before anything was written.
  expect(existsSync(process.env.KONJIR_CREDENTIALS!)).toBe(false);
  expect((await kolab.db.query(`select count(*)::int as n from oauth_grant where actor_id = 'ann' and revoked_at is not null`)).rows[0]).toStrictEqual({ n: 1 });
  expect(io.lines.indexOf('Revoked the sign-in as you.')).toBeGreaterThan(io.lines.indexOf('Made your agent ann-engineer.'));
  expect(io.lines.indexOf('Revoked the sign-in as you.')).toBeLessThan(io.lines.findIndex((l) => l.startsWith('Wrote ')));

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

test('a kept konjir login is never made the person: one that works as an agent stays as it is, untouched; one already the person\'s is used, and left alone', async () => {
  const { kolab, idp, server } = await local();
  await kolab.signInWith({ provider: 'stub', subject: '41', login: 'ann' });
  await kolab.makeOwnKolab('ann', 'anns', 'Ann\'s');
  // konjir login, choosing a new agent of hers, as it offers by default.
  await login(server.url, { log: () => undefined, open: (u) => { idp.next({ subject: '41', login: 'ann' }); void consentAt(u, { as: 'new-agent', agent_label: 'cli', kolab: 'kolab:anns' }, true); } });
  const kept = readFileSync(process.env.KONJIR_CREDENTIALS!, 'utf8');
  const project = scratch();
  const io = world(server, idp, async () => 0);
  await connectHarness(options(server, project, { yes: true, auth: false, agents: parseAgents(['pm:product']) }), io);
  expect(io.lines).toContain('Made your agent ann-pm.');
  expect(io.lines).toContain('Revoked the sign-in as you.');
  // The CLI's own sign-in, ann-cli's, is exactly as it was, and still works as ann-cli.
  expect(readFileSync(process.env.KONJIR_CREDENTIALS!, 'utf8')).toBe(kept);
  const cli = await connect(server.url, new StoredLogin(server.url));
  closeAtEnd(cli);
  expect(await call(cli, 'whoami')).toMatchObject({ actor: 'ann-cli', kind: 'agent' });

  // A kept sign-in that is already Ann's own (she chose Yourself at konjir login): used, never revoked.
  await login(server.url, { log: () => undefined, open: (u) => { idp.next({ subject: '41', login: 'ann' }); void consentAt(u, { as: 'self', kolab: 'kolab:anns' }, true); } });
  const mine = readFileSync(process.env.KONJIR_CREDENTIALS!, 'utf8');
  const quiet = world(server, idp, async () => { throw new Error('no browser this time'); });
  quiet.person = () => personSession(server.url, undefined, { log: (l) => quiet.lines.push(l), open: () => { throw new Error('no browser this time'); } });
  await connectHarness(options(server, project, { yes: true, auth: false, force: true, agents: parseAgents(['pm:product']) }), quiet);
  expect(quiet.lines).toContain('Using your agent ann-pm.');
  expect(quiet.lines).not.toContain('Revoked the sign-in as you.');
  expect(readFileSync(process.env.KONJIR_CREDENTIALS!, 'utf8')).toBe(mine);
  const still = await connect(server.url, new StoredLogin(server.url));
  closeAtEnd(still);
  expect(await call(still, 'whoami')).toMatchObject({ actor: 'ann', kind: 'person' });
});

test('konjir connect\'s own sign-in must be Yourself: if the person chooses an agent instead, it is revoked at once and connect stops, saying to choose Yourself; nothing is written (D60)', async () => {
  const { kolab, idp, server } = await local();
  await kolab.signInWith({ provider: 'stub', subject: '41', login: 'ann' });
  await kolab.makeOwnKolab('ann', 'anns', 'Ann\'s');
  const project = scratch();
  const io = world(server, idp, async () => 0, { as: { as: 'new-agent', agent_label: 'oops' } });
  await expect(connectHarness(options(server, project, { yes: true, auth: false }), io)).rejects.toThrow('on Kolab\'s page you chose ann-oops, not Yourself, and konjir connect makes your agents as you. Run it again, and under "Work as" choose "Yourself"');
  expect(io.lines).toContain('Revoked the sign-in as you.');
  expect((await kolab.db.query(`select 1 from oauth_grant where actor_id = 'ann-oops' and revoked_at is null`)).rows).toStrictEqual([]);
  expect(existsSync(join(project, 'opencode.json'))).toBe(false);
});

test('konjir connect makes agents as the person only: an agent\'s token is refused; so is the admin token, at the verb', async () => {
  const { kolab, server } = await local();
  await kolab.signInWith({ provider: 'stub', subject: '41', login: 'ann' });
  await kolab.makeOwnKolab('ann', 'anns', 'Ann\'s');
  await kolab.addOwnAgent('ann', 'cli');
  await kolab.grant('anns', 'ann-cli', 'write', { layers: ['functional'] });
  const token = await kolab.openSession('ann-cli', 'product', { kolab: 'anns' });
  const io = world(server, new StubIdentity(), async () => 0);
  io.person = () => personSession(server.url, token);
  expect(await rejection(connectHarness(options(server, scratch(), { yes: true }), io)))
    .toMatch(/the token it was given \(KONJIR_TOKEN or --token\) works as ann-cli, an agent of ann's. Unset it/);
  const admin = await connect(server.url, 'connect-admin');
  closeAtEnd(admin);
  expect(await rejection(call(admin, 'create_agent', { label: 'x' }))).toMatch(/needs an agent session token, not the admin token/);
  expect((await kolab.listActors({ owner: 'ann' })).map((a) => a.id)).toStrictEqual(['ann-cli']);
  // And from the shell: konjir connect with a harness it doesn't know, or a URL with credentials in it.
  expect(await rejection(main(['connect', 'codex']))).toMatch(/konjir connect opencode\|claude/);
  expect(() => mcpUrl('https://ann:secret@kolab.example.com')).toThrow(/without a user name or password/);
  expect(() => mcpUrl('https://kolab.example.com/?token=x')).toThrow(/without a query or fragment/);
  expect(mcpUrl('https://kolab.example.com')).toBe('https://kolab.example.com/mcp');
});

test('a config file that is a link: written where it leads inside the project; refused outside it unless --force-path, even with --yes; a dangling one refused', async () => {
  const { idp, server } = await local();
  const project = scratch();
  const elsewhere = scratch();
  writeFileSync(join(elsewhere, 'settings.json'), '{\n  "keep": true\n}\n');
  symlinkSync(join(elsewhere, 'settings.json'), join(project, 'opencode.json'));
  const io = world(server, idp, async () => 0);
  expect(await rejection(connectHarness(options(server, project, { yes: true, auth: false }), io)))
    .toMatch(/opencode.json is a link to .*settings.json, outside .*; konjir connect won't write there. Pass --force-path/);
  expect(readFileSync(join(elsewhere, 'settings.json'), 'utf8')).toBe('{\n  "keep": true\n}\n');
  const forced = world(server, idp, async () => 0);
  await connectHarness(options(server, project, { yes: true, auth: false, forcePath: true }), forced);
  expect(forced.lines.join('\n')).toContain(`is a link to ${realpathSync(join(elsewhere, 'settings.json'))}, which konjir connect would change`);
  expect(Object.keys(JSON.parse(readFileSync(join(elsewhere, 'settings.json'), 'utf8')).mcp)).toStrictEqual(['konjir-product', 'konjir-engineer']);
  expect(lstatSync(join(project, 'opencode.json')).isSymbolicLink()).toBe(true);
  // Inside the project, a link is followed, and said.
  const inner = scratch();
  mkdirSync(join(inner, 'config'));
  writeFileSync(join(inner, 'config', 'opencode.json'), '{}');
  symlinkSync(join(inner, 'config', 'opencode.json'), join(inner, 'opencode.json'));
  await connectHarness(options(server, inner, { yes: true, auth: false, force: true }), world(server, idp, async () => 0));
  expect(Object.keys(JSON.parse(readFileSync(join(inner, 'config', 'opencode.json'), 'utf8')).mcp)).toStrictEqual(['konjir-product', 'konjir-engineer']);
  // A link to nothing: refused, never replaced by a file.
  const dangling = scratch();
  symlinkSync(join(dangling, 'gone.json'), join(dangling, 'opencode.json'));
  expect(await rejection(connectHarness(options(server, dangling, { yes: true, auth: false, force: true, forcePath: true }), world(server, idp, async () => 0))))
    .toMatch(/is a link to .*gone.json, which isn't there; konjir connect won't write through it/);
  expect(lstatSync(join(dangling, 'opencode.json')).isSymbolicLink()).toBe(true);
});

test('Claude Code: an existing .mcp.json is edited in place, keeping its own formatting and big numbers, never re-serialised', () => {
  const before = '{\n    "mcpServers": {\n        "sentry": {"type": "http", "url": "https://mcp.sentry.dev/mcp"}\n    },\n    "id": 12345678901234567890\n}\n';
  const after = mergeClaude('.mcp.json', before, [entry('pm', 'product')], false);
  expect(after).toContain('        "sentry": {"type": "http", "url": "https://mcp.sentry.dev/mcp"},\n        "konjir-pm": {');
  expect(after).toContain('"id": 12345678901234567890');
  expect(JSON.parse(after).mcpServers['konjir-pm']).toStrictEqual({ type: 'http', url: URL_, oauth: { scopes: 'konjir kolab:anns role:product agent:ann-pm' } });
});

test('konjir connect reads only a regular config file of at most 1 MiB, and refuses an "mcp" or "mcpServers" that is null', async () => {
  const { idp, server } = await local();
  const fifo = scratch();
  execFileSync('mkfifo', [join(fifo, 'opencode.json')]);
  expect(await rejection(connectHarness(options(server, fifo, { yes: true, auth: false }), world(server, idp, async () => 0)))).toMatch(/opencode.json isn't a regular file, so konjir connect won't read or write it/);
  const dir = scratch();
  mkdirSync(join(dir, 'opencode.json'));
  expect(await rejection(connectHarness(options(server, dir, { yes: true, auth: false }), world(server, idp, async () => 0)))).toMatch(/isn't a regular file/);
  const big = scratch();
  writeFileSync(join(big, 'opencode.json'), `{"a": "${'x'.repeat(MAX_CONFIG_BYTES)}"}`);
  expect(await rejection(connectHarness(options(server, big, { yes: true, auth: false }), world(server, idp, async () => 0)))).toMatch(/is over 1 MiB/);
  expect(() => mergeClaude('.mcp.json', '{"mcpServers": null}', [entry('p', 'product')], false)).toThrow(/its "mcpServers" is null, so konjir connect won't touch it: make it \{\} or remove it/);
  expect(() => mergeClaude('.mcp.json', '{"mcpServers": 3}', [entry('p', 'product')], false)).toThrow(/its "mcpServers" is not an object/);
  expect(() => mergeOpencode('opencode.json', '{"mcp": null}', [entry('p', 'product')], false)).toThrow(/its "mcp" is null/);
});

test('writeAtomically checks again, just before the rename, that the file still leads inside the project', () => {
  const project = scratch();
  const elsewhere = scratch();
  writeFileSync(join(project, 'opencode.json'), '{}');
  writeAtomically(join(project, 'opencode.json'), '{"x":1}', { within: project });
  expect(readFileSync(join(project, 'opencode.json'), 'utf8')).toBe('{"x":1}');
  // Swapped for a link outside between the plan and the write: refused, nothing written there.
  writeFileSync(join(elsewhere, 'target.json'), 'keep');
  symlinkSync(join(elsewhere, 'target.json'), join(project, 'swapped.json'));
  expect(() => writeAtomically(join(project, 'swapped.json'), '{}', { within: project })).toThrow(/leads outside/);
  expect(readFileSync(join(elsewhere, 'target.json'), 'utf8')).toBe('keep');
});
