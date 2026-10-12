import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAddress, parseAddress, resolveSpan } from '../src/address.js';
import { setup, els } from './helpers.js';

test('address grammar round-trips at every granularity', () => {
  for (const s of [
    'kj:spec-checkout',
    'kj:spec-checkout@7',
    'kj:spec-checkout@7#R1',
    'kj:spec-checkout#R1~q({"exact":"30 seconds","prefix":"within "})',
  ]) assert.equal(formatAddress(parseAddress(s)), s);
  assert.throws(() => parseAddress('kj:spec~q({"exact":"x"})'), /needs an element/);
});

test('span resolution: exact is clean even if moved, near is fuzzy, gone is orphan', () => {
  const sel = { exact: 'save a cart for later' };
  assert.equal(resolveSpan('Users can save a cart for later and share it.', sel).status, 'exact');
  assert.equal(resolveSpan('Users can save the cart for later.', sel).status, 'fuzzy');
  assert.equal(resolveSpan('Users can export receipts.', sel).status, 'orphan');
});

test('each edge goes dirty only when its own addressed scope changes', async () => {
  const { kolab, product, engineer } = await setup();
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout', 'S');
  const s1 = await kolab.commit(product, spec, {
    elements: els({
      R1: 'Checkout completes within 30 seconds of payment confirmation.',
      R2: 'Users can save a cart for later.',
      SEC: 'Payments',
      R3: 'Card payments are supported.',
      R4: 'Refunds go to the original payment method.',
      R5: 'Guest checkout is allowed.',
      R6: 'Prices show tax included.',
    }, { R3: 'SEC', R4: 'SEC' }),
  });

  const binding = await kolab.createNode(engineer, 'technical_binding', 'Checkout on Postgres', 'B');
  const b = await kolab.commit(engineer, binding, {
    elements: els({ b1: 'Order worker SLA', b2: 'Saved carts table', b3: 'Payments adapter', b4: 'Guest sessions', b6: 'Tax display' }),
  });
  const link = (src: string, tgt: string, selector?: { exact: string }) =>
    kolab.link(engineer, { kind: 'dependency', source: b, sourceElement: src, target: s1, targetElement: tgt, selector });
  await link('b1', 'R1');                                         // element scope
  await link('b2', 'R2', { exact: 'save a cart for later' });     // span scope
  await link('b3', 'SEC');                                        // section = element with children
  await link('b4', 'R5');
  await link('b6', 'R6');

  // v2: change R1; extend R2 around the quoted span; change a child of SEC.
  await kolab.commit(product, spec, {
    elements: els({
      R1: 'Checkout completes within 10 seconds of payment confirmation.',
      R2: 'Users can save a cart for later and share it.',
      SEC: 'Payments',
      R3: 'Card payments are supported.',
      R4: 'Refunds go to the original payment method within 5 days.',
      R5: 'Guest checkout is allowed.',
      R6: 'Prices show tax included.',
    }, { R3: 'SEC', R4: 'SEC' }),
  });
  let marks = await kolab.openMarks();
  assert.deepEqual(marks.map((m) => [m.element_id, m.reason]).sort(), [['b1', 'changed'], ['b3', 'changed']]);

  // v3: reword the quoted span slightly; delete R5. R6 untouched throughout.
  await kolab.commit(product, spec, {
    elements: els({
      R1: 'Checkout completes within 10 seconds of payment confirmation.',
      R2: 'Users can save the cart for later and share it.',
      SEC: 'Payments',
      R3: 'Card payments are supported.',
      R4: 'Refunds go to the original payment method within 5 days.',
      R6: 'Prices show tax included.',
    }, { R3: 'SEC', R4: 'SEC' }),
  });
  marks = await kolab.openMarks();
  assert.deepEqual(marks.map((m) => [m.element_id, m.reason]).sort(),
    [['b1', 'changed'], ['b2', 'fuzzy_reanchor'], ['b3', 'changed'], ['b4', 'orphaned']]);
  await kolab.close();
});

test('resolve() follows the address scope and floats to the latest committed version', async () => {
  const { kolab, product } = await setup();
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout', 'S');
  await kolab.commit(product, spec, { elements: els({ R1: 'Timeout is 30 seconds.' }) });
  await kolab.commit(product, spec, { elements: els({ R1: 'Timeout is 10 seconds.' }) });
  const pinned = await kolab.resolve('kj:S@1#R1');
  const floating = await kolab.resolve('kj:S#R1');
  assert.equal(pinned.status === 'ok' && pinned.content, 'Timeout is 30 seconds.');
  assert.equal(floating.status === 'ok' && floating.content, 'Timeout is 10 seconds.');
  assert.equal((await kolab.resolve('kj:S#R9')).status, 'orphan');
  await kolab.close();
});
