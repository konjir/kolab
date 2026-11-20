// Closing a database closes its PGlite, whether or not it was ever queried (TST3, W2.9), and closes
// a Postgres pool even with a query on its way.
import { afterEach, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { openDb } from '@konjir/db';
import { testStore } from '@konjir/engine/testing';

const dirs: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Opens a database in a directory of its own and runs `use` on it, then reports how many times
 * `close` was called on that directory's PGlite, and whether that PGlite is now closed. (PGlite
 * makes and closes a second instance of its own while it starts up; the directory tells them apart.)
 */
async function closes(use: (db: ReturnType<typeof openDb>) => Promise<void>) {
  const close = jest.spyOn(PGlite.prototype, 'close');
  const dataDir = mkdtempSync(join(tmpdir(), 'konjir-db-'));
  dirs.push(dataDir);
  await use(openDb({ dataDir }));
  const ours = (close.mock.contexts as PGlite[]).filter((p) => p.dataDir === dataDir);
  return { calls: ours.length, closed: ours.every((p) => p.closed) };
}

test('a database closed before its first query closes its PGlite', async () => {
  // Kysely destroys only a driver it has initialized, so this PGlite used to go on starting up.
  expect(await closes((db) => db.close())).toStrictEqual({ calls: 1, closed: true });
});

test('a database closed twice at once, and again, closes its PGlite once', async () => {
  expect(await closes(async (db) => {
    expect((await db.query<{ n: number }>('select 1 as n')).rows).toStrictEqual([{ n: 1 }]);
    await Promise.all([db.close(), db.close()]);
    await db.close();
  })).toStrictEqual({ calls: 1, closed: true });
});

// Kysely before 0.29.7 lost a client the pool was still connecting when it was destroyed: the
// query failed, the client was never given back, and the pool's end waited for it for ever. A
// test's Kolab closed while its server was still answering a request hung its teardown so.
(process.env.KONJIR_TEST_DATABASE_URL ? test : test.skip)('a database closed while a query waits for a new connection closes, and the query is refused', async () => {
  const db = openDb(await testStore());
  await db.query('select 1');
  // The pool's one client is busy, so the next query opens another: closed while that connects.
  const busy = db.query('select pg_sleep(0.3)');
  const late = db.query('select 2').then(() => 'ran', () => 'refused');
  await new Promise((r) => setImmediate(r));
  await db.close();
  expect(await busy.then(() => 'ran')).toBe('ran');
  expect(await late).toBe('refused');
}, 15_000);
