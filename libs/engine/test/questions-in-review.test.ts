// D65: a question may be asked of an element of a version in review, and follows that version as it
// settles; and a review request reaches only those who can review its layer in the role they work in.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { Kolab } from '@konjir/engine';
import { TEST_KOLAB, commitReviewed, els, marksOn, openKolab, people, rejection, setup, textOf } from '@konjir/engine/testing';
import { nobodyCanReview } from '@konjir/types';
import { openReviewRequests, queryDetails, submissionsOf } from '../src/views.js';
import type { KolabEvent } from '@konjir/types';

/**
 * What production met: Alice, a product owner, has checkout@1 in review, Dave to review it, and an
 * engineer agent of Bob's that reads it and has a question.
 */
async function specInReview() {
  const ctx = await setup();
  const { kolab, product } = ctx;
  await people(kolab, 'dave', { layers: ['functional'] });
  const dave = await kolab.openSession('dave', 'product');
  await people(kolab, 'bob-agent', { owner: 'bob', layers: ['technical'] });
  const agent = await kolab.openSession('bob-agent', 'engineer');
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.', R2: 'A failed payment can be retried.' }) });
  expect(await kolab.review(v1)).toMatchObject({ in_review: true, reviewers: ['dave'] });
  return { ...ctx, dave, agent, spec, v1 };
}

/** Open questions on a version no one can ask about: there must never be any. */
async function strandedQuestions(kolab: Kolab) {
  return (await kolab.db.query<{ id: string }>(
    `select q.id from query q join version v on v.id = q.version_id where q.state = 'open' and v.state not in ('committed', 'in_review')`)).rows;
}

test('an engineer agent asks about an element of a version in review, and product answers it', async () => {
  const { kolab, product, agent } = await specInReview();
  // Without @version an address names the latest committed version, and there is none yet: the
  // refusal names the version in review to ask about instead.
  expect(await rejection(kolab.raiseQuery(agent, 'kj:checkout#R2', 'How many retries?')))
    .toMatch(/cannot ask about kj:checkout#R2: it does not resolve\. Without @version an address names the latest committed version; checkout@1 is in review: ask about kj:checkout@1#R2$/);

  const q = await kolab.raiseQuery(agent, 'kj:checkout@1#R2', 'How many retries?');
  const [listed] = await kolab.listQueries({ layer: 'functional', state: 'open' });
  expect(listed).toMatchObject({ id: q, address: 'kj:checkout@1#R2', raised_by: 'bob-agent', state: 'open' });
  expect(listed.asked_of).toBeUndefined();
  // Product reads it beside the element of the version in review, and answers it.
  expect((await kolab.readNode(product, 'checkout', 1)).queries.map((x) => x.id)).toStrictEqual([q]);
  await kolab.answerQuery(product, q, 'Three times, then the order is held.');
  expect((await kolab.listQueries({ raisedBy: 'bob-agent' }))[0]).toMatchObject({ state: 'answered', answer: 'Three times, then the order is held.', answered_by: 'alice' });
});

test('a question about a version in review carries over when it commits, and reads outside its kolab only then (D49)', async () => {
  const { kolab, dave, agent, v1 } = await specInReview();
  // Olga works in another kolab and holds Read on this one.
  await kolab.addActor('olga');
  await kolab.createKolab('elsewhere', { owner: 'olga' });
  await kolab.grant(TEST_KOLAB, 'olga', 'read');
  const olga = await kolab.openSession('olga', 'product', { kolab: 'elsewhere' });

  const q = await kolab.raiseQuery(agent, 'kj:checkout@1#R2', 'How many retries?');
  // An outside reader can't read the version in review, ask about it, or read the question on it.
  expect(await rejection(kolab.readNode(olga, 'test/checkout', 1))).toMatch(/has no version 1/);
  expect(await rejection(kolab.raiseQuery(olga, 'kj:test/checkout@1#R2', 'Retries?'))).toMatch(/asking across kolabs isn't supported yet/);
  expect(await kolab.readAs(olga, async (x) => (await x.query(`select id from query`)).rows)).toStrictEqual([]);

  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  expect(await kolab.listQueries({ layer: 'functional' })).toMatchObject([{ id: q, address: 'kj:checkout@1#R2', state: 'open' }]);
  expect((await kolab.readNode(olga, 'test/checkout', 1)).queries.map((x) => [x.id, x.address])).toStrictEqual([[q, 'kj:test/checkout@1#R2']]);
});

test('abandoned, a version in review hands its questions to the latest committed version where the element is there, and withdraws the rest', async () => {
  const { kolab, product, dave, engineer, agent, spec, v1 } = await specInReview();
  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  await kolab.createNode(agent, 'technical_binding', 'Checkout on Postgres', 'checkout-pg');
  await commitReviewed(kolab, agent, engineer, 'checkout-pg', { elements: els({ b1: 'Payments retry from a queue.' }) });

  const v2 = await kolab.draft(product, spec, { deltas: [
    { kind: 'override', element: 'R2', text: 'A failed payment can be retried twice.' },
    { kind: 'add', element: 'R3', text: 'Each retry is logged.' },
  ] });
  expect(await kolab.review(v2)).toMatchObject({ in_review: true, reviewers: ['dave'] });
  const onR2 = await kolab.raiseQuery(agent, 'kj:checkout@2#R2', 'Twice in all, or twice after the first?');
  const onR3 = await kolab.raiseQuery(agent, 'kj:checkout@2#R3', 'Logged where?', { from: 'kj:checkout-pg#b1' });
  const note = await kolab.raiseQuery(agent, 'kj:checkout@2', 'We read retries as idempotent.', { kind: 'note' });
  const answered = await kolab.raiseQuery(agent, 'kj:checkout@2#R3', 'Logged by whom?');
  await kolab.answerQuery(product, answered, 'By the payment service.');

  expect(await kolab.abandon(product, v2)).toBe('rejected');
  const byId = Object.fromEntries((await kolab.listQueries({ layer: 'functional' })).map((x) => [x.id, x]));
  expect(byId[onR2]).toMatchObject({ state: 'open', address: 'kj:checkout@1#R2', asked_of: 'kj:checkout@2' });
  expect(byId[note]).toMatchObject({ state: 'open', address: 'kj:checkout@1', asked_of: 'kj:checkout@2' });
  expect(byId[onR3]).toMatchObject({
    state: 'withdrawn', address: 'kj:checkout@2#R3', answered_by: null,
    answer: "withdrawn: checkout@2, which it was asked of, was abandoned, and R3 isn't in checkout's latest committed version",
  });
  // One already answered stays where it was asked, as the record of it.
  expect(byId[answered]).toMatchObject({ state: 'answered', address: 'kj:checkout@2#R3' });
  // The element that waited on it is told, as an answer would tell it.
  const [mark] = await marksOn(kolab, 'checkout-pg');
  expect([mark.reason, mark.element_id]).toStrictEqual(['query_answered', 'b1']);
  expect(mark.note).toMatch(/you asked "Logged where\?"; withdrawn: checkout@2, which it was asked of, was abandoned/);
  // A withdrawn question takes no answer, and nothing is left open on a version no one can ask about.
  expect(await rejection(kolab.answerQuery(product, onR3, 'In the audit log.'))).toMatch(/GateError: query \w+ is already withdrawn/);
  expect(await strandedQuestions(kolab)).toStrictEqual([]);
  // The question that moved is answered on the committed version.
  await kolab.answerQuery(product, onR2, 'Twice in all.');
});

test('returned to its author as a draft, a first version withdraws its questions; a draft or a rejected version is never asked about', async () => {
  const { kolab, product, dave, agent, v1 } = await specInReview();
  const q = await kolab.raiseQuery(agent, 'kj:checkout@1#R1', 'Measured from where?');
  await kolab.recordReview(dave, v1, { verdict: 'request_changes', note: 'Say where it is measured from.' });
  expect(await kolab.listQueries({ layer: 'functional' })).toMatchObject([{
    id: q, state: 'withdrawn', answer: 'withdrawn: checkout@1, which it was asked of, was returned to its author as a draft, and checkout has no committed version',
  }]);
  expect(await rejection(kolab.raiseQuery(agent, 'kj:checkout@1#R1', 'Again?')))
    .toMatch(/GateError: cannot ask about kj:checkout@1#R1: checkout@1 is a draft, which no one but its author works on; ask about a committed version, or one in review/);
  await kolab.abandon(product, v1);
  expect(await rejection(kolab.raiseQuery(agent, 'kj:checkout@1#R1', 'Again?'))).toMatch(/checkout@1 is rejected/);
  expect(await strandedQuestions(kolab)).toStrictEqual([]);
});

test('a version in review rejected as stale hands its questions on too', async () => {
  const { kolab, product, dave, agent, spec, v1 } = await specInReview();
  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  const v2 = await kolab.draft(product, spec, { deltas: [{ kind: 'add', element: 'R3', text: 'Each retry is logged.' }] });
  await kolab.review(v2);
  const q = await kolab.raiseQuery(agent, 'kj:checkout@2#R1', 'Still 30 seconds?');
  await commitReviewed(kolab, dave, product, spec, { deltas: [{ kind: 'override', element: 'R1', text: 'Checkout completes in 20 seconds.' }] });
  expect(await kolab.version(v2)).toMatchObject({ state: 'rejected' });
  expect(await kolab.listQueries({ layer: 'functional' })).toMatchObject([{ id: q, state: 'open', address: 'kj:checkout@3#R1', asked_of: 'kj:checkout@2' }]);
});

test('a version in review that Kolab folds onto its rebase takes its questions to the fold', async () => {
  const { kolab, product, dave, agent } = await specInReview();
  const parent = await kolab.createNode(product, 'prototype', 'P', 'P');
  const p1 = await commitReviewed(kolab, product, dave, parent, { elements: els({ E1: 'one' }) });
  const child = await kolab.createNode(product, 'prototype', 'C', 'C');
  await commitReviewed(kolab, product, dave, child, { parent: p1, deltas: [{ kind: 'add', element: 'X', text: 'x' }] });
  const draft = await kolab.draft(product, child, { deltas: [{ kind: 'add', element: 'Y', text: 'y' }] });
  await kolab.review(draft);
  const seq = (await kolab.version(draft)).seq;
  const q = await kolab.raiseQuery(agent, `kj:C@${seq}#Y`, 'Why y?');
  await commitReviewed(kolab, product, dave, parent, { elements: els({ E1: 'one, revised' }) });   // Kolab rebases C while the draft waits
  const r = await kolab.recordReview(dave, draft, { verdict: 'approve' });
  expect(r.ok).toBe(true);
  expect(await textOf(kolab, child)).toMatchObject({ Y: 'y' });
  const fold = await kolab.version(r.version);
  expect(await kolab.listQueries({ node: child })).toMatchObject([{ id: q, state: 'open', address: `kj:C@${fold.seq}#Y`, asked_of: `kj:C@${seq}` }]);
});

test('a question moved off an abandoned version in review never reaches a reader outside the kolab (D49, D58)', async () => {
  const { kolab, product, dave, agent, spec, v1 } = await specInReview();
  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  await kolab.addActor('olga');
  await kolab.createKolab('elsewhere', { owner: 'olga' });
  await kolab.grant(TEST_KOLAB, 'olga', 'read');
  const olga = await kolab.openSession('olga', 'product', { kolab: 'elsewhere' });
  const before = await kolab.raiseQuery(agent, 'kj:checkout@1#R1', 'Measured from where?');   // asked of a committed version

  const v2 = await kolab.draft(product, spec, { deltas: [{ kind: 'override', element: 'R2', text: 'A failed payment can be retried twice, by the secret fraud rule.' }] });
  await kolab.review(v2);
  const moved = await kolab.raiseQuery(agent, 'kj:checkout@2#R2', 'Which secret fraud rule?');
  await kolab.abandon(product, v2);
  // It moved, inside the kolab, and says the element's text has changed since it was asked.
  expect((await kolab.listQueries({ layer: 'functional' })).find((x) => x.id === moved))
    .toMatchObject({ state: 'open', address: 'kj:checkout@1#R2', asked_of: 'kj:checkout@2', element_changed: true });
  // Outside, only the question asked of a committed version shows: through the engine, the page's view, and row-level security.
  expect((await kolab.readNode(olga, 'test/checkout', 1)).queries.map((x) => x.id)).toStrictEqual([before]);
  expect((await queryDetails(kolab, olga, spec, TEST_KOLAB)).map((x) => x.id)).toStrictEqual([before]);
  expect((await kolab.readAs(olga, async (x) => (await x.query<{ id: string }>(`select id from query`)).rows)).map((r) => r.id)).toStrictEqual([before]);
});

test('a question that quoted words moves only if the words are in the target as quoted; otherwise it is withdrawn, saying so', async () => {
  const { kolab, product, dave, agent, spec, v1 } = await specInReview();
  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  const v2 = await kolab.draft(product, spec, { deltas: [{ kind: 'override', element: 'R2', text: 'A failed payment can be retried twice by the customer.' }] });
  await kolab.review(v2);
  const kept = await kolab.raiseQuery(agent, 'kj:checkout@2#R2~q({"exact":"A failed payment"})', 'Any failure?');
  const gone = await kolab.raiseQuery(agent, 'kj:checkout@2#R2~q({"exact":"twice by the customer"})', 'Not the shop?');
  await kolab.abandon(product, v2);
  const byId = Object.fromEntries((await kolab.listQueries({ layer: 'functional' })).map((x) => [x.id, x]));
  expect(byId[kept]).toMatchObject({ state: 'open', asked_of: 'kj:checkout@2' });
  expect(byId[kept].address).toMatch(/^kj:checkout@1#R2~q\(\{"exact":"A failed payment"/);
  expect(byId[gone]).toMatchObject({
    state: 'withdrawn', address: 'kj:checkout@2#R2~q({"exact":"twice by the customer"})',
    answer: "withdrawn: checkout@2, which it was asked of, was abandoned, and the words it quoted aren't in kj:checkout@1#R2",
  });
});

test('a moved quote takes its prefix and suffix from the committed text, carrying no word only the version in review had', async () => {
  const { kolab, product, dave, agent, spec, v1 } = await specInReview();
  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  const v2 = await kolab.draft(product, spec, { deltas: [
    { kind: 'override', element: 'R2', text: 'A failed payment can be retried twice by the secret fraud rule.' },
    { kind: 'add', element: 'R1a', text: 'Measured at the server.', parent: 'R1' },
  ] });
  await kolab.review(v2);
  const q = await kolab.raiseQuery(agent, 'kj:checkout@2#R2~q({"exact":"A failed payment","suffix":"can be retried twice by the secret fraud rule"})', 'Which payments?');
  const onR1 = await kolab.raiseQuery(agent, 'kj:checkout@2#R1', 'From the click?');   // R1's own text is the same; v2 added R1a under it
  await kolab.abandon(product, v2);
  const byId = Object.fromEntries((await kolab.listQueries({ layer: 'functional' })).map((x) => [x.id, x]));
  expect(byId[q]).toMatchObject({ state: 'open', asked_of: 'kj:checkout@2', element_changed: true });
  expect(byId[q].address).toMatch(/^kj:checkout@1#R2~q\(\{"exact":"A failed payment"/);
  expect(byId[q].address).not.toMatch(/secret|fraud/);
  const stored = (await kolab.db.query<{ selector: object }>(`select selector from query where id = $1`, [q])).rows[0].selector;
  expect(JSON.stringify(stored)).not.toMatch(/secret|fraud/);
  expect(byId[onR1]).toMatchObject({ state: 'open', address: 'kj:checkout@1#R1', element_changed: true });
});

test('a moved quote the committed text has more than once is withdrawn: it can\'t be placed', async () => {
  const { kolab, product, dave, agent, spec, v1 } = await specInReview();
  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  await commitReviewed(kolab, dave, product, spec, { deltas: [{ kind: 'override', element: 'R2', text: 'A failed payment is retried. A failed payment is logged.' }] });
  const v3 = await kolab.draft(product, spec, { deltas: [{ kind: 'override', element: 'R2', text: 'A failed payment is retried twice.' }] });
  await kolab.review(v3);
  const q = await kolab.raiseQuery(agent, 'kj:checkout@3#R2~q({"exact":"A failed payment"})', 'Card or wallet?');
  await kolab.abandon(product, v3);
  expect((await kolab.listQueries({ layer: 'functional' })).find((x) => x.id === q))
    .toMatchObject({ state: 'withdrawn', answer: expect.stringMatching(/the words it quoted aren't in kj:checkout@2#R2 just once$/) });
});

test('withdrawn with no committed version on its node, a question marks nothing: a mark\'s trigger is always committed', async () => {
  const { kolab, engineer, dave, agent, v1 } = await specInReview();
  await kolab.createNode(agent, 'technical_binding', 'Checkout on Postgres', 'checkout-pg');
  await commitReviewed(kolab, agent, engineer, 'checkout-pg', { elements: els({ b1: 'Payments retry from a queue.' }) });
  const q = await kolab.raiseQuery(agent, 'kj:checkout@1#R2', 'How many retries?', { from: 'kj:checkout-pg#b1' });
  await kolab.recordReview(dave, v1, { verdict: 'request_changes', note: 'Say how many.' });
  expect((await kolab.listQueries({ layer: 'functional' }))[0]).toMatchObject({ id: q, state: 'withdrawn' });
  expect(await marksOn(kolab, 'checkout-pg')).toStrictEqual([]);
  expect((await kolab.db.query(`select 1 from invalidation i join version v on v.id = i.triggered_by where v.state <> 'committed'`)).rows).toStrictEqual([]);
});

test('from must name an element the asker can write: a Read-only member asks without it', async () => {
  const { kolab, dave, v1 } = await specInReview();
  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  const carol = await kolab.openSession('carol', 'product');   // Read only
  expect(await rejection(kolab.raiseQuery(carol, 'kj:checkout#R2', 'Retries?', { from: 'kj:checkout#R1' })))
    .toMatch(/AccessError: carol holds Read in kolab test, so from can't name an element of the functional layer: ask without from/);
  expect(await kolab.raiseQuery(carol, 'kj:checkout#R2', 'Retries?')).toEqual(expect.any(String));
});

test('a Read-only member of the kolab may ask about a version in review it can read (D58); an outsider can\'t reach it', async () => {
  const { kolab, v1 } = await specInReview();
  const carol = await kolab.openSession('carol', 'product');   // Read only, in the kolab
  const q = await kolab.raiseQuery(carol, 'kj:checkout@1#R1', 'Is 30 seconds a target or a limit?');
  expect((await kolab.listQueries({ layer: 'functional' })).map((x) => x.id)).toStrictEqual([q]);
  expect((await kolab.version(v1)).state).toBe('in_review');
});

test('an ask racing the abandon of its version is refused or handed on, never left on it', async () => {
  const { kolab, product, dave, agent, spec, v1 } = await specInReview();
  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  const v2 = await kolab.draft(product, spec, { deltas: [{ kind: 'add', element: 'R3', text: 'Each retry is logged.' }] });
  await kolab.review(v2);
  // The abandon lands between the asker's read of the version and its question: the question is refused.
  const resolve = kolab.resolve.bind(kolab);
  kolab.resolve = async (...args: Parameters<Kolab['resolve']>) => {
    const r = await resolve(...args);
    kolab.resolve = resolve;
    await kolab.abandon(product, v2);
    return r;
  };
  expect(await rejection(kolab.raiseQuery(agent, 'kj:checkout@2#R1', 'Still 30 seconds?'))).toMatch(/checkout@2 is rejected/);

  // Many at once, against an abandon: each is refused, or lands and is handed on with the rest.
  const v3 = await kolab.draft(product, spec, { deltas: [{ kind: 'add', element: 'R4', text: 'Retries back off.' }] });
  await kolab.review(v3);
  const seq = (await kolab.version(v3)).seq;
  const asks = Array.from({ length: 8 }, (_, i) => kolab.raiseQuery(agent, `kj:checkout@${seq}#${i % 2 ? 'R1' : 'R4'}`, `Question ${i}?`));
  const settled = await Promise.allSettled([...asks, kolab.abandon(product, v3)]);
  for (const s of settled.slice(0, 8)) if (s.status === 'rejected') expect(String(s.reason)).toMatch(new RegExp(`checkout@${seq} is rejected`));
  expect(settled[8].status).toBe('fulfilled');
  expect(await strandedQuestions(kolab)).toStrictEqual([]);
  const landed = settled.slice(0, 8).filter((s) => s.status === 'fulfilled').length;
  const after = (await kolab.listQueries({ node: spec })).filter((x) => x.question.startsWith('Question '));
  expect(after.length).toBe(landed);
  for (const x of after) {
    expect(x.state === 'open' ? x.address : x.state).toBe(x.address.endsWith('#R1') ? 'kj:checkout@1#R1' : 'withdrawn');
  }
});

// ---- review requests (D65, VER16, VER11) -----------------------------------

/** Pat, a product owner; Lee, a person with Write on both layers, not signed in; and Lee's agent, Write on both, signed in as engineer. */
async function leesKolab() {
  const kolab = await openKolab();
  await people(kolab, 'pat', { layers: ['functional'] });
  await people(kolab, 'lee', { layers: ['functional', 'technical'] });
  await people(kolab, 'lee-agent', { owner: 'lee' });
  const pat = await kolab.openSession('pat', 'product');
  const eng = await kolab.openSession('lee-agent', 'engineer');
  const spec = await kolab.createNode(pat, 'functional_spec', 'Checkout', 'checkout');
  return { kolab, pat, eng, spec };
}

test('a review request skips an agent signed in as engineer but reaches a person, and shows once the agent signs in as product', async () => {
  const { kolab, pat, spec } = await leesKolab();
  const v1 = await kolab.draft(pat, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  expect(await kolab.review(v1)).toMatchObject({ in_review: true, reviewers: ['lee'], note: expect.stringMatching(/Waiting for one approval from lee\.$/) });
  expect(await kolab.reviewRequests({ reviewer: 'lee-agent' })).toStrictEqual([]);
  expect((await kolab.reviewRequests()).map((r) => r.reviewer)).toStrictEqual(['lee']);
  expect((await kolab.submissions('pat'))[0].verdicts.map((v) => v.reviewer)).toStrictEqual(['lee']);
  expect((await openReviewRequests(kolab, pat)).map((r) => r.reviewer)).toStrictEqual(['lee']);
  expect((await submissionsOf(kolab, pat, 'pat')).items[0].verdicts.map((v) => v.reviewer)).toStrictEqual(['lee']);

  // A person signed in with the other role still gets it: they choose their role as they sign in.
  await kolab.openSession('lee', 'engineer');
  expect((await kolab.reviewRequests({ reviewer: 'lee' })).map((r) => r.subject)).toStrictEqual(['kj:checkout@1']);

  // The agent signs in again as product: the request it held shows now, and it may review. Ending
  // and opening its session tell the layer's inbox and the author's answers, so open pages re-read.
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));
  await kolab.endSession({ actor: 'lee-agent' });
  const pm = await kolab.openSession('lee-agent', 'product');
  expect(events.filter((e) => 'inbox' in e)).toStrictEqual([
    { inbox: 'layer', kolab: 'test', layer: 'functional' }, { inbox: 'actor', kolab: 'test', actor: 'pat' },
    { inbox: 'layer', kolab: 'test', layer: 'functional' }, { inbox: 'actor', kolab: 'test', actor: 'pat' },
  ]);
  expect((await kolab.reviewRequests({ reviewer: 'lee-agent' })).map((r) => r.subject)).toStrictEqual(['kj:checkout@1']);
  expect((await kolab.recordReview(pm, v1, { verdict: 'approve' })).ok).toBe(true);
});

test('when nobody else can review yet, the version waits in review and says how to get a reviewer; it doesn\'t commit unreviewed (D66)', async () => {
  // Pat's only other writer on the layer is Pat's own agent, signed in as engineer.
  const kolab = await openKolab();
  await people(kolab, 'pat', { layers: ['functional', 'technical'] });
  await people(kolab, 'pat-agent', { owner: 'pat' });
  const pat = await kolab.openSession('pat', 'product');
  await kolab.openSession('pat-agent', 'engineer');
  const spec = await kolab.createNode(pat, 'functional_spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(pat, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });

  const r = await kolab.review(v1);
  expect(nobodyCanReview('functional')).toBe('Nobody else can review the functional layer yet. Invite a product teammate, or connect an agent of yours with the product role. It waits in review until one of them approves it.');
  expect(r).toMatchObject({ ok: false, in_review: true, reviewers: [], note: expect.stringContaining(nobodyCanReview('functional')) });
  expect(await kolab.version(v1)).toMatchObject({ state: 'in_review' });
  expect(await kolab.reviewRequests()).toStrictEqual([]);
  // Resubmitting says the same while it is so.
  expect(await kolab.review(v1)).toMatchObject({ in_review: true, reviewers: [], note: `Still in review. ${nobodyCanReview('functional')}` });

  // Signed in as product, Pat's agent can review it, and its request shows.
  await kolab.endSession({ actor: 'pat-agent' });
  const pm = await kolab.openSession('pat-agent', 'product');
  expect((await kolab.reviewRequests({ reviewer: 'pat-agent' })).map((x) => x.subject)).toStrictEqual(['kj:checkout@1']);
  expect(await kolab.recordReview(pm, v1, { verdict: 'approve' })).toMatchObject({ ok: true });
});

test('an agent signed in through OAuth reviews in the role chosen at consent, even once its access token expires', async () => {
  const { kolab, pat, spec } = await leesKolab();
  await kolab.endSession({ actor: 'lee-agent' });
  const client = (await kolab.registerClient({ name: 'Test client', redirectUris: ['http://127.0.0.1:9/cb'] })).id;
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await kolab.beginAuthorization({
    provider: 'github', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  const { csrf } = await kolab.identifyAuthorization(binding, state, 'lee');
  const { code, redirectUri } = await kolab.consent(binding, csrf, { as: { kind: 'agent', agent: 'lee-agent' }, kolab: TEST_KOLAB, role: 'engineer' });
  const tokens = await kolab.exchangeCode({ code, clientId: client, redirectUri, codeVerifier: verifier });
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where id = $1`, [tokens.session]);

  const v1 = await kolab.draft(pat, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  expect(await kolab.review(v1)).toMatchObject({ in_review: true, reviewers: ['lee'] });
  // Revoked, the grant holds no role: the agent chooses one when it next signs in, so it is asked.
  await kolab.revokeToken(tokens.refreshToken);
  expect((await kolab.reviewRequests()).map((r) => r.reviewer)).toStrictEqual(['lee', 'lee-agent']);
});
