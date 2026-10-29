import { expect, test } from '@jest/globals';
import { setup, els } from '@konjir/engine/testing';

/**
 * spec S:     R1  R2
 *              |   |
 * binding B:  b1  b2        (element -> element)
 *              |   |
 * plan W:     w1  w2        (B's plan: element -> element)
 *
 * binding C:  c1  c2        (another binding of S, relying on B's elements: c1 -> b1, c2 -> b2)
 *              |   |
 * plan X:     x1  x2        (C's plan: a third hop)
 *  plus a diamond: binding D's d1 relies on both b1 and c1.
 */
async function chain() {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  const S = await kolab.createNode(product, 'spec', 'Checkout', 'S');
  const s1 = await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 30 seconds.', R2: 'Carts can be saved.' }) });

  const B = await kolab.createNode(engineer, 'binding', 'Binding', 'B');
  const b = await kolab.commit(engineer, B, { elements: els({ b1: 'Order worker', b2: 'Cart table' }) });
  const W = await kolab.createNode(engineer, 'binding', 'Plan', 'W');
  const w = await kolab.commit(engineer, W, { elements: els({ w1: 'Build order worker', w2: 'Build cart table' }) });
  const link = (source: string, sourceElement: string | undefined, target: string, targetElement?: string) =>
    kolab.link(engineer, { kind: 'dependency', source, sourceElement, target, targetElement });

  await link(b, 'b1', s1, 'R1');
  await link(b, 'b2', s1, 'R2');
  await link(w, 'w1', b, 'b1');
  await link(w, 'w2', b, 'b2');
  const C = await kolab.createNode(engineer, 'binding', 'Workers', 'C');
  const c = await kolab.commit(engineer, C, { elements: els({ c1: 'Order worker pool', c2: 'Cart archive' }) });
  await link(c, 'c1', b, 'b1');
  await link(c, 'c2', b, 'b2');
  const X = await kolab.createNode(engineer, 'binding', 'Workers plan', 'X');
  const x = await kolab.commit(engineer, X, { elements: els({ x1: 'Size the pool', x2: 'Archive carts' }) });
  await link(x, 'x1', c, 'c1');
  await link(x, 'x2', c, 'c2');
  const D = await kolab.createNode(engineer, 'binding', 'Dashboard', 'D');
  const d = await kolab.commit(engineer, D, { elements: els({ d1: 'Order dashboard' }) });
  await link(d, 'd1', b, 'b1');   // the diamond
  await link(d, 'd1', c, 'c1');
  return { ...ctx, S, B, b, w, c, x, d };
}

test('one spec edit dirties exactly its own lineage, once per version, through a diamond', async () => {
  const { kolab, product, S, b, w, c, x, d } = await chain();
  await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.', R2: 'Carts can be saved.' }) });

  const marks = await kolab.openMarks();
  const direct = marks.filter((m) => m.reason === 'changed');
  expect(direct.map((m) => [m.version_id, m.element_id])).toStrictEqual([[b, 'b1']]);

  const dirtyVersions = new Set(marks.map((m) => m.version_id));
  expect(dirtyVersions).toStrictEqual(new Set([b, w, c, x, d]));
  expect(marks.filter((m) => ['w2', 'c2', 'x2'].includes(m.element_id!))).toStrictEqual([]); // the R2 lineage stays clean
  expect(marks.filter((m) => m.version_id === d).length).toBe(1); // the diamond reaches d1 once
});

test('clearing the direct mark ("still holds") re-pins the edge and clears what it caused', async () => {
  const { kolab, product, engineer, S } = await chain();
  await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.', R2: 'Carts can be saved.' }) });
  const direct = (await kolab.openMarks()).find((m) => m.reason === 'changed')!;
  await kolab.clear(engineer, direct.id);
  expect(await kolab.openMarks()).toStrictEqual([]);

  // The edge now points at v2 with v2's fingerprint: the same edit doesn't re-fire.
  await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.', R2: 'Carts can be saved, and shared.' }) });
  const after = await kolab.openMarks();
  expect(after.every((m) => m.element_id !== 'b1')).toBeTruthy();
});

test('re-versioning a dirty dependent carries its marks forward instead of dropping them', async () => {
  const { kolab, product, engineer, S, B, w, c } = await chain();
  await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.', R2: 'Carts can be saved.' }) });
  // The engineer edits b2 (unrelated to the open mark) while b1's mark is open.
  const b2v = await kolab.commit(engineer, B, { elements: els({ b1: 'Order worker', b2: 'Cart table, partitioned' }) });
  const direct = (await kolab.openMarks()).filter((m) => m.reason === 'changed');
  expect(direct.map((m) => [m.version_id, m.element_id]).sort()).toStrictEqual([
    [b2v, 'b1'],   // b1's mark followed B to its new version
    [w, 'w2'],     // and the b2 edit itself correctly dirtied w2
    [c, 'c2'],     // and c2, which relies on it too
  ].sort());
});

test('a content-identical upstream commit is a pointer bump, not a mark', async () => {
  const { kolab, product, S } = await chain();
  await kolab.commit(product, S, { elements: els({ R1: 'Checkout   within 30 seconds.', R2: 'Carts can be saved.' }) });
  expect(await kolab.openMarks()).toStrictEqual([]); // whitespace-only change normalizes away
});

test('editing a marked element in a later version addresses its mark; leaving it untouched does not', async () => {
  const { kolab, product, engineer, S, B } = await chain();
  await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.', R2: 'Carts can be saved, and shared.' }) });
  expect((await kolab.openMarks()).filter((m) => m.reason === 'changed').map((m) => m.element_id).sort()).toStrictEqual(['b1', 'b2']);

  // Rewrite b1 in response; leave b2 alone.
  const b2v = await kolab.commit(engineer, B, { deltas: [{ kind: 'override', element: 'b1', text: 'Order worker, 8s budget' }] });
  const open = await kolab.openMarks();
  const onB = open.filter((m) => m.version_id === b2v);
  expect(onB.map((m) => [m.element_id, m.reason])).toStrictEqual([['b2', 'changed']]); // b1 addressed; b2 still open
  // The spec-triggered marks downstream of b1 cleared with it. What's open
  // downstream of b1 now is the consequence of b1's own new text.
  const downstreamOfB1 = open.filter((m) => m.element_id === 'w1' || (m.version_id !== b2v && m.element_id === null && m.reason === 'changed'));
  expect(downstreamOfB1.length > 0).toBeTruthy();
  expect(downstreamOfB1.every((m) => m.triggered_by === b2v)).toBeTruthy(); // only the new binding text triggers them
});
