// An agent's state over MCP, as konnect says it: konjir_say_state { state } from an agent's own
// session, shown as `state` on that agent's entry in konjir_list_members, for every member and
// itself, while fresh (AGENT_STATE_FRESH_SECONDS, by a clock the test moves). `gone`, the session
// ending, or its access going clears it; another kolab's list never shows it; a person is refused.
import { expect, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { AGENT_STATE_FRESH_SECONDS } from '@konjir/types';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, rejection, testStore } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';

test('an agent says what it is doing, and the member list shows it while fresh; gone, ending or revoking clears it; a person is refused; no other kolab sees it', async () => {
  let now = Date.parse('2026-11-18T12:00:00Z');
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()), agentStateClock: () => now });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  for (const id of ['ann', 'bo', 'cy']) await call(admin, 'admin_add_actor', { id });
  await call(admin, 'admin_add_actor', { id: 'ann-claude', owner: 'ann' });
  await call(admin, 'admin_add_kolab', { name: 'hub', owner: 'ann' });
  await call(admin, 'admin_add_kolab', { name: 'side', owner: 'ann' });
  await call(admin, 'admin_grant', { kolab: 'hub', to: 'bo', level: 'write' });
  await call(admin, 'admin_grant', { kolab: 'hub', to: 'ann-claude', level: 'write' });
  await call(admin, 'admin_grant', { kolab: 'side', to: 'ann-claude', level: 'write' });
  await call(admin, 'admin_grant', { kolab: 'side', to: 'cy', level: 'write' });
  const session = async (actor: string, kolab: string) => {
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'engineer', kolab }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  const ann = await session('ann', 'hub');
  const bo = await session('bo', 'hub');
  const cy = await session('cy', 'side');
  let agent = await session('ann-claude', 'hub');
  const entry = async (who: Awaited<ReturnType<typeof session>>, actor: string) =>
    ((await call(who, 'list_members', {})) as { members: { actor: string; state?: unknown }[] }).members.find((m) => m.actor === actor);

  // Nothing said yet: the agent is here (its session is open), but its state is null. A person's entry has none.
  expect(await entry(bo, 'ann-claude')).toStrictEqual({ actor: 'ann-claude', kind: 'agent', owner: 'ann', label: 'claude', login: null, github_id: null, here: true, state: null, owner_reads: true });
  expect(await entry(bo, 'ann')).toStrictEqual({ actor: 'ann', kind: 'person', owner: null, login: null, github_id: null, here: true });

  // A person's session is refused; a bad state is refused.
  expect(await rejection(call(ann, 'say_state', { state: 'idle' }))).toMatch(/AccessError: ann is a person: only an agent's own session says what it is doing/);
  expect(await rejection(call(agent, 'say_state', { state: 'asleep' }))).toMatch(/state/);
  expect(await rejection(call(agent, 'say_state', { state: 'idle', actor: 'bo' }))).toMatch(/unknown argument actor/);

  // Said: shown to the others and to itself, replaced by its next call.
  expect(await call(agent, 'say_state', { state: 'working' })).toStrictEqual({ state: 'working' });
  expect(await entry(bo, 'ann-claude')).toMatchObject({ here: true, state: 'working' });
  expect(await entry(agent, 'ann-claude')).toMatchObject({ state: 'working', you: true });
  await call(agent, 'say_state', { state: 'idle' });
  expect(await entry(ann, 'ann-claude')).toMatchObject({ state: 'idle' });

  // Another kolab's list never shows it.
  expect(await entry(cy, 'ann-claude')).toMatchObject({ state: null });

  // Fresh for AGENT_STATE_FRESH_SECONDS, then null; said again, back.
  now += AGENT_STATE_FRESH_SECONDS * 1000;
  expect(await entry(bo, 'ann-claude')).toMatchObject({ state: 'idle' });
  now += 1000;
  expect(await entry(bo, 'ann-claude')).toMatchObject({ here: true, state: null });
  await call(agent, 'say_state', { state: 'running' });
  expect(await entry(bo, 'ann-claude')).toMatchObject({ state: 'running' });

  // gone clears it.
  expect(await call(agent, 'say_state', { state: 'gone' })).toStrictEqual({ state: 'gone' });
  expect(await entry(bo, 'ann-claude')).toMatchObject({ state: null });

  // Ending the session clears it, and the ended session is refused.
  await call(agent, 'say_state', { state: 'idle' });
  await call(admin, 'admin_end_session', { actor: 'ann-claude' });
  expect(await entry(bo, 'ann-claude')).toMatchObject({ here: false, state: null });
  expect(await rejection(call(agent, 'say_state', { state: 'idle' }))).toMatch(/no open session|invalid|expired|401/i);

  // Revoking its access clears it too.
  agent = await session('ann-claude', 'hub');
  await call(agent, 'say_state', { state: 'working' });
  expect(await entry(bo, 'ann-claude')).toMatchObject({ state: 'working' });
  await call(admin, 'admin_revoke', { kolab: 'hub', to: 'ann-claude' });
  expect(await entry(bo, 'ann-claude')).toBeUndefined();
  await call(admin, 'admin_grant', { kolab: 'hub', to: 'ann-claude', level: 'write' });
  expect(await entry(bo, 'ann-claude')).toMatchObject({ state: null });
});

test('an agent that says nothing but listens for messages (a konnect older than say_state) reads running; a said state wins; a person\'s stream marks no agent; no other kolab sees it', async () => {
  let now = Date.parse('2026-11-18T12:00:00Z');
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()), agentStateClock: () => now });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  for (const id of ['ann', 'bo', 'cy']) await call(admin, 'admin_add_actor', { id });
  await call(admin, 'admin_add_actor', { id: 'ann-claude', owner: 'ann' });
  await call(admin, 'admin_add_actor', { id: 'bo-claude', owner: 'bo' });
  await call(admin, 'admin_add_kolab', { name: 'hub', owner: 'ann' });
  await call(admin, 'admin_add_kolab', { name: 'side', owner: 'cy' });
  for (const to of ['bo', 'ann-claude', 'bo-claude']) await call(admin, 'admin_grant', { kolab: 'hub', to, level: 'write' });
  await call(admin, 'admin_grant', { kolab: 'side', to: 'ann', level: 'write' });
  await call(admin, 'admin_grant', { kolab: 'side', to: 'ann-claude', level: 'write' });
  const session = async (actor: string, kolab: string) => {
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'engineer', kolab }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  const ann = await session('ann', 'hub');
  const bo = await session('bo', 'hub');
  const cy = await session('cy', 'side');
  const agent = await session('ann-claude', 'hub');
  await session('bo-claude', 'hub');
  type C = Awaited<ReturnType<typeof session>>;
  const stateOf = async (who: C, actor: string) =>
    ((await call(who, 'list_members', {})) as { members: { actor: string; state?: unknown }[] }).members.find((m) => m.actor === actor)?.state;
  /** Waits for the list to read `want`: a stream's opening and closing reach the server as it handles them. */
  const until = async (who: C, actor: string, want: unknown) => {
    for (let i = 0; i < 100 && (await stateOf(who, actor)) !== want; i++) await new Promise((r) => setTimeout(r, 20));
    return stateOf(who, actor);
  };

  // A person's own stream marks none of their agents, and gives the person no state.
  const annStream = await ann.listen({ resourceSubscriptions: ['konjir://answers/hub/ann'] });
  expect(await stateOf(bo, 'ann')).toBeUndefined();
  expect(await stateOf(bo, 'ann-claude')).toBeNull();

  // The agent listens and says nothing: running, to the others and to itself; the other agent, not listening, stays null.
  const stream = await agent.listen({ resourceSubscriptions: ['konjir://answers/hub/ann-claude'] });
  expect(await until(bo, 'ann-claude', 'running')).toBe('running');
  expect(await stateOf(agent, 'ann-claude')).toBe('running');
  expect(await stateOf(bo, 'bo-claude')).toBeNull();
  // No other kolab's list shows it.
  expect(await stateOf(cy, 'ann-claude')).toBeNull();

  // A said state wins over the stream, idle or working; once stale, the stream reads running again; after gone too.
  await call(agent, 'say_state', { state: 'idle' });
  expect(await stateOf(bo, 'ann-claude')).toBe('idle');
  await call(agent, 'say_state', { state: 'working' });
  expect(await stateOf(bo, 'ann-claude')).toBe('working');
  now += (AGENT_STATE_FRESH_SECONDS + 1) * 1000;
  expect(await stateOf(bo, 'ann-claude')).toBe('running');
  await call(agent, 'say_state', { state: 'idle' });
  await call(agent, 'say_state', { state: 'gone' });
  expect(await stateOf(bo, 'ann-claude')).toBe('running');

  // The stream closed: null again.
  await stream.close();
  expect(await until(bo, 'ann-claude', null)).toBeNull();
  await annStream.close();
});
