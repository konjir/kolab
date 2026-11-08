// Splits retire elements (CAS10, ADR10, D19): a split is one version of a node that removes a
// compound element and adds the elements it is split into, each with a derivation link to the old
// element at the version the draft builds on. Every other link into the old element is orphaned,
// its mark naming the elements derived from it, and re-pointing the link to one of them settles the
// mark. The split's own derivation links stay pinned to that version and are never marked.
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { els, marksOn, rejection, setup } from '@konjir/engine/testing';

type Ctx = Awaited<ReturnType<typeof setup>>;

/** The links of a node's live version, as `source element -> target node@seq#element`. */
async function linksOf(kolab: Kolab, node: string) {
  const live = (await kolab.latestCommitted(node))!;
  return (await kolab.db.query<{ l: string }>(
    `select e.kind || ' ' || e.source_element_id || ' -> ' || t.node_id || '@' || t.seq || '#' || coalesce(e.target_element_id, '*') as l
       from edge e join version t on t.id = e.target_version_id where e.source_version_id = $1 order by 1`, [live.id])).rows.map((r) => r.l);
}

const markRow = async (kolab: Kolab, id: string) =>
  (await kolab.db.query<{ state: string; cleared_by: string | null }>(`select state, cleared_by from invalidation where id = $1`, [id])).rows[0];

/**
 * Spec `spec` (R1, a compound element, and R2), binding `b` (b1 -> R1, b2 -> R2) and work `w`
 * (w1 -> b1); then a split of R1 into R1a and R1b, which spec@2 commits.
 */
async function split(ctx: Ctx) {
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'spec', 'Spec', 'spec');
  const s1 = await kolab.commit(product, 'spec', { elements: els({ R1: 'Carts expire after 30 days, and hold 50 items.', R2: 'Checkout takes one page.' }) });
  await kolab.createNode(engineer, 'binding', 'Binding', 'b');
  const b1 = await kolab.commit(engineer, 'b', { elements: els({ b1: 'A nightly job expires carts, and a check caps them.', b2: 'One React page.' }) });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1' });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b2', target: s1, targetElement: 'R2' });
  await kolab.createNode(engineer, 'binding', 'WBS', 'w');
  const w1 = await kolab.commit(engineer, 'w', { elements: els({ w1: 'Write the expiry job.' }) });
  await kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'w1', target: b1, targetElement: 'b1' });

  const draft = await kolab.draft(product, 'spec', { elements: els({ R1a: 'Carts expire after 30 days.', R1b: 'Carts hold 50 items.', R2: 'Checkout takes one page.' }) });
  for (const el of ['R1a', 'R1b']) await kolab.link(product, { kind: 'derivation', source: draft, sourceElement: el, target: s1, targetElement: 'R1' });
  expect(await kolab.review(draft)).toMatchObject({ ok: true });
  return { s1, s2: draft };
}

test('a split orphans the other links into the old element, naming the elements derived from it, and marks none of its own (CAS10)', async () => {
  const ctx = await setup();
  const { kolab } = ctx;
  await split(ctx);
  // The old element is retired: gone from spec@2, still readable at spec@1 (ADR9).
  expect((await kolab.resolve('kj:spec@1#R1', { session: ctx.product })).status).toBe('ok');
  expect((await kolab.resolve('kj:spec#R1', { session: ctx.product })).status).toBe('orphan');

  const [orphan] = await marksOn(kolab, 'b');
  expect(await marksOn(kolab, 'b')).toHaveLength(1);
  expect(orphan).toMatchObject({ reason: 'orphaned', element_id: 'b1' });
  // Its transitive marks (CAS2).
  expect((await marksOn(kolab, 'w')).map((m) => [m.element_id, m.reason])).toStrictEqual([['w1', 'upstream_dirty']]);
  const [listed] = await kolab.describeMarks({ node: 'b' });
  expect(listed.because).toBe('kj:spec#R1 was retired by version 2, which split it into kj:spec#R1a and kj:spec#R1b: re-point the link to the one it relies on');
  expect(listed.next).toMatch(/split/);
  // The split's own derivation links are unmarked, pinned to the version R1 was retired from.
  expect(await marksOn(kolab, 'spec')).toStrictEqual([]);
  expect(await linksOf(kolab, 'spec')).toStrictEqual(['derivation R1a -> spec@1#R1', 'derivation R1b -> spec@1#R1']);
});

test('re-pointing an orphaned link to an element derived from its target replaces it, and settles its mark when the draft commits (CAS10)', async () => {
  const ctx = await setup();
  const { kolab, engineer } = ctx;
  const { s2 } = await split(ctx);
  const [orphan] = await marksOn(kolab, 'b');
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b1', text: 'A nightly job expires carts.' }] });
  await kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b1', target: s2, targetElement: 'R1a' });
  expect(await kolab.removedLinks({ session: engineer }, await kolab.version(draft)))
    .toStrictEqual([{ kind: 'dependency', source: 'kj:b@2#b1', target: 'kj:spec#R1' }]);
  expect((await markRow(kolab, orphan.id)).state).toBe('open');   // not until it commits
  await kolab.review(draft);
  expect(await markRow(kolab, orphan.id)).toStrictEqual({ state: 'cleared', cleared_by: 'its link was removed by b@2' });
  expect(await marksOn(kolab, 'b')).toStrictEqual([]);
  expect(await linksOf(kolab, 'b')).toStrictEqual(['dependency b1 -> spec@2#R1a', 'dependency b2 -> spec@2#R2']);
  // w1 keeps only the mark b1's own revision raised.
  expect((await marksOn(kolab, 'w')).map((m) => [m.element_id, m.reason])).toStrictEqual([['w1', 'changed']]);
});

test('re-pointing goes only to an element derived from the orphaned target: another element stands beside it, and the mark stays', async () => {
  const ctx = await setup();
  const { kolab, engineer } = ctx;
  const { s2 } = await split(ctx);
  const [orphan] = await marksOn(kolab, 'b');
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b2', text: 'One Vue page.' }] });
  await kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b1', target: s2, targetElement: 'R2' });
  expect(await kolab.removedLinks({ session: engineer }, await kolab.version(draft))).toStrictEqual([]);
  await kolab.review(draft);
  expect((await markRow(kolab, orphan.id)).state).toBe('open');
});

test("the split's derivation links are never re-resolved by later versions of their node, or marked by its changes", async () => {
  const ctx = await setup();
  const { kolab, product } = ctx;
  await split(ctx);
  // spec@3 edits R2, spec@4 edits R1a, and spec@5 removes R1b: the links stay pinned to spec@1, unmarked.
  await kolab.commit(product, 'spec', { elements: els({ R1a: 'Carts expire after 30 days.', R1b: 'Carts hold 50 items.', R2: 'Checkout takes two pages.' }) });
  await kolab.commit(product, 'spec', { elements: els({ R1a: 'Carts expire after 31 days.', R1b: 'Carts hold 50 items.', R2: 'Checkout takes two pages.' }) });
  expect(await marksOn(kolab, 'spec')).toStrictEqual([]);
  expect(await linksOf(kolab, 'spec')).toStrictEqual(['derivation R1a -> spec@1#R1', 'derivation R1b -> spec@1#R1']);
  await kolab.commit(product, 'spec', { elements: els({ R1a: 'Carts expire after 31 days.', R2: 'Checkout takes two pages.' }) });
  expect(await marksOn(kolab, 'spec')).toStrictEqual([]);
  expect(await linksOf(kolab, 'spec')).toStrictEqual(['derivation R1a -> spec@1#R1']);
  // b1's orphan still names what R1 was split into.
  const [listed] = await kolab.describeMarks({ node: 'b' });
  expect(listed).toMatchObject({ reason: 'orphaned', because: expect.stringMatching(/split it into kj:spec#R1a and kj:spec#R1b/) });
});

test('a derivation link into an earlier version of another node is re-resolved as any link', async () => {
  const ctx = await setup();
  const { kolab, engineer, product } = ctx;
  const { s2 } = await split(ctx);
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'add', element: 'b3', text: 'Generated from R2.' }] });
  await kolab.link(engineer, { kind: 'derivation', source: draft, sourceElement: 'b3', target: s2, targetElement: 'R2' });
  await kolab.review(draft);
  await kolab.commit(product, 'spec', { elements: els({ R1a: 'Carts expire after 30 days.', R1b: 'Carts hold 50 items.', R2: 'Checkout takes two pages.' }) });
  expect((await marksOn(kolab, 'b')).map((m) => [m.element_id, m.reason]).sort()).toStrictEqual([['b1', 'orphaned'], ['b2', 'changed'], ['b3', 'changed']]);
  expect(await rejection(kolab.clear(engineer, (await marksOn(kolab, 'b'))[0].id))).toMatch(/the target no longer exists/);
});
