// An open case file freezes nothing downstream (WRK7, CASE7): opening one writes only the case file
// and its position. Work under way goes on, versions that link its element commit, and the cascade
// runs; only giving out To do work that serves or relies on it waits for its ruling (WRK3, PLN19).
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { commitReviewed, els, marksOn, openKolab, people, registeredRepository, rejection, TEST_KOLAB } from '@konjir/engine/testing';
import type { ElementInput } from '@konjir/types';

const DECISIONS = els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.' });
const PLAN: ElementInput[] = [
  { id: 'W1.1', text: 'Build the cancel endpoint.', work: { size: 'M' } },
  { id: 'W1.2', text: 'Build the shipping queue.', work: { size: 'S' } },
  { id: 'W3.1', text: 'Cancel in bulk.', work: { size: 'S' } },
];
const COMMIT = { kind: 'commit' as const, sha: 'a'.repeat(40), title: 'Build it' };
const W = (id: string) => `kj:orders-pg#${id}`;

const row = async (kolab: Kolab, element: string) =>
  (await kolab.db.query<{ state: string; assignee_id: string | null; lease_until: Date | null }>(
    `select state, assignee_id, lease_until from work_package where element_id = $1`, [element])).rows[0];

/** Seconds left on a package's lease, by the database's clock. */
const left = async (kolab: Kolab, element: string) =>
  Number((await kolab.db.query<{ s: number }>(`select extract(epoch from lease_until - clock_timestamp()) as s from work_package where element_id = $1`, [element])).rows[0].s);

/**
 * A spec of two requirements, and a binding whose b1 serves R1 and b2 R2; W1.1 and W3.1 serve R1
 * and rely on b1, and W1.2 relies on b2. Alice and dana write the functional layer; bob, eve,
 * frank and gus are engineers; mia maintains.
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
  const bv = await kolab.draft(bob, 'orders-pg', {
    elements: DECISIONS,
    links: ['b1', 'b2'].map((b, i) => ({ kind: 'dependency' as const, sourceElement: b, target: spec, targetElement: `R${i + 1}` })),
  });
  expect((await kolab.submit(bob, bv)).ok).toBe(true);
  const delivers = (from: string, to: string) => ({ kind: 'dependency' as const, sourceElement: from, target: bv, targetElement: to });
  const serves = (from: string) => ({ kind: 'dependency' as const, sourceElement: from, target: spec, targetElement: 'R1' });
  const pv = await kolab.draft(bob, 'orders-pg', { elements: [...DECISIONS, ...PLAN], links: [delivers('W1.1', 'b1'), serves('W1.1'), delivers('W1.2', 'b2'), delivers('W3.1', 'b1'), serves('W3.1')] });
  expect((await kolab.submit(bob, pv)).ok).toBe(true);
  await registeredRepository(kolab, { binding: 'orders-pg' });
  await people(kolab, ['eve', 'frank', 'gus'], { layers: ['technical'] });
  await people(kolab, 'dana', { layers: ['functional'] });
  await people(kolab, 'mia', { level: 'maintain' });
  const [eve, frank, gus, mia, dana] = await Promise.all([
    kolab.openSession('eve', 'engineer'), kolab.openSession('frank', 'engineer'), kolab.openSession('gus', 'engineer'),
    kolab.openSession('mia', 'engineer'), kolab.openSession('dana', 'product'),
  ]);
  return { kolab, spec, product, bob, eve, frank, gus, mia, dana };
}

test('an open case file on a spec element freezes nothing downstream: In progress work renews, is submitted and approved; a binding version linking it commits with no mark; To do work waits at pull and reassignment, naming it, until it is ruled (WRK7, CASE7)', async () => {
  const { kolab, spec, product, bob, eve, frank, gus, mia, dana } = await planned();
  const pulled = await kolab.pullWork(bob);
  expect(pulled).toMatchObject({ pulled: true, item: { id: 'W1.1' } });
  expect(await kolab.pullWork(eve)).toMatchObject({ pulled: true, item: { id: 'W1.2' } });

  // Bob finds R1 can't be met as written, and opens a case file on it, with his evidence.
  const marks = (await kolab.openMarks()).length;
  const before = await row(kolab, 'W1.1');
  const c = await kolab.openCase(bob, 'kj:orders#R1', {
    question: 'Can an order be cancelled once it ships?', claim: 'Not once the courier has it.', seeks: 'change_intent',
    evidence: ['src/orders.ts:40', 'npm test: 1 failed'],
  });
  // It changes no work package, and raises no mark.
  expect(await row(kolab, 'W1.1')).toStrictEqual(before);
  expect(await row(kolab, 'W3.1')).toMatchObject({ state: 'todo', assignee_id: null });
  expect((await kolab.openMarks()).length).toBe(marks);
  const w31 = (await kolab.listWork(gus)).items.find((i) => i.id === 'W3.1')!;
  expect(w31).toMatchObject({ ready: false, blocked: [{ reason: 'case_file', on: 'kj:orders@1#R1', case: c }] });

  // 1. W1.1, In progress, serves R1 and carries on: its lease renews, it is submitted and approved.
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '10 minutes' where element_id = 'W1.1'`);
  await kolab.readWork(bob, W('W1.1'));
  expect(await left(kolab, 'W1.1')).toBeGreaterThan(1790);
  expect(await kolab.submitWork(bob, W('W1.1'), { evidence: [COMMIT] })).toMatchObject({ state: 'in_review' });
  expect(await kolab.reviewWork(frank, W('W1.1'), { verdict: 'approve', note: 'Checked it.' })).toMatchObject({ state: 'done' });

  // 2. A binding version that links R1 commits, and marks nothing.
  const committed = await commitReviewed(kolab, eve, frank, 'orders-pg', {
    elements: [...DECISIONS, { id: 'b3', text: 'Cancelling writes an audit row.' }, ...PLAN],
    links: [{ kind: 'dependency', sourceElement: 'b3', target: spec, targetElement: 'R1' }],
  });
  expect((await kolab.latestCommitted('orders-pg'))!.id).toBe(committed);
  expect((await marksOn(kolab, 'orders-pg'))).toStrictEqual([]);
  expect((await kolab.openMarks()).length).toBe(marks);

  // 3. W3.1, To do, serves R1 and waits: refused at pull and at reassignment, each naming the case file.
  const named = `case file ${c} on kj:orders@1#R1, until ruled`;
  const none = await kolab.pullWork(gus);
  expect(none).toMatchObject({ pulled: false, counts: { todo: 1, blocked_by_case_files: 1 } });
  if (!none.pulled) expect(none.why).toContain(named);
  const refused = await rejection(kolab.reassignWork(mia, W('W3.1'), 'gus'));
  expect(refused).toMatch(/^GateError: kj:orders-pg#W3\.1 is blocked \(PLN19\)/);
  expect(refused).toContain(named);
  expect(await row(kolab, 'W3.1')).toMatchObject({ state: 'todo', assignee_id: null });

  // 4. Ruled keep_intent, it marks nothing, and W3.1 can be pulled.
  await kolab.addPosition(product, c, { claim: 'R1 stands: a shipped order is cancelled by recalling it.', evidence: ['kj:orders#R1'] });
  const [open] = await kolab.listCases({ kolab: TEST_KOLAB, id: c });
  const verdicts = Object.fromEntries(open.positions.map((p) => [p.position, p.actor === 'bob' ? 'overruled' as const : 'sustained' as const]));
  await kolab.rule(dana, { case: c, text: 'R1 stands.', verdicts });
  expect((await kolab.listCases({ kolab: TEST_KOLAB, id: c }))[0]).toMatchObject({ state: 'ruled' });
  expect((await kolab.openMarks()).length).toBe(marks);
  expect(await kolab.pullWork(gus)).toMatchObject({ pulled: true, item: { id: 'W3.1', assignee: 'gus' } });
});
