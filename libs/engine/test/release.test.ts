// Done means released where a package says so (W7.7; PLN16; migration 0047): a package whose work
// field says release: true stays In review after its approval, shown as approved and waiting for
// its release, until a release (the deploy run and the commit it released) is recorded, and is then
// Done; a package without it is Done on approval; a milestone over it isn't Done before it is.
import { expect, test } from '@jest/globals';
import { checkReleaseInput, checkWork, type Kolab } from '@konjir/engine';
import { commitReviewed, els, openKolab, people, registeredRepository, rejection } from '@konjir/engine/testing';
import type { ElementInput } from '@konjir/types';

const PLAN: ElementInput[] = [
  { id: 'W1.1', text: 'Build the cancel endpoint.', work: { done_when: 'POST /orders/:id/cancel cancels an order.', size: 'M', release: true } },
  { id: 'W1.2', text: 'Build the shipping queue.', work: { size: 'S' } },
  { id: 'M1', text: 'Orders run end to end.', work: { milestone: true, depends_on: ['W1.1', 'W1.2'] } },
];

const sha = (c: string) => c.repeat(40);
const COMMIT = (c = 'a') => ({ kind: 'commit' as const, sha: sha(c), title: `Build it (${c})` });
const RUN = 'https://github.com/acme/orders/actions/runs/123';
const W = (id: string) => `kj:orders-pg#${id}`;

/**
 * A kolab with a spec of two requirements and a binding of two decisions, its work packages above
 * each relying on one; bob builds, eve and frank review, carol only reads, and alice writes the
 * functional layer.
 */
async function planned() {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const product = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'engineer');
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.', R2: 'Orders ship in a day.' }) });
  await kolab.createNode(bob, 'binding', 'Orders on Postgres', 'orders-pg');
  const spec = (await kolab.latestCommitted('orders'))!.id;
  const decisions = els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.' });
  const bv = await kolab.draft(bob, 'orders-pg', {
    elements: decisions, links: ['b1', 'b2'].map((b, i) => ({ kind: 'dependency' as const, sourceElement: b, target: spec, targetElement: `R${i + 1}` })),
  });
  expect((await kolab.submit(bob, bv)).ok).toBe(true);
  const relies = (from: string, to: string) => ({ kind: 'dependency' as const, sourceElement: from, target: bv, targetElement: to });
  const pv = await kolab.draft(bob, 'orders-pg', { elements: [...decisions, ...PLAN], links: [relies('W1.1', 'b1'), relies('W1.2', 'b2')] });
  expect((await kolab.submit(bob, pv)).ok).toBe(true);
  await registeredRepository(kolab, { binding: 'orders-pg' });
  await people(kolab, ['eve', 'frank'], { layers: ['technical'] });
  await people(kolab, 'carol', { level: 'read' });
  const eve = await kolab.openSession('eve', 'engineer');
  const frank = await kolab.openSession('frank', 'engineer');
  return { kolab, product, bob, eve, frank, decisions };
}

/** Pulls `id` as `session` (the first ready one), records a commit and submits it. */
async function submitted(kolab: Kolab, session: string, id: string) {
  const r = await kolab.pullWork(session);
  if (!r.pulled) throw new Error(r.why);
  expect(r.item.id).toBe(id);
  return kolab.submitWork(session, W(id), { evidence: [COMMIT(id === 'W1.1' ? 'a' : 'b')] });
}

const state = async (kolab: Kolab, id: string) =>
  (await kolab.db.query<{ state: string; approved: boolean }>(`select state, approved from work_package where element_id = $1`, [id])).rows[0];

test('a work package that must be released says release: true, and nothing else; a milestone never does (W7.7)', () => {
  expect(checkWork('W1', { release: true })).toStrictEqual({ work: { release: true }, problems: [], limit: false });
  expect(checkWork('W1', { done_when: 'It works.', release: true, size: 'S' }).work).toStrictEqual({ done_when: 'It works.', size: 'S', release: true });
  expect(checkWork('W1', { release: false }).problems).toStrictEqual(['W1\'s release is false: a work package that must be released says release: true, and one that needn\'t be leaves release out']);
  expect(checkWork('M1', { milestone: true, depends_on: ['W1'], release: true }).problems)
    .toStrictEqual(['M1 is a milestone, which has no work of its own to release (PLN3): set release on its members, and leave it out here']);
});

test('a release names its deploy run and the commit it released, and is never a package\'s own evidence (W7.7)', () => {
  expect(checkReleaseInput({ run: RUN, sha: sha('C') }).item).toStrictEqual({ kind: 'release', ref: sha('c'), url: RUN, title: null, files: null, repo: null });
  expect(checkReleaseInput({ sha: sha('c') }).problems).toStrictEqual(['a release names the deploy run that released it, by its https link, as run']);
  expect(checkReleaseInput({ run: RUN }).problems[0]).toMatch(/^a release names the commit it released by its full sha/);
  expect(checkReleaseInput({ run: 'http://ci/1', sha: sha('c') }).problems[0]).toMatch(/^the release's run is an https link/);
  expect(checkReleaseInput({ run: `${RUN}?token=x`, sha: sha('c') }).problems[0]).toMatch(/^the release's run carries "token"/);
  expect(checkReleaseInput({ run: RUN, sha: sha('c'), files: ['a'] }).problems).toStrictEqual(['a release has files, which it doesn\'t take: it takes run, sha, repo, title']);
});

test('the database holds a release to its run and commit, and approved to In review (migration 0047)', async () => {
  const { kolab, bob } = await planned();
  await submitted(kolab, bob, 'W1.1');
  const ev = (await kolab.db.query<{ event_id: string; repository_id: string }>(`select event_id, repository_id from evidence where element_id = 'W1.1'`)).rows[0];
  const insert = (ref: string | null, url: string | null) => kolab.db.query(
    `insert into evidence(id, binding_node_id, element_id, event_id, kind, ref, url, recorded_by, repository_id)
     select 'x' || $1::text, binding_node_id, element_id, $2, 'release', $1, $3, 'bob', $4 from work_package where element_id = 'W1.1'`, [ref, ev.event_id, url, ev.repository_id]);
  await expect(insert(sha('c'), null)).rejects.toThrow(/evidence_release/);
  await expect(insert('nope', RUN)).rejects.toThrow(/evidence_release/);
  // Only a package In review is approved: on one To do, it doesn't hold.
  await kolab.db.query(`update work_package set approved = true where element_id = 'W1.2'`);
  expect(await state(kolab, 'W1.2')).toStrictEqual({ state: 'todo', approved: false });
  // Leaving review clears approved, whatever moves it.
  await kolab.db.query(`update work_package set approved = true where element_id = 'W1.1'`);
  await kolab.db.query(`update work_package set state = 'done' where element_id = 'W1.1'`);
  expect(await state(kolab, 'W1.1')).toStrictEqual({ state: 'done', approved: false });
});

test('a package with release set stays In review after its approval, shown as approved, until its release is recorded, and is then Done; its milestone waits for it (PLN16, W7.7)', async () => {
  const { kolab, bob, eve, frank } = await planned();
  // W1.2, without the field, is Done on approval as before.
  expect((await submitted(kolab, bob, 'W1.1')).state).toBe('in_review');
  expect((await submitted(kolab, bob, 'W1.2')).state).toBe('in_review');
  expect(await kolab.reviewWork(eve, W('W1.2'), { verdict: 'approve' })).toMatchObject({ state: 'done' });
  expect((await kolab.reviewWork(eve, W('W1.2'), { verdict: 'approve' }).catch((e: Error) => e.message))).toMatch(/is Done: only a work package In review takes a verdict/);

  // W1.1's approval leaves it In review, approved.
  const r = await kolab.reviewWork(eve, W('W1.1'), { verdict: 'approve', note: 'Meets its done-when.' });
  expect(r).toMatchObject({ work: W('W1.1'), state: 'in_review', approved: true, assignee: 'bob' });
  // Its next step says who records the release, after what, and with which run and commit (W7.11).
  expect(r.next).toBe('once it is deployed, after this approval, its release is recorded by someone with Write on the technical layer other than its assignee, '
    + 'from an engineer session outside any job (a job never merges or deploys, JOB4), naming the deploy run, a GitHub Actions run of the package\'s registered repository '
    + '(<repository URL>/actions/runs/<id>), and the commit it released, by its full 40-hex sha '
    + '(konjir_record_release work=kj:orders-pg#W1.1 run=<the run\'s https link> sha=<the full sha>, or konjir work deliver kj:orders-pg#W1.1 --release <run> from a checkout of that repository), and that makes it Done');
  expect(await state(kolab, 'W1.1')).toStrictEqual({ state: 'in_review', approved: true });
  // Shown so wherever its state is: the board, the package, and to a reader.
  const board = (await kolab.listWork(bob)).items;
  expect(board.find((w) => w.id === 'W1.1')).toMatchObject({ state: 'in_review', release: true, approved: true });
  expect(board.find((w) => w.id === 'W1.2')).toMatchObject({ state: 'done' });
  expect(board.find((w) => w.id === 'W1.2')).not.toHaveProperty('approved');
  expect(board.find((w) => w.id === 'W1.2')).not.toHaveProperty('release');
  const carol = await kolab.openSession('carol', 'engineer');
  expect(await kolab.readWork(carol, W('W1.1'))).toMatchObject({ state: 'in_review', release: true, approved: true });
  // The milestone over it isn't Done: one member waits for its release.
  expect(board.find((w) => w.id === 'M1')).toMatchObject({ state: 'todo', waiting: [{ reason: 'depends_on', work: W('W1.1'), state: 'in_review' }] });
  // Nobody is asked to review it again, and it takes no other verdict, nor a resubmission.
  expect((await kolab.reviewRequests({ kolab: 'test' })).filter((q) => q.subject === W('W1.1'))).toStrictEqual([]);
  expect(await rejection(kolab.reviewWork(frank, W('W1.1'), { verdict: 'request_changes', note: 'Not deployed.' })))
    .toMatch(/^GateError: kj:orders-pg#W1\.1 is approved already, and waits for its release \(PLN16\): it takes no other verdict/);
  expect(await rejection(kolab.submitWork(bob, W('W1.1')))).toMatch(/^GateError: kj:orders-pg#W1\.1 is approved, and waits for its release \(PLN16\)/);

  // A session that only reads records no release; a product session neither.
  expect(await rejection(kolab.recordRelease(carol, W('W1.1'), { run: RUN, sha: sha('c') }))).toMatch(/^AccessError: carol may not write the technical layer/);
  // Someone other than its assignee, with Write on the technical layer, records it after the deploy: Done.
  const rel = await kolab.recordRelease(frank, W('W1.1'), { run: RUN, sha: sha('c'), title: 'deployed to production' });
  expect(rel).toStrictEqual({ work: W('W1.1'), state: 'done', done: true, recorded: 1 });
  expect(await state(kolab, 'W1.1')).toStrictEqual({ state: 'done', approved: false });
  const read = await kolab.readWork(bob, W('W1.1'));
  expect(read).not.toHaveProperty('approved');
  // The evidence names the deploy run and the released commit, in the package's repository, recorded by frank.
  expect(read.evidence.filter((e) => e.kind === 'release')).toStrictEqual([expect.objectContaining({
    kind: 'release', sha: sha('c'), url: RUN, title: 'deployed to production', recorded_by: 'frank', repository: 'https://github.com/acme/orders',
  })]);
  expect(read.events.slice(-3).map((e) => [e.kind, e.from, e.to, e.actor])).toStrictEqual([
    ['submitted', 'in_progress', 'in_review', 'bob'], ['approved', 'in_review', 'in_review', 'eve'], ['release_recorded', 'in_review', 'done', 'frank'],
  ]);
  // And the milestone is Done with it.
  expect((await kolab.listWork(bob)).items.find((w) => w.id === 'M1')).toMatchObject({ state: 'done' });
  // A Done package takes no release, the same one or another.
  expect(await rejection(kolab.recordRelease(eve, W('W1.1'), { run: RUN, sha: sha('c') })))
    .toBe('GateError: kj:orders-pg#W1.1 is Done: it is Done already, and takes no release (PLN16)');
});

test('a release is recorded only on a package In review and approved: before the approval, To do, without the field, a milestone and another repository are refused (PLN16, W7.7)', async () => {
  const { kolab, bob, eve } = await planned();
  await submitted(kolab, bob, 'W1.1');
  expect(await rejection(kolab.recordRelease(eve, W('W1.2'), { run: RUN, sha: sha('c') })))
    .toBe('GateError: kj:orders-pg#W1.2 is To do: its work field doesn\'t say release, so its approval makes it Done, and it takes no release (PLN16)');
  expect(await rejection(kolab.recordRelease(eve, W('M1'), { run: RUN, sha: sha('c') }))).toMatch(/^GateError: kj:orders-pg#M1 is a milestone: it has no work of its own to release/);
  expect(await rejection(kolab.recordRelease(eve, W('W1.1'), { run: RUN }))).toMatch(/^GateError: a release names the commit it released/);
  // Deployed before its review: refused, and the approval leaves it waiting for a release recorded after it.
  expect(await rejection(kolab.recordRelease(eve, W('W1.1'), { run: RUN, sha: sha('c') }))).toBe('GateError: kj:orders-pg#W1.1 is In review, not yet approved: '
    + 'a release is recorded only after its approval, on a package In review, approved: it is reviewed first (konjir_review), then deployed, and then its release is recorded (PLN16)');
  expect((await kolab.readWork(bob, W('W1.1'))).evidence.filter((e) => e.kind === 'release')).toStrictEqual([]);
  expect(await kolab.reviewWork(eve, W('W1.1'), { verdict: 'approve' })).toMatchObject({ state: 'in_review', approved: true });
  expect(await state(kolab, 'W1.1')).toStrictEqual({ state: 'in_review', approved: true });
  // Approved: still only in its own repository.
  expect(await rejection(kolab.recordRelease(eve, W('W1.1'), { run: RUN, sha: sha('c'), repo: 'https://github.com/acme/other' }))).toMatch(/^GateError: .*acme\/other/);
  // A package without the field, In review: refused, its state as it was, and its approval makes it Done.
  await submitted(kolab, bob, 'W1.2');
  expect(await rejection(kolab.recordRelease(eve, W('W1.2'), { run: RUN, sha: sha('d') })))
    .toBe('GateError: kj:orders-pg#W1.2 is In review, not yet approved: its work field doesn\'t say release, so its approval makes it Done, and it takes no release (PLN16)');
  expect(await kolab.reviewWork(eve, W('W1.2'), { verdict: 'approve' })).toMatchObject({ state: 'done' });
});

test('a release is never its assignee\'s, nor a job\'s: a job never merges or deploys (PLN16, JOB4, W7.7)', async () => {
  const { kolab, bob, frank } = await planned();
  await people(kolab, 'lee', { level: 'admin' });
  const lee = await kolab.openSession('lee', 'engineer');
  await submitted(kolab, bob, 'W1.1');
  // A review job approves W1.1; its agent's session records no release, though it writes the technical layer.
  const job = await kolab.takeJob(lee, { machine: 'lee-laptop', kinds: ['review'] });
  if (!job.taken) throw new Error(job.why);
  expect(job.item).toBe(W('W1.1'));
  expect(await kolab.reviewWork(job.token, W('W1.1'), { verdict: 'approve' })).toMatchObject({ state: 'in_review', approved: true });
  expect(await rejection(kolab.recordRelease(job.token, W('W1.1'), { run: RUN, sha: sha('c') })))
    .toBe('GateError: this session is a job\'s, and a job never merges or deploys (JOB4), so it records no release: a person, or an agent outside a job, records kj:orders-pg#W1.1\'s release once it is deployed');
  // Nor its assignee.
  expect(await rejection(kolab.recordRelease(bob, W('W1.1'), { run: RUN, sha: sha('c') })))
    .toBe('GateError: bob is kj:orders-pg#W1.1\'s assignee: someone else with Write on the technical layer records its release, once it is deployed (PLN16)');
  expect(await state(kolab, 'W1.1')).toStrictEqual({ state: 'in_review', approved: true });
  // Someone else, outside a job, does.
  expect(await kolab.recordRelease(frank, W('W1.1'), { run: RUN, sha: sha('c') })).toMatchObject({ state: 'done', done: true });
});

test('a release\'s run is a GitHub Actions run of the package\'s repository, and its sha a full 40-hex sha (W7.7)', async () => {
  const { kolab, bob, eve } = await planned();
  await submitted(kolab, bob, 'W1.1');
  await kolab.reviewWork(eve, W('W1.1'), { verdict: 'approve' });
  const notARun = (run: string) => `GateError: the release's run ${run} isn't a GitHub Actions run of https://github.com/acme/orders: it is https://github.com/acme/orders/actions/runs/<run id>, the deploy run that released kj:orders-pg#W1.1`;
  for (const run of ['https://example.com/not-a-deploy', 'https://github.com/acme/other/actions/runs/123', 'https://github.com/acme/orders/pull/1',
    'https://github.com/acme/orders/actions/runs/', 'https://github.com/acme/orders/actions/runs/12x', 'https://github.com/acme/orders/actions/runs/123/job/4',
    'https://gitlab.com/acme/orders/actions/runs/123', 'https://github.com/acme/orders-other/actions/runs/123']) {
    expect(await rejection(kolab.recordRelease(eve, W('W1.1'), { run, sha: sha('c') }))).toBe(notARun(run));
  }
  expect(await rejection(kolab.recordRelease(eve, W('W1.1'), { run: RUN, sha: 'c'.repeat(64) }))).toMatch(/^GateError: a release names the commit it released by its full sha: 40 hexadecimal characters, not "c{64}"/);
  expect(await rejection(kolab.recordRelease(eve, W('W1.1'), { run: RUN, sha: 'c'.repeat(12) }))).toMatch(/^GateError: a release names the commit it released by its full sha/);
  expect(await state(kolab, 'W1.1')).toStrictEqual({ state: 'in_review', approved: true });
  // An attempt of the run, in any case, is one.
  expect(await kolab.recordRelease(eve, W('W1.1'), { run: 'https://GitHub.com/Acme/Orders/actions/runs/123/attempts/2', sha: sha('C') })).toMatchObject({ state: 'done' });
});

test('a release before a request for changes is refused, so it never counts for the work resubmitted after it (PLN16, W7.7)', async () => {
  const { kolab, bob, eve } = await planned();
  await submitted(kolab, bob, 'W1.1');
  // Deployed before its review: refused, so nothing of it is left to count.
  expect(await rejection(kolab.recordRelease(eve, W('W1.1'), { run: RUN, sha: sha('a') }))).toMatch(/^GateError: kj:orders-pg#W1\.1 is In review, not yet approved/);
  await kolab.reviewWork(eve, W('W1.1'), { verdict: 'request_changes', note: 'Handle a missing order.' });
  await kolab.submitWork(bob, W('W1.1'), { evidence: [COMMIT('e')] });
  // The approval of the new round waits for the new commit's release.
  expect(await kolab.reviewWork(eve, W('W1.1'), { verdict: 'approve' })).toMatchObject({ state: 'in_review', approved: true });
  expect(await state(kolab, 'W1.1')).toStrictEqual({ state: 'in_review', approved: true });
});

test('a release among a round\'s evidence confirms no repository at its approval: only the work\'s own commits and pull requests do (D98, W7.7)', async () => {
  const { kolab, bob, eve } = await planned();
  const other = await registeredRepository(kolab, { url: 'https://github.com/acme/deploys' });
  await submitted(kolab, bob, 'W1.1');
  // Kolab records none before the approval; the database is given one, in another repository, to show the approval passes it over.
  await kolab.db.query(
    `insert into evidence(id, binding_node_id, element_id, event_id, kind, ref, url, recorded_by, repository_id, before_repositories)
     select 'xrelease', binding_node_id, element_id, event_id, 'release', $1, $2, 'bob', $3, false from evidence where element_id = 'W1.1' and kind = 'commit'`,
    [sha('c'), 'https://github.com/acme/deploys/actions/runs/1', other.id]);
  const r = await kolab.reviewWork(eve, W('W1.1'), { verdict: 'approve' });
  expect(r.confirmed_repositories).toStrictEqual(['https://github.com/acme/orders']);
  expect((await kolab.db.query(`select confirmed_at from repository where id = $1`, [other.id])).rows[0]).toStrictEqual({ confirmed_at: null });
});

test('a release is not a package\'s own evidence: konjir_add_evidence and konjir_submit_work refuse it (W7.7)', async () => {
  const { kolab, bob } = await planned();
  await kolab.pullWork(bob);
  expect(await rejection(kolab.addEvidence(bob, W('W1.1'), [{ kind: 'release', sha: sha('c'), url: RUN }])))
    .toBe('GateError: evidence 1 is a release, which is recorded after the deploy with konjir_record_release (or konjir work deliver --release), not as the work\'s own evidence.');
});

test('a binding version that drops release from a package approved and waiting makes it Done; one that adds it to a Done package leaves it Done (W7.7)', async () => {
  const { kolab, bob, eve, frank, decisions } = await planned();
  await submitted(kolab, bob, 'W1.1');
  await kolab.reviewWork(eve, W('W1.1'), { verdict: 'approve' });
  expect(await state(kolab, 'W1.1')).toStrictEqual({ state: 'in_review', approved: true });
  const plan = PLAN.map((e) => (e.id === 'W1.1' ? { ...e, work: { done_when: e.work!.done_when, size: e.work!.size } } : e));
  await commitReviewed(kolab, bob, frank, 'orders-pg', { elements: [...decisions, ...plan] });
  expect(await state(kolab, 'W1.1')).toStrictEqual({ state: 'done', approved: false });
  const events = (await kolab.readWork(bob, W('W1.1'))).events;
  expect(events.at(-1)).toMatchObject({ kind: 'approved', from: 'in_review', to: 'done', actor: 'kolab' });
  expect(events.at(-1)!.note).toMatch(/dropped its release field, so its approval makes it Done \(PLN16\)$/);
  // Setting it again on a Done package leaves it Done.
  await commitReviewed(kolab, bob, frank, 'orders-pg', { elements: [...decisions, ...PLAN] });
  expect(await state(kolab, 'W1.1')).toStrictEqual({ state: 'done', approved: false });
});

test('a review job is never given a package approved and waiting for its release, and a change of policy asks no one to review it (JOB2, POL2, W7.7)', async () => {
  const { kolab, bob, eve } = await planned();
  await people(kolab, 'lee', { level: 'admin' });
  const lee = await kolab.openSession('lee', 'engineer');
  await submitted(kolab, bob, 'W1.1');
  expect((await kolab.listJobs(lee, {})).queue).toMatchObject({ review: 1 });
  await kolab.reviewWork(eve, W('W1.1'), { verdict: 'approve' });
  expect((await kolab.listJobs(lee, {})).queue).toMatchObject({ review: 0 });
  const r = await kolab.takeJob(lee, { machine: 'lee-laptop', kinds: ['review'] });
  expect(r.taken).toBe(false);
  // A change of the policy gives packages In review their requests again (POL2), but not this one.
  await kolab.setPolicy(lee, { approve_work: 'person' });
  await kolab.setPolicy(lee, { approve_work: 'agent' });
  expect((await kolab.db.query(`select reviewer_id from review_request where element_id = 'W1.1' and state = 'open'`)).rows).toStrictEqual([]);
});
