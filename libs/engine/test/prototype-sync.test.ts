// A prototype and its spec kept in sync both ways (D79, KON3; W4.1 and W4.4): a spec change marks
// the screens that show it (kinds.test.ts), and a committed change to a screen asks the spec
// requirement it shows, routed to product, like any other divergence. Either can come first: a
// question settles when the spec's change marks the screen, and a screen that follows the spec, or
// goes back, asks nothing. Each test that shows something asks nothing also shows, beside it, the
// same kind of edit that does ask.
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
  const p1 = await kolab.commit(product, 'orders-ui', { elements: screens() });
  await kolab.link(product, { kind: 'equivalence', source: p1, sourceElement: 'cancel', target: s1, targetElement: 'R1' });
  await kolab.link(product, { kind: 'equivalence', source: p1, sourceElement: 'track', target: s1, targetElement: 'R2' });
  return { ...ctx, s1, p1 };
}

const CANCEL = 'https://example.com/orders/cancel';
function screens(o: Record<string, string> = {}, parents: Record<string, string> = {}) {
  return els({ cancel: CANCEL, track: 'https://example.com/orders/track', about: 'https://example.com/about', ...o }, parents);
}
const spec = (o: Record<string, string> = {}, parents: Record<string, string> = {}) =>
  els({ R1: 'Orders can be cancelled.', R2: 'Orders ship in a day.', ...o }, parents);

/** Every question Kolab raised for a screen: where it was asked, the screen that waits, its state. */
async function screenQuestions(kolab: Kolab) {
  return (await kolab.db.query<{ id: string; node: string; element_id: string | null; layer: string; from_element_id: string; state: string; question: string; answer: string | null; answered_by: string | null }>(
    `select q.id, n.name as node, q.element_id, v.layer, q.from_element_id, q.state, q.question, q.answer, q.answered_by
       from query q join version v on v.id = q.version_id join node n on n.id = v.node_id
      where q.raised_by is null and q.invalidation_id is null and q.from_version_id is not null order by q.id`)).rows;
}
/** The open ones, as [screen, node asked, element asked]. */
const open = async (kolab: Kolab) => (await screenQuestions(kolab)).filter((q) => q.state === 'open').map((q) => [q.from_element_id, q.node, q.element_id]);
const marks = async (kolab: Kolab, node: string) => (await marksOn(kolab, node)).map((m) => [m.element_id, m.reason]).sort();

/** The cascade's step that asks, run again for version `id` (W1.8), as a retried cascade runs it. */
async function askAgain(kolab: Kolab, id: string) {
  const k = kolab as unknown as { changedSince(v: VersionRow): Promise<unknown>; screensAskSpec(v: VersionRow, c: unknown): Promise<void> };
  const v = await kolab.version(id);
  await k.screensAskSpec(v, await k.changedSince(v));
}

test('a committed change to a screen asks the requirement it shows, routed to product, naming the screen, the requirement and the change; unlinked and unchanged screens ask nothing (D79, KON3, W4.4)', async () => {
  const { kolab, product, engineer } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2`, about: 'https://example.com/about-us' }) });

  const qs = await screenQuestions(kolab);
  expect(qs.map((q) => [q.node, q.element_id, q.layer, q.from_element_id, q.state])).toStrictEqual([['orders', 'R1', 'functional', 'cancel', 'open']]);
  expect(qs[0].question).toBe('Screen kj:orders-ui@2#cancel changed, and it shows kj:orders@1#R1 (an equivalence link, D79): '
    + `it said "${CANCEL}" and now says "${CANCEL}-v2". `
    + 'If the spec should say what the screen now shows, amend kj:orders@1#R1, which settles this; otherwise answer, and the answer reaches the screen to change it back.');
  // Routed to product: the functional layer's queue holds it, the technical layer's doesn't.
  expect((await kolab.queriesFor(product, { layer: 'functional', state: 'open' })).map((q) => q.address)).toStrictEqual(['kj:orders@1#R1']);
  expect(await kolab.queriesFor(engineer, { layer: 'technical', state: 'open' })).toStrictEqual([]);
  // Nothing is marked while it waits: an open question blocks nothing.
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([]);
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
});

test('answering settles it the way any question does: the screen gets the answer as a query_answered mark; going back asks nothing, and a new change asks again (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2` }) });
  const [q] = await screenQuestions(kolab);
  await kolab.answerQuery(product, q.id, 'No: cancelling stays on the order page.');
  expect((await screenQuestions(kolab)).map((x) => [x.state, x.answered_by])).toStrictEqual([['answered', 'alice']]);
  const ms = await marksOn(kolab, 'orders-ui');
  expect(ms.map((m) => [m.element_id, m.reason])).toStrictEqual([['cancel', 'query_answered']]);
  expect(ms[0].note).toMatch(/kj:orders#R1: you asked "Screen kj:orders-ui@2#cancel changed.*answered: "No: cancelling stays on the order page\."/);

  // The screen goes back: that revision settles the mark and follows the spec, so it asks nothing.
  await kolab.commit(product, 'orders-ui', { elements: screens() });
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([]);
  expect(await open(kolab)).toStrictEqual([]);
  // A change after that is a new divergence, and asks.
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v3` }) });
  expect(await open(kolab)).toStrictEqual([['cancel', 'orders', 'R1']]);
});

test('a spec version whose change marks the screen settles its question, and marks it once; the screen revised to follow asks nothing; a change to another requirement settles nothing (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-anytime` }) });
  // Product agrees, and amends the spec: no answer needed.
  await kolab.commit(product, 'orders', { elements: spec({ R1: 'Orders can be cancelled at any time.' }) });
  expect((await screenQuestions(kolab)).map((x) => [x.state, x.answered_by, x.answer])).toStrictEqual([
    ['answered', 'kolab', 'settled: kj:orders@2#R1 changed, and that marks the screen against it (changed)']]);
  // The forward half: the spec's change marks the screen that shows it, once, and nothing else.
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([['cancel', 'changed']]);
  // The screen revised in answer to that mark follows the spec: no new question.
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-anytime-v2` }) });
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([]);
  expect(await open(kolab)).toStrictEqual([]);
  // The next change asks; a spec change to another requirement leaves it open.
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v3` }) });
  await kolab.commit(product, 'orders', { elements: spec({ R1: 'Orders can be cancelled at any time.', R2: 'Orders ship in two days.' }) });
  expect(await open(kolab)).toStrictEqual([['cancel', 'orders', 'R1']]);
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([['track', 'changed']]);
  // The spec removing R1 orphans the screen's link, and settles it too.
  await kolab.commit(product, 'orders', { elements: els({ R2: 'Orders ship in two days.' }) });
  expect(await open(kolab)).toStrictEqual([]);
  expect((await screenQuestions(kolab)).at(-1)!.answer).toBe('settled: kj:orders@4#R1 no longer holds what the screen shows, and that marks the screen against it (orphaned)');
});

test('only a spec change that marks the screen settles its question: a move of the requirement, or an edit around quoted words that still stand, re-pins the link and leaves it open (D79, W4.4)', async () => {
  const { kolab, product, s1 } = await specAndPrototype();
  // A screen that shows a span of R2, by quote.
  const p2 = await kolab.commit(product, 'orders-ui', { elements: screens({ ship: 'https://example.com/ship' }) });
  await kolab.link(product, { kind: 'equivalence', source: p2, sourceElement: 'ship', target: s1, targetElement: 'R2', selector: { exact: 'ship in a day' } });
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2`, ship: 'https://example.com/ship-v2' }) });
  expect(await open(kolab)).toStrictEqual([['cancel', 'orders', 'R1'], ['ship', 'orders', 'R2']]);
  // R1 moves under a new section, unchanged; R2 changes around the quoted words.
  await kolab.commit(product, 'orders', { elements: spec({ S: 'Orders.', R2: 'Orders ship in a day, by post.' }, { R1: 'S' }) });
  expect(await open(kolab)).toStrictEqual([['cancel', 'orders', 'R1'], ['ship', 'orders', 'R2']]);
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([['track', 'changed']]);
  // The quoted words themselves change: that marks the screen, and settles its question; R1 changes, and settles the other.
  await kolab.commit(product, 'orders', { elements: spec({ S: 'Orders.', R1: 'Orders can be cancelled until they ship.', R2: 'Orders ship in two days, by post.' }, { R1: 'S' }) });
  expect(await open(kolab)).toStrictEqual([]);
  expect((await marks(kolab, 'orders-ui')).filter(([e]) => e !== 'track')).toStrictEqual([['cancel', 'changed'], ['ship', 'fuzzy_reanchor']]);
});

test('a screen linked to the spec as a whole asks the spec, and any change that marks the link settles it (D79, W4.4)', async () => {
  const { kolab, product, s1 } = await specAndPrototype();
  const p2 = await kolab.commit(product, 'orders-ui', { elements: screens({ home: 'https://example.com/' }) });
  await kolab.link(product, { kind: 'equivalence', source: p2, sourceElement: 'home', target: s1 });
  await kolab.commit(product, 'orders-ui', { elements: screens({ home: 'https://example.com/v2' }) });
  expect(await open(kolab)).toStrictEqual([['home', 'orders', null]]);
  expect((await screenQuestions(kolab))[0].question).toMatch(/^Screen kj:orders-ui@3#home changed, and it shows kj:orders@1 \(an equivalence link/);
  await kolab.commit(product, 'orders', { elements: spec({ R2: 'Orders ship in two days.' }) });
  expect(await open(kolab)).toStrictEqual([]);
  expect((await screenQuestions(kolab))[0].answer).toBe('settled: kj:orders@2 changed, and that marks the screen against it (changed)');
});

test('both sides changing at once neither loops nor asks twice: the spec\'s change came first, so the screen is marked and asks nothing (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  // The screens' draft is open while the spec commits a change to the requirement one shows.
  const draft = await kolab.draft(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2`, track: 'https://example.com/orders/track-v2' }) });
  await kolab.commit(product, 'orders', { elements: spec({ R1: 'Orders can be cancelled until they ship.' }) });
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([['cancel', 'changed']]);
  expect((await kolab.submit(product, draft)).ok).toBe(true);
  // The cancel screen changed too, but the spec spoke first: no question. Its draft was written
  // before the spec's change, so it hasn't addressed it, and the screen keeps its mark. The track
  // screen, whose requirement didn't move, asks.
  expect(await open(kolab)).toStrictEqual([['track', 'orders', 'R2']]);
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([['cancel', 'changed']]);
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
});

test('a screen changed again before the answer withdraws its first question and asks afresh, and one that goes back withdraws it and asks nothing; a cascade run again does nothing more (D79, W4.4, W1.8)', async () => {
  const { kolab, product } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2` }) });
  const p3 = await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v3` }) });
  expect((await screenQuestions(kolab)).map((x) => [x.state, x.answer])).toStrictEqual([
    ['withdrawn', 'withdrawn: kj:orders-ui@3#cancel changed the screen again, and asks afresh'], ['open', null]]);
  await askAgain(kolab, p3);
  expect(await screenQuestions(kolab)).toHaveLength(2);

  // Back to what it said before it asked (p1's text): withdrawn, and nothing asked.
  const p4 = await kolab.commit(product, 'orders-ui', { elements: screens() });
  expect((await screenQuestions(kolab)).map((x) => [x.state, x.answer])).toStrictEqual([
    ['withdrawn', 'withdrawn: kj:orders-ui@3#cancel changed the screen again, and asks afresh'],
    ['withdrawn', 'withdrawn: kj:orders-ui@4#cancel went back to what the screen said before it asked']]);
  await askAgain(kolab, p4);
  expect(await screenQuestions(kolab)).toHaveLength(2);
});

test('a move of a screen, a new screen, a link declared with the change and a dependency link ask nothing, while an equivalence screen rewritten beside them asks (D79, W4.4)', async () => {
  const { kolab, product, s1 } = await specAndPrototype();
  // Moved (under about), with the same text; and a new screen. Beside them, track is rewritten.
  await kolab.commit(product, 'orders-ui', { elements: screens({ refund: 'https://example.com/refund', track: 'https://example.com/orders/track-v2' }, { cancel: 'about' }) });
  expect(await open(kolab)).toStrictEqual([['track', 'orders', 'R2']]);
  // A screen changed with its link declared in the same version: linking reconciles the two.
  const p3 = await kolab.draft(product, 'orders-ui', {
    elements: screens({ refund: 'https://example.com/refund', track: 'https://example.com/orders/track-v2', about: 'https://example.com/about-v2' }, { cancel: 'about' }),
    links: [{ kind: 'equivalence', sourceElement: 'about', target: s1, targetElement: 'R2' }] });
  expect((await kolab.submit(product, p3)).ok).toBe(true);
  expect(await open(kolab)).toStrictEqual([['track', 'orders', 'R2']]);
  // Once linked, its next change asks.
  await kolab.commit(product, 'orders-ui', { elements: screens({ refund: 'https://example.com/refund', track: 'https://example.com/orders/track-v2', about: 'https://example.com/about-v3' }, { cancel: 'about' }) });
  expect(await open(kolab)).toStrictEqual([['track', 'orders', 'R2'], ['about', 'orders', 'R2']]);
  // A dependency, not an equivalence, from a screen to the spec asks nothing.
  await kolab.createNode(product, 'prototype', 'Sketch', 'sketch');
  const k1 = await kolab.commit(product, 'sketch', { elements: els({ K1: 'https://example.com/sketch', K2: 'https://example.com/sketch-2' }) });
  await kolab.link(product, { kind: 'dependency', source: k1, sourceElement: 'K1', target: s1, targetElement: 'R1' });
  await kolab.link(product, { kind: 'equivalence', source: k1, sourceElement: 'K2', target: s1, targetElement: 'R1' });
  await kolab.commit(product, 'sketch', { elements: els({ K1: 'https://example.com/sketch-v2', K2: 'https://example.com/sketch-2-v2' }) });
  expect((await open(kolab)).filter(([, n]) => n === 'orders').map(([s]) => s)).toStrictEqual(['track', 'about', 'K2']);
});

test('removing a screen, or unlinking it, withdraws its open question; another screen\'s stays open (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2`, track: 'https://example.com/orders/track-v2', about: 'https://example.com/about-v2' }) });
  expect(await open(kolab)).toStrictEqual([['cancel', 'orders', 'R1'], ['track', 'orders', 'R2']]);
  // cancel is removed.
  await kolab.commit(product, 'orders-ui', { elements: els({ track: 'https://example.com/orders/track-v2', about: 'https://example.com/about-v2' }) });
  expect(await open(kolab)).toStrictEqual([['track', 'orders', 'R2']]);
  expect((await screenQuestions(kolab))[0].answer).toBe('withdrawn: orders-ui@3 removes the screen');
  // track's link is removed.
  const d = await kolab.draft(product, 'orders-ui', { elements: els({ track: 'https://example.com/orders/track-v2', about: 'https://example.com/about-v2' }),
    unlink: [{ sourceElement: 'track', target: 'kj:orders#R2' }] });
  expect((await kolab.submit(product, d)).ok).toBe(true);
  expect(await open(kolab)).toStrictEqual([]);
  expect((await screenQuestions(kolab))[1].answer).toBe('withdrawn: orders-ui@4 no longer links the screen to what it asked');
  // An answer can no longer come.
});

test('Kolab\'s own rebase of a prototype derived from the spec asks nothing; its author\'s override of the same screen does (D79, KON3, W4.4)', async () => {
  const { kolab, product, s1 } = await specAndPrototype();
  await kolab.createNode(product, 'prototype', 'Derived screens', 'derived');
  const d1 = await kolab.commit(product, 'derived', { parent: s1, deltas: [{ kind: 'add', element: 'S1', text: 'https://example.com/derived' }] });
  await kolab.link(product, { kind: 'equivalence', source: d1, sourceElement: 'R1', target: s1, targetElement: 'R1' });
  await kolab.commit(product, 'orders', { elements: spec({ R1: 'Orders can be cancelled until they ship.' }) });
  await kolab.drainOutbox();
  expect((await kolab.latestCommitted('derived'))!.seq).toBe(2);
  expect(await open(kolab)).toStrictEqual([]);
  // The rebase marked the link; once the author settles it, their own override asks.
  for (const m of await marksOn(kolab, 'derived')) await kolab.clear(product, m.id);
  await kolab.commit(product, 'derived', { deltas: [{ kind: 'override', element: 'R1', text: 'https://example.com/derived/cancel' }] });
  expect(await open(kolab)).toStrictEqual([['R1', 'orders', 'R1']]);
});

/** A prototype in the test kolab whose screen shows a requirement of kolab eu's spec. */
async function acrossKolabs() {
  const ctx = await setup();
  const { kolab, product } = ctx;
  await kolab.createKolab('eu', { owner: 'test-org' });
  await kolab.grant('eu', 'carol', 'write', { layers: ['functional'] });
  await kolab.grant('eu', 'alice', 'read');
  const carol = await kolab.openSession('carol', 'product', { kolab: 'eu' });
  await kolab.createNode(carol, 'spec', 'Orders in the EU', 'orders-eu');
  const e1 = await kolab.commit(carol, 'orders-eu', { elements: els({ EU1: 'Prices include VAT.', EU2: 'Returns take 14 days.' }) });
  await kolab.createNode(product, 'prototype', 'EU screens', 'eu-ui');
  const p1 = await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price' }) });
  await kolab.link(product, { kind: 'equivalence', source: p1, sourceElement: 'price', target: e1, targetElement: 'EU1' });
  await kolab.link(product, { kind: 'equivalence', source: p1, sourceElement: 'price', target: e1, targetElement: 'EU2' });
  return { ...ctx, carol };
}

test('a screen that shows another kolab\'s requirements asks its own kolab\'s product layer, once, on the screen itself, as a layer leak does: questions stay in their kolab (D79, TEN12, LNK8)', async () => {
  const { kolab, product, carol } = await acrossKolabs();
  await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price-ex-vat' }) });
  const qs = await screenQuestions(kolab);
  expect(qs.map((q) => [q.node, q.element_id, q.layer, q.from_element_id, q.state])).toStrictEqual([['eu-ui', 'price', 'functional', 'price', 'open']]);
  expect(qs[0].question).toMatch(/^Screen kj:eu-ui@2#price changed, and it shows 2 requirements in another kolab it is linked to \(an equivalence link, D79\)/);
  // Its words name nothing of the other kolab: a reader here may not read it (D49, D53).
  expect(qs[0].question).not.toMatch(/orders-eu|EU1|EU2|kj:eu\//);
  // Nothing reaches the other kolab's queue.
  expect(await kolab.queriesFor(carol, { layer: 'functional', state: 'open' })).toStrictEqual([]);
  expect((await kolab.queriesFor(product, { layer: 'functional', state: 'open' })).map((q) => q.address)).toStrictEqual(['kj:eu-ui@2#price']);
});

test('across kolabs, a screen that obeys the answer to its question asks nothing again, and its next change asks (D79, W4.4)', async () => {
  const { kolab, product } = await acrossKolabs();
  await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price-ex-vat' }) });
  const [q] = await screenQuestions(kolab);
  await kolab.answerQuery(product, q.id, 'No: the EU spec keeps VAT in.');
  expect(await marks(kolab, 'eu-ui')).toStrictEqual([['price', 'query_answered']]);
  await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price' }) });
  expect(await marks(kolab, 'eu-ui')).toStrictEqual([]);
  expect(await open(kolab)).toStrictEqual([]);
  await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price-v3' }) });
  expect(await open(kolab)).toStrictEqual([['price', 'eu-ui', 'price']]);
});

test('across kolabs, the other kolab\'s change that marks the screen settles its question; one that marks nothing of it doesn\'t (D79, W4.4, LNK8)', async () => {
  const { kolab, product, carol } = await acrossKolabs();
  await kolab.createNode(carol, 'prototype', 'Unrelated', 'eu-sketch');
  await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price-ex-vat' }) });
  // A change in eu that marks nothing of the screen: a new requirement.
  await kolab.commit(carol, 'orders-eu', { elements: els({ EU1: 'Prices include VAT.', EU2: 'Returns take 14 days.', EU3: 'Ship to the EU only.' }) });
  await kolab.drainOutbox();
  expect(await open(kolab)).toStrictEqual([['price', 'eu-ui', 'price']]);
  // eu amends EU1: its rebase job marks the screen's link, and settles the question.
  await kolab.commit(carol, 'orders-eu', { elements: els({ EU1: 'Prices may exclude VAT.', EU2: 'Returns take 14 days.', EU3: 'Ship to the EU only.' }) });
  await kolab.drainOutbox();
  expect(await marks(kolab, 'eu-ui')).toStrictEqual([['price', 'changed']]);
  expect(await open(kolab)).toStrictEqual([]);
  expect((await screenQuestions(kolab))[0].answer).toBe('settled: a change in the other kolab marks the screen against a requirement it shows there (changed)');
});

test('a screen that goes back to what it said before an answered question asks nothing, though its answer\'s mark was cleared by hand, or its revert was drafted before the answer (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  // Cleared by hand, then reverted.
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2` }) });
  await kolab.answerQuery(product, (await screenQuestions(kolab))[0].id, 'Change it back.');
  const [m] = await marksOn(kolab, 'orders-ui');
  await kolab.clear(product, m.id);
  await kolab.commit(product, 'orders-ui', { elements: screens() });
  expect(await open(kolab)).toStrictEqual([]);
  // A change to something new after that asks.
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v3` }) });
  expect(await open(kolab)).toStrictEqual([['cancel', 'orders', 'R1']]);
  expect((await screenQuestions(kolab)).at(-1)!.question).toMatch(new RegExp(`it said "${CANCEL}" and now says "${CANCEL}-v3"`));

  // A revert drafted before the answer, committed after: asks nothing; the answer's mark stays,
  // since the draft predates it.
  const revert = await kolab.draft(product, 'orders-ui', { elements: screens() });
  await kolab.answerQuery(product, (await screenQuestions(kolab)).at(-1)!.id, 'Change it back.');
  expect((await kolab.submit(product, revert)).ok).toBe(true);
  expect(await open(kolab)).toStrictEqual([]);
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([['cancel', 'query_answered']]);
});

test('only the answer to the screen\'s own question about a requirement counts as obeyed: an answered ask of another requirement from the screen doesn\'t (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  // Someone asks about R2 from the cancel screen, which shows R1; the answer marks the screen.
  const asked = await kolab.raiseQuery(product, 'kj:orders#R2', 'Does tracking show the courier?', { from: 'kj:orders-ui#cancel' });
  await kolab.answerQuery(product, asked, 'Yes.');
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([['cancel', 'query_answered']]);
  // The screen's next rewrite settles that mark, and still asks R1.
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2` }) });
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([]);
  expect(await open(kolab)).toStrictEqual([['cancel', 'orders', 'R1']]);
});

test('across kolabs, only the answer to the screen\'s own question counts as obeyed: an answered ask from the screen about the prototype doesn\'t (D79, W4.4)', async () => {
  const { kolab, product } = await acrossKolabs();
  await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price', help: 'https://example.com/help' }) });
  const asked = await kolab.raiseQuery(product, 'kj:eu-ui#help', 'Is help in every language?', { from: 'kj:eu-ui#price' });
  await kolab.answerQuery(product, asked, 'Yes.');
  expect(await marks(kolab, 'eu-ui')).toStrictEqual([['price', 'query_answered']]);
  await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price-ex-vat', help: 'https://example.com/help' }) });
  expect(await open(kolab)).toStrictEqual([['price', 'eu-ui', 'price']]);
});

test('across kolabs, only a requirement the question asks about settles it, and unlinking one of them leaves it asking about the rest (D79, W4.4)', async () => {
  const { kolab, product, carol } = await acrossKolabs();
  const e1 = (await kolab.latestCommitted('orders-eu'))!.id;
  await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price-ex-vat' }) });
  expect((await screenQuestions(kolab))[0].question).toMatch(/shows 2 requirements in another kolab it is linked to/);
  // Unlinking EU2: the question asks about EU1 alone.
  const d = await kolab.draft(product, 'eu-ui', { elements: els({ price: 'https://example.com/price-ex-vat' }), unlink: [{ sourceElement: 'price', target: 'kj:eu/orders-eu#EU2' }] });
  expect((await kolab.submit(product, d)).ok).toBe(true);
  expect(await open(kolab)).toStrictEqual([['price', 'eu-ui', 'price']]);
  expect((await screenQuestions(kolab))[0].question).toMatch(/shows a requirement in another kolab it is linked to/);
  // A link added after the question (EU2 again, then a change to it) settles nothing.
  const live = (await kolab.latestCommitted('eu-ui'))!.id;
  await kolab.link(product, { kind: 'equivalence', source: live, sourceElement: 'price', target: e1, targetElement: 'EU2' });
  await kolab.commit(carol, 'orders-eu', { elements: els({ EU1: 'Prices include VAT.', EU2: 'Returns take 30 days.' }) });
  await kolab.drainOutbox();
  expect(await marks(kolab, 'eu-ui')).toStrictEqual([['price', 'changed']]);
  expect(await open(kolab)).toStrictEqual([['price', 'eu-ui', 'price']]);
  // EU1 changes: that settles it.
  await kolab.commit(carol, 'orders-eu', { elements: els({ EU1: 'Prices may exclude VAT.', EU2: 'Returns take 30 days.' }) });
  await kolab.drainOutbox();
  expect(await open(kolab)).toStrictEqual([]);
});

test('across kolabs, unlinking every requirement the question asks about withdraws it (D79, W4.4)', async () => {
  const { kolab, product } = await acrossKolabs();
  await kolab.commit(product, 'eu-ui', { elements: els({ price: 'https://example.com/price-ex-vat' }) });
  const d = await kolab.draft(product, 'eu-ui', { elements: els({ price: 'https://example.com/price-ex-vat' }),
    unlink: [{ sourceElement: 'price', target: 'kj:eu/orders-eu#EU1' }, { sourceElement: 'price', target: 'kj:eu/orders-eu#EU2' }] });
  expect((await kolab.submit(product, d)).ok).toBe(true);
  expect(await open(kolab)).toStrictEqual([]);
  expect((await screenQuestions(kolab))[0].answer).toBe('withdrawn: eu-ui@3 no longer links the screen to what it asked');
});

test('probe A: an answer stands only while the spec still says what it said when asked; once the requirement changes, going back to the old text asks again (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  // Asked, answered "change it back", reverted; the spec then changes R1, the screen follows it,
  // and later goes back to the original text, which the spec no longer says.
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2` }) });
  await kolab.answerQuery(product, (await screenQuestions(kolab))[0].id, 'Change it back.');
  await kolab.commit(product, 'orders-ui', { elements: screens() });
  expect(await open(kolab)).toStrictEqual([]);
  await kolab.commit(product, 'orders', { elements: spec({ R1: 'Orders can be cancelled until they ship.' }) });
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([['cancel', 'changed']]);
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-until-shipped` }) });
  expect(await open(kolab)).toStrictEqual([]);
  await kolab.commit(product, 'orders-ui', { elements: screens() });
  expect(await open(kolab)).toStrictEqual([['cancel', 'orders', 'R1']]);
  expect((await screenQuestions(kolab)).at(-1)!.question).toContain(`it said "${CANCEL}-until-shipped" and now says "${CANCEL}"`);
});

test('probe A2: answered, then the spec changes and its marks are cleared by hand; the screen going back asks again (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2` }) });
  await kolab.answerQuery(product, (await screenQuestions(kolab))[0].id, 'Change it back.');
  await kolab.commit(product, 'orders', { elements: spec({ R1: 'Orders can be cancelled until they ship.' }) });
  for (const m of await marksOn(kolab, 'orders-ui')) await kolab.clear(product, m.id);
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([]);
  await kolab.commit(product, 'orders-ui', { elements: screens() });
  expect(await open(kolab)).toStrictEqual([['cancel', 'orders', 'R1']]);
});

test('probe B: an answer that quotes the screen\'s own answered question is not that question\'s answer, so a real divergence still asks (D79, W4.4)', async () => {
  const { kolab, product } = await specAndPrototype();
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v2` }) });
  await kolab.answerQuery(product, (await screenQuestions(kolab))[0].id, 'Change it back.');
  const [own] = await marksOn(kolab, 'orders-ui');
  await kolab.commit(product, 'orders-ui', { elements: screens() });
  // Someone asks about R2 from the screen, and the answer quotes the earlier mark's note.
  const asked = await kolab.raiseQuery(product, 'kj:orders#R2', 'What did product say last time?', { from: 'kj:orders-ui#cancel' });
  await kolab.answerQuery(product, asked, `It said: ${own.note}`);
  expect(await marks(kolab, 'orders-ui')).toStrictEqual([['cancel', 'query_answered']]);
  // A real rewrite settles that mark, and still asks R1.
  await kolab.commit(product, 'orders-ui', { elements: screens({ cancel: `${CANCEL}-v3` }) });
  expect(await open(kolab)).toStrictEqual([['cancel', 'orders', 'R1']]);
});
