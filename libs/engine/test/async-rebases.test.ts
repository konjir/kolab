// Durable asynchronous rebasing (P6; D43, D44, CAS7, CAS8): a parent's commit queues its
// variants' rebases and returns, and the outbox worker runs them. These tests leave the queue
// alone (`queued: true`) and run it by hand, or with a live worker, at the point each needs.
import { expect, test } from '@jest/globals';
import { Kolab, OUTBOX_MAX_ATTEMPTS, structuralChecks } from '@konjir/engine';
import { drainAfterWrites, els, marksOn, openKolab, people, persistentStore, rejection, testStore, textOf, type Store } from '@konjir/engine/testing';
import type { CheckContext, Checks, CheckResult } from '@konjir/types';

const onPostgres = !!process.env.KONJIR_TEST_DATABASE_URL;

/** Checks that run `hook` first, for Kolab's own rebases and folds; people's versions pass on structure. */
function hooked() {
  let hook: ((ctx: CheckContext) => Promise<CheckResult | undefined>) | undefined;
  const checks: Checks = async (ctx) => (await hook?.(ctx)) ?? structuralChecks(ctx);
  return { checks, set: (h: typeof hook) => { hook = h; } };
}

/** P@1, and V a variant of it overriding E2, in a Kolab whose rebases stay queued. */
async function family(opts: { store?: Store; checks?: Checks; reviewers?: boolean } = {}) {
  const k = await openKolab({ ...(opts.store ?? await testStore()), checks: opts.checks, queued: true });
  await people(k, opts.reviewers ? ['alice', 'dave'] : 'alice', { layers: ['functional'] });
  const alice = await k.openSession('alice', 'product');
  const dave = opts.reviewers ? await k.openSession('dave', 'product') : undefined;
  const commit = async (node: string, input: Parameters<Kolab['draft']>[2]) => {
    const r = await k.review(await k.draft(alice, node, input));
    const done = r.in_review ? await k.recordReview(dave!, r.version, { verdict: 'approve' }) : r;
    if (!done.ok) throw new Error(`expected ${node} to commit: ${done.note ?? ''}`);
    return done;
  };
  await k.createNode(alice, 'spec', 'P', 'P');
  const p1 = (await commit('P', { elements: els({ E1: 'Parent one.', E2: 'Parent two.' }) })).version;
  await k.createNode(alice, 'prototype', 'V', 'V');
  await commit('V', { parent: p1, deltas: [{ kind: 'override', element: 'E2', text: 'V says two its way.' }] });
  return { k, alice, dave, commit };
}

const parentRev = (n: number) => ({ elements: els({ E1: `Parent one, rev ${n}.`, E2: 'Parent two.' }) });

/** Where V's live version sits, and the open rebase_failed marks on it, with the parent version each is against. */
async function where(k: Kolab) {
  const live = (await k.latestCommitted('V'))!;
  const on = (await k.version(live.parent_version_id!)).seq;
  const failed = await Promise.all((await marksOn(k, 'V')).filter((m) => m.reason === 'rebase_failed')
    .map(async (m) => (await k.version(m.triggered_by)).seq));
  return { on, failed };
}

const rebaseJobs = async (k: Kolab) =>
  (await k.db.query<{ state: string; attempts: number; again: boolean }>(
    `select state, attempts, coalesce((payload->>'again')::boolean, false) as again from outbox where kind = 'rebase' order by id`)).rows;

// ---- a parent commit while the job runs (the review's High) --------------------------------------

test('a parent commit that lands while a variant\'s rebase job runs, and that rebase then fails, still reaches the variant', async () => {
  const h = hooked();
  const { k, commit } = await family({ checks: h.checks });
  const p2 = (await commit('P', parentRev(2))).version;
  expect((await k.pendingRebase('V'))?.after).toBe('kj:test/P@2');
  // The job reads P@2 and starts the rebase; P@3 commits while its checks run, and they refuse it.
  let p3: string | undefined;
  h.set(async (ctx) => {
    if (ctx.version.node_id !== 'V' || ctx.version.parent_version_id !== p2) return undefined;
    h.set(undefined);
    p3 = (await commit('P', parentRev(3))).version;
    expect(await rebaseJobs(k)).toMatchObject([{ state: 'pending', again: true }]);   // told to run again, not queued twice
    return { ok: false, note: 'refused once' };
  });
  await k.drainOutbox();
  expect(p3).toBeDefined();
  // The job ran again, onto P@3, and that rebase passed: V is on P@3, and the failure against P@2 settled.
  expect(await where(k)).toStrictEqual({ on: 3, failed: [] });
  expect(await rebaseJobs(k)).toStrictEqual([]);
  expect(await textOf(k, 'V')).toStrictEqual({ E1: 'Parent one, rev 3.', E2: 'V says two its way.' });
});

test('if the rebase onto the parent commit that landed during the job fails too, the variant is marked against that commit, never left on the older one', async () => {
  const h = hooked();
  const { k, commit } = await family({ checks: h.checks });
  const p2 = (await commit('P', parentRev(2))).version;
  h.set(async (ctx) => {
    if (ctx.version.node_id !== 'V' || ctx.version.active_role !== 'system') return undefined;
    if (ctx.version.parent_version_id === p2) await commit('P', parentRev(3));
    return { ok: false, note: 'refused' };
  });
  await k.drainOutbox();
  expect(await where(k)).toStrictEqual({ on: 1, failed: [3] });
  expect(await rebaseJobs(k)).toStrictEqual([]);
  expect((await k.openQueries()).filter((q) => q.question.startsWith('Rebasing onto the new parent failed'))).toHaveLength(1);
});

test('a parent commit that lands while a stalled run\'s lease has lapsed, unclaimed by anyone else, still reaches the variant when that run fails', async () => {
  const h = hooked();
  const { k, commit } = await family({ checks: h.checks });
  const p2 = (await commit('P', parentRev(2))).version;
  h.set(async (ctx) => {
    if (ctx.version.node_id !== 'V' || ctx.version.active_role !== 'system') return undefined;
    if (ctx.version.parent_version_id === p2) {
      // The worker stalls past its lease, and no one takes the job; P@3 commits meanwhile.
      await k.db.query(`update outbox set claimed_until = clock_timestamp() - interval '1 second' where kind = 'rebase'`);
      await commit('P', parentRev(3));
      expect(await rebaseJobs(k)).toMatchObject([{ again: true }]);
    }
    return { ok: false, note: 'refused' };
  });
  await k.drainOutbox();
  // The stalled run's failure didn't delete the job: it ran again, onto P@3, and failed there too.
  expect(await where(k)).toStrictEqual({ on: 1, failed: [3] });
  expect(await rebaseJobs(k)).toStrictEqual([]);
});

// ---- a job that dies -------------------------------------------------------------------------------

test('a rebase job that dies marks its variant rebase_failed, says so in status, and the parent\'s next commit revives it', async () => {
  const { k, alice, commit } = await family();
  await commit('P', parentRev(2));
  // The job has failed all but its last attempt; the next fails too, as a lost connection would.
  await k.db.query(`update outbox set attempts = $1 where kind = 'rebase'`, [OUTBOX_MAX_ATTEMPTS - 1]);
  const proto = Object.getPrototypeOf(k.db);
  const query = proto.query;
  let failing = true;
  proto.query = async function (sql: string, params?: unknown[]) {
    if (failing && sql.includes('coalesce(max(seq)') && params?.[0] === 'V') throw new Error('Connection terminated unexpectedly');
    return query.call(this, sql, params);
  };
  try { await k.drainOutbox(); } finally { failing = false; proto.query = query; }

  expect(await rebaseJobs(k)).toMatchObject([{ state: 'dead' }]);
  expect(await where(k)).toStrictEqual({ on: 1, failed: [2] });
  expect(await k.pendingRebase('V')).toMatchObject({ state: 'dead', attempts: OUTBOX_MAX_ATTEMPTS, last_error: expect.stringMatching(/Connection terminated/) });
  expect((await k.readNode(alice, 'V')).rebase).toMatchObject({ state: 'dead' });
  expect((await k.listNodes(undefined, 'test')).find((n) => n.name === 'V')).toMatchObject({ rebase_pending: false, rebase_dead: true });

  // P@3 commits: the dead job for V's live version is revived, not left to block it.
  expect((await commit('P', parentRev(3))).rebases).toBe(1);
  expect(await rebaseJobs(k)).toMatchObject([{ state: 'pending', attempts: 0 }]);
  await k.drainOutbox();
  expect(await where(k)).toStrictEqual({ on: 3, failed: [] });
  expect(await k.pendingRebase('V')).toBeUndefined();
});

// ---- status ----------------------------------------------------------------------------------------

test('a person\'s commit to a variant whose rebase is queued catches it up at once, and the job and its status go', async () => {
  const { k, alice, commit } = await family();
  await commit('P', parentRev(2));
  expect((await k.listNodes(undefined, 'test')).find((n) => n.name === 'V')).toMatchObject({ rebase_pending: true });
  await commit('V', { deltas: [{ kind: 'add', element: 'A', text: 'Alice adds A.' }] });
  expect(await rebaseJobs(k)).toStrictEqual([]);
  expect(await k.pendingRebase('V')).toBeUndefined();
  expect((await k.readNode(alice, 'V')).rebase).toBeUndefined();
  expect((await k.listNodes(undefined, 'test')).find((n) => n.name === 'V')).toMatchObject({ rebase_pending: false, rebase_dead: false });
  expect(await textOf(k, 'V')).toStrictEqual({ E1: 'Parent one, rev 2.', E2: 'V says two its way.', A: 'Alice adds A.' });
});

// ---- review (W1.6) with a rebase queued ----------------------------------------------------------

test('a variant\'s version in review when the worker rebases the variant is folded onto that rebase at approval (W1.6, CAS7)', async () => {
  const { k, alice, dave, commit } = await family({ reviewers: true });
  const v2 = await k.draft(alice, 'V', { deltas: [{ kind: 'add', element: 'A', text: 'Alice adds A.' }] });
  expect(await k.review(v2)).toMatchObject({ in_review: true });
  expect((await commit('P', parentRev(2))).rebases).toBe(1);
  // The worker's rebase commits on structural checks, without review, past the version in review.
  await k.drainOutbox();
  expect((await k.latestCommitted('V'))!.active_role).toBe('system');
  expect((await k.version(v2)).state).toBe('in_review');
  const r = await k.recordReview(dave!, v2, { verdict: 'approve' });
  expect(r.ok).toBe(true);
  expect(r.version).not.toBe(v2);
  expect((await k.version(v2)).state).toBe('rejected');
  expect(await textOf(k, 'V')).toStrictEqual({ E1: 'Parent one, rev 2.', E2: 'V says two its way.', A: 'Alice adds A.' });
  expect(await where(k)).toStrictEqual({ on: 2, failed: [] });
});

test('an approval that lands before the worker reaches a variant\'s queued rebase commits, and its own catch-up rebases it', async () => {
  const { k, alice, dave, commit } = await family({ reviewers: true });
  const v2 = await k.draft(alice, 'V', { deltas: [{ kind: 'add', element: 'A', text: 'Alice adds A.' }] });
  await k.review(v2);
  await commit('P', parentRev(2));
  const r = await k.recordReview(dave!, v2, { verdict: 'approve' });
  expect([r.ok, r.version]).toStrictEqual([true, v2]);
  // The approved version committed on P@1; its catch-up rebased V onto P@2, and the queued job went.
  expect(await rebaseJobs(k)).toStrictEqual([]);
  expect(await k.drainOutbox()).toBe(0);
  expect(await where(k)).toStrictEqual({ on: 2, failed: [] });
  expect(await textOf(k, 'V')).toStrictEqual({ E1: 'Parent one, rev 2.', E2: 'V says two its way.', A: 'Alice adds A.' });
});

// ---- the test helper -------------------------------------------------------------------------------

test('a write that fails throws its own error, even when the drain after it fails too (openKolab)', async () => {
  const k = await openKolab({ queued: true });
  drainAfterWrites(k);
  await people(k, 'alice', { layers: ['functional'] });
  const alice = await k.openSession('alice', 'product');
  k.drainOutbox = async () => { throw new Error('the drain failed'); };
  expect(await rejection(k.commit(alice, 'nowhere', { elements: els({ E1: 'x' }) }))).not.toMatch(/the drain failed/);
});

// ---- two processes -----------------------------------------------------------------------------------

(onPostgres ? test : test.skip)('one process commits while another\'s worker rebases: no edit is lost and every variant ends on its parent', async () => {
  const store = await persistentStore();
  const worker = await openKolab({ ...store, queued: true });
  const writer = await openKolab({ ...store, queued: true });
  await people(writer, 'alice', { layers: ['functional'] });
  const alice = await writer.openSession('alice', 'product');
  await writer.createNode(alice, 'spec', 'P', 'P');
  const p1 = await writer.commit(alice, 'P', parentRev(1));
  const ids = ['V0', 'V1', 'V2', 'V3'];
  for (const id of ids) {
    await writer.createNode(alice, 'prototype', id, id);
    const v = await writer.commit(alice, id, { parent: p1, deltas: [{ kind: 'override', element: 'E2', text: `${id} says two its way.` }] });
    await writer.createNode(alice, 'prototype', `${id}.0`, `${id}.0`);
    await writer.commit(alice, `${id}.0`, { parent: v, deltas: [{ kind: 'add', element: 'C', text: `${id}.0 adds C.` }] });
  }
  await worker.listen();
  worker.startWorker({ pollMs: 100 });
  // Parent commits and edits to the variants, as fast as they go, while the worker rebases.
  for (let n = 2; n <= 5; n++) {
    await writer.commit(alice, 'P', parentRev(n));
    await writer.commit(alice, ids[n % ids.length], { deltas: [{ kind: 'add', element: `H${n}`, text: `Human edit ${n}.` }] });
  }
  for (let i = 0; i < 400 && (await writer.db.query(`select 1 from outbox`)).rows.length; i++) await new Promise((r) => setTimeout(r, 50));
  expect((await writer.db.query(`select kind, state, last_error from outbox`)).rows).toStrictEqual([]);
  for (const id of ids.flatMap((x) => [x, `${x}.0`])) {
    const live = (await writer.latestCommitted(id))!;
    const parent = (await writer.version(live.parent_version_id!)).node_id;
    expect([id, live.parent_version_id]).toStrictEqual([id, (await writer.latestCommitted(parent))!.id]);
  }
  for (let n = 2; n <= 5; n++) {
    const id = ids[n % ids.length];
    expect((await textOf(writer, id))[`H${n}`]).toBe(`Human edit ${n}.`);
    expect((await textOf(writer, `${id}.0`))[`H${n}`]).toBe(`Human edit ${n}.`);
  }
  expect((await writer.openMarks()).filter((m) => m.reason === 'rebase_failed')).toStrictEqual([]);
}, 60_000);

// ---- archived kolabs (D52) -------------------------------------------------------------------------

test('a queued rebase in a kolab archived before the worker reaches it waits, unclaimed, and runs once the kolab is unarchived', async () => {
  const { k, commit } = await family();
  expect((await commit('P', parentRev(2))).rebases).toBe(1);
  await k.archive({ kolab: 'test' });
  expect(await k.drainOutbox()).toBe(0);
  expect(await rebaseJobs(k)).toMatchObject([{ state: 'pending', attempts: 0 }]);
  expect(await where(k)).toStrictEqual({ on: 1, failed: [] });
  await k.unarchive({ kolab: 'test' });
  expect(await k.drainOutbox()).toBe(1);
  expect(await where(k)).toStrictEqual({ on: 2, failed: [] });
});
