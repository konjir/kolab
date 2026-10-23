// Size limits (W2.21, P13, D71): a draft, a question, an answer, a note and the rest are refused
// past their limit, before anything is written, with a message that names the limit; and a person
// and their agents ask and draft at most so many times an hour, together.
import { expect, test } from '@jest/globals';
import {
  MAX_ASKS_PER_HOUR, MAX_DRAFTS_PER_HOUR, MAX_ELEMENT_TEXT, MAX_ELEMENTS, MAX_EVIDENCE, MAX_EVIDENCE_TEXT, MAX_FINDINGS, MAX_TEXT, MAX_TITLE,
  MAX_KOLAB_TITLE, MAX_NAME, MAX_VERSION_BYTES, RATE_WINDOW_MS,
} from '@konjir/types';
import { els, people, rejection, setup, TEST_KOLAB } from '@konjir/engine/testing';
import { ADMIN_DOER } from '@konjir/types';

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
  expect(await rejection(open({ evidence: ['a test run', long(MAX_TEXT + 1)] }))).toMatch(/LimitError: evidence item 2 is 4,001 characters; the limit is 1,000/);
  expect(await rejection(kolab.rule(product, { address: 'kj:orders#R1', text: long(MAX_TEXT + 1), effect: 'keep_intent' }))).toMatch(/LimitError: the ruling is/);
  expect(await rejection(kolab.createNode(product, 'functional_spec', long(MAX_TITLE + 1), 'long'))).toMatch(new RegExp(`LimitError: the title is ${MAX_TITLE + 1} characters; the limit is ${MAX_TITLE}`));
});

test('a person and their agents ask and draft at most so many times an hour, together; the refusal names the limit and the wait, writes nothing, and holds no one else back', async () => {
  const { kolab, product, engineer } = await orders();
  expect(kolab.rates).toStrictEqual({ asks: MAX_ASKS_PER_HOUR, drafts: MAX_DRAFTS_PER_HOUR, windowMs: RATE_WINDOW_MS });
  Object.assign(kolab.rates, { asks: 4, drafts: 2 });
  const asked = async () => (await kolab.db.query(`select 1 from query`)).rows.length;
  // Bob's agent shares Bob's budget: questions and notes, his and his agent's, count alike.
  await kolab.addActor('bob-claude', { owner: 'bob' });
  await kolab.grant(TEST_KOLAB, 'bob-claude', 'write', { layers: ['technical'] });
  const agent = await kolab.openSession('bob-claude', 'engineer', { by: ADMIN_DOER });
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'Within a day of what?');
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'By whom?');
  await kolab.raiseQuery(agent, 'kj:orders#R1', 'Going ahead with the order date.', { kind: 'note' });
  await kolab.raiseQuery(agent, 'kj:orders#R1', 'And the time zone?');
  const before = await asked();
  expect(await rejection(kolab.raiseQuery(engineer, 'kj:orders#R1', 'And refunds?')))
    .toBe('LimitError: bob and bob\'s agents raised 4 questions and notes in the last hour; the limit is 4 in an hour, shared by a person and their agents. Wait 60 minutes before asking again, or put several points in one question');
  expect(await rejection(kolab.raiseQuery(agent, 'kj:orders#R1', 'And refunds?')))
    .toMatch(/^LimitError: bob-claude, with the rest of bob's agents and bob, raised 4 questions and notes in the last hour/);
  // A new agent of Bob's shares it too: making agents doesn't raise the limit.
  await kolab.addActor('bob-codex', { owner: 'bob' });
  await kolab.grant(TEST_KOLAB, 'bob-codex', 'write', { layers: ['technical'] });
  expect(await rejection(kolab.raiseQuery(await kolab.openSession('bob-codex', 'engineer', { by: ADMIN_DOER }), 'kj:orders#R1', 'And refunds?'))).toMatch(/LimitError/);
  expect(await asked()).toBe(before);
  // Someone else still asks.
  await kolab.raiseQuery(product, 'kj:orders-pg#b1', 'Is the flag indexed?');

  // Alice wrote one version already (orders' first); one more, then the limit.
  await kolab.draft(product, 'orders', { elements: els({ R1: 'Orders can be cancelled within a day.' }) });
  const versions = async () => (await kolab.db.query(`select 1 from version`)).rows.length;
  const written = await versions();
  expect(await rejection(kolab.draft(product, 'orders', { elements: els({ R1: 'Orders can be cancelled within two days.' }) })))
    .toBe('LimitError: alice and alice\'s agents drafted 2 versions in the last hour; the limit is 2 in an hour, shared by a person and their agents. Wait 60 minutes before drafting again, or put several changes in one draft');
  expect(await versions()).toBe(written);
  // A ruling the admin applies, written as Alice, isn't her draft: it isn't limited, and doesn't count.
  await kolab.applyRuling('orders', { elements: els({ R1: 'Orders can be cancelled within a week.' }) }, { id: 'D71', actor: 'alice' });
  const counted = async (actor: string) => (await kolab.db.query<{ r_count: number }>(`select * from kj_rate_take($1, 'draft', $2)`, [actor, RATE_WINDOW_MS])).rows[0].r_count;
  expect(await counted('alice')).toBe(2);
  // Bob, with one version, still drafts.
  await kolab.draft(engineer, 'orders-pg', { elements: els({ b1: 'Cancelling sets a flag and a time.' }) });

  // The window slides: once the oldest is more than an hour old, the next is let through.
  await kolab.db.query(`update query set created_at = created_at - interval '61 minutes' where raised_by in ('bob', 'bob-claude')`);
  await kolab.db.query(`update version set created_at = created_at - interval '61 minutes' where actor_id = 'alice'`);
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'And refunds?');
  await expect(kolab.draft(product, 'orders', { elements: els({ R1: 'Orders can be cancelled within two days.' }) })).resolves.toEqual(expect.any(String));
  // The wait the refusal names is how long until the oldest in the window leaves it.
  await kolab.db.query(`update query set created_at = now() - interval '50 minutes' where raised_by = 'bob' and question = 'And refunds?'`);
  for (const q of ['Partial refunds?', 'Store credit?', 'Vouchers?']) await kolab.raiseQuery(agent, 'kj:orders#R1', q);
  expect(await rejection(kolab.raiseQuery(engineer, 'kj:orders#R1', 'Gift cards?'))).toMatch(/Wait 10 minutes before asking again/);
});

test('the limit holds when many ask and draft at once: each takes its turn in the database', async () => {
  const { kolab, engineer } = await orders();
  Object.assign(kolab.rates, { asks: 5 });
  const tries = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => kolab.raiseQuery(engineer, 'kj:orders#R1', `At once ${i}?`)));
  expect(tries.filter((t) => t.status === 'fulfilled')).toHaveLength(5);
  expect(tries.filter((t) => t.status === 'rejected').map((t) => String((t as PromiseRejectedResult).reason).split(':')[0])).toStrictEqual(Array(35).fill('LimitError'));
  expect((await kolab.db.query(`select 1 from query where raised_by = 'bob'`)).rows).toHaveLength(5);
  Object.assign(kolab.rates, { drafts: 3 });
  const drafts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => kolab.draft(engineer, 'orders-pg', { elements: els({ b1: `Take ${i}.` }) })));
  // Bob wrote orders-pg's first version: two more.
  expect(drafts.filter((t) => t.status === 'fulfilled')).toHaveLength(2);
  expect((await kolab.db.query(`select 1 from version where actor_id = 'bob'`)).rows).toHaveLength(3);
}, 120_000);

test('kolab titles count characters, and the admin\'s names and titles are capped too', async () => {
  const { kolab } = await orders();
  // 100 emoji is 100 characters: within a kolab's title.
  await kolab.makeOwnKolab('alice', 'alices', '🙂'.repeat(MAX_KOLAB_TITLE));
  expect(await rejection(kolab.makeOwnKolab('alice', 'alices2', '🙂'.repeat(MAX_KOLAB_TITLE + 1)))).toMatch(/a kolab's title is 1 to 100 characters/);
  expect(await rejection(kolab.createKolab('big', { owner: 'alice', title: long(MAX_KOLAB_TITLE + 1) }))).toMatch(/a kolab's title is at most 100 characters/);
  expect(await rejection(kolab.createKolab('k'.repeat(41), { owner: 'alice' }))).toMatch(/up to 40 lowercase letters/);
  expect(await rejection(kolab.addActor('a'.repeat(MAX_NAME + 1)))).toMatch(/LimitError: an actor's id is 101 characters; the limit is 100/);
  expect(await rejection(kolab.addActor('zed', { name: long(MAX_NAME + 1) }))).toMatch(/LimitError: an actor's name is/);
  expect(await rejection(kolab.addOrganization('o'.repeat(MAX_NAME + 1)))).toMatch(/LimitError: an account's id is/);
  expect(await rejection(kolab.addTeam('test-org', 't'.repeat(MAX_NAME + 1)))).toMatch(/LimitError: a team's name is/);
});
