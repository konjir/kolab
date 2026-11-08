// apps/cli/scripts/bun-runtime.mjs installs the pinned Bun that package.mjs bun installs (W7.18).
// These run it against a local server standing in for github.com and registry.npmjs.org, with a
// stand-in bun: the release zip when it downloads; the npm tarball when the zip still fails after
// its retries, with the bun inside it run; and a zip or tarball that doesn't match its pin refused.
// And bun-runtimes.json pins an integrity for each platform's tarball.
import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const RUNTIME = join(ROOT, 'apps/cli/scripts/bun-runtime.mjs');
const dir = mkdtempSync(join(tmpdir(), 'konjir-bun-runtime-'));
const NAME = 'bun-linux-aarch64';
const VERSION = '1.3.8';

/** A stand-in bun that says it is `says`, packed as Bun's release zip and as its npm tarball are. */
function builds(says: string): { zip: Buffer; tgz: Buffer } {
  const at = mkdtempSync(join(dir, 'build-'));
  mkdirSync(join(at, NAME));
  mkdirSync(join(at, 'package/bin'), { recursive: true });
  for (const exe of [join(at, NAME, 'bun'), join(at, 'package/bin/bun')]) {
    writeFileSync(exe, `#!/bin/sh\necho ${says}\n`);
    chmodSync(exe, 0o755);
  }
  writeFileSync(join(at, 'package/package.json'), '{}\n');
  execFileSync('zip', ['-q', '-r', join(at, 'bun.zip'), NAME], { cwd: at });
  execFileSync('tar', ['-czf', join(at, 'bun.tgz'), 'package'], { cwd: at });
  return { zip: readFileSync(join(at, 'bun.zip')), tgz: readFileSync(join(at, 'bun.tgz')) };
}
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const integrity = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;

let good: { zip: Buffer; tgz: Buffer };
let other: { zip: Buffer; tgz: Buffer };
// What each scenario's github.com and registry answer: a body, or a status every time.
const scenarios: Record<string, { zip: Buffer | number; tgz: Buffer | number }> = {};
const hits: Record<string, number> = {};
let server: Server;
let base: string;

beforeAll(async () => {
  good = builds(VERSION);
  other = builds('1.0.0');
  Object.assign(scenarios, {
    github: { zip: good.zip, tgz: 404 },
    npm: { zip: 504, tgz: good.tgz },
    'npm-tampered': { zip: 504, tgz: other.tgz },
    'zip-tampered': { zip: other.zip, tgz: good.tgz },
    'both-down': { zip: 504, tgz: 503 },
    'wrong-version': { zip: other.zip, tgz: 404 },
  });
  server = createServer((req, res) => {
    const path = req.url ?? '';
    hits[path] = (hits[path] ?? 0) + 1;
    const scenario = Object.keys(scenarios).find((s) => path === zipUrl(s) || path === tgzUrl(s));
    const answer = scenario === undefined ? 404 : path === zipUrl(scenario) ? scenarios[scenario].zip : scenarios[scenario].tgz;
    if (typeof answer === 'number') res.writeHead(answer).end('no');
    else res.writeHead(200).end(answer);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
});

/** installBun(NAME) in a child node, with the given scenario's servers, short waits and its own cache. */
function install(scenario: string, pins = { zip: good.zip, tgz: good.tgz }): Promise<{ code: number; stdout: string; stderr: string; out: string }> {
  const out = join(dir, `out-${scenario}`);
  const options = {
    pinned: { version: VERSION, sha256: { [`${NAME}.zip`]: sha256(pins.zip) }, integrity: { [`@oven/${NAME}`]: integrity(pins.tgz) } },
    cache: join(dir, `cache-${scenario}`),
    github: `${base}/${scenario}/gh`,
    npm: `${base}/${scenario}/npm`,
    backoff: [10, 20, 40],
    timeout: 2_000,
  };
  const script = `import { installBun } from ${JSON.stringify(RUNTIME)};
process.stdout.write(await installBun(${JSON.stringify(NAME)}, ${JSON.stringify(out)}, ${JSON.stringify(options)}));`;
  return new Promise((done) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }, (err, stdout, stderr) =>
      done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr, out }));
  });
}

const zipUrl = (scenario: string) => `/${scenario}/gh/bun-v${VERSION}/${NAME}.zip`;
const tgzUrl = (scenario: string) => `/${scenario}/npm/@oven/${NAME}/-/${NAME}-${VERSION}.tgz`;

test('the release zip, when it downloads: its bun is installed and run, and npm is never asked', async () => {
  const r = await install('github');
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(join(r.out, 'bun'));
  expect(execFileSync(join(r.out, 'bun'), { encoding: 'utf8' })).toBe(`${VERSION}\n`);
  expect(r.stderr).toBe(`Bun ${VERSION} (${NAME}): the release zip from 127.0.0.1:${new URL(base).port}, sha256 as pinned\n`);
  expect(hits[tgzUrl('github')]).toBeUndefined();
});

test('a zip that fails after its retries: the npm tarball is taken, checked, and the bun inside it installed and run', async () => {
  const r = await install('npm');
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(join(r.out, 'bun'));
  expect(execFileSync(join(r.out, 'bun'), { encoding: 'utf8' })).toBe(`${VERSION}\n`);
  const host = `127.0.0.1:${new URL(base).port}`;
  expect(r.stderr.split('\n')).toStrictEqual([
    `downloading ${base}${zipUrl('npm')}: HTTP 504; trying again in 0.01 s (try 1 of 4)`,
    `downloading ${base}${zipUrl('npm')}: HTTP 504; trying again in 0.02 s (try 2 of 4)`,
    `downloading ${base}${zipUrl('npm')}: HTTP 504; trying again in 0.04 s (try 3 of 4)`,
    `Bun ${VERSION} (${NAME}): the release zip didn't download (downloading ${base}${zipUrl('npm')}: HTTP 504, after 4 tries); taking @oven/${NAME}@${VERSION} from npm instead`,
    `Bun ${VERSION} (${NAME}): the npm tarball @oven/${NAME}@${VERSION} from ${host}, integrity as pinned`,
    '',
  ]);
  expect(hits[zipUrl('npm')]).toBe(4);
  expect(hits[tgzUrl('npm')]).toBe(1);

  // Run again, it uses the tarball it keeps, checked again, and asks neither server.
  const again = await install('npm');
  expect(again.code).toBe(0);
  expect(again.stderr).toBe(`Bun ${VERSION} (${NAME}): the npm tarball @oven/${NAME}@${VERSION} from ${host}, integrity as pinned\n`);
  expect(hits[zipUrl('npm')]).toBe(4);
  expect(hits[tgzUrl('npm')]).toBe(1);
});

test("a tarball that doesn't match its pin is refused, and nothing is installed or kept", async () => {
  const r = await install('npm-tampered');
  expect(r.code).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain(`Error: ${NAME}-${VERSION}.tgz (@oven/${NAME}) has integrity ${integrity(other.tgz)}, but apps/cli/bun-runtimes.json pins ${integrity(good.tgz)}; refusing to use it`);
  expect(existsSync(join(r.out, 'bun'))).toBe(false);
  expect(existsSync(join(dir, 'cache-npm-tampered', `${NAME}-${VERSION}.tgz`))).toBe(false);
});

test("a zip that doesn't match its pin is refused, and npm is not asked instead", async () => {
  const r = await install('zip-tampered');
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(`Error: ${NAME}.zip has sha256 ${sha256(other.zip)}, but apps/cli/bun-runtimes.json pins ${sha256(good.zip)}; refusing to use it`);
  expect(existsSync(join(r.out, 'bun'))).toBe(false);
  expect(hits[tgzUrl('zip-tampered')]).toBeUndefined();
});

test('when npm fails too, it says both', async () => {
  const r = await install('both-down');
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(`the release zip didn't download (downloading ${base}${zipUrl('both-down')}: HTTP 504, after 4 tries)`);
  expect(r.stderr).toContain(`Error: downloading ${base}${tgzUrl('both-down')}: HTTP 503, after 4 tries`);
});

test('a bun that, run, says it is another version is refused', async () => {
  // Pins that match what is served, a bun of another version.
  const r = await install('wrong-version', other);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(`Error: ${join(r.out, 'bun')} says it is Bun 1.0.0, but apps/cli/bun-runtimes.json pins ${VERSION}`);
});

test("bun-runtimes.json pins each platform's npm tarball by its sha512 integrity, beside its zip's sha256", () => {
  const pinned = JSON.parse(readFileSync(join(ROOT, 'apps/cli/bun-runtimes.json'), 'utf8'));
  const names = Object.keys(pinned.sha256).map((zip) => zip.replace(/\.zip$/, ''));
  expect(names.sort()).toStrictEqual(['bun-darwin-aarch64', 'bun-darwin-x64-baseline', 'bun-linux-aarch64', 'bun-linux-x64-baseline', 'bun-windows-x64-baseline']);
  expect(Object.keys(pinned.integrity).sort()).toStrictEqual(names.map((n) => `@oven/${n}`));
  for (const pin of Object.values(pinned.integrity)) expect(pin).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
});
