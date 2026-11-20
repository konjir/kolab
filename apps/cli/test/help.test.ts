// `kolab <command> --help` and -h (help.ts): every command kolab runs itself prints its own usage and
// exits 0, before it reads any other argument, a project's .konjir.json or a sign-in, so it sends no
// request and opens no browser; a verb Kolab serves is `kolab help <verb>`, never a call to a tool
// named --help, and with nothing to ask Kolab with it says how to see the verb's parameters.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { closeAtEnd, openKolab } from '@konjir/engine/testing';
import { main } from '../src/cli.js';
import { COMMANDS, commandHelp, helpRequest, verbHelpOffline } from '../src/help.js';

const env = { ...process.env };
const cwd = process.cwd();
let out: string[];
let fetched: string[];
let scratch: string;
/** A browser opened, or claude started: the stand-ins on the PATH leave this file. */
let marker: string;

beforeEach(() => {
  out = [];
  fetched = [];
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
  writeFileSync(join(project, '.konjir.json'), JSON.stringify({ kolab: 'elsewhere', url: 'https://kolab.example.com/mcp' }));
  process.chdir(project);
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...env };
  process.chdir(cwd);
  process.exitCode = undefined;
});

/** The arguments that name each command, and the command whose help they get. */
const NAMED: [string[], string][] = [
  [['login'], 'login'], [['logout'], 'logout'], [['connect'], 'connect'], [['connect', 'claude'], 'connect'], [['claude'], 'claude'],
  [['bridge'], 'bridge'], [['work'], 'work'], [['work', 'deliver'], 'work deliver'], [['work', 'deliver', 'kj:b#W1', '--submit'], 'work deliver'],
  [['work', 'guard'], 'work guard'], [['repo'], 'repo register'], [['repo', 'register'], 'repo register'], [['status'], 'status'],
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
  });

test('kolab serve --help starts no Kolab', async () => {
  await main(['serve', '--port', '7431', '--help']);
  const listening = await new Promise<boolean>((resolve) => {
    const s = netConnect(7431, '127.0.0.1').once('connect', () => { s.destroy(); resolve(true); }).once('error', () => resolve(false));
  });
  expect(listening).toBe(false);
});

test('kolab help <command>, --help <command> and -h <command> print the command\'s usage; the connection flags may come first', async () => {
  for (const [argv, command] of [[['help', 'login'], 'login'], [['--help', 'work', 'deliver'], 'work deliver'], [['-h', 'repo'], 'repo register'],
    [['help', 'help'], 'help'], [['--url', 'https://kolab.example.com/mcp', 'login', '--help'], 'login'], [['--kolab', 'k', 'help', 'connect'], 'connect']] as const) {
    out = [];
    await main([...argv]);
    expect([argv, out.join('\n')]).toStrictEqual([argv, commandHelp(command)]);
  }
  expect(fetched).toStrictEqual([]);
  expect(existsSync(marker)).toBe(false);
});

test('a verb Kolab serves, with nothing to ask Kolab with, says how to see its parameters, and calls nothing', async () => {
  delete process.env.KONJIR_TOKEN;
  process.chdir(scratch);
  for (const argv of [['read_node', '--help'], ['whoami', '-h'], ['read_node', 'node=orders', '--help'], ['--help', 'read_node'], ['-h', 'read_node']]) {
    out = [];
    await main(argv);
    expect([argv, out.join('\n')]).toStrictEqual([argv, verbHelpOffline(argv.includes('whoami') ? 'whoami' : 'read_node')]);
  }
  expect(out.join('\n')).toMatch(/kolab help read_node, or kolab tools for every verb/);
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
