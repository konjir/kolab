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
  expect(await rejection(call(eng, 'create_node', { kind: 'technical_binding', title: 'Too soon', id: 'early' }))).toMatch(/holds no spec yet: create its spec first/);
  expect(await call(pm, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' })).toStrictEqual({ node: 'orders' });
  expect(await rejection(call(pm, 'create_node', { kind: 'functional_spec', title: 'Billing', id: 'billing' })))
    .toMatch(/kolab test already holds its spec, orders, and a kolab holds exactly one \(KON1, D77\)\. Write its prototypes as prototype nodes, or a variant of it in another kolab, as a fork \(KON9\)/);
  // The old label is no kind.
  expect(await rejection(call(eng, 'create_node', { kind: 'wbs', title: 'Plan', id: 'plan' }))).toMatch(/functional_spec|invalid/i);
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }, { id: 'R2', text: 'Orders ship in a day.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 1 });
  expect(await call(pm, 'create_node', { kind: 'prototype', title: 'Orders screens', id: 'orders-ui' })).toStrictEqual({ node: 'orders-ui' });
  await call(pm, 'draft', { node: 'orders-ui', elements: [{ id: 'cancel', text: 'https://example.com/orders/cancel' }],
    links: [{ source_element: 'cancel', target: 'kj:orders@1#R1', kind: 'equivalence' }] });
  await call(pm, 'submit_for_review', { node: 'orders-ui', version: 1 });

  // A binding names the kolab's spec by default; a plan, the only binding, or the one it names.
  expect(await call(eng, 'create_node', { kind: 'technical_binding', title: 'On Postgres', id: 'orders-pg' })).toStrictEqual({ node: 'orders-pg', parent: 'orders' });
  await call(eng, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' }], links: [{ source_element: 'b1', target: 'kj:orders@1#R1' }] });
  await call(eng, 'submit_for_review', { node: 'orders-pg', version: 1 });
  expect(await call(eng, 'create_node', { kind: 'technical_binding', title: 'On DynamoDB', id: 'orders-ddb', parent: 'orders' })).toStrictEqual({ node: 'orders-ddb', parent: 'orders' });
  expect(await rejection(call(eng, 'create_node', { kind: 'plan', title: 'Plan', id: 'orders-plan' })))
    .toMatch(/kolab test holds 2 bindings: name one with parent=<binding> \(orders-ddb, orders-pg\)/);
  expect(await call(eng, 'create_node', { kind: 'plan', title: 'Plan', id: 'orders-plan', parent: 'orders-pg' })).toStrictEqual({ node: 'orders-plan', parent: 'orders-pg' });
  expect(await rejection(call(eng, 'create_node', { kind: 'plan', title: 'Plan', id: 'plan-2', parent: 'orders-pg' }))).toMatch(/binding orders-pg already has its plan, orders-plan/);

  // A work package delivers its binding's element, never the spec's: in the draft's links and in konjir_link.
  await expect(call(eng, 'draft', { node: 'orders-plan', elements: [{ id: 'W1', text: 'Build the endpoint.' }], links: [{ source_element: 'W1', target: 'kj:orders@1#R1' }] }))
    .rejects.toThrow(/orders-plan is a plan: its work packages deliver elements of its own binding, never the spec \(KON6, D78\)/);
  // The draft stands, without the link refused, as with any link refused (konjir_draft drafts, then links).
  await call(eng, 'link', { kind: 'dependency', source: 'kj:orders-plan@1#W1', target: 'kj:orders-pg@1#b1' });
  await expect(call(eng, 'link', { kind: 'dependency', source: 'kj:orders-plan@1#W1', target: 'kj:orders@1#R2' })).rejects.toThrow(/never the spec/);
  await call(eng, 'submit_for_review', { node: 'orders-plan', version: 1 });

  const { nodes } = await call(eng, 'list_nodes', {}) as { nodes: { id: string; kind: string; layer: string; parent?: string }[] };
  expect(nodes.map(({ id, kind, layer, parent }) => ({ id, kind, layer, ...(parent ? { parent } : {}) }))).toStrictEqual([
    { id: 'orders', kind: 'functional_spec', layer: 'functional' },
    { id: 'orders-plan', kind: 'plan', layer: 'technical', parent: 'orders-pg' },
    { id: 'orders-ui', kind: 'prototype', layer: 'functional' },
    { id: 'orders-ddb', kind: 'technical_binding', layer: 'technical', parent: 'orders' },
    { id: 'orders-pg', kind: 'technical_binding', layer: 'technical', parent: 'orders' },
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
  await call(pm, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });
  const out: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = eng.token;
  await main(['create_node', 'kind=technical_binding', 'title=On Postgres', 'id=orders-pg']);
  await main(['create_node', 'kind=plan', 'title=Plan', 'id=orders-plan', 'parent=orders-pg']);
  expect(out.map((l) => JSON.parse(l))).toStrictEqual([{ node: 'orders-pg', parent: 'orders' }, { node: 'orders-plan', parent: 'orders-pg' }]);
});
