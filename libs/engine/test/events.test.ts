// Engine events across Kolab processes (API5, W2.2; D9): each event is notified inside the
// transaction that commits its change, over Postgres LISTEN/NOTIFY, so it reaches every
// process on the database, once, and only if the change commits. Two Kolabs on one database
// stand in for two processes here: each has its own pool and its own listener connection.
// apps/cli/test/processes.test.ts runs two real server processes.
import { describe, expect, test } from '@jest/globals';
import pg from 'pg';
import type { Db } from '@konjir/db';
import { EVENT_CHANNEL, type Kolab } from '@konjir/engine';
import type { KolabEvent } from '@konjir/types';
import { els, openKolab, rejection, testStore } from '@konjir/engine/testing';

const onPostgres = !!process.env.KONJIR_TEST_DATABASE_URL;

/** The engine's own transaction helper, which the verbs use; here to write and signal directly. */
type Internals = { inTransaction<T>(fn: (tx: Db, signal: (e: KolabEvent) => Promise<void>) => Promise<T>): Promise<T> };
const internals = (k: Kolab) => k as unknown as Internals;

function heard(k: Kolab) {
  const events: KolabEvent[] = [];
  k.onEvent((e) => events.push(e));
  return events;
}

async function until(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 300));

test('a rolled-back change signals no one; a committed one signals this Kolab once, after it commits', async () => {
  const kolab = await openKolab();
  await kolab.listen();
  const events = heard(kolab);

  const failed = internals(kolab).inTransaction(async (tx, signal) => {
    await tx.query(`insert into actor(id, name, kind) values ('zed', 'zed', 'person')`);
    await signal({ inbox: 'actor', actor: 'zed' });
    throw new Error('the change fails after signalling');
  });
  expect(await rejection(failed)).toMatch(/fails after signalling/);
  expect((await kolab.listActors()).map((a) => a.id)).toStrictEqual([]);

  await internals(kolab).inTransaction(async (tx, signal) => {
    await tx.query(`insert into actor(id, name, kind) values ('zed', 'zed', 'person')`);
    await signal({ inbox: 'actor', actor: 'zed' });
    await signal({ inbox: 'actor', actor: 'zed' });   // a repeat in one transaction is one event
    expect(events).toStrictEqual([]);                 // nothing before the commit
  });
  expect(events).toStrictEqual([{ inbox: 'actor', actor: 'zed' }]);
  await settle();                                     // and its own NOTIFY, when heard, adds nothing
  expect(events).toStrictEqual([{ inbox: 'actor', actor: 'zed' }]);
});

// PGlite is one process, with no one else to tell: Kolab.listen does nothing there.
(onPostgres ? describe : describe.skip)('across processes, on Postgres', () => {
  async function twoKolabs() {
    const store = await testStore();
    const a = await openKolab(store);
    const b = await openKolab(store);
    await a.listen();
    await b.listen();
    return { a, b, url: store.databaseUrl!, onA: heard(a), onB: heard(b) };
  }

  test('a change made through one Kolab signals the other once, and a rolled-back one signals neither', async () => {
    const { a, b, onA, onB } = await twoKolabs();
    await b.addActor('alice'); await b.addActor('bob');
    const product = await b.openSession('alice', 'product');
    const engineer = await b.openSession('bob', 'engineer');
    await b.createNode(product, 'functional_spec', 'Orders', 'orders');
    await b.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });

    const q = await b.raiseQuery(engineer, 'kj:orders#R1', 'By whom?');
    await until(() => onA.length > 0);
    await b.answerQuery(product, q, 'Office staff.');
    await until(() => onA.length >= 3);
    await settle();
    const expected = [
      { inbox: 'layer', layer: 'functional' },   // the question
      { inbox: 'layer', layer: 'functional' },   // its answer, shrinking the queue
      { inbox: 'actor', actor: 'bob' },          // and growing the asker's answers
    ];
    expect(onA).toStrictEqual(expected);
    expect(onB).toStrictEqual(expected);         // b's own, once each

    onA.length = 0; onB.length = 0;
    const failed = internals(b).inTransaction(async (tx, signal) => {
      await tx.query(`update query set answer = 'nobody' where id = $1`, [q]);
      await signal({ inbox: 'actor', actor: 'bob' });
      throw new Error('rolled back');
    });
    expect(await rejection(failed)).toMatch(/rolled back/);
    await settle();
    expect([onA, onB]).toStrictEqual([[], []]);
  });

  test('an event too long for NOTIFY reaches the other Kolab as a signal to re-read every inbox', async () => {
    const { a, b, onA, onB } = await twoKolabs();
    await a.addActor('alice'); await a.addActor('bob');
    onA.length = 0;
    const long = { inbox: 'actor', actor: 'x'.repeat(9000) } as const;
    await internals(b).inTransaction((_tx, signal) => signal(long));
    expect(onB).toStrictEqual([long]);
    await until(() => onA.length >= 4);
    expect(onA).toStrictEqual([
      { inbox: 'layer', layer: 'functional' }, { inbox: 'layer', layer: 'technical' },
      { inbox: 'actor', actor: 'alice' }, { inbox: 'actor', actor: 'bob' },
    ]);
  });

  test('a listener whose connection drops reconnects, and hears changes made after it', async () => {
    const { b, url, onA } = await twoKolabs();
    await b.addActor('alice');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const listeners = async () => (await admin.query<{ pid: number }>(
        `select pid from pg_stat_activity where datname = current_database() and application_name = $1 order by pid`,
        [`kolab-listen-${EVENT_CHANNEL}`])).rows.map((r) => r.pid);
      const before = await listeners();
      expect(before).toHaveLength(2);   // one per Kolab, apart from their pools

      // Drop both listeners' connections, as a failover or a network blip would.
      const killed = await admin.query<{ ok: boolean }>(`select pg_terminate_backend(pid) as ok from unnest($1::int[]) pid`, [before]);
      expect(killed.rows.every((r) => r.ok)).toBe(true);

      // Each listener reconnects on its own. Keep changing things through b until a hears one.
      let n = 0;
      await until(async () => {
        await internals(b).inTransaction(async (tx, signal) => {
          await tx.query(`update actor set name = $1 where id = 'alice'`, [`Alice ${++n}`]);
          await signal({ inbox: 'actor', actor: `alice-${n}` });
        });
        return onA.length > 0;
      }, 20_000);
      await until(async () => (await listeners()).length === 2);
      const after = await listeners();
      expect(after.filter((p) => before.includes(p))).toStrictEqual([]);
      // a hears every change from then on, without gaps.
      const from = n;
      onA.length = 0;
      for (let i = 1; i <= 3; i++) {
        await internals(b).inTransaction((_tx, signal) => signal({ inbox: 'actor', actor: `after-${from}-${i}` }));
      }
      await until(() => onA.length >= 3);
      expect(onA.map((e) => (e as { actor: string }).actor)).toStrictEqual([1, 2, 3].map((i) => `after-${from}-${i}`));
    } finally {
      await admin.end();
    }
  }, 40_000);
});
