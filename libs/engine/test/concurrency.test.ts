// The commit races W2.7 found (libs/engine/scripts/REBASE-STORMS.md), closed by W1.17's commit
// step, serialized per node (CAS7, DAT3). Each injects one concurrent write at an exact point,
// through a reviewer hook or a wrapper on db.query, so it runs the same way on PGlite and on
// Postgres. `npm run rebase-storm -- --races` prints the same races as RACE or SAFE.
import { expect, test } from '@jest/globals';
import { GateError, Kolab, structuralReviewer } from '@konjir/engine';
import { els, marksOn, rejection, setup, textOf } from '@konjir/engine/testing';
import type { ReviewContext, Reviewer } from '@konjir/types';

type Hook = (ctx: ReviewContext) => Promise<void>;

/** A Kolab whose reviewer runs `hook` first, set and cleared by the test. */
async function hooked(reviewer: Reviewer = structuralReviewer) {
  let hook: Hook | undefined;
  const ctx = await setup(async (c) => { await hook?.(c); return reviewer(c); });
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

test('two concurrent commits to one node: one commits, the other is rejected as stale with a GateError', async () => {
  const { kolab, product } = await setup();
  await kolab.addActor('dave');
  const dave = await kolab.openSession('dave', 'product');
  const { ids } = await family(kolab, product, 1);
  const rs = await Promise.allSettled([
    kolab.commit(product, 'V0', add('A', 'Alice adds A.')),
    kolab.commit(dave, 'V0', add('B', 'Dave adds B.')),
  ]);

  const won = rs.findIndex((r) => r.status === 'fulfilled');
  const lost = rs.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(1);
  expect(lost!.reason).toBeInstanceOf(GateError);
  expect(String(lost!.reason)).toMatch(/stale draft/);
  expect(Object.keys(await textOf(kolab, 'V0'))).toContain(won === 0 ? 'A' : 'B');
  // Both drafts took a number of their own, and only the winner committed.
  expect((await history(kolab, 'V0')).map((v) => [v.seq, v.state, v.base])).toStrictEqual([
    [1, 'committed', null], [2, won === 0 ? 'committed' : 'rejected', 1], [3, won === 1 ? 'committed' : 'rejected', 1],
  ]);
  expect(await stranded(kolab, ids)).toStrictEqual([]);
});

test('a commit to a node while another draft of it is in review rejects that draft, even after the reviewer passed it', async () => {
  const { kolab, product, setHook } = await hooked();
  await kolab.addActor('dave');
  const dave = await kolab.openSession('dave', 'product');
  const B = await kolab.createNode(product, 'functional_spec', 'B', 'B');
  await kolab.commit(product, B, { elements: els({ b1: 'v1' }) });
  const draft = await kolab.draft(product, B, { elements: els({ b1: 'alice edit' }) });
  setHook(async ({ version }) => {
    if (version.id !== draft) return;
    setHook(undefined);
    await kolab.commit(dave, B, { elements: els({ b1: 'dave edit' }) });
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
  const { kolab, product } = await hooked(async (ctx) => {
    if (ctx.version.active_role === 'system' && ctx.version.node_id === 'V1') throw new Error('the reviewer fell over');
    return structuralReviewer(ctx);
  });
  const { ids, next } = await family(kolab, product, 3);
  await kolab.commit(product, 'P', { elements: next });

  expect(await stranded(kolab, ids)).toStrictEqual(['V1']);
  const marks = (await marksOn(kolab, 'V1')).filter((m) => m.reason !== 'override_stale');
  expect(marks.map((m) => [m.version_id, m.reason])).toStrictEqual([[(await kolab.latestCommitted('V1'))!.id, 'review_failed']]);
  const [q] = (await kolab.openQueries()).filter((x) => x.question.startsWith('Rebasing'));
  expect(q.question).toMatch(/^Rebasing onto the new parent failed: the reviewer fell over\./);
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
    await tx.query(`select set_config('kj.session', $1, true)`, [product]);
    await tx.query(`insert into version(id, node_id, seq, base_version_id, layer, state, actor_id, active_role)
                    values ('forged', $1, 99, $2, 'functional', 'drafted', 'alice', 'product')`, [B, base]);
  });
  expect(await rejection(insert(a1))).toMatch(/row-level security/);
});
