// Removing links (D50; LNK6, CAS3, D48): a link's owner removes it in a draft of its node, so the
// version that commits doesn't carry it forward, and its open mark settles, with what that mark
// alone caused. The removal is part of the version: reviewed with it (W1.6), folded with it
// (CAS7), carried through an interrupted cascade once (W1.8), and bounded by row-level security
// and the session's kolab (W1.3). Rulings applied through the admin token can drop links too (D47).
import { expect, test } from '@jest/globals';
import { Kolab, RoleError, sessionKey, structuralChecks } from '@konjir/engine';
import {
  TEST_KOLAB, els, marksOn, openKolab, people, persistentStore, rejection, setup, type Store,
} from '@konjir/engine/testing';
import type { CheckContext, Checks, KolabEvent } from '@konjir/types';

type Ctx = Awaited<ReturnType<typeof setup>>;

/** The links of a node's live version, as `source element -> target node#element`. */
async function linksOf(kolab: Kolab, node: string) {
  const live = (await kolab.latestCommitted(node))!;
  return (await kolab.db.query<{ l: string }>(
    `select e.source_element_id || ' -> ' || t.node_id || '#' || coalesce(e.target_element_id, '*') as l
       from edge e join version t on t.id = e.target_version_id where e.source_version_id = $1 order by 1`, [live.id])).rows.map((r) => r.l);
}

const markRow = async (kolab: Kolab, id: string) =>
  (await kolab.db.query<{ state: string; cleared_by: string | null }>(`select state, cleared_by from invalidation where id = $1`, [id])).rows[0];

/**
 * Spec `spec` (R1, R2, R3), binding `b` (b1 -> R1, b2 -> R2, b3 -> R3), and WBS `w` (w1 -> b1),
 * so a mark on b1 spreads to w1.
 */
async function family(ctx: Ctx) {
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'functional_spec', 'Spec', 'spec');
  const s1 = await kolab.commit(product, 'spec', { elements: els({ R1: 'Carts expire after 30 days.', R2: 'Carts hold 50 items.', R3: 'Checkout takes one page.' }) });
  await kolab.createNode(engineer, 'technical_binding', 'Binding', 'b');
  const b1 = await kolab.commit(engineer, 'b', { elements: els({ b1: 'A nightly job expires carts.', b2: 'A check caps carts.', b3: 'One React page.' }) });
  for (const [el, r] of [['b1', 'R1'], ['b2', 'R2'], ['b3', 'R3']]) {
    await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: el, target: s1, targetElement: r });
  }
  await kolab.createNode(engineer, 'wbs', 'WBS', 'w');
  const w1 = await kolab.commit(engineer, 'w', { elements: els({ w1: 'Write the expiry job.' }) });
  await kolab.link(engineer, { kind: 'derivation', source: w1, sourceElement: 'w1', target: b1, targetElement: 'b1' });
  return { s1, b1, w1 };
}

test('a link removed in a draft stays until the draft commits, then is carried no further, and nothing marks it again', async () => {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await family(ctx);
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b2', text: 'No cap on carts.' }], unlink: [{ sourceElement: 'b2', target: 'kj:spec#R2' }] });
  // The draft shows what it drops, for its reviewers; the live version still has the link.
  expect(await kolab.removedLinks({ session: engineer }, await kolab.version(draft)))
    .toStrictEqual([{ kind: 'dependency', source: 'kj:b@2#b2', target: 'kj:spec#R2' }]);
  expect((await kolab.readNode(engineer, 'b', 2)).removes).toStrictEqual([{ kind: 'dependency', source: 'kj:b@2#b2', target: 'kj:spec#R2' }]);
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b1 -> spec#R1', 'b2 -> spec#R2', 'b3 -> spec#R3']);

  expect(await kolab.review(draft)).toMatchObject({ ok: true });
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b1 -> spec#R1', 'b3 -> spec#R3']);
  expect((await kolab.lineage(draft, 'upstream')).map((l) => l.target)).toStrictEqual(['kj:spec@1#R1', 'kj:spec@1#R3']);
  // Changing what it pointed at marks nothing now.
  await kolab.commit(product, 'spec', { elements: els({ R1: 'Carts expire after 30 days.', R2: 'Carts hold 80 items.', R3: 'Checkout takes one page.' }) });
  expect(await marksOn(kolab, 'b')).toStrictEqual([]);
  // A later version doesn't bring it back either.
  await kolab.commit(engineer, 'b', { deltas: [{ kind: 'override', element: 'b3', text: 'One Vue page.' }] });
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b1 -> spec#R1', 'b3 -> spec#R3']);
});

test('removing an orphaned link settles its mark and what it alone caused (LNK6, D48)', async () => {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await family(ctx);
  await kolab.commit(product, 'spec', { elements: els({ R2: 'Carts hold 50 items.', R3: 'Checkout takes one page.' }) });
  const [orphan] = await marksOn(kolab, 'b');
  expect(orphan).toMatchObject({ reason: 'orphaned', element_id: 'b1' });
  const [downstream] = await marksOn(kolab, 'w');
  expect(downstream).toMatchObject({ reason: 'upstream_dirty', element_id: 'w1' });
  // The link can't re-pin, so clearing is refused, and revising b1 leaves the mark (D48).
  expect(await rejection(kolab.clear(engineer, orphan.id))).toMatch(/GateError: the target no longer exists/);
  await kolab.commit(engineer, 'b', { deltas: [{ kind: 'override', element: 'b1', text: 'A weekly job expires carts.' }] });
  expect((await markRow(kolab, orphan.id)).state).toBe('open');
  // list_stale names the link, so the owner can remove it by its id.
  const listed = (await kolab.describeMarks({ node: 'b' }))[0];
  expect(listed).toMatchObject({ mark: orphan.id, reason: 'orphaned', link: expect.any(String) });
  expect(listed.next).toMatch(/konjir_unlink/);

  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b3', text: 'One Vue page.' }] });
  expect(await kolab.unlink(engineer, draft, [{ link: listed.link! }])).toStrictEqual([{ kind: 'dependency', source: 'kj:b@3#b1', target: 'kj:spec#R1' }]);
  expect((await markRow(kolab, orphan.id)).state).toBe('open');   // not until it commits
  const events: KolabEvent[] = [];
  kolab.onEvent((x) => events.push(x));
  await kolab.review(draft);
  // The settled marks signal their layer's inbox in their own kolab only.
  expect(events).toContainEqual({ inbox: 'layer', kolab: TEST_KOLAB, layer: 'technical' });
  expect(events.filter((x) => 'inbox' in x && x.inbox === 'layer' && x.kolab !== TEST_KOLAB)).toStrictEqual([]);
  expect(await markRow(kolab, orphan.id)).toStrictEqual({ state: 'cleared', cleared_by: 'its link was removed by b@3' });
  expect(await marksOn(kolab, 'b')).toStrictEqual([]);
  // w1 keeps only the mark b1's own revision raised: the one the orphan caused is gone.
  expect((await marksOn(kolab, 'w')).map((m) => [m.element_id, m.reason])).toStrictEqual([['w1', 'changed']]);
  expect((await markRow(kolab, downstream.id)).state).toBe('cleared');
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b2 -> spec#R2', 'b3 -> spec#R3']);
});

test('re-pointing: one draft removes the orphaned link and links the replacement', async () => {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await family(ctx);
  const s2 = await kolab.commit(product, 'spec', { elements: els({ R1b: 'Carts expire after 30 days of no activity.', R2: 'Carts hold 50 items.', R3: 'Checkout takes one page.' }) });
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b1', text: 'A nightly job expires idle carts.' }], unlink: [{ sourceElement: 'b1', target: 'kj:spec#R1' }] });
  await kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b1', target: s2, targetElement: 'R1b' });
  await kolab.review(draft);
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b1 -> spec#R1b', 'b2 -> spec#R2', 'b3 -> spec#R3']);
  // Only w1's mark is open: b1, which it derives from, was revised.
  expect((await kolab.openMarks()).map((m) => [m.element_id, m.reason])).toStrictEqual([['w1', 'changed']]);
});

test("a link the draft declared goes at once; linking a removed link again takes the removal back", async () => {
  const ctx = await setup();
  const { kolab, engineer } = ctx;
  const { s1 } = await family(ctx);
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'add', element: 'b4', text: 'A page for the cart.' }] });
  await kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b4', target: s1, targetElement: 'R2' });
  await kolab.unlink(engineer, draft, [{ sourceElement: 'b4', target: 'kj:spec@1#R2' }]);
  expect((await kolab.lineage(draft, 'upstream')).map((l) => l.source)).toStrictEqual([]);
  expect(await kolab.removedLinks({ session: engineer }, await kolab.version(draft))).toStrictEqual([]);

  await kolab.unlink(engineer, draft, [{ sourceElement: 'b3', target: 'kj:spec#R3' }]);
  await kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b3', target: s1, targetElement: 'R3' });
  expect(await kolab.removedLinks({ session: engineer }, await kolab.version(draft))).toStrictEqual([]);
  await kolab.review(draft);
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b1 -> spec#R1', 'b2 -> spec#R2', 'b3 -> spec#R3']);
});

test('only the draft\'s author removes links, only in a draft, only links it has', async () => {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await family(ctx);
  await people(kolab, 'erin', { layers: ['technical'] });
  const erin = await kolab.openSession('erin', 'engineer');
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b3', text: 'One Vue page.' }] });

  expect(await rejection(kolab.unlink(engineer, draft, [{ sourceElement: 'b3', target: 'kj:spec#R1' }])))
    .toMatch(/^Error: b@1 has no link from b3 to kj:spec#R1, and neither has this draft/);
  expect(await rejection(kolab.unlink(engineer, draft, [{ link: 'no-such-link' }]))).toMatch(/^Error: b has no link no-such-link/);
  expect(await rejection(kolab.unlink(engineer, draft, [{ sourceElement: 'b3', target: 'kj:other/spec#R3' }])))
    .toBe('Error: b@1 has no link from b3 to kj:other/spec#R3, and neither has this draft: konjir_lineage direction=upstream lists its links');   // a link into another kolab is removed as any other (LNK8), and this one isn't there
  await expect(kolab.unlink(product, draft, [{ sourceElement: 'b3', target: 'kj:spec#R3' }])).rejects.toBeInstanceOf(RoleError);
  expect(await rejection(kolab.unlink(erin, draft, [{ sourceElement: 'b3', target: 'kj:spec#R3' }])))
    .toMatch(/RoleError: b@2 is bob's draft: only its author changes it/);
  // In review, it is the version its reviewers judge: no more removals.
  expect(await kolab.review(draft)).toMatchObject({ in_review: true, reviewers: ['erin'] });
  expect(await rejection(kolab.unlink(engineer, draft, [{ sourceElement: 'b3', target: 'kj:spec#R3' }])))
    .toMatch(/GateError: b@2 is in_review: links are removed in a draft/);
  const live = (await kolab.latestCommitted('b'))!.id;
  expect(await rejection(kolab.unlink(engineer, live, [{ sourceElement: 'b3', target: 'kj:spec#R3' }]))).toMatch(/GateError: b@1 is committed/);

  // Another kolab's draft reads as no node at all.
  await kolab.createKolab('other', { owner: 'test-org' });
  await kolab.grant('other', 'bob', 'write', { layers: ['technical'] });
  await kolab.grant('other', 'alice', 'write', { layers: ['functional'] });
  await kolab.endSession(engineer);
  const there = await kolab.openSession('bob', 'engineer', { kolab: 'other' });
  await kolab.createNode(there, 'technical_binding', 'Other', 'ob');
  const elsewhere = await kolab.draft(there, 'ob', { elements: els({ o1: 'Something.' }) });
  expect(await rejection(kolab.unlink(erin, elsewhere, [{ sourceElement: 'o1', target: 'kj:spec#R3' }]))).toBe('Error: no node ob in kolab test');
});

test('row-level security: an agent records removals, and deletes links, only in a draft of its own, in its layer and kolab', async () => {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  const { b1, s1 } = await family(ctx);
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b3', text: 'One Vue page.' }] });
  const own = await kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b3', target: s1, targetElement: 'R1' });
  const asAgent = (session: string, sql: string, params: unknown[]) => kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(session)]);
    return tx.query(sql, params);
  });
  const remove = (session: string, version: string, id: string) => asAgent(session,
    `insert into link_removal(id, version_id, kind, source_element_id, target_node_id, target_element_id) values ($1, $2, 'dependency', 'b1', 'spec', 'R1')`, [id, version]);
  // Not on a committed version, and not as the other layer.
  expect(await rejection(remove(engineer, b1, 'r1'))).toMatch(/row-level security/);
  expect(await rejection(remove(product, draft, 'r2'))).toMatch(/row-level security/);
  await remove(engineer, draft, 'r3');
  // Deleting links: the committed version's are out of reach, its own draft's aren't.
  const committedLink = (await kolab.db.query<{ id: string }>(`select id from edge where source_version_id = $1 limit 1`, [b1])).rows[0].id;
  const del = async (session: string, id: string) => (await asAgent(session, `delete from edge where id = $1 returning id`, [id])).rows.length;
  expect(await del(engineer, committedLink)).toBe(0);
  expect(await del(product, own)).toBe(0);
  expect(await del(engineer, own)).toBe(1);
  expect((await kolab.db.query(`select 1 from edge where id = $1`, [committedLink])).rows).toHaveLength(1);
  // A removal's kolab is its draft's, whatever its writer said.
  expect((await kolab.db.query(`select kolab_id from link_removal where id = 'r3'`)).rows).toStrictEqual([{ kolab_id: TEST_KOLAB }]);
});

test('a removal is reviewed with its version: nothing changes until an approval commits it', async () => {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await family(ctx);
  await people(kolab, 'erin', { layers: ['technical'] });
  const erin = await kolab.openSession('erin', 'engineer');
  await kolab.commit(product, 'spec', { elements: els({ R2: 'Carts hold 50 items.', R3: 'Checkout takes one page.' }) });
  const [orphan] = await marksOn(kolab, 'b');

  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b3', text: 'One Vue page.' }], unlink: [{ sourceElement: 'b1', target: 'kj:spec#R1' }] });
  expect(await kolab.review(draft)).toMatchObject({ in_review: true, reviewers: ['erin'] });
  // Sent back, it changes nothing.
  await kolab.recordReview(erin, draft, { verdict: 'request_changes', note: 'Say why b1 no longer relies on R1.' });
  expect((await markRow(kolab, orphan.id)).state).toBe('open');
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b1 -> spec#R1', 'b2 -> spec#R2', 'b3 -> spec#R3']);
  // Resubmitted and approved, it commits, and the mark settles.
  await kolab.review(draft);
  expect(await kolab.recordReview(erin, draft, { verdict: 'approve' })).toMatchObject({ ok: true });
  expect((await markRow(kolab, orphan.id)).state).toBe('cleared');
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b2 -> spec#R2', 'b3 -> spec#R3']);
  // An abandoned draft's removal changes nothing either.
  const other = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b3', text: 'One Svelte page.' }], unlink: [{ sourceElement: 'b2', target: 'kj:spec#R2' }] });
  await kolab.abandon(engineer, other);
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b2 -> spec#R2', 'b3 -> spec#R3']);
});

test("a draft overtaken by Kolab's rebase is folded with its removals (CAS7)", async () => {
  const ctx = await setup();
  const { kolab, product } = ctx;
  await kolab.createNode(product, 'functional_spec', 'Glossary', 'g');
  const g1 = await kolab.commit(product, 'g', { elements: els({ G1: 'A cart holds items.' }) });
  await kolab.createNode(product, 'functional_spec', 'Parent', 'p');
  const p1 = await kolab.commit(product, 'p', { elements: els({ E1: 'Parent one.', E2: 'Parent two.' }) });
  await kolab.createNode(product, 'functional_spec', 'Variant', 'v');
  const v1 = await kolab.commit(product, 'v', { parent: p1, deltas: [{ kind: 'add', element: 'A', text: 'The variant adds A.' }] });
  await kolab.link(product, { kind: 'dependency', source: v1, sourceElement: 'A', target: g1, targetElement: 'G1' });

  const draft = await kolab.draft(product, 'v', { deltas: [{ kind: 'override', element: 'E2', text: 'V says two.' }], unlink: [{ sourceElement: 'A', target: 'kj:g#G1' }] });
  await kolab.commit(product, 'p', { elements: els({ E1: 'Parent one, revised.', E2: 'Parent two.' }) });   // rebases v: v@3
  const r = await kolab.review(draft);
  expect(r).toMatchObject({ ok: true });
  const fold = await kolab.version(r.version);
  expect(fold.seq).toBe(4);
  expect(await kolab.removedLinks({ system: TEST_KOLAB }, fold)).toStrictEqual([{ kind: 'dependency', source: 'kj:v@4#A', target: 'kj:g#G1' }]);
  expect(await linksOf(kolab, 'v')).toStrictEqual([]);
});

test('a ruling applied through the admin token drops links too (D47)', async () => {
  const ctx = await setup();
  const { kolab, product } = ctx;
  await family(ctx);
  await kolab.commit(product, 'spec', { elements: els({ R2: 'Carts hold 50 items.', R3: 'Checkout takes one page.' }) });
  const [orphan] = await marksOn(kolab, 'b');
  expect(await rejection(kolab.applyRuling('b', { deltas: [], unlink: [{ sourceElement: 'b9', target: 'kj:spec#R1' }] }, { id: 'D50', actor: 'bob' })))
    .toMatch(/b@1 has no link from b9/);
  const r = await kolab.applyRuling('b', { deltas: [{ kind: 'override', element: 'b1', text: 'Carts never expire.' }], unlink: [{ sourceElement: 'b1', target: `kj:${TEST_KOLAB}/spec#R1` }] }, { id: 'D50', actor: 'bob' });
  expect(r).toMatchObject({ ok: true });
  expect(await markRow(kolab, orphan.id)).toStrictEqual({ state: 'cleared', cleared_by: 'its link was removed by b@2' });
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b2 -> spec#R2', 'b3 -> spec#R3']);
});

test('a cascade stopped part way and run again removes the link and settles its mark once (W1.8)', async () => {
  const store: Store = await persistentStore();
  // The cascade of v's commit stops at the rebase of its own variant, vv, after carrying links forward.
  let stop = false;
  let reached!: () => void;
  const stopped = new Promise<void>((res) => { reached = res; });
  const checks: Checks = async (c: CheckContext) => {
    if (!stop || c.node.id !== 'vv') return structuralChecks(c);
    reached();
    return new Promise(() => undefined);
  };
  const a = await openKolab({ ...store, checks, outboxLeaseMs: 1_000, closeWaitMs: 0 });
  await people(a, 'alice', { layers: ['functional'] });
  const product = await a.openSession('alice', 'product');
  await a.createNode(product, 'functional_spec', 'Glossary', 'g');
  const g1 = await a.commit(product, 'g', { elements: els({ G1: 'A cart holds items.', G2: 'An item has a price.' }) });
  await a.createNode(product, 'functional_spec', 'Spec', 'v');
  const v1 = await a.commit(product, 'v', { elements: els({ E1: 'One.', E2: 'Two.' }) });
  await a.link(product, { kind: 'dependency', source: v1, sourceElement: 'E1', target: g1, targetElement: 'G1' });
  await a.link(product, { kind: 'dependency', source: v1, sourceElement: 'E2', target: g1, targetElement: 'G2' });
  await a.createNode(product, 'functional_spec', 'Variant', 'vv');
  await a.commit(product, 'vv', { parent: v1, deltas: [{ kind: 'add', element: 'X', text: 'The variant adds X.' }] });
  await a.commit(product, 'g', { elements: els({ G2: 'An item has a price.' }) });   // orphans v's E1 -> G1
  const [orphan] = await marksOn(a, 'v');
  expect(orphan).toMatchObject({ reason: 'orphaned', element_id: 'E1' });

  stop = true;
  const draft = await a.draft(product, 'v', { deltas: [{ kind: 'override', element: 'E2', text: 'Two, revised.' }], unlink: [{ sourceElement: 'E1', target: 'kj:g#G1' }] });
  void a.review(draft).catch(() => undefined);
  await stopped;
  await a.db.close();

  await new Promise((r) => setTimeout(r, 1_100));
  const b = await openKolab({ ...store, outboxLeaseMs: 1_000 });
  expect(await b.drainOutbox()).toBe(1);
  expect(await linksOf(b, 'v')).toStrictEqual(['E2 -> g#G2']);
  expect(await markRow(b, orphan.id)).toStrictEqual({ state: 'cleared', cleared_by: 'its link was removed by v@2' });
  expect(await b.openMarks()).toStrictEqual([]);
  // Exactly one copy of the surviving link on the live version.
  expect((await b.db.query(`select 1 from edge where source_version_id = $1`, [draft])).rows).toHaveLength(1);
});

/** The M1 demo's quote: b1 relies on the words "7 days" of spec#R1. */
async function quoted(ctx: Ctx) {
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'functional_spec', 'Spec', 'spec');
  const s1 = await kolab.commit(product, 'spec', { elements: els({ R1: 'Carts expire after 7 days of inactivity.', R2: 'Carts hold 50 items.' }) });
  await kolab.createNode(engineer, 'technical_binding', 'Binding', 'b');
  const b1 = await kolab.commit(engineer, 'b', { elements: els({ b1: 'A nightly job expires carts idle for 7 days.', b2: 'A check caps carts.' }) });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1',
    selector: { exact: '7 days', prefix: 'Carts expire after', suffix: 'of inactivity.' } });
  const s2 = await kolab.commit(product, 'spec', { elements: els({ R1: 'Carts expire after 14 days of inactivity.', R2: 'Carts hold 50 items.' }) });
  const [mark] = await marksOn(kolab, 'b');
  return { s2, mark };
}

test('demo finding: quoted words edited in place, context intact, are a change, not an orphan (ADR8)', async () => {
  const ctx = await setup();
  const { mark } = await quoted(ctx);
  expect(mark).toMatchObject({ reason: 'fuzzy_reanchor', element_id: 'b1' });
  expect((await ctx.kolab.describeMarks({ node: 'b' }))[0].next).toMatch(/konjir_link your element to the current words/);
});

test('a committed version is never changed: linking it to the new words adds a link, reviewed nowhere, and the marked one stays (VER1)', async () => {
  const ctx = await setup();
  const { kolab, engineer } = ctx;
  const { s2, mark } = await quoted(ctx);
  const live = (await kolab.latestCommitted('b'))!.id;
  const edge = await kolab.link(engineer, { kind: 'dependency', source: live, sourceElement: 'b1', target: s2, targetElement: 'R1',
    selector: { exact: '14 days', prefix: 'Carts expire after', suffix: 'of inactivity.' } });
  expect(edge).not.toBe(mark.edge_id);
  expect((await markRow(kolab, mark.id)).state).toBe('open');
  expect((await kolab.db.query(`select target_version_id from edge where id = $1`, [mark.edge_id])).rows[0].target_version_id).not.toBe(s2);
});

test('a link targets its node\'s live version, never an older one where an orphaned quote still stands', async () => {
  const ctx = await setup();
  const { kolab, engineer } = ctx;
  await quoted(ctx);
  const s1 = (await kolab.db.query<{ id: string }>(`select id from version where node_id = 'spec' and seq = 1`)).rows[0].id;
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b2', text: 'A check caps carts at 50.' }] });
  expect(await rejection(kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b1', target: s1, targetElement: 'R1',
    selector: { exact: '7 days', prefix: 'Carts expire after', suffix: 'of inactivity.' } }))).toMatch(/GateError: link to spec@2, its live version/);
});

test('demo finding: re-linking in a draft drops the marked link when the draft commits', async () => {
  const ctx = await setup();
  const { kolab, engineer } = ctx;
  const { s2, mark } = await quoted(ctx);
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b1', text: 'A nightly job expires carts idle for 14 days.' }] });
  await kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b1', target: s2, targetElement: 'R1',
    selector: { exact: '14 days', prefix: 'Carts expire after', suffix: 'of inactivity.' } });
  await kolab.review(draft);
  expect((await markRow(kolab, mark.id)).state).toBe('cleared');
  expect(await kolab.lineage(draft, 'upstream')).toMatchObject([{ target: 'kj:spec@2#R1~q({"exact":"14 days","prefix":"Carts expire after","suffix":"of inactivity."})' }]);
  expect(await kolab.openMarks()).toStrictEqual([]);
});

test('demo finding: removing an element drops its links and settles their marks; no mark moves onto an element that is gone', async () => {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await family(ctx);
  await kolab.commit(product, 'spec', { elements: els({ R2: 'Carts hold 50 items.', R3: 'Checkout takes one page.' }) });
  const [orphan] = await marksOn(kolab, 'b');
  const [downstream] = await marksOn(kolab, 'w');
  await kolab.commit(engineer, 'b', { deltas: [{ kind: 'remove', element: 'b1' }] });
  expect(await markRow(kolab, orphan.id)).toStrictEqual({ state: 'cleared', cleared_by: 'its element was removed by b@2' });
  expect((await markRow(kolab, downstream.id)).state).toBe('cleared');
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b2 -> spec#R2', 'b3 -> spec#R3']);
  // Nothing open sits on an element its version doesn't have.
  const stray = await kolab.db.query(
    `select i.id from invalidation i where i.state = 'open' and i.element_id is not null
        and not exists (select 1 from element e where e.version_id = i.version_id and e.element_id = i.element_id)`);
  expect(stray.rows).toStrictEqual([]);
});

test('re-pointing replaces only a marked quote link: a changed whole-element link stays, and so does its mark (review of #35)', async () => {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await family(ctx);
  const s2 = await kolab.commit(product, 'spec', { elements: els({ R1: 'Carts expire after 31 days.', R2: 'Carts hold 50 items.', R3: 'Checkout takes one page.' }) });
  const [changed] = await marksOn(kolab, 'b');
  expect(changed).toMatchObject({ reason: 'changed', element_id: 'b1' });
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b3', text: 'One Vue page.' }] });
  await kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b1', target: s2, targetElement: 'R1',
    selector: { exact: '31 days', prefix: 'Carts expire after', suffix: '.' } });
  expect(await kolab.removedLinks({ session: engineer }, await kolab.version(draft))).toStrictEqual([]);
  await kolab.review(draft);
  expect((await markRow(kolab, changed.id)).state).toBe('open');
  expect(await linksOf(kolab, 'b')).toStrictEqual(['b1 -> spec#R1', 'b1 -> spec#R1', 'b2 -> spec#R2', 'b3 -> spec#R3']);
});

test('of two marked quote links, re-pointing replaces the one whose context the new quote keeps, or asks which', async () => {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'functional_spec', 'Spec', 'spec');
  const s1 = await kolab.commit(product, 'spec', { elements: els({ R1: 'Carts expire after 7 days of inactivity, and hold 50 items at most.' }) });
  await kolab.createNode(engineer, 'technical_binding', 'Binding', 'b');
  const b1 = await kolab.commit(engineer, 'b', { elements: els({ b1: 'A job expires carts; a check caps them.' }) });
  const q1 = { exact: '7 days', prefix: 'Carts expire after', suffix: 'of inactivity, and' };
  const q2 = { exact: '50 items', prefix: 'inactivity, and hold', suffix: 'at most.' };
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1', selector: q1 });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1', selector: q2 });
  const s2 = await kolab.commit(product, 'spec', { elements: els({ R1: 'Carts expire after 14 days of inactivity, and hold 80 items at most.' }) });
  const marks = await marksOn(kolab, 'b');
  expect(marks.map((m) => m.reason)).toStrictEqual(['fuzzy_reanchor', 'fuzzy_reanchor']);
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b1', text: 'A job expires carts after 14 days; a check caps them.' }] });
  await kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b1', target: s2, targetElement: 'R1', selector: { ...q1, exact: '14 days' } });
  expect((await kolab.removedLinks({ session: engineer }, await kolab.version(draft))).map((r) => r.target))
    .toStrictEqual(['kj:spec#R1~q({"exact":"7 days","prefix":"Carts expire after","suffix":"of inactivity, and"})']);
  // A quote whose context matches neither can't say which it replaces.
  expect(await rejection(kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'b1', target: s2, targetElement: 'R1',
    selector: { exact: '80 items', prefix: 'and hold', suffix: 'at most.' } }))).toMatch(/GateError: more than one marked link|name the one this replaces/);
});

test('re-pointing happens only in the author\'s own draft; another writer links from it as before', async () => {
  const ctx = await setup();
  const { kolab, engineer } = ctx;
  const { s2, mark } = await quoted(ctx);
  await people(kolab, 'erin', { layers: ['technical'] });
  const erin = await kolab.openSession('erin', 'engineer');
  const draft = await kolab.draft(engineer, 'b', { deltas: [{ kind: 'override', element: 'b2', text: 'A check caps carts at 50.' }] });
  await kolab.link(erin, { kind: 'dependency', source: draft, sourceElement: 'b1', target: s2, targetElement: 'R1',
    selector: { exact: '14 days', prefix: 'Carts expire after', suffix: 'of inactivity.' } });
  expect(await kolab.removedLinks({ session: engineer }, await kolab.version(draft))).toStrictEqual([]);
  expect((await markRow(kolab, mark.id)).state).toBe('open');
});

test('removing a link settles the transitive marks that reached its element, and those below, only through it (LNK5)', async () => {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  // brief#X <- spec#R1 <- b#b1 <- w#w1, and spec#R2 <- b#b2.
  await kolab.createNode(product, 'functional_spec', 'Brief', 'brief');
  const br1 = await kolab.commit(product, 'brief', { elements: els({ X: 'Carts are kept a while.' }) });
  await kolab.createNode(product, 'functional_spec', 'Spec', 'spec');
  const s1 = await kolab.commit(product, 'spec', { elements: els({ R1: 'Carts expire after 30 days.', R2: 'Carts hold 50 items.' }) });
  await kolab.link(product, { kind: 'dependency', source: s1, sourceElement: 'R1', target: br1, targetElement: 'X' });
  await kolab.createNode(engineer, 'technical_binding', 'Binding', 'b');
  const b1 = await kolab.commit(engineer, 'b', { elements: els({ b1: 'A nightly job expires carts.', b2: 'A check caps carts.' }) });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1' });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b2', target: s1, targetElement: 'R2' });
  await kolab.createNode(engineer, 'wbs', 'WBS', 'w');
  const w1 = await kolab.commit(engineer, 'w', { elements: els({ w1: 'Write the expiry job.' }) });
  await kolab.link(engineer, { kind: 'derivation', source: w1, sourceElement: 'w1', target: b1, targetElement: 'b1' });
  await kolab.commit(product, 'brief', { elements: els({ X: 'Carts are kept a long while.' }) });
  expect((await marksOn(kolab, 'b')).map((m) => [m.element_id, m.reason])).toStrictEqual([['b1', 'upstream_dirty']]);
  expect((await marksOn(kolab, 'w')).map((m) => [m.element_id, m.reason])).toStrictEqual([['w1', 'upstream_dirty']]);

  await kolab.commit(engineer, 'b', { deltas: [{ kind: 'override', element: 'b2', text: 'A check caps carts at 50.' }], unlink: [{ sourceElement: 'b1', target: 'kj:spec#R1' }] });
  expect(await marksOn(kolab, 'b')).toStrictEqual([]);
  expect(await marksOn(kolab, 'w')).toStrictEqual([]);
  // The spec's own mark is its owner's to settle.
  expect((await marksOn(kolab, 'spec')).map((m) => [m.element_id, m.reason])).toStrictEqual([['R1', 'changed']]);
});
