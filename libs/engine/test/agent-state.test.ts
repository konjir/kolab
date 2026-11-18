// konjir_say_state's session check (agentStateSession): an agent's own session that is a member of
// its kolab, read quietly (no work or job lease renewed), and still refused once ended or revoked.
// What it says is kept by the server (apps/server's AgentStates), never in the database.
import { expect, test } from '@jest/globals';
import { openKolab, rejection } from '@konjir/engine/testing';

async function hub() {
  const k = await openKolab();
  for (const id of ['ann', 'bo']) await k.addActor(id);
  await k.addActor('ann-claude', { owner: 'ann' });
  await k.createKolab('hub', { owner: 'ann' });
  await k.grant('hub', 'bo', 'write');
  await k.grant('hub', 'ann-claude', 'write');
  const ann = await k.openSession('ann', 'engineer', { kolab: 'hub' });
  const agent = await k.openSession('ann-claude', 'engineer', { kolab: 'hub' });
  return { kolab: k, ann, agent };
}

test('an agent\'s own session is named by its key, actor and kolab; a person\'s is refused', async () => {
  const { kolab, ann, agent } = await hub();
  expect(await kolab.agentStateSession(agent)).toStrictEqual({ session: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), actor: 'ann-claude', kolab: 'hub' });
  expect(await rejection(kolab.agentStateSession(ann))).toBe('AccessError: ann is a person: only an agent\'s own session says what it is doing');
});

test('it is quiet: it renews no work lease, as any other agent call does', async () => {
  const { kolab, agent } = await hub();
  const calls: string[] = [];
  const k = kolab as unknown as { renewLease: (...a: unknown[]) => Promise<void> };
  const renew = k.renewLease;
  k.renewLease = async function (this: unknown, ...a: unknown[]) { calls.push(String(a[0])); return renew.apply(this, a); };
  try {
    await kolab.agentStateSession(agent);
    await kolab.agentStateSession(agent);
    expect(calls).toStrictEqual([]);
    // A call that isn't quiet does renew: the check can see one.
    await kolab.listLeases(agent);
    expect(calls).toStrictEqual(['ann-claude']);
  } finally { k.renewLease = renew; }
});

test('an ended or revoked session is refused', async () => {
  const { kolab, agent } = await hub();
  await kolab.revoke('hub', 'ann-claude');
  expect(await rejection(kolab.agentStateSession(agent))).toMatch(/no open session for that token|can no longer reach kolab hub/);
  await kolab.grant('hub', 'ann-claude', 'write');
  const again = await kolab.openSession('ann-claude', 'engineer', { kolab: 'hub' });
  await kolab.agentStateSession(again);
  await kolab.endSession(again, { signingOut: true });
  expect(await rejection(kolab.agentStateSession(again))).toMatch(/^RoleError: no open session for that token/);
});

test('the agents listening in a kolab, from listening sessions\' ids: only an agent\'s own open session of that kolab counts', async () => {
  const { kolab, agent } = await hub();
  await kolab.createKolab('side', { owner: 'ann' });
  const ids = (await kolab.db.query<{ id: string }>(`select id from session where ended_at is null order by actor_id`)).rows.map((r) => r.id);
  const { session } = await kolab.agentStateSession(agent);
  // The person's session among them marks no one; the agent's marks it, in its own kolab alone.
  expect(await kolab.agentsListeningIn('hub', ids)).toStrictEqual(new Set(['ann-claude']));
  expect(await kolab.agentsListeningIn('side', ids)).toStrictEqual(new Set());
  expect(await kolab.agentsListeningIn('hub', ids.filter((id) => id !== session))).toStrictEqual(new Set());
  expect(await kolab.agentsListeningIn('hub', [])).toStrictEqual(new Set());
  // Ended: no longer.
  await kolab.endSession(agent, { signingOut: true });
  expect(await kolab.agentsListeningIn('hub', ids)).toStrictEqual(new Set());
});
