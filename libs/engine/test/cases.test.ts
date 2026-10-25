// Case files, positions and rulings (W2.14; CASE1–CASE7, D16, D49, D50, D51): a disagreement
// agents can't settle becomes a case file with one position for each side; a person who isn't a
// party rules on it, or rules directly; every ruling records its author and date, never changes,
// is precedent in its own kolab only, and one that changes the intent marks the element.
import { expect, test } from '@jest/globals';
import { sessionKey, type Kolab } from '@konjir/engine';
import type { KolabEvent } from '@konjir/types';
import { commitReviewed, els, marksOn, people, rejection, setup, TEST_KOLAB } from '@konjir/engine/testing';

/**
 * A spec and a binding in the test kolab. Alice and her product agent write the functional layer,
 * and so does Dana, who is no party to anything here; Bob and his agent write the technical one;
 * Carol only reads.
 */
async function dispute() {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({
    R1: 'Checkout completes within 2 seconds of payment confirming.',
    R2: 'Users can save a cart for later.',
  }) });
  await kolab.createNode(engineer, 'binding', 'Orders on Postgres', 'orders-pg');
  await kolab.commit(engineer, 'orders-pg', { elements: els({ b1: 'The payment provider confirms in 3 to 5 seconds.' }) });
  await people(kolab, 'alice-pm', { owner: 'alice', layers: ['functional'] });
  await people(kolab, 'bob-eng', { owner: 'bob', layers: ['technical'] });
  await people(kolab, 'dana', { layers: ['functional'] });
  const pm = await kolab.openSession('alice-pm', 'product');
  const bobEng = await kolab.openSession('bob-eng', 'engineer');
  const dana = await kolab.openSession('dana', 'product');
  const reader = await kolab.openSession('carol', 'product');
  return { ...ctx, pm, bobEng, dana, reader };
}

/** Runs `sql` as kj_agent in `session`, so row-level security applies. */
const asAgent = <T extends Record<string, unknown>>(kolab: Kolab, session: string, sql: string, params: unknown[] = []) =>
  kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(session)]);
    return (await tx.query<T>(sql, params)).rows;
  });

const ev = (events: KolabEvent[]) => new Set(events.map((e) => JSON.stringify(e)));
const layer = (l: string) => JSON.stringify({ inbox: 'layer', kolab: TEST_KOLAB, layer: l });
const actor = (a: string) => JSON.stringify({ inbox: 'actor', kolab: TEST_KOLAB, actor: a });

test('an engineer raises a case file against the spec; the other side takes the other position; a person who is no party rules, and it is precedent (CASE1–CASE6)', async () => {
  const { kolab, product, engineer, pm, bobEng, dana, reader } = await dispute();
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));

  // CASE5: the spec can't be met as written, so the engineer raises a case file against it, seeking to change it.
  const c = await kolab.openCase(engineer, 'kj:orders#R1', {
    question: 'Can checkout complete within 2 seconds when the provider takes 3 to 5?',
    claim: 'R1 cannot be met: the provider confirms in 3 to 5 seconds.', seeks: 'change_intent',
    evidence: ['kj:orders-pg#b1', 'provider SLA, section 4.2'],
  });
  expect(ev(events)).toStrictEqual(new Set([layer('functional'), actor('bob')]));
  const [open] = await kolab.listCases({ kolab: TEST_KOLAB, layer: 'functional', state: 'open' });
  expect(open).toMatchObject({
    case: c, on: 'kj:orders@1#R1', layer: 'functional', state: 'open', opened_by: 'bob', ruling: null, superseded_by: null,
    positions: [{ actor: 'bob', seeks: 'change_intent', evidence: ['kj:orders-pg#b1', 'provider SLA, section 4.2'], verdict: null }],
  });
  expect(open.opened_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(open.next).toMatch(/konjir_add_position case=.*to keep the intent/);
  // An open case file freezes nothing (CASE7): the spec still commits.
  await commitReviewed(kolab, product, pm, 'orders', { deltas: [{ kind: 'override', element: 'R2', text: 'Users can save a cart for 30 days.' }] });

  // Nobody rules on one side.
  expect(await rejection(kolab.rule(dana, { case: c, text: 'R1 stands.', verdicts: {} })))
    .toMatch(/holds 1 position; it is ruled on once it holds both sides/);

  // The other side must be someone else's: not Bob again, not Bob's own agent, not a reader.
  expect(await rejection(kolab.addPosition(engineer, c, { claim: 'Again.', evidence: ['x'] }))).toMatch(/bob already holds a position/);
  expect(await rejection(kolab.addPosition(bobEng, c, { claim: 'Agreed.', evidence: ['x'] })))
    .toMatch(/AccessError: bob-eng can't take the other side of case file .*: bob holds its first side, and one person and their agents are one side/);
  expect(await rejection(kolab.addPosition(reader, c, { claim: 'Agreed.', evidence: ['x'] })))
    .toMatch(/AccessError: carol holds Read in kolab test; only those with Write on a layer of a kolab argue a case file there \(D49\)/);
  events.length = 0;
  const p2 = await kolab.addPosition(pm, c, { claim: 'R1 stands: confirm optimistically and reconcile.', evidence: ['kj:orders#R1'] });
  expect(ev(events)).toStrictEqual(new Set([layer('functional'), actor('bob'), actor('alice-pm')]));
  const [twoSided] = await kolab.listCases({ kolab: TEST_KOLAB, id: c });
  const p1 = twoSided.positions.find((p) => p.actor === 'bob')!.position;
  // The opener sees who took the other side, and which side it takes: the opposite.
  expect(twoSided.positions.map((p) => [p.position, p.actor, p.seeks])).toStrictEqual([[p1, 'bob', 'change_intent'], [p2, 'alice-pm', 'keep_intent']]);
  expect(twoSided.next).toMatch(/Waiting for a ruling from a person with Write on the functional layer who isn't a party: konjir_rule case=/);

  // Who rules (D51): a person, never an agent; with Write on the element's layer; not a party, nor the person whose agent is.
  const verdicts = { [p1]: 'overruled' as const, [p2]: 'sustained' as const };
  expect(await rejection(kolab.rule(pm, { case: c, text: 'R1 stands.', verdicts }))).toMatch(/AccessError: only a person rules \(CASE2\): alice-pm is an agent of alice/);
  expect(await rejection(kolab.rule(engineer, { case: c, text: 'R1 goes.', verdicts }))).toMatch(/RoleError: an engineer session may not write the functional layer/);
  expect(await rejection(kolab.rule(product, { case: c, text: 'R1 stands.', verdicts })))
    .toMatch(/AccessError: alice is a party to case file .*: its agent alice-pm holds a position on it, so can't rule on it/);
  // Exactly one position is sustained, and the effect is its side.
  expect(await rejection(kolab.rule(dana, { case: c, text: 'R1 stands.', verdicts: { [p1]: 'overruled' } }))).toMatch(/give each position of case file .* a verdict/);
  expect(await rejection(kolab.rule(dana, { case: c, text: 'Both.', verdicts: { [p1]: 'sustained', [p2]: 'sustained' } }))).toMatch(/sustains exactly one .* these verdicts sustain 2/);
  expect(await rejection(kolab.rule(dana, { case: c, text: 'Neither.', verdicts: { [p1]: 'overruled', [p2]: 'overruled' } }))).toMatch(/these verdicts sustain 0/);
  expect(await rejection(kolab.rule(dana, { case: c, text: 'R1 stands.', effect: 'change_intent', verdicts })))
    .toMatch(/the sustained position seeks to keep the intent, so the ruling's effect is keep_intent, not change_intent/);

  events.length = 0;
  const r = await kolab.rule(dana, { case: c, text: 'R1 stands: show the order as confirmed at once, and reconcile when the provider answers.', verdicts });
  expect(ev(events)).toStrictEqual(new Set([layer('functional'), actor('bob'), actor('alice-pm')]));
  const [ruled] = await kolab.listCases({ kolab: TEST_KOLAB, id: c });
  expect(ruled).toMatchObject({
    state: 'ruled',
    positions: [{ position: p1, verdict: 'overruled' }, { position: p2, verdict: 'sustained' }],
    ruling: { ruling: r, on: 'kj:orders@1#R1', case: c, effect: 'keep_intent', ruled_by: 'dana', replaces: null },
  });
  // CASE4: its author and its date. Keeping the intent marks nothing.
  expect(Date.now() - Date.parse(ruled.ruling!.ruled_at!)).toBeLessThan(60_000);
  expect(ruled.next).toMatch(/Ruled by dana: it keeps the intent: find another way.*precedent/);
  expect(await marksOn(kolab, 'orders')).toStrictEqual([]);
  expect(await kolab.listCases({ kolab: TEST_KOLAB, layer: 'functional', state: 'open' })).toStrictEqual([]);
  expect((await kolab.listCases({ kolab: TEST_KOLAB, actor: 'alice-pm' })).map((x) => x.case)).toStrictEqual([c]);

  // Ruled once: no more positions, no second ruling.
  expect(await rejection(kolab.addPosition(dana, c, { claim: 'Late.', evidence: ['x'] }))).toMatch(/already ruled on/);
  expect(await rejection(kolab.rule(dana, { case: c, text: 'Again.', verdicts: { [p1]: 'sustained', [p2]: 'overruled' } }))).toMatch(/already ruled on/);
  expect((await kolab.rulingsFor(engineer, { node: 'orders' })).map((x) => x.ruling)).toStrictEqual([r]);
  expect(await kolab.rulingsFor(engineer, { node: 'orders-pg' })).toStrictEqual([]);
});

test('a direct ruling that changes the intent marks the element, with a question to its layer, until a version amends it; it supersedes the case file open on it (CASE3, D51)', async () => {
  const { kolab, product, engineer, pm, dana } = await dispute();
  const c = await kolab.openCase(engineer, 'kj:orders#R2', { question: 'Do saved carts expire?', claim: 'They must, for storage.', seeks: 'change_intent', evidence: ['storage budget'] });
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));

  // It can't wait for the other side: Dana rules directly. A direct ruling says what it does.
  expect(await rejection(kolab.rule(dana, { address: 'kj:orders#R2', text: 'x' }))).toMatch(/say what a direct ruling does/);
  const d = await kolab.rule(dana, { address: 'kj:orders#R2', text: 'Saved carts last 30 days.', effect: 'change_intent', replaces: 'Saved carts never expire.' });
  // It is news: the layer's inbox changes (the mark, its question, the superseded case file) and the opener hears.
  expect(ev(events)).toStrictEqual(new Set([layer('functional'), actor('bob')]));
  const [sup] = await kolab.listCases({ kolab: TEST_KOLAB, id: c });
  expect(sup).toMatchObject({ state: 'superseded', superseded_by: d, ruling: { ruling: d, case: null, on: 'kj:orders@1#R2' } });
  expect(sup.next).toMatch(/^Superseded by ruling .*, given directly on kj:orders@1#R2 by dana: it changes the intent/);
  expect(await rejection(kolab.addPosition(pm, c, { claim: 'x', evidence: ['e'] }))).toMatch(/already superseded by a ruling/);
  expect(await kolab.listRulings({ kolab: TEST_KOLAB })).toMatchObject([{ ruling: d, case: null, effect: 'change_intent', replaces: 'Saved carts never expire.', ruled_by: 'dana' }]);

  // D51: R2 is marked, with a question to the functional layer. Nothing but an amendment settles them.
  const [mark] = await marksOn(kolab, 'orders');
  expect([mark.reason, mark.element_id, mark.note]).toStrictEqual(['ruled', 'R2', `ruling ${d} changes the intent of kj:orders#R2: "Saved carts last 30 days."`]);
  const [described] = await kolab.describeMarks({ layer: 'functional' });
  expect(described).toMatchObject({ reason: 'ruled', dirty: 'kj:orders@1#R2', next: expect.stringMatching(/Amend it/) });
  const [question] = await kolab.listQueries({ layer: 'functional', state: 'open' });
  expect(question).toMatchObject({ address: 'kj:orders@1#R2', mark: mark.id });
  expect(await rejection(kolab.clear(product, mark.id))).toMatch(/amend it and commit/);
  expect(await rejection(kolab.answerQuery(product, question.id, 'done'))).toMatch(/commit a version that amends it/);
  // An unrelated edit settles nothing; amending R2 settles both.
  await commitReviewed(kolab, product, pm, 'orders', { deltas: [{ kind: 'override', element: 'R1', text: 'Checkout completes within 6 seconds.' }] });
  expect((await marksOn(kolab, 'orders')).map((m) => m.reason)).toStrictEqual(['ruled']);
  await commitReviewed(kolab, product, pm, 'orders', { deltas: [{ kind: 'override', element: 'R2', text: 'Users can save a cart for 30 days.' }] });
  expect(await marksOn(kolab, 'orders')).toStrictEqual([]);
  expect((await kolab.listQueries({ layer: 'functional' })).find((q) => q.id === question.id)).toMatchObject({ state: 'answered', answer: expect.stringMatching(/^settled: version 3 of orders amends it/) });

  // A ruling on a case file that sustains the side seeking change marks its element too, and removing it settles that.
  const c2 = await kolab.openCase(engineer, 'kj:orders#R1', { question: 'q', claim: 'R1 must go.', seeks: 'change_intent', evidence: ['e'] });
  await kolab.addPosition(pm, c2, { claim: 'R1 stays.', evidence: ['e'] });
  const [{ positions }] = await kolab.listCases({ kolab: TEST_KOLAB, id: c2 });
  await kolab.rule(dana, { case: c2, text: 'R1 goes.', verdicts: Object.fromEntries(positions.map((p) => [p.position, p.actor === 'bob' ? 'sustained' as const : 'overruled' as const])) });
  expect((await marksOn(kolab, 'orders')).map((m) => [m.reason, m.element_id])).toStrictEqual([['ruled', 'R1']]);
  await commitReviewed(kolab, product, pm, 'orders', { deltas: [{ kind: 'remove', element: 'R1' }] });
  expect(await marksOn(kolab, 'orders')).toStrictEqual([]);
});

test('who may open and argue, and what a case file must say', async () => {
  const { kolab, product, engineer, reader } = await dispute();
  expect(await rejection(kolab.openCase(reader, 'kj:orders-pg#b1', { question: 'q', claim: 'c', seeks: 'keep_intent', evidence: ['e'] })))
    .toMatch(/AccessError: carol holds Read in kolab test; only those with Write on a layer of a kolab open a case file there \(D49\)/);
  const base = { question: 'q', claim: 'c', seeks: 'keep_intent' as const, evidence: ['e'] };
  expect(await rejection(kolab.openCase(engineer, 'kj:orders', base))).toMatch(/about one element/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R1~q({"exact":"2 seconds"})', base))).toMatch(/whole element/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R9', base))).toMatch(/doesn't exist/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R1', { ...base, evidence: [] }))).toMatch(/needs its evidence/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R1', { ...base, question: ' ' }))).toMatch(/give the question in dispute/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R1', { ...base, seeks: 'maybe' as never }))).toMatch(/say which side your position takes/);
  expect(await rejection(kolab.openCase(engineer, 'kj:orders#R1', { ...base, evidence: ['kj:orders#R7'] }))).toMatch(/evidence kj:orders#R7 does not resolve/);
  await kolab.draft(product, 'orders', { deltas: [{ kind: 'override', element: 'R1', text: 'Within 6 seconds.' }] });
  expect(await rejection(kolab.openCase(engineer, 'kj:orders@2#R1', base))).toMatch(/is drafted, not committed/);

  // The technical layer's case file is ruled from an engineer session with Write on it.
  const c = await kolab.openCase(product, 'kj:orders-pg#b1', { question: 'Is 3 to 5 seconds right?', claim: 'It is 1 second now.', seeks: 'change_intent', evidence: ['release notes'] });
  await kolab.addPosition(engineer, c, { claim: 'Still 3 to 5 seconds at p99.', evidence: ['kj:orders-pg#b1'] });
  const [{ positions }] = await kolab.listCases({ kolab: TEST_KOLAB, id: c });
  const verdicts = Object.fromEntries(positions.map((p) => [p.position, p.actor === 'bob' ? 'sustained' as const : 'overruled' as const]));
  expect(await rejection(kolab.rule(product, { case: c, text: 'x', verdicts }))).toMatch(/RoleError: a product session may not write the technical layer/);
  expect(await rejection(kolab.rule(engineer, { case: c, text: 'x', verdicts }))).toMatch(/bob is a party to case file .*, so can't rule on it/);
  await kolab.endSession(reader);
  const carol = await kolab.openSession('carol', 'engineer');
  expect(await rejection(kolab.rule(carol, { case: c, text: 'x', verdicts }))).toMatch(/no case file .* in kolab test/);   // she can't even see it (D49)
  expect(await rejection(kolab.rule(product, { case: c, address: 'kj:orders#R1', text: 'x', effect: 'keep_intent' }))).toMatch(/not both or neither/);
  expect(await rejection(kolab.rule(product, { address: 'kj:orders#R1', text: 'x', effect: 'keep_intent', verdicts: {} }))).toMatch(/a direct ruling has none/);
  // A direct ruling on a whole node is fine too, and keeping the intent marks nothing.
  await kolab.rule(product, { address: 'kj:orders', text: 'The spec states intent only.', effect: 'keep_intent' });
  expect(await marksOn(kolab, 'orders')).toStrictEqual([]);
});

test("case files and rulings belong to the kolab's work: another kolab's, and a reader's view of its own, show none, to Kolab and to row-level security (TEN12, TEN13, D49)", async () => {
  const { kolab, product, engineer, reader } = await dispute();
  const c = await kolab.openCase(engineer, 'kj:orders#R1', { question: 'q', claim: 'c', seeks: 'change_intent', evidence: ['e'] });
  await kolab.rule(product, { address: 'kj:orders#R2', text: 'Carts last 30 days.', effect: 'keep_intent' });

  await kolab.addActor('dave');
  await kolab.createKolab('elsewhere', { owner: 'dave' });
  const dave = await kolab.openSession('dave', 'product', { kolab: 'elsewhere' });
  await kolab.commit(dave, await kolab.createNode(dave, 'spec', 'Orders', 'orders'), { elements: els({ R1: 'Orders ship in a day.' }) });

  expect(await kolab.casesFor(dave, {})).toStrictEqual([]);
  expect(await kolab.rulingsFor(dave, {})).toStrictEqual([]);
  expect(await rejection(kolab.addPosition(dave, c, { claim: 'x', evidence: ['e'] }))).toMatch(/no case file .* in kolab elsewhere/);
  expect(await rejection(kolab.openCase(dave, 'kj:test/orders#R1', { question: 'q', claim: 'c', seeks: 'keep_intent', evidence: ['e'] }))).toMatch(/opening a case file across kolabs isn't supported yet/);
  // A reader in the kolab itself sees none either (D49), and nor does row-level security.
  expect(await kolab.casesFor(reader, {})).toStrictEqual([]);
  expect(await kolab.rulingsFor(reader, {})).toStrictEqual([]);
  expect(await kolab.sessionBelongs(reader)).toBe(false);
  for (const t of ['case_file', 'position', 'ruling']) {
    expect(await asAgent(kolab, dave, `select id from ${t}`)).toStrictEqual([]);
    expect(await asAgent(kolab, reader, `select id from ${t}`)).toStrictEqual([]);
    expect((await asAgent(kolab, engineer, `select id from ${t}`)).length).toBeGreaterThan(0);
  }
  // And no agent writes them directly: only Kolab's verbs do, as kj_system.
  expect(await rejection(asAgent(kolab, engineer, `insert into ruling(id, version_id, actor_id, text, effect) select 'x', id, 'bob', 't', 'keep_intent' from version limit 1`)))
    .toMatch(/permission denied/);
});

test('a ruling never changes or goes, only a person is its author, a position keeps its claim, and only a ruling rules (stare decisis)', async () => {
  const { kolab, engineer, pm, dana } = await dispute();
  const c = await kolab.openCase(engineer, 'kj:orders#R1', { question: 'q', claim: 'c', seeks: 'change_intent', evidence: ['e'] });
  const sys = (sql: string, params: unknown[] = []) => kolab.db.transaction(async (tx) => { await tx.exec('set local role kj_system'); return tx.query(sql, params); });
  // Before the ruling: no verdict, no ruled state, without a ruling row.
  expect(await rejection(sys(`update position set verdict = 'sustained' where case_file_id = $1`, [c]))).toMatch(/only its case file's ruling sets its verdict/);
  expect(await rejection(sys(`update case_file set state = 'ruled' where id = $1`, [c]))).toMatch(/a case file is ruled only with its ruling/);
  expect(await rejection(sys(`update case_file set state = 'superseded' where id = $1`, [c]))).toMatch(/case_file_superseded/);
  await kolab.addPosition(pm, c, { claim: 'd', evidence: ['e'] });
  const [{ positions }] = await kolab.listCases({ kolab: TEST_KOLAB, id: c });
  const r = await kolab.rule(dana, { case: c, text: 'R1 stands.', verdicts: Object.fromEntries(positions.map((p) => [p.position, p.actor === 'bob' ? 'overruled' as const : 'sustained' as const])) });
  expect(await rejection(sys(`update ruling set text = 'R1 goes.' where id = $1`, [r]))).toMatch(/a ruling never changes once given/);
  expect(await rejection(sys(`update position set claim = 'other' where case_file_id = $1`, [c]))).toMatch(/a position never changes once taken/);
  expect(await rejection(sys(`update position set verdict = 'overruled' where case_file_id = $1`, [c]))).toMatch(/a position never changes once taken/);
  expect(await rejection(sys(`update case_file set state = 'open' where id = $1`, [c]))).toMatch(/a case file never changes once opened/);
  expect(await rejection(sys(`update case_file set question = 'other' where id = $1`, [c]))).toMatch(/a case file never changes once opened/);
  expect(await rejection(sys(`insert into position(id, case_file_id, actor_id, claim, evidence, seeks) values ('late', $1, 'dana', 'x', '[]', 'keep_intent')`, [c]))).toMatch(/isn't open/);
  // Nothing is ever removed, row by row (kj_system may delete) or wholesale (only Kolab's own login may truncate).
  for (const t of ['ruling', 'position', 'case_file']) {
    expect(await rejection(sys(`delete from ${t}`))).toMatch(/are never removed/);
    expect(await rejection(kolab.db.query(`truncate ${t} cascade`))).toMatch(/are never removed/);
  }
  // A ruling written as an agent, by anyone, is refused by the database too; and every new one is dated and says what it does.
  expect(await rejection(sys(`insert into ruling(id, version_id, actor_id, text, effect) select 'x', id, 'alice-pm', 't', 'keep_intent' from version limit 1`)))
    .toMatch(/alice-pm is not a person; only a person rules/);
  expect(await rejection(sys(`insert into ruling(id, version_id, actor_id, text, effect, ruled_at) select 'y', id, 'alice', 't', 'keep_intent', null from version limit 1`)))
    .toMatch(/ruling_dated/);
  expect(await rejection(sys(`insert into ruling(id, version_id, actor_id, text) select 'z', id, 'alice', 't' from version limit 1`)))
    .toMatch(/ruling_has_effect/);
});
