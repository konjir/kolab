// Durable waits (W1.8; REV3, VER2, CAS7, API5): review and question waits are rows, and the work a
// verdict still owes is a job in a transactional outbox, written with the verdict. A Kolab process
// that stops between steps loses no request or verdict, and the next process to open the database
// finishes the work once. Each test stops a Kolab as a dying process would, by closing its
// database under it at an exact point, then opens another Kolab on the same database, on PGlite
// and on Postgres.
import { expect, test } from '@jest/globals';
import { Kolab, structuralChecks } from '@konjir/engine';
import { commitReviewed, els, marksOn, openKolab, people, persistentStore, rejection, textOf, type Store } from '@konjir/engine/testing';
import type { CheckContext, Checks } from '@konjir/types';

const onPostgres = !!process.env.KONJIR_TEST_DATABASE_URL;
/** Claims lapse quickly here, so a process opened after a stop on Postgres can take its jobs. */
const LEASE_MS = 300;

/**
 * A Kolab on `store` whose structural checks stop for good at the first version `at` picks: the
 * call never returns. `stopped` resolves when it gets there.
 */
async function stoppingAt(store: Store, at: (ctx: CheckContext) => boolean) {
  let reached!: () => void;
  const stopped = new Promise<void>((r) => { reached = r; });
  const checks: Checks = async (ctx) => {
    if (!at(ctx)) return structuralChecks(ctx);
    reached();
    return new Promise(() => undefined);
  };
  const kolab = await openKolab({ ...store, checks, outboxLeaseMs: LEASE_MS });
  return { kolab, stopped };
}

/** Stops `kolab` as a process that dies does: its connections close, and nothing it was doing finishes or cleans up. */
const die = (kolab: Kolab) => kolab.db.close();

/** Opens the database again in a new Kolab, once any claim the dead process held has lapsed. */
async function restart(store: Store) {
  if (onPostgres) await new Promise((r) => setTimeout(r, LEASE_MS + 100));
  return openKolab({ ...store, outboxLeaseMs: LEASE_MS });
}

const jobs = async (kolab: Kolab) =>
  (await kolab.db.query<{ kind: string; version_id: string; attempts: number; claimed_by: string | null }>(
    `select kind, version_id, attempts, claimed_by from outbox order by id`)).rows;

/** Every version of a node: seq, role, state, note and the version it folds, in seq order. */
async function history(kolab: Kolab, node: string) {
  return (await kolab.db.query<{ seq: number; active_role: string; state: string; review_note: string | null; folded: number | null }>(
    `select v.seq, v.active_role, v.state, v.review_note, f.seq as folded
       from version v left join version f on f.id = v.folded_from where v.node_id = $1 order by v.seq`, [node])).rows;
}

const verdicts = async (kolab: Kolab, versionId: string) =>
  (await kolab.db.query<{ reviewer_id: string; state: string }>(
    `select reviewer_id, state from review_request where version_id = $1 order by created_at, id`, [versionId])).rows;

/**
 * Alice and Dave each review the other's specs. P@1 and its variant V@1 are committed; Alice's
 * V@2 waits in review; P@2 commits, and Kolab's rebase of V, V@3, overtakes V@2. Dave's approval
 * of V@2 now folds it onto V@3 (CAS7, D38).
 */
async function overtakenInReview(kolab: Kolab) {
  await people(kolab, ['alice', 'dave'], { layers: ['functional'] });
  const alice = await kolab.openSession('alice', 'product');
  const dave = await kolab.openSession('dave', 'product');
  await kolab.createNode(alice, 'functional_spec', 'P', 'P');
  const p1 = await commitReviewed(kolab, alice, dave, 'P', { elements: els({ E1: 'Parent one.', E2: 'Parent two.' }) });
  await kolab.createNode(alice, 'functional_spec', 'V', 'V');
  await commitReviewed(kolab, alice, dave, 'V', { parent: p1, deltas: [{ kind: 'override', element: 'E2', text: 'V says two its way.' }] });
  const v2 = await kolab.draft(alice, 'V', { deltas: [{ kind: 'add', element: 'A', text: 'Alice adds A.' }] });
  expect(await kolab.review(v2)).toMatchObject({ in_review: true, reviewers: ['dave'] });
  await commitReviewed(kolab, alice, dave, 'P', { elements: els({ E1: 'Parent one, revised.', E2: 'Parent two.' }) });
  expect((await kolab.latestCommitted('V'))!.seq).toBe(3);
  return { alice, dave, v2 };
}

/** What a fold of V@2 that committed once looks like, whichever process committed it. */
async function expectFoldedOnce(kolab: Kolab, v2: string) {
  const h = await history(kolab, 'V');
  const committedFolds = h.filter((v) => v.folded === 2 && v.state === 'committed');
  expect(committedFolds).toHaveLength(1);
  const fold = committedFolds[0];
  expect(h.find((v) => v.seq === 2)).toMatchObject({ state: 'rejected', review_note: expect.stringMatching(/^folded into /) });
  expect(fold).toMatchObject({ active_role: 'product', review_note: expect.stringMatching(/^Approved by dave, then rebased by Kolab/) });
  // Nothing else was ever committed onto V: only V@1, Kolab's rebase V@3 and the fold.
  expect(h.filter((v) => v.state === 'committed').map((v) => v.seq)).toStrictEqual([1, 3, fold.seq]);
  expect(await textOf(kolab, 'V')).toStrictEqual({ E1: 'Parent one, revised.', E2: 'V says two its way.', A: 'Alice adds A.' });
  // The verdict stands, on the version Dave approved and on the fold that carries it.
  expect(await verdicts(kolab, v2)).toStrictEqual([{ reviewer_id: 'dave', state: 'approved' }]);
  const foldId = (await kolab.latestCommitted('V'))!.id;
  expect(await verdicts(kolab, foldId)).toStrictEqual([{ reviewer_id: 'dave', state: 'approved' }]);
  expect((await kolab.submissions('alice')).find((s) => s.subject === 'kj:V@2')).toMatchObject({ state: 'rejected', folded_into: `kj:V@${fold.seq}` });
  expect(await kolab.reviewRequests()).toStrictEqual([]);
  expect(await jobs(kolab)).toStrictEqual([]);
}

test('an approval recorded before its process stops is folded and committed once, by the next process to open the database', async () => {
  const store = await persistentStore();
  // The process stops after Dave's approval committed and its fold was written, before the fold commits.
  const a = await stoppingAt(store, (ctx) => !!ctx.version.folded_from);
  const { dave, v2 } = await overtakenInReview(a.kolab);
  void a.kolab.recordReview(dave, v2, { verdict: 'approve' }).catch(() => undefined);
  await a.stopped;
  // The verdict is a row, and so is the work it still owes.
  expect(await verdicts(a.kolab, v2)).toStrictEqual([{ reviewer_id: 'dave', state: 'approved' }]);
  expect(await jobs(a.kolab)).toMatchObject([{ kind: 'settle_approval', version_id: v2 }]);
  await die(a.kolab);

  const b = await restart(store);
  expect((await b.version(v2)).state).toBe('in_review');
  expect(await b.drainOutbox()).toBe(1);
  await expectFoldedOnce(b, v2);
  // The fold the stopped process wrote, and never committed, was rejected, not committed too.
  expect((await history(b, 'V')).filter((v) => v.folded === 2 && v.state === 'rejected'))
    .toMatchObject([{ seq: 4, review_note: 'not committed: Kolab stopped while folding V@2, and folded it again' }]);
  // Run again, it finds nothing to do.
  expect(await b.drainOutbox()).toBe(0);
  await expectFoldedOnce(b, v2);
});

test('a commit whose cascade a stopped process cut short is finished once by the next: its variant rebased, its marks and layer leaks raised once', async () => {
  const store = await persistentStore();
  // The process stops in P@2's cascade, as Kolab's rebase of the variant V reaches its checks.
  const a = await stoppingAt(store, (ctx) => ctx.version.node_id === 'V' && ctx.version.active_role === 'system');
  const k = a.kolab;
  await people(k, ['alice', 'dave'], { layers: ['functional'] });
  await people(k, 'bob', { layers: ['technical'] });
  const alice = await k.openSession('alice', 'product');
  const dave = await k.openSession('dave', 'product');
  const bob = await k.openSession('bob', 'engineer');
  await k.createNode(alice, 'functional_spec', 'P', 'P');
  const p1 = await commitReviewed(k, alice, dave, 'P', { elements: els({ E1: 'Parent one.', E2: 'Parent two.' }) });
  await k.createNode(alice, 'functional_spec', 'V', 'V');
  await commitReviewed(k, alice, dave, 'V', { parent: p1, deltas: [{ kind: 'override', element: 'E2', text: 'V says two its way.' }] });
  // Bob's binding relies on E1, and his work package on the binding (a transitive mark's path).
  await k.createNode(bob, 'technical_binding', 'B', 'B');
  const b1 = await k.draft(bob, 'B', { elements: els({ b1: 'An endpoint for E1.' }) });
  await k.link(bob, { kind: 'dependency', source: b1, sourceElement: 'b1', target: p1, targetElement: 'E1' });
  expect((await k.review(b1)).ok).toBe(true);
  await k.createNode(bob, 'work_package', 'W', 'W');
  const w1 = await k.draft(bob, 'W', { elements: els({ w1: 'Build the endpoint.' }) });
  await k.link(bob, { kind: 'dependency', source: w1, sourceElement: 'w1', target: b1, targetElement: 'b1' });
  expect((await k.review(w1)).ok).toBe(true);

  const p2 = await k.draft(alice, 'P', { elements: els({ E1: 'Parent one, revised.', E2: 'Parent two.' }) });
  expect((await k.review(p2)).in_review).toBe(true);
  const leak = { kind: 'layer_leak' as const, elements: ['E1'], explanation: 'It names a table.' };
  void k.recordReview(dave, p2, { verdict: 'approve', findings: [leak] }).catch(() => undefined);
  await a.stopped;
  // P@2 committed with Dave's verdict, and its cascade is owed: B was marked before the stop, V wasn't rebased.
  expect((await k.version(p2)).state).toBe('committed');
  expect(await jobs(k)).toMatchObject([{ kind: 'after_commit', version_id: p2 }]);
  await die(k);

  const b = await restart(store);
  expect(await b.drainOutbox()).toBe(1);
  expect(await jobs(b)).toStrictEqual([]);
  // V rebased onto P@2 once. The rebase the stopped process drafted stays drafted, never committed.
  expect((await history(b, 'V')).map((v) => [v.seq, v.active_role, v.state])).toStrictEqual([
    [1, 'product', 'committed'], [2, 'system', 'drafted'], [3, 'system', 'committed'],
  ]);
  expect(await textOf(b, 'V')).toStrictEqual({ E1: 'Parent one, revised.', E2: 'V says two its way.' });
  // B's edge got one mark, and W one transitive mark from it.
  expect((await marksOn(b, 'B')).map((m) => m.reason)).toStrictEqual(['changed']);
  expect((await marksOn(b, 'W')).map((m) => m.reason)).toStrictEqual(['upstream_dirty']);
  // Dave's layer leak became one mark and one question, raised once.
  expect((await marksOn(b, 'P')).map((m) => [m.reason, m.element_id, m.note])).toStrictEqual([['role_boundary', 'E1', 'It names a table.']]);
  expect((await b.openQueries()).filter((q) => q.question.startsWith('The review gate thinks'))).toHaveLength(1);
  expect(await verdicts(b, p2)).toStrictEqual([{ reviewer_id: 'dave', state: 'approved' }]);

  // A second pass, or the node's next commit, raises nothing again.
  expect(await b.drainOutbox()).toBe(0);
  expect((await marksOn(b, 'B'))).toHaveLength(1);
  expect((await marksOn(b, 'P'))).toHaveLength(1);
});

test('a cascade that fails is freed with its error and retried by the worker until it finishes', async () => {
  const store = await persistentStore();
  const k = await openKolab({ ...store, outboxLeaseMs: LEASE_MS });
  await people(k, 'alice', { layers: ['functional'] });
  const alice = await k.openSession('alice', 'product');
  await k.createNode(alice, 'functional_spec', 'P', 'P');
  const p1 = await k.commit(alice, 'P', { elements: els({ E1: 'Parent one.' }) });
  await k.createNode(alice, 'functional_spec', 'V', 'V');
  await k.commit(alice, 'V', { parent: p1, deltas: [{ kind: 'add', element: 'A', text: 'V adds A.' }] });

  // The first read of P@2's catch-up of V fails, as a dropped connection would.
  const proto = Object.getPrototypeOf(k.db);
  const query = proto.query;
  let armed = true;
  proto.query = async function (sql: string, params?: unknown[]) {
    if (armed && sql.includes('c.node_id <> $1')) {
      armed = false;
      throw new Error('Connection terminated unexpectedly');
    }
    return query.call(this, sql, params);
  };
  let error: string;
  try { error = await rejection(k.commit(alice, 'P', { elements: els({ E1: 'Parent one, revised.' }) })); } finally { proto.query = query; }
  expect(error).toMatch(/^CascadeError: P@2 committed, but its cascade did not finish: Connection terminated unexpectedly/);
  const [job] = (await k.db.query<{ kind: string; attempts: number; claimed_by: string | null; last_error: string; due: boolean }>(
    `select kind, attempts, claimed_by, last_error, run_after > now() as due from outbox`)).rows;
  expect(job).toMatchObject({ kind: 'after_commit', attempts: 1, claimed_by: null, last_error: 'P@2 committed, but its cascade did not finish: Connection terminated unexpectedly', due: true });
  expect((await k.latestCommitted('V'))!.seq).toBe(1);

  // The worker waits out the backoff (1 s), then finishes it.
  k.startWorker({ pollMs: 50 });
  for (let i = 0; i < 100 && (await jobs(k)).length; i++) await new Promise((r) => setTimeout(r, 50));
  expect(await jobs(k)).toStrictEqual([]);
  expect(await textOf(k, 'V')).toStrictEqual({ E1: 'Parent one, revised.', A: 'V adds A.' });
});

test('a node\'s cascades run in commit order: its next commit first finishes the cascade a stopped process owed the version before it', async () => {
  const store = await persistentStore();
  const k = await openKolab({ ...store, outboxLeaseMs: LEASE_MS });
  await people(k, 'alice', { layers: ['functional'] });
  await people(k, 'bob', { layers: ['technical'] });
  const alice = await k.openSession('alice', 'product');
  const bob = await k.openSession('bob', 'engineer');
  await k.createNode(alice, 'functional_spec', 'S', 'S');
  const s1 = await k.commit(alice, 'S', { elements: els({ R1: 'Orders can be cancelled.' }) });
  await k.createNode(bob, 'technical_binding', 'B', 'B');
  const b1 = await k.draft(bob, 'B', { elements: els({ b1: 'A cancel endpoint.' }) });
  await k.link(bob, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1' });
  expect((await k.review(b1)).ok).toBe(true);

  // B@2 commits, and its process stops as its cascade starts to carry B@1's link forward.
  let reached!: () => void;
  const stopped = new Promise<void>((r) => { reached = r; });
  const query = k.db.query.bind(k.db);
  k.db.query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("seq < $2 and state = 'committed' order by seq desc limit 1") && params?.[0] === 'B') {
      reached();
      return new Promise(() => undefined);
    }
    return query(sql, params);
  }) as typeof k.db.query;
  void k.commit(bob, 'B', { deltas: [{ kind: 'add', element: 'b2', text: 'A refund endpoint.' }] }).catch(() => undefined);
  await stopped;
  await die(k);

  // The next process doesn't drain first: Bob commits B@3 at once. B@2's cascade runs before
  // B@3's, so the link reaches B@2 and then B@3, rather than B@3 carrying forward a B@2 without it.
  const b = await restart(store);
  await b.commit(bob, 'B', { deltas: [{ kind: 'add', element: 'b3', text: 'A status endpoint.' }] });
  expect(await jobs(b)).toStrictEqual([]);
  const b3 = (await b.latestCommitted('B'))!;
  expect(b3.seq).toBe(3);
  expect((await b.lineage(b3.id, 'upstream')).map((e) => [e.source, e.target])).toStrictEqual([['kj:B@3#b1', 'kj:S@1#R1']]);
  // So a change to R1 still reaches the binding.
  await b.commit(alice, 'S', { elements: els({ R1: 'Orders can be cancelled by office staff.' }) });
  expect((await marksOn(b, 'B')).map((m) => m.reason)).toStrictEqual(['changed']);
});

test('an answer and everything it causes commit together, or not at all', async () => {
  const store = await persistentStore();
  const k = await openKolab(store);
  await people(k, 'alice', { layers: ['functional'] });
  await people(k, 'bob', { layers: ['technical'] });
  const alice = await k.openSession('alice', 'product');
  const bob = await k.openSession('bob', 'engineer');
  await k.createNode(alice, 'functional_spec', 'S', 'S');
  await k.commit(alice, 'S', { elements: els({ R1: 'Orders can be cancelled.' }) });
  await k.createNode(bob, 'technical_binding', 'B', 'B');
  await k.commit(bob, 'B', { elements: els({ b1: 'A cancel endpoint.' }) });
  const q = await k.raiseQuery(bob, 'kj:S#R1', 'By whom?', { from: 'kj:B#b1' });

  // The asker's mark fails to write: the answer doesn't land without it.
  const proto = Object.getPrototypeOf(k.db);
  const query = proto.query;
  let armed = true;
  proto.query = async function (sql: string, params?: unknown[]) {
    if (armed && sql.startsWith('insert into invalidation') && params?.includes('query_answered')) {
      armed = false;
      throw new Error('Connection terminated unexpectedly');
    }
    return query.call(this, sql, params);
  };
  try {
    expect(await rejection(k.answerQuery(alice, q, 'Office staff.'))).toMatch(/Connection terminated unexpectedly/);
  } finally { proto.query = query; }
  expect((await k.listQueries({ raisedBy: 'bob' }))[0]).toMatchObject({ state: 'open', answer: null });
  expect(await marksOn(k, 'B')).toStrictEqual([]);

  await k.answerQuery(alice, q, 'Office staff.');
  expect((await k.listQueries({ raisedBy: 'bob' }))[0]).toMatchObject({ state: 'answered', answer: 'Office staff.' });
  expect((await marksOn(k, 'B')).map((m) => m.reason)).toStrictEqual(['query_answered']);
  expect(await rejection(k.answerQuery(alice, q, 'Again.'))).toMatch(/GateError: query .* is already answered/);
});

(onPostgres ? test : test.skip)('two processes draining the same outbox at once run each job once', async () => {
  const store = await persistentStore();
  const a = await stoppingAt(store, (ctx) => !!ctx.version.folded_from);
  const { dave, v2 } = await overtakenInReview(a.kolab);
  void a.kolab.recordReview(dave, v2, { verdict: 'approve' }).catch(() => undefined);
  await a.stopped;
  await die(a.kolab);

  const b = await restart(store);
  const c = await openKolab({ ...store, outboxLeaseMs: LEASE_MS });
  const done = await Promise.all([b.drainOutbox(), c.drainOutbox(), b.drainOutbox(), c.drainOutbox()]);
  expect(done.reduce((x, y) => x + y)).toBe(1);
  await expectFoldedOnce(b, v2);
});

(onPostgres ? test : test.skip)('a job freed by one process wakes another process\'s worker, over NOTIFY', async () => {
  const store = await persistentStore();
  const a = await openKolab({ ...store, outboxLeaseMs: LEASE_MS });
  const b = await openKolab({ ...store, outboxLeaseMs: LEASE_MS });
  await b.listen();
  // B's worker would otherwise look again only in a minute.
  b.startWorker({ pollMs: 60_000 });
  await new Promise((r) => setTimeout(r, 200));
  await people(a, 'alice', { layers: ['functional'] });
  const alice = await a.openSession('alice', 'product');
  await a.createNode(alice, 'functional_spec', 'P', 'P');
  const p1 = await a.commit(alice, 'P', { elements: els({ E1: 'Parent one.' }) });
  await a.createNode(alice, 'functional_spec', 'V', 'V');
  await a.commit(alice, 'V', { parent: p1, deltas: [{ kind: 'add', element: 'A', text: 'V adds A.' }] });

  const proto = Object.getPrototypeOf(a.db);
  const query = proto.query;
  let armed = true;
  proto.query = async function (this: unknown, sql: string, params?: unknown[]) {
    if (armed && this === a.db && sql.includes('c.node_id <> $1')) {
      armed = false;
      throw new Error('Connection terminated unexpectedly');
    }
    return query.call(this, sql, params);
  };
  try {
    expect(await rejection(a.commit(alice, 'P', { elements: els({ E1: 'Parent one, revised.' }) }))).toMatch(/^CascadeError/);
  } finally { proto.query = query; }
  // A runs no worker. B heard the job was freed, and runs it once its backoff is over.
  for (let i = 0; i < 100 && (await jobs(a)).length; i++) await new Promise((r) => setTimeout(r, 50));
  expect(await jobs(a)).toStrictEqual([]);
  expect(await textOf(a, 'V')).toStrictEqual({ E1: 'Parent one, revised.', A: 'V adds A.' });
});
