// apps/cli/scripts/download.mjs fetches the Bun release zips package.mjs pins (W7.17). These run
// it against a local server: a 5xx is tried again until the body comes, a 5xx every time fails
// naming the URL and the status, and other statuses fail at once. And each workflow step that
// installs Bun fails when package.mjs bun does, as GitHub runs it (bash -e -o pipefail), rather
// than passing on to "no bun on PATH" in the next step.
import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const DOWNLOAD = join(ROOT, 'apps/cli/scripts/download.mjs');
const dir = mkdtempSync(join(tmpdir(), 'konjir-bun-download-'));

// Each path answers its own list of statuses in turn, the last one for every request after.
const answers: Record<string, number[]> = {
  '/flaky.zip': [504, 502, 200],
  '/down.zip': [504],
  '/gone.zip': [404, 200],
};
const hits: Record<string, number> = {};
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '';
    const n = (hits[path] = (hits[path] ?? 0) + 1);
    const list = answers[path] ?? [404];
    const status = list[Math.min(n, list.length) - 1];
    res.writeHead(status).end(status === 200 ? 'the zip' : 'Gateway Timeout');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
});

/** Run download(url) in a child node with short waits, as package.mjs does but without its own Bun pin. */
function run(url: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = `import { download } from ${JSON.stringify(DOWNLOAD)};
process.stdout.write(await download(process.argv[1], { backoff: [10, 20, 40] }));`;
  return new Promise((done) => {
    execFile(process.execPath, ['--input-type=module', '-e', script, url], { encoding: 'utf8' }, (err, stdout, stderr) =>
      done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

test('a 504, then a 502, then a 200 gets the body, saying each retry', async () => {
  const r = await run(`${base}/flaky.zip`);
  expect(r).toStrictEqual({
    code: 0,
    stdout: 'the zip',
    stderr: `downloading ${base}/flaky.zip: HTTP 504; trying again in 0.01 s (try 1 of 4)\n`
      + `downloading ${base}/flaky.zip: HTTP 502; trying again in 0.02 s (try 2 of 4)\n`,
  });
  expect(hits['/flaky.zip']).toBe(3);
});

test('a 504 every time gives up after four tries, naming the URL and the status', async () => {
  const r = await run(`${base}/down.zip`);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain(`Error: downloading ${base}/down.zip: HTTP 504, after 4 tries`);
  expect(hits['/down.zip']).toBe(4);
});

test('a 404 is not retried', async () => {
  const r = await run(`${base}/gone.zip`);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(`Error: downloading ${base}/gone.zip: HTTP 404\n`);
  expect(hits['/gone.zip']).toBe(1);
});

test('a network error is retried, then fails naming the URL and the error', async () => {
  // A port nothing listens on: the server above, closed.
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((done) => closed.close(done));
  const r = await run(`http://127.0.0.1:${port}/bun.zip`);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(`downloading http://127.0.0.1:${port}/bun.zip: network error: connect ECONNREFUSED 127.0.0.1:${port}; trying again in 0.01 s (try 1 of 4)`);
  expect(r.stderr).toContain(`Error: downloading http://127.0.0.1:${port}/bun.zip: network error: connect ECONNREFUSED 127.0.0.1:${port}, after 4 tries`);
});

/** The run script of a workflow's "Install Bun" step. */
function installStep(workflow: string): string {
  const lines = readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8').split('\n');
  const at = lines.findIndex((l) => /^\s*- name: Install Bun\s*$/.test(l));
  expect(at).toBeGreaterThan(-1);
  const run = /^(\s*)run: \|\s*$/.exec(lines[at + 1]);
  expect(run).not.toBeNull();
  const body: string[] = [];
  for (const l of lines.slice(at + 2)) {
    if (l.trim() && l.length - l.trimStart().length <= run![1].length) break;
    body.push(l.trim());
  }
  return body.join('\n');
}

test.each(['cli.yml', 'release-cli.yml'])("%s's Install Bun step fails when package.mjs bun fails, and adds nothing to the PATH", (workflow) => {
  const script = installStep(workflow);
  expect(script).toContain('node apps/cli/scripts/package.mjs bun "$RUNNER_TEMP/bun"');
  // A node that fails as package.mjs does when every download answers 504.
  const bin = join(dir, `bin-${workflow}`);
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "Error: downloading https://github.com/…/bun.zip: HTTP 504, after 4 tries" >&2\nexit 1\n');
  chmodSync(join(bin, 'node'), 0o755);
  const githubPath = join(dir, `path-${workflow}`);
  writeFileSync(githubPath, '');
  // GitHub runs a step's script with bash --noprofile --norc -eo pipefail.
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_PATH: githubPath },
  });
  expect(r.status).toBe(1);
  expect(readFileSync(githubPath, 'utf8')).toBe('');

  // And the same step passes, adding the directory, when it succeeds.
  writeFileSync(join(bin, 'node'), `#!/bin/sh\necho "$RUNNER_TEMP/bun/bun"\n`);
  const ok = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_PATH: githubPath },
  });
  expect(ok.status).toBe(0);
  expect(readFileSync(githubPath, 'utf8')).toBe(`${dir}/bun\n`);
});
