// Agents as actors of their own, over real HTTP (W1.14; D30, ENF4, ENF5, ROL4): an admin adds two
// agents for one person, each holds its own session at the same time, and each version names its
// agent. And accounts, kolabs and grants over the admin verbs (W1.3; TEN4, TEN11, TEN12).
import { expect, test } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { sessionKey } from '@konjir/engine';
import { startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, rejection, testStore } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';

test("two agents of one person hold sessions at once over MCP, and whoami and read_node name the agent and its owner", async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);

  expect(await call(admin, 'admin_add_actor', { id: 'alice', name: 'Alice' })).toStrictEqual({ actor: 'alice', kind: 'person', owner: null });
  expect(await call(admin, 'admin_add_actor', { id: 'alice-pm', owner: 'alice' })).toStrictEqual({ actor: 'alice-pm', kind: 'agent', owner: 'alice' });
  await call(admin, 'admin_add_actor', { id: 'alice-pm-2', owner: 'alice' });
  expect(await rejection(call(admin, 'admin_add_actor', { id: 'sub', owner: 'alice-pm' }))).toMatch(/alice-pm is an agent; an agent's owner must be a person or an organization/);
  await call(admin, 'admin_add_kolab', { name: 'checkout', owner: 'alice' });
  await call(admin, 'admin_grant', { kolab: 'checkout', to: 'alice-pm', level: 'write', layers: ['functional'] });
  await call(admin, 'admin_grant', { kolab: 'checkout', to: 'alice-pm-2', level: 'write' });
  expect(await call(admin, 'admin_list_actors', { owner: 'alice' })).toStrictEqual({ actors: [
    { id: 'alice-pm', name: 'alice-pm', kind: 'agent', owner: 'alice' },
    { id: 'alice-pm-2', name: 'alice-pm-2', kind: 'agent', owner: 'alice' },
  ] });

  const session = async (actor: string) => {
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'product' }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return { token, client };
  };
  const one = await session('alice-pm');
  const two = await session('alice-pm-2');
  expect(await rejection(call(admin, 'admin_open_session', { actor: 'alice-pm', role: 'engineer' }))).toMatch(/alice-pm already has an open session/);

  expect(await call(one.client, 'whoami')).toStrictEqual({
    session: sessionKey(one.token), actor: 'alice-pm', kind: 'agent', owner: 'alice', role: 'product', layer: 'functional',
    kolab: 'checkout', access: { level: 'write', layers: ['functional'] },
    subscribe: ['konjir://inbox/checkout/functional', 'konjir://answers/checkout/alice-pm'],
  });
  expect(await call(two.client, 'whoami')).toMatchObject({ actor: 'alice-pm-2', kind: 'agent', owner: 'alice' });

  // Each agent commits a version of the same spec while both sessions are open.
  await call(one.client, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' });
  await call(one.client, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Checkout completes in 30 seconds.' }] });
  await call(one.client, 'submit_for_review', { node: 'checkout', version: 1 });
  await call(two.client, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Checkout completes in 10 seconds.' }] });
  await call(two.client, 'submit_for_review', { node: 'checkout', version: 2 });

  const authorOf = async (version: number) => (await call(two.client, 'read_node', { node: 'checkout', version }) as { author: unknown }).author;
  expect(await authorOf(1)).toStrictEqual({ actor: 'alice-pm', kind: 'agent', owner: 'alice', role: 'product' });
  expect(await authorOf(2)).toStrictEqual({ actor: 'alice-pm-2', kind: 'agent', owner: 'alice', role: 'product' });

  // Identity rides the token: an agent can't reach the admin verbs to add agents of its own.
  expect((await one.client.listTools()).tools.some((t) => t.name.startsWith('konjir_admin'))).toBe(false);
});

test('over MCP, an agent whose draft another agent overtook is told it is stale, not that its content was wrong', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'shop' });
  await call(admin, 'admin_add_kolab', { name: 'checkout', owner: 'shop' });
  const session = async (actor: string) => {
    await call(admin, 'admin_add_actor', { id: actor });
    await call(admin, 'admin_grant', { kolab: 'checkout', to: actor, level: 'write' });
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'product' }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  const one = await session('ann');
  const two = await session('ben');
  await call(one, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' });
  await call(one, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Checkout completes in 30 seconds.' }] });
  await call(one, 'submit_for_review', { node: 'checkout', version: 1 });
  await call(two, 'review', { node: 'checkout', version: 1, verdict: 'approve' });
  await call(one, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Checkout completes in 20 seconds.' }] });
  await call(two, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Checkout completes in 10 seconds.' }] });
  expect(await call(two, 'submit_for_review', { node: 'checkout', version: 3 })).toMatchObject({ ok: false, in_review: 'kj:checkout@3', reviewers: ['ann'] });
  expect(await call(one, 'review', { node: 'checkout', version: 3, verdict: 'approve' })).toMatchObject({ ok: true, committed: 'kj:checkout@3', stale: false });

  expect(await call(one, 'submit_for_review', { node: 'checkout', version: 2 })).toMatchObject({
    ok: false, stale: true, committed: null,
    review: 'stale draft: the node committed a newer version; redraft against it',
    next: expect.stringMatching(/^Stale: someone else committed to checkout after this was drafted/),
  });
});

test('over MCP: two accounts\' kolabs can\'t see each other, a taken kolab name is refused, and an agent gets no more than its owner', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_actor', { id: 'ann' });
  await call(admin, 'admin_add_organization', { id: 'acme', name: 'Acme' });
  expect(await call(admin, 'admin_add_kolab', { name: 'orders', owner: 'ann' })).toStrictEqual({ kolab: 'orders', owner: 'ann', visibility: 'private', base: null });
  await call(admin, 'admin_add_kolab', { name: 'billing', owner: 'acme' });
  expect(await rejection(call(admin, 'admin_add_kolab', { name: 'orders', owner: 'acme' }))).toMatch(/TenancyError: the kolab name orders is taken: kolab names are unique across all of Konjir/);
  expect(await call(admin, 'admin_list_kolabs', {})).toMatchObject({ kolabs: [{ id: 'billing', owner: 'acme' }, { id: 'orders', owner: 'ann' }] });

  // An agent of the organization, and one of ann's that may not reach acme's kolab.
  await call(admin, 'admin_add_actor', { id: 'acme-bot', owner: 'acme' });
  await call(admin, 'admin_add_actor', { id: 'ann-pm', owner: 'ann' });
  await call(admin, 'admin_grant', { kolab: 'billing', to: 'acme-bot', level: 'write', layers: ['functional'] });
  expect(await rejection(call(admin, 'admin_grant', { kolab: 'billing', to: 'ann-pm', level: 'read' }))).toMatch(/AccessError: ann-pm's owner ann holds no access in kolab billing/);
  await call(admin, 'admin_grant', { kolab: 'orders', to: 'ann-pm', level: 'write' });
  expect(await call(admin, 'admin_access', { actor: 'ann-pm', kolab: 'orders' })).toStrictEqual({ actor: 'ann-pm', kolab: 'orders', level: 'write', layers: ['functional', 'technical'] });

  const client = async (actor: string, kolab?: string) => {
    const { token, kolab: k } = await call(admin, 'admin_open_session', { actor, role: 'product', ...(kolab && { kolab }) }) as { token: string; kolab: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return { c, k };
  };
  const bot = await client('acme-bot');
  const pm = await client('ann-pm', 'orders');
  expect([bot.k, pm.k]).toStrictEqual(['billing', 'orders']);
  expect(await rejection(call(admin, 'admin_open_session', { actor: 'ann', role: 'product', kolab: 'billing' }))).toMatch(/AccessError: ann has no access to kolab billing/);

  await call(bot.c, 'create_node', { kind: 'functional_spec', title: 'Billing', id: 'billing-spec' });
  await call(bot.c, 'draft', { node: 'billing-spec', elements: [{ id: 'B1', text: 'Invoices are monthly.' }] });
  await call(bot.c, 'submit_for_review', { node: 'billing-spec', version: 1 });
  await call(pm.c, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders-spec' });

  // Neither sees the other's node: not in a list, not by name, not to link or ask about.
  expect((await call(pm.c, 'list_nodes') as unknown as { id: string }[]).map((n) => n.id)).toStrictEqual(['orders-spec']);
  expect((await call(bot.c, 'list_nodes') as unknown as { id: string }[]).map((n) => n.id)).toStrictEqual(['billing-spec']);
  expect(await rejection(call(pm.c, 'read_node', { node: 'billing-spec' }))).toMatch(/no node billing-spec in kolab orders/);
  expect(await rejection(call(pm.c, 'resolve', { address: 'kj:billing-spec#B1' }))).toMatch(/no node billing-spec in kolab orders/);
  expect(await rejection(call(pm.c, 'ask', { address: 'kj:billing-spec#B1', question: 'Why monthly?' }))).toMatch(/no node billing-spec in kolab orders/);
  expect(await rejection(call(pm.c, 'draft', { node: 'billing-spec', elements: [{ id: 'B1', text: 'Weekly.' }] }))).toMatch(/no node billing-spec in kolab orders/);

  // The served instructions carry answered questions only from the agent's own kolab (TEN13).
  const { query } = await call(bot.c, 'ask', { address: 'kj:billing-spec#B1', question: 'Why monthly, not weekly?' }) as { query: string };
  await call(bot.c, 'answer_query', { query, answer: 'Our customers pay monthly.' });
  const instructions = async (c: typeof pm.c) => {
    const r = await c.getPrompt({ name: 'konjir_operating_instructions' });
    return (r.messages[0].content as { text: string }).text;
  };
  expect(await instructions(bot.c)).toMatch(/Answered questions and notes \(1\):.*Why monthly, not weekly\?/);
  expect(await instructions(pm.c)).toMatch(/Answered questions and notes \(0\): none yet/);
  expect(await instructions(pm.c)).not.toMatch(/monthly/);
  // Submitting needs Write: a Read session can't commit another's draft.
  await call(pm.c, 'draft', { node: 'orders-spec', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] });

  // Her agent's grant drops to Read: its session narrows. When it goes, the session ends and its token is refused.
  expect(await call(admin, 'admin_grant', { kolab: 'orders', to: 'ann-pm', level: 'read' })).toMatchObject({ ended_sessions: 0 });
  expect(await call(pm.c, 'whoami')).toMatchObject({ kolab: 'orders', access: { level: 'read', layers: [] } });
  expect(await rejection(call(pm.c, 'draft', { node: 'orders-spec', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] })))
    .toMatch(/AccessError: ann-pm may not write the functional layer of kolab orders: it holds Read/);
  expect(await rejection(call(pm.c, 'submit_for_review', { node: 'orders-spec', version: 1 })))
    .toMatch(/AccessError: ann-pm may not write the functional layer of kolab orders: it holds Read/);
  expect(await call(admin, 'admin_revoke', { kolab: 'orders', to: 'ann-pm' })).toStrictEqual({ kolab: 'orders', revoked: 'ann-pm', ended_sessions: 1 });
  expect(await rejection(call(pm.c, 'whoami'))).toMatch(/token/i);
});

test('over MCP, a review request waits in the reviewer\'s inbox, konjir_review settles it, and the author\'s answers show the verdict', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  await call(admin, 'admin_add_actor', { id: 'lee' });
  await call(admin, 'admin_grant', { kolab: 'test', to: 'lee', level: 'write', layers: ['functional'] });
  const session = async (actor: string) => {
    await call(admin, 'admin_add_actor', { id: actor, owner: 'lee' });
    await call(admin, 'admin_grant', { kolab: 'test', to: actor, level: 'write', layers: ['functional'] });
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'product' }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  // Two agents of one person: Claude Code writes, Codex reviews (D25). Lee, with Write on the
  // layer too, is a reviewer as well, though she has no session.
  const claude = await session('lee-claude');
  const codex = await session('lee-codex');
  const read = async (client: Client, uri: string) => {
    const [content] = (await client.readResource({ uri })).contents;
    return JSON.parse('text' in content ? content.text : '');
  };
  await call(claude, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' });
  await call(claude, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Checkout completes in 30 seconds and emails a receipt.' }] });
  expect(await call(claude, 'submit_for_review', { node: 'checkout', version: 1 })).toMatchObject({
    ok: false, committed: null, in_review: 'kj:checkout@1', reviewers: ['lee', 'lee-codex'], next: expect.stringMatching(/^In review: lee, lee-codex each have a review request/),
  });

  const inbox = await read(codex, 'konjir://inbox/test/functional');
  expect(inbox.reviews).toMatchObject([{ subject: 'kj:checkout@1', subject_kind: 'version', author: 'lee-claude', reviewer: 'lee-codex' }]);
  expect((await read(claude, 'konjir://inbox/test/functional')).reviews).toStrictEqual([]);
  expect(await call(codex, 'list_reviews', {})).toMatchObject({ for_you: [{ subject: 'kj:checkout@1' }], yours: [] });
  expect(await rejection(call(claude, 'review', { node: 'checkout', version: 1, verdict: 'approve' }))).toMatch(/lee-claude wrote checkout@1/);
  expect(await rejection(call(codex, 'review', { node: 'checkout', version: 1, verdict: 'request_changes' }))).toMatch(/request_changes needs a note/);

  expect(await call(codex, 'review', {
    node: 'checkout', version: 1, verdict: 'request_changes', note: 'R1 is compound: split it.',
  })).toMatchObject({ verdict: 'request_changes', state: 'drafted' });
  const answers = await read(claude, 'konjir://answers/test/lee-claude');
  expect(answers.submissions).toMatchObject([{ subject: 'kj:checkout@1', state: 'drafted', verdicts: [{ reviewer: 'lee', state: 'withdrawn' }, { reviewer: 'lee-codex', state: 'changes_requested', note: 'R1 is compound: split it.' }] }]);

  await call(claude, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Checkout completes in 30 seconds.' }, { id: 'R2', text: 'Checkout emails a receipt.' }] });
  await call(claude, 'abandon', { node: 'checkout', version: 1 });
  await call(claude, 'submit_for_review', { node: 'checkout', version: 2 });
  expect(await call(codex, 'review', { node: 'checkout', version: 2, verdict: 'approve', note: 'Each element is one testable intent.' })).toMatchObject({
    verdict: 'approve', ok: true, committed: 'kj:checkout@2', unreviewed: false,
  });
  expect((await read(codex, 'konjir://inbox/test/functional')).reviews).toStrictEqual([]);
  expect((await read(claude, 'konjir://answers/test/lee-claude')).submissions.map((s: { subject: string; state: string }) => [s.subject, s.state]))
    .toStrictEqual([['kj:checkout@2', 'committed'], ['kj:checkout@1', 'rejected']]);
});

test('over MCP, only the admin token applies a ruling, which commits without review (D47); an agent session can\'t reach it', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const session = async (actor: string) => {
    await call(admin, 'admin_add_actor', { id: actor });
    await call(admin, 'admin_grant', { kolab: 'test', to: actor, level: 'write', layers: ['functional'] });
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'product' }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  const pm = await session('mirror-product');
  const other = await session('pm-2');   // a reviewer: without D47, the version would wait for it
  await call(pm, 'create_node', { kind: 'functional_spec', title: 'Kolab', id: 'kolab' });
  const ruling = { ruling: 'D46', actor: 'mirror-product', node: 'kolab', elements: [{ id: 'R1', text: 'Kolab adopts onivoro hooks.' }] };

  expect((await pm.listTools()).tools.some((t) => t.name === 'konjir_admin_apply_ruling')).toBe(false);
  expect(await rejection(call(pm, 'admin_apply_ruling', ruling))).toMatch(/admin|scope|not found|forbidden|unknown/i);
  expect(await rejection(call(other, 'admin_apply_ruling', ruling))).toMatch(/admin|scope|not found|forbidden|unknown/i);

  expect(await call(admin, 'admin_apply_ruling', ruling)).toMatchObject({ ok: true, ruling: 'D46', committed: 'kj:test/kolab@1', state: 'committed', review: expect.stringMatching(/^Applied as ruling D46 through the admin token/) });
  expect(await call(other, 'list_reviews', {})).toMatchObject({ for_you: [] });
  expect(await call(pm, 'read_node', { node: 'kolab' })).toMatchObject({ version: 1, state: 'committed', author: { actor: 'mirror-product', role: 'product' } });
});

test('over MCP, two kolabs each have a node called checkout: the short form is your own, the full form resolves wherever you can read (W1.4, DAT11)', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  for (const [actor, kolab] of [['alice', 'orders'], ['bob', 'billing']]) {
    await call(admin, 'admin_add_actor', { id: actor });
    await call(admin, 'admin_add_kolab', { name: kolab, owner: actor });
  }
  const session = async (actor: string) => {
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'product' }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  const alice = await session('alice');
  const bob = await session('bob');
  for (const [client, text] of [[alice, 'Orders ship within a day.'], [bob, 'Invoices are sent monthly.']] as const) {
    expect(await call(client, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' })).toStrictEqual({ node: 'checkout' });
    await call(client, 'draft', { node: 'checkout', elements: [{ id: 'R1', text }] });
    expect(await call(client, 'submit_for_review', { node: 'checkout', version: 1 })).toMatchObject({ ok: true, committed: 'kj:checkout@1' });
  }
  expect((await call(bob, 'list_nodes') as { id: string }[]).map((n) => n.id)).toStrictEqual(['checkout']);
  expect(await call(bob, 'resolve', { address: 'kj:checkout#R1' })).toMatchObject({ status: 'ok', content: 'Invoices are sent monthly.' });
  expect(await call(alice, 'resolve', { address: 'kj:checkout#R1' })).toMatchObject({ status: 'ok', content: 'Orders ship within a day.' });
  // Its own kolab's full form works for writing too.
  await call(bob, 'draft', { node: 'billing/checkout', elements: [{ id: 'R1', text: 'Invoices are sent weekly.' }] });
  expect(await call(bob, 'submit_for_review', { node: 'kj:billing/checkout', version: 2 })).toMatchObject({ ok: true, committed: 'kj:checkout@2' });

  // Without Read on billing, alice is told there is no such node, as for one that isn't there.
  expect(await rejection(call(alice, 'resolve', { address: 'kj:billing/checkout#R1' }))).toMatch(/no node checkout in kolab billing/);
  expect(await rejection(call(alice, 'read_node', { node: 'billing/checkout' }))).toMatch(/no node checkout in kolab billing/);
  await call(admin, 'admin_grant', { kolab: 'billing', to: 'alice', level: 'read' });
  expect(await call(alice, 'resolve', { address: 'kj:billing/checkout@1#R1' })).toMatchObject({ status: 'ok', version: 1, content: 'Invoices are sent monthly.' });
  expect(await call(alice, 'read_node', { node: 'billing/checkout' })).toMatchObject({
    node: 'billing/checkout', version: 2, elements: [{ address: 'kj:billing/checkout@2#R1', id: 'R1', text: 'Invoices are sent weekly.' }],
  });
  expect(await call(alice, 'read_node', { node: 'checkout' })).toMatchObject({ node: 'checkout', elements: [{ address: 'kj:checkout@1#R1' }] });

  // A link and a fork may cross into a kolab alice reads (LNK8, KON9); a question, and drafting there, may not.
  await call(alice, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Orders ship within a day.' }, { id: 'R2', text: 'Invoices follow billing.' }] });
  expect(await call(alice, 'link', { kind: 'dependency', source: 'kj:checkout@2#R2', target: 'kj:billing/checkout#R1' })).toMatchObject({ edge: expect.any(String) });
  expect(await rejection(call(alice, 'link', { kind: 'dependency', source: 'kj:checkout@2#R2', target: 'kj:shop/checkout#R1' }))).toMatch(/no node checkout in kolab shop/);
  await call(alice, 'create_node', { kind: 'functional_spec', title: 'Billing EU', id: 'billing-eu' });
  expect(await call(alice, 'draft', { node: 'billing-eu', parent: 'kj:billing/checkout@2', deltas: [{ kind: 'override', element: 'R1', text: 'Invoices are sent weekly, in euros.' }] }))
    .toMatchObject({ node: 'billing-eu', version: 1 });
  expect(await rejection(call(alice, 'ask', { address: 'kj:billing/checkout#R1', question: 'Why weekly?' }))).toMatch(/asking across kolabs isn't supported yet/);
  expect(await rejection(call(alice, 'draft', { node: 'billing/checkout', elements: [{ id: 'R1', text: 'x' }] }))).toMatch(/drafting across kolabs isn't supported yet/);
});
