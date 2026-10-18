// Case files, positions and rulings (W2.14; CASE1–CASE7, D16, D50): a disagreement agents can't
// settle becomes a case file with two positions; a person rules on it, or rules directly; every
// ruling records its author and date, never changes, and is precedent in its own kolab only.
import { expect, test } from '@jest/globals';
import { sessionKey, type Kolab } from '@konjir/engine';
import type { KolabEvent } from '@konjir/types';
import { commitReviewed, els, people, rejection, setup, TEST_KOLAB } from '@konjir/engine/testing';

/**
 * A spec and a binding in the test kolab, with a product agent of Alice's beside her: Alice and
 * her agent write the functional layer, Bob the technical one, Carol only reads.
 */
async function dispute() {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({
    R1: 'Checkout completes within 2 seconds of payment confirming.',
    R2: 'Users can save a cart for later.',
  }) });
  await kolab.createNode(engineer, 'technical_binding', 'Orders on Postgres', 'orders-pg');
  await kolab.commit(engineer, 'orders-pg', { elements: els({ b1: 'The payment provider confirms in 3 to 5 seconds.' }) });
  await people(kolab, 'alice-pm', { owner: 'alice', layers: ['functional'] });
  const pm = await kolab.openSession('alice-pm', 'product');
  const reader = await kolab.openSession('carol', 'product');
  return { ...ctx, pm, reader };
}

/** Runs `sql` as kj_agent in `session`, so row-level security applies. */
const asAgent = <T extends Record<string, unknown>>(kolab: Kolab, session: string, sql: string, params: unknown[] = []) =>
  kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(session)]);
    return (await tx.query<T>(sql, params)).rows;
  });

test('an engineer raises a case file against the spec; the other side takes a position; a person rules, and it is precedent (CASE1–CASE6)', async () => {
  const { kolab, product, engineer, pm } = await dispute();
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));

  // CASE5: the spec can't be met as written, so the engineer raises a case file against it, with evidence.
  const c = await kolab.openCase(engineer, 'kj:orders#R1', {
    question: 'Can checkout complete within 2 seconds when the provider takes 3 to 5?',
    claim: 'R1 cannot be met: the provider confirms in 3 to 5 seconds.',
    evidence: ['kj:orders-pg#b1', 'provider SLA, section 4.2'],
  });
  expect(new Set(events.map((e) => JSON.stringify(e)))).toStrictEqual(new Set([
    JSON.stringify({ inbox: 'layer', layer: 'functional' }),   // the spec's layer: where it is ruled
    JSON.stringify({ inbox: 'actor', actor: 'bob' }),         // the opener's answers
  ]));
  const [open] = await kolab.listCases({ kolab: TEST_KOLAB, layer: 'functional', state: 'open' });
  expect(open).toMatchObject({
    case: c, on: 'kj:orders@1#R1', layer: 'functional', state: 'open', opened_by: 'bob', ruling: null,
    question: 'Can checkout complete within 2 seconds when the provider takes 3 to 5?',
    positions: [{ actor: 'bob', claim: 'R1 cannot be met: the provider confirms in 3 to 5 seconds.', evidence: ['kj:orders-pg#b1', 'provider SLA, section 4.2'], verdict: null }],
  });
  expect(open.opened_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(open.next).toMatch(/konjir_add_position case=/);
  // An open case file freezes nothing (CASE7): the spec still commits.
  await commitReviewed(kolab, product, pm, 'orders', { deltas: [{ kind: 'override', element: 'R2', text: 'Users can save a cart for 30 days.' }] });

  // Nobody rules on one position: the other side comes first.
  expect(await rejection(kolab.rule(product, { case: c, text: 'R1 stands.', effect: 'keep_intent', verdicts: {} })))
    .toMatch(/holds 1 position; it is ruled on once it holds two/);

  // The other side. One position per actor, two per case file.
  events.length = 0;
  const p2 = await kolab.addPosition(pm, c, { claim: 'R1 stands: confirm optimistically and reconcile.', evidence: ['kj:orders#R1'] });
  expect(new Set(events.map((e) => JSON.stringify(e)))).toStrictEqual(new Set([
    JSON.stringify({ inbox: 'layer', layer: 'functional' }),
    JSON.stringify({ inbox: 'actor', actor: 'bob' }),
    JSON.stringify({ inbox: 'actor', actor: 'alice-pm' }),
  ]));
  expect(await rejection(kolab.addPosition(engineer, c, { claim: 'Again.', evidence: ['x'] }))).toMatch(/bob already holds a position/);
  const [twoSided] = await kolab.listCases({ kolab: TEST_KOLAB, id: c });
  const p1 = twoSided.positions.find((p) => p.actor === 'bob')!.position;
  expect(twoSided.positions.map((p) => p.position)).toStrictEqual([p1, p2]);
  expect(twoSided.next).toMatch(/Waiting for a ruling from a person with Write on the functional layer: konjir_rule case=/);

  // Only a person rules (CASE2), from a session that writes the element's layer, never a party to it.
  expect(await rejection(kolab.rule(pm, { case: c, text: 'R1 stands.', effect: 'keep_intent', verdicts: { [p1]: 'overruled', [p2]: 'sustained' } })))
    .toMatch(/AccessError: only a person rules \(CASE2\): alice-pm is an agent of alice/);
  expect(await rejection(kolab.rule(engineer, { case: c, text: 'R1 goes.', effect: 'change_intent', verdicts: { [p1]: 'sustained', [p2]: 'overruled' } })))
    .toMatch(/RoleError: an engineer session may not write the functional layer/);
  // Each position gets its verdict, and only those positions.
  expect(await rejection(kolab.rule(product, { case: c, text: 'R1 stands.', effect: 'keep_intent', verdicts: { [p1]: 'overruled' } })))
    .toMatch(/give each position of case file .* a verdict/);
  expect(await rejection(kolab.rule(product, { case: c, text: 'R1 stands.', effect: 'keep_intent' })))
    .toMatch(/give each position/);

  events.length = 0;
  const r = await kolab.rule(product, {
    case: c, text: 'R1 stands: show the order as confirmed at once, and reconcile when the provider answers.',
    effect: 'keep_intent', verdicts: { [p1]: 'overruled', [p2]: 'sustained' },
  });
  expect(new Set(events.map((e) => JSON.stringify(e)))).toStrictEqual(new Set([
    JSON.stringify({ inbox: 'layer', layer: 'functional' }),   // the case leaves the inbox
    JSON.stringify({ inbox: 'actor', actor: 'bob' }),
    JSON.stringify({ inbox: 'actor', actor: 'alice-pm' }),
  ]));
  const [ruled] = await kolab.listCases({ kolab: TEST_KOLAB, id: c });
  expect(ruled).toMatchObject({
    state: 'ruled',
    positions: [{ position: p1, verdict: 'overruled' }, { position: p2, verdict: 'sustained' }],
    ruling: { ruling: r, on: 'kj:orders@1#R1', case: c, effect: 'keep_intent', ruled_by: 'alice', replaces: null },
  });
  // CASE4: its author and its date.
  expect(Date.now() - Date.parse(ruled.ruling!.ruled_at!)).toBeLessThan(60_000);
  expect(ruled.next).toMatch(/Ruled by alice: it keeps the intent: find another way.*precedent/);
  expect(await kolab.listCases({ kolab: TEST_KOLAB, layer: 'functional', state: 'open' })).toStrictEqual([]);
  // Each party's own list.
  expect((await kolab.listCases({ kolab: TEST_KOLAB, actor: 'alice-pm' })).map((x) => x.case)).toStrictEqual([c]);

  // Ruled once: no more positions, no second ruling.
  expect(await rejection(kolab.addPosition(product, c, { claim: 'Late.', evidence: ['x'] }))).toMatch(/already ruled on/);
  expect(await rejection(kolab.rule(product, { case: c, text: 'Again.', effect: 'change_intent', verdicts: { [p1]: 'sustained', [p2]: 'overruled' } })))
    .toMatch(/already ruled on/);

  // A ruling given directly (CASE3, D16), on another element, saying in words what it replaces.
  const d = await kolab.rule(product, { address: 'kj:orders#R2', text: 'Saved carts last 30 days.', effect: 'change_intent', replaces: 'Saved carts never expire.' });
  expect(await kolab.listRulings({ kolab: TEST_KOLAB })).toMatchObject([
    { ruling: d, on: 'kj:orders@2#R2', case: null, effect: 'change_intent', replaces: 'Saved carts never expire.', ruled_by: 'alice' },
    { ruling: r, on: 'kj:orders@1#R1', case: c },
  ]);
  expect((await kolab.rulingsFor(engineer, { node: 'orders-pg' }))).toStrictEqual([]);
  expect((await kolab.rulingsFor(engineer, { node: 'orders' })).map((x) => x.ruling)).toStrictEqual([d, r]);
});

test('who may open, argue and rule, and what a case file must say', async () => {
  const { kolab, product, engineer, reader } = await dispute();
  // Anyone with access may open one (as anyone may ask, Q1), about one element of a committed version.
  const c = await kolab.openCase(reader, 'kj:orders-pg#b1', { question: 'Is 3 to 5 seconds right?', claim: 'It is 1 second now.', evidence: ['release notes 2026-09'] });
  expect((await kolab.listCases({ kolab: TEST_KOLAB, layer: 'technical' }))[0]).toMatchObject({ case: c, on: 'kj:orders-pg@1#b1', layer: 'technical' });
  expect(await rejection(kolab.openCase(engineer, 'kj:orders', { question: 'q', claim: 'c', evidence: ['e'] }))).toMatch(/about one element/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R1~q({"exact":"2 seconds"})', { question: 'q', claim: 'c', evidence: ['e'] }))).toMatch(/whole element/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R9', { question: 'q', claim: 'c', evidence: ['e'] }))).toMatch(/doesn't exist/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R1', { question: 'q', claim: 'c', evidence: [] }))).toMatch(/needs its evidence/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R1', { question: ' ', claim: 'c', evidence: ['e'] }))).toMatch(/give the question in dispute/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R1', { question: 'q', claim: 'c', evidence: ['kj:orders#R7'] }))).toMatch(/evidence kj:orders#R7 does not resolve/);
  const draft = await kolab.draft(product, 'orders', { deltas: [{ kind: 'override', element: 'R1', text: 'Within 6 seconds.' }] });
  expect(draft).toBeTruthy();
  expect(await rejection(kolab.openCase(engineer, 'kj:orders@2#R1', { question: 'q', claim: 'c', evidence: ['e'] }))).toMatch(/is drafted, not committed/);

  // The technical layer's case is ruled from an engineer session with Write on it; a reader can't.
  await kolab.addPosition(engineer, c, { claim: 'Still 3 to 5 seconds at p99.', evidence: ['kj:orders-pg#b1'] });
  const [{ positions }] = await kolab.listCases({ kolab: TEST_KOLAB, id: c });
  const verdicts = Object.fromEntries(positions.map((p) => [p.position, p.actor === 'bob' ? 'sustained' as const : 'overruled' as const]));
  expect(await rejection(kolab.rule(product, { case: c, text: 'x', effect: 'keep_intent', verdicts }))).toMatch(/RoleError: a product session may not write the technical layer/);
  // Bob holds a position, so he can't rule on it.
  expect(await rejection(kolab.rule(engineer, { case: c, text: 'x', effect: 'keep_intent', verdicts }))).toMatch(/bob holds a position on case file .*, so can't rule on it/);
  await kolab.endSession(reader);
  const carol = await kolab.openSession('carol', 'engineer');
  expect(await rejection(kolab.rule(carol, { case: c, text: 'x', effect: 'keep_intent', verdicts }))).toMatch(/AccessError: carol may not write the technical layer of kolab test: it holds Read/);
  // A ruling must say what it does (CASE6), on one subject.
  expect(await rejection(kolab.rule(product, { address: 'kj:orders#R1', text: 'x', effect: 'maybe' as never }))).toMatch(/change_intent or keep_intent/);
  expect(await rejection(kolab.rule(product, { case: c, address: 'kj:orders#R1', text: 'x', effect: 'keep_intent' }))).toMatch(/not both or neither/);
  expect(await rejection(kolab.rule(product, { address: 'kj:orders#R1', text: 'x', effect: 'keep_intent', verdicts: {} }))).toMatch(/a direct ruling has none/);
  // A direct ruling on a whole node is fine too.
  await kolab.rule(product, { address: 'kj:orders', text: 'The spec states intent only.', effect: 'keep_intent' });
});

test("case files and rulings are their kolab's alone: another kolab's are as if they weren't there, to Kolab and to row-level security (TEN12, TEN13)", async () => {
  const { kolab, product, engineer } = await dispute();
  const c = await kolab.openCase(engineer, 'kj:orders#R1', { question: 'q', claim: 'c', evidence: ['e'] });
  await kolab.rule(product, { address: 'kj:orders#R2', text: 'Carts last 30 days.', effect: 'change_intent' });

  await kolab.addActor('dave');
  await kolab.createKolab('elsewhere', { owner: 'dave' });
  const dave = await kolab.openSession('dave', 'product', { kolab: 'elsewhere' });
  await kolab.commit(dave, await kolab.createNode(dave, 'functional_spec', 'Orders', 'orders'), { elements: els({ R1: 'Orders ship in a day.' }) });

  expect(await kolab.casesFor(dave, {})).toStrictEqual([]);
  expect(await kolab.rulingsFor(dave, {})).toStrictEqual([]);
  expect(await rejection(kolab.addPosition(dave, c, { claim: 'x', evidence: ['e'] }))).toMatch(/no case file .* in kolab elsewhere/);
  expect(await rejection(kolab.openCase(dave, 'kj:test/orders#R1', { question: 'q', claim: 'c', evidence: ['e'] }))).toMatch(/opening a case file across kolabs isn't supported yet/);
  // Row-level security: as kj_agent, dave's session reads none of test's case files, positions or rulings.
  for (const t of ['case_file', 'position', 'ruling']) {
    expect(await asAgent(kolab, dave, `select id from ${t}`)).toStrictEqual([]);
    expect((await asAgent(kolab, engineer, `select id from ${t}`)).length).toBeGreaterThan(0);
  }
  // And no agent writes them directly: only Kolab's verbs do, as kj_system.
  expect(await rejection(asAgent(kolab, engineer, `insert into ruling(id, version_id, actor_id, text, effect) select 'x', id, 'bob', 't', 'keep_intent' from version limit 1`)))
    .toMatch(/permission denied/);
});

test('a ruling never changes, only a person is its author, and a position keeps its claim (stare decisis)', async () => {
  const { kolab, product, engineer, pm } = await dispute();
  const c = await kolab.openCase(engineer, 'kj:orders#R1', { question: 'q', claim: 'c', evidence: ['e'] });
  await kolab.addPosition(pm, c, { claim: 'd', evidence: ['e'] });
  const [{ positions }] = await kolab.listCases({ kolab: TEST_KOLAB, id: c });
  const r = await kolab.rule(product, { case: c, text: 'R1 stands.', effect: 'keep_intent', verdicts: Object.fromEntries(positions.map((p) => [p.position, 'sustained' as const])) });
  const sys = (sql: string, params: unknown[] = []) => kolab.db.transaction(async (tx) => { await tx.exec('set local role kj_system'); return tx.query(sql, params); });
  expect(await rejection(sys(`update ruling set text = 'R1 goes.' where id = $1`, [r]))).toMatch(/a ruling never changes once given/);
  expect(await rejection(sys(`update position set claim = 'other' where case_file_id = $1`, [c]))).toMatch(/a position never changes once taken/);
  expect(await rejection(sys(`update position set verdict = 'overruled' where case_file_id = $1`, [c]))).toMatch(/a position never changes once taken/);
  expect(await rejection(sys(`update case_file set state = 'open' where id = $1`, [c]))).toMatch(/a case file never changes once opened/);
  expect(await rejection(sys(`update case_file set question = 'other' where id = $1`, [c]))).toMatch(/a case file never changes once opened/);
  // A ruling written as an agent, by anyone, is refused by the database too.
  expect(await rejection(sys(`insert into ruling(id, version_id, actor_id, text, effect) select 'x', id, 'alice-pm', 't', 'keep_intent' from version limit 1`)))
    .toMatch(/alice-pm is not a person; only a person rules/);
  // And every new one is dated and says what it does.
  expect(await rejection(sys(`insert into ruling(id, version_id, actor_id, text, effect, ruled_at) select 'y', id, 'alice', 't', 'keep_intent', null from version limit 1`)))
    .toMatch(/ruling_dated/);
  expect(await rejection(sys(`insert into ruling(id, version_id, actor_id, text) select 'z', id, 'alice', 't' from version limit 1`)))
    .toMatch(/ruling_has_effect/);
});
