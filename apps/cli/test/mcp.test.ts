// End to end over real HTTP: two agents with different roles, one Kolab server.
import { expect, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, persistentStore, rejection, testStore, type Store } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';

async function boot(store?: Store) {
  const server = await startServer({ adminToken: ADMIN, ...(store ?? await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  return { server, admin };
}

async function agentFor(url: string, admin: Awaited<ReturnType<typeof connect>>, actor: string, role: 'product' | 'engineer') {
  await call(admin, 'admin_add_actor', { id: actor }).catch(() => undefined);
  await call(admin, 'admin_add_organization', { id: 'test-org' }).catch(() => undefined);
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' }).catch(() => undefined);
  await call(admin, 'admin_grant', { kolab: 'test', to: actor, level: 'write' });
  const { token } = (await call(admin, 'admin_open_session', { actor, role })) as { token: string };
  const client = await connect(url, token);
  closeAtEnd(client);
  return { token, client };
}

test('two agents work through one kolab: roles, gate, links, questions, cascade, served instructions', async () => {
  const { server, admin } = await boot();
  const pm = await agentFor(server.url, admin, 'pm-agent', 'product');
  const eng = await agentFor(server.url, admin, 'eng-agent', 'engineer');

  expect(await call(eng.client, 'whoami')).toStrictEqual({
    session: eng.token, actor: 'eng-agent', kind: 'person', owner: null, role: 'engineer', layer: 'technical',
    kolab: 'test', access: { level: 'write', layers: ['functional', 'technical'] },
    subscribe: ['konjir://inbox/technical', 'konjir://answers/eng-agent'],
  });

  // Product authors and commits the spec.
  await call(pm.client, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' });
  await call(pm.client, 'draft', { node: 'checkout', elements: [
    { id: 'R1', text: 'Checkout completes within 30 seconds of payment confirmation.' },
    { id: 'R2', text: 'Users can save a cart for later.' },
  ] });
  const committed = await call(pm.client, 'submit_for_review', { node: 'checkout', version: 1 }) as { ok: boolean; committed: string };
  expect([committed.ok, committed.committed]).toStrictEqual([true, 'kj:checkout@1']);

  // The engineer cannot touch the functional layer, and gets an actionable error.
  expect(await rejection(call(eng.client, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'x' }] }))).toMatch(/RoleError.*konjir_ask/);

  // The engineer binds, links element to element, and asks the spec a question.
  await call(eng.client, 'create_node', { kind: 'technical_binding', title: 'Checkout on Postgres', id: 'checkout-pg' });
  await call(eng.client, 'draft', { node: 'checkout-pg', elements: [{ id: 'b1', text: 'Order finalizer worker with a 25s budget.' }, { id: 'b2', text: 'saved_cart table.' }] });
  expect(await rejection(call(eng.client, 'link', { kind: 'dependency', source: 'kj:checkout-pg@1', source_element: 'b1', target: 'kj:checkout-pg@1' }))).toMatch(/not committed|GateError/);
  await call(eng.client, 'submit_for_review', { node: 'checkout-pg', version: 1 });
  await call(eng.client, 'link', { kind: 'dependency', source: 'kj:checkout-pg@1', source_element: 'b1', target: 'kj:checkout@1#R1' });
  await call(eng.client, 'link', { kind: 'dependency', source: 'kj:checkout-pg@1', source_element: 'b2', target: 'kj:checkout#R2~q({"exact":"save a cart"})' });
  const { query } = await call(eng.client, 'ask', { address: 'kj:checkout#R2', question: 'Do saved carts expire?' }) as { query: string };

  // The question lands on the product layer; the engineer can't answer it.
  const pmQueries = await call(pm.client, 'list_queries') as { queries: { id: string; address: string }[] };
  expect(pmQueries.queries.map((q) => [q.id, q.address])).toStrictEqual([[query, 'kj:checkout@1#R2']]);
  expect(await rejection(call(eng.client, 'answer_query', { query, answer: 'never' }))).toMatch(/RoleError/);
  await call(pm.client, 'answer_query', { query, answer: 'After 30 days.' });

  // Product tightens R1. Only b1 goes dirty; the span link on R2 doesn't.
  await call(pm.client, 'draft', { node: 'checkout', elements: [
    { id: 'R1', text: 'Checkout completes within 10 seconds of payment confirmation.' },
    { id: 'R2', text: 'Users can save a cart for later, for 30 days.' },
  ] });
  await call(pm.client, 'submit_for_review', { node: 'checkout', version: 2 });
  const stale = await call(eng.client, 'list_stale') as { marks: { mark: string; dirty: string; reason: string; because: string; next: string }[] };
  expect(stale.marks.length).toBe(1);
  expect(stale.marks[0].dirty).toBe('kj:checkout-pg@1#b1');
  expect(stale.marks[0].reason).toBe('changed');
  expect(stale.marks[0].because).toMatch(/kj:checkout#R1 changed in version 2/);
  expect(stale.marks[0].next).toMatch(/konjir_clear_mark/);
  expect((await call(pm.client, 'list_stale') as { marks: unknown[] }).marks).toStrictEqual([]); // product layer has nothing dirty

  // Lineage reads both ways.
  const down = await call(pm.client, 'lineage', { node: 'checkout', direction: 'downstream' }) as { edges: { source: string }[] };
  expect(down.edges.map((e) => e.source).sort()).toStrictEqual(['kj:checkout-pg@1#b1', 'kj:checkout-pg@1#b2']);

  // The engineer re-checks and clears; the edge re-pins to v2.
  await call(eng.client, 'clear_mark', { mark: stale.marks[0].mark });
  expect((await call(eng.client, 'list_stale') as { marks: unknown[] }).marks).toStrictEqual([]);
  const up = await call(eng.client, 'lineage', { node: 'checkout-pg', direction: 'upstream' }) as { edges: { target: string }[] };
  expect(up.edges.some((e) => e.target === 'kj:checkout@2#R1')).toBeTruthy();

  // Served instructions carry the rules and the settled question.
  const prompt = await pm.client.getPrompt({ name: 'konjir_operating_instructions' });
  const text = prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('');
  expect(text).toMatch(/Fetch fresh/);
  expect(text).toMatch(/Do saved carts expire\?" -> "After 30 days\./);

  for (const c of [pm.client, eng.client, admin]) await c.close();
  await server.close();
});

test('tokens: no token, a wrong token, and a revoked token are all refused; agents cannot use admin verbs', async () => {
  const { server, admin } = await boot();
  const res = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(res.status).toBe(401);
  await expect(connect(server.url, 'kjs_not-a-session')).rejects.toThrow();

  const pm = await agentFor(server.url, admin, 'pm', 'product');
  const tools = (await pm.client.listTools()).tools.map((t) => t.name);
  expect(!tools.some((t) => t.startsWith('konjir_admin'))).toBeTruthy();
  await pm.client.close();

  await call(admin, 'admin_end_session', { token: pm.token });
  await expect(connect(server.url, pm.token)).rejects.toThrow();
  await admin.close();
  await server.close();
});

test('Kolab persists across restarts', async () => {
  const store = await persistentStore();
  {
    let { server, admin } = await boot(store);
    const pm = await agentFor(server.url, admin, 'pm', 'product');
    await call(pm.client, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' });
    await call(pm.client, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Persist me.' }] });
    await call(pm.client, 'submit_for_review', { node: 'checkout', version: 1 });
    await pm.client.close(); await admin.close(); await server.close();

    ({ server, admin } = await boot(store));
    const again = await connect(server.url, pm.token);
    expect(await call(again, 'resolve', { address: 'kj:checkout#R1' })).toStrictEqual({ address: 'kj:checkout#R1', status: 'ok', version: 1, content: 'Persist me.' });
    await again.close(); await admin.close(); await server.close();
  }
});
