// Agents are actors of their own (W1.14; D30, DAT10, ENF4, ENF5, ROL4): each is owned by an
// account, holds its own sessions, and is the author of what it writes.
import { expect, test } from '@jest/globals';
import { ActorError } from '@konjir/engine';
import { TEST_KOLAB, els, openKolab, people, rejection } from '@konjir/engine/testing';

/** Alice, with Write on both layers of the test kolab, and three agents of hers with the same. */
async function aliceAndHerAgents() {
  const kolab = await openKolab();
  await people(kolab, []);
  await kolab.addActor('alice', { name: 'Alice' });
  await kolab.grant(TEST_KOLAB, 'alice', 'write');
  await people(kolab, ['alice-pm', 'alice-pm-2', 'alice-eng'], { owner: 'alice' });
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
    kolab: TEST_KOLAB, access: { level: 'write', layers: ['functional', 'technical'] },
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
  expect(await rejection(kolab.openSession('alice-pm', 'engineer'))).toMatch(/ActorError: alice-pm already has an open session; end it before opening another/);
  await kolab.openSession('alice-pm-2', 'engineer');   // her other agent is unaffected
  await kolab.endSession(first);
  expect(await kolab.sessionInfo(await kolab.openSession('alice-pm', 'engineer'))).toMatchObject({ actor: 'alice-pm', role: 'engineer' });
});

test("an agent's owner must be an account that exists", async () => {
  const kolab = await aliceAndHerAgents();
  expect(await rejection(kolab.addActor('stray', { owner: 'nobody' }))).toMatch(/ActorError: no account nobody to own stray/);
  expect(await rejection(kolab.addActor('sub-agent', { owner: 'alice-pm' }))).toMatch(/ActorError: alice-pm is an agent/);
  await expect(kolab.openSession('nobody', 'product')).rejects.toBeInstanceOf(ActorError);
  expect(await kolab.listActors({ owner: 'alice' })).toStrictEqual([
    { id: 'alice-eng', name: 'alice-eng', kind: 'agent', owner: 'alice' },
    { id: 'alice-pm', name: 'alice-pm', kind: 'agent', owner: 'alice' },
    { id: 'alice-pm-2', name: 'alice-pm-2', kind: 'agent', owner: 'alice' },
  ]);
  expect(await kolab.actor('alice')).toStrictEqual({ id: 'alice', name: 'Alice', kind: 'person', owner: null });
});

test('the database refuses an agent with no owner, a person with one, an agent owned by an agent, a person with no user account, and a bad id', async () => {
  const kolab = await aliceAndHerAgents();
  const insert = (id: string, kind: string, owner: string | null) =>
    kolab.db.query(`insert into actor(id, name, kind, owner_id) values ($1, $1, $2, $3)`, [id, kind, owner]);
  expect(await rejection(insert('orphan', 'agent', null))).toMatch(/actor_owner_check/);
  expect(await rejection(insert('owned-person', 'person', 'alice'))).toMatch(/actor_owner_check/);
  expect(await rejection(insert('sub-agent', 'agent', 'alice-pm'))).toMatch(/actor_owner_is_account/);
  expect(await rejection(insert('stray', 'agent', 'nobody'))).toMatch(/actor_owner_is_account/);
  expect(await rejection(insert('no-account', 'person', null))).toMatch(/actor_person_is_user/);
  expect(await rejection(insert('robot', 'robot', null))).toMatch(/actor_kind_check/);
  expect(await rejection(insert('kolab', 'person', null))).toMatch(/actor_id_check/);
  expect(await rejection(insert('', 'person', null))).toMatch(/actor_id_check/);
  expect(await rejection(insert('a b', 'person', null))).toMatch(/actor_id_check/);
});

test("an actor's kind and owner never change, so past authorship can't be rewritten", async () => {
  const kolab = await aliceAndHerAgents();
  await kolab.addActor('bob');
  await kolab.addActor('carol');
  const update = (sql: string) => kolab.db.query(`update actor set ${sql}`);
  expect(await rejection(update(`owner_id = 'bob' where id = 'alice-pm'`))).toMatch(/actor alice-pm: kind and owner never change/);
  expect(await rejection(update(`kind = 'person', owner_id = null where id = 'alice-pm'`))).toMatch(/kind and owner never change/);
  expect(await rejection(update(`kind = 'agent', owner_id = 'bob' where id = 'carol'`))).toMatch(/kind and owner never change/);
  expect(await rejection(update(`kind = 'agent', owner_id = 'bob' where id = 'alice'`))).toMatch(/kind and owner never change/);
  await update(`name = 'Alice Liddell' where id = 'alice'`);   // a name may change
  expect(await kolab.actor('alice-pm')).toMatchObject({ kind: 'agent', owner: 'alice' });
});

test('an actor id must be valid, new and not the reserved kolab', async () => {
  const kolab = await aliceAndHerAgents();
  expect(await rejection(kolab.addActor('alice'))).toMatch(/ActorError: actor alice already exists/);
  expect(await rejection(kolab.addActor('alice-pm', { owner: 'alice' }))).toMatch(/ActorError: actor alice-pm already exists/);
  expect(await rejection(kolab.addActor('kolab'))).toMatch(/ActorError: "kolab" is reserved/);
  expect(await rejection(kolab.addActor(''))).toMatch(/ActorError: "" isn't a valid actor id/);
  expect(await rejection(kolab.addActor('two words'))).toMatch(/ActorError: "two words" isn't a valid actor id/);
  await kolab.addActor('lee@konjir.com');
});

test("row-level security: an agent's session writes only as its own actor and role, never as its owner", async () => {
  const kolab = await aliceAndHerAgents();
  const pm = await kolab.openSession('alice-pm', 'product');
  await kolab.openSession('alice-pm-2', 'product');
  const spec = await kolab.createNode(pm, 'functional_spec', 'Checkout', 'checkout');
  const v1 = await kolab.commit(pm, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  const asAgent = (sql: string, params: unknown[]) => kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [pm]);
    await tx.query(sql, params);
  });
  const draftBy = (id: string, actor: string, role: string) => asAgent(
    `insert into version(id, node_id, seq, layer, state, actor_id, active_role)
     values ($1, $2, 90, 'functional', 'drafted', $3, $4)`, [id, spec, actor, role]);

  for (const [actor, role] of [['alice', 'product'], ['alice-pm-2', 'product'], ['kolab', 'system'], ['alice-pm', 'engineer']]) {
    expect(await rejection(draftBy(`v-${actor}-${role}`, actor, role))).toMatch(/row-level security/);
  }
  await draftBy('v-own', 'alice-pm', 'product');   // as itself, in its own role

  // Elements and deltas go only into the session's own drafts.
  await kolab.db.query(`insert into version(id, node_id, seq, layer, state, actor_id, active_role)
                        values ('v-other', $1, 91, 'functional', 'drafted', 'alice-pm-2', 'product')`, [spec]);
  const element = (version: string) => asAgent(
    `insert into element(version_id, element_id, ord, text, fingerprint) values ($1, 'R9', 0, 'x', 'x')`, [version]);
  expect(await rejection(element('v-other'))).toMatch(/row-level security/);
  await element('v-own');
  const delta = (id: string, version: string) => asAgent(
    `insert into delta(id, version_id, element_id, kind, text) values ($1, $2, 'R9', 'add', 'x')`, [id, version]);
  expect(await rejection(delta('d-other', 'v-other'))).toMatch(/row-level security/);
  await delta('d-own', 'v-own');

  // A question is raised by the session's own actor, and unanswered.
  const query = (id: string, raisedBy: string, answeredBy: string | null = null) => asAgent(
    `insert into query(id, version_id, question, raised_by, answered_by) values ($1, $2, 'Why?', $3, $4)`, [id, v1, raisedBy, answeredBy]);
  expect(await rejection(query('q-owner', 'alice'))).toMatch(/row-level security/);
  expect(await rejection(query('q-answered', 'alice-pm', 'alice'))).toMatch(/row-level security/);
  await query('q-own', 'alice-pm');
});

test("author() takes the system from the version's role, and refuses a version whose actor is gone", async () => {
  const kolab = await aliceAndHerAgents();
  const pm = await kolab.openSession('alice-pm', 'product');
  const spec = await kolab.createNode(pm, 'functional_spec', 'Checkout', 'checkout');
  await kolab.db.query(`insert into version(id, node_id, seq, layer, state, actor_id, active_role)
                        values ('v-ghost', $1, 1, 'functional', 'committed', 'ghost', 'product')`, [spec]);
  expect(await rejection(kolab.author('v-ghost'))).toMatch(/ActorError: version v-ghost names actor ghost, who doesn't exist/);
});
