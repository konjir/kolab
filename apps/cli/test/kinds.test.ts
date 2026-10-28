// Konstruct kinds over MCP and in a shell (W4.1; D77, D78, D79): create_node takes a kind and, for a
// binding or a plan, its parent; list_nodes and read_node name it; a second spec, a plan's link into
// the spec and a plan of an unnamed binding among several are refused, saying what to do.
import { afterEach, expect, jest, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { call, connect, main } from '../src/cli.js';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';
const env = { ...process.env };
afterEach(() => { jest.restoreAllMocks(); process.env = { ...env }; });

async function kolabWithAgents() {
  const kolab = await openKolab();
  const server = await startServer({ adminToken: ADMIN, kolab });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const agent = async (id: string, role: 'product' | 'engineer') => {
    await call(admin, 'admin_add_actor', { id });
    await call(admin, 'admin_grant', { kolab: 'test', to: id, level: 'write', layers: [role === 'product' ? 'functional' : 'technical'] });
    const { token } = (await call(admin, 'admin_open_session', { actor: id, role })) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return { c, token };
  };
  return { server, pm: (await agent('pm-agent', 'product')).c, eng: await agent('eng-agent', 'engineer') };
}

test('over MCP: a spec, its prototype, two bindings and a plan, each naming its parent, and the limits refused with what to do', async () => {
  const { pm, eng: { c: eng } } = await kolabWithAgents();
  // A binding before the spec is refused: it names the spec it binds.
  expect(await rejection(call(eng, 'create_node', { kind: 'binding', title: 'Too soon', id: 'early' }))).toMatch(/holds no spec yet: create its spec first/);
  expect(await call(pm, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' })).toStrictEqual({ node: 'orders' });
  expect(await rejection(call(pm, 'create_node', { kind: 'spec', title: 'Billing', id: 'billing' })))
    .toMatch(/kolab test already holds its spec, orders, and a kolab holds exactly one \(KON1, D77\)\. Write its prototypes as prototype nodes, or a variant of it in another kolab, as a fork \(KON9\)/);
  // The old label is no kind.
  expect(await rejection(call(eng, 'create_node', { kind: 'wbs', title: 'Plan', id: 'plan' }))).toMatch(/wbs is now plan \(D77\): create it with kind plan/);
  expect(await rejection(call(pm, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'o' }))).toMatch(/functional_spec is now spec \(D95\): create it with kind spec/);
  expect(await rejection(call(eng, 'create_node', { kind: 'technical_binding', title: 'B', id: 'b' }))).toMatch(/technical_binding is now binding \(D95\): create it with kind binding/);
  expect(await rejection(call(eng, 'list_nodes', { kind: 'implementation' }))).toMatch(/implementation is a repository, not a node \(KON7, D77\)/);
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }, { id: 'R2', text: 'Orders ship in a day.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 1 });
  expect(await call(pm, 'create_node', { kind: 'prototype', title: 'Orders screens', id: 'orders-ui' })).toStrictEqual({ node: 'orders-ui' });
  await call(pm, 'draft', { node: 'orders-ui', elements: [{ id: 'cancel', text: 'https://example.com/orders/cancel' }],
    links: [{ source_element: 'cancel', target: 'kj:orders@1#R1', kind: 'equivalence' }] });
  await call(pm, 'submit_for_review', { node: 'orders-ui', version: 1 });

  // A binding names the kolab's spec by default; a plan, the only binding, or the one it names.
  expect(await call(eng, 'create_node', { kind: 'binding', title: 'On Postgres', id: 'orders-pg' })).toStrictEqual({ node: 'orders-pg', parent: 'orders' });
  await call(eng, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' }], links: [{ source_element: 'b1', target: 'kj:orders@1#R1' }] });
  await call(eng, 'submit_for_review', { node: 'orders-pg', version: 1 });
  expect(await call(eng, 'create_node', { kind: 'binding', title: 'On DynamoDB', id: 'orders-ddb', parent: 'orders' })).toStrictEqual({ node: 'orders-ddb', parent: 'orders' });
  expect(await rejection(call(eng, 'create_node', { kind: 'plan', title: 'Plan', id: 'orders-plan' })))
    .toMatch(/kolab test holds 2 bindings: name one with parent=<binding> \(orders-ddb, orders-pg\)/);
  expect(await call(eng, 'create_node', { kind: 'plan', title: 'Plan', id: 'orders-plan', parent: 'orders-pg' })).toStrictEqual({ node: 'orders-plan', parent: 'orders-pg' });
  expect(await rejection(call(eng, 'create_node', { kind: 'plan', title: 'Plan', id: 'plan-2', parent: 'orders-pg' }))).toMatch(/binding orders-pg already has its plan, orders-plan/);

  // A work package delivers its binding's element, never the spec's: in the draft's links and in konjir_link.
  await expect(call(eng, 'draft', { node: 'orders-plan', elements: [{ id: 'W1', text: 'Build the endpoint.' }], links: [{ source_element: 'W1', target: 'kj:orders@1#R1' }] }))
    .rejects.toThrow(/orders-plan is a plan: its work packages deliver elements of its own binding, never the spec \(KON6, D78\)/);
  // A draft with links is all or nothing (D95): the refused link left no draft behind.
  expect(await call(eng, 'read_node', { node: 'orders-plan' }).catch(String)).toMatch(/has no committed version/);
  expect((await call(eng, 'list_nodes', { kind: 'plan' }) as { nodes: { drafts: number }[] }).nodes[0].drafts).toBe(0);
  // One refused link among good ones refuses them all, and the draft.
  await expect(call(eng, 'draft', { node: 'orders-plan', elements: [{ id: 'W1', text: 'Build the endpoint.' }],
    links: [{ source_element: 'W1', target: 'kj:orders-pg@1#b1' }, { source_element: 'W1', target: 'kj:orders@1#R2' }] })).rejects.toThrow(/never the spec/);
  expect((await call(eng, 'list_nodes', { kind: 'plan' }) as { nodes: { drafts: number }[] }).nodes[0].drafts).toBe(0);
  expect(await call(eng, 'draft', { node: 'orders-plan', elements: [{ id: 'W1', text: 'Build the endpoint.' }], links: [{ source_element: 'W1', target: 'kj:orders-pg@1#b1' }] }))
    .toMatchObject({ version: 1, linked: ['W1 -> kj:orders-pg@1#b1'] });
  await expect(call(eng, 'link', { kind: 'dependency', source: 'kj:orders-plan@1#W1', target: 'kj:orders@1#R2' })).rejects.toThrow(/never the spec/);
  await call(eng, 'submit_for_review', { node: 'orders-plan', version: 1 });

  const { nodes } = await call(eng, 'list_nodes', {}) as { nodes: { id: string; kind: string; layer: string; parent?: string }[] };
  expect(nodes.map(({ id, kind, layer, parent }) => ({ id, kind, layer, ...(parent ? { parent } : {}) }))).toStrictEqual([
    { id: 'orders-ddb', kind: 'binding', layer: 'technical', parent: 'orders' },
    { id: 'orders-pg', kind: 'binding', layer: 'technical', parent: 'orders' },
    { id: 'orders-plan', kind: 'plan', layer: 'technical', parent: 'orders-pg' },
    { id: 'orders-ui', kind: 'prototype', layer: 'functional' },
    { id: 'orders', kind: 'spec', layer: 'functional' },
  ]);
  expect((await call(eng, 'list_nodes', { kind: 'plan' }) as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toStrictEqual(['orders-plan']);
  expect(await call(eng, 'read_node', { node: 'orders-plan' })).toMatchObject({ node: 'orders-plan', kind: 'plan', parent: 'orders-pg' });
  expect(await call(pm, 'read_node', { node: 'orders' })).not.toHaveProperty('parent');

  // The spec changes R1: the screen that shows it, the binding element that serves it and the work package that delivers that are flagged.
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled until they ship.' }, { id: 'R2', text: 'Orders ship in a day.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 2 });
  const stale = (await call(pm, 'list_stale', { all_layers: true }) as { marks: { dirty: string }[] }).marks.map((m) => m.dirty).sort();
  expect(stale).toStrictEqual(['kj:orders-pg@1#b1', 'kj:orders-plan@1#W1', 'kj:orders-ui@1#cancel']);
});

test('in a shell: konjir create_node takes kind and parent, and prints the parent Kolab named', async () => {
  const { server, pm, eng } = await kolabWithAgents();
  await call(pm, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  const out: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = eng.token;
  await main(['create_node', 'kind=binding', 'title=On Postgres', 'id=orders-pg']);
  await main(['create_node', 'kind=plan', 'title=Plan', 'id=orders-plan', 'parent=orders-pg']);
  expect(out.map((l) => JSON.parse(l))).toStrictEqual([{ node: 'orders-pg', parent: 'orders' }, { node: 'orders-plan', parent: 'orders-pg' }]);
});

test('work-package fields over MCP and in a shell: drafted on a plan\'s elements, shown by read_node, and a plan that breaks PLN2 refused, naming it (W5.1a, D98)', async () => {
  const { server, pm, eng } = await kolabWithAgents();
  await call(pm, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 1 });
  await call(eng.c, 'create_node', { kind: 'binding', title: 'On Postgres', id: 'orders-pg' });
  await call(eng.c, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' }] });
  await call(eng.c, 'submit_for_review', { node: 'orders-pg', version: 1 });
  await call(eng.c, 'create_node', { kind: 'plan', title: 'Plan', id: 'orders-plan' });
  // A field Kolab doesn't know is refused, not dropped; a spec's element takes none.
  await expect(call(eng.c, 'draft', { node: 'orders-plan', elements: [{ id: 'W1', text: 'Build it.', work: { estimate: '3d' } }] })).rejects.toThrow(/estimate/);
  await expect(call(pm, 'draft', { node: 'orders', deltas: [{ kind: 'override', element: 'R1', work: { size: 'S' } }] }))
    .rejects.toThrow(/only on a plan's elements, its work packages \(PLN1, D98\), and orders is a spec/);
  // A cycle is refused at submit, naming PLN2; the draft stays drafted.
  await call(eng.c, 'draft', { node: 'orders-plan', elements: [
    { id: 'W1', text: 'Build it.', work: { depends_on: ['W2'] } }, { id: 'W2', text: 'Ship it.', work: { depends_on: ['W1'] } },
  ] });
  expect(await call(eng.c, 'submit_for_review', { node: 'orders-plan', version: 1 })).toMatchObject({ ok: false, review: expect.stringMatching(/Plan checks failed \(PLN2\): Depends on has a cycle: W1 → W2 → W1/) });
  await call(eng.c, 'abandon', { node: 'orders-plan', version: 1 });
  // In a shell, the same draft with its fields as JSON, and its Delivers as a link.
  const out: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = eng.token;
  const elements = [
    { id: 'W1', text: 'Build it.', work: { done_when: 'It cancels.', size: 'M' } },
    { id: 'M1', text: 'Done.', work: { milestone: true, depends_on: ['W1'], target_date: '2026-12-01' } },
  ];
  await main(['draft', 'node=orders-plan', 'elements=' + JSON.stringify(elements), 'links=' + JSON.stringify([{ source_element: 'W1', target: 'kj:orders-pg@1#b1' }])]);
  await main(['submit_for_review', 'node=orders-plan', 'version=2']);
  expect(JSON.parse(out[1])).toMatchObject({ ok: true, committed: 'kj:orders-plan@2' });
  const read = await call(eng.c, 'read_node', { node: 'orders-plan' }) as { elements: { id: string; work?: unknown }[] };
  expect(read.elements.map((e) => [e.id, e.work])).toStrictEqual([
    ['W1', { done_when: 'It cancels.', size: 'M' }], ['M1', { depends_on: ['W1'], milestone: true, target_date: '2026-12-01' }],
  ]);
  // A milestone delivers nothing: refused as the link is declared.
  await expect(call(eng.c, 'link', { kind: 'dependency', source: 'kj:orders-plan@2#M1', target: 'kj:orders-pg@1#b1' })).rejects.toThrow(/M1 is a milestone, and a milestone delivers nothing \(PLN2, PLN3\)/);
});
