import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, els } from './helpers.js';

/**
 * spec S:  R1  R2
 *           |   |
 * binding:  b1  b2         (element -> element)
 *           |   |
 * wbs:      w1  w2         (element -> element)
 *           |   |
 * packages: WP1 WP2        (whole package -> wbs element)
 *           |   |
 * impls:    I1  I2         (whole impl -> whole package)
 *  plus a diamond: I1 also depends directly on binding b1.
 */
async function chain() {
  const ctx = await setup();
  const { hub, product, engineer } = ctx;
  const S = await hub.createNode(product, 'functional_spec', 'Checkout', 'S');
  const s1 = await hub.commit(product, S, { elements: els({ R1: 'Checkout within 30 seconds.', R2: 'Carts can be saved.' }) });

  const B = await hub.createNode(engineer, 'technical_binding', 'Binding', 'B');
  const b = await hub.commit(engineer, B, { elements: els({ b1: 'Order worker', b2: 'Cart table' }) });
  const W = await hub.createNode(engineer, 'wbs', 'WBS', 'W');
  const w = await hub.commit(engineer, W, { elements: els({ w1: 'Build order worker', w2: 'Build cart table' }) });
  const link = (source: string, sourceElement: string | undefined, target: string, targetElement?: string) =>
    hub.link(engineer, { kind: 'dependency', source, sourceElement, target, targetElement });

  await link(b, 'b1', s1, 'R1');
  await link(b, 'b2', s1, 'R2');
  await link(w, 'w1', b, 'b1');
  await link(w, 'w2', b, 'b2');
  const pk: Record<string, string> = {}, im: Record<string, string> = {};
  for (const i of [1, 2]) {
    const P = await hub.createNode(engineer, 'work_package', `WP${i}`, `WP${i}`);
    pk[i] = await hub.commit(engineer, P, { elements: els({ t: `Task ${i}` }) });
    await link(pk[i], undefined, w, `w${i}`);
    const I = await hub.createNode(engineer, 'implementation', `I${i}`, `I${i}`);
    im[i] = await hub.commit(engineer, I, { elements: els({ code: `module ${i}` }) });
    await link(im[i], undefined, pk[i]);
  }
  await link(im[1], undefined, b, 'b1'); // the diamond
  return { ...ctx, S, B, b, w, pk, im };
}

test('one spec edit dirties exactly its own lineage, once per version, through a diamond', async () => {
  const { hub, product, S, b, w, pk, im } = await chain();
  await hub.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.', R2: 'Carts can be saved.' }) });

  const marks = await hub.openMarks();
  const direct = marks.filter((m) => m.reason === 'changed');
  assert.deepEqual(direct.map((m) => [m.version_id, m.element_id]), [[b, 'b1']]);

  const dirtyVersions = new Set(marks.map((m) => m.version_id));
  assert.deepEqual(dirtyVersions, new Set([b, w, pk[1], im[1]]));
  assert.ok(!dirtyVersions.has(pk[2]) && !dirtyVersions.has(im[2]), 'the R2 lineage stays clean');
  assert.equal(marks.filter((m) => m.version_id === im[1]).length, 1, 'diamond reaches I1 once');
});

test('clearing the direct mark ("still holds") re-pins the edge and clears what it caused', async () => {
  const { hub, product, engineer, S } = await chain();
  await hub.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.', R2: 'Carts can be saved.' }) });
  const direct = (await hub.openMarks()).find((m) => m.reason === 'changed')!;
  await hub.clear(engineer, direct.id);
  assert.deepEqual(await hub.openMarks(), []);

  // The edge now points at v2 with v2's fingerprint: the same edit doesn't re-fire.
  await hub.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.', R2: 'Carts can be saved, and shared.' }) });
  const after = await hub.openMarks();
  assert.ok(after.every((m) => m.element_id !== 'b1'));
});

test('re-versioning a dirty dependent carries its marks forward instead of dropping them', async () => {
  const { hub, product, engineer, S, B, w } = await chain();
  await hub.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.', R2: 'Carts can be saved.' }) });
  // The engineer edits b2 (unrelated to the open mark) while b1's mark is open.
  const b2v = await hub.commit(engineer, B, { elements: els({ b1: 'Order worker', b2: 'Cart table, partitioned' }) });
  const direct = (await hub.openMarks()).filter((m) => m.reason === 'changed');
  assert.deepEqual(direct.map((m) => [m.version_id, m.element_id]).sort(), [
    [b2v, 'b1'],   // b1's mark followed B to its new version
    [w, 'w2'],     // and the b2 edit itself correctly dirtied w2
  ].sort());
});

test('a content-identical upstream commit is a pointer bump, not a mark', async () => {
  const { hub, product, S } = await chain();
  await hub.commit(product, S, { elements: els({ R1: 'Checkout   within 30 seconds.', R2: 'Carts can be saved.' }) });
  assert.deepEqual(await hub.openMarks(), [], 'whitespace-only change normalizes away');
});

test('editing a marked element in a later version addresses its mark; leaving it untouched does not', async () => {
  const { hub, product, engineer, S, B } = await chain();
  await hub.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.', R2: 'Carts can be saved, and shared.' }) });
  assert.deepEqual((await hub.openMarks()).filter((m) => m.reason === 'changed').map((m) => m.element_id).sort(), ['b1', 'b2']);

  // Rewrite b1 in response; leave b2 alone.
  const b2v = await hub.commit(engineer, B, { deltas: [{ kind: 'override', element: 'b1', text: 'Order worker, 8s budget' }] });
  const open = await hub.openMarks();
  const onB = open.filter((m) => m.version_id === b2v);
  assert.deepEqual(onB.map((m) => [m.element_id, m.reason]), [['b2', 'changed']], 'b1 addressed; b2 still open');
  // The spec-triggered marks downstream of b1 cleared with it. What's open
  // downstream of b1 now is the consequence of b1's own new text.
  const downstreamOfB1 = open.filter((m) => m.element_id === 'w1' || (m.version_id !== b2v && m.element_id === null && m.reason === 'changed'));
  assert.ok(downstreamOfB1.length > 0);
  assert.ok(downstreamOfB1.every((m) => m.triggered_by === b2v), 'only the new binding text triggers them');
});
