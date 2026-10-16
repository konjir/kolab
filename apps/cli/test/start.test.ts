// The release's start script, run the way the instance runs it: plain node on the compiled
// dist/ (RUN2), reached through a symlink (/opt/konjir/current -> /opt/konjir/releases/<ts>).
// Nx builds every project before this test (the test target depends on build), as the
// release's install.sh does before the instance starts it.
import { afterAll, expect, test } from '@jest/globals';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'konjir-start-'));
let child: ChildProcess | undefined;

afterAll(() => {
  child?.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
});

test('deploy/release/start.sh serves /healthz with node on the compiled output, through a symlink', async () => {
  expect(existsSync(join(root, 'apps/cli/dist/main.js'))).toBe(true); // run it through Nx, which builds first
  symlinkSync(root, join(dir, 'current'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  child = spawn('bash', [join(dir, 'current/deploy/release/start.sh'), '--port', String(port), '--data', join(dir, 'data')], {
    // No type stripping: if any package still resolved to its .ts source, node would fail to load it.
    env: { ...process.env, NODE_OPTIONS: '--no-experimental-strip-types', KONJIR_ADMIN_TOKEN: 'start-test', KONJIR_DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  const exited = new Promise<number | null>((done) => child!.on('exit', done));

  const listening = new Promise<void>((done) => child!.stdout!.on('data', () => { if (output.includes('Kolab listening')) done(); }));
  const outcome = await Promise.race([listening.then(() => 'listening'), exited.then(() => 'exited')]);
  expect({ outcome, output: outcome === 'exited' ? output : '' }).toStrictEqual({ outcome: 'listening', output: '' });

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  expect(await res.text()).toBe('ok');

  // start.sh execs node, so the child is the server itself: node on dist, with no tsx.
  const command = execFileSync('ps', ['-o', 'args=', '-p', String(child.pid)], { encoding: 'utf8' }).trim();
  expect(command).toBe(`node apps/cli/dist/main.js serve --port ${port} --data ${join(dir, 'data')} --quiet`);
}, 60_000);
