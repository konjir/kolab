// A prototype and its spec kept in sync both ways (D79, KON3; W4.1 and W4.4): a spec change marks
// the screens that show it (kinds.test.ts), and a committed change to a screen asks the spec
// requirement it shows, routed to product, like any other divergence. Either can come first, and
// a change on both sides neither loops nor asks twice.
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { els, marksOn, setup } from '@konjir/engine/testing';
import type { VersionRow } from '@konjir/types';

/** The kolab's spec, and a prototype whose screens show its requirements, each linked by equivalence. */
async function specAndPrototype() {
  const ctx = await setup();
  const { kolab, product } = ctx;
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  const s1 = await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.', R2: 'Orders ship in a day.' }) });
  await kolab.createNode(product, 'prototype', 'Orders screens', 'orders-ui');
  const p1 = await kolab.commit(product, 'orders-ui', { elements: els({
    cancel: 'https://example.com/orders/cancel', track: 'https://example.com/orders/track', about: 'https://example.com/about' }) });
  await kolab.link(product, { kind: 'equivalence', source: p1, sourceElement: 'cancel', target: s1, targetElement: 'R1' });
  await kolab.link(product, { kind: 'equivalence', source: p1, sourceElement: 'track', target: s1, targetElement: 'R2' });
  return { ...ctx, s1, p1 };
}

const screens = (o: Record<string, string> = {}) => els({
  cancel: 'https://example.com/orders/cancel', track: 'https://example.com/orders/track', about: 'https://example.com/about', ...o });

/** Every question Kolab raised for a screen: where it was asked, the screen that waits, its state. */
async function screenQuestions(kolab: Kolab) {
  return (await kolab.db.query<{ id: string; node: string; element_id: string | null; layer: string; from_element_id: string; state: string; question: string; answer: string | null; answered_by: string | null }>(
    `select q.id, n.name as node, q.element_id, v.layer, q.from_element_id, q.state, q.question, q.answer, q.answered_by
       from query q join version v on v.id = q.version_id join node n on n.id = v.node_id
      where q.raised_by is null and q.invalidation_id is null and q.from_version_id is not null order by q.id`)).rows;
}

const on = async (kolab: Kolab, node: string) => (await marksOn(kolab, node)).map((m) => [m.element_id, m.reason]).sort();

test('a committed change to a screen asks the requirement it shows, routed to product, naming the screen, the requirement and the change; unlinked and unchanged screens ask nothing (D79, KON3, W4.4)', async () => {
  const { kolab, product, engineer } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({
    cancel: 'https://example.com/orders/cancel-v2', about: 'https://example.com/about-us' }) });

  const qs = await screenQuestions(kolab);
  expect(qs.map((q) => [q.node, q.element_id, q.layer, q.from_element_id, q.state])).toStrictEqual([['orders', 'R1', 'functional', 'cancel', 'open']]);
  expect(qs[0].question).toBe('Screen kj:orders-ui@2#cancel changed, and it shows kj:orders@1#R1 (an equivalence link, D79): '
    + 'it said "https://example.com/orders/cancel" and now says "https://example.com/orders/cancel-v2". '
    + 'If the spec should say what the screen now shows, amend kj:orders@1#R1, which settles this; otherwise answer, and the answer reaches the screen to change it back.');
  // Routed to product: the functional layer's queue holds it, the technical layer's doesn't.
  expect((await kolab.queriesFor(product, { layer: 'functional', state: 'open' })).map((q) => q.address)).toStrictEqual(['kj:orders@1#R1']);
  expect(await kolab.queriesFor(engineer, { layer: 'technical', state: 'open' })).toStrictEqual([]);
  // Nothing is marked while it waits: an open question blocks nothing.
  expect(await on(kolab, 'orders-ui')).toStrictEqual([]);
  expect(await on(kolab, 'orders')).toStrictEqual([]);
});

test('answering settles it the way any question does: the screen gets the answer as a query_answered mark, and revising the screen to it asks nothing again (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: 'https://example.com/orders/cancel-v2' }) });
  const [q] = await screenQuestions(kolab);
  await kolab.answerQuery(product, q.id, 'No: cancelling stays on the order page.');
  expect((await screenQuestions(kolab)).map((x) => [x.state, x.answered_by])).toStrictEqual([['answered', 'alice']]);
  const marks = await marksOn(kolab, 'orders-ui');
  expect(marks.map((m) => [m.element_id, m.reason])).toStrictEqual([['cancel', 'query_answered']]);
  expect(marks[0].note).toMatch(/kj:orders#R1: you asked "Screen kj:orders-ui@2#cancel changed.*answered: "No: cancelling stays on the order page\."/);

  // The screen goes back: that revision settles the mark and follows the spec, so it asks nothing.
  await kolab.commit(product, 'orders-ui', { elements: screens() });
  expect(await on(kolab, 'orders-ui')).toStrictEqual([]);
  expect((await screenQuestions(kolab)).map((x) => x.state)).toStrictEqual(['answered']);
});

test('a spec version that amends the requirement settles the question, and its change marks the screen once; the screen revised to follow it asks nothing (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: 'https://example.com/orders/cancel-anytime' }) });
  // Product agrees, and amends the spec: no answer needed.
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled at any time.', R2: 'Orders ship in a day.' }) });
  expect((await screenQuestions(kolab)).map((x) => [x.state, x.answered_by, x.answer])).toStrictEqual([
    ['answered', 'kolab', 'settled: orders@2 amends R1, and that change marks the screen against it']]);
  // The forward half: the spec's change marks the screen that shows it, once, and nothing else.
  expect(await on(kolab, 'orders-ui')).toStrictEqual([['cancel', 'changed']]);
  // The screen confirms it holds against the new text by a revision: that follows the spec, so no new question.
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: 'https://example.com/orders/cancel-anytime-v2' }) });
  expect(await on(kolab, 'orders-ui')).toStrictEqual([]);
  expect(await screenQuestions(kolab)).toHaveLength(1);
  // A spec change to another requirement settles nothing of this screen's.
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: 'https://example.com/orders/cancel-v3' }) });
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled at any time.', R2: 'Orders ship in two days.' }) });
  expect((await screenQuestions(kolab)).map((x) => x.state)).toStrictEqual(['answered', 'open']);
  expect(await on(kolab, 'orders-ui')).toStrictEqual([['track', 'changed']]);
});

test('both sides changing at once neither loops nor asks twice: the spec\'s change came first, so the screen is marked and asks nothing (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  // The screen's draft is open while the spec commits a change to the requirement it shows.
  const draft = await kolab.draft(product, 'orders-ui', { elements: screens({ cancel: 'https://example.com/orders/cancel-v2' }) });
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled until they ship.', R2: 'Orders ship in a day.' }) });
  expect(await on(kolab, 'orders-ui')).toStrictEqual([['cancel', 'changed']]);
  expect((await kolab.submit(product, draft)).ok).toBe(true);
  // The screen changed too, but the spec spoke first: no question. Its draft was written before the
  // spec's change, so it hasn't addressed it, and the screen keeps its mark to reconcile against R1.
  expect(await screenQuestions(kolab)).toStrictEqual([]);
  expect(await on(kolab, 'orders-ui')).toStrictEqual([['cancel', 'changed']]);
  expect(await on(kolab, 'orders')).toStrictEqual([]);
});

test('the screen changing again before the answer withdraws its first question and asks afresh; a cascade run again asks nothing more (D79, W4.4, W1.8)', async () => {
  const { kolab, product } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: 'https://example.com/orders/cancel-v2' }) });
  const p3 = await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: 'https://example.com/orders/cancel-v3' }) });
  expect((await screenQuestions(kolab)).map((x) => [x.state, x.answer])).toStrictEqual([
    ['withdrawn', 'withdrawn: kj:orders-ui@3#cancel changed the screen again, and asks afresh'], ['open', null]]);
  // The cascade's step, run again for the same version, finds the question it asked.
  const again = kolab as unknown as { screensAskSpec(v: VersionRow): Promise<void> };
  await again.screensAskSpec(await kolab.version(p3));
  expect(await screenQuestions(kolab)).toHaveLength(2);
});

test('a new screen, a removed one, a link declared with the change, and a screen with no equivalence link to the spec ask nothing (D79, W4.4)', async () => {
  const { kolab, product, s1 } = await specAndPrototype();
  // A new screen, linked as it is made.
  await kolab.commit(product, 'orders-ui', { elements: screens({ refund: 'https://example.com/refund' }) });
  // A screen changed with its link declared in the same version: linking reconciles the two.
  const p3 = await kolab.draft(product, 'orders-ui', {
    elements: screens({ refund: 'https://example.com/refund-v2', about: 'https://example.com/about-v2' }),
    links: [{ kind: 'equivalence', sourceElement: 'about', target: s1, targetElement: 'R2' }] });
  expect((await kolab.submit(product, p3)).ok).toBe(true);
  // A removed screen.
  await kolab.commit(product, 'orders-ui', { elements: els({ cancel: 'https://example.com/orders/cancel', about: 'https://example.com/about-v2' }) });
  // A dependency, not an equivalence, from the screen to the spec.
  await kolab.createNode(product, 'prototype', 'Sketch', 'sketch');
  const k1 = await kolab.commit(product, 'sketch', { elements: els({ K1: 'https://example.com/sketch' }) });
  await kolab.link(product, { kind: 'dependency', source: k1, sourceElement: 'K1', target: s1, targetElement: 'R1' });
  await kolab.commit(product, 'sketch', { elements: els({ K1: 'https://example.com/sketch-v2' }) });
  expect(await screenQuestions(kolab)).toStrictEqual([]);
});

test('Kolab\'s own rebase of a prototype derived from the spec asks nothing (D79, KON3, W4.4)', async () => {
  const { kolab, product, s1 } = await specAndPrototype();
  await kolab.createNode(product, 'prototype', 'Derived screens', 'derived');
  const d1 = await kolab.commit(product, 'derived', { parent: s1, deltas: [{ kind: 'add', element: 'S1', text: 'https://example.com/derived' }] });
  await kolab.link(product, { kind: 'equivalence', source: d1, sourceElement: 'R1', target: s1, targetElement: 'R1' });
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled until they ship.', R2: 'Orders ship in a day.' }) });
  await kolab.drainOutbox();
  expect((await kolab.latestCommitted('derived'))!.seq).toBe(2);
  expect(await screenQuestions(kolab)).toStrictEqual([]);
});

test('a screen that shows another kolab\'s requirement asks its own kolab\'s product layer instead, as a layer leak does: questions stay in their kolab (D79, TEN12, LNK8)', async () => {
  const { kolab, product } = await setup();
  await kolab.createKolab('eu', { owner: 'test-org' });
  await kolab.grant('eu', 'carol', 'write', { layers: ['functional'] });
  await kolab.grant('eu', 'alice', 'read');
  const carol = await kolab.openSession('carol', 'product', { kolab: 'eu' });
  await kolab.createNode(carol, 'spec', 'Orders in the EU', 'orders-eu');
  const e1 = await kolab.commit(carol, 'orders-eu', { elements: els({ EU1: 'Prices include VAT.' }) });
  await kolab.createNode(product, 'prototype', 'EU screens', 'eu-ui');
  const p1 = await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price' }) });
  await kolab.link(product, { kind: 'equivalence', source: p1, sourceElement: 'price', target: e1, targetElement: 'EU1' });
  await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price-ex-vat' }) });

  const qs = await screenQuestions(kolab);
  expect(qs.map((q) => [q.node, q.element_id, q.layer, q.from_element_id, q.state])).toStrictEqual([['eu-ui', 'price', 'functional', 'price', 'open']]);
  expect(qs[0].question).toMatch(/^Screen kj:eu-ui@2#price changed, and it shows kj:eu\/orders-eu@1#EU1, which is in another kolab/);
  // Nothing reaches the other kolab's queue.
  expect(await kolab.queriesFor(carol, { layer: 'functional', state: 'open' })).toStrictEqual([]);
  expect((await kolab.queriesFor(product, { layer: 'functional', state: 'open' })).map((q) => q.address)).toStrictEqual(['kj:eu-ui@2#price']);
});
