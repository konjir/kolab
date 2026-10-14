// End to end over real HTTP: two agents with different roles, one Kolab server.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';

const ADMIN = 'test-admin-token';

const open: { close(): Promise<void> }[] = [];
after(async () => { for (const o of open.reverse()) await o.close().catch(() => undefined); });

async function boot(dataDir?: string) {
  const server = await startServer({ adminToken: ADMIN, dataDir });
  const admin = await connect(server.url, ADMIN);
  open.push(server, admin);
  return { server, admin };
}

async function agentFor(url: string, admin: Awaited<ReturnType<typeof connect>>, actor: string, role: 'product' | 'engineer') {
  await call(admin, 'admin_add_actor', { id: actor }).catch(() => undefined);
  const { token } = (await call(admin, 'admin_open_session', { actor, role })) as { token: string };
  const client = await connect(url, token);
  open.push(client);
  return { token, client };
}

test('two agents work through one kolab: roles, gate, links, questions, cascade, served instructions', async () => {
  const { server, admin } = await boot();
  const pm = await agentFor(server.url, admin, 'pm-agent', 'product');
  const eng = await agentFor(server.url, admin, 'eng-agent', 'engineer');

  assert.deepEqual(await call(eng.client, 'whoami'), {
    session: eng.token, actor: 'eng-agent', role: 'engineer', layer: 'technical',
    subscribe: ['konjir://inbox/technical', 'konjir://answers/eng-agent'],
  });

  // Product authors and commits the spec.
  await call(pm.client, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' });
  await call(pm.client, 'draft', { node: 'checkout', elements: [
    { id: 'R1', text: 'Checkout completes within 30 seconds of payment confirmation.' },
    { id: 'R2', text: 'Users can save a cart for later.' },
  ] });
  const committed = await call(pm.client, 'submit_for_review', { node: 'checkout', version: 1 }) as { ok: boolean; committed: string };
  assert.deepEqual([committed.ok, committed.committed], [true, 'kj:checkout@1']);

  // The engineer cannot touch the functional layer, and gets an actionable error.
  await assert.rejects(call(eng.client, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'x' }] }), /RoleError.*konjir_ask/);

  // The engineer binds, links element to element, and asks the spec a question.
  await call(eng.client, 'create_node', { kind: 'technical_binding', title: 'Checkout on Postgres', id: 'checkout-pg' });
  await call(eng.client, 'draft', { node: 'checkout-pg', elements: [{ id: 'b1', text: 'Order finalizer worker with a 25s budget.' }, { id: 'b2', text: 'saved_cart table.' }] });
  await assert.rejects(call(eng.client, 'link', { kind: 'dependency', source: 'kj:checkout-pg@1', source_element: 'b1', target: 'kj:checkout-pg@1' }), /not committed|GateError/);
  await call(eng.client, 'submit_for_review', { node: 'checkout-pg', version: 1 });
  await call(eng.client, 'link', { kind: 'dependency', source: 'kj:checkout-pg@1', source_element: 'b1', target: 'kj:checkout@1#R1' });
  await call(eng.client, 'link', { kind: 'dependency', source: 'kj:checkout-pg@1', source_element: 'b2', target: 'kj:checkout#R2~q({"exact":"save a cart"})' });
  const { query } = await call(eng.client, 'ask', { address: 'kj:checkout#R2', question: 'Do saved carts expire?' }) as { query: string };

  // The question lands on the product layer; the engineer can't answer it.
  const pmQueries = await call(pm.client, 'list_queries') as { queries: { id: string; address: string }[] };
  assert.deepEqual(pmQueries.queries.map((q) => [q.id, q.address]), [[query, 'kj:checkout@1#R2']]);
  await assert.rejects(call(eng.client, 'answer_query', { query, answer: 'never' }), /RoleError/);
  await call(pm.client, 'answer_query', { query, answer: 'After 30 days.' });

  // Product tightens R1. Only b1 goes dirty; the span link on R2 doesn't.
  await call(pm.client, 'draft', { node: 'checkout', elements: [
    { id: 'R1', text: 'Checkout completes within 10 seconds of payment confirmation.' },
    { id: 'R2', text: 'Users can save a cart for later, for 30 days.' },
  ] });
  await call(pm.client, 'submit_for_review', { node: 'checkout', version: 2 });
  const stale = await call(eng.client, 'list_stale') as { marks: { mark: string; dirty: string; reason: string; because: string; next: string }[] };
  assert.equal(stale.marks.length, 1);
  assert.equal(stale.marks[0].dirty, 'kj:checkout-pg@1#b1');
  assert.equal(stale.marks[0].reason, 'changed');
  assert.match(stale.marks[0].because, /kj:checkout#R1 changed in version 2/);
  assert.match(stale.marks[0].next, /konjir_clear_mark/);
  assert.deepEqual((await call(pm.client, 'list_stale') as { marks: unknown[] }).marks, [], 'product layer has nothing dirty');

  // Lineage reads both ways.
  const down = await call(pm.client, 'lineage', { node: 'checkout', direction: 'downstream' }) as { edges: { source: string }[] };
  assert.deepEqual(down.edges.map((e) => e.source).sort(), ['kj:checkout-pg@1#b1', 'kj:checkout-pg@1#b2']);

  // The engineer re-checks and clears; the edge re-pins to v2.
  await call(eng.client, 'clear_mark', { mark: stale.marks[0].mark });
  assert.deepEqual((await call(eng.client, 'list_stale') as { marks: unknown[] }).marks, []);
  const up = await call(eng.client, 'lineage', { node: 'checkout-pg', direction: 'upstream' }) as { edges: { target: string }[] };
  assert.ok(up.edges.some((e) => e.target === 'kj:checkout@2#R1'));

  // Served instructions carry the rules and the settled question.
  const prompt = await pm.client.getPrompt({ name: 'konjir_operating_instructions' });
  const text = prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('');
  assert.match(text, /Fetch fresh/);
  assert.match(text, /Do saved carts expire\?" -> "After 30 days\./);

  for (const c of [pm.client, eng.client, admin]) await c.close();
  await server.close();
});

test('tokens: no token, a wrong token, and a revoked token are all refused; agents cannot use admin verbs', async () => {
  const { server, admin } = await boot();
  const res = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  await assert.rejects(connect(server.url, 'kjs_not-a-session'));

  const pm = await agentFor(server.url, admin, 'pm', 'product');
  const tools = (await pm.client.listTools()).tools.map((t) => t.name);
  assert.ok(!tools.some((t) => t.startsWith('konjir_admin')));
  await pm.client.close();

  await call(admin, 'admin_end_session', { token: pm.token });
  await assert.rejects(connect(server.url, pm.token));
  await admin.close();
  await server.close();
});

test('Kolab persists across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-'));
  try {
    let { server, admin } = await boot(dir);
    const pm = await agentFor(server.url, admin, 'pm', 'product');
    await call(pm.client, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' });
    await call(pm.client, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Persist me.' }] });
    await call(pm.client, 'submit_for_review', { node: 'checkout', version: 1 });
    await pm.client.close(); await admin.close(); await server.close();

    ({ server, admin } = await boot(dir));
    const again = await connect(server.url, pm.token);
    assert.deepEqual(await call(again, 'resolve', { address: 'kj:checkout#R1' }),
      { address: 'kj:checkout#R1', status: 'ok', version: 1, content: 'Persist me.' });
    await again.close(); await admin.close(); await server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
