import { expect, test } from '@jest/globals';
import { formatAddress, parseAddress, resolveSpan } from '@konjir/address';
import { setup, els, rejection, TEST_KOLAB, thrown } from '@konjir/engine/testing';

test('address grammar round-trips at every granularity', () => {
  for (const s of [
    'kj:spec-checkout',
    'kj:spec-checkout@7',
    'kj:spec-checkout@7#R1',
    'kj:spec-checkout#R1~q({"exact":"30 seconds","prefix":"within "})',
  ]) expect(formatAddress(parseAddress(s))).toBe(s);
  expect(thrown(() => parseAddress('kj:spec~q({"exact":"x"})'))).toMatch(/needs an element/);
});

test('span resolution: exact is clean even if moved, near is fuzzy, gone is orphan', () => {
  const sel = { exact: 'save a cart for later' };
  expect(resolveSpan('Users can save a cart for later and share it.', sel).status).toBe('exact');
  expect(resolveSpan('Users can save the cart for later.', sel).status).toBe('fuzzy');
  expect(resolveSpan('Users can export receipts.', sel).status).toBe('orphan');
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
  expect(marks.map((m) => [m.element_id, m.reason]).sort()).toStrictEqual([['b1', 'changed'], ['b3', 'changed']]);

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
  expect(marks.map((m) => [m.element_id, m.reason]).sort()).toStrictEqual([['b1', 'changed'], ['b2', 'fuzzy_reanchor'], ['b3', 'changed'], ['b4', 'orphaned']]);
  await kolab.close();
});

test('D42: a verbatim copy whose context no longer agrees is marked; a moved quote with its context is not', async () => {
  const { kolab, product, engineer } = await setup();
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout', 'S');
  const s1 = await kolab.commit(product, spec, {
    elements: els({
      R1: 'Alpha said save the cart now. Beta said save the cart later.',
      R2: 'Refunds go to the original card within 5 days.',
      R3: 'Beta said save the cart later.',
    }),
  });
  const binding = await kolab.createNode(engineer, 'technical_binding', 'Checkout on Postgres', 'B');
  const b = await kolab.commit(engineer, binding, { elements: els({ b1: 'Beta', b2: 'Any', b3: 'Refunds', b4: 'Moved' }) });
  const link = (src: string, tgt: string, selector: { exact: string; prefix?: string; suffix?: string }) =>
    kolab.link(engineer, { kind: 'dependency', source: b, sourceElement: src, target: s1, targetElement: tgt, selector });
  await link('b1', 'R1', { exact: 'save the cart', prefix: 'Beta said', suffix: 'later.' });
  await link('b2', 'R1', { exact: 'save the cart' });
  await link('b3', 'R2', { exact: 'the original card', prefix: 'Refunds go to', suffix: 'within 5 days' });
  await link('b4', 'R3', { exact: 'save the cart', prefix: 'Beta said', suffix: 'later.' });

  await kolab.commit(product, spec, {
    elements: els({
      // Beta's words were edited; Alpha's verbatim copy is no longer the quoted statement.
      R1: 'Alpha said save the cart now. Beta said save a cart later.',
      // Moved, with its context: clean.
      R2: 'For card payments, refunds go to the original card within 5 days of the request.',
      // Only a verbatim copy is left, in another statement: a change.
      R3: 'Alpha said save the cart now.',
    }),
  });
  const marks = await kolab.openMarks();
  expect(marks.map((m) => [m.element_id, m.reason]).sort()).toStrictEqual([['b1', 'fuzzy_reanchor'], ['b4', 'fuzzy_reanchor']]);
  await kolab.close();
});

test('a link whose quoted context does not match is refused, with a selector that would', async () => {
  const { kolab, product, engineer } = await setup();
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout', 'S');
  const s1 = await kolab.commit(product, spec, {
    elements: els({ R1: 'Alpha said save the cart now. Beta said save a cart later.' }),
  });
  const binding = await kolab.createNode(engineer, 'technical_binding', 'Checkout on Postgres', 'B');
  const b = await kolab.commit(engineer, binding, { elements: els({ b1: 'Beta' }) });
  const link = (selector: { exact: string; prefix?: string; suffix?: string }) =>
    kolab.link(engineer, { kind: 'dependency', source: b, sourceElement: 'b1', target: s1, targetElement: 'R1', selector });

  const message = await link({ exact: 'save the cart', prefix: 'Beta said', suffix: 'later.' }).then(() => '', (e: Error) => e.message);
  expect(message).toMatch(/does not resolve exactly \(fuzzy\)/);
  expect(message).toContain('"save a cart"');
  const suggested = /(kj:\S+~q\(.*\))$/.exec(message)![1];
  const { selector } = parseAddress(suggested);
  expect(selector).toStrictEqual({ exact: 'save a cart', prefix: 'cart now. Beta said', suffix: 'later.' });
  await expect(link(selector!)).resolves.toEqual(expect.any(String));

  // One word of context is too little to tell (D42): refused, with several words to quote instead.
  const weak = await link({ exact: 'save a cart', prefix: 'said' }).then(() => '', (e: Error) => e.message);
  expect(weak).toMatch(/does not resolve exactly \(fuzzy\).*too little to tell/);
  await expect(link(parseAddress(/(kj:\S+~q\(.*\))$/.exec(weak)![1]).selector!)).resolves.toEqual(expect.any(String));

  const long = await link({ exact: 'save a cart '.repeat(100) }).then(() => '', (e: Error) => e.message);
  expect(long).toMatch(/the quote is 1199 characters; quote at most 1000/);

  const gone = await link({ exact: 'export receipts' }).then(() => '', (e: Error) => e.message);
  expect(gone).toMatch(/does not resolve exactly \(orphan\).*konjir_read_node/);
  await kolab.close();
});

test('resolve() follows the address scope and floats to the latest committed version', async () => {
  const { kolab, product } = await setup();
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout', 'S');
  await kolab.commit(product, spec, { elements: els({ R1: 'Timeout is 30 seconds.' }) });
  await kolab.commit(product, spec, { elements: els({ R1: 'Timeout is 10 seconds.' }) });
  // Inside its kolab the short form is enough; the full form names the kolab too (DAT11).
  const pinned = await kolab.resolve(`kj:${TEST_KOLAB}/S@1#R1`, { session: product });
  const floating = await kolab.resolve('kj:S#R1', { session: product });
  expect(pinned.status === 'ok' && pinned.content).toBe('Timeout is 30 seconds.');
  expect(floating.status === 'ok' && floating.content).toBe('Timeout is 10 seconds.');
  expect((await kolab.resolve('kj:S#R9', { session: product })).status).toBe('orphan');
  expect((await kolab.resolve('kj:S@9#R1', { system: TEST_KOLAB })).status).toBe('orphan');
  expect(await rejection(kolab.resolve('kj:T#R1', { session: product }))).toMatch(/no node T in kolab test/);
  await kolab.close();
});
