// `kolab <command> --help` and -h (help.ts): every command kolab runs itself prints its own usage and
// exits 0, before it reads any other argument, a project's .konjir.json or a sign-in, so it sends no
// request and opens no browser; a verb Kolab serves is `kolab help <verb>`, never a call to a tool
// named --help, and with nothing to ask Kolab with it says how to see the verb's parameters.
// node:child_process is stood in for, so a browser opened (@konjir/login's execFile) or claude started
// (spawn) is recorded rather than run; bin/kolab, run as a process, gets stand-ins on its PATH.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

const actual = await import('node:child_process');
/** Every program kolab started, in place of starting it. */
const started: string[][] = [];
jest.unstable_mockModule('node:child_process', () => ({
  ...actual,
  spawn: (cmd: string, args: readonly string[] = []) => {
    started.push([cmd, ...args]);
    const child = Object.assign(new EventEmitter(), { pid: 0, kill: () => true });
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  },
  execFile: (cmd: string, args: readonly string[] = []) => { started.push([cmd, ...args]); return { unref: () => undefined }; },
}));
const { execFileSync } = actual;
const { startServer } = await import('@konjir/server');
const { closeAtEnd, openKolab } = await import('@konjir/engine/testing');
const { main } = await import('../src/cli.js');
const { COMMANDS, commandHelp, helpRequest, verbHelpOffline } = await import('../src/help.js');
const { claudeBridgeEntry } = await import('../src/connect.js');
type Entry = import('../src/connect.js').Entry;

const env = { ...process.env };
const cwd = process.cwd();
let out: string[];
let fetched: string[];
let scratch: string;
/** The project's .konjir.json, as written. */
const PROJECT_FILE = JSON.stringify({ kolab: 'elsewhere', url: 'https://kolab.example.com/mcp' });
/** bin/kolab, run as a process: a browser it opened or claude it started, as the stand-ins on its PATH leave this file. */
let marker: string;

beforeEach(() => {
  out = [];
  fetched = [];
  started.length = 0;
  process.exitCode = undefined;
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  // Any request at all is recorded, and fails.
  jest.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return Promise.reject(new TypeError('fetch failed'));
  });
  scratch = mkdtempSync(join(tmpdir(), 'konjir-help-'));
  marker = join(scratch, 'started');
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  for (const b of ['open', 'xdg-open', 'claude']) writeFileSync(join(bin, b), `#!/bin/sh\necho "${b} $*" >> "${marker}"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.KONJIR_CREDENTIALS = join(scratch, 'konjir', 'credentials.json');
  // Everything that would otherwise send a request or refuse to: a token, and a project whose
  // .konjir.json names a Kolab nobody gave kolab, which every command that talks to Kolab refuses.
  process.env.KONJIR_TOKEN = 'kjs_not-a-real-token';
  delete process.env.KONJIR_URL;
  delete process.env.KONJIR_JOB;
  const project = join(scratch, 'project');
  mkdirSync(project);
  writeFileSync(join(project, '.konjir.json'), PROJECT_FILE);
  process.chdir(project);
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...env };
  process.chdir(cwd);
  process.exitCode = undefined;
});

/** Help wrote nothing: no credentials store, no data folder, the project's file as it was, and no stand-in ran. */
function nothingWritten() {
  expect(started).toStrictEqual([]);
  expect(readdirSync(scratch).sort()).toStrictEqual(['bin', 'project']);
  expect(readdirSync(join(scratch, 'project'))).toStrictEqual(['.konjir.json']);
  expect(readFileSync(join(scratch, 'project', '.konjir.json'), 'utf8')).toBe(PROJECT_FILE);
}

/** The arguments that name each command, and the command whose help they get. */
const NAMED: [string[], string][] = [
  [['login'], 'login'], [['logout'], 'logout'], [['connect'], 'connect'], [['connect', 'claude'], 'connect'], [['claude'], 'claude'],
  [['bridge'], 'bridge'], [['work'], 'work'], [['work', 'deliver'], 'work deliver'], [['work', 'deliver', 'kj:b#W1', '--submit'], 'work deliver'],
  [['work', 'guard'], 'work guard'], [['repo'], 'repo register'], [['repo', 'register'], 'repo register'], [['status'], 'status'], [['status', '--json'], 'status'],
  [['import'], 'import'], [['import', 'file.json'], 'import'], [['serve', '--port', '7431'], 'serve'], [['watch'], 'watch'], [['tools'], 'tools'],
  [['instructions'], 'instructions'], [['help'], 'help'], [['resolve'], 'resolve'], [['read'], 'read'], [['stale'], 'stale'], [['queries'], 'queries'],
];

test('every command kolab runs itself has its help, and each is named here', () => {
  expect(new Set(NAMED.map(([, c]) => c))).toStrictEqual(new Set(Object.keys(COMMANDS)));
});

test.each(NAMED.flatMap(([args, command]) => ['--help', '-h'].map((h) => [[...args, h].join(' '), command] as const)))(
  'kolab %s prints its usage, exits 0, sends no request and opens no browser', async (line, command) => {
    await main(line.split(' '));
    const text = out.join('\n');
    expect(text).toBe(commandHelp(command));
    expect(text.startsWith(`kolab ${command}`)).toBe(true);
    expect(text).toMatch(/\nExamples?:\n {2}/);
    expect(process.exitCode).toBeUndefined();
    expect(fetched).toStrictEqual([]);
    expect(existsSync(marker)).toBe(false);
    nothingWritten();
  });

test('kolab serve --help starts no Kolab', async () => {
  await main(['serve', '--port', '7431', '--help']);
  const listening = await new Promise<boolean>((resolve) => {
    const s = netConnect(7431, '127.0.0.1').once('connect', () => { s.destroy(); resolve(true); }).once('error', () => resolve(false));
  });
  expect(listening).toBe(false);
  nothingWritten();
});

test('kolab help <command>, --help <command> and -h <command> print the command\'s usage; the connection flags may come first', async () => {
  for (const [argv, command] of [[['help', 'login'], 'login'], [['--help', 'work', 'deliver'], 'work deliver'], [['-h', 'repo'], 'repo register'],
    [['help', 'help'], 'help'], [['--url', 'https://kolab.example.com/mcp', 'login', '--help'], 'login'], [['--kolab', 'k', 'help', 'connect'], 'connect']] as const) {
    out = [];
    await main([...argv]);
    expect([argv, out.join('\n')]).toStrictEqual([argv, commandHelp(command)]);
  }
  expect(fetched).toStrictEqual([]);
  nothingWritten();
});

test('inside a Konjir job (KONJIR_JOB), a command\'s help prints as anywhere, before the job\'s refusals', async () => {
  process.env.KONJIR_JOB = 'J1';
  for (const [argv, command] of [[['login', '--help'], 'login'], [['work', '-h'], 'work'], [['work', 'deliver', '--help'], 'work deliver'], [['import', '-h'], 'import'], [['claude', '--help'], 'claude']] as const) {
    out = [];
    await main([...argv]);
    expect([argv, out.join('\n')]).toStrictEqual([argv, commandHelp(command)]);
  }
  // Without help, a job still refuses them.
  await expect(main(['login'])).rejects.toThrow(/kolab login doesn't run inside a Konjir job/);
  expect(fetched).toStrictEqual([]);
  nothingWritten();
});

test('a verb Kolab serves, with nothing to ask Kolab with, says how to see its parameters, and calls nothing', async () => {
  delete process.env.KONJIR_TOKEN;
  process.chdir(scratch);
  for (const [argv, verb] of [[['read_node', '--help'], 'read_node'], [['whoami', '-h'], 'whoami'], [['read_node', 'node=orders', '--help'], 'read_node'],
    [['--help', 'read_node'], 'read_node'], [['-h', 'read_node'], 'read_node'], [['help', 'read_node'], 'read_node'], [['help', 'konjir_import'], 'konjir_import']] as const) {
    out = [];
    await main([...argv]);
    expect([argv, out.join('\n')]).toStrictEqual([argv, verbHelpOffline(verb)]);
  }
  expect(verbHelpOffline('read_node')).toMatch(/kolab help read_node, or kolab tools for every verb/);
  expect(verbHelpOffline('konjir_import')).toMatch(/^kolab import \[key=value …\]/);
  expect(verbHelpOffline('konjir_import')).toMatch(/then run kolab help konjir_import, or kolab tools/);
  expect(process.exitCode).toBeUndefined();
  expect(fetched).toStrictEqual([]);
});

test('a verb Kolab serves, with a session, prints its parameters from the verbs Kolab lists, and calls no tool', async () => {
  jest.mocked(globalThis.fetch).mockRestore();
  const kolab = await openKolab();
  const server = await startServer({ adminToken: 'help-admin', kolab, webRoot: null });
  closeAtEnd(server);
  const real = globalThis.fetch;
  const methods: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (typeof init?.body === 'string') { try { methods.push((JSON.parse(init.body) as { method?: string }).method ?? ''); } catch { /* not JSON-RPC */ } }
    return real(input, init);
  });
  process.chdir(scratch);
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = 'help-admin';
  for (const argv of [['read_node', 'node=orders', '--help'], ['konjir_read_node', '-h'], ['--help', 'read_node']]) {
    out = [];
    await main(argv);
    const text = out.join('\n');
    expect(text).toMatch(/^kolab read_node node=<string>/);
    expect(text).toMatch(/\n {2}node: string/);
  }
  expect(methods).toContain('tools/list');
  expect(methods).not.toContain('tools/call');
  expect(process.exitCode).toBeUndefined();
}, 60_000);

test('help is asked only where it is kolab\'s: not as a flag\'s value, and never after kolab claude\'s label', () => {
  expect(helpRequest(['claude', 'product', '--help'])).toBeUndefined();
  expect(helpRequest(['claude', '--help'])).toStrictEqual({ command: 'claude' });
  expect(helpRequest(['work', 'deliver', 'kj:b#W1', '--note', '-h'])).toBeUndefined();
  expect(helpRequest(['work', '--harness', '--help'])).toBeUndefined();
  expect(helpRequest(['create_node', '--json', '-h'])).toBeUndefined();
  expect(helpRequest(['import', '--json', '-h'])).toBeUndefined();
  // kolab status's --json takes no value.
  expect(helpRequest(['status', '--json', '--help'])).toStrictEqual({ command: 'status' });
  expect(helpRequest(['repo', 'register', '--url', '-h'])).toBeUndefined();
  expect(helpRequest(['--token', '-h', 'whoami'])).toBeUndefined();
  for (const argv of [[], ['help'], ['--help'], ['--version'], ['whoami'], ['read_node', 'node=x'], ['login', '--kolab', 'k']]) expect(helpRequest(argv)).toBeUndefined();
  // kolab -h is kolab --help, with any connection flags kept.
  expect(helpRequest(['-h'])).toStrictEqual({ argv: ['--help'] });
  expect(helpRequest(['--url', 'u', 'whoami', '--help'])).toStrictEqual({ verb: 'whoami', argv: ['--url', 'u', 'help', 'whoami'] });
  expect(helpRequest(['whoami', '--help', '--token', 't'])).toStrictEqual({ verb: 'whoami', argv: ['--token', 't', 'help', 'whoami'] });
});

test('each command\'s flags are the ones kolab --help names', async () => {
  await main(['--help']);
  const usage = out.join('\n');
  expect(usage).toContain('kolab <command> --help');
  for (const [name, h] of Object.entries(COMMANDS)) {
    for (const f of h.usage.join(' ').match(/--[a-z][a-z-]*/g) ?? []) expect([name, f, usage.includes(f)]).toStrictEqual([name, f, true]);
  }
}, 60_000);

test('bin/kolab login --help and logout -h print their usage on stdout and exit 0, as a process', () => {
  const bin = join(import.meta.dirname, '..', '..', '..', 'bin', 'kolab');
  const run = (...args: string[]) => execFileSync(bin, args, { cwd: scratch, encoding: 'utf8', env: { ...process.env, KONJIR_URL: 'http://127.0.0.1:9/mcp' } });
  expect(run('login', '--help')).toBe(`${commandHelp('login')}\n`);
  expect(run('logout', '-h')).toBe(`${commandHelp('logout')}\n`);
  expect(existsSync(marker)).toBe(false);
}, 60_000);

test('kolab claude <label> --help is claude\'s: kolab starts claude with it', async () => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'konjir-help-home-'));
  const project = mkdtempSync(join(tmpdir(), 'konjir-help-claude-'));
  const entry: Entry = { name: 'konjir-product', agent: 'ann-product', label: 'product', role: 'product', kolab: 'anns', url: 'https://kolab.example/mcp' };
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'konjir-product': claudeBridgeEntry(entry, '/src/kolab/apps/channel-bridge/scripts/start.sh') } }));
  process.chdir(project);
  await main(['claude', 'product', '--help']);
  expect(out).toStrictEqual([]);
  expect(process.exitCode).toBe(0);
  expect(started).toHaveLength(1);
  expect(started[0].slice(0, 2)).toStrictEqual(['claude', '--strict-mcp-config']);
  expect(started[0].at(-1)).toBe('--help');
  expect(fetched).toStrictEqual([]);
});

test('kolab work deliver … --note -h is a delivery with the note -h, not help', async () => {
  jest.mocked(globalThis.fetch).mockRestore();
  const kolab = await openKolab();
  const server = await startServer({ adminToken: 'help-admin', kolab, webRoot: null });
  closeAtEnd(server);
  const real = globalThis.fetch;
  const calls: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (typeof init?.body === 'string') {
      try { const m = JSON.parse(init.body) as { method?: string; params?: { name?: string } }; if (m.method === 'tools/call') calls.push(m.params?.name ?? ''); } catch { /* not JSON-RPC */ }
    }
    return real(input, init);
  });
  process.chdir(scratch);
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = 'help-admin';
  // Delivery reads the package from Kolab first; this kolab has none, so it stops there, past help.
  const refused = main(['work', 'deliver', 'kj:b#W1', '--note', '-h', '-C', scratch]);
  await expect(refused).rejects.toThrow();
  expect(String(await refused.catch((e: Error) => e.message))).not.toContain('kolab work deliver [<work>]');
  expect(out.join('\n')).not.toContain(commandHelp('work deliver'));
  expect(calls).toContain('konjir_read_work');
}, 60_000);
