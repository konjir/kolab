// Agents as actors of their own, over real HTTP (W1.14; D30, ENF4, ENF5, ROL4): an admin adds two
// agents for one person, each holds its own session at the same time, and each version names its agent.
import { afterAll, expect, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { rejection, testStore } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';

const open: { close(): Promise<void> }[] = [];
afterAll(async () => { for (const o of open.reverse()) await o.close().catch(() => undefined); });

test("two agents of one person hold sessions at once over MCP, and whoami and read_node name the agent and its owner", async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  open.push(server, admin);

  expect(await call(admin, 'admin_add_actor', { id: 'alice', name: 'Alice' })).toStrictEqual({ actor: 'alice', kind: 'person', owner: null });
  expect(await call(admin, 'admin_add_actor', { id: 'alice-pm', owner: 'alice' })).toStrictEqual({ actor: 'alice-pm', kind: 'agent', owner: 'alice' });
  await call(admin, 'admin_add_actor', { id: 'alice-pm-2', owner: 'alice' });
  expect(await rejection(call(admin, 'admin_add_actor', { id: 'sub', owner: 'alice-pm' }))).toMatch(/alice-pm is an agent; an agent's owner must be a person/);
  expect(await call(admin, 'admin_list_actors', { owner: 'alice' })).toStrictEqual({ actors: [
    { id: 'alice-pm', name: 'alice-pm', kind: 'agent', owner: 'alice' },
    { id: 'alice-pm-2', name: 'alice-pm-2', kind: 'agent', owner: 'alice' },
  ] });

  const session = async (actor: string) => {
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'product' }) as { token: string };
    const client = await connect(server.url, token);
    open.push(client);
    return { token, client };
  };
  const one = await session('alice-pm');
  const two = await session('alice-pm-2');
  expect(await rejection(call(admin, 'admin_open_session', { actor: 'alice-pm', role: 'engineer' }))).toMatch(/alice-pm already has an open session/);

  expect(await call(one.client, 'whoami')).toStrictEqual({
    session: one.token, actor: 'alice-pm', kind: 'agent', owner: 'alice', role: 'product', layer: 'functional',
    subscribe: ['konjir://inbox/functional', 'konjir://answers/alice-pm'],
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
