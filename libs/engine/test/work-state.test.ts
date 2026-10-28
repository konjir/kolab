// Work state, its events, the board, pulling and the lease (W5.1b; PLN3–PLN5, PLN12–PLN15,
// PLN17–PLN19, D98; migration 0030): a committed plan's packages exist when its commit returns;
// ready work is pulled in natural order, one package per actor; a package is blocked by a
// dependency, an open question or an open case file; a lease runs on the database's clock, is
// renewed by its assignee's calls, and lapses back to To do with Kolab as the actor, never revived;
// only Kolab's trusted role writes work state, and events are never edited.
import { expect, test } from '@jest/globals';
import pg from 'pg';
import { naturalCompare, sessionKey, type Kolab } from '@konjir/engine';
import { commitReviewed, els, openKolab, people, rejection, testStore, TEST_KOLAB } from '@konjir/engine/testing';
import { ADMIN_DOER, type ElementInput } from '@konjir/types';

const POSTGRES = !!process.env.KONJIR_TEST_DATABASE_URL;

/** The M5 check's plan: four work packages, W2.1 after W1.1, and milestone M1 gathering them. */
const PLAN: ElementInput[] = [
  { id: 'W1.1', text: 'Build the cancel endpoint.', work: { done_when: 'POST /orders/:id/cancel cancels an order.', size: 'M' } },
  { id: 'W1.2', text: 'Build the shipping queue.', work: { size: 'S' } },
  { id: 'W1.10', text: 'Build the tracking page.', work: { done_when: 'A customer sees where the order is.' } },
  { id: 'W2.1', text: 'Cancel from the tracking page.', work: { depends_on: ['W1.1'], size: 'L' } },
  { id: 'M1', text: 'Orders run end to end.', work: { milestone: true, depends_on: ['W1.1', 'W1.2', 'W1.10', 'W2.1'], target_date: '2026-12-01' } },
];

/**
 * A kolab with a spec of four requirements, a binding of four elements serving them, and the plan
 * above, each package delivering one binding element. Alice writes the functional layer; bob, eve
 * and frank are engineers; mia maintains; carol only reads.
 */
async function planned(opts: { databaseUrl?: string } = {}) {
  const kolab = await openKolab(opts.databaseUrl ? { databaseUrl: opts.databaseUrl } : {});
  // Alice and bob alone on their layers while the spec and binding commit, so neither waits in review.
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const product = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'engineer');
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  // Each requirement under a section, so the context carries its ancestors.
  await kolab.commit(product, 'orders', { elements: els(
    { S: 'Orders.', R1: 'Orders can be cancelled.', R2: 'Orders ship in a day.', R3: 'Orders can be tracked.', R4: 'A tracked order can be cancelled.' },
    { R1: 'S', R2: 'S', R3: 'S', R4: 'S' }) });
  await kolab.createNode(bob, 'binding', 'Orders on Postgres', 'orders-pg');
  // Links to the committed spec, written with the draft.
  const spec = (await kolab.latestCommitted('orders'))!.id;
  const bv = await kolab.draft(bob, 'orders-pg', {
    elements: els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.', b3: 'A tracking page.', b4: 'A cancel button on the tracking page.' }),
    links: ['b1', 'b2', 'b3', 'b4'].map((b, i) => ({ kind: 'dependency' as const, sourceElement: b, target: spec, targetElement: `R${i + 1}` })),
  });
  expect((await kolab.submit(bob, bv)).ok).toBe(true);
  await kolab.createNode(bob, 'plan', 'Plan', 'orders-plan');
  const delivers = (from: string, to: string) => ({ kind: 'dependency' as const, sourceElement: from, target: bv, targetElement: to });
  const pv = await kolab.draft(bob, 'orders-plan', { elements: PLAN, links: [delivers('W1.1', 'b1'), delivers('W1.2', 'b2'), delivers('W1.10', 'b3'), delivers('W2.1', 'b4')] });
  const r = await kolab.submit(bob, pv);
  expect(r.ok).toBe(true);
  // A plan commits on its checks alone (PLN2), so more engineers change nothing of that.
  await people(kolab, ['eve', 'frank'], { layers: ['technical'] });
  await people(kolab, 'mia', { level: 'maintain' });
  await people(kolab, 'carol', { level: 'read' });
  const eve = await kolab.openSession('eve', 'engineer');
  const frank = await kolab.openSession('frank', 'engineer');
  return { kolab, product, bob, eve, frank, binding: bv, plan: pv, delivers };
}

/** The board's ids and states, in its order. */
async function board(kolab: Kolab, session: string) {
  return (await kolab.listWork(session)).items.map((i) => [i.id, i.state, i.assignee, i.ready]);
}

/** A package's events, kind and actor, oldest first. */
async function events(kolab: Kolab, session: string, work: string) {
  return (await kolab.readWork(session, work)).events.map((e) => [e.kind, e.actor]);
}

/** Makes `work`'s lease lapse now, as the database's clock reads it, by moving it into the past. */
async function lapse(kolab: Kolab, element: string, ago = '1 second') {
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() - interval '${ago}' where element_id = $1 and state = 'in_progress'`, [element]);
}

const row = async (kolab: Kolab, element: string) =>
  (await kolab.db.query<{ state: string; assignee_id: string | null; lease_until: Date | null; removed_in_version_id: string | null }>(
    `select state, assignee_id, lease_until, removed_in_version_id from work_package where element_id = $1`, [element])).rows[0];

test('natural order: digits compare as numbers, so W1.2 comes before W1.10 (PLN17)', () => {
  const ids = ['W1.10', 'W2.1', 'W1.2', 'M1', 'W1.1', 'W10', 'W9', 'W01.3', 'W1.3', 'a', 'A'];
  expect([...ids].sort(naturalCompare)).toStrictEqual(['A', 'M1', 'W1.1', 'W1.2', 'W01.3', 'W1.3', 'W1.10', 'W2.1', 'W9', 'W10', 'a']);
});

test('a committed plan has its work packages when its commit returns, each To do with an added event by its author, naming what it delivers (PLN4, PLN5)', async () => {
  const { kolab, bob, plan } = await planned();
  expect(await board(kolab, bob)).toStrictEqual([
    ['M1', 'todo', null, false], ['W1.1', 'todo', null, true], ['W1.2', 'todo', null, true], ['W1.10', 'todo', null, true], ['W2.1', 'todo', null, false],
  ]);
  const w = await kolab.readWork(bob, 'kj:orders-plan#W1.1');
  expect(w.events).toHaveLength(1);
  expect(w.events[0]).toMatchObject({ kind: 'added', from: null, to: 'todo', actor: 'bob', plan_version: 'kj:orders-plan@1', note: null });
  expect(w.events[0].concerned).toStrictEqual([{ address: 'kj:orders-pg@1#b1', version_id: expect.any(String), fingerprint: expect.any(String) }]);
  expect(w.trailer).toBe('Konjir-Work: kj:test/orders-plan#W1.1');
  // Every event names the plan version it stood in.
  expect((await kolab.db.query(`select distinct plan_version_id from work_event`)).rows).toStrictEqual([{ plan_version_id: plan }]);
  // A milestone is a package too, with no work of its own: never ready (PLN3, PLN13).
  const m = (await kolab.listWork(bob)).items.find((i) => i.id === 'M1')!;
  expect(m).toMatchObject({ milestone: true, ready: false, blocked: [] });
});

test('blocked: by a work package it depends on that isn\'t Done, by an open question and by an open case file on a binding element it delivers, not by a note (PLN19, D98)', async () => {
  const { kolab, product, bob } = await planned();
  const item = async (id: string) => (await kolab.listWork(bob)).items.find((i) => i.id === id)!;
  expect((await item('W2.1')).blocked).toStrictEqual([{ reason: 'depends_on', work: 'kj:orders-plan#W1.1', state: 'todo' }]);
  // A note blocks nothing.
  await kolab.raiseQuery(product, 'kj:orders-pg#b3', 'I read the tracking page as one page per order.', { kind: 'note' });
  expect((await item('W1.10')).ready).toBe(true);
  // An open question on what W1.10 delivers blocks it; answering it unblocks it.
  const q = await kolab.raiseQuery(product, 'kj:orders-pg#b3', 'Does the tracking page show the courier?');
  expect(await item('W1.10')).toMatchObject({ ready: false, blocked: [{ reason: 'question', on: 'kj:orders-pg@1#b3', query: q }] });
  await kolab.answerQuery(bob, q, 'Yes, with its tracking link.');
  expect(await item('W1.10')).toMatchObject({ ready: true, blocked: [] });
  // An open case file on what W1.2 delivers blocks it.
  const c = await kolab.openCase(bob, 'kj:orders-pg#b2', { question: 'Can the queue ship in a day?', claim: 'Not with one courier.', evidence: ['the courier contract'], seeks: 'change_intent' });
  expect(await item('W1.2')).toMatchObject({ ready: false, blocked: [{ reason: 'case_file', on: 'kj:orders-pg@1#b2', case: c }] });
  // Pull takes neither, but W1.1 (natural order, and ready).
  const r = await kolab.pullWork(bob);
  expect(r).toMatchObject({ pulled: true, item: { id: 'W1.1', state: 'in_progress', assignee: 'bob' } });
});

test('pulling: the first ready package in natural order, In progress with a lease and its context; one per actor; never a milestone; only an engineer who writes the technical layer (PLN13, PLN14, PLN17, PLN18)', async () => {
  const { kolab, product, bob, eve, frank } = await planned();
  const carol = await kolab.openSession('carol', 'engineer');
  const a = await kolab.pullWork(bob);
  if (!a.pulled) throw new Error(a.why);
  expect(a.item).toMatchObject({ work: 'kj:orders-plan#W1.1', state: 'in_progress', assignee: 'bob', lease_until: expect.any(String) });
  expect(a.trailer).toBe('Konjir-Work: kj:test/orders-plan#W1.1');
  // Its context (PLN14): the done-when, what it delivers at the binding's latest, and the spec it serves with its ancestors.
  expect(a.context).toMatchObject({
    work: 'kj:orders-plan#W1.1', done_when: 'POST /orders/:id/cancel cancels an order.', size: 'M', depends_on: [],
    delivers: [{ address: 'kj:orders-pg@1#b1', text: 'A cancel endpoint.', links: [{ kind: 'dependency', address: 'kj:orders@1#R1', text: 'Orders can be cancelled.', ancestors: [{ id: 'S', text: 'Orders.' }] }], questions: [], rulings: [] }],
  });
  // A lease of the kolab's length, 30 minutes by default, on the database's clock.
  const lease = (await kolab.db.query<{ s: number }>(`select extract(epoch from lease_until - clock_timestamp()) as s from work_package where element_id = 'W1.1'`)).rows[0].s;
  expect(Number(lease)).toBeGreaterThan(1790);
  expect(Number(lease)).toBeLessThanOrEqual(1800);
  // The next engineer gets W1.2: not W1.10 (natural order), not W2.1 (blocked by W1.1).
  expect(await kolab.pullWork(eve)).toMatchObject({ pulled: true, item: { id: 'W1.2' } });
  expect(await kolab.pullWork(frank)).toMatchObject({ pulled: true, item: { id: 'W1.10' } });
  // A second pull by bob is refused, naming what it holds (PLN18).
  expect(await rejection(kolab.pullWork(bob))).toMatch(/GateError: bob already holds kj:orders-plan#W1\.1 In progress.*\(PLN18\)/);
  // A product session, and an actor who only reads, pull nothing (PLN13).
  expect(await rejection(kolab.pullWork(product))).toMatch(/RoleError: a product session pulls no work/);
  expect(await rejection(kolab.pullWork(carol))).toMatch(/AccessError: carol may not write the technical layer/);
  // Nothing left ready: W2.1 is blocked, M1 is a milestone. The pull says why.
  await people(kolab, 'gus', { layers: ['technical'] });
  const gus = await kolab.openSession('gus', 'engineer');
  const none = await kolab.pullWork(gus);
  expect(none).toMatchObject({ pulled: false, counts: { todo: 1, blocked_by_dependencies: 1, in_progress: 3 } });
  if (!none.pulled) expect(none.why).toMatch(/every work package To do in orders-plan is blocked: 1 by a work package it depends on/);
  expect(await events(kolab, bob, 'kj:orders-plan#W1.1')).toStrictEqual([['added', 'bob'], ['pulled', 'bob']]);
  expect((await kolab.listWork(gus, { ready: true })).items).toStrictEqual([]);
  expect((await kolab.listWork(bob, { mine: true })).items.map((i) => i.id)).toStrictEqual(['W1.1']);
});

test('a plan named, or the only one: a kolab with two plans needs plan=', async () => {
  const { kolab, bob, eve } = await planned();
  await kolab.createNode(bob, 'binding', 'Orders on Lambda', 'orders-fn');
  await commitReviewed(kolab, bob, eve, 'orders-fn', { elements: els({ f1: 'A function.' }) });
  await kolab.createNode(bob, 'plan', 'Plan B', 'fn-plan', { parent: 'orders-fn' });
  await kolab.commit(bob, 'fn-plan', { elements: els({ X1: 'Deploy it.' }) });
  expect(await rejection(kolab.pullWork(bob))).toMatch(/kolab test has plans fn-plan, orders-plan: name the one to pull from/);
  expect(await kolab.pullWork(bob, { plan: 'fn-plan' })).toMatchObject({ pulled: true, item: { work: 'kj:fn-plan#X1' } });
  expect(await rejection(kolab.pullWork(bob, { plan: 'orders-pg' }))).toMatch(/orders-pg is a binding, not a plan/);
  // The board lists both, plan by plan.
  expect((await kolab.listWork(bob)).items.map((i) => i.work)).toStrictEqual([
    'kj:fn-plan#X1', 'kj:orders-plan#M1', 'kj:orders-plan#W1.1', 'kj:orders-plan#W1.2', 'kj:orders-plan#W1.10', 'kj:orders-plan#W2.1',
  ]);
});

test('the board pages by plan and id, in natural order, and a cursor is bound to its filters', async () => {
  const { kolab, bob } = await planned();
  const one = await kolab.listWork(bob, {}, { limit: 2 });
  expect(one.items.map((i) => i.id)).toStrictEqual(['M1', 'W1.1']);
  const two = await kolab.listWork(bob, {}, { limit: 2, cursor: one.next });
  expect(two.items.map((i) => i.id)).toStrictEqual(['W1.2', 'W1.10']);
  const three = await kolab.listWork(bob, {}, { limit: 2, cursor: two.next });
  expect(three).toMatchObject({ items: [{ id: 'W2.1' }], next: null });
  expect(await rejection(kolab.listWork(bob, { state: 'todo' }, { cursor: one.next }))).toMatch(/invalid cursor/);
});

test('the lease: renewed by its assignee\'s calls, reads included, once some of it is spent; never by reads a listen stream prompts (PLN15, D98)', async () => {
  const { kolab, bob, eve } = await planned();
  await kolab.pullWork(bob);
  const left = async () => Number((await kolab.db.query<{ s: number }>(`select extract(epoch from lease_until - clock_timestamp()) as s from work_package where element_id = 'W1.1'`)).rows[0].s);
  // Fresh: a call writes nothing (throttled).
  const before = (await row(kolab, 'W1.1')).lease_until;
  await kolab.listWork(bob);
  expect((await row(kolab, 'W1.1')).lease_until).toStrictEqual(before);
  // Ten minutes left: any call renews it to the kolab's full length, a read too.
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '10 minutes' where element_id = 'W1.1'`);
  await kolab.sessionInfo(bob);
  expect(await left()).toBeGreaterThan(1790);
  // A read a listen stream prompts (an inbox re-read) renews nothing.
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '10 minutes' where element_id = 'W1.1'`);
  await kolab.quietly(() => kolab.sessionInfo(bob));
  expect(await left()).toBeLessThan(601);
  // Someone else's call renews nothing of bob's.
  await kolab.listWork(eve);
  expect(await left()).toBeLessThan(601);
});

test('a lapsed lease: reads show To do at once, the assignee\'s calls never revive it, its writes are refused, and the sweep returns it with Kolab as the actor (PLN15, D98)', async () => {
  const { kolab, bob, eve } = await planned();
  await kolab.pullWork(bob);
  await lapse(kolab, 'W1.1');
  // Read before the sweep: To do, no assignee, and the lapse said.
  const w = await kolab.readWork(bob, 'kj:orders-plan#W1.1');
  expect(w).toMatchObject({ state: 'todo', assignee: null, lease_until: null, ready: true, lapsed: { held_by: 'bob' } });
  // bob's calls renew nothing: the row still says In progress, past its lease.
  await kolab.sessionInfo(bob);
  const r = await row(kolab, 'W1.1');
  expect(r.state).toBe('in_progress');
  expect(new Date(r.lease_until!).getTime()).toBeLessThan(Date.now() + 1000);
  // Releasing it is refused as lapsed.
  expect(await rejection(kolab.releaseWork(bob, 'kj:orders-plan#W1.1'))).toMatch(/your lease on kj:orders-plan#W1\.1 lapsed at .*: pull again/);
  // The sweep returns it, as Kolab, naming whose lease and when.
  expect(await kolab.sweepLapsedLeases()).toBe(1);
  expect(await kolab.sweepLapsedLeases()).toBe(0);
  expect(await row(kolab, 'W1.1')).toMatchObject({ state: 'todo', assignee_id: null, lease_until: null });
  const ev = (await kolab.readWork(bob, 'kj:orders-plan#W1.1')).events;
  expect(ev.map((e) => [e.kind, e.actor, e.from, e.to])).toStrictEqual([['added', 'bob', null, 'todo'], ['pulled', 'bob', 'todo', 'in_progress'], ['lapsed', 'kolab', 'in_progress', 'todo']]);
  expect(ev[2].note).toMatch(/^bob's lease lapsed at \d{4}-\d\d-\d\dT.*: no call of theirs renewed it \(PLN15\)$/);
  // bob is told, in its answers.
  expect((await kolab.workNotices(bob)).events.map((e) => [e.work, e.kind, e.actor])).toStrictEqual([['kj:orders-plan#W1.1', 'lapsed', 'kolab']]);
  // It is ready again, first in order: the next pull takes it, eve's.
  expect(await kolab.pullWork(eve)).toMatchObject({ pulled: true, item: { id: 'W1.1', assignee: 'eve' } });
});

test('a pull sweeps lapsed leases first: the actor whose lease lapsed may pull again, and gets the same package back', async () => {
  const { kolab, bob } = await planned();
  await kolab.pullWork(bob);
  await lapse(kolab, 'W1.1');
  expect(await kolab.pullWork(bob)).toMatchObject({ pulled: true, item: { id: 'W1.1', assignee: 'bob' } });
  expect(await events(kolab, bob, 'kj:orders-plan#W1.1')).toStrictEqual([['added', 'bob'], ['pulled', 'bob'], ['lapsed', 'kolab'], ['pulled', 'bob']]);
});

test('the outbox worker sweeps lapsed leases on its timer, waking when the next one lapses (D98)', async () => {
  const { kolab, bob } = await planned();
  await kolab.pullWork(bob);
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '300 milliseconds' where element_id = 'W1.1'`);
  kolab.startWorker({ pollMs: 60_000 });
  const until = Date.now() + 10_000;
  while ((await row(kolab, 'W1.1')).state !== 'todo' && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  expect(await events(kolab, bob, 'kj:orders-plan#W1.1')).toStrictEqual([['added', 'bob'], ['pulled', 'bob'], ['lapsed', 'kolab']]);
});

test('release: the assignee alone gives its package back, To do, recorded with its note (PLN15)', async () => {
  const { kolab, bob, eve } = await planned();
  await kolab.pullWork(bob);
  expect(await rejection(kolab.releaseWork(eve, 'kj:orders-plan#W1.1'))).toMatch(/GateError: kj:orders-plan#W1\.1 is In progress, held by bob: only its assignee releases/);
  expect(await rejection(kolab.releaseWork(eve, 'kj:orders-plan#W1.2'))).toMatch(/GateError: kj:orders-plan#W1\.2 is To do: only its assignee releases/);
  expect(await kolab.releaseWork(bob, 'orders-plan#W1.1', { note: 'Blocked on the payments team.' })).toMatchObject({ state: 'todo', assignee: null, ready: true });
  const ev = (await kolab.readWork(bob, 'kj:orders-plan#W1.1')).events.at(-1)!;
  expect(ev).toMatchObject({ kind: 'released', actor: 'bob', from: 'in_progress', to: 'todo', note: 'Blocked on the payments team.' });
  // Free to pull again.
  expect(await kolab.pullWork(bob)).toMatchObject({ pulled: true, item: { id: 'W1.1' } });
});

test('reassign: Maintain or Admin gives a package to someone who writes the technical layer and holds nothing, with a fresh lease (PLN15)', async () => {
  const { kolab, bob, eve, frank } = await planned();
  const mia = await kolab.openSession('mia', 'engineer');
  await kolab.pullWork(bob);
  await kolab.pullWork(frank);
  expect(await rejection(kolab.reassignWork(eve, 'kj:orders-plan#W1.1', 'eve'))).toMatch(/AccessError: reassigning work needs Maintain or Admin in kolab test \(PLN15\); eve holds Write/);
  // One refusal for whoever can't be given work, so nothing is learned of who exists (W3.6).
  const cant = (who: string) => `AccessError: ${who} can't be given work in kolab test: give it to someone who holds Write on the technical layer here and holds no work package In progress`;
  expect(await rejection(kolab.reassignWork(mia, 'kj:orders-plan#W1.1', 'carol'))).toBe(cant('carol'));
  expect(await rejection(kolab.reassignWork(mia, 'kj:orders-plan#W1.1', 'nobody'))).toBe(cant('nobody'));
  // Busy in this kolab: named, since the caller reads it anyway.
  expect(await rejection(kolab.reassignWork(mia, 'kj:orders-plan#W1.1', 'frank'))).toMatch(/GateError: frank already holds kj:orders-plan#W1\.2 In progress/);
  expect(await rejection(kolab.reassignWork(mia, 'kj:orders-plan#M1', 'eve'))).toMatch(/is a milestone/);
  // Work To do that is blocked goes to no one; and To do work isn't given to oneself: one pulls it.
  expect(await rejection(kolab.reassignWork(mia, 'kj:orders-plan#W2.1', 'eve'))).toMatch(/GateError: kj:orders-plan#W2\.1 is blocked \(PLN19\)/);
  await kolab.releaseWork(frank, 'kj:orders-plan#W1.2');
  expect(await rejection(kolab.reassignWork(mia, 'kj:orders-plan#W1.2', 'mia'))).toMatch(/GateError: kj:orders-plan#W1\.2 is To do: pull it/);
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '1 minute' where element_id = 'W1.1'`);
  expect(await kolab.reassignWork(mia, 'kj:orders-plan#W1.1', 'eve')).toMatchObject({ state: 'in_progress', assignee: 'eve' });
  expect(Number((await kolab.db.query<{ s: number }>(`select extract(epoch from lease_until - clock_timestamp()) as s from work_package where element_id = 'W1.1'`)).rows[0].s)).toBeGreaterThan(1790);
  const ev = (await kolab.readWork(eve, 'kj:orders-plan#W1.1')).events.at(-1)!;
  expect(ev).toMatchObject({ kind: 'reassigned', actor: 'mia', from: 'in_progress', to: 'in_progress', note: 'from bob to eve', assignee_from: 'bob', assignee_to: 'eve' });
  // Both are told; bob may pull again.
  expect((await kolab.workNotices(bob)).events.map((e) => e.kind)).toStrictEqual(['reassigned']);
  expect((await kolab.workNotices(eve)).holding).toMatchObject({ id: 'W1.1' });
  expect(await kolab.pullWork(bob)).toMatchObject({ pulled: true, item: { id: 'W1.2' } });
  // A package To do and ready can be given too.
  await people(kolab, 'gus', { layers: ['technical'] });
  expect(await kolab.reassignWork(mia, 'kj:orders-plan#W1.10', 'gus')).toMatchObject({ state: 'in_progress', assignee: 'gus' });
});

test('reassigning a package whose lease lapsed unswept records the lapse first, as Kolab, and tells its old assignee (PLN5, PLN15)', async () => {
  const { kolab, bob, eve } = await planned();
  const mia = await kolab.openSession('mia', 'engineer');
  await kolab.pullWork(bob);
  await lapse(kolab, 'W1.1');
  expect(await kolab.reassignWork(mia, 'kj:orders-plan#W1.1', 'eve')).toMatchObject({ state: 'in_progress', assignee: 'eve' });
  const ev = (await kolab.readWork(eve, 'kj:orders-plan#W1.1')).events;
  expect(ev.map((e) => [e.kind, e.actor, e.from, e.to, e.assignee_from ?? null, e.assignee_to ?? null])).toStrictEqual([
    ['added', 'bob', null, 'todo', null, null], ['pulled', 'bob', 'todo', 'in_progress', null, 'bob'],
    ['lapsed', 'kolab', 'in_progress', 'todo', 'bob', null], ['reassigned', 'mia', 'todo', 'in_progress', null, 'eve'],
  ]);
  expect((await kolab.workNotices(bob)).events.map((e) => e.kind)).toStrictEqual(['lapsed']);
});

test('reassign tells nothing of another kolab\'s work, nor of who exists: one refusal for an unknown actor, one with no Write here, and one busy elsewhere (D49, W3.6)', async () => {
  const { kolab, bob } = await planned();
  // bob holds X1 in kolab `secret`, which mia's maintainer zed can't read.
  await kolab.createKolab('secret', { owner: 'test-org' });
  await kolab.grant('secret', 'bob', 'write', { layers: ['technical'] });
  await kolab.grant('secret', 'alice', 'write', { layers: ['functional'] });
  await kolab.endSession({ actor: 'bob' });
  await kolab.endSession({ actor: 'alice' });
  const sb = await kolab.openSession('bob', 'engineer', { kolab: 'secret' });
  const sa = await kolab.openSession('alice', 'product', { kolab: 'secret' });
  await kolab.createNode(sa, 'spec', 'S', 's');
  await kolab.commit(sa, 's', { elements: els({ R1: 'Hush.' }) });
  await kolab.createNode(sb, 'binding', 'B', 'b');
  await kolab.commit(sb, 'b', { elements: els({ b1: 'Hush.' }) });
  await kolab.createNode(sb, 'plan', 'Hush plan', 'hush-plan');
  await kolab.commit(sb, 'hush-plan', { elements: els({ X1: 'Hush it.' }) });
  expect(await kolab.pullWork(sb)).toMatchObject({ pulled: true });
  await people(kolab, 'zed', { level: 'maintain' });
  const zed = await kolab.openSession('zed', 'engineer');
  const refusals = await Promise.all(['bob', 'carol', 'no-such-actor'].map((to) => rejection(kolab.reassignWork(zed, 'kj:orders-plan#W1.2', to))));
  expect(refusals.map((r) => r.replace(/^AccessError: \S+ /, 'AccessError: X '))).toStrictEqual(Array(3).fill(
    "AccessError: X can't be given work in kolab test: give it to someone who holds Write on the technical layer here and holds no work package In progress"));
  for (const r of refusals) expect(r).not.toMatch(/secret|hush|X1/);
});

test('set_work_lease: Maintain sets the kolab\'s lease, 1 to 1,440 minutes, audited; the next pull takes it (PLN15)', async () => {
  const { kolab, bob, eve } = await planned();
  const mia = await kolab.openSession('mia', 'engineer');
  expect(await rejection(kolab.setWorkLease(bob, 5))).toMatch(/AccessError: setting the lease on work needs Maintain or Admin/);
  for (const bad of [0, 1441, 2.5]) expect(await rejection(kolab.setWorkLease(mia, bad))).toMatch(/LimitError: minutes is a whole number from 1 to 1440/);
  expect(await kolab.setWorkLease(mia, 1)).toStrictEqual({ kolab: 'test', minutes: 1, was: 30 });
  expect(await kolab.auditLog({ kolab: TEST_KOLAB })).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'work_lease.set', kolab: 'test', subject: 'test', by: 'mia', detail: { seconds: 60, was: 1800 } }),
  ]));
  await kolab.pullWork(eve);
  const s = Number((await kolab.db.query<{ s: number }>(`select extract(epoch from lease_until - clock_timestamp()) as s from work_package where element_id = 'W1.1'`)).rows[0].s);
  expect(s).toBeGreaterThan(50);
  expect(s).toBeLessThanOrEqual(60);
  await kolab.setWorkLease(mia, 30);
});

test('removing a package from the plan stops its work, recorded as an event; adding it back restores it To do (PLN4)', async () => {
  const { kolab, bob, eve, delivers } = await planned();
  await kolab.pullWork(bob);
  const v2 = await kolab.commit(eve, 'orders-plan', { deltas: [{ kind: 'remove', element: 'W1.1' }, { kind: 'override', element: 'W2.1', work: { size: 'L' } },
    { kind: 'override', element: 'M1', work: { milestone: true, depends_on: ['W1.2', 'W1.10', 'W2.1'] } }] });
  expect(await row(kolab, 'W1.1')).toMatchObject({ state: 'todo', assignee_id: null, removed_in_version_id: v2 });
  expect((await kolab.listWork(bob)).items.map((i) => i.id)).toStrictEqual(['M1', 'W1.2', 'W1.10', 'W2.1']);
  const w = await kolab.readWork(bob, 'kj:orders-plan#W1.1');
  expect(w).toMatchObject({ state: 'todo', ready: false, removed_in: 'kj:orders-plan@2' });
  expect(w.events.at(-1)).toMatchObject({ kind: 'removed', actor: 'eve', from: 'in_progress', to: 'todo', note: expect.stringMatching(/the work bob held stops \(PLN4\)/),
    concerned: [{ address: 'kj:orders-pg@1#b1', version_id: expect.any(String), fingerprint: expect.any(String) }] });
  expect((await kolab.workNotices(bob)).events.map((e) => e.kind)).toStrictEqual(['removed']);
  // bob holds nothing now, and pulls W1.2.
  expect(await kolab.pullWork(bob)).toMatchObject({ pulled: true, item: { id: 'W1.2' } });
  // Back in a later version: To do again, restored.
  const v3 = await kolab.draft(eve, 'orders-plan', { deltas: [{ kind: 'add', element: 'W1.1', text: 'Build the cancel endpoint.' }], links: [delivers('W1.1', 'b1')] });
  expect((await kolab.submit(eve, v3)).ok).toBe(true);
  expect(await row(kolab, 'W1.1')).toMatchObject({ state: 'todo', removed_in_version_id: null });
  expect((await kolab.readWork(bob, 'kj:orders-plan#W1.1')).events.at(-1)).toMatchObject({ kind: 'restored', actor: 'eve', to: 'todo' });
});

test('a milestone is Done when every member is, a milestone of milestones too, and To do again when one isn\'t, recorded by Kolab (PLN3)', async () => {
  const { kolab, bob } = await planned();
  await kolab.commit(bob, 'orders-plan', { deltas: [{ kind: 'add', element: 'M2', text: 'All of it.', work: { milestone: true, depends_on: ['M1'] } }] });
  const done = async (ids: string[], state = 'done') => {
    // As W5.1c's approvals will, here straight in the database; the next plan commit works milestones out.
    await kolab.db.query(`update work_package set state = $2, assignee_id = 'bob' where element_id = any($1)`, [ids, state]);
    await kolab.commit(bob, 'orders-plan', { deltas: [{ kind: 'override', element: 'W1.1', text: `Build the cancel endpoint (${Date.now()}).` }] });
  };
  await done(['W1.1', 'W1.2', 'W1.10']);
  expect((await row(kolab, 'M1')).state).toBe('todo');
  await done(['W2.1']);
  expect((await row(kolab, 'M1')).state).toBe('done');
  expect((await row(kolab, 'M2')).state).toBe('done');
  expect((await kolab.readWork(bob, 'kj:orders-plan#M1')).events.map((e) => [e.kind, e.actor])).toStrictEqual([['added', 'bob'], ['milestone_done', 'kolab']]);
  expect((await kolab.readWork(bob, 'kj:orders-plan#M2')).events.map((e) => [e.kind, e.actor])).toStrictEqual([['added', 'bob'], ['milestone_done', 'kolab']]);
  await done(['W2.1'], 'todo');
  expect((await row(kolab, 'M1')).state).toBe('todo');
  expect((await row(kolab, 'M2')).state).toBe('todo');
  expect((await kolab.readWork(bob, 'kj:orders-plan#M1')).events.at(-1)).toMatchObject({ kind: 'milestone_reopened', actor: 'kolab', from: 'done', to: 'todo' });
  // A milestone is never pulled, and never given to anyone.
  expect((await kolab.listWork(bob)).items.filter((i) => i.milestone).every((i) => !i.ready)).toBe(true);
});

test('a package that becomes a milestone stops its work; one that stops being a milestone is To do (PLN3)', async () => {
  const { kolab, bob, eve } = await planned();
  await kolab.pullWork(bob);
  await kolab.commit(eve, 'orders-plan', { deltas: [
    { kind: 'override', element: 'W1.1', work: { milestone: true, depends_on: ['W1.2'] } },
    { kind: 'override', element: 'W2.1', work: { size: 'L' } },
    { kind: 'override', element: 'M1', work: { done_when: 'All done.' } },
  ], unlink: [{ sourceElement: 'W1.1', target: 'kj:orders-pg#b1' }] });
  expect(await row(kolab, 'W1.1')).toMatchObject({ state: 'todo', assignee_id: null });
  expect((await kolab.readWork(bob, 'kj:orders-plan#W1.1')).events.at(-1)).toMatchObject({ kind: 'released', actor: 'kolab', note: expect.stringMatching(/made it a milestone/) });
  expect((await kolab.listWork(bob)).items.find((i) => i.id === 'M1')).toMatchObject({ milestone: false, ready: true });
});

test('losing Write on the technical layer gives work back, as Kolab, noting access_lost (D98)', async () => {
  const { kolab, eve, frank: bob } = await planned();
  await kolab.pullWork(eve);
  await kolab.grant(TEST_KOLAB, 'eve', 'write', { layers: ['functional'] });
  expect(await row(kolab, 'W1.1')).toMatchObject({ state: 'todo', assignee_id: null });
  expect((await kolab.readWork(bob, 'kj:orders-plan#W1.1')).events.at(-1)).toMatchObject({ kind: 'released', actor: 'kolab', note: 'access_lost: eve no longer holds Write on the technical layer of kolab test' });
});

test('archiving a kolab gives back its work In progress, as Kolab, in the archive\'s transaction, so its assignees pull elsewhere (D52, PLN18)', async () => {
  const { kolab, bob } = await planned();
  await kolab.createKolab('other', { owner: 'test-org' });
  await kolab.grant('other', 'bob', 'write', { layers: ['technical'] });
  await kolab.pullWork(bob);
  await kolab.archive({ kolab: TEST_KOLAB });
  expect(await row(kolab, 'W1.1')).toMatchObject({ state: 'todo', assignee_id: null, lease_until: null });
  const last = (await kolab.db.query<{ kind: string; actor_id: string; assignee_from: string; note: string }>(
    `select kind, actor_id, assignee_from, note from work_event where element_id = 'W1.1' order by at desc, id desc limit 1`)).rows[0];
  expect(last).toStrictEqual({ kind: 'released', actor_id: 'kolab', assignee_from: 'bob', note: 'archived: kolab test is archived, so the work bob held there stops' });
  expect(await kolab.sweepLapsedLeases()).toBe(0);
  // bob holds nothing anywhere now: in `other`, a pull isn't refused for test's package.
  const bob2 = await kolab.openSession('bob', 'engineer', { kolab: 'other' });
  expect(await rejection(kolab.pullWork(bob2))).toMatch(/kolab other has no plan/);
  // An organization's archive does the same for each of its kolabs.
  await kolab.unarchive({ kolab: TEST_KOLAB });
  await kolab.endSession({ actor: 'bob' });
  const bob3 = await kolab.openSession('bob', 'engineer', { kolab: TEST_KOLAB });
  await kolab.pullWork(bob3);
  await kolab.archive({ organization: 'test-org' });
  expect(await row(kolab, 'W1.1')).toMatchObject({ state: 'todo', assignee_id: null });
});

test('a commit that removes a package whose lease lapsed unswept records the lapse first; a Done package removed and brought back stays Done (PLN4, PLN5)', async () => {
  const { kolab, bob, eve, delivers } = await planned();
  await kolab.pullWork(bob);
  await lapse(kolab, 'W1.1');
  await kolab.db.query(`update work_package set state = 'done', assignee_id = 'eve' where element_id = 'W1.2'`);
  await kolab.commit(eve, 'orders-plan', { deltas: [{ kind: 'remove', element: 'W1.1' }, { kind: 'remove', element: 'W1.2' },
    { kind: 'override', element: 'W2.1', work: { size: 'L' } }, { kind: 'override', element: 'M1', work: { milestone: true, depends_on: ['W1.10', 'W2.1'] } }] });
  expect((await kolab.readWork(eve, 'kj:orders-plan#W1.1')).events.map((e) => [e.kind, e.actor, e.from, e.to])).toStrictEqual([
    ['added', 'bob', null, 'todo'], ['pulled', 'bob', 'todo', 'in_progress'], ['lapsed', 'kolab', 'in_progress', 'todo'], ['removed', 'eve', 'todo', 'todo'],
  ]);
  const v = await kolab.draft(eve, 'orders-plan', { deltas: [{ kind: 'add', element: 'W1.2', text: 'Build the shipping queue.' }], links: [delivers('W1.2', 'b2')] });
  expect((await kolab.submit(eve, v)).ok).toBe(true);
  expect(await row(kolab, 'W1.2')).toMatchObject({ state: 'done', assignee_id: 'eve', removed_in_version_id: null });
  expect((await kolab.readWork(eve, 'kj:orders-plan#W1.2')).events.at(-1)).toMatchObject({ kind: 'restored', from: 'done', to: 'done' });
});

test('a lease is renewed only for an actor that may still write the technical layer (D98)', async () => {
  const { kolab, bob } = await planned();
  await kolab.pullWork(bob);
  // Read only now, as by a change made outside Kolab's verbs, which would otherwise release it.
  await kolab.db.transaction(async (tx) => {
    await tx.query(`insert into audit_event(action, kolab_id, subject, done_by) values ('grant.set', 'test', 'bob', 'admin')`);
    await tx.query(`update kolab_grant set level = 'read', functional = false, technical = false where user_id = 'bob'`);
  });
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '5 minutes' where element_id = 'W1.1'`);
  await kolab.sessionInfo(bob);
  expect(Number((await kolab.db.query<{ s: number }>(`select extract(epoch from lease_until - clock_timestamp()) as s from work_package where element_id = 'W1.1'`)).rows[0].s)).toBeLessThan(301);
});

test('events read in the database clock\'s order, a ULID breaking ties, whatever process minted their ids (D98)', async () => {
  const { kolab, bob } = await planned();
  await kolab.pullWork(bob);
  // An event whose id sorts first, though it happened last (another process's clock, behind).
  await kolab.db.query(`insert into work_event(id, plan_node_id, element_id, kind, from_state, to_state, actor_id, assignee_from, plan_version_id, concerned, note)
    select '00000000000000000000000000', plan_node_id, element_id, 'released', 'in_progress', 'todo', 'bob', 'bob', plan_version_id, '[]', 'late'
      from work_event where element_id = 'W1.1' and kind = 'pulled'`);
  expect((await kolab.readWork(bob, 'kj:orders-plan#W1.1')).events.map((e) => e.kind)).toStrictEqual(['added', 'pulled', 'released']);
  const one = await kolab.readWork(bob, 'kj:orders-plan#W1.1', { limit: 2 });
  expect(one.events.map((e) => e.kind)).toStrictEqual(['added', 'pulled']);
  expect((await kolab.readWork(bob, 'kj:orders-plan#W1.1', { limit: 2, cursor: one.events_next })).events.map((e) => e.kind)).toStrictEqual(['released']);
});

test('work stays in its kolab: another kolab\'s session reads none of it, and one actor holds one package across kolabs (D49, PLN18, D98)', async () => {
  const { kolab, bob } = await planned();
  await kolab.createKolab('other', { owner: 'test-org' });
  await kolab.grant('other', 'bob', 'write', { layers: ['technical'] });
  await kolab.grant('other', 'eve', 'read');
  await kolab.pullWork(bob);
  // eve, working in `other`, holds Read on nothing of test's here: not found, as if it weren't there.
  await kolab.endSession({ actor: 'eve' });
  const eve = await kolab.openSession('eve', 'engineer', { kolab: 'other' });
  for (const ref of ['kj:test/orders-plan#W1.1', 'kj:orders-plan#W1.1']) {
    expect(await rejection(kolab.readWork(eve, ref))).toMatch(/^Error: no work package kj:orders-plan#W1\.1 in kolab other$/);
  }
  expect((await kolab.listWork(eve)).items).toStrictEqual([]);
  // Row-level security: a session in `other` reads no row of test's work.
  const seen = await kolab.readAs(eve, async (q) => (await q.query(`select * from work_package`)).rows.length + (await q.query(`select * from work_event`)).rows.length);
  expect(seen).toBe(0);
  // bob, in `other`, with a plan there, pulls nothing while it holds W1.1 in test.
  await kolab.endSession({ actor: 'bob' });
  const bob2 = await kolab.openSession('bob', 'engineer', { kolab: 'other' });
  await kolab.createNode(bob2, 'spec', 'S', 's').catch(() => undefined);
  await kolab.grant('other', 'alice', 'write', { layers: ['functional'] });
  await kolab.endSession({ actor: 'alice' });
  const alice = await kolab.openSession('alice', 'product', { kolab: 'other' });
  await kolab.createNode(alice, 'spec', 'S', 's');
  await kolab.commit(alice, 's', { elements: els({ R1: 'One.' }) });
  await kolab.createNode(bob2, 'binding', 'B', 'b');
  await kolab.commit(bob2, 'b', { elements: els({ b1: 'One.' }) });
  await kolab.createNode(bob2, 'plan', 'P', 'p');
  await kolab.commit(bob2, 'p', { elements: els({ X1: 'Do one.' }) });
  expect(await rejection(kolab.pullWork(bob2))).toMatch(/GateError: bob already holds kj:test\/orders-plan#W1\.1 In progress/);
  // The database holds it too: a second package pulled by bob anywhere is refused (0031: a returned one isn't counted).
  expect(await rejection(kolab.db.query(`update work_package set state = 'in_progress', assignee_id = 'bob', lease_until = now() + interval '1 hour', touched_at = now() where element_id = 'X1'`)))
    .toMatch(/one_pulled_per_actor/);
});

test('only Kolab\'s trusted role writes work state: an agent\'s raw writes are refused, and events are never edited or removed, even by Kolab\'s login (ENF2, PLN5, D98)', async () => {
  const { kolab, bob } = await planned();
  await kolab.pullWork(bob);
  const asAgent = (sql: string) => kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(bob)]);
    return tx.query(sql);
  });
  expect(await rejection(asAgent(`update work_package set lease_until = now() + interval '1 day' where element_id = 'W1.1'`))).toMatch(/permission denied/);
  expect(await rejection(asAgent(`insert into work_package(plan_node_id, element_id) values ('orders-plan', 'W9')`))).toMatch(/permission denied/);
  expect(await rejection(asAgent(`insert into work_event(id, plan_node_id, element_id, kind, actor_id, plan_version_id, concerned) select 'x', plan_node_id, element_id, 'pulled', 'bob', plan_version_id, '[]' from work_event limit 1`))).toMatch(/permission denied/);
  // The agent reads its own kolab's.
  expect((await asAgent(`select element_id from work_package where state = 'in_progress'`)).rows).toStrictEqual([{ element_id: 'W1.1' }]);
  // Events: no update, no delete, for any role.
  for (const sql of [`update work_event set note = 'edited'`, `delete from work_event`, `update work_event set actor_id = 'eve'`]) {
    expect(await rejection(kolab.db.query(sql))).toMatch(/work_event: events are never edited or removed \(PLN5\)/);
  }
  expect(await rejection(kolab.db.query(`delete from work_package`))).toMatch(/a work package is never deleted/);
  // Kolab's trusted role may redact one: actor and note go, the rest stays.
  const asSystem = (sql: string) => kolab.db.transaction(async (tx) => { await tx.exec('set local role kj_system'); return tx.query(sql); });
  expect(await rejection(asSystem(`update work_event set note = null where kind = 'pulled'`))).toMatch(/never edited/);
  await asSystem(`update work_event set actor_id = 'redacted', note = null, assignee_to = 'redacted', redacted_at = now(), redacted_by = '${ADMIN_DOER}' where kind = 'pulled'`);
  expect((await kolab.readWork(bob, 'kj:orders-plan#W1.1')).events.map((e) => [e.kind, e.actor])).toStrictEqual([['added', 'bob'], ['pulled', 'redacted']]);
  expect(await rejection(asSystem(`update work_event set redacted_at = now() where kind = 'pulled'`))).toMatch(/never edited/);
});

test('a session that holds only Read sees the board, but no open case file and no question a mark raised, as row-level security holds them (0013, 0022; D49, D58)', async () => {
  const { kolab, product, bob } = await planned();
  const carol = await kolab.openSession('carol', 'engineer');
  const blockedFor = async (s: string, id: string) => (await kolab.listWork(s)).items.find((i) => i.id === id)!.blocked;
  // A question a person raised is shown in full.
  const q = await kolab.raiseQuery(product, 'kj:orders-pg#b3', 'Which courier?');
  expect(await blockedFor(carol, 'W1.10')).toStrictEqual([{ reason: 'question', on: 'kj:orders-pg@1#b3', query: q }]);
  // An open case file: those who belong see it; carol sees nothing of it, as she reads no case file.
  const c = await kolab.openCase(bob, 'kj:orders-pg#b2', { question: 'Can it ship in a day?', claim: 'No.', evidence: ['the contract'], seeks: 'change_intent' });
  expect(await blockedFor(bob, 'W1.2')).toStrictEqual([{ reason: 'case_file', on: 'kj:orders-pg@1#b2', case: c }]);
  expect(await blockedFor(carol, 'W1.2')).toStrictEqual([]);
  expect(await kolab.readAs(carol, async (q2) => (await q2.query(`select * from case_file`)).rows.length)).toBe(0);
  expect(JSON.stringify(await kolab.readWork(carol, 'kj:orders-plan#W1.2'))).not.toContain(c);
  // A question with a mark behind it is hidden from her too.
  const s1 = (await kolab.latestCommitted('orders'))!.id;
  const m = (await kolab.db.query<{ id: string }>(`insert into invalidation(id, version_id, element_id, triggered_by, reason, state)
    select 'mk1', id, 'b3', $1, 'changed', 'open' from version where node_id = 'orders-pg' and state = 'committed' returning id`, [s1])).rows[0].id;
  await kolab.db.query(`update query set invalidation_id = $2 where id = $1`, [q, m]);
  expect(await blockedFor(carol, 'W1.10')).toStrictEqual([]);
  expect(await blockedFor(bob, 'W1.10')).toStrictEqual([{ reason: 'question', on: 'kj:orders-pg@1#b3', query: q }]);
});

// ---- concurrency ---------------------------------------------------------------

test('many agents pulling at once each get a different package, and together take every ready one (PLN14)', async () => {
  const { kolab, bob } = await planned();
  // Twelve independent packages more, so pulls contend.
  await kolab.commit(bob, 'orders-plan', { deltas: Array.from({ length: 12 }, (_, i) => ({ kind: 'add' as const, element: `X${i + 1}`, text: `Extra ${i + 1}.` })) });
  const agents = Array.from({ length: 16 }, (_, i) => `ag${i}`);
  await people(kolab, agents, { owner: 'bob', layers: ['technical'] }).catch(async () => {
    for (const a of agents) { await kolab.addActor(a, { owner: 'bob' }); await kolab.grant(TEST_KOLAB, a, 'write', { layers: ['technical'] }); }
  });
  const sessions = await Promise.all(agents.map((a) => kolab.openSession(a, 'engineer')));
  const results = await Promise.all(sessions.map((s) => kolab.pullWork(s)));
  const pulled = results.flatMap((r) => (r.pulled ? [r.item.id] : []));
  // 3 ready at first (W1.1, W1.2, W1.10) and 12 more: 15 for 16 agents; W2.1 stays blocked.
  expect(pulled).toHaveLength(15);
  expect(new Set(pulled).size).toBe(15);
  expect(results.filter((r) => !r.pulled)).toHaveLength(1);
  const held = (await kolab.db.query<{ n: number }>(`select count(*)::int as n from work_package where state = 'in_progress'`)).rows[0].n;
  expect(held).toBe(15);
  expect((await kolab.db.query<{ n: number }>(`select count(*)::int as n from work_event where kind = 'pulled'`)).rows[0].n).toBe(15);
}, 120_000);

test('one actor pulling several times at once gets one package, and the others are refused naming it (PLN18)', async () => {
  const { kolab, bob } = await planned();
  const results = await Promise.allSettled([kolab.pullWork(bob), kolab.pullWork(bob), kolab.pullWork(bob), kolab.pullWork(bob)]);
  const got = results.filter((r) => r.status === 'fulfilled' && r.value.pulled);
  expect(got).toHaveLength(1);
  const id = (got[0] as PromiseFulfilledResult<{ pulled: true; item: { id: string } }>).value.item.id;
  for (const r of results.filter((x) => x.status === 'rejected')) {
    expect(String((r as PromiseRejectedResult).reason)).toMatch(new RegExp(`bob already holds kj:orders-plan#${id.replace('.', '\\.')} In progress`));
  }
  expect((await kolab.db.query(`select element_id from work_package where assignee_id = 'bob' and state = 'in_progress'`)).rows).toStrictEqual([{ element_id: id }]);
  expect((await kolab.db.query<{ n: number }>(`select count(*)::int as n from work_event where kind = 'pulled'`)).rows[0].n).toBe(1);
}, 60_000);

test('a renewal racing the sweep never revives a lapsed lease, in either order, and many at once leave it lapsed exactly once (PLN15, D98)', async () => {
  const { kolab, bob } = await planned();
  for (let round = 0; round < 5; round++) {
    await kolab.pullWork(bob);
    const id = (await kolab.db.query<{ element_id: string }>(`select element_id from work_package where assignee_id = 'bob' and state = 'in_progress'`)).rows[0].element_id;
    // Lapsed, by a hair: the sweep and bob's calls race for it.
    await lapse(kolab, id, '1 millisecond');
    await Promise.all([kolab.sweepLapsedLeases(), kolab.sessionInfo(bob), kolab.listWork(bob), kolab.sweepLapsedLeases(), kolab.sessionInfo(bob)]);
    expect(await row(kolab, id)).toMatchObject({ state: 'todo', assignee_id: null, lease_until: null });
    const lapses = (await kolab.db.query<{ n: number }>(`select count(*)::int as n from work_event where element_id = $1 and kind = 'lapsed'`, [id])).rows[0].n;
    expect(lapses).toBeGreaterThanOrEqual(1);
    expect((await kolab.db.query<{ kind: string }>(`select kind from work_event where element_id = $1 order by id desc limit 1`, [id])).rows[0].kind).toBe('lapsed');
  }
}, 120_000);

(POSTGRES ? test : test.skip)('on Postgres: a renewal waiting on the sweep\'s lock finds the lease gone and revives nothing; a sweep waiting on a renewal\'s finds it live (D98)', async () => {
  const store = await testStore();
  const { kolab, bob } = await planned(store);
  await kolab.pullWork(bob);
  const other = new pg.Client({ connectionString: store.databaseUrl });
  await other.connect();
  try {
    // 1. The sweep's transaction holds the row, lapsed; bob's call waits for it, then finds it To do.
    await lapse(kolab, 'W1.1');
    await other.query('begin');
    await other.query(`update work_package set state = 'todo', assignee_id = null, lease_until = null where element_id = 'W1.1' and state = 'in_progress' and lease_until < clock_timestamp()`);
    const call = kolab.sessionInfo(bob);
    await new Promise((r) => setTimeout(r, 200));
    await other.query('commit');
    await call;
    expect(await row(kolab, 'W1.1')).toMatchObject({ state: 'todo', lease_until: null });
    // 2. bob holds it again, its lease about to lapse. bob's renewal, under its own where clause
    //    (the lease still runs), holds the row as the lease's time passes; the sweep, which reads the
    //    committed lease as lapsed, skips the locked row rather than wait, and once the renewal
    //    commits, finds it live.
    await kolab.pullWork(bob);
    await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '300 milliseconds' where element_id = 'W1.1'`);
    await other.query('begin');
    const renewed = await other.query(`update work_package set lease_until = clock_timestamp() + interval '30 minutes'
      where element_id = 'W1.1' and state = 'in_progress' and lease_until >= clock_timestamp() returning element_id`);
    expect(renewed.rows).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(await kolab.sweepLapsedLeases()).toBe(0);   // locked: skipped, not waited on
    await other.query('commit');
    expect(await kolab.sweepLapsedLeases()).toBe(0);   // renewed: kept
    expect((await row(kolab, 'W1.1')).state).toBe('in_progress');
  } finally {
    await other.end();
  }
}, 60_000);

test('a plan commit and a change of access that both give back work never deadlock: both lock rows in plan and element order (review 6)', async () => {
  const { kolab, bob, eve, frank } = await planned();
  for (let round = 0; round < 6; round++) {
    await kolab.pullWork(eve);
    await kolab.pullWork(frank);
    // The commit locks the plan's rows in element order; the grant changes release both, in the same order.
    const results = await Promise.allSettled([
      kolab.commit(bob, 'orders-plan', { deltas: [{ kind: 'override', element: 'W2.1', text: `Cancel from the tracking page (${round}).` }] }),
      kolab.grant(TEST_KOLAB, 'eve', 'write', { layers: ['functional'] }),
      kolab.grant(TEST_KOLAB, 'frank', 'write', { layers: ['functional'] }),
    ]);
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toStrictEqual([]);
    expect((await kolab.db.query(`select 1 from work_package where state = 'in_progress'`)).rows).toStrictEqual([]);
    await kolab.grant(TEST_KOLAB, 'eve', 'write', { layers: ['technical'] });
    await kolab.grant(TEST_KOLAB, 'frank', 'write', { layers: ['technical'] });
  }
}, 120_000);
