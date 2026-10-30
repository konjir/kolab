// Jobs (W5.4a; D103, D104, JOB1–JOB3; migration 0034): a person's session takes the next item for
// one of their pool agents, a review before a ready work package, and Kolab picks, makes, grants and
// signs in the agent; the reviewer is never the author; a person runs at most four live jobs and a
// kolab eight; ending a job releases its package and ends its session; a lapsed job's package returns
// to To do; the runner's heartbeat and the agent's calls renew the lease, never past four hours.
import { expect, test } from '@jest/globals';
import { buildInstructions, jobMachine, jobOutcome, reviewInstructions, type Kolab } from '@konjir/engine';
import { els, openKolab, people, registeredRepository, rejection, TEST_KOLAB } from '@konjir/engine/testing';
import type { ElementInput } from '@konjir/types';

const sha = (c: string) => c.repeat(40);
const COMMIT = (c = 'a') => ({ kind: 'commit' as const, sha: sha(c), title: `Build it (${c})` });

/**
 * A kolab with a spec and a binding: `n` decisions, b1…bn, each serving a requirement, and `n`
 * independent work packages, W1…Wn, each relying on one decision (D104), and the binding's
 * repository. Alice writes the functional layer; bob and lee, people, the technical one; carol only
 * reads. Lee runs jobs.
 */
async function planned(n = 6) {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, ['bob', 'lee'], { layers: ['technical'] });
  await people(kolab, 'carol', { level: 'read' });
  const product = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'engineer');
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els(Object.fromEntries(ids.map((i) => [`R${i}`, `Requirement ${i}.`]))) });
  const spec = (await kolab.latestCommitted('orders'))!.id;
  await kolab.createNode(bob, 'binding', 'Orders on Postgres', 'orders-pg');
  const decisions = els(Object.fromEntries(ids.map((i) => [`b${i}`, `Binding element ${i}.`])));
  // lee also writes the technical layer, so bob's binding versions wait for lee's review: approved here.
  const approve = async (v: string) => {
    const r = await kolab.submit(bob, v);
    if (!r.in_review) return;
    const l = await kolab.openSession('lee', 'engineer');
    expect(await kolab.recordReview(l, v, { verdict: 'approve' })).toMatchObject({ ok: true });
    await kolab.endSession({ actor: 'lee' });
  };
  const bv = await kolab.draft(bob, 'orders-pg', {
    elements: decisions, links: ids.map((i) => ({ kind: 'dependency' as const, sourceElement: `b${i}`, target: spec, targetElement: `R${i}` })),
  });
  await approve(bv);
  const work: ElementInput[] = ids.map((i) => ({ id: `W${i}`, text: `Build element ${i}.`, work: { done_when: `Element ${i} works.` } }));
  const wv = await kolab.draft(bob, 'orders-pg', { elements: [...decisions, ...work], links: ids.map((i) => ({ kind: 'dependency' as const, sourceElement: `W${i}`, target: bv, targetElement: `b${i}` })) });
  await approve(wv);
  await registeredRepository(kolab, { binding: 'orders-pg' });
  const lee = await kolab.openSession('lee', 'engineer');
  return { kolab, product, bob, lee };
}

const W = (id: string) => `kj:orders-pg#${id}`;

/** Takes a job as `session`, which must start one. */
async function take(kolab: Kolab, session: string, machine = 'lee-laptop') {
  const r = await kolab.takeJob(session, { machine });
  if (!r.taken) throw new Error(`expected a job: ${r.why}`);
  return r;
}

const row = async (kolab: Kolab, element: string) =>
  (await kolab.db.query<{ state: string; assignee_id: string | null; lease_until: Date | null }>(
    `select state, assignee_id, lease_until from work_package where element_id = $1`, [element])).rows[0];

const jobRow = async (kolab: Kolab, id: string) =>
  (await kolab.db.query<{ outcome: string | null; said: string | null; ended_by: string | null; note: string | null; lease_until: Date; started_at: Date; ended_at: Date | null; person_id: string; runner_session_id: string }>(
    `select outcome, said, ended_by, note, lease_until, started_at, ended_at, person_id, runner_session_id from job where id = $1`, [id])).rows[0];

/** A package's events, kind and actor, oldest first. */
async function events(kolab: Kolab, session: string, work: string) {
  return (await kolab.readWork(session, work)).events.map((e) => [e.kind, e.actor]);
}

test('a person\'s session takes a review before a ready package; two takes give two pool agents, each signed in with its own session; the reviewer is never the author (JOB2, JOB3, VER16)', async () => {
  const { kolab, bob, lee } = await planned();
  // bob builds W1 and submits it: it waits In review, with lee among its reviewers.
  expect(await kolab.pullWork(bob)).toMatchObject({ pulled: true, item: { id: 'W1' } });
  await kolab.submitWork(bob, W('W1'), { evidence: [COMMIT('a')] });

  // The first take is the review, though W2… are ready: a review comes first.
  const first = await take(kolab, lee);
  expect(first).toMatchObject({ taken: true, kind: 'review', item: W('W1'), agent: 'lee-engineer-1', token: expect.stringMatching(/^kjs_/), lease_until: expect.any(String) });
  expect(first).not.toHaveProperty('trailer');
  expect(first.instructions).toMatch(/^You are lee-engineer-1, an engineer agent of lee's, running one job in kolab test of Konjir\. Your job is one item: review kj:orders-pg#W1, which bob submitted\./);
  expect(first.instructions).toMatch(/konjir_review work=kj:orders-pg#W1 verdict=approve/);
  expect(first.instructions).toMatch(/Then stop\./);
  // The second, a build, by another agent: the first ready package, pulled for it as a pull would.
  const second = await take(kolab, lee);
  expect(second).toMatchObject({ taken: true, kind: 'build', item: W('W2'), agent: 'lee-engineer-2', trailer: 'Konjir-Work: kj:test/orders-pg#W2' });
  expect(second.token).not.toBe(first.token);
  expect(second.instructions).toMatch(/Done when: Element 2 works\./);
  expect(second.instructions).toMatch(/Konjir-Work: kj:test\/orders-pg#W2/);
  expect(second.instructions).toMatch(/konjir work deliver kj:orders-pg#W2 --submit/);
  expect(second.instructions).toMatch(/It is done in the repository https:\/\/github\.com\/acme\/orders/);
  expect(await row(kolab, 'W2')).toMatchObject({ state: 'in_progress', assignee_id: 'lee-engineer-2' });
  expect(await events(kolab, bob, W('W2'))).toStrictEqual([['added', 'bob'], ['pulled', 'lee-engineer-2']]);

  // Each agent is lee's, made on first need, granted what lee holds here, and signed in as an engineer, once (ENF4).
  for (const [r, agent] of [[first, 'lee-engineer-1'], [second, 'lee-engineer-2']] as const) {
    expect(await kolab.sessionInfo(r.token)).toMatchObject({ actor: agent, kind: 'agent', owner: 'lee', role: 'engineer', kolab: TEST_KOLAB, access: { level: 'write', layers: ['technical'] } });
    expect(await kolab.liveSession(r.token)).toMatchObject({ actor: agent, granted: false, job: true });
  }
  expect((await kolab.db.query(`select opened_by from session where actor_id like 'lee-engineer-%' and ended_at is null order by actor_id`)).rows)
    .toStrictEqual([{ opened_by: 'lee' }, { opened_by: 'lee' }]);
  expect((await kolab.listActors({ owner: 'lee' })).map((a) => a.id)).toStrictEqual(['lee-engineer-1', 'lee-engineer-2']);

  // lee-engineer-2 builds W2 and submits it; its runner ends the job: submitted.
  await kolab.submitWork(second.token, W('W2'), { evidence: [COMMIT('b')] });
  expect(await kolab.endJob(lee, { job: second.job, outcome: 'done' })).toStrictEqual({ job: second.job, ended: true, outcome: 'submitted', state: 'in_review' });
  expect(await kolab.sessionOpen(second.token)).toBe(false);

  // W2's review: lee-engineer-2 is free, but it is W2's author, and lee-engineer-1 is busy: a third agent is made (VER16).
  const third = await take(kolab, lee);
  expect(third).toMatchObject({ kind: 'review', item: W('W2'), agent: 'lee-engineer-3' });
  expect(third.instructions).toMatch(/which lee-engineer-2 submitted/);
  // It was granted after W2 was submitted: Kolab gave it a review request, so it can give the review.
  expect((await kolab.readWork(bob, W('W2'))).reviews.filter((x) => x.state === 'open').map((x) => x.reviewer).sort())
    .toStrictEqual(['bob', 'lee', 'lee-engineer-1', 'lee-engineer-3']);
  expect(await kolab.reviewWork(third.token, W('W2'), { verdict: 'approve', note: 'Ran the tests.' })).toMatchObject({ state: 'done' });
  expect(await kolab.endJob(lee, { job: third.job, outcome: 'done' })).toStrictEqual({ job: third.job, ended: true, outcome: 'reviewed', state: 'done' });

  // The first reviews W1, as itself; ending the job ends its session.
  expect(await kolab.reviewWork(first.token, W('W1'), { verdict: 'approve', note: 'Checked.' })).toMatchObject({ state: 'done' });
  expect(await kolab.endJob(lee, { job: first.job, outcome: 'done' })).toStrictEqual({ job: first.job, ended: true, outcome: 'reviewed', state: 'done' });
  expect(await kolab.sessionOpen(first.token)).toBe(false);
  expect(await kolab.liveSession(first.token)).toBeUndefined();
  expect(await jobRow(kolab, first.job)).toMatchObject({ outcome: 'reviewed', said: 'done', ended_by: 'lee', person_id: 'lee' });

  // The next take reuses a free agent: lee-engineer-1, the first by number.
  expect(await take(kolab, lee)).toMatchObject({ kind: 'build', item: W('W3'), agent: 'lee-engineer-1' });
});

test('a technical version in review is a review job too, never its author\'s; an agent reviews it as itself (JOB2, VER16)', async () => {
  const { kolab, bob, lee } = await planned(2);
  // A pool agent of lee's drafts the binding: its version waits in review.
  const build = await take(kolab, lee);
  const v = await kolab.draft(build.token, 'orders-pg', { deltas: [{ kind: 'override', element: 'b1', text: 'Binding element 1, revised.' }] });
  expect(await kolab.submit(build.token, v)).toMatchObject({ in_review: true });
  // Its author is busy and the version is the oldest review: another agent takes it.
  const review = await take(kolab, lee);
  expect(review).toMatchObject({ kind: 'review', item: 'kj:orders-pg@3', agent: 'lee-engineer-2' });
  expect(review.instructions).toMatch(/konjir_read_node node=orders-pg version=3/);
  expect(review.instructions).toMatch(/konjir_review node=orders-pg version=3 verdict=approve/);
  // The author's job ending frees it, but it never reviews its own version: with the version's job ended
  // before review, the next take of it makes another agent.
  expect(await kolab.endJob(lee, { job: review.job, outcome: 'stopped', note: 'Not now.' })).toStrictEqual({ job: review.job, ended: true, outcome: 'stopped', state: 'in_review' });
  // The review request Kolab gave lee-engineer-2 is withdrawn: no verdict came.
  expect((await kolab.db.query(`select state from review_request where version_id = $1 and reviewer_id = 'lee-engineer-2'`, [v])).rows).toStrictEqual([{ state: 'withdrawn' }]);
  expect(await kolab.endJob(lee, { job: build.job, outcome: 'failed' })).toMatchObject({ outcome: 'released', released: W('W1'), state: 'todo' });
  const again = await take(kolab, lee);
  expect(again).toMatchObject({ kind: 'review', item: 'kj:orders-pg@3', agent: 'lee-engineer-2' });
  expect(await kolab.recordReview(again.token, v, { verdict: 'approve', note: 'Consistent with R1.' })).toMatchObject({ ok: true });
  expect(await kolab.endJob(lee, { job: again.job, outcome: 'done' })).toStrictEqual({ job: again.job, ended: true, outcome: 'reviewed', state: 'committed' });
  expect((await kolab.latestCommitted('orders-pg'))!.id).toBe(v);
  void bob;
});

test('a fifth live job of one person is refused, and a ninth of a kolab; each says why, with the caps (JOB3)', async () => {
  const { kolab, bob, lee } = await planned(10);
  const jobs = [];
  for (let i = 1; i <= 4; i++) jobs.push(await take(kolab, lee));
  expect(jobs.map((j) => [j.item, j.agent])).toStrictEqual([1, 2, 3, 4].map((i) => [W(`W${i}`), `lee-engineer-${i}`]));
  const fifth = await kolab.takeJob(lee, { machine: 'lee-laptop' });
  expect(fifth).toMatchObject({
    taken: false, why: 'you have 4 live jobs, the most a person runs at once (4, JOB3): wait for one to end',
    caps: { person: { live: 4, max: 4 }, kolab: { live: 4, max: 8 } }, counts: { review: 0, ready: 6 },
  });
  // Nothing was made or opened for it.
  expect((await kolab.listActors({ owner: 'lee' })).length).toBe(4);
  // The ledger shows them, to anyone in the kolab.
  const list = await kolab.listJobs(bob, { live: true });
  expect(list.jobs.map((j) => [j.agent, j.kind, j.item, j.machine, j.person])).toStrictEqual([4, 3, 2, 1].map((i) => [`lee-engineer-${i}`, 'build', W(`W${i}`), 'lee-laptop', 'lee']));
  expect(list).toMatchObject({ queue: { review: 0, build: 6 }, caps: { person: { live: 0, max: 4 }, kolab: { live: 4, max: 8 } }, next: null });
  expect((await kolab.listJobs(lee, {}, { limit: 3 })).next).toEqual(expect.any(String));
  // Ending one frees a place.
  await kolab.endJob(lee, { job: jobs[0].job, outcome: 'stopped' });
  expect(await take(kolab, lee)).toMatchObject({ kind: 'build', item: W('W1'), agent: 'lee-engineer-1' });
  // The kolab's cap: bob takes too, until the kolab holds its most.
  kolab.jobLimits.perKolab = 6;
  expect(await take(kolab, bob, 'bob-desktop')).toMatchObject({ kind: 'build', agent: 'bob-engineer-1' });
  expect(await take(kolab, bob, 'bob-desktop')).toMatchObject({ kind: 'build', agent: 'bob-engineer-2' });
  expect(await kolab.takeJob(bob, { machine: 'bob-desktop' })).toMatchObject({
    taken: false, why: 'kolab test has 6 live jobs, the most a kolab runs at once (6, JOB3): wait for one to end',
    caps: { person: { live: 2, max: 4 }, kolab: { live: 6, max: 6 } },
  });
});

test('ending a job releases the package its agent still holds, with the runner\'s note, and ends its session; it can\'t be renewed or ended again (JOB2)', async () => {
  const { kolab, bob, lee } = await planned(2);
  const j = await take(kolab, lee);
  expect(j).toMatchObject({ kind: 'build', item: W('W1'), agent: 'lee-engineer-1' });
  expect(await kolab.endJob(lee, { job: j.job, outcome: 'stopped', note: 'Stopped by hand.' }))
    .toStrictEqual({ job: j.job, ended: true, outcome: 'stopped', released: W('W1'), state: 'todo' });
  expect(await row(kolab, 'W1')).toMatchObject({ state: 'todo', assignee_id: null, lease_until: null });
  const w = await kolab.readWork(bob, W('W1'));
  expect(w.events.map((e) => [e.kind, e.actor, e.note])).toStrictEqual([
    ['added', 'bob', null], ['pulled', 'lee-engineer-1', null], ['released', 'lee', 'Stopped by hand.'],
  ]);
  // Its session has ended: the token reaches nothing.
  expect(await kolab.sessionOpen(j.token)).toBe(false);
  expect(await rejection(kolab.pullWork(j.token))).toMatch(/^RoleError: no open session for that token/);
  expect(await jobRow(kolab, j.job)).toMatchObject({ outcome: 'stopped', said: 'stopped', ended_by: 'lee', note: 'Stopped by hand.' });
  expect(await rejection(kolab.renewJob(lee, j.job))).toMatch(new RegExp(`^GateError: job ${j.job} ended \\(stopped\\) at .*: take another \\(konjir_take_job\\)$`));
  expect(await rejection(kolab.endJob(lee, { job: j.job, outcome: 'done' }))).toMatch(/ended \(stopped\)/);
  // The package is To do again: the next take builds it, on the same agent.
  const k = await take(kolab, lee);
  expect(k).toMatchObject({ item: W('W1'), agent: 'lee-engineer-1' });
  // An agent that failed: the package goes back, released, with Kolab's words when the runner gives none.
  expect(await kolab.endJob(lee, { job: k.job, outcome: 'failed' })).toMatchObject({ outcome: 'released', released: W('W1') });
  expect((await kolab.readWork(bob, W('W1'))).events.at(-1)).toMatchObject({ kind: 'released', actor: 'lee', note: `job ${k.job} on lee-laptop ended (failed) with the work still In progress` });
});

test('a job whose lease lapses ends, by Kolab: its package returns to To do and its session ends; a package lease that lapses ends its job too (JOB1, PLN15)', async () => {
  const { kolab, bob, lee } = await planned(2);
  const j = await take(kolab, lee);
  await kolab.db.query(`update job set lease_until = clock_timestamp() - interval '1 second' where id = $1`, [j.job]);
  // Lapsed by the database's clock: the runner can't revive it.
  expect(await rejection(kolab.renewJob(lee, j.job))).toMatch(new RegExp(`^GateError: job ${j.job}'s lease lapsed at .*, so it has ended`));
  expect(await kolab.sweepLapsedJobs()).toBe(1);
  expect(await row(kolab, 'W1')).toMatchObject({ state: 'todo', assignee_id: null });
  expect((await kolab.readWork(bob, W('W1'))).events.at(-1)).toMatchObject({ kind: 'lapsed', actor: 'kolab', note: expect.stringMatching(new RegExp(`^job ${j.job}'s lease lapsed at .*: neither its agent's calls nor its runner's heartbeat renewed it \\(JOB1\\)$`)) });
  expect(await jobRow(kolab, j.job)).toMatchObject({ outcome: 'lapsed', ended_by: 'kolab', said: null });
  expect(await kolab.sessionOpen(j.token)).toBe(false);
  expect(await rejection(kolab.endJob(lee, { job: j.job, outcome: 'done' }))).toMatch(/ended when its lease lapsed at .*, and its item went back to the queue/);
  expect((await kolab.listJobs(lee)).jobs[0]).toMatchObject({ job: j.job, outcome: 'lapsed', ended_at: expect.any(String) });

  // The package's own lease lapses first: the sweep of work leases ends its job.
  const k = await take(kolab, lee);
  expect(k.item).toBe(W('W1'));
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() - interval '1 second' where element_id = 'W1'`);
  expect(await kolab.sweepLapsedLeases()).toBe(1);
  expect(await jobRow(kolab, k.job)).toMatchObject({ outcome: 'lapsed', ended_by: 'kolab' });
  expect(await kolab.sessionOpen(k.token)).toBe(false);
  expect(await row(kolab, 'W1')).toMatchObject({ state: 'todo' });
  // The worker's timer does the same, on its own.
  const m = await take(kolab, lee);
  await kolab.db.query(`update job set lease_until = clock_timestamp() - interval '1 second' where id = $1`, [m.job]);
  kolab.startWorker({ pollMs: 20 });
  for (let i = 0; i < 100 && !(await jobRow(kolab, m.job)).ended_at; i++) await new Promise((r) => setTimeout(r, 20));
  expect(await jobRow(kolab, m.job)).toMatchObject({ outcome: 'lapsed' });
});

test('the runner\'s heartbeat and the agent\'s calls renew a job\'s lease, and the build\'s package lease with it, never past four hours (JOB1)', async () => {
  const { kolab, lee } = await planned(2);
  const j = await take(kolab, lee);
  const started = (await jobRow(kolab, j.job)).started_at;
  const lease = new Date(j.lease_until).getTime() - new Date(started).getTime();
  expect(lease).toBe(30 * 60_000);
  // The heartbeat: the job's lease, and W1's with it.
  await kolab.db.query(`update job set lease_until = clock_timestamp() + interval '60 seconds' where id = $1`, [j.job]);
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '60 seconds' where element_id = 'W1'`);
  const r = await kolab.renewJob(lee, j.job);
  expect(r.job).toBe(j.job);
  const until = new Date(r.lease_until).getTime();
  expect(until).toBeGreaterThan(Date.now() + 29 * 60_000);
  expect(new Date((await row(kolab, 'W1')).lease_until!).getTime()).toBe(until);
  // The agent's own call renews the job's lease.
  await kolab.db.query(`update job set lease_until = clock_timestamp() + interval '60 seconds' where id = $1`, [j.job]);
  await kolab.listWork(j.token);
  expect(new Date((await jobRow(kolab, j.job)).lease_until).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
  // So does a call that names its package.
  await kolab.db.query(`update job set lease_until = clock_timestamp() + interval '60 seconds' where id = $1`, [j.job]);
  await kolab.readWork(j.token, W('W1'));
  expect(new Date((await jobRow(kolab, j.job)).lease_until).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
  // A read a listen stream prompts renews nothing.
  await kolab.db.query(`update job set lease_until = clock_timestamp() + interval '60 seconds' where id = $1`, [j.job]);
  await kolab.quietly(() => kolab.listWork(j.token));
  expect(new Date((await jobRow(kolab, j.job)).lease_until).getTime()).toBeLessThan(Date.now() + 120_000);
  // Only the session that took it renews or ends it: another session of lee's, or bob's, is told no such job.
  const other = await kolab.openSession('carol', 'engineer');
  expect(await rejection(kolab.renewJob(other, j.job))).toBe(`GateError: no job ${j.job} of this session's: only the session that took a job renews or ends it (JOB2)`);
  expect(await rejection(kolab.endJob(other, { job: j.job, outcome: 'done' }))).toMatch(/^GateError: no job .* of this session's/);
  expect(await rejection(kolab.renewJob(lee, 'nope'))).toMatch(/^GateError: no job nope of this session's/);
  // A kolab whose lease is a day: a job still lasts at most four hours.
  await kolab.endJob(lee, { job: j.job, outcome: 'stopped' });
  await people(kolab, 'max', { level: 'maintain' });
  await kolab.setWorkLease(await kolab.openSession('max', 'engineer'), 1440);
  const k = await take(kolab, lee);
  const kr = await jobRow(kolab, k.job);
  expect(new Date(kr.lease_until).getTime() - new Date(kr.started_at).getTime()).toBe(4 * 3600_000);
  expect(new Date((await kolab.renewJob(lee, k.job)).lease_until).getTime()).toBe(new Date(kr.started_at).getTime() + 4 * 3600_000);
  // The agent's session expires with it.
  expect((await kolab.db.query<{ ok: boolean }>(`select s.expires_at <= j.started_at + interval '4 hours' + interval '5 seconds' as ok from job j join session s on s.id = j.session_id where j.id = $1`, [k.job])).rows[0].ok).toBe(true);
});

test('only a person\'s own session with Write on the technical layer takes a job, naming its machine; with nothing to take it says why (JOB2)', async () => {
  const { kolab, product, bob, lee } = await planned(1);
  const j = await take(kolab, lee);
  // An agent's session takes none, a job's agent included; nor does a reader or a functional writer.
  expect(await rejection(kolab.takeJob(j.token, { machine: 'x' }))).toBe('AccessError: lee-engineer-1 is an agent, and an agent takes no job: a person\'s own session takes jobs, for their pool agents to do (D103, JOB2)');
  const carol = await kolab.openSession('carol', 'engineer');
  expect(await rejection(kolab.takeJob(carol, { machine: 'x' }))).toMatch(/^AccessError: carol may not write the technical layer of kolab test, so it takes no job \(JOB2\)/);
  expect(await rejection(kolab.takeJob(product, { machine: 'x' }))).toMatch(/^AccessError: alice may not write the technical layer/);
  // The machine: a label, 1 to 64 characters, with no control characters.
  for (const machine of ['', '  ', 42, 'x'.repeat(65), 'a\nb', 'a\u0085b', 'a\u009fb']) {
    expect(await rejection(kolab.takeJob(bob, { machine }))).toMatch(/^GateError: machine /);
  }
  expect(jobMachine(' lee-laptop ')).toStrictEqual({ machine: 'lee-laptop' });
  // Nothing to take: W1 is lee's job's, and nothing else is ready; it says why, as a pull does.
  expect(await kolab.takeJob(bob, { machine: 'bob-desktop' })).toStrictEqual({
    taken: false, why: 'nothing in orders-pg is To do: 1 In progress, 0 In review, 0 Done',
    counts: { review: 0, ready: 0, todo: 0, blocked_by_dependencies: 0, blocked_by_questions: 0, blocked_by_case_files: 0, in_progress: 1, in_review: 0, done: 0, held_back: 0 },
    caps: { person: { live: 0, max: 4 }, kolab: { live: 1, max: 8 } }, now: expect.any(String),
  });
  expect((await kolab.listActors({ owner: 'bob' })).length).toBe(0);
  // W1 submitted: bob's take reviews it, and a second take finds nothing, the review being taken.
  await kolab.submitWork(j.token, W('W1'), { evidence: [COMMIT()] });
  await kolab.endJob(lee, { job: j.job, outcome: 'done' });
  const review = await take(kolab, bob, 'bob-desktop');
  expect(review).toMatchObject({ kind: 'review', item: W('W1'), agent: 'bob-engineer-1' });
  expect(await kolab.takeJob(bob, { machine: 'bob-desktop' })).toMatchObject({ taken: false, counts: { review: 0 } });
  // Its agent is granted what bob holds here, never more: Write on the technical layer.
  expect((await kolab.db.query(`select level, functional, technical from kolab_grant where agent_id = 'bob-engineer-1'`)).rows).toStrictEqual([{ level: 'write', functional: false, technical: true }]);
});

test('the instructions are one function per kind, and an outcome follows what became of the item (JOB1, JOB2)', () => {
  const b = buildInstructions({ kolab: 'k', agent: 'ann-engineer-1', person: 'ann', work: 'kj:p#W1', text: 'Do it.\nWell.', trailer: 'Konjir-Work: kj:k/p#W1' });
  expect(b).toMatch(/^You are ann-engineer-1, an engineer agent of ann's, running one job in kolab k of Konjir\. Your job is one item: build the work package kj:p#W1\./);
  expect(b).toMatch(/\n {2}Do it\.\n {2}Well\.\n/);
  expect(b).toMatch(/Done when: its text above is met/);
  expect(b).not.toMatch(/repository https/);
  const r = reviewInstructions({ kolab: 'k', agent: 'ann-engineer-2', person: 'ann', item: 'kj:p#W1', subject: 'work', author: 'ann-engineer-1' });
  expect(r).toMatch(/check out its pull request/i);
  expect(r).toMatch(/run the tests/);
  expect(jobOutcome('build', true, 'done')).toBe('submitted');
  expect(jobOutcome('review', true, 'failed')).toBe('reviewed');
  expect(jobOutcome('build', false, 'stopped')).toBe('stopped');
  expect(jobOutcome('review', false, 'done')).toBe('released');
});

test('ending a job gives back only its own item: a build its own package, a review nothing; an agent holding a package takes no new job, and resumes its package once changes are requested (JOB2, PLN18)', async () => {
  const { kolab, bob, lee } = await planned(4);
  // lee-engineer-1 builds W1 and submits it; it then pulls W2, beyond its job, and the job ends.
  const a = await take(kolab, lee);
  expect(a).toMatchObject({ kind: 'build', item: W('W1'), agent: 'lee-engineer-1' });
  await kolab.submitWork(a.token, W('W1'), { evidence: [COMMIT('a')] });
  expect(await kolab.pullWork(a.token)).toMatchObject({ pulled: true, item: { id: 'W2' } });
  expect(await kolab.endJob(lee, { job: a.job, outcome: 'done' })).toStrictEqual({ job: a.job, ended: true, outcome: 'submitted', state: 'in_review' });
  // W2 is not the job's: it stays lee-engineer-1's.
  expect(await row(kolab, 'W2')).toMatchObject({ state: 'in_progress', assignee_id: 'lee-engineer-1' });
  // bob submits W3 too. The review of W1 goes to a new agent, W1's author being lee-engineer-1;
  // so does W3's: lee-engineer-1 is free, but holds W2, and takes no new job while it does.
  expect(await kolab.pullWork(bob)).toMatchObject({ pulled: true, item: { id: 'W3' } });
  await kolab.submitWork(bob, W('W3'), { evidence: [COMMIT('c')] });
  const r1 = await take(kolab, lee);
  expect(r1).toMatchObject({ kind: 'review', item: W('W1'), agent: 'lee-engineer-2' });
  const r2 = await take(kolab, lee);
  expect(r2).toMatchObject({ kind: 'review', item: W('W3'), agent: 'lee-engineer-3' });
  // A review job that ends gives back nothing: W2 stays where it is.
  expect(await kolab.endJob(lee, { job: r2.job, outcome: 'failed' })).toStrictEqual({ job: r2.job, ended: true, outcome: 'released', state: 'in_review' });
  expect(await row(kolab, 'W2')).toMatchObject({ state: 'in_progress', assignee_id: 'lee-engineer-1' });
  // lee-engineer-2 requests changes on W1: it goes back to lee-engineer-1, beside W2.
  await kolab.reviewWork(r1.token, W('W1'), { verdict: 'request_changes', note: 'Handle a missing order.' });
  await kolab.endJob(lee, { job: r1.job, outcome: 'done' });
  // The next take resumes W1, as lee-engineer-1, before any review or ready package.
  const resumed = await take(kolab, lee);
  expect(resumed).toMatchObject({ kind: 'build', item: W('W1'), agent: 'lee-engineer-1', trailer: 'Konjir-Work: kj:test/orders-pg#W1' });
  expect(resumed.instructions).toMatch(/It was returned to you with changes requested, and you hold it In progress: read the latest review note first \(the newest changes_requested event in konjir_read_work's events\)/);
  expect(await kolab.readWork(resumed.token, W('W1'))).toMatchObject({ state: 'in_progress', assignee: 'lee-engineer-1' });
  // Ending it gives back W1 only, not W2.
  expect(await kolab.endJob(lee, { job: resumed.job, outcome: 'stopped' })).toMatchObject({ outcome: 'stopped', released: W('W1'), state: 'todo' });
  expect(await row(kolab, 'W2')).toMatchObject({ state: 'in_progress', assignee_id: 'lee-engineer-1' });
});

test('an item whose last two jobs ended in the last hour without doing it is held back, and the refusal says how many (JOB2)', async () => {
  const { kolab, lee } = await planned(2);
  for (let i = 0; i < 2; i++) {
    const j = await take(kolab, lee);
    expect(j.item).toBe(W('W1'));
    await kolab.endJob(lee, { job: j.job, outcome: 'failed', note: 'The tests never pass.' });
  }
  // W1 is held back: the next take builds W2, and the one after finds nothing.
  expect(await take(kolab, lee)).toMatchObject({ item: W('W2') });
  const refused = await kolab.takeJob(lee, { machine: 'lee-laptop' });
  expect(refused).toMatchObject({ taken: false, counts: { held_back: 1, ready: 0 } });
  expect(refused.taken === false && refused.why).toMatch(/every ready work package in orders-pg is held back; and 1 item is held back: the last two jobs on it ended in the last hour without doing it \(JOB2\)$/);
  expect((await kolab.listJobs(lee)).queue).toStrictEqual({ review: 0, build: 0 });
  // An hour on, it is taken again.
  await kolab.db.query(`alter table job disable trigger job_fixed`);
  await kolab.db.query(`update job set ended_at = ended_at - interval '61 minutes' where element_id = 'W1'`);
  await kolab.db.query(`alter table job enable trigger job_fixed`);
  expect(await take(kolab, lee)).toMatchObject({ item: W('W1') });
});

test('a job ends when it can run no more: its lease lapsed, its agent released its package, its runner signed out, its kolab archived (JOB1, JOB2, JOB3)', async () => {
  const { kolab, lee } = await planned(4);
  const j = await take(kolab, lee);
  expect(await kolab.liveSession(j.token)).toMatchObject({ job: true });
  // Unswept, a lapsed lease already loses the job's exception for its token.
  await kolab.db.query(`update job set lease_until = clock_timestamp() - interval '1 second' where id = $1`, [j.job]);
  expect(await kolab.liveSession(j.token)).toMatchObject({ job: false });
  await kolab.sweepLapsedJobs();
  // Its agent releases the package: the sweep ends the job, released.
  const k = await take(kolab, lee);
  await kolab.releaseWork(k.token, k.item, { note: 'Not mine.' });
  expect(await kolab.sweepLapsedJobs()).toBe(1);
  expect(await jobRow(kolab, k.job)).toMatchObject({ outcome: 'released', ended_by: 'kolab', note: `its agent ${k.agent} no longer holds ${k.item} (JOB1)` });
  expect(await kolab.sessionOpen(k.token)).toBe(false);
  // Its runner signs out: its jobs stop, and their agents' sessions end.
  const m = await take(kolab, lee);
  const n = await take(kolab, lee);
  await kolab.endSession(lee);
  for (const x of [m, n]) {
    expect(await jobRow(kolab, x.job)).toMatchObject({ outcome: 'stopped', said: 'stopped', ended_by: 'lee', note: 'its runner\'s session ended' });
    expect(await kolab.sessionOpen(x.token)).toBe(false);
    expect(await row(kolab, x.item.split('#')[1])).toMatchObject({ state: 'todo' });
  }
  // Archiving the kolab stops its live jobs, with their sessions.
  const again = await kolab.openSession('lee', 'engineer');
  const p = await take(kolab, again);
  await kolab.archive({ kolab: TEST_KOLAB });
  expect(await jobRow(kolab, p.job)).toMatchObject({ outcome: 'stopped', note: 'kolab test is archived' });
  expect(await kolab.sessionOpen(p.token)).toBe(false);
});

test('a job in an archived kolab holds no place under the caps, and its runner is told the kolab is out of reach (JOB3)', async () => {
  const { kolab, lee } = await planned(2);
  const j = await take(kolab, lee);
  // Archived outside Kolab's verbs, which would have ended it: the job is left live.
  await kolab.db.query(`update kolab set archived_at = now() where id = $1`, [TEST_KOLAB]);
  const caps = await (kolab as unknown as { jobCapsIn(q: unknown, p: string, k: string): Promise<unknown> }).jobCapsIn(kolab.db, 'lee', TEST_KOLAB);
  expect(caps).toStrictEqual({ person: { live: 0, max: 4 }, kolab: { live: 0, max: 8 } });
  // Its runner is told the kolab is out of reach, never that the job lapsed; and it changes nothing there.
  expect(await rejection(kolab.renewJob(lee, j.job))).toBe('AccessError: lee can no longer reach kolab test; its session has ended');
  expect(await rejection(kolab.endJob(lee, { job: j.job, outcome: 'done' }))).toMatch(/^RoleError: no open session for that token/);
  expect(await jobRow(kolab, j.job)).toMatchObject({ ended_at: null });
});

test('a pool name in another account\'s namespace is refused, saying so (JOB3)', async () => {
  const { kolab, lee } = await planned(1);
  await kolab.addOrganization('lee-engineer');
  const r = await kolab.takeJob(lee, { machine: 'lee-laptop' });
  expect(r).toMatchObject({ taken: false });
  expect(r.taken === false && r.why).toMatch(/^your pool agents are named lee-engineer-<n>, and those names lie in the namespace of the account lee-engineer \(its names start lee-engineer-\), so Kolab makes no pool agent for you/);
});

test('the job table keeps its ledger: a live job changes only its lease, an ended one nothing, and none is deleted (JOB1, migration 0034)', async () => {
  const { kolab, lee } = await planned(1);
  const j = await take(kolab, lee);
  const refused = /job: a job is never deleted, and changes only its lease until it ends, once \(JOB1\)/;
  expect(await rejection(kolab.db.query(`update job set machine = 'elsewhere' where id = $1`, [j.job]))).toMatch(refused);
  expect(await rejection(kolab.db.query(`update job set agent_id = 'lee' where id = $1`, [j.job]))).toMatch(refused);
  await kolab.db.query(`update job set lease_until = lease_until - interval '1 minute' where id = $1`, [j.job]);
  await kolab.endJob(lee, { job: j.job, outcome: 'stopped' });
  expect(await rejection(kolab.db.query(`update job set lease_until = lease_until where id = $1`, [j.job]))).toMatch(refused);
  expect(await rejection(kolab.db.query(`update job set outcome = 'submitted' where id = $1`, [j.job]))).toMatch(refused);
  expect(await rejection(kolab.db.query(`delete from job where id = $1`, [j.job]))).toMatch(refused);
  expect(await rejection(kolab.db.query(`truncate job cascade`))).toMatch(refused);
});

test('takes at once: one person on two machines gets two agents and two items, and a race past the cap starts no more than it allows (JOB1, JOB3)', async () => {
  const { kolab, lee } = await planned(8);
  const [a, b] = await Promise.all([take(kolab, lee, 'lee-laptop'), take(kolab, lee, 'lee-desktop')]);
  expect(a.agent).not.toBe(b.agent);
  expect(a.item).not.toBe(b.item);
  // A job's id is a ULID, which the runner's check of job ids takes.
  expect([a.job, b.job].every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))).toBe(true);
  const raced = await Promise.all(Array.from({ length: 5 }, (_, i) => kolab.takeJob(lee, { machine: `m${i}` }).catch((e: unknown) => ({ taken: false as const, why: String(e) }))));
  expect(raced.filter((r) => r.taken).length).toBe(2);
  expect((await kolab.db.query<{ n: number }>(`select count(*)::int as n from job where ended_at is null and person_id = 'lee'`)).rows[0].n).toBe(4);
  // Every session a refused take opened was given back: one open per live job.
  expect((await kolab.db.query<{ n: number }>(`select count(*)::int as n from session where actor_id like 'lee-engineer-%' and ended_at is null`)).rows[0].n).toBe(4);
});

test('with work in several bindings, a build job pulls from the first, by name, that has a ready package, naming it to the pull (JOB2, D104)', async () => {
  const { kolab, bob, lee } = await planned(1);
  await kolab.createNode(bob, 'binding', 'Orders API', 'orders-api');
  const v = await kolab.draft(bob, 'orders-api', { elements: [{ id: 'A1', text: 'Build the API.', work: { done_when: 'It answers.' } }] });
  const r = await kolab.submit(bob, v);
  if (r.in_review) expect(await kolab.recordReview(lee, v, { verdict: 'approve' })).toMatchObject({ ok: true });
  // A bare pull with work in two bindings asks which; a job names it.
  expect(await rejection(kolab.pullWork(bob))).toMatch(/has work in bindings orders-api, orders-pg: name the one to pull from, binding=<name>/);
  const first = await take(kolab, lee);
  expect(first).toMatchObject({ kind: 'build', item: 'kj:orders-api#A1', trailer: 'Konjir-Work: kj:test/orders-api#A1' });
  const second = await take(kolab, lee);
  expect(second).toMatchObject({ kind: 'build', item: W('W1'), trailer: 'Konjir-Work: kj:test/orders-pg#W1' });
  const none = await kolab.takeJob(lee, { machine: 'lee-laptop' });
  expect(none.taken === false && none.why).toBe('nothing in orders-api is To do: 1 In progress, 0 In review, 0 Done; nothing in orders-pg is To do: 1 In progress, 0 In review, 0 Done');
});
