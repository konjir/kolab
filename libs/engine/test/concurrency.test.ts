// The commit races W2.7 found (libs/engine/scripts/REBASE-STORMS.md), closed by W1.17's commit
// step, serialized per node (CAS7, DAT3). Each injects one concurrent write at an exact point,
// through a checks hook or a wrapper on db.query, so it runs the same way on PGlite and on
// Postgres. `npm run rebase-storm -- --races` prints the same races as RACE or SAFE.
import { expect, test } from '@jest/globals';
import { GateError, Kolab, sessionKey, structuralChecks } from '@konjir/engine';
import { approved, commitReviewed, els, marksOn, people, rejection, setup, textOf } from '@konjir/engine/testing';
import type { CheckContext, Checks } from '@konjir/types';

type Hook = (ctx: CheckContext) => Promise<void>;

/**
 * A Kolab whose gates run `hook` first, set and cleared by the test: the checks of people's
 * versions, and the structural checks of Kolab's own rebases (W1.6, VER12).
 */
async function hooked(opts: { submissionChecks?: Checks; checks?: Checks } = {}) {
  let hook: Hook | undefined;
  const { submissionChecks = structuralChecks, checks = structuralChecks } = opts;
  const ctx = await setup(async (c) => { await hook?.(c); return submissionChecks(c); }, async (c) => { await hook?.(c); return checks(c); });
  return { ...ctx, setHook: (h: Hook | undefined) => { hook = h; } };
}

/** P@1 with three elements, and `roots` variants V0, V1, …, each with `children` variants under it (V0.0, …). */
async function family(kolab: Kolab, s: string, roots: number, children = 0) {
  await kolab.createNode(s, 'functional_spec', 'P', 'P');
  const p1 = await kolab.commit(s, 'P', { elements: els({ E0: 'Parent element 0, rev 1.', E1: 'Parent element 1.', E2: 'Parent element 2.' }) });
  const ids: string[] = [];
  const add = async (id: string, parent: string) => {
    ids.push(id);
    await kolab.createNode(s, 'functional_spec', id, id);
    return kolab.commit(s, id, { parent, deltas: [{ kind: 'override', element: 'E2', text: `${id} says E2 its own way.` }] });
  };
  for (let r = 0; r < roots; r++) {
    const v = await add(`V${r}`, p1);
    for (let c = 0; c < children; c++) await add(`V${r}.${c}`, v);
  }
  const next = els({ E0: 'Parent element 0, rev 2.', E1: 'Parent element 1.', E2: 'Parent element 2.' });
  return { ids, next };
}

const add = (element: string, text: string) => ({ deltas: [{ kind: 'add' as const, element, text }] });

/** Variants whose live version doesn't sit on their parent node's live version. */
async function stranded(kolab: Kolab, ids: string[]) {
  const out = [];
  for (const id of ids) {
    const v = (await kolab.latestCommitted(id))!;
    const parentNode = (await kolab.version(v.parent_version_id!)).node_id;
    if ((await kolab.latestCommitted(parentNode))!.id !== v.parent_version_id) out.push(id);
  }
  return out;
}

/** Every version of a node: seq, role, state, and what it was built on, in seq order. */
async function history(kolab: Kolab, node: string) {
  return (await kolab.db.query<{ seq: number; active_role: string; state: string; base: number | null }>(
    `select v.seq, v.active_role, v.state, b.seq as base from version v left join version b on b.id = v.base_version_id
      where v.node_id = $1 order by v.seq`, [node])).rows;
}

/** What review recorded on a version. */
const noteOf = async (kolab: Kolab, id: string) =>
  (await kolab.db.query<{ review_note: string | null }>(`select review_note from version where id = $1`, [id])).rows[0].review_note;

// ---- two commits to one node --------------------------------------------------

test('two commits to one node built on the same version: the second is rejected as stale with a GateError', async () => {
  const { kolab, product } = await setup();
  const { ids } = await family(kolab, product, 1);
  await people(kolab, 'dave', { layers: ['functional'] });
  const dave = await kolab.openSession('dave', 'product');   // from here on, each reviews the other's versions
  // Both drafted on V0@1, at once: each takes a number of its own.
  const [alice, mine] = await Promise.all([
    kolab.draft(product, 'V0', add('A', 'Alice adds A.')),
    kolab.draft(dave, 'V0', add('B', 'Dave adds B.')),
  ]);
  expect((await history(kolab, 'V0')).map((v) => [v.seq, v.state, v.base])).toStrictEqual([
    [1, 'committed', null], [2, 'drafted', 1], [3, 'drafted', 1],
  ]);

  expect((await approved(kolab, product, await kolab.review(mine))).ok).toBe(true);
  const r = await kolab.review(alice);
  expect([r.ok, r.stale, r.note]).toStrictEqual([false, true, 'stale draft: the node committed a newer version; redraft against it']);
  expect(await textOf(kolab, 'V0')).toMatchObject({ B: 'Dave adds B.' });
  expect(Object.keys(await textOf(kolab, 'V0'))).not.toContain('A');
  // Through commit, the loser gets Kolab's GateError, never a database error.
  const again = await kolab.draft(product, 'V0', add('A', 'Alice adds A.'));
  await commitReviewed(kolab, dave, product, 'V0', add('C', 'Dave adds C.'));
  expect(await rejection(kolab.review(again).then((x) => { if (!x.ok) throw new GateError(`review rejected: ${x.note}`); }))).toMatch(/^GateError: review rejected: stale draft/);
  expect(await stranded(kolab, ids)).toStrictEqual([]);
});

test('a commit to a node while another draft of it is in review rejects that draft, even after the reviewer passed it', async () => {
  const { kolab, product, setHook } = await hooked();
  const B = await kolab.createNode(product, 'functional_spec', 'B', 'B');
  await kolab.commit(product, B, { elements: els({ b1: 'v1' }) });
  await people(kolab, 'dave', { layers: ['functional'] });
  const dave = await kolab.openSession('dave', 'product');
  const draft = await kolab.draft(product, B, { elements: els({ b1: 'alice edit' }) });
  setHook(async ({ version }) => {
    if (version.id !== draft) return;
    setHook(undefined);
    await commitReviewed(kolab, dave, product, B, { elements: els({ b1: 'dave edit' }) });
  });

  const r = await kolab.review(draft);
  expect([r.ok, r.stale, r.note]).toStrictEqual([false, true, 'stale draft: the node committed a newer version; redraft against it']);
  expect((await kolab.version(draft)).state).toBe('rejected');
  expect(await textOf(kolab, B)).toStrictEqual({ b1: 'dave edit' });
});

test('a draft reviewed twice at once commits once; the other review gets a GateError', async () => {
  const { kolab, product } = await setup();
  const B = await kolab.createNode(product, 'functional_spec', 'B', 'B');
  await kolab.commit(product, B, { elements: els({ b1: 'v1' }) });
  const draft = await kolab.draft(product, B, { elements: els({ b1: 'v2' }) });
  const rs = await Promise.allSettled([kolab.review(draft), kolab.review(draft)]);

  expect(rs.filter((r) => r.status === 'fulfilled').map((r) => r.value.ok)).toStrictEqual([true]);
  const lost = rs.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
  expect(String(lost.reason)).toMatch(/^GateError: \S+ (is no longer drafted|is committed, not drafted)/);
  expect((await history(kolab, B)).map((v) => [v.seq, v.state])).toStrictEqual([[1, 'committed'], [2, 'committed']]);
});

// ---- a commit during a review ---------------------------------------------------

test('a parent commit while a draft of its variant is in review folds the draft, keeping its human edit (1b)', async () => {
  const { kolab, product, setHook } = await hooked();
  const { ids, next } = await family(kolab, product, 1);
  const draft = await kolab.draft(product, 'V0', add('H', 'Human edit to V0.'));
  setHook(async ({ version }) => {
    if (version.id !== draft) return;
    setHook(undefined);
    await kolab.commit(product, 'P', { elements: next });   // rebases V0@1 while the draft waits
  });

  const r = await kolab.review(draft);
  expect(r.ok).toBe(true);
  expect(r.version).not.toBe(draft);
  expect(await noteOf(kolab, draft)).toBe(`folded into ${r.version}`);
  expect(await textOf(kolab, 'V0')).toStrictEqual({
    E0: 'Parent element 0, rev 2.', E1: 'Parent element 1.', E2: 'V0 says E2 its own way.', H: 'Human edit to V0.',
  });
  expect((await history(kolab, 'V0')).map((v) => [v.seq, v.active_role, v.state, v.base])).toStrictEqual([
    [1, 'product', 'committed', null],
    [2, 'product', 'rejected', 1],     // the draft, overtaken while in review
    [3, 'system', 'committed', 1],     // the storm's rebase of V0@1
    [4, 'product', 'committed', 3],    // the fold: the draft's edit on the rebase, by its author
  ]);
  expect(await stranded(kolab, ids)).toStrictEqual([]);
  expect((await kolab.openMarks()).filter((m) => m.reason !== 'override_stale')).toStrictEqual([]);
});

test('a draft overtaken only by Kolab\'s own rebases before review still folds and keeps its human edit', async () => {
  const { kolab, product } = await setup();
  const { next } = await family(kolab, product, 1);
  const draft = await kolab.draft(product, 'V0', add('H', 'Human edit to V0.'));
  await kolab.commit(product, 'P', { elements: next });
  await kolab.commit(product, 'P', { elements: els({ E0: 'Parent element 0, rev 3.', E1: 'Parent element 1.', E2: 'Parent element 2.' }) });

  const r = await kolab.review(draft);
  expect(r.ok).toBe(true);
  expect(r.version).not.toBe(draft);
  expect(await textOf(kolab, 'V0')).toStrictEqual({
    E0: 'Parent element 0, rev 3.', E1: 'Parent element 1.', E2: 'V0 says E2 its own way.', H: 'Human edit to V0.',
  });
  expect(await kolab.author(r.version)).toMatchObject({ actor: 'alice', role: 'product' });
});

test('a human commit between judging a draft overtaken by rebases and folding it makes the fold stale, not lost', async () => {
  const { kolab, product } = await setup();
  const { next } = await family(kolab, product, 1);
  await people(kolab, 'dave', { layers: ['functional'] });
  const dave = await kolab.openSession('dave', 'product');
  const draft = await kolab.draft(product, 'V0', add('A', 'Alice adds A.'));
  await commitReviewed(kolab, product, dave, 'P', { elements: next });   // V0@3, Kolab's rebase, overtakes the draft

  // Dave commits the moment the fold starts work: at its first read of the variant's parent.
  const proto = Object.getPrototypeOf(kolab.db);
  const query = proto.query;
  let armed = true;
  proto.query = async function (sql: string, params?: unknown[]) {
    if (armed && sql.includes("state = 'committed' order by seq desc limit 1") && params?.[0] === 'P') {
      armed = false;
      await commitReviewed(kolab, dave, product, 'V0', add('B', 'Dave adds B.'));
    }
    return query.call(this, sql, params);
  };
  let r;
  try { r = await kolab.review(draft); } finally { proto.query = query; }

  expect(armed).toBe(false);
  expect([r.ok, r.stale]).toStrictEqual([false, true]);
  expect(await textOf(kolab, 'V0')).toMatchObject({ E0: 'Parent element 0, rev 2.', B: 'Dave adds B.' });
  expect(Object.keys(await textOf(kolab, 'V0'))).not.toContain('A');
  expect(await noteOf(kolab, draft)).toMatch(/^overtaken by Kolab's rebases; folding it into \S+ failed: stale draft/);
  expect((await history(kolab, 'V0')).map((v) => [v.seq, v.active_role, v.state, v.base])).toStrictEqual([
    [1, 'product', 'committed', null],
    [2, 'product', 'rejected', 1],    // Alice's draft
    [3, 'system', 'committed', 1],    // the storm's rebase
    [4, 'product', 'committed', 3],   // Dave's commit, in the window
    [5, 'product', 'rejected', 3],    // the fold, built on the rebase it judged, so Dave's commit overtook it
  ]);
});

// ---- a human commit during a rebase storm ------------------------------------------

test('a human commit to a variant the storm listed but hasn\'t reached keeps its edit, in the variant and its child (1a)', async () => {
  const { kolab, product, setHook } = await hooked();
  const { ids, next } = await family(kolab, product, 2, 1);
  let edited: string | undefined;
  setHook(async ({ version }) => {
    // While the storm reviews its first root's rebase, edit the other root, which it listed already.
    if (edited || version.active_role !== 'system' || !/^V\d$/.test(version.node_id)) return;
    edited = version.node_id === 'V0' ? 'V1' : 'V0';
    await kolab.commit(product, edited, add('H', `Human edit to ${edited}.`));
  });

  await kolab.commit(product, 'P', { elements: next });
  setHook(undefined);
  expect(edited).toBeDefined();
  expect(await textOf(kolab, edited!)).toMatchObject({ E0: 'Parent element 0, rev 2.', H: `Human edit to ${edited}.` });
  expect(await textOf(kolab, `${edited}.0`)).toMatchObject({ E0: 'Parent element 0, rev 2.', H: `Human edit to ${edited}.` });
  expect(await stranded(kolab, ids)).toStrictEqual([]);
  expect((await kolab.openMarks()).filter((m) => m.reason !== 'override_stale')).toStrictEqual([]);
});

test('a storm\'s rebase overtaken by a human commit while in review is dropped, with no mark', async () => {
  const { kolab, product, setHook } = await hooked();
  const { ids, next } = await family(kolab, product, 2);
  let rebase: string | undefined;
  setHook(async ({ version }) => {
    if (rebase || version.active_role !== 'system' || version.node_id !== 'V1') return;
    rebase = version.id;
    await kolab.commit(product, 'V1', add('H', 'Human edit to V1.'));
  });

  await kolab.commit(product, 'P', { elements: next });
  setHook(undefined);
  expect((await kolab.version(rebase!)).state).toBe('rejected');
  expect(await noteOf(kolab, rebase!)).toMatch(/^superseded: /);
  expect(await textOf(kolab, 'V1')).toMatchObject({ E0: 'Parent element 0, rev 2.', H: 'Human edit to V1.' });
  expect(await stranded(kolab, ids)).toStrictEqual([]);
  expect((await kolab.openMarks()).filter((m) => m.reason !== 'override_stale')).toStrictEqual([]);
});

test('a human commit between the storm\'s version number and its insert waits its turn: no collision, nothing lost (2a)', async () => {
  const { kolab, product } = await setup();
  const { ids, next } = await family(kolab, product, 4);
  const proto = Object.getPrototypeOf(kolab.db);
  const query = proto.query;
  let edited: string | undefined, human: Promise<unknown> | undefined;
  proto.query = async function (sql: string, params?: unknown[]) {
    const res = await query.call(this, sql, params);
    const node = params?.[0];
    if (!edited && sql.includes('coalesce(max(seq)') && typeof node === 'string' && node.startsWith('V')) {
      edited = node;
      // Not awaited here: this read is inside the storm's transaction, which holds the node's lock.
      human = kolab.commit(product, node, add('H', `Human edit to ${node}.`));
    }
    return res;
  };
  try {
    await kolab.commit(product, 'P', { elements: next });
    await human;
  } finally { proto.query = query; }

  expect(await textOf(kolab, edited!)).toMatchObject({ E0: 'Parent element 0, rev 2.', H: `Human edit to ${edited}.` });
  expect(await stranded(kolab, ids)).toStrictEqual([]);
  expect((await kolab.openMarks()).filter((m) => m.reason !== 'override_stale')).toStrictEqual([]);
});

test('a rebase that throws marks its variant, and the storm carries on to the rest', async () => {
  const { kolab, product } = await hooked({ checks: async (ctx) => {
    if (ctx.version.node_id === 'V1') throw new Error('the checks fell over');
    return structuralChecks(ctx);
  } });
  const { ids, next } = await family(kolab, product, 3);
  await kolab.commit(product, 'P', { elements: next });

  expect(await stranded(kolab, ids)).toStrictEqual(['V1']);
  const marks = (await marksOn(kolab, 'V1')).filter((m) => m.reason !== 'override_stale');
  expect(marks.map((m) => [m.version_id, m.reason])).toStrictEqual([[(await kolab.latestCommitted('V1'))!.id, 'rebase_failed']]);
  const [q] = (await kolab.openQueries()).filter((x) => x.question.startsWith('Rebasing'));
  expect(q.question).toMatch(/^Rebasing onto the new parent failed: Kolab's checks failed on \S+: the checks fell over\./);
  // The rebase the checks fell over on is rejected, not left drafted for anyone to resubmit.
  expect((await history(kolab, 'V1')).map((v) => v.state)).toStrictEqual(['committed', 'rejected']);
});

/** Makes the first db.query matching `when` throw a connection error, until `restore` is called. */
function failOnce(kolab: Kolab, when: (sql: string, params?: unknown[]) => boolean) {
  const proto = Object.getPrototypeOf(kolab.db);
  const query = proto.query;
  let armed = true;
  proto.query = async function (sql: string, params?: unknown[]) {
    if (armed && when(sql, params)) {
      armed = false;
      throw new Error('Connection terminated unexpectedly');
    }
    return query.call(this, sql, params);
  };
  return { fired: () => !armed, restore: () => { proto.query = query; } };
}

/** supersedePrevious's first read, in the cascade of a version of `node` that has just committed. */
const supersedeRead = (node: string) => (sql: string, params?: unknown[]) =>
  sql.includes("seq < $2 and state = 'committed' order by seq desc limit 1") && params?.[0] === node;

/** Waits out a failed cascade's first backoff (1 s), then has the outbox's jobs run (W1.8). */
async function retried(kolab: Kolab) {
  await new Promise((r) => setTimeout(r, 1100));
  await kolab.drainOutbox();
  expect((await kolab.db.query(`select 1 from outbox`)).rows).toStrictEqual([]);
}

/** The outbox's jobs, by kind and what failed them. */
const owed = async (kolab: Kolab) =>
  (await kolab.db.query<{ kind: string; last_error: string | null }>(`select kind, last_error from outbox order by id`)).rows;

test('a failure in a committed rebase\'s own cascade leaves that job to retry; the parent\'s commit returned, and nothing is marked (P6)', async () => {
  const { kolab, product } = await setup();
  const { ids, next } = await family(kolab, product, 2);
  const fail = failOnce(kolab, supersedeRead('V0'));
  let r: Awaited<ReturnType<Kolab['review']>>;
  // The commit returns once P is committed, with its variants' rebases queued (D43); the worker
  // (here, the drain after the write) runs them, and V0's rebase's own cascade fails.
  try { r = await kolab.review(await kolab.draft(product, 'P', { elements: next })); } finally { fail.restore(); }

  expect(fail.fired()).toBe(true);
  expect(r).toMatchObject({ ok: true, rebases: 2 });
  expect(await stranded(kolab, ids)).toStrictEqual([]);   // V0's rebase stands, and V1's ran
  expect((await kolab.openMarks()).filter((m) => m.reason === 'rebase_failed')).toStrictEqual([]);
  // The failure is the jobs', not the commit's: V0's rebase's cascade, and the rebase job that ran it, wait to retry.
  expect(await owed(kolab)).toStrictEqual([
    { kind: 'rebase', last_error: 'V0@2 committed, but its cascade did not finish: Connection terminated unexpectedly' },
    { kind: 'after_commit', last_error: 'V0@2 committed, but its cascade did not finish: Connection terminated unexpectedly' },
  ]);
  // The parent's next commit queues them again, and V0's next cascade waits behind its failed one,
  // in commit order. Once their backoff is over, the worker catches everything up.
  await kolab.commit(product, 'P', { elements: els({ E0: 'Parent element 0, rev 3.', E1: 'Parent element 1.', E2: 'Parent element 2.' }) });
  await retried(kolab);
  expect(await stranded(kolab, ids)).toStrictEqual([]);
});

test('a lost connection during a variant\'s rebase leaves its job to retry, and the other variants rebase (P6)', async () => {
  const { kolab, product } = await setup();
  const { ids, next } = await family(kolab, product, 3);
  const fail = failOnce(kolab, (sql, params) => sql.includes('coalesce(max(seq)') && params?.[0] === 'V1');
  let r: Awaited<ReturnType<Kolab['review']>>;
  try { r = await kolab.review(await kolab.draft(product, 'P', { elements: next })); } finally { fail.restore(); }

  expect(fail.fired()).toBe(true);
  expect(r).toMatchObject({ ok: true, rebases: 3 });
  // Only V1 is behind, and it says so: its rebase waits in the outbox with the error, unmarked.
  expect(await stranded(kolab, ids)).toStrictEqual(['V1']);
  expect(await kolab.pendingRebase('V1')).toMatchObject({ state: 'pending', attempts: 1, last_error: 'Connection terminated unexpectedly' });
  expect((await kolab.openMarks()).filter((m) => m.reason === 'rebase_failed')).toStrictEqual([]);
  await retried(kolab);
  expect(await stranded(kolab, ids)).toStrictEqual([]);
});

test('a storm\'s rebase dropped as overtaken catches up the version that overtook it, even if that version\'s own cascade never got there', async () => {
  const { kolab, product, setHook } = await hooked();
  const { ids, next } = await family(kolab, product, 2);
  let human: string | undefined;
  setHook(async ({ version }) => {
    if (human !== undefined || version.active_role !== 'system' || version.node_id !== 'V1') return;
    // A human commits to V1 while the storm's rebase of it is in review, and that commit's
    // cascade dies before its own catch-up (step 5).
    const fail = failOnce(kolab, supersedeRead('V1'));
    try { human = await rejection(kolab.commit(product, 'V1', add('H', 'Human edit to V1.'))); } finally { fail.restore(); }
  });
  await kolab.commit(product, 'P', { elements: next });
  setHook(undefined);

  expect(human).toMatch(/^CascadeError: V1@\d+ committed, but its cascade did not finish/);
  expect(await stranded(kolab, ids)).toStrictEqual([]);
  expect(await textOf(kolab, 'V1')).toMatchObject({ E0: 'Parent element 0, rev 2.', H: 'Human edit to V1.' });
  expect((await kolab.openMarks()).filter((m) => m.reason !== 'override_stale')).toStrictEqual([]);
});

test('a variant whose rebases keep failing holds one rebase_failed mark and one question, re-pointed at the newest parent', async () => {
  const { kolab, product } = await hooked({ checks: async (ctx) =>
    (ctx.version.node_id === 'V0' ? { ok: false, note: 'contradicts itself' } : structuralChecks(ctx)) });
  const { next } = await family(kolab, product, 1);
  await kolab.commit(product, 'P', { elements: next });
  const p3 = await kolab.commit(product, 'P', { elements: els({ E0: 'Parent element 0, rev 3.', E1: 'Parent element 1.', E2: 'Parent element 2.' }) });

  const marks = (await marksOn(kolab, 'V0')).filter((m) => m.reason === 'rebase_failed');
  expect(marks.map((m) => m.triggered_by)).toStrictEqual([p3]);
  expect((await kolab.openMarks()).filter((m) => m.reason === 'review_failed')).toStrictEqual([]);
  expect((await kolab.openQueries()).filter((q) => q.question.startsWith('Rebasing')).length).toBe(1);
});

// ---- the base is recorded, and enforced for agents ------------------------------------

test('an agent may only build a draft on a committed version of its own node', async () => {
  const { kolab, product } = await setup();
  const A = await kolab.createNode(product, 'functional_spec', 'A', 'A');
  const a1 = await kolab.commit(product, A, { elements: els({ E: 'a' }) });
  const B = await kolab.createNode(product, 'functional_spec', 'B', 'B');
  await kolab.commit(product, B, { elements: els({ F: 'b' }) });
  const insert = (base: string) => kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(product)]);
    await tx.query(`insert into version(id, node_id, seq, base_version_id, layer, state, actor_id, active_role)
                    values ('forged', $1, 99, $2, 'functional', 'drafted', 'alice', 'product')`, [B, base]);
  });
  expect(await rejection(insert(a1))).toMatch(/row-level security/);
});

// ---- the review flow (W1.6, PR #26 review) -------------------------------------------

/** Alice's spec S@1, and Dave and Erin, each a reviewer of the other product owners' versions. */
async function reviewers() {
  const ctx = await hooked();
  const { kolab, product } = ctx;
  const S = await kolab.createNode(product, 'functional_spec', 'S', 'S');
  await kolab.commit(product, S, { elements: els({ s1: 'v1' }) });
  await people(kolab, ['dave', 'erin'], { layers: ['functional'] });
  return { ...ctx, S, dave: await kolab.openSession('dave', 'product'), erin: await kolab.openSession('erin', 'product') };
}

/**
 * Starts `other` (not awaited) the first time a query matching `when` runs, then lets that query
 * go on: `other` runs while the operation that made the query holds the node's lock.
 */
function injectAt(kolab: Kolab, when: (sql: string, params?: unknown[]) => boolean, other: () => Promise<unknown>) {
  const proto = Object.getPrototypeOf(kolab.db);
  const query = proto.query;
  let started: Promise<PromiseSettledResult<unknown>> | undefined;
  proto.query = async function (sql: string, params?: unknown[]) {
    if (!started && when(sql, params)) {
      started = other().then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
    }
    return query.call(this, sql, params);
  };
  return { other: () => started!, restore: () => { proto.query = query; } };
}

/** The approval's read of the version under the node's lock, as it records its verdict. */
const approvalRead = (id: string) => (sql: string, params?: unknown[]) => sql.startsWith('select state, review_note from version where id = $1') && params?.[0] === id;
/** abandon's read of the version under the node's lock, before it rejects it. */
const abandonRead = (id: string) => (sql: string, params?: unknown[]) => sql.startsWith('select state from version where id = $1') && params?.[0] === id;

test('an author abandoning a version while an approval holds the node\'s lock loses: the approval commits, and abandon is told so', async () => {
  const { kolab, product, dave, S } = await reviewers();
  const v = await kolab.draft(product, S, { elements: els({ s1: 'alice edit' }) });
  await kolab.review(v);
  const hook = injectAt(kolab, approvalRead(v), () => kolab.abandon(product, v));
  let approval;
  try { approval = await kolab.recordReview(dave, v, { verdict: 'approve' }); } finally { hook.restore(); }
  const abandon = await hook.other();
  expect(approval.ok).toBe(true);
  expect(abandon.status).toBe('rejected');
  expect(String((abandon as PromiseRejectedResult).reason)).toMatch(/GateError: S@2 is committed; only a draft or a version in review can be abandoned/);
  expect((await kolab.version(v)).state).toBe('committed');
});

test('an approval arriving while the author abandons the version under the node\'s lock loses: nothing commits, and the reviewer is told why', async () => {
  const { kolab, product, dave, S } = await reviewers();
  const v = await kolab.draft(product, S, { elements: els({ s1: 'alice edit' }) });
  await kolab.review(v);
  const hook = injectAt(kolab, abandonRead(v), () => kolab.recordReview(dave, v, { verdict: 'approve' }));
  let state;
  try { state = await kolab.abandon(product, v); } finally { hook.restore(); }
  const approval = await hook.other();
  expect(state).toBe('rejected');
  expect(approval.status).toBe('rejected');
  expect(String((approval as PromiseRejectedResult).reason)).toMatch(/GateError: S@2 was rejected \(abandoned by alice\); there is nothing to review/);
  expect((await kolab.version(v)).state).toBe('rejected');
  expect(await textOf(kolab, 'S')).toStrictEqual({ s1: 'v1' });
  expect(await kolab.reviewRequests()).toStrictEqual([]);
});

test('an author who abandons an approved version while Kolab folds it keeps the edit out: the fold never commits', async () => {
  const { kolab, product, setHook } = await hooked();
  const { next } = await family(kolab, product, 1);
  await people(kolab, 'dave', { layers: ['functional'] });
  const dave = await kolab.openSession('dave', 'product');
  const draft = await kolab.draft(product, 'V0', add('H', 'Human edit to V0.'));
  await kolab.review(draft);
  await commitReviewed(kolab, product, dave, 'P', { elements: next });   // Kolab's rebase of V0 overtakes the draft in review
  setHook(async ({ version }) => {
    // The fold of the approved draft is being checked: its author abandons the draft now.
    if (version.node_id !== 'V0' || version.active_role === 'system' || version.id === draft) return;
    setHook(undefined);
    await kolab.abandon(product, draft);
  });
  const r = await kolab.recordReview(dave, draft, { verdict: 'approve' });
  expect(r.ok).toBe(false);
  expect(r.note).toMatch(/was abandoned by alice while Kolab folded it/);
  expect(Object.keys(await textOf(kolab, 'V0'))).not.toContain('H');
  expect(await noteOf(kolab, draft)).toBe('abandoned by alice');
  expect((await history(kolab, 'V0')).map((v) => [v.seq, v.active_role, v.state])).toStrictEqual([
    [1, 'product', 'committed'], [2, 'product', 'rejected'], [3, 'system', 'committed'], [4, 'product', 'rejected'],
  ]);
});

test('two reviewers approving at once commit the version once; the second is told it already committed', async () => {
  const { kolab, product, dave, erin, S } = await reviewers();
  const v = await kolab.draft(product, S, { elements: els({ s1: 'alice edit' }) });
  await kolab.review(v);
  const rs = await Promise.allSettled([kolab.recordReview(dave, v, { verdict: 'approve' }), kolab.recordReview(erin, v, { verdict: 'approve' })]);
  expect(rs.filter((r) => r.status === 'fulfilled').map((r) => r.value.ok)).toStrictEqual([true]);
  expect(String((rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/GateError: S@2 is committed already/);
  expect((await history(kolab, 'S')).map((x) => [x.seq, x.state])).toStrictEqual([[1, 'committed'], [2, 'committed']]);
});

test('an approval arriving while another approval to the node commits, in either order: the first commits, the second is stale, and nothing merges', async () => {
  for (const first of ['alice', 'dave'] as const) {
    const { kolab, product, dave, S } = await reviewers();
    const mine = await kolab.draft(product, S, { elements: els({ s1: 'alice edit' }) });
    const theirs = await kolab.draft(dave, S, { elements: els({ s1: 'dave edit' }) });
    await kolab.review(mine); await kolab.review(theirs);
    // Alice's version is approved by dave, dave's by alice; the second approval arrives while the first holds the lock.
    const [winner, loser] = first === 'alice' ? [mine, theirs] : [theirs, mine];
    const approve = (id: string) => kolab.recordReview(id === mine ? dave : product, id, { verdict: 'approve' });
    const hook = injectAt(kolab, approvalRead(winner), () => approve(loser));
    let won;
    try { won = await approve(winner); } finally { hook.restore(); }
    const lost = await hook.other();
    expect(won.ok).toBe(true);
    expect((await kolab.version(winner)).state).toBe('committed');
    expect((await kolab.version(loser)).state).toBe('rejected');
    expect(lost.status === 'rejected' ? String(lost.reason) : (lost.value as { note: string }).note).toMatch(/stale draft/);
    expect((await textOf(kolab, S)).s1).toBe(first === 'alice' ? 'alice edit' : 'dave edit');
    expect(await kolab.reviewRequests()).toStrictEqual([]);
  }
});
