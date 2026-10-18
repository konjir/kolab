// End to end over real HTTP: two agents with different roles, one Kolab server.
import { expect, test } from '@jest/globals';
import { sessionKey } from '@konjir/engine';
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
  await call(admin, 'admin_grant', { kolab: 'test', to: actor, level: 'write', layers: [role === 'product' ? 'functional' : 'technical'] });   // alone on its layer: no review (W1.6)
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
    session: sessionKey(eng.token), actor: 'eng-agent', kind: 'person', owner: null, role: 'engineer', layer: 'technical',
    kolab: 'test', access: { level: 'write', layers: ['technical'] },
    subscribe: ['konjir://inbox/test/technical', 'konjir://answers/test/eng-agent'],
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
  expect(text).toMatch(/konjir_reviewer_instructions/);

  // So do the reviewer's instructions (REV5): the same rules for every session and the admin token.
  expect((await pm.client.listPrompts()).prompts.map((p) => p.name).sort()).toStrictEqual(['konjir_operating_instructions', 'konjir_reviewer_instructions']);
  const reviewer = async (c: typeof admin) => (await c.getPrompt({ name: 'konjir_reviewer_instructions' })).messages
    .map((m) => (m.content.type === 'text' ? m.content.text : '')).join('');
  const forReviewers = await reviewer(eng.client);
  expect(forReviewers).toMatch(/^Konjir reviewer instructions\./);
  expect(forReviewers).toMatch(/verdict=request_changes note=/);
  expect(await reviewer(admin)).toBe(forReviewers);

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
  // Calling one anyway is refused in plain words, not as an OAuth scope challenge.
  await expect(call(pm.client, 'admin_list_kolabs')).rejects.toThrow(/^konjir_admin_list_kolabs is an admin verb: only the admin token may call it, and this token is an agent session's/);
  await expect(call(pm.client, 'konjir_admin_apply_ruling', { ruling: 'D1', actor: 'pm', node: 'test/x', deltas: [] })).rejects.toThrow(/only the admin token may call it/);
  await pm.client.close();

  await call(admin, 'admin_end_session', { token: pm.token });
  await expect(connect(server.url, pm.token)).rejects.toThrow();
  await admin.close();
  await server.close();
});

test('a token is shown once, when its session opens: whoami and the database hold only its hash, which the admin can end it by', async () => {
  const { server, admin } = await boot();
  await call(admin, 'admin_add_actor', { id: 'pm' });
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  await call(admin, 'admin_grant', { kolab: 'test', to: 'pm', level: 'write', layers: ['functional'] });
  const opened = await call(admin, 'admin_open_session', { actor: 'pm', role: 'product' }) as { token: string; session: string };
  expect(opened.session).toBe(sessionKey(opened.token));
  const pm = await connect(server.url, opened.token);
  const me = await call(pm, 'whoami');
  expect(me).toMatchObject({ session: opened.session, actor: 'pm' });
  expect(JSON.stringify(me)).not.toContain(opened.token);
  const stored = (await server.kolab.db.query<{ id: string }>(`select id from session`)).rows.map((r) => r.id);
  expect(stored).toStrictEqual([opened.session]);
  // The key is no bearer token.
  await expect(connect(server.url, opened.session)).rejects.toThrow();

  expect(await rejection(call(admin, 'admin_end_session', {}))).toMatch(/exactly one of token, session or actor/);
  expect(await rejection(call(admin, 'admin_end_session', { token: opened.token, actor: 'pm' }))).toMatch(/exactly one of token, session or actor/);
  // Each argument in its own form: a token as session=, or a key as token=, is refused, naming the right one.
  expect(await rejection(call(admin, 'admin_end_session', { session: opened.token }))).toMatch(/that is a token, not a session key; pass it as token=/);
  expect(await rejection(call(admin, 'admin_end_session', { token: opened.session }))).toMatch(/that is a session's key, not a token; pass it as session=/);
  expect(await rejection(call(admin, 'admin_end_session', { session: 'nonsense' }))).toMatch(/not a session key/);
  expect(await rejection(call(admin, 'admin_end_session', { token: 'nonsense' }))).toMatch(/not a session token/);
  expect(await call(pm, 'whoami')).toMatchObject({ actor: 'pm' });   // none of those ended it
  expect(await call(admin, 'admin_end_session', { session: opened.session })).toStrictEqual({ ended: opened.session });
  await expect(connect(server.url, opened.token)).rejects.toThrow();
  // Nothing open matched: an error, never a quiet success.
  expect(await rejection(call(admin, 'admin_end_session', { session: opened.session }))).toMatch(/no open session matched/);
  expect(await rejection(call(admin, 'admin_end_session', { token: opened.token }))).toMatch(/no open session matched/);
  expect(await rejection(call(admin, 'admin_end_session', { actor: 'pm' }))).toMatch(/pm has no open session/);

  // By actor, for an admin who kept no token.
  const again = await call(admin, 'admin_open_session', { actor: 'pm', role: 'product' }) as { token: string; session: string };
  expect(await call(admin, 'admin_end_session', { actor: 'pm' })).toStrictEqual({ ended: again.session });
  await expect(connect(server.url, again.token)).rejects.toThrow();
  await pm.close();
});

test('admin_outbox lists one kolab\'s jobs with kolab=, and refuses a kolab that isn\'t there', async () => {
  const { server, admin } = await boot();
  await agentFor(server.url, admin, 'pm', 'product');   // makes the kolab test
  expect(await call(admin, 'admin_outbox', { kolab: 'test' })).toStrictEqual({ jobs: [] });
  await expect(call(admin, 'admin_outbox', { kolab: 'nowhere' })).rejects.toThrow(/TenancyError: no kolab nowhere/);
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
