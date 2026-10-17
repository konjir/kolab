// Engine events across Kolab processes (API5, W2.2; D9): each event is notified inside the
// transaction that commits its change, over Postgres LISTEN/NOTIFY, so it reaches every
// process on the database, once, and only if the change commits. Two Kolabs on one database
// stand in for two processes here: each has its own pool and its own listener connection.
// apps/cli/test/processes.test.ts runs two real server processes.
import { describe, expect, test } from '@jest/globals';
import { createServer, Socket as NetSocket, type Socket } from 'node:net';
import pg from 'pg';
import { listenerConnection, openDb, type Db } from '@konjir/db';
import { EVENT_CHANNEL, isKolabEvent, maskTokens, sessionKey, type Kolab, type ListenerState } from '@konjir/engine';
import type { KolabEvent } from '@konjir/types';
import { els, marksOn, openKolab, rejection, setup, testStore } from '@konjir/engine/testing';

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
  expect(await kolab.listenerConnected()).toBe(onPostgres ? true : undefined);
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

test('clearing a mark signals every layer whose inbox it empties, the cascade\'s included', async () => {
  const { kolab, product, engineer } = await setup();
  const spec = await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
  const s1 = await kolab.commit(product, spec, { elements: els({ R1: 'Orders can be cancelled.' }) });
  const binding = await kolab.createNode(engineer, 'technical_binding', 'Orders on Postgres', 'orders-pg');
  const b1 = await kolab.commit(engineer, binding, { elements: els({ b1: 'A cancel endpoint.' }) });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1' });
  // A functional prototype relies on the binding, so a mark on the binding cascades to it.
  const proto = await kolab.createNode(product, 'prototype', 'Cancel screen', 'cancel-ui');
  const p1 = await kolab.commit(product, proto, { elements: els({ F: 'A cancel button.' }) });
  await kolab.link(product, { kind: 'dependency', source: p1, sourceElement: 'F', target: b1, targetElement: 'b1' });
  await kolab.commit(product, spec, { elements: els({ R1: 'Orders can be cancelled until shipped.' }) });
  const [changed] = await marksOn(kolab, binding);
  expect((await marksOn(kolab, proto)).map((m) => m.reason)).toStrictEqual(['upstream_dirty']);

  const events = heard(kolab);
  await kolab.clear(engineer, changed.id);
  expect(await marksOn(kolab, proto)).toStrictEqual([]);
  expect(events).toStrictEqual([{ inbox: 'layer', layer: 'technical' }, { inbox: 'layer', layer: 'functional' }]);
});

test('a listener that can\'t LISTEN at boot rejects, and leaves nothing behind still reconnecting', async () => {
  // A "server" that hangs up on every connection, counting the attempts.
  let attempts = 0;
  const sockets = new Set<Socket>();
  const server = createServer((sock) => { attempts++; sockets.add(sock); sock.destroy(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const db = openDb({ databaseUrl: `postgres://kolab:x@127.0.0.1:${port}/kolab` });
  const original = console.error;
  try {
    expect(await rejection(db.listen(EVENT_CHANNEL, () => undefined, { applicationName: 'kolab-listen-test' }))).toMatch(/Error/);
    const after = attempts;
    await new Promise((r) => setTimeout(r, 2500));   // past pg-listen's 500 ms retry and the listener's 1 s re-init
    expect(attempts).toBe(after);
  } finally {
    console.error = original;
    await db.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('isKolabEvent accepts the events Kolab sends, and nothing else', () => {
  expect([
    { inbox: 'layer', layer: 'functional' }, { inbox: 'actor', actor: 'alice-pm' },
    { session: 'ended', id: sessionKey('kjs_anything') },
  ].every(isKolabEvent)).toBe(true);
  expect([
    undefined, null, 'null', 3, [], {}, { inbox: 'layer', layer: '<script>' }, { inbox: 'actor', actor: 7 },
    { inbox: 'actor', actor: '../x' }, { inbox: 'mailbox' }, { inbox: 'actor', actor: 'x', extra: 1 },
    { session: 'ended', id: 'kjs_a-raw-token' }, { session: 'open', id: sessionKey('kjs_x') },
  ].some(isKolabEvent)).toBe(false);
});

test('the listening connection notices a silent drop: bounded checks, early keepalive, bounded connects', () => {
  expect(listenerConnection('postgres://kolab@db/kolab', 'kolab-listen-x')).toStrictEqual({
    connectionString: 'postgres://kolab@db/kolab',
    application_name: 'kolab-listen-x',
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    query_timeout: 5_000,
    connectionTimeoutMillis: 10_000,
    paranoidChecking: 10_000,
  });
});

test('maskTokens masks every session token in an error', () => {
  expect(maskTokens(new Error('no session kjs_AbC-1_x or kjs_z'))).toBe('no session kjs_*** or kjs_***');
  expect(maskTokens('kjs_q')).toBe('kjs_***');
});

/** A TCP proxy to Postgres that can go silent: it stops passing bytes either way, and closes nothing, as a dropped route would. */
async function silenceableProxy(databaseUrl: string) {
  const target = new URL(databaseUrl);
  let silent = false;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = new NetSocket();
    sockets.add(client); sockets.add(upstream);
    const born = silent;
    upstream.connect(Number(target.port || 5432), target.hostname);
    client.on('data', (d: Buffer) => { if (!silent && !born) upstream.write(d); });
    upstream.on('data', (d: Buffer) => { if (!silent && !born) client.write(d); });
    const drop = () => { if (!silent) { client.destroy(); upstream.destroy(); } };
    client.on('close', drop); upstream.on('close', drop);
    client.on('error', () => undefined); upstream.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as { port: number }).port);
  return {
    url: url.toString(),
    silence: (on: boolean) => { silent = on; },
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

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

  test('a session ended through one Kolab reaches the other by its sessionKey, never its token', async () => {
    const { b, onA } = await twoKolabs();
    await b.addActor('alice');
    const token = await b.openSession('alice', 'product');
    await b.endSession(token);
    await until(() => onA.length > 0);
    expect(onA).toStrictEqual([{ session: 'ended', id: sessionKey(token) }]);
    expect(JSON.stringify(onA)).not.toContain(token);
  });

  test('an event too long for NOTIFY reaches the other Kolab as a signal to re-read every inbox', async () => {
    const { a, b, onA, onB } = await twoKolabs();
    await a.addActor('alice'); await a.addActor('bob'); await a.addActor('carol');
    await a.openSession('alice', 'product'); await a.openSession('bob', 'engineer');
    const ended = await a.openSession('carol', 'product');
    await a.endSession(ended);
    await until(() => onB.some((e) => 'session' in e));   // a told itself at once; b hears it over NOTIFY
    onA.length = 0; onB.length = 0;
    const long = { inbox: 'actor', actor: 'x'.repeat(9000) } as const;
    await internals(b).inTransaction((_tx, signal) => signal(long));
    expect(onB).toStrictEqual([long]);
    await until(() => onA.length >= 4);
    // Every inbox, and the answers of each actor with an open session: carol has none, so no one can be listening to hers.
    expect(onA).toStrictEqual([
      { inbox: 'layer', layer: 'functional' }, { inbox: 'layer', layer: 'technical' },
      { inbox: 'actor', actor: 'alice' }, { inbox: 'actor', actor: 'bob' },
    ]);
  });

  test('a bad notification on the channel is dropped, and the Kolab goes on hearing real events', async () => {
    const { a, b, url, onA } = await twoKolabs();
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: unknown) => { errors.push(String(m)); };
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`notify ${EVENT_CHANNEL}`);                                  // no payload
      for (const bad of ['null', '"str"', '7', '[]', '{}', '{"from":"x"}',
        '{"from":"x","event":{"inbox":"layer","layer":"<script>"}}', '{"from":"x","event":{"inbox":"actor","actor":"x","session":"kjs_secret"}, "resync": false}']) {
        await admin.query(`select pg_notify($1, $2)`, [EVENT_CHANNEL, bad]);
      }
      await admin.query(`select pg_notify($1, $2)`, [EVENT_CHANNEL, '{"from":"x","event":{"inbox":"actor","actor":"zed"}}']);
      await until(() => onA.length > 0);
      expect(onA).toStrictEqual([{ inbox: 'actor', actor: 'zed' }]);   // only the valid one
      expect(errors.filter((e) => e.includes('dropped a notification'))).toHaveLength(2 * 9);   // a and b each drop all nine
      expect(errors.some((e) => e.includes('<script>') || e.includes('str'))).toBe(false);   // no payloads in the log
      expect([a.droppedNotifications, b.droppedNotifications]).toStrictEqual([9, 9]);
    } finally {
      console.error = original;
      await admin.end();
    }
  });

  test('a notification that isn\'t JSON is dropped without reconnecting, and the next real event arrives', async () => {
    const { a, b, url, onA } = await twoKolabs();
    const logged: string[] = [];
    const originals = { error: console.error, warn: console.warn, log: console.log };
    console.error = console.warn = console.log = (...m: unknown[]) => { logged.push(m.map(String).join(' ')); };
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const listeners = async () => (await admin.query<{ pid: number }>(
        `select pid from pg_stat_activity where datname = current_database() and application_name like 'kolab-listen-%' order by pid`,
      )).rows.map((r) => r.pid);
      const before = await listeners();
      expect(before).toHaveLength(2);

      await admin.query(`select pg_notify($1, $2)`, [EVENT_CHANNEL, '{bad-json-payload']);
      await admin.query(`select pg_notify($1, $2)`, [EVENT_CHANNEL, '{"from":"x","event":{"inbox":"actor","actor":"after-bad"}}']);
      await until(() => onA.length > 0);
      expect(onA).toStrictEqual([{ inbox: 'actor', actor: 'after-bad' }]);
      // No reconnect: the same backends, still listening, and nothing was resynced.
      expect([await a.listenerConnected(), await b.listenerConnected()]).toStrictEqual([true, true]);
      expect(await listeners()).toStrictEqual(before);
      await settle();
      expect(onA).toStrictEqual([{ inbox: 'actor', actor: 'after-bad' }]);
      // Counted and logged, once by each Kolab, never with the payload.
      expect([a.droppedNotifications, b.droppedNotifications]).toStrictEqual([1, 1]);
      expect(logged.filter((m) => m.includes('isn\'t JSON'))).toHaveLength(2);
      expect(logged.some((m) => m.includes('bad-json-payload'))).toBe(false);
    } finally {
      Object.assign(console, originals);
      await admin.end();
    }
  });

  test('a change committed while a Kolab\'s listener is reconnecting reaches that Kolab\'s listeners once it\'s back', async () => {
    const { a, b, url, onA } = await twoKolabs();
    const states: ListenerState[] = [];
    a.onListenerState((s) => states.push(s));
    await b.addActor('alice'); await b.addActor('bob');
    const product = await b.openSession('alice', 'product');
    const engineer = await b.openSession('bob', 'engineer');
    await b.createNode(product, 'functional_spec', 'Orders', 'orders');
    await b.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
    await settle();
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const originals = { error: console.error, warn: console.warn };
    console.error = console.warn = () => undefined;   // the listener's own lines about the loss
    try {
      onA.length = 0;
      // Drop a's listening connection only, as a failover or a network blip would.
      const killed = await admin.query<{ ok: boolean }>(
        `select pg_terminate_backend(pid) as ok from pg_stat_activity where application_name = $1`, [`kolab-listen-${(a as unknown as { origin: string }).origin}`]);
      expect(killed.rows.map((r) => r.ok)).toStrictEqual([true]);
      await until(async () => (await a.listenerConnected()) === false);

      // While it's down, bob asks alice a question through b: a doesn't hear it...
      await b.raiseQuery(engineer, 'kj:orders#R1', 'By whom?');
      expect(await a.listenerConnected()).toBe(false);   // committed during the outage
      expect(onA).toStrictEqual([]);

      // ...until its listener is back, when a resyncs: every inbox, and each open session's answers.
      await until(async () => (await a.listenerConnected()) === true, 20_000);
      await until(() => onA.length >= 4);
      await settle();
      expect(onA).toStrictEqual([
        { inbox: 'layer', layer: 'functional' }, { inbox: 'layer', layer: 'technical' },
        { inbox: 'actor', actor: 'alice' }, { inbox: 'actor', actor: 'bob' },
      ]);
      expect(states).toStrictEqual([{ state: 'lost' }, { state: 'restored' }]);

      // And it hears what's committed from then on.
      onA.length = 0;
      await b.raiseQuery(engineer, 'kj:orders#R1', 'And refunds?');
      await until(() => onA.length > 0);
      expect(onA).toStrictEqual([{ inbox: 'layer', layer: 'functional' }]);
    } finally {
      Object.assign(console, originals);
      await admin.end();
    }
  }, 40_000);

  test('a listener whose connection drops reconnects, and hears changes made after it', async () => {
    const { a, b, url, onA } = await twoKolabs();
    expect(await a.listenerConnected()).toBe(true);
    await b.addActor('alice');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const listeners = async () => (await admin.query<{ pid: number }>(
        `select pid from pg_stat_activity where datname = current_database() and application_name like 'kolab-listen-%' order by pid`,
      )).rows.map((r) => r.pid);
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
      expect(await a.listenerConnected()).toBe(true);
    } finally {
      await admin.end();
    }
  }, 40_000);

  test('a resync that fails after a reconnect signals nothing, and is retried until everything is signalled', async () => {
    const { a, b, url, onA } = await twoKolabs();
    await b.addActor('alice'); await b.addActor('bob');
    const product = await b.openSession('alice', 'product');
    const engineer = await b.openSession('bob', 'engineer');
    await b.createNode(product, 'functional_spec', 'Orders', 'orders');
    await b.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
    const q = await b.raiseQuery(engineer, 'kj:orders#R1', 'By whom?');
    await settle();
    const states: ListenerState[] = [];
    let atFailure: KolabEvent[] | undefined;
    a.onListenerState((s) => { states.push(s); if (s.state === 'resync_failed') atFailure = [...onA]; });
    // The resync's session query fails once, as the pool's first query after a failover might.
    const query = a.db.query.bind(a.db);
    let failed = 0;
    a.db.query = (async (text: string, params?: unknown[]) => {
      if (/from session where ended_at is null/.test(text) && failed++ === 0) throw new Error('connection terminated unexpectedly');
      return query(text, params);
    }) as Db['query'];
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const originals = { error: console.error, warn: console.warn };
    console.error = console.warn = () => undefined;
    try {
      onA.length = 0;
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1`,
        [`kolab-listen-${(a as unknown as { origin: string }).origin}`]);
      await until(async () => (await a.listenerConnected()) === false);
      await b.answerQuery(product, q, 'Office staff.');   // bob's answers change while a can't hear it

      await until(() => states.some((s) => s.state === 'restored'), 20_000);
      expect(states).toStrictEqual([
        { state: 'lost' },
        { state: 'resync_failed', retryInMs: 1000, error: 'connection terminated unexpectedly' },
        { state: 'restored' },
      ]);
      expect(atFailure).toStrictEqual([]);   // the failed attempt signalled nothing
      expect(onA).toStrictEqual([
        { inbox: 'layer', layer: 'functional' }, { inbox: 'layer', layer: 'technical' },
        { inbox: 'actor', actor: 'alice' }, { inbox: 'actor', actor: 'bob' },
      ]);
    } finally {
      Object.assign(console, originals);
      a.db.query = query;
      await admin.end();
    }
  }, 40_000);

  test('a listening connection that goes silent, with no FIN or RST, is noticed, reconnected and resynced', async () => {
    const store = await testStore();
    const proxy = await silenceableProxy(store.databaseUrl!);
    const b = await openKolab(store);
    const db = openDb({ databaseUrl: proxy.url });
    const heard: unknown[] = [];
    const listening: boolean[] = [];
    let lost = 0;
    const originals = { error: console.error, warn: console.warn };
    console.error = console.warn = () => undefined;
    let l: Awaited<ReturnType<Db['listen']>>;
    try {
      l = await db.listen(EVENT_CHANNEL, (p) => heard.push(p), {
        applicationName: 'kolab-listen-silent', onListening: ({ reconnected }) => listening.push(reconnected), onConnectionLost: () => { lost++; },
      });
      expect(l!.connected()).toBe(true);
      proxy.silence(true);
      const t0 = Date.now();
      await until(() => !l!.connected(), 30_000);
      expect(Date.now() - t0).toBeLessThan(25_000);   // the 10 s check, unanswered for 5 s
      expect(lost).toBe(1);
      proxy.silence(false);
      await until(() => l!.connected(), 40_000);
      expect(listening).toStrictEqual([false, true]);
      await internals(b).inTransaction((_tx, signal) => signal({ inbox: 'actor', actor: 'after-silence' }));
      await until(() => heard.length > 0);
      expect(heard).toStrictEqual([{ from: (b as unknown as { origin: string }).origin, event: { inbox: 'actor', actor: 'after-silence' } }]);
    } finally {
      Object.assign(console, originals);
      await l!?.close();
      await db.close();
      await proxy.close();
    }
  }, 90_000);
});
