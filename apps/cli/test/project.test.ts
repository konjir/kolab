// W9.2 (API25, API26): the Kolab a command talks to by default is the one its build names, and a
// project's .konjir.json names its kolab and Kolab's URL. Nothing here connects to anything: the
// hosted default is checked from the build script and from what konjir says before it sends a
// request, with fetch refusing any.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { rejection } from '@konjir/engine/testing';
import { HOSTED_URL, LOCAL_URL, PROJECT_FILE, connectionUrl, defaultUrl, findProject, main, projectText, readProject } from '../src/cli.js';

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
  // scripts/package.mjs builds the npm package and the binaries with it defined as the CLI's HOSTED_URL.
  const script = readFileSync(resolve(import.meta.dirname, '../scripts/package.mjs'), 'utf8');
  expect(/const HOSTED_URL = '([^']+)'/.exec(script)?.[1]).toBe(HOSTED_URL);
  expect(script).toContain("'--define', `KONJIR_DEFAULT_URL=${JSON.stringify(HOSTED_URL)}`");
  expect(HOSTED_URL).toBe('https://kolab.konjir.com/mcp');
  // Run from the checkout (tsx, or its dist), nothing defines it.
  expect(defaultUrl()).toBe(LOCAL_URL);
  expect(LOCAL_URL).toBe('http://127.0.0.1:7420/mcp');
  published.KONJIR_DEFAULT_URL = HOSTED_URL;
  expect(defaultUrl()).toBe(HOSTED_URL);
  for (const cmd of ['whoami', 'login', 'connect', 'work', 'status']) expect(connectionUrl({ cmd, kept: () => [] })).toStrictEqual({ url: HOSTED_URL, implicit: false });
  // --url and KONJIR_URL still come first.
  expect(connectionUrl({ cmd: 'whoami', given: LOCAL_URL, kept: () => [] }).url).toBe(LOCAL_URL);
});

test('a published konjir with no --url or KONJIR_URL names the hosted Kolab, in its help and before it sends anything; a checkout names the local one', async () => {
  published.KONJIR_DEFAULT_URL = HOSTED_URL;
  process.chdir(scratch());
  await main(['help']);
  expect(out.join('\n')).toContain(`KONJIR_URL (default ${HOSTED_URL})`);
  // Nothing kept for it: refused before any request, naming it as the default.
  expect(await rejection(main(['whoami']))).toContain(`konjir keeps no sign-in for ${HOSTED_URL}, the default`);
  delete published.KONJIR_DEFAULT_URL;
  out = [];
  await main(['help']);
  expect(out.join('\n')).toContain(`KONJIR_URL (default ${LOCAL_URL})`);
  expect(await rejection(main(['whoami']))).toContain(`konjir keeps no sign-in for ${LOCAL_URL}, the default`);
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

test('a .konjir.json konjir connect couldn\'t have written is refused, never passed over for the default', () => {
  const r = scratch();
  const path = join(r, PROJECT_FILE);
  for (const [bad, why] of [['{', /isn't JSON/], ['[]', /isn't a JSON object/], ['null', /isn't a JSON object/], ['{"kolab": "Anns"}', /names a kolab badly/], ['{"kolab": 7}', /names a kolab badly/],
    ['{"url": "ftp://kolab.example.com/mcp"}', /names Kolab's URL badly/], ['{"url": "https://ann:pw@kolab.example.com/mcp"}', /names Kolab's URL badly/],
    ['{"url": "https://kolab.example.com/mcp?token=x"}', /names Kolab's URL badly/], ['{"url": "not a url"}', /names Kolab's URL badly/]] as const) {
    writeFileSync(path, bad);
    expect(() => readProject(path)).toThrow(why);
    expect(() => readProject(path)).toThrow(/as konjir connect writes it. Fix it, or run konjir connect again/);
  }
  mkdirSync(join(r, '.git'));
  writeFileSync(path, '{"kolab": "Anns"}');
  expect(() => findProject(r)).toThrow(/names a kolab badly/);
});

test('projectText writes the kolab and URL, with two-space indentation, keeping any other key; no token', () => {
  expect(projectText('p', '', 'anns', HOSTED_URL)).toBe(`{\n  "kolab": "anns",\n  "url": "${HOSTED_URL}"\n}\n`);
  expect(JSON.parse(projectText('p', '{"note": "ours", "kolab": "old"}', 'anns', HOSTED_URL))).toStrictEqual({ note: 'ours', kolab: 'anns', url: HOSTED_URL });
  expect(() => projectText('p', '{', 'anns', HOSTED_URL)).toThrow(/p isn't JSON/);
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
  expect(await rejection(main(['whoami']))).toBe(`Error: a token is given (KONJIR_TOKEN or --token), but not Kolab's URL, and ${join(r, PROJECT_FILE)} names https://elsewhere.example.com/mcp: konjir sends a token only to a URL you give it, so set KONJIR_URL or pass --url`);
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
  expect(await rejection(main(['--url', LOCAL_URL, '--kolab', 'anns', 'whoami']))).toMatch(new RegExp(`konjir keeps no sign-in for ${LOCAL_URL.replace(/\./g, '\\.')}$`));
});
