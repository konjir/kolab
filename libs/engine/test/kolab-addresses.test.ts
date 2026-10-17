// Addresses carry the kolab (W1.4; DAT11, ADR3, D8, TEN12): kj:<kolab>/<node> resolves from
// anywhere its reader can read, kj:<node> inside its kolab, and a node's name is unique within its
// kolab only. Links, variants and questions stay inside one kolab until the binding decides how
// they cross (LNK8, KON).
import { expect, test } from '@jest/globals';
import { structuralReviewer, type Kolab } from '@konjir/engine';
import type { Resolution, ReviewContext } from '@konjir/types';
import { els, openKolab, rejection } from '@konjir/engine/testing';

const text = (r: Resolution) => (r.status === 'orphan' ? r.status : r.content);
/** An id Kolab generates when another kolab's node holds the name as its id already. */
const GENERATED = /^~[0-9A-Z]{26}$/;

/** alice owns the kolab `orders` and bob `billing`, and each has a spec called `checkout` in it. */
async function twoCheckouts(opts: Parameters<typeof openKolab>[0] = {}) {
  const kolab = await openKolab(opts);
  await kolab.addActor('alice');
  await kolab.addActor('bob');
  await kolab.createKolab('orders', { owner: 'alice' });
  await kolab.createKolab('billing', { owner: 'bob' });
  const alice = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'product');
  const mine = await kolab.createNode(alice, 'functional_spec', 'Checkout', 'checkout');
  const theirs = await kolab.createNode(bob, 'functional_spec', 'Checkout', 'checkout');
  await kolab.commit(alice, mine, { elements: els({ R1: 'Orders ship within a day.' }) });
  await kolab.commit(bob, theirs, { elements: els({ R1: 'Invoices are sent monthly.' }) });
  return { kolab, alice, bob, mine, theirs };
}

test('a node name is unique within its kolab: two kolabs may each have one, and neither learns of the other', async () => {
  const { kolab, alice, bob, mine, theirs } = await twoCheckouts();
  // The first keeps its name as its id; the second, whose name another kolab's node holds as its id, gets one generated.
  expect(mine).toBe('checkout');
  expect(theirs).toMatch(GENERATED);

  // Each session's short form is its own kolab's node; the full form names the kolab and resolves from anywhere.
  expect(text(await kolab.resolve('kj:checkout#R1', { session: alice }))).toBe('Orders ship within a day.');
  expect(text(await kolab.resolve('kj:checkout#R1', { session: bob }))).toBe('Invoices are sent monthly.');
  expect(text(await kolab.resolve('kj:orders/checkout#R1', { system: 'billing' }))).toBe('Orders ship within a day.');
  expect(text(await kolab.resolve('kj:billing/checkout@1#R1', { system: 'orders' }))).toBe('Invoices are sent monthly.');
  expect(text(await kolab.resolve('kj:billing/checkout#R1', { session: bob }))).toBe('Invoices are sent monthly.');
  expect(text(await kolab.resolve('kj:checkout#R1', { system: 'billing' }))).toBe('Invoices are sent monthly.');

  // Within one kolab a name is taken once, and the refusal names only that kolab.
  expect(await rejection(kolab.createNode(bob, 'functional_spec', 'Again', 'checkout'))).toBe('GateError: the node name checkout is taken in kolab billing; choose another');
  expect(await rejection(kolab.createNode(bob, 'functional_spec', 'Bad', 'a/b'))).toMatch(/GateError: "a\/b" isn't a valid node name: it may not contain '\/', '@', '#', '~' or whitespace/);
  expect(await rejection(kolab.createNode(bob, 'functional_spec', 'Bad', 'a b'))).toMatch(/isn't a valid node name/);

  // Listing gives each node's name, which every verb takes.
  expect((await kolab.listNodes(undefined, 'billing')).map((n) => [n.id, n.name, n.kolab])).toStrictEqual([[theirs, 'checkout', 'billing']]);
  expect((await kolab.nodeIn(bob, 'checkout')).id).toBe(theirs);
  expect((await kolab.nodeIn(bob, 'billing/checkout')).id).toBe(theirs);
  expect((await kolab.nodeIn(bob, 'kj:billing/checkout')).id).toBe(theirs);

  // A third kolab, and two more at once, all called checkout: each gets one.
  await kolab.addActor('carol');
  await kolab.addActor('dave');
  await kolab.createKolab('shop', { owner: 'carol' });
  await kolab.createKolab('store', { owner: 'dave' });
  const carol = await kolab.openSession('carol', 'product');
  const dave = await kolab.openSession('dave', 'product');
  const made = await Promise.all([carol, dave].map((s) => kolab.createNode(s, 'functional_spec', 'Checkout', 'checkout')));
  expect(made.every((id) => GENERATED.test(id)) && made[0] !== made[1]).toBe(true);
});

test('the database holds a node to one name in its kolab, and its id to that name', async () => {
  const { kolab, theirs } = await twoCheckouts();
  const insert = (id: string, name: string, kolabId: string) => kolab.db.query(
    `insert into node(id, name, kind, layer, title, kolab_id) values ($1, $2, 'functional_spec', 'functional', 'X', $3)`, [id, name, kolabId]);
  expect(await rejection(insert('~01JAAAAAAAAAAAAAAAAAAAAAAA', 'checkout', 'orders'))).toMatch(/node_kolab_name_key/);
  expect(await rejection(insert('shipping', 'returns', 'orders'))).toMatch(/node_id_name_check/);
  expect(await rejection(insert('orders/returns', 'returns', 'orders'))).toMatch(/node_id_name_check/);
  expect(await rejection(insert('~not-a-ulid', 'returns', 'orders'))).toMatch(/node_id_name_check/);
  expect(await rejection(insert('a/b', 'a/b', 'orders'))).toMatch(/node_name_check/);
  await insert('~01JBBBBBBBBBBBBBBBBBBBBBBB', 'returns', 'orders');   // a generated id
  expect(await rejection(kolab.db.query(`update node set name = 'refunds' where id = 'checkout'`))).toMatch(/a node's id and name never change once written/);
  expect(await rejection(kolab.db.query(`update node set id = '~01JCCCCCCCCCCCCCCCCCCCCCCC' where id = $1`, [theirs]))).toMatch(/never change once written/);
  expect(await rejection(kolab.db.query(`insert into node(id, kind, layer, title, kolab_id) values ('nameless', 'functional_spec', 'functional', 'X', 'orders')`))).toMatch(/"name"/);
});

test('the full form resolves wherever its reader holds Read, and elsewhere is no node at all (TEN12)', async () => {
  const { kolab, alice } = await twoCheckouts();
  // Without access to billing, its node reads exactly as a node or kolab that isn't there.
  expect(await rejection(kolab.resolve('kj:billing/checkout#R1', { session: alice }))).toBe('Error: no node checkout in kolab billing');
  expect(await rejection(kolab.resolve('kj:billing/missing#R1', { session: alice }))).toBe('Error: no node missing in kolab billing');
  expect(await rejection(kolab.resolve('kj:nowhere/checkout#R1', { session: alice }))).toBe('Error: no node checkout in kolab nowhere');
  expect(await rejection(kolab.locateNode({ session: alice }, 'billing/checkout'))).toBe('Error: no node checkout in kolab billing');

  // With Read on billing, it resolves from alice's kolab; her own short form is still her own.
  await kolab.grant('billing', 'alice', 'read');
  expect(text(await kolab.resolve('kj:billing/checkout#R1', { session: alice }))).toBe('Invoices are sent monthly.');
  expect(text(await kolab.resolve('kj:checkout#R1', { session: alice }))).toBe('Orders ship within a day.');
  expect((await kolab.locateNode({ session: alice }, 'billing/checkout')).name).toBe('checkout');

  // An agent reads by its own grant, never more than its owner's (D30).
  await kolab.addActor('alice-pm', { owner: 'alice' });
  await kolab.grant('orders', 'alice-pm', 'write');
  const pm = await kolab.openSession('alice-pm', 'product', { kolab: 'orders' });
  expect(await rejection(kolab.resolve('kj:billing/checkout#R1', { session: pm }))).toBe('Error: no node checkout in kolab billing');
  await kolab.grant('billing', 'alice-pm', 'read');
  expect(text(await kolab.resolve('kj:billing/checkout#R1', { session: pm }))).toBe('Invoices are sent monthly.');
  // Its owner's Read goes, and so does its own, at once; its session in orders stays open.
  await kolab.revoke('billing', 'alice');
  expect(await rejection(kolab.resolve('kj:billing/checkout#R1', { session: pm }))).toBe('Error: no node checkout in kolab billing');
  expect(await kolab.sessionOpen(pm)).toBe(true);

  // A public kolab: any person reads it; an agent still needs a grant of its own.
  await kolab.createKolab('docs', { owner: 'bob', visibility: 'public' });
  await kolab.addActor('erin');
  await kolab.grant('docs', 'erin', 'write');
  const erin = await kolab.openSession('erin', 'product', { kolab: 'docs' });
  await kolab.createNode(erin, 'functional_spec', 'Guide', 'guide');
  await kolab.commit(erin, 'guide', { elements: els({ G1: 'Read the guide first.' }) });
  expect(text(await kolab.resolve('kj:docs/guide#G1', { session: alice }))).toBe('Read the guide first.');
  expect(await rejection(kolab.resolve('kj:docs/guide#G1', { session: pm }))).toBe('Error: no node guide in kolab docs');
});

test('a link, a variant or a question across kolabs is refused, by the address alone, until the binding decides them (LNK8)', async () => {
  const { kolab, alice, theirs } = await twoCheckouts();
  await kolab.grant('billing', 'alice', 'read');
  const cross = /AccessError: billing\/checkout is in kolab billing, and this session works in kolab orders: (\w[\w ()]*) across kolabs isn't supported yet/;
  expect(await rejection(kolab.versionIn(alice, 'kj:billing/checkout#R1', { what: 'linking' }))).toMatch(cross);
  expect(await rejection(kolab.versionIn(alice, 'kj:billing/checkout@1', { what: 'a variant (a fork)' }))).toMatch(/a variant \(a fork\) across kolabs isn't supported yet/);
  expect(await rejection(kolab.raiseQuery(alice, 'kj:billing/checkout#R1', 'Why monthly?'))).toMatch(/asking across kolabs isn't supported yet/);
  // The same whether or not there is anything there, and whether or not alice can read it.
  expect(await rejection(kolab.versionIn(alice, 'kj:billing/nothing', { what: 'linking' }))).toMatch(/billing\/nothing is in kolab billing, and this session works in kolab orders/);
  expect(await rejection(kolab.versionIn(alice, 'kj:shop/checkout', { what: 'linking' }))).toMatch(/shop\/checkout is in kolab shop/);
  // The engine refuses a link between versions of two kolabs, and a variant of another kolab's version, too.
  const spec = await kolab.createNode(alice, 'functional_spec', 'EU', 'eu');
  const draft = await kolab.draft(alice, spec, { elements: els({ E1: 'EU orders ship within two days.' }) });
  const target = (await kolab.latestCommitted(theirs))!.id;
  expect(await rejection(kolab.link(alice, { kind: 'dependency', source: draft, sourceElement: 'E1', target, targetElement: 'R1' })))
    .toMatch(/AccessError: the link target is not in kolab orders/);
  expect(await rejection(kolab.draft(alice, spec, { parent: target, deltas: [{ kind: 'override', element: 'R1', text: 'x' }] })))
    .toMatch(/AccessError: parent .* is not in kolab orders/);

  // Its own kolab's full form is fine everywhere a short one is.
  expect((await kolab.versionIn(alice, 'kj:orders/checkout', { what: 'linking' })).node_id).toBe('checkout');
  await kolab.raiseQuery(alice, 'kj:orders/checkout#R1', 'Why a day?');
  expect((await kolab.listQueries({ kolab: 'orders' })).map((q) => q.address)).toStrictEqual(['kj:checkout@1#R1']);
});

test('every address and message Kolab gives names a node by its name, never its id', async () => {
  const seen: ReviewContext[] = [];
  const { kolab, bob, theirs } = await twoCheckouts({ reviewer: (ctx) => { seen.push(ctx); return structuralReviewer(ctx); } });
  // An engineer in each kolab, and a binding called impl in each: billing's gets a generated id.
  for (const [actor, k] of [['eve', 'orders'], ['dan', 'billing']] as const) {
    await kolab.addActor(actor);
    await kolab.grant(k, actor, 'write');
  }
  const eve = await kolab.openSession('eve', 'engineer', { kolab: 'orders' });
  const dan = await kolab.openSession('dan', 'engineer', { kolab: 'billing' });
  expect(await kolab.createNode(eve, 'technical_binding', 'Impl', 'impl')).toBe('impl');
  const impl = await kolab.createNode(dan, 'technical_binding', 'Impl', 'impl');
  expect(impl).toMatch(GENERATED);

  const v1 = await kolab.draft(dan, impl, { elements: els({ b1: 'A job sends invoices on the first of the month.' }) });
  await kolab.link(dan, { kind: 'dependency', source: v1, sourceElement: 'b1', target: (await kolab.latestCommitted(theirs))!.id, targetElement: 'R1' });
  expect((await kolab.review(v1)).ok).toBe(true);
  const q = await kolab.raiseQuery(dan, 'kj:checkout#R1', 'Which day of the month?', { from: 'kj:impl#b1' });
  await kolab.answerQuery(bob, q, 'The first.');
  await kolab.commit(bob, theirs, { elements: els({ R1: 'Invoices are sent weekly.' }) });

  const said = {
    marks: await kolab.describeMarks({ kolab: 'billing' }),
    queries: await kolab.listQueries({ kolab: 'billing' }),
    upstream: await kolab.lineage((await kolab.latestCommitted(impl))!.id, 'upstream'),
    downstream: await kolab.lineage((await kolab.latestCommitted(theirs))!.id, 'downstream'),
    review: seen.filter((c) => c.node.id === impl).map((c) => ({ node: c.node.name, upstream: c.upstream })),
  };
  expect(said.marks.map((m) => [m.reason, m.dirty, m.because])).toStrictEqual([
    ['query_answered', 'kj:impl@1#b1', 'kj:checkout#R1: you asked "Which day of the month?"; answered: "The first."'],
    ['changed', 'kj:impl@1#b1', 'kj:checkout#R1 changed in version 2'],
  ]);
  expect(said.queries.map((x) => [x.address, x.from])).toStrictEqual([['kj:checkout@1#R1', 'kj:impl@1#b1']]);
  expect(said.upstream.map((e) => [e.source, e.target])).toStrictEqual([['kj:impl@1#b1', 'kj:checkout@1#R1']]);
  expect(said.downstream.map((e) => [e.source, e.target])).toStrictEqual([['kj:impl@1#b1', 'kj:checkout@1#R1']]);
  expect(said.review).toStrictEqual([{ node: 'impl', upstream: [{ element: 'b1', target: 'kj:checkout@1#R1', text: 'Invoices are sent monthly.' }] }]);
  expect(JSON.stringify(said)).not.toContain(impl);
  expect(JSON.stringify(said)).not.toContain(theirs);

  // A variant loop names the nodes by name too.
  const eu = await kolab.createNode(bob, 'functional_spec', 'EU', 'eu');
  await kolab.commit(bob, eu, { parent: (await kolab.latestCommitted(theirs))!.id, deltas: [{ kind: 'override', element: 'R1', text: 'EU invoices are sent weekly, in euros.' }] });
  expect(await rejection(kolab.draft(bob, theirs, { parent: (await kolab.latestCommitted(eu))!.id, deltas: [] })))
    .toBe('GateError: checkout would inherit from itself through eu -> checkout');
});

test("a session works on its own kolab's nodes by name, and is told plainly when it names another kolab's", async () => {
  const { kolab, alice }: { kolab: Kolab; alice: string } = await twoCheckouts();
  expect(await rejection(kolab.nodeIn(alice, 'billing/checkout', 'drafting'))).toBe('AccessError: billing/checkout is in kolab billing, and this session works in kolab orders: drafting across kolabs isn\'t supported yet');
  expect(await rejection(kolab.nodeIn(alice, 'missing'))).toBe('Error: no node missing in kolab orders');
  expect(await rejection(kolab.nodeIn(alice, 'checkout@2'))).toMatch(/names a version, element or span; name the node alone/);
});

/** Runs `sql` as kj_agent in `session`, as Kolab runs a session's reads, so row-level security applies. */
const asAgent = <T extends Record<string, unknown>>(kolab: Kolab, session: string, sql: string, params: unknown[] = []) =>
  kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [session]);
    return (await tx.query<T>(sql, params)).rows;
  });

test("row-level security lets a session read another kolab only where it holds Read, and only its nodes and committed versions", async () => {
  const { kolab, alice, bob, theirs } = await twoCheckouts();
  // bob's kolab holds a link, a mark-free draft and a rejected version too.
  const draft = await kolab.draft(bob, theirs, { elements: els({ R1: 'Invoices are sent daily.' }) });
  const kolabs = async (session: string, table: string, where = 'true') =>
    (await asAgent<{ kolab_id: string }>(kolab, session, `select distinct kolab_id from ${table} where ${where} order by kolab_id`)).map((r) => r.kolab_id);

  // A read that skips Kolab's own check still sees nothing of billing without Read there.
  for (const t of ['node', 'version', 'element', 'query', 'delta', 'edge', 'invalidation']) expect([t, await kolabs(alice, t)]).toStrictEqual([t, t === 'edge' || t === 'invalidation' || t === 'query' ? [] : ['orders']]);
  expect(await asAgent(kolab, alice, `select kj_session_readable_kolabs() as k`)).toStrictEqual([{ k: ['orders'] }]);

  // With Read: billing's nodes, its committed versions and their elements, never its draft, deltas or links.
  await kolab.grant('billing', 'alice', 'read');
  expect(await asAgent(kolab, alice, `select kj_session_readable_kolabs() as k`)).toStrictEqual([{ k: ['billing', 'orders'] }]);
  expect(await kolabs(alice, 'node')).toStrictEqual(['billing', 'orders']);
  expect((await asAgent<{ id: string; state: string }>(kolab, alice, `select id, state from version where kolab_id = 'billing'`)).map((v) => v.state)).toStrictEqual(['committed']);
  expect(await asAgent(kolab, alice, `select 1 from version where id = $1`, [draft])).toStrictEqual([]);
  expect(await asAgent(kolab, alice, `select 1 from element where version_id = $1`, [draft])).toStrictEqual([]);
  expect(await kolabs(alice, 'element')).toStrictEqual(['billing', 'orders']);
  expect(await kolabs(alice, 'delta')).toStrictEqual(['orders']);
  // bob still sees his own draft.
  expect(await asAgent(kolab, bob, `select state from version where id = $1`, [draft])).toStrictEqual([{ state: 'drafted' }]);
  // Read lets alice write nothing there.
  expect(await rejection(asAgent(kolab, alice,
    `insert into element(version_id, element_id, ord, text, fingerprint) select id, 'X', 9, 'x', 'x' from version where kolab_id = 'billing' limit 1`))).toMatch(/row-level security/);

  // An agent reads by its own grant, cut down to its owner's.
  await kolab.addActor('alice-pm', { owner: 'alice' });
  await kolab.grant('orders', 'alice-pm', 'write');
  const pm = await kolab.openSession('alice-pm', 'product', { kolab: 'orders' });
  expect(await kolabs(pm, 'node')).toStrictEqual(['orders']);
  await kolab.grant('billing', 'alice-pm', 'read');
  expect(await kolabs(pm, 'node')).toStrictEqual(['billing', 'orders']);
  await kolab.revoke('billing', 'alice');
  expect(await kolabs(pm, 'node')).toStrictEqual(['orders']);
  expect(await kolabs(alice, 'node')).toStrictEqual(['orders']);
});

test('another kolab\'s drafts and rejected versions are as if they weren\'t there, even pinned', async () => {
  const { kolab, alice, bob, theirs } = await twoCheckouts();
  await kolab.grant('billing', 'alice', 'read');
  const draft = await kolab.draft(bob, theirs, { elements: els({ R1: 'Invoices are sent daily.' }) });
  expect((await kolab.version(draft)).seq).toBe(2);
  expect((await kolab.resolve('kj:billing/checkout@2#R1', { session: alice })).status).toBe('orphan');
  expect((await kolab.resolve('kj:billing/checkout@3#R1', { session: alice })).status).toBe('orphan');
  expect(await rejection(kolab.readNode(alice, 'billing/checkout', 2))).toBe('Error: billing/checkout has no version 2');
  expect(await rejection(kolab.readNode(alice, 'billing/checkout', 3))).toBe('Error: billing/checkout has no version 3');
  // Its own kolab reads its drafts as before.
  expect(text(await kolab.resolve('kj:checkout@2#R1', { session: bob }))).toBe('Invoices are sent daily.');
  expect((await kolab.readNode(bob, 'checkout', 2)).version.state).toBe('drafted');
  expect((await kolab.readNode(alice, 'billing/checkout')).elements.map((e) => e.text)).toStrictEqual(['Invoices are sent monthly.']);
});
