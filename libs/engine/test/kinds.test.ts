// Typed konstruct kinds (W4.1, W5.1d; KON1–KON6, KON8; D77–D79, D104): a kolab holds one spec, each
// binding names its spec and holds its own work (no plan is made), element links point inside that parent, a node's layer
// follows from its kind, and a prototype's screens are marked when the requirement they show
// changes. Kolab refuses each break, saying what to do, and the database refuses it for every role
// (migration 0027).
import { expect, test } from '@jest/globals';
import { sessionKey } from '@konjir/engine';
import { TEST_KOLAB, els, marksOn, people, rejection, setup } from '@konjir/engine/testing';
import { KINDS, LAYER_OF_KIND, PARENT_KIND, PLAN_RETIRED, RETIRED_KINDS } from '@konjir/types';

/** The kolab's spec with two requirements, and a binding of it, committed. */
async function specAndBinding() {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  const s1 = await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.', R2: 'Orders ship in a day.' }) });
  await kolab.createNode(engineer, 'binding', 'Orders on Postgres', 'orders-pg');
  const b1 = await kolab.commit(engineer, 'orders-pg', { elements: els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.' }) });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1' });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b2', target: s1, targetElement: 'R2' });
  return { ...ctx, s1, b1 };
}

/** Runs `sql` as kj_agent in `session`'s session, as row-level security sees it. */
const asAgent = (kolab: Awaited<ReturnType<typeof setup>>['kolab'], session: string, sql: string, params: unknown[] = []) =>
  kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(session)]);
    await tx.query(sql, params);
  });

test('the kinds are four, each in the layer it fixes, and the parent kinds are a binding\'s spec and a plan\'s binding; plan is retired (D77, D78, KON8, D104)', () => {
  expect([...KINDS]).toStrictEqual(['spec', 'prototype', 'binding', 'plan']);
  expect([...RETIRED_KINDS]).toStrictEqual(['plan']);
  expect(LAYER_OF_KIND).toStrictEqual({ spec: 'functional', prototype: 'functional', binding: 'technical', plan: 'technical' });
  expect(PARENT_KIND).toStrictEqual({ binding: 'spec', plan: 'binding' });
});

test('a kolab holds exactly one spec: a second is refused, saying where its variants and prototypes go, and the database refuses it too (KON1, KON9)', async () => {
  const { kolab, product } = await setup();
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  expect(await rejection(kolab.createNode(product, 'spec', 'Billing', 'billing')))
    .toBe('GateError: kolab test already holds its spec, orders, and a kolab holds exactly one (KON1, D77). Write its prototypes as prototype nodes, or a variant of it in another kolab, as a fork (KON9)');
  // As many prototypes as it likes (KON2).
  for (const name of ['web', 'mobile']) await kolab.createNode(product, 'prototype', name, name);
  // For every role: Kolab's own login too.
  expect(await rejection(kolab.db.query(`insert into node(id, name, kind, layer, title, kolab_id, created_by) values ('b2', 'b2', 'spec', 'functional', 'B', $1, 'admin')`, [TEST_KOLAB])))
    .toMatch(/node_one_spec_per_kolab/);
  expect((await kolab.listNodes('spec', TEST_KOLAB)).map((n) => n.name)).toStrictEqual(['orders']);
  // Another kolab holds its own: a variant of this one, as a fork, is that kolab's one spec.
  await kolab.createKolab('eu', { owner: 'test-org' });
  await kolab.grant('eu', 'carol', 'write', { layers: ['functional'] });
  await kolab.grant(TEST_KOLAB, 'carol', 'read');
  const carol = await kolab.openSession('carol', 'product', { kolab: 'eu' });
  const p1 = await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  await kolab.createNode(carol, 'spec', 'Orders in the EU', 'orders-eu');
  await kolab.commit(carol, 'orders-eu', { parent: p1, deltas: [{ kind: 'add', element: 'EU1', text: 'Prices include VAT.' }] });
  expect((await kolab.listNodes('spec', 'eu')).map((n) => n.name)).toStrictEqual(['orders-eu']);
});

test('two specs created at once in one kolab: one is made, and the other is refused as the second', async () => {
  const { kolab, product } = await setup();
  await people(kolab, 'dave', { layers: ['functional'] });
  const dave = await kolab.openSession('dave', 'product');
  const made = await Promise.allSettled([kolab.createNode(product, 'spec', 'A', 'a'), kolab.createNode(dave, 'spec', 'B', 'b')]);
  expect(made.filter((m) => m.status === 'fulfilled')).toHaveLength(1);
  const refused = made.find((m) => m.status === 'rejected') as PromiseRejectedResult;
  expect(String(refused.reason)).toMatch(/^GateError: kolab test already holds its spec, [ab], and a kolab holds exactly one/);
  expect(await kolab.listNodes('spec', TEST_KOLAB)).toHaveLength(1);
});

test('a binding names the spec it binds, its kolab\'s one spec, set when it is made (D78, KON4)', async () => {
  const { kolab, product, engineer } = await setup();
  expect(await rejection(kolab.createNode(engineer, 'binding', 'Too soon', 'early')))
    .toBe('GateError: a binding names the spec it binds (D78), and kolab test holds no spec yet: create its spec first (kind spec)');
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.createNode(product, 'prototype', 'Orders screens', 'orders-ui');
  // Many bindings of the one spec, each naming it, by default or by name.
  await kolab.createNode(engineer, 'binding', 'On Postgres', 'orders-pg');
  await kolab.createNode(engineer, 'binding', 'On DynamoDB', 'orders-ddb', { parent: 'orders' });
  expect((await kolab.listNodes('binding', TEST_KOLAB)).map((n) => [n.name, n.parent])).toStrictEqual([['orders-ddb', 'orders'], ['orders-pg', 'orders']]);
  expect(await rejection(kolab.createNode(engineer, 'binding', 'Of a prototype', 'x', { parent: 'orders-ui' })))
    .toBe('GateError: a binding names the spec it binds, in its own kolab (D78), and orders-ui is no spec of kolab test: its spec is orders');
  expect(await rejection(kolab.createNode(engineer, 'binding', 'Of nothing', 'x', { parent: 'nowhere/orders' })))
    .toMatch(/nowhere\/orders is no spec of kolab test/);
  // A spec and a prototype name none.
  expect(await rejection(kolab.createNode(product, 'prototype', 'Screens', 'y', { parent: 'orders' })))
    .toBe('GateError: a prototype names no parent: a binding names its spec (D78)');
  // The database: a binding with no parent, or one that isn't a spec, or another kolab's.
  const insert = (id: string, kind: string, layer: string, parent: string | null, kolab_ = TEST_KOLAB) => kolab.db.query(
    `insert into node(id, name, kind, layer, title, kolab_id, parent_node_id, created_by) values ($1, $1, $2, $3, 'X', $4, $5, 'admin')`, [id, kind, layer, kolab_, parent]);
  expect(await rejection(insert('b0', 'binding', 'technical', null))).toMatch(/node_parent_given/);
  expect(await rejection(insert('b0', 'binding', 'technical', 'orders-ui'))).toMatch(/a binding names the spec it binds \(D78\), and orders-ui is no spec of its kolab/);
  expect(await rejection(insert('p0', 'prototype', 'functional', 'orders'))).toMatch(/node_parent_given/);
  await kolab.createKolab('other', { owner: 'test-org' });
  expect(await rejection(insert('b0', 'binding', 'technical', 'orders', 'other'))).toMatch(/node_parent_kolab_fkey|no spec of its kolab/);
});

test('a binding holds its own work: no plan is made any more, by Kolab or by any role in the database (KON5, D104)', async () => {
  const { kolab, engineer } = await specAndBinding();
  expect(await rejection(kolab.createNode(engineer, 'plan', 'Plan', 'orders-plan')))
    .toBe(`GateError: ${PLAN_RETIRED}. Draft the work packages in the binding itself`);
  expect(await kolab.listNodes('plan', TEST_KOLAB)).toStrictEqual([]);
  const insert = (id: string, parent: string) => kolab.db.query(
    `insert into node(id, name, kind, layer, title, kolab_id, parent_node_id, created_by) values ($1, $1, 'plan', 'technical', 'X', $2, $3, 'admin')`, [id, TEST_KOLAB, parent]);
  expect(await rejection(insert('plan-3', 'orders-pg'))).toMatch(/node: the plan kind is retired \(D104\)/);
  // Its work packages are its own elements, with a work field.
  await kolab.commit(engineer, 'orders-pg', { elements: [...els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.' }), { id: 'W1', text: 'Build the cancel endpoint.', work: {} }] });
  expect((await kolab.listWork(engineer)).items.map((i) => [i.work, i.binding])).toStrictEqual([['kj:orders-pg#W1', 'orders-pg']]);
});

test('a node\'s layer follows from its kind, and its kind, layer and parent never change (D77, KON8)', async () => {
  const { kolab, product, engineer } = await specAndBinding();
  // The engine fixes the layer from the kind, and the role check follows it.
  expect(await rejection(kolab.createNode(product, 'binding', 'Binding', 'p'))).toMatch(/RoleError/);
  expect(await rejection(kolab.createNode(engineer, 'prototype', 'Screens', 'ui'))).toMatch(/RoleError/);
  // A kind Kolab once took points to what replaces it (D77, D104).
  expect(await rejection(kolab.createNode(engineer, 'wbs' as never, 'Old label', 'w'))).toBe(`GateError: wbs became plan (D77), and ${PLAN_RETIRED}`);
  expect(await rejection(kolab.createNode(engineer, 'work_package' as never, 'Old label', 'w'))).toMatch(/a work package is an element of a binding with a work field, not a node \(KON5, D104\)/);
  expect(await rejection(kolab.createNode(engineer, 'nonsense' as never, 'X', 'w'))).toBe('GateError: a node\'s kind is one of spec, prototype, binding (D77, D95, D104), not nonsense');
  const insert = (id: string, kind: string, layer: string) => kolab.db.query(
    `insert into node(id, name, kind, layer, title, kolab_id, created_by) values ($1, $1, $2, $3, 'X', $4, 'admin')`, [id, kind, layer, TEST_KOLAB]);
  expect(await rejection(insert('u1', 'prototype', 'technical'))).toMatch(/node_layer_of_kind/);
  for (const old of ['wbs', 'work_package', 'implementation']) expect(await rejection(insert('u2', old, 'technical'))).toMatch(/node_kind_check/);
  // Once written, for every role.
  for (const sql of [`update node set kind = 'prototype' where id = 'orders'`, `update node set layer = 'functional' where id = 'orders-pg'`,
    `update node set parent_node_id = null where id = 'orders-pg'`]) {
    expect(await rejection(kolab.db.query(sql))).toMatch(/a node's kind, layer and parent never change once written/);
  }
  await kolab.createNode(product, 'prototype', 'Screens', 'ui');
  expect(await rejection(kolab.db.query(`update node set kind = 'spec' where id = 'ui'`))).toMatch(/never change once written|node_one_spec_per_kolab/);
});

test('a binding\'s work packages serve its own spec and rely on its decisions; one never links another; a binding serves its own spec (D78, D99, KON6, D104)', async () => {
  const { kolab, engineer, s1 } = await specAndBinding();
  const w1 = await kolab.commit(engineer, 'orders-pg', { elements: [...els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.' }),
    { id: 'W1', text: 'Build the cancel endpoint.', work: {} }, { id: 'W2', text: 'Build the queue.', work: {} }] });
  // A work package serves its spec's requirement, and relies on its binding's decision.
  await kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'W1', target: s1, targetElement: 'R1' });
  await kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'W1', target: w1, targetElement: 'b1' });
  // A work package depends on another through its depends_on work field, not a new link (D99):
  // the link is refused, pointing there.
  expect(await rejection(kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'W2', target: w1, targetElement: 'W1' })))
    .toMatch(/^GateError: work packages don't link to each other \(D99\): say what W2 needs in its work field instead, work: \{ depends_on: \["W1"\] \}/);
  // A binding serves its own spec, and no other kolab's.
  await kolab.createKolab('other', { owner: 'test-org' });
  await kolab.grant('other', 'carol', 'write', { layers: ['functional'] });
  await kolab.grant('other', 'bob', 'read');
  const carol = await kolab.openSession('carol', 'product', { kolab: 'other' });
  await kolab.createNode(carol, 'spec', 'Their spec', 'theirs');
  const t1 = await kolab.commit(carol, 'theirs', { elements: els({ T1: 'Theirs.' }) });
  expect(await rejection(kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'W2', target: t1, targetElement: 'T1' })))
    .toBe('GateError: orders-pg is a binding of its kolab\'s spec, and serves that spec alone, not other/theirs (D78)');
  // But it may rely on another kolab's prototype or binding: only Serves is held to the parent.
  await kolab.createNode(carol, 'prototype', 'Their screens', 'their-ui');
  const u1 = await kolab.commit(carol, 'their-ui', { elements: els({ U1: 'https://example.com/their-ui' }) });
  await kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'b2', target: u1, targetElement: 'U1' });
});

test('the database refuses a link outside the parent for every role, an agent\'s raw insert and Kolab\'s own login included (D78)', async () => {
  const { kolab, engineer, b1 } = await specAndBinding();
  await kolab.createKolab('other', { owner: 'test-org' });
  await kolab.grant('other', 'carol', 'write', { layers: ['functional'] });
  const carol = await kolab.openSession('carol', 'product', { kolab: 'other' });
  await kolab.createNode(carol, 'spec', 'Their spec', 'theirs');
  const t1 = await kolab.commit(carol, 'theirs', { elements: els({ T1: 'Theirs.' }) });
  const draft = await kolab.draft(engineer, 'orders-pg', { elements: els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.' }) });
  const fp = (await kolab.db.query<{ fingerprint: string }>(`select fingerprint from element where version_id = $1 and element_id = 'T1'`, [t1])).rows[0].fingerprint;
  const edge = `insert into edge(id, kind, source_version_id, source_element_id, target_version_id, target_element_id, target_fingerprint, held_by)
                values ($1, 'dependency', $2, 'b1', $3, 'T1', $4, 'bob')`;
  // As the engineer's own agent session, past row-level security: refused, as another kolab's version it doesn't read.
  expect(await rejection(asAgent(kolab, engineer, edge, ['e1', draft, t1, fp]))).toMatch(/row-level security|a binding serves its own spec/);
  // Kolab's own login: refused by the trigger.
  expect(await rejection(kolab.db.query(edge, ['e2', b1, t1, fp]))).toMatch(/a binding serves its own spec, and no other \(D78\); orders-pg targets theirs/);
});

test('a prototype\'s screens are marked when the requirement they show changes, beside the binding element and the work package that serve it (D79, KON3, M4)', async () => {
  const { kolab, product, engineer, b1 } = await specAndBinding();
  // Work packages of the binding that rely on its decisions.
  const w1 = await kolab.commit(engineer, 'orders-pg', { elements: [...els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.' }),
    { id: 'W1', text: 'Build the cancel endpoint.', work: {} }, { id: 'W2', text: 'Build the queue.', work: {} }] });
  await kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'W1', target: w1, targetElement: 'b1' });
  await kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'W2', target: w1, targetElement: 'b2' });
  void b1;
  // A prototype of the spec: each screen a URL, linked by equivalence to the requirement it shows.
  await kolab.createNode(product, 'prototype', 'Orders screens', 'orders-ui');
  const p1 = await kolab.commit(product, 'orders-ui', { elements: els({ cancel: 'https://example.com/orders/cancel', track: 'https://example.com/orders/track' }) });
  const s1 = (await kolab.latestCommitted('orders'))!.id;
  await kolab.link(product, { kind: 'equivalence', source: p1, sourceElement: 'cancel', target: s1, targetElement: 'R1' });
  await kolab.link(product, { kind: 'equivalence', source: p1, sourceElement: 'track', target: s1, targetElement: 'R2' });
  expect((await kolab.readNode(product, 'orders-ui')).node).toMatchObject({ kind: 'prototype', layer: 'functional', parent_node_id: null });

  // The spec changes R1 alone: the screen that shows it, the binding element that serves it, and
  // the work package that relies on that element are flagged; nothing of R2's.
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled until they ship.', R2: 'Orders ship in a day.' }) });
  const on = async (node: string) => (await marksOn(kolab, node)).map((m) => [m.element_id, m.reason]).sort();
  expect(await on('orders-ui')).toStrictEqual([['cancel', 'changed']]);
  expect(await on('orders-pg')).toStrictEqual([['W1', 'upstream_dirty'], ['b1', 'changed']]);
  // The product side settles its screen: still holds.
  const [screen] = await marksOn(kolab, 'orders-ui');
  await kolab.clear(product, screen.id);
  expect(await marksOn(kolab, 'orders-ui')).toStrictEqual([]);
});

test('a variant is of its parent\'s kind, and only a prototype may be derived from the spec: no binding inherits a spec\'s elements (D95, KON3, KON6; review M2)', async () => {
  const { kolab, product, engineer, s1, b1 } = await specAndBinding();
  // A second binding on the spec's version is refused; on the first binding's, it is a binding's variant.
  await kolab.createNode(engineer, 'binding', 'On DynamoDB', 'orders-ddb');
  expect(await rejection(kolab.draft(engineer, 'orders-ddb', { parent: s1, deltas: [] }))).toMatch(/orders-ddb is a binding, and its versions build on its own versions \(or, as a variant, on another binding's\), never on a spec's: orders is a spec\. Write the version without a parent/);
  expect(await rejection(kolab.applyRuling('orders-ddb', { parent: s1, deltas: [] }, { id: 'D95', actor: 'bob', by: 'admin' }))).toMatch(/orders-ddb is a binding, and its versions build on its own versions/);
  await kolab.commit(engineer, 'orders-ddb', { parent: b1, deltas: [{ kind: 'override', element: 'b1', text: 'A cancel table.' }] });
  // A prototype may be derived from the spec, and from a prototype; a spec from neither.
  await kolab.createNode(product, 'prototype', 'Screens', 'ui');
  const u1 = await kolab.commit(product, 'ui', { parent: s1, deltas: [{ kind: 'add', element: 'S1', text: 'https://example.com/cancel' }] });
  await kolab.createNode(product, 'prototype', 'Mobile screens', 'ui-mobile');
  await kolab.commit(product, 'ui-mobile', { parent: u1, deltas: [{ kind: 'override', element: 'S1', text: 'https://example.com/m/cancel' }] });
  await kolab.createNode(product, 'prototype', 'A sketch', 'sketch');
  const k1 = await kolab.commit(product, 'sketch', { elements: els({ K1: 'https://example.com/sketch' }) });
  expect(await rejection(kolab.draft(product, 'orders', { parent: k1, deltas: [] }))).toMatch(/orders is a spec, and a spec's variant is a spec, never a prototype's: sketch is a prototype/);
  // The database holds to it for every role, Kolab's own login included.
  const insert = (id: string, node: string, parent: string, layer: string) => kolab.db.query(
    `insert into version(id, node_id, seq, parent_version_id, layer, state, actor_id, active_role) values ($1, $2, 9, $3, $4, 'drafted', 'bob', 'engineer')`, [id, node, parent, layer]);
  expect(await rejection(insert('v-ddb', 'orders-ddb', s1, 'technical'))).toMatch(/orders-ddb is a binding, and its parent orders a spec/);
});

test('a draft with links is all or nothing: a link refused leaves no draft, and the links that pass are written with it (D95)', async () => {
  const { kolab, engineer, b1 } = await specAndBinding();
  const versions = async () => (await kolab.db.query(`select id from version where node_id = 'orders-pg'`)).rows.length;
  const elements = [...els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.' }), { id: 'W1', text: 'Build it.', work: {} }, { id: 'W2', text: 'Ship it.', work: {} }];
  // The third link names an element the binding hasn't: nothing is written, the first two included.
  expect(await rejection(kolab.draft(engineer, 'orders-pg', { elements, links: [
    { kind: 'dependency', sourceElement: 'W1', target: b1, targetElement: 'b1' },
    { kind: 'dependency', sourceElement: 'W2', target: b1, targetElement: 'b2' },
    { kind: 'dependency', sourceElement: 'b2', target: b1, targetElement: 'nowhere' },
  ] }))).toMatch(/orphan/);
  expect(await versions()).toBe(1);
  // A quote that doesn't resolve refuses it too.
  await rejection(kolab.draft(engineer, 'orders-pg', { elements, links: [
    { kind: 'dependency', sourceElement: 'W1', target: b1, targetElement: 'b1', selector: { exact: 'no such words' } },
  ] }));
  expect(await versions()).toBe(1);
  // All pass: the draft and its links are written together, a link declared twice once.
  const v = await kolab.draft(engineer, 'orders-pg', { elements, links: [
    { kind: 'dependency', sourceElement: 'W1', target: b1, targetElement: 'b1' },
    { kind: 'dependency', sourceElement: 'W1', target: b1, targetElement: 'b1' },
    { kind: 'dependency', sourceElement: 'W2', target: b1, targetElement: 'b2' },
  ] });
  expect((await kolab.db.query(`select source_element_id, target_element_id from edge where source_version_id = $1 and source_element_id like 'W%' order by source_element_id`, [v])).rows)
    .toStrictEqual([{ source_element_id: 'W1', target_element_id: 'b1' }, { source_element_id: 'W2', target_element_id: 'b2' }]);
  expect(await versions()).toBe(2);
});
