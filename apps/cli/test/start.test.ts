// The release's start script, run the way the instance runs it: through a symlink
// (/opt/konjir/current -> /opt/konjir/releases/<ts>). tsx applies its tsconfig only to files
// under the tsconfig's directory by real path, so a start script that used the symlinked path
// compiled the server without the decorators NestJS needs, and Kolab restarted in a loop.
import { afterAll, expect, test } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'konjir-start-'));
let child: ChildProcess | undefined;

afterAll(() => {
  child?.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
});

test('deploy/release/start.sh serves /healthz when the release is reached through a symlink', async () => {
  symlinkSync(root, join(dir, 'current'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  child = spawn('bash', [join(dir, 'current/deploy/release/start.sh'), '--port', String(port), '--data', join(dir, 'data')], {
    env: { ...process.env, KONJIR_ADMIN_TOKEN: 'start-test', KONJIR_DATABASE_URL: '' },
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
}, 60_000);
