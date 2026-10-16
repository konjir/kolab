// Agents are actors of their own (W1.14; D30, DAT10, ENF4, ENF5, ROL4): each is owned by a
// person, holds its own sessions, and is the author of what it writes.
import { expect, test } from '@jest/globals';
import { ActorError } from '@konjir/engine';
import { els, openKolab, rejection } from '@konjir/engine/testing';

async function aliceAndHerAgents() {
  const kolab = await openKolab();
  await kolab.addActor('alice', { name: 'Alice' });
  await kolab.addActor('alice-pm', { owner: 'alice' });
  await kolab.addActor('alice-pm-2', { owner: 'alice' });
  await kolab.addActor('alice-eng', { owner: 'alice' });
  return kolab;
}

test('two agents of one person hold sessions at the same time, and each version records the agent that wrote it', async () => {
  const kolab = await aliceAndHerAgents();
  const pm = await kolab.openSession('alice-pm', 'product');
  const pm2 = await kolab.openSession('alice-pm-2', 'product');
  const eng = await kolab.openSession('alice-eng', 'engineer');
  const self = await kolab.openSession('alice', 'product');   // the owner keeps her own session too

  expect(await kolab.sessionInfo(pm)).toStrictEqual({
    session: pm, actor: 'alice-pm', kind: 'agent', owner: 'alice', role: 'product', layer: 'functional',
  });
  expect(await kolab.sessionInfo(pm2)).toMatchObject({ actor: 'alice-pm-2', kind: 'agent', owner: 'alice' });
  expect(await kolab.sessionInfo(self)).toMatchObject({ actor: 'alice', kind: 'person', owner: null });

  // Both product agents write the same spec, one version each, while both sessions are open.
  const spec = await kolab.createNode(pm, 'functional_spec', 'Checkout', 'checkout');
  const v1 = await kolab.commit(pm, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  const v2 = await kolab.commit(pm2, spec, { elements: els({ R1: 'Checkout completes in 10 seconds.' }) });
  const binding = await kolab.createNode(eng, 'technical_binding', 'Checkout on Postgres', 'checkout-pg');
  const b1 = await kolab.commit(eng, binding, { elements: els({ b1: 'A queue worker finalizes orders.' }) });

  expect(await kolab.author(v1)).toStrictEqual({ actor: 'alice-pm', kind: 'agent', owner: 'alice', role: 'product' });
  expect(await kolab.author(v2)).toStrictEqual({ actor: 'alice-pm-2', kind: 'agent', owner: 'alice', role: 'product' });
  expect(await kolab.author(b1)).toStrictEqual({ actor: 'alice-eng', kind: 'agent', owner: 'alice', role: 'engineer' });
  expect((await kolab.version(v2)).actor_id).toBe('alice-pm-2');

  // Questions are raised by the agent, so its answers inbox is its own.
  const q = await kolab.raiseQuery(eng, 'kj:checkout#R1', 'Is 10 seconds a hard limit?');
  expect((await kolab.listQueries({ raisedBy: 'alice-eng' })).map((x) => x.id)).toStrictEqual([q]);
  expect(await kolab.listQueries({ raisedBy: 'alice' })).toStrictEqual([]);
  await kolab.answerQuery(pm2, q, 'Yes.');
  expect((await kolab.listQueries({ raisedBy: 'alice-eng' }))[0].answered_by).toBe('alice-pm-2');
});

test("Kolab's own rebases are authored by the system, not by a person or an agent", async () => {
  const kolab = await aliceAndHerAgents();
  const pm = await kolab.openSession('alice-pm', 'product');
  const spec = await kolab.createNode(pm, 'functional_spec', 'Storefront', 'storefront');
  const parent = await kolab.commit(pm, spec, { elements: els({ R1: 'Prices show in dollars.' }) });
  const child = await kolab.createNode(pm, 'functional_spec', 'EU storefront', 'storefront-eu');
  await kolab.commit(pm, child, { parent, deltas: [{ kind: 'override', element: 'R1', text: 'Prices show in euros.' }] });
  await kolab.commit(pm, spec, { elements: els({ R1: 'Prices show in dollars.', R2: 'Carts persist.' }) });
  const rebased = (await kolab.latestCommitted(child))!;
  expect(await kolab.author(rebased.id)).toStrictEqual({ actor: 'kolab', kind: 'system', owner: null, role: 'system' });
});

test('one open session per agent: an agent with a session must end it before opening another', async () => {
  const kolab = await aliceAndHerAgents();
  const first = await kolab.openSession('alice-pm', 'product');
  expect(await rejection(kolab.openSession('alice-pm', 'engineer'))).toMatch(/RoleError: alice-pm already has an open session/);
  await kolab.openSession('alice-pm-2', 'engineer');   // her other agent is unaffected
  await kolab.endSession(first);
  expect(await kolab.sessionInfo(await kolab.openSession('alice-pm', 'engineer'))).toMatchObject({ actor: 'alice-pm', role: 'engineer' });
});

test("an agent's owner must be a person who exists", async () => {
  const kolab = await aliceAndHerAgents();
  expect(await rejection(kolab.addActor('stray', { owner: 'nobody' }))).toMatch(/ActorError: no actor nobody to own stray/);
  expect(await rejection(kolab.addActor('sub-agent', { owner: 'alice-pm' }))).toMatch(/ActorError: alice-pm is an agent/);
  await expect(kolab.openSession('nobody', 'product')).rejects.toBeInstanceOf(ActorError);
  expect(await kolab.listActors({ owner: 'alice' })).toStrictEqual([
    { id: 'alice-eng', name: 'alice-eng', kind: 'agent', owner: 'alice' },
    { id: 'alice-pm', name: 'alice-pm', kind: 'agent', owner: 'alice' },
    { id: 'alice-pm-2', name: 'alice-pm-2', kind: 'agent', owner: 'alice' },
  ]);
  expect(await kolab.actor('alice')).toStrictEqual({ id: 'alice', name: 'Alice', kind: 'person', owner: null });
});

test('the database refuses an agent with no owner, a person with one, an agent owned by an agent, and an owner turned agent', async () => {
  const kolab = await aliceAndHerAgents();
  const insert = (id: string, kind: string, owner: string | null) =>
    kolab.db.query(`insert into actor(id, name, kind, owner_id) values ($1, $1, $2, $3)`, [id, kind, owner]);
  expect(await rejection(insert('orphan', 'agent', null))).toMatch(/actor_owner_check/);
  expect(await rejection(insert('owned-person', 'person', 'alice'))).toMatch(/actor_owner_check/);
  expect(await rejection(insert('sub-agent', 'agent', 'alice-pm'))).toMatch(/actor_owner_is_person/);
  expect(await rejection(insert('stray', 'agent', 'nobody'))).toMatch(/actor_owner_is_person/);
  expect(await rejection(insert('robot', 'robot', null))).toMatch(/actor_kind_check/);
  // Alice owns agents, so she can't become an agent herself.
  await kolab.addActor('bob');
  expect(await rejection(kolab.db.query(`update actor set kind = 'agent', owner_id = 'bob' where id = 'alice'`))).toMatch(/actor_owner_is_person/);
});
