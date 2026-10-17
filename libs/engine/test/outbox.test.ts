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
  const kolab = await openKolab({ ...store, checks, outboxLeaseMs: LEASE_MS, closeWaitMs: 0 });
  return { kolab, stopped };
}

/** Stops `kolab` as a process that dies does: its connections close, and nothing it was doing finishes or cleans up. */
const die = (kolab: Kolab) => kolab.db.close();

/** Opens the database again in a new Kolab, once any claim the dead process held has lapsed. */
async function restart(store: Store) {
  // The dead process's claims lapse unrenewed. (A PGlite directory opened in a fresh process frees
  // them at once; here the dead Kolab is in this process still, so they lapse as on Postgres.)
  await new Promise((r) => setTimeout(r, LEASE_MS + 100));
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
  expect(await jobs(a.kolab)).toMatchObject([{ kind: 'settle', version_id: v2 }]);
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
  const k = await openKolab({ ...store, outboxLeaseMs: LEASE_MS, closeWaitMs: 0 });
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

/** A promise and the function that settles it, for holding a step until a test lets it go. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}

/** S@1 with R1, and Bob's binding B@1, whose b1 relies on R1; S@2 changes R1, so B@1 carries a changed mark. */
async function bindingWithMark(k: Kolab) {
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
  await k.commit(alice, 'S', { elements: els({ R1: 'Orders can be cancelled by staff.' }) });
  expect((await marksOn(k, 'B')).map((m) => [m.reason, m.version_id])).toStrictEqual([['changed', b1]]);
  return { alice, bob, b1 };
}

/** What a binding whose cascades all ran in order shows: its link and its mark on its latest version. */
async function expectCarriedToLatest(k: Kolab) {
  const latest = (await k.latestCommitted('B'))!;
  expect(latest.seq).toBe(3);
  expect((await k.lineage(latest.id, 'upstream')).map((e) => [e.source, e.target])).toStrictEqual([['kj:B@3#b1', 'kj:S@1#R1']]);
  expect((await marksOn(k, 'B')).map((m) => [m.reason, m.version_id])).toStrictEqual([['changed', latest.id]]);
  expect(await jobs(k)).toStrictEqual([]);
}

const supersedeRead = (sql: string, params?: unknown[]) =>
  sql.includes("seq < $2 and state = 'committed' order by seq desc limit 1") && params?.[0] === 'B';

test('a node\'s later commit waits for the cascade another run holds, and runs once that one is done, in commit order', async () => {
  const k = await openKolab({ ...(await persistentStore()), outboxLeaseMs: LEASE_MS });
  const { bob } = await bindingWithMark(k);
  // B@2's cascade is held up as it starts to carry B@1's link and mark forward.
  const held = gate();
  const reached = gate();
  const query = k.db.query.bind(k.db);
  let armed = true;
  k.db.query = (async (sql: string, params?: unknown[]) => {
    if (armed && supersedeRead(sql, params)) { armed = false; reached.open(); await held.opened; }
    return query(sql, params);
  }) as typeof k.db.query;
  const b2 = k.commit(bob, 'B', { deltas: [{ kind: 'add', element: 'b2', text: 'A refund endpoint.' }] });
  await reached.opened;
  // B@3 commits meanwhile; its cascade waits behind B@2's, which this process holds.
  await k.commit(bob, 'B', { deltas: [{ kind: 'add', element: 'b3', text: 'A status endpoint.' }] });
  expect((await jobs(k)).map((j) => [j.kind, !!j.claimed_by])).toStrictEqual([['after_commit', true], ['after_commit', false]]);
  expect(await k.drainOutbox()).toBe(0);   // nor does the worker run it out of turn
  // A lease's worth later the held cascade still holds its claim: it is renewed while it runs.
  await new Promise((r) => setTimeout(r, LEASE_MS * 2));
  expect(await k.drainOutbox()).toBe(0);
  held.open();
  await b2;
  // B@2's cascade, then B@3's: the link and the mark reach B@3.
  await expectCarriedToLatest(k);
});

test('a node\'s later commit waits for a cascade that failed, rather than run ahead of it, and both run in order once it is retried', async () => {
  const k = await openKolab({ ...(await persistentStore()), outboxLeaseMs: LEASE_MS });
  const { bob, b1 } = await bindingWithMark(k);
  const proto = Object.getPrototypeOf(k.db);
  const query = proto.query;
  let armed = true;
  proto.query = async function (sql: string, params?: unknown[]) {
    if (armed && supersedeRead(sql, params)) { armed = false; throw new Error('Connection terminated unexpectedly'); }
    return query.call(this, sql, params);
  };
  try {
    expect(await rejection(k.commit(bob, 'B', { deltas: [{ kind: 'add', element: 'b2', text: 'A refund endpoint.' }] })))
      .toMatch(/^CascadeError: B@2 committed, but its cascade did not finish/);
  } finally { proto.query = query; }
  // B@3 commits, and its cascade waits: B@2's is backing off, and runs first. The result says so.
  const b3 = await k.review(await k.draft(bob, 'B', { deltas: [{ kind: 'add', element: 'b3', text: 'A status endpoint.' }] }));
  expect(b3).toMatchObject({ ok: true, cascade: 'queued' });
  expect((await marksOn(k, 'B')).map((m) => m.version_id)).toStrictEqual([b1]);
  expect(await k.lineage((await k.latestCommitted('B'))!.id, 'upstream')).toStrictEqual([]);
  expect(await jobs(k)).toHaveLength(2);
  await new Promise((r) => setTimeout(r, 1100));
  await k.drainOutbox();
  await expectCarriedToLatest(k);
});

test('a run that lost its claim to another touches nothing of the job, which the other run finishes once', async () => {
  const store = await persistentStore();
  const first = gate(); const firstReached = gate();
  const second = gate(); const secondReached = gate();
  let calls = 0;
  const checks: Checks = async (ctx) => {
    if (ctx.version.node_id !== 'V' || ctx.version.active_role !== 'system') return structuralChecks(ctx);
    calls++;
    if (calls === 1) { firstReached.open(); await first.opened; }
    else if (calls === 2) { secondReached.open(); await second.opened; }
    return structuralChecks(ctx);
  };
  const k = await openKolab({ ...store, checks, outboxLeaseMs: LEASE_MS });
  await people(k, 'alice', { layers: ['functional'] });
  const alice = await k.openSession('alice', 'product');
  await k.createNode(alice, 'functional_spec', 'P', 'P');
  const p1 = await k.commit(alice, 'P', { elements: els({ E1: 'Parent one.' }) });
  await k.createNode(alice, 'functional_spec', 'V', 'V');
  await k.commit(alice, 'V', { parent: p1, deltas: [{ kind: 'add', element: 'A', text: 'V adds A.' }] });

  const p2 = k.commit(alice, 'P', { elements: els({ E1: 'Parent one, revised.' }) });
  await firstReached.opened;
  const claimOf = async () => (await k.db.query<{ claim: string | null; attempts: number }>(`select claim, attempts from outbox where kind = 'after_commit'`)).rows;
  const [{ claim: token1 }] = await claimOf();
  // Its renewals fail, as on a saturated pool, so its lease lapses; the worker takes the job.
  const query = k.db.query.bind(k.db);
  k.db.query = (async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('update outbox set claimed_until') && params?.[0] === token1) throw new Error('timeout exceeded when trying to connect');
    return query(sql, params);
  }) as typeof k.db.query;
  await new Promise((r) => setTimeout(r, LEASE_MS * 2));
  const drained = k.drainOutbox();
  await secondReached.opened;
  const [{ claim: token2, attempts }] = await claimOf();
  expect(token2).not.toBe(token1);
  expect(attempts).toBe(2);

  // The first run goes on, finds its claim lost and stops; the job is the second run's still.
  first.open();
  const p2id = await p2;
  expect(await claimOf()).toStrictEqual([{ claim: token2, attempts: 2 }]);
  // Nor can a stale token free or fail it.
  await (k as unknown as { fail(j: object, e: unknown): Promise<void> }).fail({ token: token1, kind: 'after_commit', versionId: p2id }, new Error('late'));
  expect(await claimOf()).toStrictEqual([{ claim: token2, attempts: 2 }]);

  second.open();
  expect(await drained).toBe(1);
  expect(await jobs(k)).toStrictEqual([]);
  // V was rebased onto P@2 once.
  const committed = (await history(k, 'V')).filter((v) => v.state === 'committed').map((v) => v.active_role);
  expect(committed).toStrictEqual(['product', 'system']);
  expect(await textOf(k, 'V')).toStrictEqual({ E1: 'Parent one, revised.', A: 'V adds A.' });
});

test('a job that keeps failing is dead after ten attempts: no worker runs it until an admin retries it', async () => {
  const k = await openKolab({ ...(await persistentStore()), outboxLeaseMs: LEASE_MS });
  const { bob } = await bindingWithMark(k);
  const proto = Object.getPrototypeOf(k.db);
  const query = proto.query;
  let failing = true;
  proto.query = async function (sql: string, params?: unknown[]) {
    if (failing && supersedeRead(sql, params)) throw new Error('Connection terminated unexpectedly');
    return query.call(this, sql, params);
  };
  try {
    expect(await rejection(k.commit(bob, 'B', { deltas: [{ kind: 'add', element: 'b2', text: 'A refund endpoint.' }] }))).toMatch(/^CascadeError/);
    // Nine attempts on, its backoff over, it fails a tenth time.
    await k.db.query(`update outbox set attempts = 9, run_after = clock_timestamp()`);
    expect(await k.drainOutbox()).toBe(0);
  } finally { proto.query = query; }
  const [dead] = await k.outboxJobs({ state: 'dead' });
  expect(dead).toMatchObject({ kind: 'after_commit', state: 'dead', subject: 'kj:test/B@2', attempts: 10, last_error: expect.stringMatching(/Connection terminated unexpectedly/) });
  await k.db.query(`update outbox set run_after = clock_timestamp()`);
  expect(await k.drainOutbox()).toBe(0);
  failing = false;
  expect(await k.retryOutboxJob(dead.id)).toBe(true);
  expect(await k.drainOutbox()).toBe(1);
  expect(await k.outboxJobs()).toStrictEqual([]);
  expect((await marksOn(k, 'B')).map((m) => m.version_id)).toStrictEqual([(await k.latestCommitted('B'))!.id]);
});

test('a ruling applied through the admin token, overtaken by Kolab\'s rebase as it commits, is applied once by the next process if its own stops mid-fold (D47)', async () => {
  const store = await persistentStore();
  let k!: Kolab;
  let alice!: string;
  let stopped!: () => void;
  const reached = new Promise<void>((r) => { stopped = r; });
  const checks: Checks = async (ctx) => {
    if (ctx.version.node_id === 'V' && ctx.version.active_role === 'product') {
      if (ctx.version.folded_from) { stopped(); return new Promise(() => undefined); }
      // As the ruling's version is checked, Alice commits P@2, and Kolab rebases V past it.
      await k.commit(alice, 'P', { elements: els({ E1: 'Parent one, revised.' }) });
    }
    return structuralChecks(ctx);
  };
  k = await openKolab({ ...store, checks, outboxLeaseMs: LEASE_MS, closeWaitMs: 0 });
  await people(k, 'alice', { layers: ['functional'] });
  alice = await k.openSession('alice', 'product');
  await k.createNode(alice, 'functional_spec', 'P', 'P');
  const p1 = await k.commit(alice, 'P', { elements: els({ E1: 'Parent one.' }) });
  await k.createNode(alice, 'functional_spec', 'V', 'V');
  await k.commit(alice, 'V', { parent: p1, deltas: [{ kind: 'add', element: 'A', text: 'V adds A.' }] });
  void k.applyRuling('V', { deltas: [{ kind: 'add', element: 'D', text: 'Ruled: V adds D.' }] }, { id: 'D99', actor: 'alice' }).catch(() => undefined);
  await reached;
  expect((await jobs(k)).map((j) => j.kind)).toStrictEqual(['settle']);
  await die(k);

  const b = await restart(store);
  expect(await b.drainOutbox()).toBe(1);
  expect(await jobs(b)).toStrictEqual([]);
  expect(await textOf(b, 'V')).toStrictEqual({ E1: 'Parent one, revised.', A: 'V adds A.', D: 'Ruled: V adds D.' });
  const h = await history(b, 'V');
  expect(h.filter((v) => v.state === 'committed' && v.active_role === 'product' && v.folded !== null)).toMatchObject([
    { review_note: expect.stringMatching(/^Applied as ruling D99 through the admin token/) },
  ]);
  expect(h.filter((v) => v.state === 'drafted')).toStrictEqual([]);
});

test('closing waits for the outbox work this process is running, then frees nothing it finished', async () => {
  const store = await persistentStore();
  const held = gate(); const reached = gate();
  const checks: Checks = async (ctx) => {
    if (ctx.version.node_id === 'V' && ctx.version.active_role === 'system') { reached.open(); await held.opened; }
    return structuralChecks(ctx);
  };
  const k = await openKolab({ ...store, checks, outboxLeaseMs: LEASE_MS, closeWaitMs: 5_000 });
  await people(k, 'alice', { layers: ['functional'] });
  const alice = await k.openSession('alice', 'product');
  await k.createNode(alice, 'functional_spec', 'P', 'P');
  const p1 = await k.commit(alice, 'P', { elements: els({ E1: 'Parent one.' }) });
  await k.createNode(alice, 'functional_spec', 'V', 'V');
  await k.commit(alice, 'V', { parent: p1, deltas: [{ kind: 'add', element: 'A', text: 'V adds A.' }] });
  const p2 = k.commit(alice, 'P', { elements: els({ E1: 'Parent one, revised.' }) });
  await reached.opened;
  const closing = k.close();
  setTimeout(() => held.open(), 200);
  await closing;
  await p2;
  const b = await openKolab(store);
  expect(await jobs(b)).toStrictEqual([]);
  expect(await textOf(b, 'V')).toStrictEqual({ E1: 'Parent one, revised.', A: 'V adds A.' });
});

/** Makes the first query matching `when` fail as a dropped connection would; returns a function that restores it. */
function failOnce(k: Kolab, when: (sql: string, params?: unknown[]) => boolean) {
  const proto = Object.getPrototypeOf(k.db);
  const query = proto.query;
  let armed = true;
  proto.query = async function (sql: string, params?: unknown[]) {
    if (armed && when(sql, params)) { armed = false; throw new Error('Connection terminated unexpectedly'); }
    return query.call(this, sql, params);
  };
  return () => { proto.query = query; };
}

test('a cascade retried late leaves alone an edge a newer version\'s catch-up has already re-pinned', async () => {
  const k = await openKolab({ ...(await persistentStore()), outboxLeaseMs: LEASE_MS });
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
  // S@2 changes R1, and its cascade fails before it reaches B.
  const restore = failOnce(k, (sql, params) => sql.includes('t.seq < $2::int') && params?.[0] === 'S');
  try {
    expect(await rejection(k.commit(alice, 'S', { elements: els({ R1: 'Orders can be cancelled by staff.' }) }))).toMatch(/^CascadeError: S@2/);
  } finally { restore(); }
  // S@3 puts R1 back; its cascade waits behind S@2's.
  expect(await k.review(await k.draft(alice, 'S', { elements: els({ R1: 'Orders can be cancelled.' }) }))).toMatchObject({ ok: true, cascade: 'queued' });
  // Bob commits B@2, whose catch-up finds R1 as it linked it, and re-pins the link to S@3.
  await k.commit(bob, 'B', { deltas: [{ kind: 'add', element: 'b2', text: 'A refund endpoint.' }] });
  const b2 = (await k.latestCommitted('B'))!.id;
  expect((await k.lineage(b2, 'upstream')).map((e) => e.target)).toStrictEqual(['kj:S@3#R1']);
  // S@2's cascade, retried, then S@3's, leave it so: no mark for a change that was undone.
  await new Promise((r) => setTimeout(r, 1100));
  await k.drainOutbox();
  expect(await jobs(k)).toStrictEqual([]);
  expect(await marksOn(k, 'B')).toStrictEqual([]);
  expect((await k.lineage(b2, 'upstream')).map((e) => e.target)).toStrictEqual(['kj:S@3#R1']);
});

test('a settle job run again finds the fold it already made in review, and folds nothing twice', async () => {
  const k = await openKolab({ ...(await persistentStore()), outboxLeaseMs: LEASE_MS });
  await people(k, ['alice', 'dave'], { layers: ['functional'] });
  const alice = await k.openSession('alice', 'product');
  const dave = await k.openSession('dave', 'product');
  await k.createNode(alice, 'functional_spec', 'P', 'P');
  const p1 = await commitReviewed(k, alice, dave, 'P', { elements: els({ E1: 'Parent one.', E2: 'Parent two.' }) });
  await k.createNode(alice, 'functional_spec', 'V', 'V');
  await commitReviewed(k, alice, dave, 'V', { parent: p1, deltas: [{ kind: 'override', element: 'E2', text: 'V says two its way.' }] });
  const v2 = await k.draft(alice, 'V', { deltas: [{ kind: 'add', element: 'A', text: 'Alice adds A.' }] });
  await commitReviewed(k, alice, dave, 'P', { elements: els({ E1: 'Parent one, revised.', E2: 'Parent two.' }) });
  // Submitting V@2 folds it, and the fold goes into review; settling V@2 as folded into it fails once.
  const restore = failOnce(k, (sql, params) => sql.startsWith(`update version set state = 'rejected'`) && params?.[0] === v2 && String(params?.[1]).startsWith('folded into'));
  try {
    expect(await rejection(k.review(v2))).toMatch(/Connection terminated unexpectedly/);
  } finally { restore(); }
  expect((await jobs(k)).map((j) => j.kind)).toStrictEqual(['settle']);
  await new Promise((r) => setTimeout(r, 1100));
  expect(await k.drainOutbox()).toBe(1);
  const h = await history(k, 'V');
  const folds = h.filter((v) => v.folded === 2);
  expect(folds.map((v) => v.state)).toStrictEqual(['in_review']);
  expect(h.find((v) => v.seq === 2)).toMatchObject({ state: 'rejected', review_note: expect.stringMatching(/^folded into /) });
  expect((await k.reviewRequests({ reviewer: 'dave' })).map((r) => r.subject)).toStrictEqual([`kj:V@${folds[0].seq}`]);
  expect(await jobs(k)).toStrictEqual([]);
});
