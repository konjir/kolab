// W9.2 (API25, API26): the Kolab a command talks to by default is the one its build names, and a
// project's .konjir.json names its kolab and Kolab's URL. Nothing here connects to anything: the
// hosted default is checked from the build script and from what kolab says before it sends a
// request, with fetch refusing any.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { rejection } from '@konjir/engine/testing';
import { HOSTED_URL, LOCAL_URL, PROJECT_FILE, connectionUrl, defaultUrl, findProject, main, projectText, readProject, signInsKept, trustedProjectUrl } from '../src/cli.js';

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'konjir-project-')));
const published = globalThis as { KONJIR_DEFAULT_URL?: string };
const env = { ...process.env };
const cwd = process.cwd();
let out: string[];
let errors: string[];
beforeEach(() => {
  out = []; errors = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  // No test sends a request anywhere: the hosted Kolab least of all.
  jest.spyOn(globalThis, 'fetch').mockImplementation((input) => { throw new Error(`a request was sent to ${String(input instanceof Request ? input.url : input)}`); });
  for (const k of ['KONJIR_TOKEN', 'KONJIR_URL', 'KONJIR_JOB']) delete process.env[k];
  process.env.KONJIR_CREDENTIALS = join(scratch(), 'konjir', 'credentials.json');
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...env };
  delete published.KONJIR_DEFAULT_URL;
  process.chdir(cwd);
});

/** A git repository's folder (its .git is all findProject looks for), with `files` written in it. */
function repo(files: Record<string, string> = {}) {
  const r = scratch();
  mkdirSync(join(r, '.git'));
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(r, f, '..'), { recursive: true }); writeFileSync(join(r, f), text); }
  return r;
}

test('the published build defines the hosted Kolab as its default; a checkout keeps the local one (API25)', () => {
  // scripts/bundle.mjs builds the one kolab.mjs the npm package ships and the binaries are compiled
  // from, with it defined as the CLI's HOSTED_URL.
  const script = readFileSync(resolve(import.meta.dirname, '../scripts/bundle.mjs'), 'utf8');
  expect(/const HOSTED_URL = '([^']+)'/.exec(script)?.[1]).toBe(HOSTED_URL);
  expect(script).toContain('KONJIR_DEFAULT_URL: JSON.stringify(HOSTED_URL)');
  expect(HOSTED_URL).toBe('https://kolab.konjir.com/mcp');
  // Run from the checkout (tsx, or its dist), nothing defines it.
  expect(defaultUrl()).toBe(LOCAL_URL);
  expect(LOCAL_URL).toBe('http://127.0.0.1:7420/mcp');
  for (const cmd of ['whoami', 'login', 'work', 'status']) expect(connectionUrl({ cmd, kept: () => [] })).toStrictEqual({ url: LOCAL_URL, implicit: false });
  // kolab connect sets up at the hosted Kolab from a checkout too (Lee's instruction of 2026-11-14).
  expect(connectionUrl({ cmd: 'connect', kept: () => [] })).toStrictEqual({ url: HOSTED_URL, implicit: false });
  published.KONJIR_DEFAULT_URL = HOSTED_URL;
  expect(defaultUrl()).toBe(HOSTED_URL);
  for (const cmd of ['whoami', 'login', 'connect', 'work', 'status']) expect(connectionUrl({ cmd, kept: () => [] })).toStrictEqual({ url: HOSTED_URL, implicit: false });
  // --url and KONJIR_URL still come first.
  expect(connectionUrl({ cmd: 'whoami', given: LOCAL_URL, kept: () => [] }).url).toBe(LOCAL_URL);
});

test('a published kolab with no --url or KONJIR_URL names the hosted Kolab, in its help and before it sends anything; a checkout names the local one', async () => {
  published.KONJIR_DEFAULT_URL = HOSTED_URL;
  process.chdir(scratch());
  await main(['help']);
  expect(out.join('\n')).toContain(`KONJIR_URL (default ${HOSTED_URL})`);
  // Nothing kept for it: refused before any request, naming it as the default.
  expect(await rejection(main(['whoami']))).toContain(`kolab keeps no sign-in for ${HOSTED_URL}, the default`);
  delete published.KONJIR_DEFAULT_URL;
  out = [];
  await main(['help']);
  expect(out.join('\n')).toContain(`KONJIR_URL (default ${LOCAL_URL})`);
  expect(await rejection(main(['whoami']))).toContain(`kolab keeps no sign-in for ${LOCAL_URL}, the default`);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('.konjir.json is found from the project or a folder below it, up to the repository\'s root; outside a repository, only the folder\'s own', () => {
  const text = JSON.stringify({ kolab: 'anns', url: 'https://kolab.example.com/mcp' });
  const r = repo({ [PROJECT_FILE]: text, 'apps/web/src/x.ts': '' });
  const want = { path: join(r, PROJECT_FILE), kolab: 'anns', url: 'https://kolab.example.com/mcp' };
  expect(findProject(r)).toStrictEqual(want);
  expect(findProject(join(r, 'apps/web/src'))).toStrictEqual(want);
  // The nearest wins: a subproject's own.
  writeFileSync(join(r, 'apps/web', PROJECT_FILE), JSON.stringify({ kolab: 'web' }));
  expect(findProject(join(r, 'apps/web/src'))).toStrictEqual({ path: join(r, 'apps/web', PROJECT_FILE), kolab: 'web' });
  // A repository nested in a folder that has one: its root stops the search.
  const outer = scratch();
  writeFileSync(join(outer, PROJECT_FILE), text);
  const inner = join(outer, 'inner');
  mkdirSync(join(inner, '.git'), { recursive: true });
  mkdirSync(join(inner, 'sub'));
  expect(findProject(join(inner, 'sub'))).toBeUndefined();
  // Outside a repository, a file in a folder above is never read; the folder's own is.
  const loose = join(outer, 'loose');
  mkdirSync(loose);
  expect(findProject(loose)).toBeUndefined();
  expect(findProject(outer)).toStrictEqual({ ...want, path: join(outer, PROJECT_FILE) });
});

test('a .konjir.json kolab connect couldn\'t have written is refused, never passed over for the default', () => {
  const r = scratch();
  const path = join(r, PROJECT_FILE);
  for (const [bad, why] of [['{', /isn't JSON/], ['[]', /isn't a JSON object/], ['null', /isn't a JSON object/], ['{"kolab": "Anns"}', /names a kolab badly/], ['{"kolab": 7}', /names a kolab badly/],
    ['{"url": "ftp://kolab.example.com/mcp"}', /names Kolab's URL badly/], ['{"url": "https://ann:pw@kolab.example.com/mcp"}', /names Kolab's URL badly/],
    ['{"url": "https://kolab.example.com/mcp?token=x"}', /names Kolab's URL badly/], ['{"url": "not a url"}', /names Kolab's URL badly/], ['{"url": 7}', /names Kolab's URL badly/],
    // Nor a URL that isn't written as a URL is: a control character or a space in it, or one that reads back another way.
    ['{"url": "https://kolab.example.com/mcp\\u001b[2J"}', /names Kolab's URL badly/], ['{"url": "https://kolab.example.com/m cp"}', /names Kolab's URL badly/],
    ['{"url": "HTTPS://Kolab.Example.com/mcp"}', /names Kolab's URL badly/], ['{"url": "https://kolab.example.com:443/mcp"}', /names Kolab's URL badly/],
    ['{"url": "https://kolab.example.com/a/../mcp"}', /names Kolab's URL badly/], ['{"url": "https://k\\u043elab.example.com/mcp"}', /names Kolab's URL badly/]] as const) {
    writeFileSync(path, bad);
    expect(() => readProject(path)).toThrow(why);
    expect(() => readProject(path)).toThrow(/as kolab connect writes it\. Fix it, or write it again: kolab connect opencode\|claude --kolab <name> --url <Kolab's URL>/);
  }
  mkdirSync(join(r, '.git'));
  writeFileSync(path, '{"kolab": "Anns"}');
  expect(() => findProject(r)).toThrow(/names a kolab badly/);
  // The URL is given back as kolab connect writes it: /mcp for no path.
  for (const bare of ['https://kolab.example.com', 'https://kolab.example.com/']) {
    writeFileSync(path, JSON.stringify({ url: bare }));
    expect(readProject(path)).toStrictEqual({ path, url: 'https://kolab.example.com/mcp' });
  }
  // A path with an escape sequence in it is printed without it.
  const odd = join(r, 'a\u001b[2Jb');
  mkdirSync(odd);
  writeFileSync(join(odd, PROJECT_FILE), '{');
  expect(() => readProject(join(odd, PROJECT_FILE))).toThrow(new RegExp(`a\\?\\[2Jb/${PROJECT_FILE.replace('.', '\\.')} isn't JSON`));
});

test('projectText writes the kolab and URL, with two-space indentation, keeping any other key; no token', () => {
  expect(projectText('', 'anns', HOSTED_URL)).toBe(`{\n  "kolab": "anns",\n  "url": "${HOSTED_URL}"\n}\n`);
  expect(JSON.parse(projectText('{"note": "ours", "kolab": "old"}', 'anns', HOSTED_URL))).toStrictEqual({ note: 'ours', kolab: 'anns', url: HOSTED_URL });
  // One that isn't a JSON object is replaced whole.
  for (const broken of ['{', '[1]', '7']) expect(projectText(broken, 'anns', HOSTED_URL)).toBe(projectText('', 'anns', HOSTED_URL));
});

test('connectionUrl: a URL given comes first, then the project\'s, then the one sign-in kept, then the default; commands that talk to no Kolab take none of them', () => {
  const kept = () => ['https://kept.example.com/mcp'];
  const project = 'https://project.example.com/mcp';
  for (const cmd of ['whoami', 'login', 'connect', 'work', 'status', 'repo', 'logout']) {
    expect(connectionUrl({ cmd, project, kept })).toStrictEqual({ url: project, implicit: false });
    expect(connectionUrl({ cmd, project, given: LOCAL_URL, kept })).toStrictEqual({ url: LOCAL_URL, implicit: false });
  }
  for (const cmd of [undefined, '--version', 'help', 'serve']) expect(connectionUrl({ cmd, project, kept }).url).toBe(LOCAL_URL);
  expect(connectionUrl({ cmd: 'help', rest: ['whoami'], project, kept }).url).toBe(project);
});

test('a token goes only to a URL given or the default, never to one a project\'s file names; inside a job no .konjir.json is read', async () => {
  const r = repo({ [PROJECT_FILE]: JSON.stringify({ kolab: 'anns', url: 'https://elsewhere.example.com/mcp' }) });
  process.chdir(r);
  process.env.KONJIR_TOKEN = 'kjs_secret';
  expect(await rejection(main(['whoami']))).toBe(`Error: a token is given (KONJIR_TOKEN or --token), but not Kolab's URL, and ${join(r, PROJECT_FILE)} names https://elsewhere.example.com/mcp: kolab sends a token only to a URL you give it, so set KONJIR_URL or pass --url`);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  // A job's environment is all it takes: KONJIR_URL and its token, whatever a file in its worktree says.
  delete process.env.KONJIR_TOKEN;
  process.env.KONJIR_JOB = '01JOB';
  writeFileSync(join(r, PROJECT_FILE), '{');
  expect(await rejection(main(['whoami']))).toMatch(/this is a Konjir job \(KONJIR_JOB is set\)/);
  // Outside a job, the same broken file is refused.
  delete process.env.KONJIR_JOB;
  expect(await rejection(main(['whoami']))).toMatch(/isn't JSON: it names the kolab and Kolab's URL/);
  // --url and --kolab both given: the file isn't needed, so isn't read.
  expect(await rejection(main(['--url', LOCAL_URL, '--kolab', 'anns', 'whoami']))).toMatch(new RegExp(`kolab keeps no sign-in for ${LOCAL_URL.replace(/\./g, '\\.')}$`));
});

const EVIL = 'https://kolab.konjir.com.evil.example/mcp';
/** A sign-in kept for `url` in the credentials file at `path`: enough for kolab to find it kept. */
function keep(path: string, url: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ [url]: { tokens: { access_token: 'x', token_type: 'Bearer', refresh_token: 'kjr_x' } } }), { mode: 0o600 });
}

test('a URL only a .konjir.json names is trusted when it is the hosted Kolab, on this machine, or one kolab keeps a sign-in for', () => {
  const none = () => [];
  expect(trustedProjectUrl(HOSTED_URL, HOSTED_URL, none)).toBe(true);
  for (const u of ['http://127.0.0.1:7420/mcp', 'http://localhost:7420/mcp', 'https://localhost/mcp', 'http://127.8.9.1/mcp', 'http://[::1]:7420/mcp']) expect(trustedProjectUrl(u, HOSTED_URL, none)).toBe(true);
  for (const u of [EVIL, 'https://kolab.konjir.com/other', 'https://kolab.konjir.com:8443/mcp', 'http://kolab.konjir.com/mcp', 'http://localhost.evil.example/mcp', 'http://127.0.0.1.evil.example/mcp',
    'http://[::2]/mcp', 'https://kolab.example.com/mcp', 'not a url']) expect(trustedProjectUrl(u, HOSTED_URL, none)).toBe(false);
  // A sign-in kept for exactly that Kolab, read as kolab connect reads a URL.
  const kept = () => ['https://kolab.example.com'];
  expect(trustedProjectUrl('https://kolab.example.com/mcp', HOSTED_URL, kept)).toBe(true);
  expect(trustedProjectUrl('https://kolab.example.com/other', HOSTED_URL, kept)).toBe(false);
  expect(trustedProjectUrl('https://kolab.example.com.evil.example/mcp', HOSTED_URL, kept)).toBe(false);
  // The sign-ins kolab keeps: the CLI's own, and each agent's under agents/.
  expect(signInsKept()).toStrictEqual([]);
  keep(process.env.KONJIR_CREDENTIALS!, 'https://one.example.com/mcp');
  keep(join(dirname(process.env.KONJIR_CREDENTIALS!), 'agents', 'ann-pm.json'), 'https://two.example.com/mcp');
  writeFileSync(join(dirname(process.env.KONJIR_CREDENTIALS!), 'agents', 'notes.txt'), '{"https://three.example.com/mcp": {"tokens": {}}}');
  expect(signInsKept()).toStrictEqual(['https://one.example.com/mcp', 'https://two.example.com/mcp']);
});

test('a URL a cloned repository\'s .konjir.json chose is refused by every command, before any request or browser, until the person gives it once', async () => {
  const r = repo({ [PROJECT_FILE]: JSON.stringify({ kolab: 'anns', url: EVIL }) });
  const file = join(r, PROJECT_FILE);
  const refusal = `Error: ${file} names Kolab at kolab.konjir.com.evil.example (${EVIL}), which you haven't given kolab yourself, so kolab won't use it: a project's file is followed unasked only to kolab.konjir.com, to a Kolab on this machine, or to one you are signed in to. If it is the Kolab you mean, give it once: kolab login --url ${EVIL} (or kolab connect … --url ${EVIL}). Otherwise pass --url or set KONJIR_URL`;
  const opened: URL[] = [];
  const open = (u: URL) => { opened.push(u); };
  process.chdir(r);
  for (const argv of [['login'], ['login', '--role', 'engineer'], ['connect', 'claude'], ['connect', 'opencode', '--dry-run'], ['whoami'], ['list_nodes'], ['help', 'whoami'], ['tools'], ['admin_list_actors'],
    ['work', '--once'], ['status'], ['repo', 'register'], ['work', 'deliver'], ['watch', '--once'], ['import', 'x.json'], ['logout'], ['logout', '--forget']]) {
    expect(await rejection(main([...argv], { open }))).toBe(refusal);
  }
  // From anywhere, for the folder the command acts on (-C).
  process.chdir(scratch());
  for (const argv of [['work', '--once', '-C', r], ['repo', 'register', '-C', r], ['work', 'deliver', '-C', r]]) expect(await rejection(main([...argv], { open }))).toBe(refusal);
  // -C is the folder of those commands only, and with none the file isn't there to read.
  expect(await rejection(main(['whoami']))).toContain(`kolab keeps no sign-in for ${LOCAL_URL}, the default`);
  expect(await rejection(main(['work', '--once']))).toContain(`kolab keeps no sign-in for ${LOCAL_URL}, the default`);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(opened).toStrictEqual([]);
  expect(errors).toStrictEqual([]);
  // A token is refused first, as for any URL a file names.
  process.chdir(r);
  process.env.KONJIR_TOKEN = 'kjs_secret';
  expect(await rejection(main(['whoami']))).toContain('kolab sends a token only to a URL you give it');
  delete process.env.KONJIR_TOKEN;
  // A URL given is the person's own: the file's is then not used at all.
  expect(await rejection(main(['--url', 'http://127.0.0.1:9/mcp', 'whoami']))).toMatch(/kolab keeps no sign-in for http:\/\/127\.0\.0\.1:9\/mcp$/);
  expect(globalThis.fetch).not.toHaveBeenCalled();

  // Signed in there before, by the CLI or as an agent (kolab connect claude's): it is used, and login says where it came from before the browser.
  for (const whose of ['cli', 'agent']) {
    process.env.KONJIR_CREDENTIALS = join(scratch(), 'konjir', 'credentials.json');
    keep(whose === 'cli' ? process.env.KONJIR_CREDENTIALS : join(dirname(process.env.KONJIR_CREDENTIALS), 'agents', 'ann-pm.json'), EVIL);
    errors = [];
    const said = await rejection(main(['login'], { open }));
    expect(said).not.toContain('which you haven\'t given kolab yourself');
    expect(errors[0]).toBe(`kolab: using ${EVIL} and kolab anns, which ${file} names`);
    // It went on to Kolab: the test's fetch refused the request.
    expect(jest.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(0);
    expect(jest.mocked(globalThis.fetch).mock.calls.every(([input]) => String(input instanceof Request ? input.url : input).startsWith('https://kolab.konjir.com.evil.example/'))).toBe(true);
    jest.mocked(globalThis.fetch).mockClear();
  }
});

test('the hosted Kolab and a Kolab on this machine are followed from a .konjir.json unasked; kolab says the file named it', async () => {
  for (const url of [HOSTED_URL, 'http://127.0.0.1:9/mcp', 'http://localhost:9/mcp', 'http://[::1]:9/mcp']) {
    const r = repo({ [PROJECT_FILE]: JSON.stringify({ kolab: 'anns', url }) });
    process.chdir(r);
    for (const argv of [['whoami'], ['status'], ['work', '--once'], ['repo', 'register']]) {
      expect(await rejection(main(argv))).toBe(`Error: set KONJIR_TOKEN (an agent session token, or the admin token for admin_* verbs), or run kolab login to sign in with your browser. kolab keeps no sign-in for ${url}, which ${join(r, PROJECT_FILE)} names`);
    }
    // kolab connect's plan is for that Kolab, said first with where it came from.
    out = []; errors = [];
    await main(['connect', 'opencode', '--dry-run']);
    expect(errors).toStrictEqual([`kolab: using ${url} and kolab anns, which ${join(r, PROJECT_FILE)} names`]);
    expect(out[0]).toContain(`kolab connect opencode: kolab anns at ${url}, 2 agents`);
    expect(out).toContain(`${join(r, PROJECT_FILE)} already names kolab anns at ${url}.`);
  }
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('kolab repo register\'s --url is the repository\'s, not Kolab\'s; one before repo is Kolab\'s', async () => {
  const r = repo({ [PROJECT_FILE]: JSON.stringify({ kolab: 'anns', url: 'http://127.0.0.1:9/mcp' }) });
  process.chdir(r);
  expect(await rejection(main(['repo', 'register', '--url', 'https://github.com/ann/project.git']))).toContain(`kolab keeps no sign-in for http://127.0.0.1:9/mcp, which ${join(r, PROJECT_FILE)} names`);
  expect(await rejection(main(['--url', 'http://127.0.0.1:8/mcp', 'repo', 'register', '--url', 'https://github.com/ann/project.git']))).toMatch(/kolab keeps no sign-in for http:\/\/127\.0\.0\.1:8\/mcp$/);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('kolab connect --global reads no .konjir.json: it sets up no project, so the folder\'s file names neither its kolab nor its Kolab', async () => {
  process.env.XDG_CONFIG_HOME = scratch();
  for (const text of [JSON.stringify({ kolab: 'theirs', url: EVIL }), JSON.stringify({ kolab: 'theirs', url: 'http://127.0.0.1:9/mcp' }), '{']) {
    const r = repo({ [PROJECT_FILE]: text });
    process.chdir(r);
    // No kolab from the file.
    expect(await rejection(main(['connect', 'opencode', '--global', '--dry-run']))).toMatch(/kolab connect needs --kolab <name>/);
    // Nor its URL: Konjir's own Kolab, as with no file.
    out = []; errors = [];
    await main(['connect', 'opencode', '--global', '--kolab', 'anns', '--dry-run']);
    expect(out[0]).toContain(`kolab connect opencode: kolab anns at ${HOSTED_URL}, 2 agents`);
    expect(out.join('\n')).not.toMatch(/theirs|evil\.example|127\.0\.0\.1|\.konjir\.json/);
    expect(errors).toStrictEqual([]);
    expect(readFileSync(join(r, PROJECT_FILE), 'utf8')).toBe(text);
  }
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('a .konjir.json that isn\'t what kolab connect writes stops what must read it, and not a command given both the kolab and the URL: kolab connect replaces it, shown first', async () => {
  const r = repo({ [PROJECT_FILE]: '{"kolab": 1}\u001b[2J' });
  const file = join(r, PROJECT_FILE);
  process.chdir(r);
  for (const argv of [['whoami'], ['login'], ['connect', 'opencode', '--dry-run'], ['connect', 'opencode', '--kolab', 'anns', '--dry-run'], ['--url', 'http://127.0.0.1:9/mcp', 'whoami']]) {
    expect(await rejection(main(argv))).toMatch(/\.konjir\.json isn't JSON: .* Fix it, or write it again: kolab connect opencode\|claude --kolab <name> --url <Kolab's URL>/);
  }
  expect(await rejection(main(['--url', 'http://127.0.0.1:9/mcp', '--kolab', 'anns', 'whoami']))).toMatch(/kolab keeps no sign-in for http:\/\/127\.0\.0\.1:9\/mcp$/);
  out = [];
  await main(['connect', 'opencode', '--url', 'http://127.0.0.1:9/mcp', '--kolab', 'anns', '--dry-run']);
  const said = out.join('\n');
  expect(said).toContain(`Will replace ${file}: kolab anns at http://127.0.0.1:9/mcp, and no token`);
  // What it replaces, with nothing of the file's that could write to the terminal.
  expect(said).toContain('-{"kolab": 1}?[2J');
  expect(said).toContain('+  "kolab": "anns",');
  expect(said).not.toContain('\u001b');
  expect(readFileSync(file, 'utf8')).toBe('{"kolab": 1}\u001b[2J');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
