// Regressions for the bugs W2.5's property tests (properties.test.ts) found, each the
// counterexample fast-check shrank to, written out by hand, and for the review of PR #28.
import { expect, test } from '@jest/globals';
import type { GateResult } from '@konjir/types';
import { approved, commitReviewed, els, marksOn, people, setup, textOf } from '@konjir/engine/testing';

test('a mark spreads downstream through a link that carries a mark of its own (LNK5)', async () => {
  const { kolab, product, engineer } = await setup();
  const S = await kolab.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 30 seconds.' }) });
  const B = await kolab.createNode(engineer, 'technical_binding', 'B', 'B');
  const b1 = await kolab.commit(engineer, B, { elements: els({ b1: 'Order worker.' }) });
  const W = await kolab.createNode(engineer, 'plan', 'W', 'W');
  const w1 = await kolab.commit(engineer, W, { elements: els({ w1: 'Build the order worker.' }) });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1' });
  await kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'w1', target: b1, targetElement: 'b1' });

  // The binding changes: w1's link is marked, and stays pinned to the binding's first version.
  await kolab.commit(engineer, B, { elements: els({ b1: 'Order worker, sharded.' }) });
  const [wChanged] = await marksOn(kolab, W);
  expect(wChanged.reason).toBe('changed');

  // Then the spec changes under b1. The walk must still reach w1, though its link sits on b1's old version.
  await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.' }) });
  expect((await marksOn(kolab, W)).map((m) => m.reason).sort()).toStrictEqual(['changed', 'upstream_dirty']);

  // Clearing w1's own mark leaves it dirty while b1 is: before the fix it came out clean.
  await kolab.clear(engineer, wChanged.id);
  expect((await marksOn(kolab, W)).map((m) => m.reason)).toStrictEqual(['upstream_dirty']);
  const [bMark] = await marksOn(kolab, B);
  await kolab.clear(engineer, bMark.id);
  expect(await marksOn(kolab, W)).toStrictEqual([]);
});

async function nested() {
  const ctx = await setup();
  const { kolab, product } = ctx;
  const P = await kolab.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await kolab.commit(product, P, { elements: els({ E1: 'Timeout is 15 minutes.', E2: 'Logo top-left.' }) });
  const V1 = await kolab.createNode(product, 'prototype', 'V1', 'V1');
  const v1 = await kolab.commit(product, V1, { parent: p1, deltas: [{ kind: 'add', element: 'X1', text: 'Chat is on.' }] });
  const V2 = await kolab.createNode(product, 'prototype', 'V2', 'V2');
  return { ...ctx, P, V1, V2, v1 };
}

test('an override mark that settles on its own closes its question too', async () => {
  const { kolab, product, V1, V2, v1 } = await nested();
  await kolab.commit(product, V2, { parent: v1, deltas: [{ kind: 'override', element: 'E1', text: 'Timeout is 15 minutes.' }] });
  // V1 changes E1 under V2's override: dirty, with a mark and a question.
  await kolab.commit(product, V1, { deltas: [{ kind: 'override', element: 'E1', text: 'Timeout is 30 minutes.' }] });
  expect((await marksOn(kolab, V2)).map((m) => m.reason)).toStrictEqual(['override_stale']);
  expect((await kolab.listQueries({ node: V2, state: 'open' })).length).toBe(1);

  // V1 goes back to the text V2's override was written against: the override is clean again.
  await kolab.commit(product, V1, { deltas: [{ kind: 'override', element: 'E1', text: 'Timeout is 15 minutes.' }] });
  expect(await marksOn(kolab, V2)).toStrictEqual([]);
  // Before the fix the question stayed open, and nothing could answer it.
  expect(await kolab.listQueries({ node: V2, state: 'open' })).toStrictEqual([]);
});

test('an orphaned override whose element comes back changed is marked and asked as stale', async () => {
  const { kolab, product, P, V1 } = await nested();
  await kolab.commit(product, V1, { deltas: [{ kind: 'override', element: 'E1', text: 'Timeout is 30 minutes.' }] });
  await kolab.commit(product, P, { elements: els({ E2: 'Logo top-left.' }) });
  const [orphaned] = await marksOn(kolab, V1);
  expect(orphaned.reason).toBe('override_orphaned');

  await kolab.commit(product, P, { elements: els({ E1: 'Timeout is 10 minutes.', E2: 'Logo top-left.' }) });
  const marks = await marksOn(kolab, V1);
  // The same mark, reworded: it was raised as orphaned and kept saying so.
  expect(marks.map((m) => [m.id, m.reason])).toStrictEqual([[orphaned.id, 'override_stale']]);
  const questions = await kolab.listQueries({ node: V1, state: 'open' });
  expect(questions.map((q) => q.question)).toStrictEqual(['The parent changed E1, which you override. Reaffirm, adopt the parent\'s text, or amend?']);
});

test('a resolution\'s precedent reaches the nested variant its own cascade rebases (OVR9)', async () => {
  const { kolab, product, P, V1, V2, v1 } = await nested();
  // V1 and V2 both override E1 with the parent's own text.
  const v1b = await kolab.commit(product, V1, { parent: (await kolab.latestCommitted(P))!.id, deltas: [{ kind: 'override', element: 'E1', text: 'Timeout is 15 minutes.' }] });
  expect(v1b).not.toBe(v1);
  await kolab.commit(product, V2, { parent: v1b, deltas: [{ kind: 'override', element: 'E1', text: 'Timeout is 15 minutes.' }] });
  await kolab.commit(product, P, { elements: els({ E1: 'Timeout is 10 minutes.', E2: 'Logo top-left.' }) });
  const [stale] = await marksOn(kolab, V1);
  expect(stale.reason).toBe('override_stale');
  expect(await marksOn(kolab, V2)).toStrictEqual([]); // V1 still says 15 minutes, as V2's override does

  // V1 adopts the parent. V2 then rebases onto V1 with the same (base, parent, child) triple, so
  // the ruling settles V2 too. Before the fix the precedent was recorded after that rebase.
  await kolab.resolveOverride(product, stale.id, 'adopt_parent');
  expect((await textOf(kolab, V2)).E1).toBe('Timeout is 10 minutes.');
  expect(await marksOn(kolab, V2)).toStrictEqual([]);
});

// ---- the review of PR #28 ------------------------------------------------------

/** P, and variants A and B of it that both override E1 the same way; then P changes E1, so both are dirty. */
async function twins(reviewer?: Parameters<typeof setup>[0]) {
  const ctx = await setup(reviewer);
  const { kolab, product } = ctx;
  const P = await kolab.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await kolab.commit(product, P, { elements: els({ E1: 'Timeout is 15 minutes.', E2: 'Logo top-left.' }) });
  for (const id of ['A', 'B']) {
    await kolab.createNode(product, 'prototype', id, id);
    await kolab.commit(product, id, { parent: p1, deltas: [{ kind: 'override', element: 'E1', text: 'Timeout is 30 minutes.' }] });
  }
  await kolab.commit(product, P, { elements: els({ E1: 'Timeout is 10 minutes.', E2: 'Logo top-left.' }) });
  const [a] = await marksOn(kolab, 'A');
  return { ...ctx, P, a };
}

test('a resolution\'s precedent is invisible while it is in review, so a rejection leaves nothing behind', async () => {
  let during: (() => Promise<void>) | undefined;
  let verdict = { ok: true };
  const { kolab, product, a } = await twins(async (c) => {
    const hook = during;
    during = undefined;
    await hook?.();
    return c.elements.some((e) => e.text === 'Timeout is 20 minutes.') ? verdict : { ok: true };
  });

  // While A's resolution is in review, P commits again, so B rebases with the same triple.
  during = async () => { await kolab.commit(product, 'P', { elements: els({ E1: 'Timeout is 10 minutes.', E2: 'Logo top-center.' }) }); };
  verdict = { ok: false } as typeof verdict;
  const r = await kolab.resolveOverride(product, a.id, 'amend', 'Timeout is 20 minutes.');
  expect(r.verdict.ok).toBe(false);

  // B's rebase saw no precedent: it is still dirty, and asked; and none was left behind.
  expect((await textOf(kolab, 'B')).E1).toBe('Timeout is 30 minutes.');
  expect((await marksOn(kolab, 'B')).map((m) => m.reason)).toStrictEqual(['override_stale']);
  expect((await kolab.db.query(`select 1 from precedent`)).rows).toStrictEqual([]);
  expect((await marksOn(kolab, 'A')).map((m) => m.id)).toStrictEqual([a.id]);
});

test('of two resolutions of one mark, only the one that commits sets precedent and answers the question', async () => {
  let during: (() => Promise<void>) | undefined;
  const { kolab, product, a } = await twins(async () => {
    const hook = during;
    during = undefined;
    await hook?.();
    return { ok: true };
  });
  await people(kolab, 'dana');
  const dana = await kolab.openSession('dana', 'product');

  // Alice amends; while her draft is in review, Dana adopts the parent's text and commits first:
  // with two product owners, each one's resolution waits for the other's approval (W1.6).
  let danas: GateResult | undefined;
  during = async () => { danas = await approved(kolab, product, (await kolab.resolveOverride(dana, a.id, 'adopt_parent')).verdict); };
  const alices = await kolab.resolveOverride(product, a.id, 'amend', 'Timeout is 20 minutes.');
  expect(danas!.ok).toBe(true);
  expect(alices.verdict).toMatchObject({ ok: false, stale: true });

  expect((await kolab.db.query(`select resolution, ruled_by from precedent`)).rows).toStrictEqual([{ resolution: 'adopt_parent', ruled_by: 'dana' }]);
  expect((await kolab.db.query(`select state, answer, answered_by from query where invalidation_id = $1`, [a.id])).rows)
    .toStrictEqual([{ state: 'answered', answer: 'adopt_parent', answered_by: 'dana' }]);
  expect((await textOf(kolab, 'A')).E1).toBe('Timeout is 10 minutes.');
  // B follows Dana's ruling on P's next commit.
  await commitReviewed(kolab, product, dana, 'P', { elements: els({ E1: 'Timeout is 10 minutes.', E2: 'Logo top-center.' }) });
  expect((await textOf(kolab, 'B')).E1).toBe('Timeout is 10 minutes.');
});

test('a variant\'s commit settles marks only on the elements it revised, not on overrides it carried forward (CAS4)', async () => {
  const { kolab, product, engineer } = await setup();
  const P = await kolab.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await kolab.commit(product, P, { elements: els({ E1: 'Timeout is 15 minutes.', E2: 'Logo top-left.' }) });
  const V = await kolab.createNode(product, 'prototype', 'V', 'V');
  const v1 = await kolab.commit(product, V, { parent: p1, deltas: [{ kind: 'override', element: 'E2', text: 'Logo top-right.' }] });
  const B = await kolab.createNode(engineer, 'technical_binding', 'B', 'B');
  const b1 = await kolab.commit(engineer, B, { elements: els({ b1: 'Logo renderer.' }) });
  await kolab.link(product, { kind: 'dependency', source: v1, sourceElement: 'E2', target: b1, targetElement: 'b1' });
  await kolab.commit(engineer, B, { elements: els({ b1: 'Logo renderer, cached.' }) });
  const [x1] = await marksOn(kolab, V);
  expect([x1.element_id, x1.reason]).toStrictEqual(['E2', 'changed']);

  // V overrides E1. Its override of E2 is carried into the new version untouched, so E2's mark
  // stays. Before the fix, any element with a delta counted as revised.
  await kolab.commit(product, V, { deltas: [{ kind: 'override', element: 'E1', text: 'Timeout is 30 minutes.' }] });
  expect((await marksOn(kolab, V)).map((m) => m.id)).toStrictEqual([x1.id]);
});

test('revising an element settles its upstream_dirty mark (LNK6, CAS4)', async () => {
  const { kolab, product, engineer } = await setup();
  const S = await kolab.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 30 seconds.' }) });
  const B = await kolab.createNode(engineer, 'technical_binding', 'B', 'B');
  const b1 = await kolab.commit(engineer, B, { elements: els({ b1: 'Order worker.' }) });
  const W = await kolab.createNode(engineer, 'plan', 'W', 'W');
  const w1 = await kolab.commit(engineer, W, { elements: els({ w1: 'Build the order worker.', w2: 'Test it.' }) });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1' });
  await kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'w1', target: b1, targetElement: 'b1' });
  await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.' }) });
  expect((await marksOn(kolab, W)).map((m) => m.reason)).toStrictEqual(['upstream_dirty']);

  // Revising w2 leaves w1's mark; revising w1 settles it, though b1's own mark is still open.
  await kolab.commit(engineer, W, { elements: els({ w1: 'Build the order worker.', w2: 'Test it under load.' }) });
  expect((await marksOn(kolab, W)).length).toBe(1);
  await kolab.commit(engineer, W, { elements: els({ w1: 'Build the order worker for 10 s.', w2: 'Test it under load.' }) });
  expect(await marksOn(kolab, W)).toStrictEqual([]);
  expect((await marksOn(kolab, B)).map((m) => m.reason)).toStrictEqual(['changed']);
});
