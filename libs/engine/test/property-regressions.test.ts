// Regressions for the four bugs W2.5's property tests (properties.test.ts) found, each the
// counterexample fast-check shrank to, written out by hand.
import { expect, test } from '@jest/globals';
import { els, marksOn, setup, textOf } from '@konjir/engine/testing';

test('a mark spreads downstream through a link that carries a mark of its own (LNK5)', async () => {
  const { kolab, product, engineer } = await setup();
  const S = await kolab.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 30 seconds.' }) });
  const B = await kolab.createNode(engineer, 'technical_binding', 'B', 'B');
  const b1 = await kolab.commit(engineer, B, { elements: els({ b1: 'Order worker.' }) });
  const W = await kolab.createNode(engineer, 'wbs', 'W', 'W');
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
  const V1 = await kolab.createNode(product, 'functional_spec', 'V1', 'V1');
  const v1 = await kolab.commit(product, V1, { parent: p1, deltas: [{ kind: 'add', element: 'X1', text: 'Chat is on.' }] });
  const V2 = await kolab.createNode(product, 'functional_spec', 'V2', 'V2');
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
