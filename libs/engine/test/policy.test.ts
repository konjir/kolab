// A kolab's autonomy policy (W6.2; AUT1–AUT5, AUT7, VER13; POL1–POL4, D103, D109; migration 0041):
// who approves each layer's versions and work packages, a binding's product review, who answers a
// functional question and with what cites, and the job caps; read and changed by a kolab's Admins
// from their own sessions, audited, taking effect at once; and what no setting reaches.
import { expect, test } from '@jest/globals';
import { type Kolab } from '@konjir/engine';
import { TEST_KOLAB, agentsMay, els, openKolab, people, registeredRepository, rejection, testPolicy } from '@konjir/engine/testing';
import { DEFAULT_POLICY, JOB_KINDS, type KolabEvent } from '@konjir/types';

const sha = (c: string) => c.repeat(40);

/**
 * The test kolab, with Ada its Admin: a person with Write on both layers, who may change its policy.
 * Her agents write each layer: ada-pm and ada-pm-2 the functional, ada-eng and ada-eng-2 the
 * technical. Bob, a person, writes the technical layer and is no Admin. The spec `orders` is
 * committed, R1 and R2, written by Ada.
 */
async function adasKolab() {
  const kolab = await openKolab();
  await people(kolab, 'ada', { level: 'admin' });
  await people(kolab, ['ada-pm', 'ada-pm-2'], { owner: 'ada', layers: ['functional'] });
  await people(kolab, ['ada-eng', 'ada-eng-2'], { owner: 'ada', layers: ['technical'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const s = {
    ada: await kolab.openSession('ada', 'product'),
    pm: await kolab.openSession('ada-pm', 'product'),
    pm2: await kolab.openSession('ada-pm-2', 'product'),
    eng: await kolab.openSession('ada-eng', 'engineer'),
    eng2: await kolab.openSession('ada-eng-2', 'engineer'),
    bob: await kolab.openSession('bob', 'engineer'),
  };
  await kolab.createNode(s.ada, 'spec', 'Orders', 'orders');
  // Ada's own spec: no other person writes the functional layer, so it commits on the checks alone (VER11).
  await kolab.commit(s.ada, 'orders', { elements: els({ R1: 'Orders can be cancelled.', R2: 'Orders ship in a day.' }) });
  /** Ada signed in again in `role`: a hand-issued session is one at a time, so her last one ends. */
  const adaAs = async (role: 'product' | 'engineer') => { await kolab.endSessions({ actor: 'ada' }); return kolab.openSession('ada', role); };
  return { kolab, s, adaAs };
}

/** A binding version by ada-eng, linking b1 to the spec's R1, submitted. */
async function bindingInReview(kolab: Kolab, eng: string, text = 'A cancelled flag on the order row.') {
  if (!(await kolab.listNodes('binding', TEST_KOLAB)).some((n) => n.name === 'orders-pg')) await kolab.createNode(eng, 'binding', 'Orders on Postgres', 'orders-pg');
  const spec = (await kolab.latestCommitted('orders'))!.id;
  const v = await kolab.draft(eng, 'orders-pg', { elements: els({ b1: text }), links: [{ kind: 'dependency', sourceElement: 'b1', target: spec, targetElement: 'R1' }] });
  return { v, r: await kolab.submit(eng, v) };
}

test('with the defaults, an agent\'s approval of a functional version is refused and of a technical one counts (AUT2, POL3)', async () => {
  const { kolab, s } = await adasKolab();
  // An agent's spec version is asked of Ada alone: the other agent may not approve it, and isn't asked.
  const v2 = await kolab.draft(s.pm, 'orders', { deltas: [{ kind: 'override', element: 'R2', text: 'Orders ship in two days.' }] });
  expect(await kolab.submit(s.pm, v2)).toMatchObject({ in_review: true, reviewers: ['ada'] });
  expect(await kolab.reviewRequests({ reviewer: 'ada-pm-2' })).toStrictEqual([]);
  for (const verdict of ['approve', 'request_changes'] as const) {
    expect(await rejection(kolab.recordReview(s.pm2, v2, { verdict, note: 'x' })))
      .toMatch(/AccessError: kolab test's policy keeps reviewing functional versions for a person \(AUT2; konjir_read_policy\): ada-pm-2 is an agent, so it gives no verdict on orders@2/);
  }
  expect(await kolab.version(v2)).toMatchObject({ state: 'in_review' });
  expect(await kolab.recordReview(s.ada, v2, { verdict: 'approve' })).toMatchObject({ ok: true, note: 'Approved by ada.' });

  // A binding version is asked of everyone else who writes the technical layer, agents too, and an agent's approval commits it.
  const { v, r } = await bindingInReview(kolab, s.eng);
  expect(r).toMatchObject({ in_review: true, reviewers: ['ada', 'ada-eng-2', 'bob'] });
  expect(await kolab.recordReview(s.eng2, v, { verdict: 'approve' })).toMatchObject({ ok: true, note: 'Approved by ada-eng-2.' });
  expect(await kolab.version(v)).toMatchObject({ state: 'committed' });
});

test('with no one else the policy lets approve, a version commits unreviewed only if its author\'s own act meets the setting; otherwise it waits for a person (VER11, AUT1)', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'alice-pm', { owner: 'alice', layers: ['functional'] });
  const alice = await kolab.openSession('alice', 'product');
  const pm = await kolab.openSession('alice-pm', 'product');
  await kolab.createNode(alice, 'spec', 'Orders', 'orders');
  // A person's spec, where only her agent writes the layer beside her: a person approves, and she is one.
  const v1 = await kolab.draft(alice, 'orders', { elements: els({ R1: 'One.' }) });
  const r1 = await kolab.submit(alice, v1);
  expect(r1).toMatchObject({ ok: true, unreviewed: true });
  expect(r1.note).toMatch(/No person other than its author holds Write on the functional layer, where the kolab's policy keeps approving for a person \(AUT2\), so these checks alone committed it, unreviewed \(VER11\)\.$/);
  // Her agent's goes to her.
  const v2 = await kolab.draft(pm, 'orders', { deltas: [{ kind: 'override', element: 'R1', text: 'One, the first.' }] });
  expect(await kolab.submit(pm, v2)).toMatchObject({ in_review: true, reviewers: ['alice'] });
  expect(await kolab.recordReview(alice, v2, { verdict: 'approve' })).toMatchObject({ ok: true });

  // An organization's agent, where no person writes the layer, waits for a person, and says why.
  await kolab.addOrganization('acme');
  await kolab.createKolab('acme-api', { owner: 'acme' });
  await kolab.addActor('acme-bot', { owner: 'acme' });
  await kolab.grant('acme-api', 'acme-bot', 'write', { layers: ['functional'] });
  const bot = await kolab.openSession('acme-bot', 'product');
  await kolab.createNode(bot, 'spec', 'API', 'api');
  const a1 = await kolab.draft(bot, 'api', { elements: els({ A1: 'Requests are authenticated.' }) });
  const r = await kolab.submit(bot, a1);
  expect(r).toMatchObject({ ok: false, in_review: true, reviewers: [], nobody: expect.stringMatching(/^Kolab acme-api's policy keeps approving functional versions for a person \(AUT2\), and nobody here who may is free to: it waits in review until such a person holds Write on the layer, or a kolab Admin changes the policy \(konjir_set_policy\)\.$/) });
  expect(r.note).toContain(r.nobody);
  expect(await kolab.submit(bot, a1)).toMatchObject({ in_review: true, reviewers: [], nobody: r.nobody });
  // Once the kolab lets an agent approve, resubmitting it commits it on the checks alone, as VER11 says.
  await testPolicy(kolab, { approve_functional: 'agent' }, 'acme-api');
  expect(await kolab.submit(bot, a1)).toMatchObject({ ok: true, unreviewed: true, note: expect.stringMatching(/Everyone who could review it has gone: No one other than its author holds Write on the functional layer/) });
});

test('other_person: neither the author nor the owner of the agent that wrote it approves; with no other person it waits (AUT2)', async () => {
  const { kolab, s, adaAs } = await adasKolab();
  await testPolicy(kolab, { approve_functional: 'other_person' });
  const v2 = await kolab.draft(s.pm, 'orders', { deltas: [{ kind: 'override', element: 'R2', text: 'Orders ship in two days.' }] });
  const r = await kolab.submit(s.pm, v2);
  expect(r).toMatchObject({ in_review: true, reviewers: [], nobody: expect.stringMatching(/for a person other than the one whose intent it carries/) });
  expect(await rejection(kolab.recordReview(s.ada, v2, { verdict: 'approve' })))
    .toMatch(/AccessError: kolab test's policy keeps reviewing functional versions for a person other than the one whose intent the version carries .*orders@2 carries ada's, written by their agent ada-pm/);
  // Another person joins: they are asked when it is resubmitted, and their approval commits it.
  await people(kolab, 'dana', { layers: ['functional'] });
  expect(await kolab.submit(s.pm, v2)).toMatchObject({ in_review: true, reviewers: ['dana'] });
  expect(await kolab.recordReview(await kolab.openSession('dana', 'product'), v2, { verdict: 'approve' })).toMatchObject({ ok: true });
  // Ada's own version goes to Dana too, never to Ada's agents: it carries her intent.
  const v3 = await kolab.draft(s.ada, 'orders', { deltas: [{ kind: 'override', element: 'R1', text: 'Orders can be cancelled until they ship.' }] });
  expect(await kolab.submit(s.ada, v3)).toMatchObject({ in_review: true, reviewers: ['dana'] });

  // On the technical layer: Bob, a person other than Ada, approves her agent's binding; she and her agents don't.
  await testPolicy(kolab, { approve_technical: 'other_person' });
  const { v, r: rb } = await bindingInReview(kolab, s.eng);
  expect(rb).toMatchObject({ in_review: true, reviewers: ['bob'] });
  expect(await rejection(kolab.recordReview(await adaAs('engineer'), v, { verdict: 'approve' }))).toMatch(/AccessError: .*other than the one whose intent the version carries/);
  expect(await rejection(kolab.recordReview(s.eng2, v, { verdict: 'approve' }))).toMatch(/AccessError: .*ada-eng-2 is an agent/);
  expect(await kolab.recordReview(s.bob, v, { verdict: 'approve' })).toMatchObject({ ok: true });
});

test('a kolab\'s Admins read and change its policy from their own sessions: never an agent, nor anyone without Admin; each change audited with its actor (POL2)', async () => {
  const { kolab, s } = await adasKolab();
  // An agent of Ada's, with Admin itself, is still an agent.
  await people(kolab, 'ada-ops', { owner: 'ada', level: 'admin' });
  const ops = await kolab.openSession('ada-ops', 'engineer');
  expect(await kolab.readPolicy(s.ada)).toStrictEqual({
    kolab: 'test', policy: { ...DEFAULT_POLICY }, changed_from_default: [], limits: { jobs_per_person: 4, jobs_per_kolab: 8 }, updated_by: null, updated_at: null,
  });
  for (const who of [ops, s.pm]) {
    expect(await rejection(kolab.readPolicy(who))).toMatch(/AccessError: ada-(ops|pm) is an agent, and a kolab's policy is read and changed only from a person's own session \(POL2\)/);
    expect(await rejection(kolab.setPolicy(who, { approve_functional: 'agent' }))).toMatch(/AccessError: ada-(ops|pm) is an agent/);
  }
  expect(await rejection(kolab.readPolicy(s.bob))).toMatch(/AccessError: kolab test's policy is read and changed by those with Admin there \(POL2\); bob holds Write on the technical layer/);
  expect(await rejection(kolab.setPolicy(s.bob, { approve_functional: 'agent' }))).toMatch(/AccessError: kolab test's policy is read and changed by those with Admin there/);
  // What it takes: only the settings, each one of its values; the caps within the server's own limits.
  expect(await rejection(kolab.setPolicy(s.ada, {}))).toMatch(/GateError: name a setting to change/);
  expect(await rejection(kolab.setPolicy(s.ada, { approve_rulings: 'agent' }))).toMatch(/GateError: approve_rulings is not a setting of a kolab's policy/);
  expect(await rejection(kolab.setPolicy(s.ada, { approve_work: 'other_person' }))).toMatch(/GateError: approve_work is one of agent, person, not "other_person"/);
  expect(await rejection(kolab.setPolicy(s.ada, { product_review_of_bindings: 'yes' }))).toMatch(/GateError: product_review_of_bindings is true or false/);
  for (const bad of [0, 5, 2.5]) expect(await rejection(kolab.setPolicy(s.ada, { jobs_per_person: bad }))).toMatch(/LimitError: jobs_per_person is a whole number from 1 to 4, the server's own limit/);
  expect(await rejection(kolab.setPolicy(s.ada, { jobs_per_kolab: 9 }))).toMatch(/LimitError: jobs_per_kolab is a whole number from 1 to 8/);
  expect(await kolab.auditLog({ kolab: 'test' })).not.toEqual(expect.arrayContaining([expect.objectContaining({ action: 'policy.set' })]));

  const set = await kolab.setPolicy(s.ada, { approve_technical: 'person', jobs_per_kolab: 6 });
  expect(set).toMatchObject({
    kolab: 'test', policy: { ...DEFAULT_POLICY, approve_technical: 'person', jobs_per_kolab: 6 }, changed_from_default: ['approve_technical', 'jobs_per_kolab'],
    updated_by: 'ada', updated_at: expect.any(String), requests: { added: 0, withdrawn: 0 },
    changes: [{ setting: 'approve_technical', was: 'agent', now: 'person' }, { setting: 'jobs_per_kolab', was: 8, now: 6 }],
  });
  expect(await kolab.readPolicy(s.ada)).toMatchObject({ policy: set.policy, updated_by: 'ada' });
  const [event] = (await kolab.auditLog({ kolab: 'test' })).filter((e) => e.action === 'policy.set');
  expect(event).toMatchObject({ action: 'policy.set', kolab: 'test', subject: 'test', by: 'ada', detail: { changes: set.changes } });
  // Setting what is set changes nothing, and records nothing.
  expect(await kolab.setPolicy(s.ada, { approve_technical: 'person' })).toMatchObject({ changes: [] });
  expect((await kolab.auditLog({ kolab: 'test' })).filter((e) => e.action === 'policy.set')).toHaveLength(1);
  // An Admin who loses Admin can no longer change it.
  await kolab.grant('test', 'ada', 'write');
  expect(await rejection(kolab.setPolicy(s.ada, { approve_technical: 'agent' }))).toMatch(/AccessError: kolab test's policy is read and changed by those with Admin there/);
});

test('a change takes effect at once: the review requests waiting are given again under it, and the inboxes told (POL2, REV6)', async () => {
  const { kolab, s } = await adasKolab();
  const v2 = await kolab.draft(s.pm, 'orders', { deltas: [{ kind: 'override', element: 'R2', text: 'Orders ship in two days.' }] });
  expect(await kolab.submit(s.pm, v2)).toMatchObject({ reviewers: ['ada'] });
  const { v } = await bindingInReview(kolab, s.eng);
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));

  // Agents may approve functional versions: ada-pm-2 is asked now, and its verdict counts.
  expect(await kolab.setPolicy(s.ada, { approve_functional: 'agent' })).toMatchObject({ requests: { added: 1, withdrawn: 0 } });
  expect((await kolab.reviewRequests({ reviewer: 'ada-pm-2' })).map((r) => r.subject)).toStrictEqual(['kj:orders@2']);
  expect(events).toEqual(expect.arrayContaining([{ inbox: 'layer', kolab: 'test', layer: 'functional' }, { inbox: 'actor', kolab: 'test', actor: 'ada-pm' }]));
  // And back: its request is withdrawn, and its verdict refused at once.
  expect(await kolab.setPolicy(s.ada, { approve_functional: 'person' })).toMatchObject({ requests: { added: 0, withdrawn: 1 } });
  expect(await kolab.reviewRequests({ reviewer: 'ada-pm-2' })).toStrictEqual([]);
  expect(await rejection(kolab.recordReview(s.pm2, v2, { verdict: 'approve' }))).toMatch(/AccessError: kolab test's policy keeps reviewing functional versions for a person/);

  // Only a person approves technical versions: the agent's request goes; Bob's and Ada's stay.
  events.length = 0;
  expect(await kolab.setPolicy(s.ada, { approve_technical: 'person' })).toMatchObject({ requests: { added: 0, withdrawn: 1 } });
  expect((await kolab.reviewRequests({ kolab: 'test', layer: 'technical' })).map((r) => r.reviewer).sort()).toStrictEqual(['ada', 'bob']);
  expect(events).toEqual(expect.arrayContaining([{ inbox: 'layer', kolab: 'test', layer: 'technical' }, { inbox: 'actor', kolab: 'test', actor: 'ada-eng' }]));
  expect(await rejection(kolab.recordReview(s.eng2, v, { verdict: 'approve' }))).toMatch(/AccessError: kolab test's policy keeps reviewing technical versions for a person/);
  expect(await kolab.recordReview(s.bob, v, { verdict: 'approve' })).toMatchObject({ ok: true });
  expect(await kolab.recordReview(s.ada, v2, { verdict: 'approve' })).toMatchObject({ ok: true });
});

test('an agent answers a question on the functional layer only citing committed elements or rulings, each checked; with "person only", not at all (AUT4, POL3)', async () => {
  const { kolab, s } = await adasKolab();
  const ask = (q = 'Can a shipped order be cancelled?') => kolab.raiseQuery(s.bob, 'kj:orders#R1', q);
  const q1 = await ask();
  // Uncited, refused: the question stays open, for a person.
  for (const cites of [undefined, []]) {
    expect(await rejection(kolab.answerQuery(s.pm, q1, 'No.', { cites }))).toMatch(/GateError: an agent answers a question on the functional layer only by citing committed elements or precedent \(AUT4\)/);
  }
  // Each cite is checked: it exists, is committed, names an element, and can be read.
  await kolab.addActor('zed');
  await kolab.createKolab('elsewhere', { owner: 'zed' });
  await kolab.grant('elsewhere', 'zed', 'write');
  const zed = await kolab.openSession('zed', 'product', { kolab: 'elsewhere' });
  await kolab.createNode(zed, 'spec', 'Secret', 'secret');
  await kolab.commit(zed, 'secret', { elements: els({ S1: 'Hidden.' }) });
  const v3 = await kolab.draft(s.pm, 'orders', { deltas: [{ kind: 'override', element: 'R1', text: 'Orders can be cancelled until they ship.' }] });
  await kolab.submit(s.pm, v3);
  for (const [cite, why] of [
    ['kj:orders@1#R9', /cite kj:orders@1#R9: orders@1 has no element R9/],
    ['kj:nothing#R1', /cite kj:nothing#R1: no node nothing in kolab test/],
    ['kj:orders@7#R1', /cite kj:orders@7#R1: orders has no version 7/],
    ['kj:orders@2#R1', /cite kj:orders@2#R1: orders@2 is in_review, not committed: an answer cites only what is committed/],
    ['kj:orders@1', /cite kj:orders@1 names no element/],
    ['kj:elsewhere/secret@1#S1', /cite kj:elsewhere\/secret@1#S1: no node secret in kolab elsewhere/],
    ['01HZZZZZZZZZZZZZZZZZZZZZZZ', /cite 01HZZZZZZZZZZZZZZZZZZZZZZZ is neither a kj: address nor a ruling you can read in kolab test/],
    ['kj:orders#R1~q({"exact":"never said"})', /orders@1 has no element R1 holding that quote/],
  ] as const) {
    expect(await rejection(kolab.answerQuery(s.pm, q1, 'No.', { cites: [cite] }))).toMatch(why);
  }
  expect(await rejection(kolab.answerQuery(s.pm, q1, 'No.', { cites: 'kj:orders#R1' }))).toMatch(/GateError: cites is a list/);
  expect(await rejection(kolab.answerQuery(s.pm, q1, 'No.', { cites: Array.from({ length: 21 }, () => 'kj:orders#R1') }))).toMatch(/LimitError: an answer cites at most 20/);
  expect((await kolab.listQueries({ kolab: 'test' })).find((q) => q.id === q1)).toMatchObject({ state: 'open' });

  // Cited, it stands: each address pinned to the version it read, and a ruling of the kolab's.
  const ruling = await kolab.rule(s.ada, { address: 'kj:orders#R2', text: 'A day means a working day.', effect: 'keep_intent' });
  await kolab.answerQuery(s.pm, q1, 'No: only until it ships.', { cites: ['kj:orders#R1', 'kj:orders@1#R2', ruling, 'kj:orders@1#R1'] });
  const answered = (await kolab.listQueries({ kolab: 'test' })).find((q) => q.id === q1)!;
  expect(answered).toMatchObject({ state: 'answered', answered_by: 'ada-pm', cites: ['kj:orders@1#R1', 'kj:orders@1#R2', ruling] });
  // Another kolab's reader sees the addresses in full.
  expect((await kolab.db.query(`select answer_cites from query where id = $1`, [q1])).rows[0]).toStrictEqual({ answer_cites: ['kj:test/orders@1#R1', 'kj:test/orders@1#R2', ruling] });

  // A person answers without citing; an agent replies to a note uncited; on the technical layer, an agent answers uncited.
  const q2 = await ask('And a returned one?');
  await kolab.answerQuery(s.ada, q2, 'Returns are another spec.');
  const note = await kolab.raiseQuery(s.bob, 'kj:orders#R2', 'We read a day as 24 hours.', { kind: 'note' });
  await kolab.answerQuery(s.pm, note, 'Working days: see the ruling.');
  const { v } = await bindingInReview(kolab, s.eng);
  expect(await kolab.recordReview(s.eng2, v, { verdict: 'approve' })).toMatchObject({ ok: true });
  const tq = await kolab.raiseQuery(s.pm, 'kj:orders-pg#b1', 'Is the flag indexed?');
  await kolab.answerQuery(s.eng2, tq, 'Yes.');
  expect((await kolab.listQueries({ kolab: 'test', state: 'answered' })).map((q) => [q.id, q.cites ?? null])).toEqual(expect.arrayContaining([[q2, null], [note, null], [tq, null]]));

  // Person only: every agent answer on the functional layer is refused, cited or not; a person's stands.
  await kolab.setPolicy(s.ada, { answer_functional: 'person' });
  const q3 = await ask('What of a partly shipped order?');
  expect(await rejection(kolab.answerQuery(s.pm, q3, 'Until the first part ships.', { cites: ['kj:orders#R1'] })))
    .toMatch(/AccessError: kolab test's policy keeps answering questions on the functional layer for a person \(AUT4; konjir_read_policy\): ada-pm is an agent, so query \w+ stays open for a person to answer/);
  await kolab.answerQuery(s.ada, q3, 'Until the first part ships.', { cites: ['kj:orders#R1'] });
  expect((await kolab.listQueries({ kolab: 'test' })).find((q) => q.id === q3)).toMatchObject({ state: 'answered', answered_by: 'ada', cites: ['kj:orders@1#R1'] });
});

/** A binding with one work package, W1, relying on b1, and its repository; Ada's agent ada-eng holds W1 and submits it with a commit. */
async function packageInReview() {
  const ctx = await adasKolab();
  const { kolab, s } = ctx;
  const { v } = await bindingInReview(kolab, s.eng);
  await kolab.recordReview(s.bob, v, { verdict: 'approve' });
  const w = await kolab.draft(s.eng, 'orders-pg', {
    elements: [...els({ b1: 'A cancelled flag on the order row.' }), { id: 'W1', text: 'Build the flag.', work: { done_when: 'It is built.' } }],
    links: [{ kind: 'dependency', sourceElement: 'W1', target: v, targetElement: 'b1' }],
  });
  await kolab.submit(s.eng, w);
  await kolab.recordReview(s.bob, w, { verdict: 'approve' });
  await registeredRepository(kolab, { binding: 'orders-pg' });
  expect(await kolab.pullWork(s.eng)).toMatchObject({ pulled: true, item: { id: 'W1' } });
  return { ...ctx, submitted: await kolab.submitWork(s.eng, 'kj:orders-pg#W1', { evidence: [{ kind: 'commit', sha: sha('a'), title: 'Build the flag' }] }) };
}

test('approve_work: an agent reviewer approves work by default; where a person must, an agent\'s verdict is refused and no job offers it (AUT3, POL3)', async () => {
  const { kolab, s, submitted } = await packageInReview();
  expect(submitted).toMatchObject({ state: 'in_review', reviewers: ['ada', 'ada-eng-2', 'bob'] });
  // Bob takes a job: the review is offered to his pool agent, as an agent may approve work.
  const lee = s.bob;
  const offered = await kolab.takeJob(lee, { machine: 'm', kinds: [...JOB_KINDS] });
  expect(offered).toMatchObject({ taken: true, kind: 'review', item: 'kj:orders-pg#W1' });
  await kolab.endJob(lee, { job: (offered as { job: string }).job, outcome: 'stopped' });

  expect(await kolab.setPolicy(s.ada, { approve_work: 'person' })).toMatchObject({ requests: { added: 0, withdrawn: 1 } });
  expect((await kolab.reviewRequests({ kolab: 'test', layer: 'technical' })).filter((r) => r.subject_kind === 'work').map((r) => r.reviewer).sort()).toStrictEqual(['ada', 'bob']);
  expect(await rejection(kolab.reviewWork(s.eng2, 'kj:orders-pg#W1', { verdict: 'approve' })))
    .toMatch(/AccessError: kolab test's policy keeps reviewing work packages for a person \(AUT3; konjir_read_policy\): ada-eng-2 is an agent/);
  expect(await kolab.takeJob(lee, { machine: 'm', kinds: ['review'] })).toMatchObject({ taken: false, counts: { review: 0 } });
  expect(await kolab.reviewWork(s.bob, 'kj:orders-pg#W1', { verdict: 'approve' })).toMatchObject({ state: 'done' });
});

test('approve_technical=person: no job offers a technical version\'s review, and a person\'s approval commits it (AUT2, JOB2)', async () => {
  const { kolab, s } = await adasKolab();
  const { v } = await bindingInReview(kolab, s.eng);
  const lee = s.bob;
  expect((await kolab.listJobs(lee)).queue).toMatchObject({ review: 1 });
  await kolab.setPolicy(s.ada, { approve_technical: 'person' });
  expect((await kolab.listJobs(lee)).queue).toMatchObject({ review: 0 });
  expect(await kolab.takeJob(lee, { machine: 'm', kinds: ['review'] })).toMatchObject({ taken: false });
  expect(await kolab.recordReview(s.bob, v, { verdict: 'approve' })).toMatchObject({ ok: true });
});

test('product_review_of_bindings: a binding version also needs a product approval, from a product session, before it commits (VER13)', async () => {
  const { kolab, s } = await adasKolab();
  await kolab.setPolicy(s.ada, { product_review_of_bindings: true });
  const { v, r } = await bindingInReview(kolab, s.eng);
  // Its technical reviewers, and its product reviewers: those who write the functional layer whom the functional setting allows.
  expect(r).toMatchObject({ in_review: true, reviewers: ['ada', 'ada-eng-2', 'bob'], product_reviewers: ['ada'] });
  const [product] = await kolab.reviewRequests({ kolab: 'test', layer: 'functional' });
  expect(product).toMatchObject({ subject: 'kj:orders-pg@1', reviewer: 'ada', product_review: true, next: expect.stringMatching(/requires a product approval of bindings \(VER13\)/) });
  // A product agent may not give it: a person approves functional versions.
  expect(await rejection(kolab.recordReview(s.pm2, v, { verdict: 'approve' }))).toMatch(/AccessError: kolab test's policy keeps reviewing a binding's product review \(VER13\), as it does functional versions, for a person/);
  // The technical approval alone doesn't commit it.
  expect(await kolab.recordReview(s.eng2, v, { verdict: 'approve' })).toMatchObject({ ok: false, in_review: true, note: expect.stringMatching(/requires a product approval of bindings too \(VER13\)/) });
  expect(await kolab.version(v)).toMatchObject({ state: 'in_review' });
  // Ada's, from her product session, does.
  expect(await kolab.recordReview(s.ada, v, { verdict: 'approve', note: 'No behavior changes.' })).toMatchObject({ ok: true });
  expect((await kolab.submissions('ada-eng'))[0].verdicts.map((x) => [x.reviewer, x.state, x.product_review ?? false]))
    .toEqual(expect.arrayContaining([['ada-eng-2', 'approved', false], ['ada', 'approved', true]]));

  // A request for changes from the product review returns it to its author, as any.
  const { v: v2 } = await bindingInReview(kolab, s.eng, 'A cancelled_at timestamp, which also emails the customer.');
  expect(await kolab.recordReview(s.ada, v2, { verdict: 'request_changes', note: 'Emailing the customer is behavior the spec doesn\'t state.' })).toMatchObject({ ok: false });
  expect(await kolab.version(v2)).toMatchObject({ state: 'drafted' });
  expect(await kolab.reviewRequests({ kolab: 'test' })).toStrictEqual([]);
});

/** Ada's kolab with six ready work packages, for the job caps. */
async function sixPackages() {
  const ctx = await adasKolab();
  const { kolab, s } = ctx;
  await kolab.createNode(s.eng, 'binding', 'Orders on Postgres', 'orders-pg');
  const spec = (await kolab.latestCommitted('orders'))!.id;
  const b = await kolab.draft(s.eng, 'orders-pg', { elements: els({ b1: 'A flag.' }), links: [{ kind: 'dependency', sourceElement: 'b1', target: spec, targetElement: 'R1' }] });
  await kolab.submit(s.eng, b);
  await kolab.recordReview(s.bob, b, { verdict: 'approve' });
  const ids = [1, 2, 3, 4, 5, 6];
  const w = await kolab.draft(s.eng, 'orders-pg', {
    elements: [...els({ b1: 'A flag.' }), ...ids.map((i) => ({ id: `W${i}`, text: `Build ${i}.`, work: { done_when: `${i} works.` } }))],
    links: ids.map((i) => ({ kind: 'dependency' as const, sourceElement: `W${i}`, target: b, targetElement: 'b1' })),
  });
  await kolab.submit(s.eng, w);
  await kolab.recordReview(s.bob, w, { verdict: 'approve' });
  await registeredRepository(kolab, { binding: 'orders-pg' });
  return ctx;
}

test('take_job reads the caps from the kolab\'s policy, never above the server\'s own limits (AUT7)', async () => {
  const { kolab, s, adaAs } = await sixPackages();
  const ada = await adaAs('engineer');
  await kolab.setPolicy(ada, { jobs_per_person: 1, jobs_per_kolab: 2 });
  const bob = s.bob;
  expect(await kolab.takeJob(ada, { machine: 'm' })).toMatchObject({ taken: true, kind: 'build' });
  expect(await kolab.takeJob(ada, { machine: 'm' })).toMatchObject({
    taken: false, why: 'you have 1 live jobs in kolab test, the most its policy lets a person run at once there (1, AUT7): wait for one to end',
    caps: { person: { live: 1, max: 1 }, kolab: { live: 1, max: 2 }, everywhere: { live: 1, max: 4 } },
  });
  expect(await kolab.takeJob(bob, { machine: 'b' })).toMatchObject({ taken: true });
  await kolab.setPolicy(ada, { jobs_per_person: 4 });
  expect(await kolab.takeJob(ada, { machine: 'm' })).toMatchObject({ taken: false, why: 'kolab test has 2 live jobs, the most a kolab runs at once (2, JOB3): wait for one to end' });
  // The server's own limits bound the policy: lowered below it, the server's holds.
  kolab.jobLimits.perKolab = 1;
  expect(await kolab.readPolicy(ada)).toMatchObject({ policy: { jobs_per_kolab: 1 }, limits: { jobs_per_kolab: 1 } });
  expect((await kolab.listJobs(ada)).caps).toMatchObject({ kolab: { live: 2, max: 1 } });
});

test('rulings and registering a repository stay a person\'s, whatever the policy says (AUT5, POL4)', async () => {
  const { kolab, s, adaAs } = await adasKolab();
  // Every setting at its most permissive for agents.
  await kolab.setPolicy(s.ada, { approve_functional: 'agent', approve_technical: 'agent', approve_work: 'agent', answer_functional: 'agent_cited' });
  await agentsMay(kolab);
  expect(await rejection(kolab.rule(s.pm, { address: 'kj:orders#R1', text: 'Cancelling is free.', effect: 'keep_intent' }))).toMatch(/AccessError: .*ada-pm is an agent/);
  expect(await rejection(kolab.registerRepository(s.eng, { url: 'https://github.com/acme/orders', root_sha: sha('f') }))).toMatch(/AccessError: ada-eng is an agent, and an agent registers no repository/);
  // A person's ruling and registration stand, as ever.
  expect(await kolab.rule(s.ada, { address: 'kj:orders#R1', text: 'Cancelling is free.', effect: 'keep_intent' })).toEqual(expect.any(String));
  expect(await kolab.registerRepository(await adaAs('engineer'), { url: 'https://github.com/acme/orders', root_sha: sha('f') })).toMatchObject({ url: 'https://github.com/acme/orders' });
});
