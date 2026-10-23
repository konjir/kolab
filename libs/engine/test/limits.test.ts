// Size limits (W2.21, P13, D71): a draft, a question, an answer, a note and the rest are refused
// past their limit, before anything is written, with a message that names the limit.
import { expect, test } from '@jest/globals';
import {
  MAX_ASKS_PER_HOUR, MAX_DRAFTS_PER_HOUR, MAX_ELEMENT_TEXT, MAX_ELEMENTS, MAX_EVIDENCE, MAX_EVIDENCE_TEXT, MAX_FINDINGS, MAX_TEXT, MAX_TITLE,
  MAX_VERSION_BYTES, RATE_WINDOW_MS,
} from '@konjir/types';
import { els, people, rejection, setup } from '@konjir/engine/testing';

const long = (n: number) => 'x'.repeat(n);
const count = (n: number) => n.toLocaleString('en');

async function orders() {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  await kolab.createNode(engineer, 'technical_binding', 'Orders on Postgres', 'orders-pg');
  await kolab.commit(engineer, 'orders-pg', { elements: els({ b1: 'Cancelling sets a flag.' }) });
  const versions = async (node: string) => (await kolab.db.query(`select 1 from version where node_id = $1`, [node])).rows.length;
  return { ...ctx, versions };
}

test('a draft over a version\'s limits is refused, naming the limit, and writes nothing', async () => {
  const { kolab, product, versions } = await orders();
  const before = await versions('orders');
  const many = Array.from({ length: MAX_ELEMENTS + 1 }, (_, i) => ({ id: `R${i}`, text: `Requirement ${i}.` }));
  expect(await rejection(kolab.draft(product, 'orders', { elements: many })))
    .toBe(`LimitError: that draft sends ${count(MAX_ELEMENTS + 1)} elements; a version holds at most ${count(MAX_ELEMENTS)} elements. Split the node into several nodes`);
  expect(await rejection(kolab.draft(product, 'orders', { deltas: many.map((e) => ({ kind: 'add' as const, element: e.id, text: e.text })) })))
    .toMatch(new RegExp(`that draft sends ${count(MAX_ELEMENTS + 1)} changes`));
  expect(await rejection(kolab.draft(product, 'orders', { elements: [{ id: 'R1', text: long(MAX_ELEMENT_TEXT + 1) }] })))
    .toBe(`LimitError: element R1's text is ${count(MAX_ELEMENT_TEXT + 1)} characters; the limit is ${count(MAX_ELEMENT_TEXT)}. Shorten it`);
  // Each element within its limit, the whole over the version's: 70 elements of 8,000 characters.
  const big = Array.from({ length: Math.ceil(MAX_VERSION_BYTES / MAX_ELEMENT_TEXT) + 1 }, (_, i) => ({ id: `R${i}`, text: `${i} ${long(MAX_ELEMENT_TEXT - 10)}` }));
  expect(await rejection(kolab.draft(product, 'orders', { elements: big }))).toMatch(new RegExp(`KiB of text; the limit is ${MAX_VERSION_BYTES / 1024} KiB`));
  expect(await versions('orders')).toBe(before);
  // Characters, not bytes, for an element: 8,000 emoji is within its limit.
  await expect(kolab.draft(product, 'orders', { elements: [{ id: 'R1', text: '🙂'.repeat(MAX_ELEMENT_TEXT) }] })).resolves.toEqual(expect.any(String));
});

test('a question, a note, an answer, a review note and a finding over MAX_TEXT are refused', async () => {
  const { kolab, product, engineer } = await orders();
  expect(await rejection(kolab.raiseQuery(engineer, 'kj:orders#R1', long(MAX_TEXT + 1))))
    .toBe(`LimitError: the question is ${count(MAX_TEXT + 1)} characters; the limit is ${count(MAX_TEXT)}. Shorten it, or link to the detail by address`);
  expect(await rejection(kolab.raiseQuery(engineer, 'kj:orders#R1', long(MAX_TEXT + 1), { kind: 'note' }))).toMatch(/LimitError: the note is/);
  const q = await kolab.raiseQuery(engineer, 'kj:orders#R1', long(MAX_TEXT));
  expect(await rejection(kolab.answerQuery(product, q, long(MAX_TEXT + 1)))).toMatch(/LimitError: the answer is 4,001 characters; the limit is 4,000/);
  await kolab.answerQuery(product, q, long(MAX_TEXT));

  await people(kolab, 'dana', { layers: ['functional'] });
  const dana = await kolab.openSession('dana', 'product');
  const r = await kolab.submit(product, await kolab.draft(product, 'orders', { elements: els({ R1: 'Orders can be cancelled within a day.' }) }));
  expect(r.in_review).toBe(true);
  expect(await rejection(kolab.recordReview(dana, r.version, { verdict: 'request_changes', note: long(MAX_TEXT + 1) }))).toMatch(/LimitError: the review note is/);
  const finding = { kind: 'layer_leak' as const, elements: ['R1'], explanation: 'A day is an implementation detail.' };
  expect(await rejection(kolab.recordReview(dana, r.version, { verdict: 'approve', findings: Array(MAX_FINDINGS + 1).fill(finding) })))
    .toMatch(new RegExp(`LimitError: that verdict has ${MAX_FINDINGS + 1} findings; the limit is ${MAX_FINDINGS}`));
  expect(await rejection(kolab.recordReview(dana, r.version, { verdict: 'approve', findings: [{ ...finding, explanation: long(MAX_TEXT + 1) }] })))
    .toMatch(/LimitError: a finding's explanation is/);
  // Still in review: none of them was recorded.
  expect((await kolab.version(r.version)).state).toBe('in_review');
});

test('a case file\'s question, a claim, its evidence and a ruling over their limits are refused; a node\'s title too', async () => {
  const { kolab, product, engineer } = await orders();
  const open = (over: Partial<{ question: string; claim: string; evidence: string[] }>) => kolab.openCase(engineer, 'kj:orders#R1', {
    question: 'Can orders be cancelled?', claim: 'Not once shipped.', seeks: 'change_intent', evidence: ['a test run'], ...over,
  });
  expect(await rejection(open({ question: long(MAX_TEXT + 1) }))).toMatch(/LimitError: the question in dispute is 4,001 characters; the limit is 4,000/);
  expect(await rejection(open({ claim: long(MAX_TEXT + 1) }))).toMatch(/LimitError: your position's claim is/);
  expect(await rejection(open({ evidence: Array(MAX_EVIDENCE + 1).fill('a test run') }))).toMatch(new RegExp(`LimitError: a position cites at most ${MAX_EVIDENCE} pieces of evidence`));
  expect(await rejection(open({ evidence: [long(MAX_EVIDENCE_TEXT + 1)] }))).toMatch(/LimitError: evidence item 1 is 1,001 characters; the limit is 1,000/);
  expect(await rejection(kolab.rule(product, { address: 'kj:orders#R1', text: long(MAX_TEXT + 1), effect: 'keep_intent' }))).toMatch(/LimitError: the ruling is/);
  expect(await rejection(kolab.createNode(product, 'functional_spec', long(MAX_TITLE + 1), 'long'))).toMatch(new RegExp(`LimitError: the title is ${MAX_TITLE + 1} characters; the limit is ${MAX_TITLE}`));
});

test('an actor asks and drafts at most so many times an hour; the refusal names the limit and the wait, writes nothing, and holds no one else back', async () => {
  const { kolab, product, engineer } = await orders();
  expect(kolab.rates).toStrictEqual({ asks: MAX_ASKS_PER_HOUR, drafts: MAX_DRAFTS_PER_HOUR, windowMs: RATE_WINDOW_MS });
  Object.assign(kolab.rates, { asks: 3, drafts: 2 });
  const asked = async () => (await kolab.db.query(`select 1 from query`)).rows.length;
  // Questions and notes count alike.
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'Within a day of what?');
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'By whom?');
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'Going ahead with the order date.', { kind: 'note' });
  const before = await asked();
  const engineerId = (await kolab.sessionInfo(engineer)).actor;
  expect(await rejection(kolab.raiseQuery(engineer, 'kj:orders#R1', 'And refunds?')))
    .toBe(`LimitError: ${engineerId} raised 3 questions and notes in the last hour; the limit is 3 in an hour. Wait 60 minutes before asking again, or put several points in one question`);
  expect(await asked()).toBe(before);
  // Someone else still asks.
  await kolab.raiseQuery(product, 'kj:orders-pg#b1', 'Is the flag indexed?');

  // The product owner wrote one version already (orders' first); one more, then the limit.
  const productId = (await kolab.sessionInfo(product)).actor;
  await kolab.draft(product, 'orders', { elements: els({ R1: 'Orders can be cancelled within a day.' }) });
  const versions = async () => (await kolab.db.query(`select 1 from version`)).rows.length;
  const written = await versions();
  expect(await rejection(kolab.draft(product, 'orders', { elements: els({ R1: 'Orders can be cancelled within two days.' }) })))
    .toBe(`LimitError: ${productId} drafted 2 versions in the last hour; the limit is 2 in an hour. Wait 60 minutes before drafting again, or put several changes in one draft`);
  expect(await versions()).toBe(written);
  // The engineer, with one version, still drafts.
  await kolab.draft(engineer, 'orders-pg', { elements: els({ b1: 'Cancelling sets a flag and a time.' }) });

  // The window slides: once the oldest is more than an hour old, the next is let through.
  await kolab.db.query(`update query set created_at = created_at - interval '61 minutes' where raised_by = $1`, [engineerId]);
  await kolab.db.query(`update version set created_at = created_at - interval '61 minutes' where actor_id = $1`, [productId]);
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'And refunds?');
  await expect(kolab.draft(product, 'orders', { elements: els({ R1: 'Orders can be cancelled within two days.' }) })).resolves.toEqual(expect.any(String));
  // The wait the refusal names is how long until the oldest in the window leaves it.
  await kolab.db.query(`update query set created_at = now() - interval '50 minutes' where raised_by = $1 and question = 'And refunds?'`, [engineerId]);
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'Partial refunds?');
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'Store credit?');
  expect(await rejection(kolab.raiseQuery(engineer, 'kj:orders#R1', 'Gift cards?'))).toMatch(/Wait 10 minutes before asking again/);
});
