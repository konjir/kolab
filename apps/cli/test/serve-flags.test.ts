// `konjir serve --no-migrate --no-worker` (W2.24): a restore's smoke check opens a database without
// migrating it or running its outbox, and says so at warn; a database that needs a migration is refused.
import { expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '@konjir/db';
import { openKolab, persistentStore, type Store } from '@konjir/engine/testing';

const root = resolve(import.meta.dirname, '../../..');

/** Runs `konjir serve` on the store with `flags` until it listens or exits, then stops it; resolves with what it printed and how it ended. */
function serve(store: Store, flags: string[]): Promise<{ outcome: 'listening' | 'exited'; output: string }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const where = store.databaseUrl ? ['--database-url', store.databaseUrl] : ['--data', store.dataDir!];
  const child = spawn('node', [join(root, 'apps/cli/dist/main.js'), 'serve', '--port', String(port), ...where, ...flags, '--quiet'], {
    env: { ...process.env, NODE_OPTIONS: '--no-experimental-strip-types', KONJIR_ADMIN_TOKEN: 'admin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  return new Promise((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    const seen = (d: Buffer) => {
      output += d;
      if (output.includes('Kolab listening')) child.kill('SIGTERM');
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.on('exit', () => {
      clearTimeout(timer);
      done({ outcome: output.includes('Kolab listening') ? 'listening' : 'exited', output });
    });
  });
}

const tableOf = async (store: Store, table: string) => {
  const db = openDb(store);
  try {
    return (await db.query<{ t: string | null }>(`select to_regclass($1)::text as t`, [`public.${table}`])).rows[0].t;
  } finally {
    await db.close();
  }
};

test('serve --no-migrate refuses a database that needs a migration, and leaves it as it was', async () => {
  const store: Store = process.env.KONJIR_TEST_DATABASE_URL ? await persistentStore() : { dataDir: mkdtempSync(join(tmpdir(), 'konjir-')) };
  const run = await serve(store, ['--no-migrate']);
  expect(run.outcome).toBe('exited');
  expect(run.output).toMatch(/no migration record \(kj_migration\)/);
  expect(await tableOf(store, 'kj_migration')).toBeNull();
}, 90_000);

test('serve --no-migrate --no-worker opens a current database, and warns that it migrates nothing and runs no outbox', async () => {
  const store = await persistentStore();
  const kolab = await openKolab(store);
  await kolab.close();
  const run = await serve(store, ['--no-migrate', '--no-worker']);
  expect(run.outcome).toBe('listening');
  const warned = run.output.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { level: string; message: string })
    .filter((l) => l.level === 'warn').map((l) => l.message);
  expect(warned).toEqual(expect.arrayContaining([
    expect.stringMatching(/^migrations: checked, none applied \(--no-migrate\)/),
    expect.stringMatching(/^outbox: no worker \(--no-worker\)/),
  ]));
}, 90_000);

