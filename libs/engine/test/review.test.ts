// The review flow (W1.6; REV2, REV4, DAT3, VER2, VER6, VER9, VER11, VER12, VER16, D19, D25, D33):
// drafted -> in_review -> committed, review requests in reviewers' inboxes, konjir_review's verdicts,
// the solo-project fallback, and rebases that commit after structural checks only.
import { describe, expect, test } from '@jest/globals';
import { RoleError, sessionKey, structuralChecks } from '@konjir/engine';
import { TEST_KOLAB, agentsMay, commitReviewed, els, marksOn, openKolab, people, rejection, setup, textOf } from '@konjir/engine/testing';
import type { KolabEvent } from '@konjir/types';

/** Alice (product) and Dave (product), two people, so each reviews the other's specs; Bob is the engineer. */
async function twoProductOwners() {
  const ctx = await setup();
  await people(ctx.kolab, 'dave', { layers: ['functional'] });
  const dave = await ctx.kolab.openSession('dave', 'product');
  return { ...ctx, dave };
}

const markState = async (kolab: Awaited<ReturnType<typeof setup>>['kolab'], id: string) =>
  (await kolab.db.query<{ state: string }>(`select state from invalidation where id = $1`, [id])).rows[0].state;
const stateOf = async (kolab: Awaited<ReturnType<typeof setup>>['kolab'], id: string) => (await kolab.version(id)).state;

test('a submitted version waits in review, with a request in each reviewer\'s inbox, until another user approves it', async () => {
  const { kolab, product, engineer, dave } = await twoProductOwners();
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });

  const r = await kolab.review(v1);
  expect(r).toMatchObject({ ok: false, in_review: true, reviewers: ['dave'], version: v1 });
  expect(await stateOf(kolab, v1)).toBe('in_review');
  expect(events).toStrictEqual([{ inbox: 'layer', kolab: 'test', layer: 'functional' }, { inbox: 'actor', kolab: 'test', actor: 'alice' }]);
  const [request] = await kolab.reviewRequests({ reviewer: 'dave' });
  expect(request).toMatchObject({ subject: 'kj:checkout@1', subject_kind: 'version', author: 'alice', reviewer: 'dave' });
  expect(request.next).toMatch(/konjir_review node=checkout version=1 verdict=approve/);
  expect(await kolab.reviewRequests({ reviewer: 'alice' })).toStrictEqual([]);
  expect((await kolab.submissions('alice')).map((s) => [s.subject, s.state])).toStrictEqual([['kj:checkout@1', 'in_review']]);

  // Nothing is truth, or linkable, until it commits (VER4).
  expect(await kolab.latestCommitted(spec)).toBeUndefined();
  const binding = await kolab.createNode(engineer, 'binding', 'B', 'b');
  const b1 = await kolab.draft(engineer, binding, { elements: els({ b1: 'A queue.' }) });
  expect(await rejection(kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: v1, targetElement: 'R1' })))
    .toMatch(/GateError: nothing may derive from/);
  // Only another actor with Write on the layer reviews it: never its author, never the other layer.
  expect(await rejection(kolab.recordReview(product, v1, { verdict: 'approve' }))).toMatch(/GateError: alice wrote checkout@1; another actor with Write on the functional layer must review it/);
  await expect(kolab.recordReview(engineer, v1, { verdict: 'approve' })).rejects.toBeInstanceOf(RoleError);

  events.length = 0;
  const approved = await kolab.recordReview(dave, v1, { verdict: 'approve', note: 'One testable intent.' });
  expect(approved).toMatchObject({ ok: true, version: v1, note: 'Approved by dave: One testable intent.' });
  expect(await stateOf(kolab, v1)).toBe('committed');
  expect((await kolab.latestCommitted(spec))!.id).toBe(v1);
  expect(events).toEqual(expect.arrayContaining([{ inbox: 'layer', kolab: 'test', layer: 'functional' }, { inbox: 'actor', kolab: 'test', actor: 'alice' }]));
  expect(await kolab.reviewRequests()).toStrictEqual([]);
  expect((await kolab.submissions('alice'))[0]).toMatchObject({
    state: 'committed', verdicts: [{ reviewer: 'dave', state: 'approved', note: 'One testable intent.', findings: [] }],
  });
  // A version settled once takes no further verdict.
  expect(await rejection(kolab.recordReview(dave, v1, { verdict: 'approve' }))).toMatch(/GateError: checkout@1 is committed already: Approved by dave: One testable intent\./);
});

test('another agent of the same person counts as a reviewer, and so does the person (D25, D33)', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, ['alice-pm', 'alice-codex'], { owner: 'alice', layers: ['functional'] });
  const pm = await kolab.openSession('alice-pm', 'product');
  const codex = await kolab.openSession('alice-codex', 'product');
  const spec = await kolab.createNode(pm, 'spec', 'Checkout', 'checkout');

  // Both the other agent and the person who owns them hold Write on the layer: each is a reviewer,
  // whatever session it has open, or none (VER16), where the kolab's policy lets an agent approve
  // functional versions. By default only a person does (AUT2): the agent is asked nothing, and its
  // verdict is refused.
  const v1 = await kolab.draft(pm, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  expect(await kolab.review(v1)).toMatchObject({ in_review: true, reviewers: ['alice'] });
  expect(await rejection(kolab.recordReview(codex, v1, { verdict: 'approve' }))).toMatch(/AccessError: kolab test's policy keeps reviewing functional versions for a person \(AUT2/);
  await agentsMay(kolab);
  expect(await kolab.review(v1)).toMatchObject({ in_review: true, reviewers: ['alice', 'alice-codex'] });
  expect(await kolab.recordReview(codex, v1, { verdict: 'approve' })).toMatchObject({ ok: true, note: 'Approved by alice-codex.' });
  expect(await kolab.author(v1)).toMatchObject({ actor: 'alice-pm', owner: 'alice' });

  // The owning person reviews her agents' versions too, once she opens a session in that role.
  const self = await kolab.openSession('alice', 'product');
  const v2 = await kolab.draft(pm, spec, { elements: els({ R1: 'Checkout completes in 10 seconds.' }) });
  expect(await kolab.review(v2)).toMatchObject({ in_review: true, reviewers: ['alice', 'alice-codex'] });
  expect((await kolab.recordReview(self, v2, { verdict: 'approve' })).ok).toBe(true);
  expect(await textOf(kolab, spec)).toStrictEqual({ R1: 'Checkout completes in 10 seconds.' });
});

test('a request for changes returns the version to drafted; its author resubmits it, or abandons it', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  await people(kolab, 'erin', { layers: ['functional'] });
  const erin = await kolab.openSession('erin', 'product');
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds and emails a receipt.' }) });
  expect((await kolab.review(v1)).reviewers).toStrictEqual(['dave', 'erin']);

  // A contradiction stops the commit (VER9): it comes with a request for changes, never an approval.
  const contradiction = { kind: 'contradiction' as const, elements: ['R1'], explanation: 'Thirty seconds contradicts the SLA.' };
  expect(await rejection(kolab.recordReview(dave, v1, { verdict: 'approve', findings: [contradiction] })))
    .toMatch(/GateError: a contradiction stops a version from committing \(VER9\)/);

  const r = await kolab.recordReview(dave, v1, { verdict: 'request_changes', note: 'R1 is compound: split it.', findings: [contradiction] });
  expect(r).toMatchObject({ ok: false, version: v1, note: 'Changes requested by dave: R1 is compound: split it.' });
  expect(await stateOf(kolab, v1)).toBe('drafted');
  expect(await kolab.reviewRequests()).toStrictEqual([]);   // erin's request is withdrawn with it
  expect(await rejection(kolab.recordReview(erin, v1, { verdict: 'approve' }))).toMatch(/GateError: checkout@1 is back with its author as a draft \(Changes requested by dave: R1 is compound: split it\.\); it isn't in review/);
  const [mine] = await kolab.submissions('alice');
  expect(mine).toMatchObject({ subject: 'kj:checkout@1', state: 'drafted', note: 'Changes requested by dave: R1 is compound: split it.' });
  expect(mine.verdicts).toStrictEqual([
    { reviewer: 'dave', state: 'changes_requested', note: 'R1 is compound: split it.', findings: [contradiction] },
    { reviewer: 'erin', state: 'withdrawn', note: null, findings: [] },
  ]);
  expect(mine.next).toMatch(/^Changes were requested/);

  // Resubmitted unchanged, it goes back into review with new requests, and an approval commits it.
  expect(await kolab.review(v1)).toMatchObject({ in_review: true, reviewers: ['dave', 'erin'] });
  expect((await kolab.recordReview(erin, v1, { verdict: 'approve' })).ok).toBe(true);

  // A draft, or a version in review, is rejected only when its author abandons it.
  const v2 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  await kolab.review(v2);
  expect(await rejection(kolab.abandon(dave, v2))).toMatch(/GateError: only alice, who wrote checkout@2, can abandon it/);
  await kolab.abandon(product, v2);
  expect(await kolab.version(v2)).toMatchObject({ state: 'rejected' });
  expect(await kolab.reviewRequests()).toStrictEqual([]);
  expect(await rejection(kolab.abandon(product, v2))).toMatch(/GateError: checkout@2 is rejected; only a draft or a version in review can be abandoned/);
});

test('with no one else holding Write on the layer, structural checks alone commit a version, and it says so (VER11)', async () => {
  const { kolab, product, engineer } = await setup();   // one product owner, one engineer
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  const r = await kolab.review(v1);
  expect(r).toMatchObject({ ok: true, unreviewed: true, version: v1 });
  expect(r.note).toMatch(/No one other than its author holds Write on the functional layer, so these checks alone committed it, unreviewed \(VER11\)\.$/);
  expect((await kolab.db.query<{ review_note: string }>(`select review_note from version where id = $1`, [v1])).rows[0].review_note).toBe(r.note);
  expect((await kolab.db.query(`select 1 from review_request`)).rows).toStrictEqual([]);
  // The structural checks still refuse a broken version.
  const bad = await kolab.draft(product, spec, { elements: els({ R1: 'Same.', R2: 'Same.' }) });
  expect(await kolab.review(bad)).toMatchObject({ ok: false });
  expect(await stateOf(kolab, bad)).toBe('drafted');   // returned to its author, with the reason (VER2)
  // An engineer is no reviewer of a spec: holding Write on the other layer doesn't count.
  expect(await kolab.reviewersFor({ actor_id: 'alice', layer: 'functional', kolab_id: TEST_KOLAB })).toStrictEqual([]);
  expect(await kolab.reviewersFor({ actor_id: 'bob', layer: 'technical', kolab_id: TEST_KOLAB })).toStrictEqual([]);
  expect((await kolab.sessionInfo(engineer)).layer).toBe('technical');
});

test('a rebase Kolab makes commits after structural checks only, with no review request, while people\'s versions wait for review (VER12)', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const parent = await kolab.createNode(product, 'spec', 'Storefront', 'storefront');
  const p1 = await commitReviewed(kolab, product, dave, parent, { elements: els({ R1: 'Prices show in dollars.' }) });
  const child = await kolab.createNode(dave, 'prototype', 'EU storefront', 'storefront-eu');
  await commitReviewed(kolab, dave, product, child, { parent: p1, deltas: [{ kind: 'override', element: 'R1', text: 'Prices show in euros.' }] });

  const p2 = await kolab.draft(product, parent, { elements: els({ R1: 'Prices show in dollars.', R2: 'Carts persist.' }) });
  expect((await kolab.review(p2)).in_review).toBe(true);
  expect(await textOf(kolab, child)).toStrictEqual({ R1: 'Prices show in euros.' });   // nothing rebases until it commits
  expect((await kolab.recordReview(dave, p2, { verdict: 'approve' })).ok).toBe(true);

  const rebased = (await kolab.latestCommitted(child))!;
  expect(rebased).toMatchObject({ active_role: 'system', state: 'committed', parent_version_id: p2 });
  expect(await textOf(kolab, child)).toStrictEqual({ R1: 'Prices show in euros.', R2: 'Carts persist.' });
  expect((await kolab.db.query(`select 1 from review_request where version_id = $1`, [rebased.id])).rows).toStrictEqual([]);
  expect(await kolab.reviewRequests()).toStrictEqual([]);
});

test('a version in review that someone else\'s commit overtakes is rejected as stale, and its requests leave the inboxes', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  await commitReviewed(kolab, product, dave, spec, { elements: els({ R1: 'v1' }) });
  const mine = await kolab.draft(product, spec, { elements: els({ R1: 'alice edit' }) });
  expect((await kolab.review(mine)).in_review).toBe(true);
  expect((await kolab.reviewRequests({ reviewer: 'dave' })).length).toBe(1);

  await commitReviewed(kolab, dave, product, spec, { elements: els({ R1: 'dave edit' }) });
  expect(await kolab.version(mine)).toMatchObject({ state: 'rejected' });
  expect(await kolab.reviewRequests({ reviewer: 'dave' })).toStrictEqual([]);
  const [stale] = (await kolab.submissions('alice')).filter((s) => s.subject === 'kj:checkout@2');
  expect(stale.note).toMatch(/^stale draft: checkout@3, by dave, committed while this waited in review; redraft against it$/);
  expect(await textOf(kolab, spec)).toStrictEqual({ R1: 'dave edit' });
});

test('a variant\'s version approved after Kolab\'s rebase overtook it is folded onto the rebase, and commits as approved', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const parent = await kolab.createNode(product, 'spec', 'P', 'P');
  const p1 = await commitReviewed(kolab, product, dave, parent, { elements: els({ E1: 'one' }) });
  const child = await kolab.createNode(product, 'prototype', 'C', 'C');
  await commitReviewed(kolab, product, dave, child, { parent: p1, deltas: [{ kind: 'add', element: 'X', text: 'x' }] });
  const draft = await kolab.draft(product, child, { deltas: [{ kind: 'add', element: 'Y', text: 'y' }] });
  expect((await kolab.review(draft)).in_review).toBe(true);
  await commitReviewed(kolab, product, dave, parent, { elements: els({ E1: 'one, revised' }) });   // rebases C while the draft waits
  expect(await kolab.version(draft)).toMatchObject({ state: 'in_review' });                       // only Kolab overtook it

  const r = await kolab.recordReview(dave, draft, { verdict: 'approve' });
  expect(r.ok).toBe(true);
  expect(r.version).not.toBe(draft);
  expect(await kolab.version(r.version)).toMatchObject({ state: 'committed', actor_id: 'alice', active_role: 'product' });
  expect(await textOf(kolab, child)).toStrictEqual({ E1: 'one, revised', X: 'x', Y: 'y' });
  expect(await kolab.version(draft)).toMatchObject({ state: 'rejected' });
  expect((await kolab.db.query<{ review_note: string }>(`select review_note from version where id = $1`, [r.version])).rows[0].review_note)
    .toMatch(/^Approved by dave, then rebased by Kolab onto its node's newer version;/);
  expect(await kolab.reviewRequests()).toStrictEqual([]);
});

test('an approval with a layer leak commits the version and raises a question to the layer that owns the answer (VER9)', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Orders are stored in Postgres.' }) });
  await kolab.review(v1);
  const leak = { kind: 'layer_leak' as const, elements: ['R1'], explanation: 'Postgres is implementation.' };
  expect((await kolab.recordReview(dave, v1, { verdict: 'approve', findings: [leak] })).ok).toBe(true);
  expect((await marksOn(kolab, spec)).map((m) => [m.reason, m.element_id])).toStrictEqual([['role_boundary', 'R1']]);
  expect((await kolab.openQueries())[0].question).toMatch(/specifies implementation, not behavior: Postgres is implementation\./);
  expect(await rejection(kolab.recordReview(dave, v1, { verdict: 'approve', findings: [{ kind: 'style' as never, elements: ['R1'], explanation: 'x' }] })))
    .toMatch(/GateError: a finding is a contradiction or a layer_leak, not style/);
});

test('an override resolution that waits in review settles its mark and sets precedent only when it commits', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const P = await kolab.createNode(product, 'spec', 'P', 'P');
  const p1 = await commitReviewed(kolab, product, dave, P, { elements: els({ E3: 'Timeout 15.' }) });
  const C = await kolab.createNode(product, 'prototype', 'C', 'C');
  await commitReviewed(kolab, product, dave, C, { parent: p1, deltas: [{ kind: 'override', element: 'E3', text: 'Timeout 30.' }] });
  await commitReviewed(kolab, product, dave, P, { elements: els({ E3: 'Timeout 10.' }) });
  const [mark] = (await marksOn(kolab, C)).filter((m) => m.reason === 'override_stale');

  const { version, verdict } = await kolab.resolveOverride(product, mark.id, 'reaffirm');
  expect(verdict.in_review).toBe(true);
  expect(await markState(kolab, mark.id)).toBe('open');
  expect((await kolab.db.query(`select 1 from precedent`)).rows).toStrictEqual([]);

  expect((await kolab.recordReview(dave, version, { verdict: 'approve' })).ok).toBe(true);
  expect(await markState(kolab, mark.id)).toBe('cleared');
  expect((await kolab.db.query(`select resolution, ruled_by from precedent`)).rows).toStrictEqual([{ resolution: 'reaffirm', ruled_by: 'alice' }]);
  expect(await kolab.openQueries()).toStrictEqual([]);
});

test('a reviewer who gained Write on the layer after submission can still review; an ended session can\'t', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  await kolab.review(v1);
  await people(kolab, 'erin', { layers: ['functional'] });
  const erin = await kolab.openSession('erin', 'product');
  expect((await kolab.recordReview(erin, v1, { verdict: 'approve' })).ok).toBe(true);
  expect((await kolab.submissions('alice'))[0].verdicts.map((v) => [v.reviewer, v.state])).toStrictEqual([['dave', 'withdrawn'], ['erin', 'approved']]);
  await kolab.endSession(dave);
  const v2 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 20 seconds.' }) });
  await kolab.review(v2);
  expect(await rejection(kolab.recordReview(dave, v2, { verdict: 'approve' }))).toMatch(/RoleError: no open session/);
});

test('an agent can read review requests but never write one, nor move a version into or out of review: only Kolab\'s verbs do (ENF2, ENF3)', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  await people(kolab, 'erin', { layers: ['functional'] });
  await kolab.openSession('erin', 'product');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  await kolab.review(v1);
  const asAgent = (session: string, sql: string, params: unknown[] = []) => kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(session)]);
    return tx.query(sql, params);
  });
  // Requests are readable like versions and questions: every agent sees all of them in its
  // session's kolab, its own and others' (kolab_read; another kolab's are pinned in tenancy.test.ts).
  expect((await asAgent(dave, `select reviewer_id from review_request order by reviewer_id`)).rows).toStrictEqual([{ reviewer_id: 'dave' }, { reviewer_id: 'erin' }]);
  expect((await asAgent(product, `select count(*)::int as n from review_request`)).rows).toStrictEqual([{ n: 2 }]);
  expect(await rejection(asAgent(dave, `update review_request set state = 'approved'`))).toMatch(/permission denied/);
  expect(await rejection(asAgent(dave, `insert into review_request(id, version_id, reviewer_id, state) values ('x', $1, 'dave', 'approved')`, [v1])))
    .toMatch(/permission denied/);
  expect(await rejection(asAgent(product, `insert into version(id, node_id, seq, layer, state, actor_id, active_role)
                                             values ('v-r', $1, 9, 'functional', 'in_review', 'alice', 'product')`, [spec])))
    .toMatch(/row-level security/);
  expect(await kolab.version(v1)).toMatchObject({ state: 'in_review' });
});

// ---- PR #26 review -------------------------------------------------------------------

test('a binding version with work packages is reviewed like any binding version: no plan commits on its checks alone any more (VER3, PLN2, D104)', async () => {
  const { kolab, product, engineer } = await setup();
  await people(kolab, 'erin', { layers: ['technical'] });
  await kolab.openSession('erin', 'engineer');   // another engineer: a reviewer of bindings, and of their work
  await kolab.createNode(product, 'spec', 'Spec', 'spec');
  const b = await kolab.createNode(engineer, 'binding', 'B', 'b');
  const v = await kolab.draft(engineer, b, { elements: [{ id: 'b1', text: 'A queue.' }, { id: 'W1', text: 'Do a thing.', work: { done_when: 'It is done.' } }] });
  const r = await kolab.review(v);
  expect(r).toMatchObject({ ok: false, version: v, in_review: true, reviewers: ['erin'] });
  expect((await kolab.db.query(`select reviewer_id from review_request where version_id = $1`, [v])).rows).toStrictEqual([{ reviewer_id: 'erin' }]);
});

test('a version approved and then folded ends settled as folded into the fold, which the author\'s answers show with the approval', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const parent = await kolab.createNode(product, 'spec', 'P', 'P');
  const p1 = await commitReviewed(kolab, product, dave, parent, { elements: els({ E1: 'one' }) });
  const child = await kolab.createNode(product, 'prototype', 'C', 'C');
  await commitReviewed(kolab, product, dave, child, { parent: p1, deltas: [{ kind: 'add', element: 'X', text: 'x' }] });
  const draft = await kolab.draft(product, child, { deltas: [{ kind: 'add', element: 'Y', text: 'y' }] });
  await kolab.review(draft);
  await commitReviewed(kolab, product, dave, parent, { elements: els({ E1: 'one, revised' }) });
  const r = await kolab.recordReview(dave, draft, { verdict: 'approve', note: 'Fine.' });
  expect(r.ok).toBe(true);
  const fold = await kolab.version(r.version);

  const original = (await kolab.db.query<{ state: string; review_note: string }>(`select state, review_note from version where id = $1`, [draft])).rows[0];
  expect(original).toStrictEqual({ state: 'rejected', review_note: `folded into ${r.version}` });
  const mine = (await kolab.submissions('alice')).filter((s) => s.subject.startsWith('kj:C@') && s.subject !== 'kj:C@1');
  expect(mine.map((s) => [s.subject, s.state, s.folded_into ?? null])).toStrictEqual([
    [`kj:C@${fold.seq}`, 'committed', null],
    ['kj:C@2', 'rejected', `kj:C@${fold.seq}`],
  ]);
  expect(mine[0].verdicts).toStrictEqual([{ reviewer: 'dave', state: 'approved', note: 'Fine.', findings: [] }]);
  expect(mine[1].verdicts.map((v) => v.state)).toStrictEqual(['approved']);
  expect(mine[1].next).toMatch(/^Folded into kj:C@\d+, which carries this edit/);
});

test('on a variant, a move to the top level stays through rebases, folds, edits of its words, the parent coming to the same words, and adopting the parent\'s (W7.2, OVR3)', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const up = (e1: string, e2 = 'two', e3 = 'three') => [
    { id: 'S', text: 'A section' }, { id: 'E1', text: e1, parent: 'S' }, { id: 'E2', text: e2, parent: 'S' }, { id: 'E3', text: e3, parent: 'S' },
  ];
  const upstream = async (e1: string, e2?: string, e3?: string) => {
    const v = await commitReviewed(kolab, product, dave, 'P', { elements: up(e1, e2, e3) });
    await kolab.drainOutbox();
    return v;
  };
  const at = async (node: string) => Object.fromEntries((await kolab.elements((await kolab.latestCommitted(node))!.id)).map((e) => [e.element_id, [e.parent_element_id, e.text]]));
  await kolab.createNode(product, 'spec', 'P', 'P');
  const p1 = await commitReviewed(kolab, product, dave, 'P', { elements: up('one') });
  await kolab.createNode(product, 'prototype', 'C', 'C');
  const moved = [{ id: 'S', text: 'A section' }, { id: 'E1', text: 'one', parent: null }, { id: 'E2', text: 'two', parent: 'S' }, { id: 'E3', text: 'three', parent: 'S' }];
  await commitReviewed(kolab, product, dave, 'C', { parent: p1, elements: moved });
  expect((await at('C')).E1).toStrictEqual([null, 'one']);

  // Upstream changes something else: the rebase keeps the move, and marks nothing.
  await upstream('one', 'two, revised');
  expect(await at('C')).toMatchObject({ E1: [null, 'one'], E2: ['S', 'two, revised'] });
  expect(await kolab.openMarks()).toStrictEqual([]);

  // A move waiting in review: the approval folds it, with the move, and nothing puts it back.
  const draft = await kolab.draft(product, 'C', { elements: [moved[0], moved[1], { id: 'E2', text: 'two, revised', parent: null }, moved[3]] });
  await kolab.review(draft);
  await upstream('one', 'two, revised', 'three, revised');
  expect((await at('C')).E2).toStrictEqual(['S', 'two, revised']);
  const fold = await kolab.recordReview(dave, draft, { verdict: 'approve' });
  expect(fold).toMatchObject({ ok: true });
  expect(fold.version).not.toBe(draft);
  expect(await at('C')).toMatchObject({ E1: [null, 'one'], E2: [null, 'two, revised'], E3: ['S', 'three, revised'] });
  await upstream('one', 'two, revised', 'three, again');
  expect(await at('C')).toMatchObject({ E1: [null, 'one'], E2: [null, 'two, revised'], E3: ['S', 'three, again'] });

  // A delta on a moved element leaves it moved, and a later rebase too.
  await commitReviewed(kolab, product, dave, 'C', { deltas: [{ kind: 'override', element: 'E2', text: 'two, its way' }] });
  expect((await at('C')).E2).toStrictEqual([null, 'two, its way']);
  await upstream('one', 'two, revised', 'three, once more');
  expect(await at('C')).toMatchObject({ E1: [null, 'one'], E2: [null, 'two, its way'] });

  // Upstream comes to the same words: the override has nothing left to say of them, but the move stands.
  await upstream('one', 'two, its way', 'three, once more');
  expect(await at('C')).toMatchObject({ E2: [null, 'two, its way'] });
  expect(await kolab.openMarks()).toStrictEqual([]);
  await upstream('one', 'two, later', 'three, once more');
  expect(await at('C')).toMatchObject({ E2: [null, 'two, later'] });

  // Upstream rewrites a moved element: its override goes stale, and stays moved. Adopting the parent's words keeps the move.
  await upstream('one, rewritten', 'two, later', 'three, once more');
  expect((await at('C')).E1).toStrictEqual([null, 'one']);
  const [mark] = await kolab.openMarks();
  expect(mark).toMatchObject({ reason: 'override_stale', element_id: 'E1' });
  const { version } = await kolab.resolveOverride(product, mark.id, 'adopt_parent');
  await kolab.recordReview(dave, version, { verdict: 'approve' });
  expect((await at('C')).E1).toStrictEqual([null, 'one, rewritten']);

  // So does the precedent that sets, on another variant in the same place.
  await kolab.createNode(product, 'prototype', 'D', 'D');
  await commitReviewed(kolab, product, dave, 'D', { parent: p1, elements: moved });
  await upstream('one, rewritten', 'two, later', 'three, last');
  expect((await at('D')).E1).toStrictEqual([null, 'one, rewritten']);
  expect(await kolab.openMarks()).toStrictEqual([]);
});

describe.each(['variant', 'fork'])('on a %s, a move to the top level (W7.2, OVR3)', (shape) => {
  /** Ann's spec upstream, and over it a node of `shape`: hers in the same kolab, or Lee's in another. */
  async function moving() {
    const kolab = await openKolab();
    await people(kolab, 'ann', { layers: ['functional'] });
    const ann = await kolab.openSession('ann', 'product');
    const up = (e1: string, e2 = 'two') => [{ id: 'S', text: 'A section' }, { id: 'T', text: 'Another' }, { id: 'E1', text: e1, parent: 'S' }, { id: 'E2', text: e2, parent: 'S' }];
    await kolab.createNode(ann, 'spec', 'Upstream', 'up');
    await kolab.commit(ann, 'up', { elements: up('one') });
    const v1 = (await kolab.latestCommitted('up'))!;
    let s = ann;
    if (shape === 'fork') {
      await kolab.createKolab('forked', { owner: 'test-org' });
      await kolab.addActor('lee');
      await kolab.grant('forked', 'lee', 'admin');
      await kolab.grant(TEST_KOLAB, 'lee', 'read');
      s = await kolab.openSession('lee', 'product', { kolab: 'forked' });
    }
    const node = await kolab.createNode(s, shape === 'fork' ? 'spec' : 'prototype', 'Mine', 'mine');
    await kolab.submit(s, await kolab.draft(s, node, { parent: v1.id, deltas: [] }));
    expect((await kolab.version((await kolab.latestCommitted(node))!.parent_version_id!)).kolab_id).toBe(TEST_KOLAB);
    const at = async () => Object.fromEntries((await kolab.elements((await kolab.latestCommitted(node))!.id)).map((e) => [e.element_id, [e.parent_element_id, e.text]]));
    return {
      kolab, node, at, up, ann, s,
      mine: async (input: Parameters<typeof kolab.draft>[2]) => {
        const r = await kolab.submit(s, await kolab.draft(s, node, input));
        expect(r).toMatchObject({ ok: true });
      },
      upstream: async (e1: string, e2?: string) => { await kolab.commit(ann, 'up', { elements: up(e1, e2) }); await kolab.drainOutbox(); },
      rows: async () => (await kolab.db.query<{ element_id: string; top_level: boolean; text: string | null }>(
        `select element_id, top_level, text from delta where version_id = $1 order by element_id`, [(await kolab.latestCommitted(node))!.id])).rows,
    };
  }

  test('a delta saying parent null holds only the move: it follows upstream\'s words, asks nothing, and stays moved', async () => {
    const { kolab, at, mine, upstream, rows } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: null }] });
    expect(await at()).toMatchObject({ E1: [null, 'one'], E2: ['S', 'two'] });
    expect(await rows()).toStrictEqual([{ element_id: 'E1', top_level: true, text: null }]);
    await upstream('one, later');
    expect(await at()).toMatchObject({ E1: [null, 'one, later'] });
    await upstream('one, later', 'two, later');
    expect(await at()).toMatchObject({ E1: [null, 'one, later'], E2: ['S', 'two, later'] });
    expect(await kolab.openMarks()).toStrictEqual([]);
  });

  test('its own words that upstream comes to leave only the move, and it follows upstream from there', async () => {
    const { kolab, at, mine, upstream, rows } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', text: 'one, mine', parent: null }] });
    await upstream('one, mine');
    expect(await at()).toMatchObject({ E1: [null, 'one, mine'] });
    expect(await rows()).toStrictEqual([{ element_id: 'E1', top_level: true, text: null }]);
    await upstream('one, after');
    expect(await at()).toMatchObject({ E1: [null, 'one, after'] });
    expect(await kolab.openMarks()).toStrictEqual([]);
  });

  test('a full list that leaves its parent out keeps it moved; naming the section moves it back, and it then follows upstream\'s place', async () => {
    const { at, mine, upstream, rows, up } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: null }] });
    const list = up('one').map(({ id, text }) => ({ id, text }));
    await mine({ elements: list.map((e) => (e.id === 'E2' ? { ...e, text: 'two, mine' } : e)) });
    expect(await at()).toMatchObject({ E1: [null, 'one'], E2: ['S', 'two, mine'] });
    await upstream('one');
    expect(await at()).toMatchObject({ E1: [null, 'one'] });
    await mine({ elements: up('one') });
    expect(await at()).toMatchObject({ E1: ['S', 'one'] });
    expect((await rows()).filter((r) => r.top_level)).toStrictEqual([]);
  });

  test('a delta on an element moved into another section keeps it there; a full list that leaves its parent out returns it', async () => {
    const { at, mine, up } = await moving();
    await mine({ elements: up('one').map((e) => (e.id === 'E1' ? { ...e, parent: 'T' } : e)) });
    expect((await at()).E1).toStrictEqual(['T', 'one']);
    await mine({ deltas: [{ kind: 'override', element: 'E1', text: 'one, mine' }] });
    expect((await at()).E1).toStrictEqual(['T', 'one, mine']);
    // Only a move to the top level outlives a full list that leaves its parent out.
    await mine({ elements: up('one').map(({ id, text }) => ({ id, text })) });
    expect((await at()).E1).toStrictEqual(['S', 'one']);
  });

  test('a move that leaves out the text keeps the element\'s own words, and so does moving it back into a section', async () => {
    const { kolab, at, mine, rows } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', text: 'one, mine' }] });
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: null }] });
    expect((await at()).E1).toStrictEqual([null, 'one, mine']);
    expect(await rows()).toStrictEqual([{ element_id: 'E1', top_level: true, text: 'one, mine' }]);
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: 'S' }] });
    expect((await at()).E1).toStrictEqual(['S', 'one, mine']);
    expect(await rows()).toStrictEqual([{ element_id: 'E1', top_level: false, text: 'one, mine' }]);
    expect(await kolab.openMarks()).toStrictEqual([]);
  });

  test('a move leaves a question open on the element\'s words open, and adopting then keeps the move', async () => {
    const { kolab, at, mine, upstream, s } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', text: 'one, mine' }] });
    await upstream('one, new');
    const [asked] = await kolab.openMarks();
    expect(asked).toMatchObject({ reason: 'override_stale', element_id: 'E1' });
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: null }] });
    expect((await at()).E1).toStrictEqual([null, 'one, mine']);
    const [still] = await kolab.openMarks();
    expect(still).toMatchObject({ reason: 'override_stale', element_id: 'E1' });
    await kolab.resolveOverride(s, still.id, 'adopt_parent');
    expect((await at()).E1).toStrictEqual([null, 'one, new']);
    expect(await kolab.openMarks()).toStrictEqual([]);
  });

  test('a move leaves what the words rest on: upstream going back to them settles the question', async () => {
    const { kolab, at, mine, upstream } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', text: 'one, mine' }] });
    await upstream('one, new');
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: null }] });
    expect(await kolab.openMarks()).toHaveLength(1);
    await upstream('one');
    expect((await at()).E1).toStrictEqual([null, 'one, mine']);
    expect(await kolab.openMarks()).toStrictEqual([]);
  });

  test('upstream moving it to the top level itself, with new words or the variant\'s, and back leaves it moved', async () => {
    const { kolab, at, mine, upstream, rows, ann } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: null }, { kind: 'override', element: 'E2', text: 'two, mine', parent: null }] });
    await kolab.commit(ann, 'up', { elements: [{ id: 'S', text: 'A section' }, { id: 'T', text: 'Another' }, { id: 'E1', text: 'one, new', parent: null }, { id: 'E2', text: 'two, mine', parent: null }] });
    await kolab.drainOutbox();
    expect(await rows()).toStrictEqual([{ element_id: 'E1', top_level: true, text: null }, { element_id: 'E2', top_level: true, text: null }]);
    await upstream('one, new', 'two, mine');
    expect(await at()).toMatchObject({ E1: [null, 'one, new'], E2: [null, 'two, mine'] });
    expect(await kolab.openMarks()).toStrictEqual([]);
  });

  test('a draft while upstream has it at the top level too keeps the move, by a delta and by a full list', async () => {
    const { kolab, at, mine, upstream, ann } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: null }, { kind: 'override', element: 'E2', parent: null }] });
    const top = [{ id: 'S', text: 'A section' }, { id: 'T', text: 'Another' }, { id: 'E1', text: 'one', parent: null }, { id: 'E2', text: 'two', parent: null }];
    await kolab.commit(ann, 'up', { elements: top });
    await kolab.drainOutbox();
    await mine({ deltas: [{ kind: 'override', element: 'E1', text: 'one, mine', parent: null }] });
    await upstream('one');
    expect(await at()).toMatchObject({ E1: [null, 'one, mine'], E2: [null, 'two'] });
    await kolab.commit(ann, 'up', { elements: top });
    await kolab.drainOutbox();
    await mine({ elements: top.map(({ id, text }) => ({ id, text })) });
    await upstream('one');
    expect(await at()).toMatchObject({ E1: [null, 'one'], E2: [null, 'two'] });
  });

  const intoSection = [{ id: 'S', text: 'A section' }, { id: 'T', text: 'Another', parent: 'S' }, { id: 'E1', text: 'one', parent: 'S' }, { id: 'E2', text: 'two', parent: 'S' }];

  test('a delta saying parent null on what upstream has at the top level moves nothing, so it follows upstream into a section', async () => {
    const { kolab, at, mine, rows, ann } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'T', text: 'another, mine', parent: null }] });
    expect(await rows()).toStrictEqual([{ element_id: 'T', top_level: false, text: 'another, mine' }]);
    await kolab.commit(ann, 'up', { elements: intoSection });
    await kolab.drainOutbox();
    expect((await at()).T).toStrictEqual(['S', 'another, mine']);
  });

  test('a full list saying parent null on what upstream has at the top level moves nothing, so it follows upstream into a section', async () => {
    const { kolab, at, mine, rows, up, ann } = await moving();
    await mine({ elements: up('one').map((e) => (e.id === 'T' ? { id: 'T', text: 'another, mine', parent: null } : e)) });
    expect((await rows()).filter((r) => r.top_level)).toStrictEqual([]);
    await kolab.commit(ann, 'up', { elements: intoSection });
    await kolab.drainOutbox();
    expect((await at()).T).toStrictEqual(['S', 'another, mine']);
  });

  test('a removal is never a move', async () => {
    const { at, mine, rows } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: null }] });
    await mine({ deltas: [{ kind: 'remove', element: 'E1' }, { kind: 'remove', element: 'E2', parent: null }] });
    expect(await rows()).toStrictEqual([{ element_id: 'E1', top_level: false, text: null }, { element_id: 'E2', top_level: false, text: null }]);
    expect(Object.keys(await at()).sort()).toStrictEqual(['S', 'T']);
  });

  test('removing a section removes what the variant moved into it, whether the same draft edits that or not', async () => {
    for (const also of [[], [{ kind: 'override' as const, element: 'E1', text: 'one, mine' }]]) {
      const { at, mine, up } = await moving();
      await mine({ elements: up('one').map((e) => (e.id === 'E1' ? { ...e, parent: 'T' } : e)) });
      await mine({ deltas: [{ kind: 'remove', element: 'T' }, ...also] });
      expect(Object.keys(await at()).sort()).toStrictEqual(['E2', 'S']);
    }
  });

  test('what holds only the move, removed upstream and added back, follows upstream again and asks nothing', async () => {
    const { kolab, at, mine, up, upstream, ann, rows } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: null }] });
    const without = up('one').filter((e) => e.id !== 'E1');
    await kolab.commit(ann, 'up', { elements: without });
    await kolab.drainOutbox();
    expect((await at()).E1).toStrictEqual([null, 'one']);
    await upstream('one');
    expect((await at()).E1).toStrictEqual([null, 'one']);
    expect(await rows()).toStrictEqual([{ element_id: 'E1', top_level: true, text: null }]);
    expect(await kolab.openMarks()).toStrictEqual([]);
    await upstream('one, after');
    expect((await at()).E1).toStrictEqual([null, 'one, after']);
    expect(await kolab.openMarks()).toStrictEqual([]);
    // Added back with other words, it takes them.
    await kolab.commit(ann, 'up', { elements: without });
    await kolab.drainOutbox();
    await upstream('one, back');
    expect((await at()).E1).toStrictEqual([null, 'one, back']);
    expect(await kolab.openMarks()).toStrictEqual([]);
  });

  test('a move with words of its own, removed upstream and added back, keeps them', async () => {
    const { kolab, at, mine, up, upstream, ann } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', text: 'one, mine', parent: null }] });
    await kolab.commit(ann, 'up', { elements: up('one').filter((e) => e.id !== 'E1') });
    await kolab.drainOutbox();
    await upstream('one');
    expect((await at()).E1).toStrictEqual([null, 'one, mine']);
  });

  test('upstream removing what holds only the move leaves its words, and asks', async () => {
    const { kolab, at, mine, up, node, ann } = await moving();
    await mine({ deltas: [{ kind: 'override', element: 'E1', parent: null }] });
    await kolab.commit(ann, 'up', { elements: up('one').filter((e) => e.id !== 'E1') });
    await kolab.drainOutbox();
    expect((await at()).E1).toStrictEqual([null, 'one']);
    expect((await kolab.openMarks()).map((m) => [m.reason, m.element_id])).toStrictEqual([['override_orphaned', 'E1']]);
    expect((await kolab.latestCommitted(node))!.state).toBe('committed');
  });
});

test('on a variant of a binding, what holds only the move follows upstream\'s work fields, and asks nothing; a move with work fields of its own is asked about (W7.2, OVR3)', async () => {
  const { kolab, product, engineer } = await setup();
  await kolab.createNode(product, 'spec', 'The spec', 'spec');
  const up = (w1: object, w2: object) => [{ id: 'S', text: 'A section' }, { id: 'W1', text: 'One.', parent: 'S', work: w1 }, { id: 'W2', text: 'Two.', parent: 'S', work: w2 }];
  await kolab.createNode(engineer, 'binding', 'B', 'b');
  const v1 = await kolab.commit(engineer, 'b', { elements: up({ size: 'S' }, { size: 'S' }) });
  await kolab.createNode(engineer, 'binding', 'C', 'c');
  await kolab.commit(engineer, 'c', { parent: v1, deltas: [{ kind: 'override', element: 'W1', parent: null }, { kind: 'override', element: 'W2', parent: null, work: { size: 'L' } }] });
  const at = async () => Object.fromEntries((await kolab.elements((await kolab.latestCommitted('c'))!.id)).map((e) => [e.element_id, [e.parent_element_id, e.work?.size]]));
  expect(await at()).toMatchObject({ W1: [null, 'S'], W2: [null, 'L'] });
  await kolab.commit(engineer, 'b', { elements: up({ size: 'M' }, { size: 'M' }) });
  await kolab.drainOutbox();
  expect(await at()).toMatchObject({ W1: [null, 'M'], W2: [null, 'L'] });
  expect((await kolab.openMarks()).map((m) => [m.reason, m.element_id])).toStrictEqual([['override_stale', 'W2']]);
});

test('on a variant of a binding, a delta that leaves out the work fields keeps the element\'s own, by a move and by new words (W7.2, OVR3)', async () => {
  const { kolab, product, engineer } = await setup();
  await kolab.createNode(product, 'spec', 'The spec', 'spec');
  await kolab.createNode(engineer, 'binding', 'B', 'b');
  const v1 = await kolab.commit(engineer, 'b', { elements: [{ id: 'S', text: 'A section' }, { id: 'W1', text: 'One.', parent: 'S', work: { size: 'S' } }, { id: 'W2', text: 'Two.', parent: 'S', work: { size: 'S' } }] });
  await kolab.createNode(engineer, 'binding', 'C', 'c');
  await kolab.commit(engineer, 'c', { parent: v1, deltas: [{ kind: 'override', element: 'W1', work: { size: 'L' } }] });
  const w1 = async () => { const e = (await kolab.elements((await kolab.latestCommitted('c'))!.id)).find((x) => x.element_id === 'W1')!; return [e.parent_element_id, e.text, e.work?.size]; };
  await kolab.commit(engineer, 'c', { deltas: [{ kind: 'override', element: 'W1', parent: null }] });
  expect(await w1()).toStrictEqual([null, 'One.', 'L']);
  await kolab.commit(engineer, 'c', { deltas: [{ kind: 'override', element: 'W1', text: 'One, mine.' }] });
  expect(await w1()).toStrictEqual([null, 'One, mine.', 'L']);
  // A removal holds no work fields to keep: bringing the element back brings the parent's.
  await kolab.commit(engineer, 'c', { deltas: [{ kind: 'remove', element: 'W2' }] });
  await kolab.commit(engineer, 'c', { deltas: [{ kind: 'override', element: 'W2', text: 'Two, back.' }] });
  expect((await kolab.elements((await kolab.latestCommitted('c'))!.id)).find((x) => x.element_id === 'W2')!.work).toStrictEqual({ size: 'S' });
});

test('an override resolution folded at approval still sets precedent and settles its mark (OVR8, OVR9)', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const P = await kolab.createNode(product, 'spec', 'P', 'P');
  const p1 = await commitReviewed(kolab, product, dave, P, { elements: els({ E3: 'Timeout 15.', E4: 'a' }) });
  const C = await kolab.createNode(product, 'prototype', 'C', 'C');
  await commitReviewed(kolab, product, dave, C, { parent: p1, deltas: [{ kind: 'override', element: 'E3', text: 'Timeout 30.' }] });
  await commitReviewed(kolab, product, dave, P, { elements: els({ E3: 'Timeout 10.', E4: 'a' }) });
  const [mark] = (await marksOn(kolab, C)).filter((m) => m.reason === 'override_stale');
  const { version, verdict } = await kolab.resolveOverride(product, mark.id, 'reaffirm');
  expect(verdict.in_review).toBe(true);
  await commitReviewed(kolab, product, dave, P, { elements: els({ E3: 'Timeout 10.', E4: 'b' }) });   // rebases C meanwhile
  const r = await kolab.recordReview(dave, version, { verdict: 'approve' });
  expect([r.ok, r.version === version]).toStrictEqual([true, false]);   // committed as a fold
  expect(await markState(kolab, mark.id)).toBe('cleared');
  expect((await kolab.db.query(`select resolution from precedent`)).rows).toStrictEqual([{ resolution: 'reaffirm' }]);
  expect(await kolab.openQueries()).toStrictEqual([]);
});

test('a person\'s version that fails Kolab\'s checks stays drafted with the reason, rather than rejected (VER2, D33)', async () => {
  let contradiction = false;
  const { kolab, product } = await setup(async (ctx) => (contradiction
    ? { ok: false, note: 'R1 contradicts R2.' }
    : (await import('@konjir/engine')).structuralChecks(ctx)));
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  const bad = await kolab.draft(product, spec, { elements: els({ R1: 'Same.', R2: 'Same.' }) });
  const r = await kolab.review(bad);
  expect(r).toMatchObject({ ok: false, version: bad });
  expect(r.note).toMatch(/R2 repeats R1 word for word/);
  expect(await kolab.version(bad)).toMatchObject({ state: 'drafted' });
  expect((await kolab.db.query<{ review_note: string }>(`select review_note from version where id = $1`, [bad])).rows[0].review_note).toBe(r.note);
  // A version a test's checks veto at submission returns the same way; resubmitted once they pass, it commits.
  const v = await kolab.draft(product, spec, { elements: els({ R1: 'One.', R2: 'Two.' }) });
  contradiction = true;
  expect(await kolab.review(v)).toMatchObject({ ok: false });
  expect(await kolab.version(v)).toMatchObject({ state: 'drafted' });
  contradiction = false;
  expect((await kolab.review(v)).ok).toBe(true);
  await kolab.abandon(product, bad);
  expect(await kolab.version(bad)).toMatchObject({ state: 'rejected' });
});

test('a version in review whose reviewers have all lost Write can be resubmitted: with no reviewer left it commits on structural checks (VER11)', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  await kolab.review(v1);
  // While someone can still review it, resubmitting re-asks them, adding anyone new.
  await people(kolab, 'erin', { layers: ['functional'] });
  const erin = await kolab.openSession('erin', 'product');
  expect(await kolab.review(v1)).toMatchObject({ ok: false, in_review: true, reviewers: ['dave', 'erin'] });
  expect((await kolab.reviewRequests()).map((x) => x.reviewer)).toStrictEqual(['dave', 'erin']);
  // Their Write is revoked (which ends their sessions): no one can review it now.
  await kolab.revoke(TEST_KOLAB, 'dave');
  await kolab.revoke(TEST_KOLAB, 'erin');
  const r = await kolab.review(v1);
  expect(r).toMatchObject({ ok: true, unreviewed: true, version: v1 });
  expect(await kolab.version(v1)).toMatchObject({ state: 'committed' });
  expect(await kolab.reviewRequests()).toStrictEqual([]);
});

test('approving a version that was abandoned, or rejected as stale, says why; abandoning a settled version reports it', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  await kolab.review(v1);
  expect(await kolab.abandon(product, v1)).toBe('rejected');
  expect(await rejection(kolab.recordReview(dave, v1, { verdict: 'approve' }))).toMatch(/GateError: checkout@1 was rejected \(abandoned by alice\); there is nothing to review/);
  const v2 = await commitReviewed(kolab, product, dave, spec, { elements: els({ R1: 'Checkout completes in 20 seconds.' }) });
  expect(await rejection(kolab.abandon(product, v2))).toMatch(/GateError: checkout@2 is committed; only a draft or a version in review can be abandoned/);
});

test('Kolab\'s own checks are structural and report no findings: a layer leak is the reviewer\'s to report (REV5, VER5, VER7)', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Orders are stored in Postgres.' }) });
  const r = await kolab.review(v1);
  expect(r).toMatchObject({ in_review: true, reviewers: ['dave'] });
  expect(r.findings).toBeUndefined();
  expect(r.note).toMatch(/Kolab checks structure only: contradictions and layer leaks are for its reviewers\. Waiting for one approval from dave\./);
  // Nothing about a version's findings is kept on the version: only reviewers report them, on their requests.
  expect((await kolab.db.query(`select 1 from information_schema.columns where table_name = 'version' and column_name = 'findings'`)).rows).toStrictEqual([]);
  // A reviewer who approves without reporting the leak commits it unmarked; Kolab doesn't judge it.
  expect((await kolab.recordReview(dave, v1, { verdict: 'approve' })).ok).toBe(true);
  expect(await marksOn(kolab, spec)).toStrictEqual([]);
});

test('a ruling applied to the mirror commits after structural checks only, with no review request, and its note records it (D47)', async () => {
  const { kolab, product, dave } = await twoProductOwners();
  await people(kolab, 'mirror-product', { layers: ['functional'] });
  const spec = await kolab.createNode(product, 'spec', 'Kolab', 'kolab');
  await commitReviewed(kolab, product, dave, spec, { elements: els({ R1: 'One spec per kolab.' }) });
  const waiting = await kolab.draft(product, spec, { elements: els({ R1: 'One spec per kolab, alice says.' }) });
  expect((await kolab.review(waiting)).in_review).toBe(true);

  const r = await kolab.applyRuling(spec, { deltas: [{ kind: 'add', element: 'R2', text: 'Rulings commit on structural checks.' }] }, { id: 'D47', actor: 'mirror-product' });
  expect(r).toMatchObject({ ok: true });
  expect(r.in_review).toBeUndefined();
  const v = await kolab.version(r.version);
  expect(v).toMatchObject({ state: 'committed', actor_id: 'mirror-product', active_role: 'product' });
  expect(r.note).toMatch(/^Applied as ruling D47 through the admin token, written as mirror-product: the ruling is the approval, so structural checks alone committed it, without review \(D47\)\./);
  expect((await kolab.db.query(`select 1 from review_request where version_id = $1`, [r.version])).rows).toStrictEqual([]);
  expect(await textOf(kolab, spec)).toStrictEqual({ R1: 'One spec per kolab.', R2: 'Rulings commit on structural checks.' });
  // It commits like anyone's commit: what waited in review on the node is now stale.
  expect(await kolab.version(waiting)).toMatchObject({ state: 'rejected' });
  // It still passes the structural checks, and names a ruling and a real actor.
  const bad = await kolab.applyRuling(spec, { deltas: [{ kind: 'add', element: 'R3', text: 'One spec per kolab.' }] }, { id: 'D47', actor: 'mirror-product' });
  expect(bad.ok).toBe(false);
  // A ruling has no author to return to: one that fails its checks is rejected, not left for anyone to submit.
  expect(await kolab.version(bad.version)).toMatchObject({ state: 'rejected' });
  // The actor it is written as must hold Write on the layer there; otherwise nothing is written at all.
  const before = (await kolab.db.query(`select id from version`)).rows.length;
  expect(await rejection(kolab.applyRuling(spec, { deltas: [{ kind: 'add', element: 'R4', text: 'Carol rules.' }] }, { id: 'D47', actor: 'carol' })))
    .toMatch(/AccessError: carol may not write the functional layer of kolab test: it holds Read; apply the ruling as an actor that does/);
  expect((await kolab.db.query(`select id from version`)).rows.length).toBe(before);
  expect(await rejection(kolab.applyRuling(spec, { deltas: [] }, { id: 'because', actor: 'mirror-product' }))).toMatch(/GateError: a ruling is named by its Decisions Log ID/);
  expect(await rejection(kolab.applyRuling(spec, { deltas: [] }, { id: 'D47', actor: 'nobody' }))).toMatch(/ActorError: no actor nobody/);
});

test('reviewers are whoever holds Write on the layer in the version\'s kolab, whatever their sessions: not a reader with a session, but a writer with none or in the other role (VER16)', async () => {
  const { kolab, product } = await setup();
  await kolab.openSession('carol', 'product');                       // Read only: a session doesn't make her a reviewer
  await people(kolab, 'erin', { layers: ['functional', 'technical'] });
  const erinEng = await kolab.openSession('erin', 'engineer');        // Write on the spec's layer, in the other role
  await people(kolab, 'frank', { layers: ['functional'] });           // Write, never connected
  const spec = await kolab.createNode(product, 'spec', 'Checkout', 'checkout');
  const v1 = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  expect(await kolab.review(v1)).toMatchObject({ in_review: true, reviewers: ['erin', 'frank'] });
  // A reviewer may give a verdict only from a session in the layer's role.
  expect(await rejection(kolab.recordReview(erinEng, v1, { verdict: 'approve' }))).toMatch(/RoleError: an engineer session may not write the functional layer/);
  // An author who loses Write while the version waits: the approval rejects it rather than commit it.
  await kolab.grant(TEST_KOLAB, 'alice', 'read');
  const frank = await kolab.openSession('frank', 'product');
  expect(await kolab.recordReview(frank, v1, { verdict: 'approve' })).toMatchObject({ ok: false, note: expect.stringMatching(/its author alice no longer holds Write on the functional layer/) });
  expect(await kolab.version(v1)).toMatchObject({ state: 'rejected' });
});

test('a ruling overtaken by Kolab\'s rebase while its checks run is folded, and the fold still commits on structural checks, without review (D47)', async () => {
  let during: (() => Promise<void>) | undefined;
  const { kolab, product } = await setup(undefined, async (ctx) => {
    const hook = during;
    during = undefined;
    await hook?.();
    return structuralChecks(ctx);
  });
  await people(kolab, 'mirror-product', { layers: ['functional'] });
  const mirror = await kolab.openSession('mirror-product', 'product');   // a reviewer of alice's versions
  const P = await kolab.createNode(product, 'spec', 'P', 'P');
  const p1 = await commitReviewed(kolab, product, mirror, P, { elements: els({ E1: 'one' }) });
  const V0 = await kolab.createNode(product, 'prototype', 'V0', 'V0');
  await commitReviewed(kolab, product, mirror, V0, { parent: p1, deltas: [{ kind: 'add', element: 'X', text: 'x' }] });
  // While the ruling's checks run, the parent commits, and Kolab's rebase of V0 overtakes it.
  during = async () => { await commitReviewed(kolab, product, mirror, P, { elements: els({ E1: 'one, revised' }) }); };

  const r = await kolab.applyRuling(V0, { deltas: [{ kind: 'add', element: 'R', text: 'Ruled.' }] }, { id: 'D47', actor: 'mirror-product' });
  expect(r).toMatchObject({ ok: true });
  expect(r.in_review).toBeUndefined();
  expect(await kolab.version(r.version)).toMatchObject({ state: 'committed', actor_id: 'mirror-product' });
  expect(r.note).toMatch(/^Applied as ruling D47 through the admin token/);
  expect(await textOf(kolab, V0)).toStrictEqual({ E1: 'one, revised', X: 'x', R: 'Ruled.' });
  expect((await kolab.db.query(`select 1 from review_request where version_id = $1`, [r.version])).rows).toStrictEqual([]);
  expect((await kolab.db.query<{ seq: number; active_role: string; state: string }>(
    `select seq, active_role, state from version where node_id = $1 order by seq`, [V0])).rows.map((v) => [v.seq, v.active_role, v.state]))
    .toStrictEqual([[1, 'product', 'committed'], [2, 'product', 'rejected'], [3, 'system', 'committed'], [4, 'product', 'committed']]);
});
