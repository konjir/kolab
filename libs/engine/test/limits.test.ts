// Size limits (W2.21, P13, D71): a draft, a question, an answer, a note and the rest are refused
// past their limit, before anything is written, with a message that names the limit; and a person
// and their agents ask and draft at most so many times an hour, together.
import { expect, test } from '@jest/globals';
import {
  MAX_ASKS_PER_HOUR, MAX_DRAFTS_PER_HOUR, MAX_ORG_ASKS_PER_HOUR, MAX_ORG_DRAFTS_PER_HOUR, MAX_ELEMENT_TEXT, MAX_ELEMENTS, MAX_EVIDENCE, MAX_EVIDENCE_TEXT, MAX_FINDINGS, MAX_TEXT, MAX_TITLE,
  MAX_KOLAB_TITLE, MAX_NAME, MAX_VERSION_BYTES, RATE_WINDOW_MS,
} from '@konjir/types';
import { els, people, rejection, setup, TEST_KOLAB } from '@konjir/engine/testing';
import { ADMIN_DOER } from '@konjir/types';

const long = (n: number) => 'x'.repeat(n);
const count = (n: number) => n.toLocaleString('en');

async function orders() {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  await kolab.createNode(engineer, 'binding', 'Orders on Postgres', 'orders-pg');
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
  expect(await rejection(kolab.createNode(product, 'spec', long(MAX_TITLE + 1), 'long'))).toMatch(new RegExp(`LimitError: the title is ${MAX_TITLE + 1} characters; the limit is ${MAX_TITLE}`));
});

test('a person and their agents ask and draft at most so many times an hour, together; the refusal names the limit and the wait, writes nothing, and holds no one else back', async () => {
  const { kolab, product, engineer } = await orders();
  expect(kolab.rates).toStrictEqual({
    asks: MAX_ASKS_PER_HOUR, drafts: MAX_DRAFTS_PER_HOUR, orgAsks: MAX_ORG_ASKS_PER_HOUR, orgDrafts: MAX_ORG_DRAFTS_PER_HOUR, windowMs: RATE_WINDOW_MS,
  });
  // An organization's budget is five times a person's.
  expect([MAX_ORG_ASKS_PER_HOUR, MAX_ORG_DRAFTS_PER_HOUR]).toStrictEqual([5 * MAX_ASKS_PER_HOUR, 5 * MAX_DRAFTS_PER_HOUR]);
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
    .toBe('LimitError: alice and alice\'s agents drafted 2 versions in the last hour; the limit is 2 in an hour, shared by a person and their agents, and a draft counts when it is made, whatever becomes of it. Wait 60 minutes before drafting again, or put several changes in one draft');
  expect(await versions()).toBe(written);
  // A ruling the admin applies, written as Alice, isn't her draft: it isn't limited, and doesn't count.
  await kolab.applyRuling('orders', { elements: els({ R1: 'Orders can be cancelled within a week.' }) }, { id: 'D71', actor: 'alice' });
  // Asked with a limit of 0, kj_rate_take only counts: it holds nothing.
  const counted = async (actor: string) => (await kolab.db.query<{ r_count: number }>(`select * from kj_rate_take($1, 'draft', $2, 0, 0)`, [actor, RATE_WINDOW_MS])).rows[0].r_count;
  expect(await counted('alice')).toBe(2);
  // Bob, with one version, still drafts.
  await kolab.draft(engineer, 'orders-pg', { elements: els({ b1: 'Cancelling sets a flag and a time.' }) });

  // The window slides: once the oldest is more than an hour old, the next is let through.
  await kolab.db.query(`update rate_event set created_at = created_at - interval '61 minutes' where owner_id in ('bob', 'alice')`);
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'And refunds?');
  await expect(kolab.draft(product, 'orders', { elements: els({ R1: 'Orders can be cancelled within two days.' }) })).resolves.toEqual(expect.any(String));
  // The wait the refusal names is how long until the oldest in the window leaves it.
  await kolab.db.query(`update rate_event set created_at = now() - interval '50 minutes' where owner_id = 'bob' and kind = 'ask' and created_at > now() - interval '1 minute'`);
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
  // Drafts on twenty different nodes, so no node's lock puts them in turn: only the budget's does.
  for (let i = 0; i < 20; i++) await kolab.createNode(engineer, 'binding', `Part ${i}`, `part-${i}`);
  Object.assign(kolab.rates, { drafts: 3 });
  const drafts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => kolab.draft(engineer, `part-${i}`, { elements: els({ b1: `Take ${i}.` }) })));
  // Bob wrote orders-pg's first version: two more.
  expect(drafts.filter((t) => t.status === 'fulfilled')).toHaveLength(2);
  expect((await kolab.db.query(`select 1 from version where actor_id = 'bob'`)).rows).toHaveLength(3);
  // Every hold was used or given back: Bob's budget holds the 5 asks and the 3 drafts, and nothing is held.
  expect((await kolab.db.query(`select kind, count(*)::int as n from rate_event where not held and owner_id = 'bob' group by kind order by kind`)).rows)
    .toStrictEqual([{ kind: 'ask', n: 5 }, { kind: 'draft', n: 3 }]);
  expect((await kolab.db.query(`select 1 from rate_event where held`)).rows).toStrictEqual([]);
}, 120_000);

test('a call that fails after taking its place in the budget gives it back, and a hold its process never gave back stops counting', async () => {
  const { kolab, product, engineer } = await orders();
  Object.assign(kolab.rates, { asks: 2 });
  const draft = await kolab.draft(product, 'orders', { elements: els({ R1: 'Orders can be cancelled within a day.' }) });
  const seq = (await kolab.version(draft)).seq;
  // Asking about a draft is refused after the place was taken: the place is given back, so Bob still asks twice.
  for (let i = 0; i < 3; i++) expect(await rejection(kolab.raiseQuery(engineer, `kj:orders@${seq}#R1`, 'Within a day?'))).toMatch(/GateError: cannot ask about/);
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'Within a day of what?');
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'By whom?');
  expect(await rejection(kolab.raiseQuery(engineer, 'kj:orders#R1', 'And refunds?'))).toMatch(/LimitError: bob and bob's agents raised 2 questions/);
  expect((await kolab.db.query(`select 1 from rate_event where held`)).rows).toStrictEqual([]);
  // A hold left by a process that stopped mid-write counts for ten minutes, then not at all.
  Object.assign(kolab.rates, { asks: 3 });
  await kolab.db.query(`insert into rate_event(id, owner_id, kind) values ('ask:bob:lost', 'bob', 'ask')`);
  expect(await rejection(kolab.raiseQuery(engineer, 'kj:orders#R1', 'And refunds?'))).toMatch(/LimitError: bob and bob's agents raised 3 questions/);
  await kolab.db.query(`update rate_event set created_at = now() - interval '11 minutes' where id = 'ask:bob:lost'`);
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'And refunds?');
  expect((await kolab.db.query(`select id from rate_event where held or id = 'ask:bob:lost'`)).rows).toStrictEqual([]);
});

test('a draft counts against its author when it is made, whatever becomes of it: another writer submitting it frees nothing', async () => {
  const { kolab, engineer } = await orders();
  // Dave is a second writer on the technical layer: the colluding second account of the review's L1.
  await people(kolab, 'dave', { layers: ['technical'] });
  const dave = await kolab.openSession('dave', 'engineer', { by: ADMIN_DOER });
  for (let i = 0; i < 4; i++) await kolab.createNode(engineer, 'binding', `Part ${i}`, `part-${i}`);
  // Bob wrote orders-pg's first version; with a limit of 4, three more.
  Object.assign(kolab.rates, { drafts: 4 });
  const counted = async () => (await kolab.db.query<{ r_count: number }>(`select * from kj_rate_take('bob', 'draft', $1, 0, 0)`, [RATE_WINDOW_MS])).rows[0].r_count;
  const a = await kolab.draft(engineer, 'part-0', { elements: els({ b1: 'First.' }) });
  const b = await kolab.draft(engineer, 'part-1', { elements: els({ b1: 'Second.' }) });
  const c = await kolab.draft(engineer, 'part-2', { elements: els({ b1: 'Third.' }) });
  expect(await counted()).toBe(4);
  // Dave submits two of Bob's drafts, and approves neither: they wait in review. Bob abandons the third.
  expect((await kolab.submit(dave, a)).in_review).toBe(true);
  expect((await kolab.submit(dave, b)).in_review).toBe(true);
  await kolab.abandon(engineer, c);
  expect(await counted()).toBe(4);
  // Bob's budget is spent: a draft submitted by someone else, or abandoned, still counts.
  expect(await rejection(kolab.draft(engineer, 'part-3', { elements: els({ b1: 'Fourth.' }) })))
    .toMatch(/^LimitError: bob and bob's agents drafted 4 versions in the last hour; the limit is 4 in an hour/);
  // Approved or sent back, they still count.
  await kolab.recordReview(dave, a, { verdict: 'approve' });
  expect((await kolab.version(a)).state).toBe('committed');
  await kolab.recordReview(dave, b, { verdict: 'request_changes', note: 'Say which flag.' });
  expect(await counted()).toBe(4);
  // Dave's own budget is his: his submits took none of it, and he still drafts.
  await expect(kolab.draft(dave, 'part-3', { elements: els({ b1: 'Dave\'s.' }) })).resolves.toEqual(expect.any(String));
  expect((await kolab.db.query<{ r_count: number }>(`select * from kj_rate_take('dave', 'draft', $1, 0, 0)`, [RATE_WINDOW_MS])).rows[0].r_count).toBe(1);
});

test('an organization\'s agents share one budget of the organization\'s, with its own limit, apart from each person\'s', async () => {
  const { kolab, engineer } = await orders();
  // Two agents of the organization that owns the test kolab, and one of Bob's.
  await people(kolab, ['org-a', 'org-b'], { owner: 'test-org', layers: ['technical'] });
  await people(kolab, 'bob-claude', { owner: 'bob', layers: ['technical'] });
  const [orgA, orgB, bobs] = await Promise.all(['org-a', 'org-b', 'bob-claude'].map((id) => kolab.openSession(id, 'engineer', { by: ADMIN_DOER })));
  Object.assign(kolab.rates, { asks: 2, orgAsks: 5, drafts: 1, orgDrafts: 3 });
  // Past a person's limit of 2, the organization's agents go on, to the organization's 5, together.
  for (let i = 0; i < 3; i++) await kolab.raiseQuery(orgA, 'kj:orders#R1', `From a, ${i}?`);
  for (let i = 0; i < 2; i++) await kolab.raiseQuery(orgB, 'kj:orders#R1', `From b, ${i}?`);
  expect(await rejection(kolab.raiseQuery(orgB, 'kj:orders#R1', 'One more?')))
    .toBe('LimitError: org-b, with the rest of organization test-org\'s agents, raised 5 questions and notes in the last hour; the limit is 5 in an hour, shared by an organization\'s agents. Wait 60 minutes before asking again, or put several points in one question');
  expect(await rejection(kolab.raiseQuery(orgA, 'kj:orders#R1', 'One more?'))).toMatch(/^LimitError: org-a, with the rest of organization test-org's agents, raised 5/);
  // A person's budget is apart from it, and still a person's: Bob and his agent ask twice.
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'From Bob?');
  await kolab.raiseQuery(bobs, 'kj:orders#R1', 'From Bob\'s agent?');
  expect(await rejection(kolab.raiseQuery(bobs, 'kj:orders#R1', 'Again?'))).toMatch(/^LimitError: bob-claude, with the rest of bob's agents and bob, raised 2 .* the limit is 2 in an hour, shared by a person and their agents/);
  // Drafts the same way: the organization's 3, across its agents, counted when made.
  for (let i = 0; i < 3; i++) await kolab.createNode(engineer, 'binding', `Part ${i}`, `part-${i}`);
  await kolab.draft(orgA, 'part-0', { elements: els({ b1: 'A.' }) });
  await kolab.draft(orgB, 'part-1', { elements: els({ b1: 'B.' }) });
  await kolab.draft(orgA, 'part-2', { elements: els({ b1: 'C.' }) });
  expect(await rejection(kolab.draft(orgB, 'part-0', { elements: els({ b1: 'D.' }) })))
    .toMatch(/^LimitError: org-b, with the rest of organization test-org's agents, drafted 3 versions in the last hour; the limit is 3 in an hour, shared by an organization's agents/);
  // Lifting the organization's limit lifts only the organization's.
  Object.assign(kolab.rates, { orgDrafts: Infinity });
  await expect(kolab.draft(orgB, 'part-0', { elements: els({ b1: 'D.' }) })).resolves.toEqual(expect.any(String));
  expect(await rejection(kolab.draft(engineer, 'part-1', { elements: els({ b1: 'Bob.' }) }))).toMatch(/^LimitError: bob and bob's agents drafted 1 versions/);
});

// On Postgres, each call takes a pooled connection (10 by default). The budget's lock is held only
// while a call counts and takes its place, never through its write, so one person's burst of big
// drafts costs everyone else no more than the same burst would with no rate at all. (With the lock
// held through each write, the burst took four times as long and another person's read waited
// four or five times as long as with no rate.) PGlite is one connection, which a burst holds in
// turn whatever the lock does, so this is Postgres's alone.
(process.env.KONJIR_TEST_DATABASE_URL ? test : test.skip)('one person\'s burst of big drafts doesn\'t starve another person\'s read', async () => {
  const { kolab, product, engineer } = await orders();
  const parts = 20;
  for (let i = 0; i < 2 * parts; i++) await kolab.createNode(engineer, 'binding', `Part ${i}`, `part-${i}`);
  const big = Array.from({ length: MAX_ELEMENTS }, (_, i) => ({ id: `b${i}`, text: `Element ${i}: ${long(150)}` }));
  const read = async () => { const t = Date.now(); await kolab.queriesPage(product, {}); return Date.now() - t; };
  /** Bob drafts on `parts` nodes at once, from node `from`; Alice reads once the burst has the pool. */
  const burst = async (from: number) => {
    const started = Date.now();
    const drafts = Promise.all(Array.from({ length: parts }, (_, i) => kolab.draft(engineer, `part-${from + i}`, { elements: big })));
    await new Promise((r) => setTimeout(r, 300));
    const alice = await read();
    await drafts;
    return { alice, total: Date.now() - started };
  };
  Object.assign(kolab.rates, { drafts: Infinity });
  const unrated = await burst(0);
  Object.assign(kolab.rates, { drafts: MAX_DRAFTS_PER_HOUR });
  const rated = await burst(parts);
  expect((await kolab.db.query(`select 1 from version where actor_id = 'bob'`)).rows).toHaveLength(2 * parts + 1);
  expect({ alice: rated.alice < 3 * unrated.alice + 1_000, total: rated.total < 2 * unrated.total + 2_000, unrated, rated })
    .toMatchObject({ alice: true, total: true });
}, 300_000);

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

test('resolving an override mark is a draft: it takes a place in the resolver\'s budget, so a person at the limit can\'t keep resolving a mark', async () => {
  const { kolab, product } = await setup();
  const p1 = await kolab.commit(product, await kolab.createNode(product, 'spec', 'Storefront', 'P'), { elements: els({ E1: 'Session timeout is 15 minutes.' }) });
  const child = await kolab.createNode(product, 'prototype', 'Storefront for Acme', 'C');
  await kolab.commit(product, child, { parent: p1, deltas: [{ kind: 'override', element: 'E1', text: 'Session timeout is 30 minutes.' }] });
  await kolab.commit(product, 'P', { elements: els({ E1: 'Session timeout is 10 minutes.' }) });
  const mark = (await kolab.openMarks()).find((m) => m.reason === 'override_stale')!;
  // A second writer on the layer, so a resolution waits in review and the mark stays open.
  await people(kolab, 'dana', { layers: ['functional'] });
  const versions = async () => (await kolab.db.query(`select 1 from version where node_id = $1`, [child])).rows.length;
  // Alice has made 3 drafts: one more is allowed.
  Object.assign(kolab.rates, { drafts: 4 });
  expect((await kolab.resolveOverride(product, mark.id, 'amend', 'Session timeout is 20 minutes.')).verdict.in_review).toBe(true);
  const written = await versions();
  expect(await rejection(kolab.resolveOverride(product, mark.id, 'amend', 'Session timeout is 25 minutes.')))
    .toMatch(/^LimitError: alice and alice's agents drafted 4 versions in the last hour; the limit is 4 in an hour/);
  expect(await rejection(kolab.resolveOverride(product, mark.id, 'adopt_parent'))).toMatch(/^LimitError/);
  expect(await versions()).toBe(written);
  expect((await kolab.db.query(`select 1 from rate_event where owner_id = 'alice' and kind = 'draft' and not held`)).rows).toHaveLength(4);
  expect((await kolab.db.query(`select 1 from rate_event where held`)).rows).toStrictEqual([]);
});

test('a write that commits after its hold was pruned is counted all the same, and only Kolab takes or gives back a place', async () => {
  const { kolab } = await orders();
  const take = async () => (await kolab.db.query<{ r_hold: string }>(`select * from kj_rate_take('bob', 'ask', $1, 100, 100)`, [RATE_WINDOW_MS])).rows[0].r_hold;
  const first = await take();
  // The write waited past ten minutes for its locks: the next take prunes its hold.
  await kolab.db.query(`update rate_event set created_at = now() - interval '11 minutes' where id = $1`, [first]);
  const second = await take();
  expect((await kolab.db.query(`select 1 from rate_event where id = $1`, [first])).rows).toStrictEqual([]);
  // Its use puts the event back, used, from now; the other hold is used in place.
  await kolab.db.query(`select kj_rate_use($1)`, [first]);
  await kolab.db.query(`select kj_rate_use($1)`, [second]);
  expect((await kolab.db.query<{ id: string; owner_id: string; kind: string; held: boolean; fresh: boolean }>(
    `select id, owner_id, kind, held, created_at > now() - interval '1 minute' as fresh from rate_event where id = any($1) order by id = $2 desc`, [[first, second], first])).rows)
    .toStrictEqual([
      { id: first, owner_id: 'bob', kind: 'ask', held: false, fresh: true },
      { id: second, owner_id: 'bob', kind: 'ask', held: false, fresh: true },
    ]);
  // A used event isn't given back.
  await kolab.db.query(`select kj_rate_release($1)`, [first]);
  expect((await kolab.db.query(`select 1 from rate_event where id = $1`, [first])).rows).toHaveLength(1);
  expect(await rejection(kolab.db.query(`select kj_rate_use('not-a-hold')`))).toMatch(/not a rate hold/);
  // A session's role (kj_agent) may use its own hold as its write commits, but never take or give back a place.
  const asAgent = (sql: string, params: unknown[] = []) => kolab.db.transaction(async (tx) => { await tx.exec('set local role kj_agent'); await tx.query(sql, params); });
  expect(await rejection(asAgent(`select * from kj_rate_take('alice', 'draft', 3600000, 100, 100)`))).toMatch(/permission denied/);
  expect(await rejection(asAgent(`select kj_rate_release($1)`, [second]))).toMatch(/permission denied/);
  await asAgent(`select kj_rate_use($1)`, [second]);
});
