// Acceptance checks (W8.4; REV9, VER15; migration 0048): a test run's evidence lists the acceptance
// checks it ran, each a committed spec element by its address, passed or failed; an address that
// doesn't resolve refuses the call and records nothing; a failed check is an acceptance_failed
// finding on the package's review request, in each verdict's result, and on its record for good,
// whatever the verdict. On PGlite, and on Postgres with KONJIR_TEST_POSTGRES=1.
import { expect, test } from '@jest/globals';
import { type Kolab } from '@konjir/engine';
import { els, openKolab, people, registeredRepository, rejection, TEST_KOLAB } from '@konjir/engine/testing';
import { ADMIN_DOER } from '@konjir/types';

const sha = (c: string) => c.repeat(40);
const COMMIT = (c = 'a') => ({ kind: 'commit' as const, sha: sha(c), title: `Build it (${c})` });
const W = (id: string) => `kj:orders-pg#${id}`;
const R = (id: string) => `kj:${TEST_KOLAB}/orders#${id}`;

/**
 * A spec of two requirements, a binding of two decisions serving them, and two work packages relying
 * on them; alice writes the functional layer, bob and eve are engineers.
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
    elements: decisions,
    links: [{ kind: 'dependency' as const, sourceElement: 'b1', target: spec, targetElement: 'R1' }, { kind: 'dependency' as const, sourceElement: 'b2', target: spec, targetElement: 'R2' }],
  });
  expect((await kolab.submit(bob, bv)).ok).toBe(true);
  const pv = await kolab.draft(bob, 'orders-pg', {
    elements: [...decisions,
      { id: 'W1', text: 'Build the cancel endpoint.', work: { done_when: 'An order cancels.', size: 'M' } },
      { id: 'W2', text: 'Build the shipping queue.', work: { size: 'S' } }],
    links: [{ kind: 'dependency' as const, sourceElement: 'W1', target: bv, targetElement: 'b1' }, { kind: 'dependency' as const, sourceElement: 'W2', target: bv, targetElement: 'b2' }],
  });
  expect((await kolab.submit(bob, pv)).ok).toBe(true);
  await registeredRepository(kolab, { binding: 'orders-pg' });
  await people(kolab, 'eve', { layers: ['technical'] });
  const eve = await kolab.openSession('eve', 'engineer');
  return { kolab, product, bob, eve };
}

async function pull(kolab: Kolab, session: string): Promise<string> {
  const r = await kolab.pullWork(session);
  if (!r.pulled) throw new Error(r.why);
  return r.item.id;
}

const RUN = (checks: { address: string; result: string }[], title = 'npm test: 120 passed') => ({ kind: 'test_run' as const, title, checks });

test('REV9: a failed check recorded on a package is on its review request, in the approval\'s result, and still on its record after approval', async () => {
  const { kolab, bob, eve } = await planned();
  const id = await pull(kolab, bob);
  // Short and full addresses alike, each kept by its full address and the version it resolved to.
  const added = await kolab.addEvidence(bob, W(id), [RUN([{ address: 'kj:orders#R1', result: 'passed' }, { address: R('R2'), result: 'failed' }])]);
  expect(added).toMatchObject({ recorded: 1, findings: [{ kind: 'acceptance_failed', element: R('R2'), version: 1, recorded_by: 'bob' }] });
  const sub = await kolab.submitWork(bob, W(id), { evidence: [COMMIT()] });
  expect(sub).toMatchObject({ state: 'in_review', findings: [{ kind: 'acceptance_failed', element: R('R2') }] });
  // The reviewer sees it with the request.
  const [req] = await kolab.reviewRequests({ kolab: TEST_KOLAB, reviewer: 'eve' });
  expect(req.findings).toMatchObject([{ kind: 'acceptance_failed', element: R('R2'), recorded_by: 'bob' }]);
  expect(req.next).toMatch(/^Its evidence records a failed acceptance check \(kj:test\/orders#R2\): each is a finding, acceptance_failed, that stays on its record whatever your verdict \(REV9\)/);
  // An approval isn't refused because of it, and its result carries it.
  const verdict = await kolab.reviewWork(eve, W(id), { verdict: 'approve' });
  expect(verdict).toMatchObject({ state: 'done', findings: [{ kind: 'acceptance_failed', element: R('R2') }] });
  // Still on its record after approval: the finding names the element, the evidence item and who recorded it.
  const w = await kolab.readWork(eve, W(id));
  expect(w.state).toBe('done');
  const run = w.evidence.find((e) => e.kind === 'test_run')!;
  expect(run.checks).toStrictEqual([{ address: R('R1'), version: 1, result: 'passed' }, { address: R('R2'), version: 1, result: 'failed' }]);
  expect(w.findings).toStrictEqual([{
    kind: 'acceptance_failed', element: R('R2'), version: 1, evidence: run.id, recorded_by: 'bob', at: run.at,
    explanation: `bob's test run "npm test: 120 passed" records the acceptance check of ${R('R2')} (version 1) as failed`,
  }]);
  // The evidence that carries it is never edited, by any role, so no later act removes it (PLN5).
  expect(await rejection(kolab.db.query(`update evidence set checks = null where id = $1`, [run.id]))).toMatch(/evidence is never edited or removed/);
  const asSystem = (sql: string) => kolab.db.transaction(async (tx) => { await tx.exec('set local role kj_system'); return tx.query(sql); });
  expect(await rejection(asSystem(`update evidence set checks = null`))).toMatch(/never edited/);
  // A redaction drops its text, and keeps its checks, which carry addresses only (SRC1).
  await asSystem(`update evidence set title = null, files = null, redacted_at = now(), redacted_by = '${ADMIN_DOER}' where kind = 'test_run'`);
  expect((await kolab.readWork(eve, W(id))).findings).toMatchObject([{ element: R('R2'), evidence: run.id }]);
  // Reopened, the package starts a new round, and its record keeps the finding.
  expect((await kolab.reopenWork(eve, W(id), { note: 'again' })).state).toBe('todo');
  expect((await kolab.readWork(eve, W(id))).findings).toMatchObject([{ element: R('R2') }]);
});

test('REV9: a request for changes doesn\'t remove a finding either; the resubmission\'s request carries it, and so does its approval', async () => {
  const { kolab, bob, eve } = await planned();
  const id = await pull(kolab, bob);
  await kolab.submitWork(bob, W(id), { evidence: [COMMIT(), RUN([{ address: R('R1'), result: 'failed' }])] });
  const back = await kolab.reviewWork(eve, W(id), { verdict: 'request_changes', note: 'R1 fails.' });
  expect(back).toMatchObject({ state: 'in_progress', findings: [{ element: R('R1') }] });
  // The fix's passing run is recorded beside the failed one, which stays.
  await kolab.submitWork(bob, W(id), { evidence: [COMMIT('b'), RUN([{ address: R('R1'), result: 'passed' }], 'npm test: 121 passed')] });
  expect((await kolab.reviewRequests({ kolab: TEST_KOLAB, reviewer: 'eve' }))[0].findings).toMatchObject([{ element: R('R1') }]);
  expect((await kolab.reviewWork(eve, W(id), { verdict: 'approve' })).findings).toMatchObject([{ element: R('R1') }]);
  expect((await kolab.readWork(bob, W(id))).findings).toHaveLength(1);
  // A package whose checks all pass has none.
  const other = await pull(kolab, bob);
  const r = await kolab.submitWork(bob, W(other), { evidence: [COMMIT('c'), RUN([{ address: R('R2'), result: 'passed' }])] });
  expect(r.findings).toBeUndefined();
  expect((await kolab.readWork(bob, W(other))).findings).toBeUndefined();
});

test('REV9: an address that doesn\'t resolve to a committed spec element is refused, and nothing is recorded', async () => {
  const { kolab, product, bob } = await planned();
  const id = await pull(kolab, bob);
  // A draft of the spec, which nothing may name until it commits.
  await kolab.draft(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.', R2: 'Orders ship in a day.', R3: 'Orders can be returned.' }) });
  const refused = async (address: string) => rejection(kolab.addEvidence(bob, W(id), [RUN([{ address, result: 'passed' }])]));
  expect(await refused(R('R9'))).toBe(`GateError: evidence 1's check 1, ${R('R9')}, doesn't resolve: kj:test/orders@1 has no element R9. Nothing was recorded.`);
  expect(await refused('kj:orders@2#R3')).toMatch(/^GateError: evidence 1's check 1, kj:orders@2#R3, doesn't resolve: version 2 of its spec isn't committed/);
  expect(await refused('kj:orders@7#R1')).toMatch(/doesn't resolve: version 7 of its spec isn't committed/);
  expect(await refused('kj:nowhere#R1')).toMatch(/doesn't resolve: no node of that name that you can read/);
  expect(await refused('kj:elsewhere/orders#R1')).toMatch(/doesn't resolve: no node of that name that you can read/);
  expect(await refused('kj:orders-pg#b1')).toMatch(/names an element of a binding, and an acceptance check names a spec's \(REV9\)/);
  expect(await refused('kj:orders')).toMatch(/names no element/);
  expect(await refused('kj:orders#R1~q({"exact":"Orders"})')).toMatch(/names no element/);
  expect(await refused('orders#R1')).toMatch(/isn't an address/);
  // The same element twice in one run, however it is written.
  expect(await rejection(kolab.addEvidence(bob, W(id), [RUN([{ address: 'kj:orders#R1', result: 'passed' }, { address: R('R1'), result: 'failed' }])])))
    .toMatch(/names kj:test\/orders#R1 again: a test run checks each element once/);
  // Submitting with one that doesn't resolve refuses the submission too.
  expect(await rejection(kolab.submitWork(bob, W(id), { evidence: [COMMIT(), RUN([{ address: R('R9'), result: 'failed' }])] }))).toMatch(/doesn't resolve/);
  // Their shape, before anything is resolved.
  const shape = async (checks: unknown, extra: Record<string, unknown> = {}) => rejection(kolab.addEvidence(bob, W(id), [{ kind: 'test_run', title: 't', checks, ...extra } as never]));
  expect(await shape([])).toMatch(/checks lists the acceptance checks it ran/);
  expect(await shape([{ address: R('R1'), result: 'ok' }])).toMatch(/check 1's result is passed or failed, not "ok"/);
  expect(await shape([{ address: R('R1'), result: 'passed', text: 'x' }])).toMatch(/check 1 has text, which a check doesn't take/);
  expect(await shape(Array.from({ length: 201 }, (_, i) => ({ address: `kj:orders#R${i}`, result: 'passed' })))).toMatch(/^LimitError: .*201 acceptance checks; the limit is 200/);
  expect(await rejection(kolab.addEvidence(bob, W(id), [{ ...COMMIT(), checks: [{ address: R('R1'), result: 'passed' }] } as never]))).toMatch(/only a test run lists acceptance checks/);
  expect((await kolab.db.query(`select 1 from evidence`)).rows).toStrictEqual([]);
  // A later spec version: a check resolves to the latest committed one, or the committed one it pins.
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.', R2: 'Orders ship in a day.', R3: 'Orders can be returned.' }) });
  await kolab.addEvidence(bob, W(id), [RUN([{ address: 'kj:orders#R3', result: 'passed' }, { address: 'kj:orders@1#R1', result: 'passed' }])]);
  expect((await kolab.readWork(bob, W(id))).evidence[0].checks).toStrictEqual([
    { address: R('R3'), version: 3, result: 'passed' }, { address: R('R1'), version: 1, result: 'passed' },
  ]);
});

test('REV9: the same run given again with other checks is recorded, not counted as already there; given again as it was, it is', async () => {
  const { kolab, bob } = await planned();
  const id = await pull(kolab, bob);
  expect(await kolab.addEvidence(bob, W(id), [RUN([{ address: R('R1'), result: 'failed' }])])).toMatchObject({ recorded: 1, already: 0 });
  expect(await kolab.addEvidence(bob, W(id), [RUN([{ address: R('R1'), result: 'failed' }])])).toMatchObject({ recorded: 0, already: 1 });
  expect(await kolab.addEvidence(bob, W(id), [RUN([{ address: R('R1'), result: 'passed' }])])).toMatchObject({ recorded: 1, already: 0 });
  expect((await kolab.readWork(bob, W(id))).findings).toHaveLength(1);
});

test('migration 0048: only a test run carries checks, each a full address, a version and a result, each element once', async () => {
  const { kolab, bob } = await planned();
  const id = await pull(kolab, bob);
  await kolab.addEvidence(bob, W(id), [COMMIT()]);
  const ev = (await kolab.db.query<{ event_id: string }>(`select event_id from evidence`)).rows[0].event_id;
  const insert = (kind: string, checks: unknown, ref: string | null = null) => kolab.db.query(
    `insert into evidence(id, binding_node_id, element_id, event_id, kind, ref, title, recorded_by, checks) values (gen_random_uuid()::text, (select binding_node_id from evidence limit 1), $1, $2, $3, $4, 't', 'bob', $5)`,
    [id, ev, kind, ref, JSON.stringify(checks)]);
  const ok = { address: R('R1'), version: 1, passed: false };
  for (const bad of [[], {}, [{ ...ok, address: 'kj:orders#R1' }], [{ ...ok, version: 0 }], [{ ...ok, version: '1' }], [{ ...ok, passed: 'no' }], [{ ...ok, text: 'x' }], [ok, ok]]) {
    expect(await rejection(insert('test_run', bad))).toMatch(/evidence_checks/);
  }
  expect(await rejection(insert('commit', [ok], sha('f')))).toMatch(/evidence_checks/);
  await insert('test_run', [ok]);
});
