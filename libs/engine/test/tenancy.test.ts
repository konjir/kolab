// Accounts, kolabs, teams and grants (W1.3; DAT10, TEN1–TEN12, D3, D7, D12, D30): every row is
// keyed by its kolab, a session reaches only its own kolab, kolab names are unique across the
// whole database, and an agent never holds more access than its owner.
import { expect, test } from '@jest/globals';
import { AccessError, sessionKey, TenancyError, type Kolab } from '@konjir/engine';
import type { KolabEvent } from '@konjir/types';
import { els, openKolab, rejection } from '@konjir/engine/testing';

const WRITE_BOTH = { level: 'write', layers: ['functional', 'technical'] };

/** Two accounts, each owning a kolab with a spec in it: alice's `orders`, bob's `billing`. */
async function twoAccounts() {
  const kolab = await openKolab();
  await kolab.addActor('alice');
  await kolab.addActor('bob');
  await kolab.createKolab('orders', { owner: 'alice' });
  await kolab.createKolab('billing', { owner: 'bob' });
  const alice = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'product');
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  await kolab.commit(alice, 'orders-spec', { elements: els({ R1: 'Orders can be cancelled.' }) });
  await kolab.createNode(bob, 'functional_spec', 'Billing', 'billing-spec');
  await kolab.commit(bob, 'billing-spec', { elements: els({ B1: 'Invoices are monthly.' }) });
  return { kolab, alice, bob };
}

/** Runs `sql` as kj_agent in `session`, as the engine runs an agent's writes, so row-level security applies. */
const asAgent = <T extends Record<string, unknown>>(kolab: Kolab, session: string, sql: string, params: unknown[] = []) =>
  kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [session]);
    return (await tx.query<T>(sql, params)).rows;
  });

test("two accounts' kolabs can't see each other", async () => {
  const { kolab, alice, bob } = await twoAccounts();
  expect(await kolab.sessionInfo(alice)).toMatchObject({ actor: 'alice', kolab: 'orders', access: { level: 'admin', layers: ['functional', 'technical'] } });
  expect(await kolab.access('alice', 'billing')).toStrictEqual({ level: null, layers: [] });

  // Through Kolab: each session lists, reads, writes and asks only inside its own kolab.
  expect((await kolab.listNodes(undefined, await kolab.sessionKolab(alice))).map((n) => n.id)).toStrictEqual(['orders-spec']);
  expect((await kolab.listNodes(undefined, await kolab.sessionKolab(bob))).map((n) => n.id)).toStrictEqual(['billing-spec']);
  expect(await rejection(kolab.requireNodeIn(alice, 'billing-spec'))).toMatch(/no node billing-spec in kolab orders/);
  expect(await rejection(kolab.draft(alice, 'billing-spec', { elements: els({ B1: 'Invoices are weekly.' }) })))
    .toMatch(/no node billing-spec in kolab orders/);
  expect(await rejection(kolab.draft(alice, 'no-such-spec', { elements: els({ B1: 'Invoices are weekly.' }) })))
    .toMatch(/no node no-such-spec in kolab orders/);   // the same as a node that doesn't exist
  expect(await rejection(kolab.raiseQuery(alice, 'kj:billing-spec#B1', 'Why monthly?'))).toMatch(/no node billing-spec in kolab orders/);
  await kolab.raiseQuery(bob, 'kj:billing-spec#B1', 'Why monthly?');
  expect(await kolab.listQueries({ kolab: 'orders' })).toStrictEqual([]);
  expect(await kolab.listQueries({ kolab: 'billing' })).toHaveLength(1);
  // Neither can open a session in the other's kolab.
  await kolab.endSession(alice);
  expect(await rejection(kolab.openSession('alice', 'product', { kolab: 'billing' }))).toMatch(/AccessError: alice has no access to kolab billing/);

  // Row-level security repeats it in the database: as kj_agent, a session sees only its kolab's rows.
  const tables = ['node', 'version', 'element', 'delta', 'edge', 'invalidation', 'query'];
  const seen = async (session: string) => Object.fromEntries(await Promise.all(tables.map(async (t) =>
    [t, (await asAgent<{ kolab_id: string }>(kolab, session, `select distinct kolab_id from ${t}`)).map((r) => r.kolab_id)])));
  expect(await seen(bob)).toStrictEqual({ node: ['billing'], version: ['billing'], element: ['billing'], delta: ['billing'], edge: [], invalidation: [], query: ['billing'] });
  expect((await asAgent(kolab, bob, `select id from node where id = 'orders-spec'`))).toStrictEqual([]);
  // And refuses a draft on the other kolab's node, even one that names the node outright.
  const v1 = (await kolab.latestCommitted('orders-spec'))!;
  expect(await rejection(asAgent(kolab, bob,
    `insert into version(id, node_id, seq, layer, state, actor_id, active_role, base_version_id)
     values ('intruder', 'orders-spec', 9, 'functional', 'drafted', 'bob', 'product', $1)`, [v1.id]))).toMatch(/row-level security/);
  // An ended session reaches nothing at all.
  expect(await asAgent(kolab, alice, `select id from node`)).toStrictEqual([]);
});

test('every row carries the kolab of what it belongs to, whatever its writer says', async () => {
  const { kolab, alice } = await twoAccounts();
  const v = (await kolab.latestCommitted('orders-spec'))!;
  expect(v.kolab_id).toBe('orders');
  // A row's kolab is its parent's: a writer can't place it elsewhere.
  await kolab.db.query(`insert into element(version_id, element_id, ord, text, fingerprint, kolab_id) values ($1, 'R9', 9, 'x', 'x', 'billing')`, [v.id]);
  expect((await kolab.db.query(`select kolab_id from element where element_id = 'R9'`)).rows).toStrictEqual([{ kolab_id: 'orders' }]);
  // A node with no kolab is refused.
  expect(await rejection(kolab.db.query(`insert into node(id, kind, layer, title) values ('loose', 'functional_spec', 'functional', 'Loose')`))).toMatch(/kolab_id/);
  expect((await kolab.sessionInfo(alice)).kolab).toBe('orders');
});

test('a kolab name is unique across the whole database: a duplicate is refused, whoever owns it', async () => {
  const { kolab } = await twoAccounts();
  await kolab.addOrganization('acme');
  expect(await rejection(kolab.createKolab('orders', { owner: 'bob' }))).toMatch(/TenancyError: the kolab name orders is taken: kolab names are unique across all of Konjir/);
  expect(await rejection(kolab.createKolab('orders', { owner: 'acme' }))).toMatch(/the kolab name orders is taken/);
  expect(await rejection(kolab.createKolab('Orders', { owner: 'acme' }))).toMatch(/TenancyError: "Orders" isn't a valid kolab name/);
  // The database refuses it too, and any name that differs only by case can't exist.
  expect(await rejection(kolab.db.query(`insert into kolab(id, owner_id, title) values ('orders', 'acme', 'Again')`))).toMatch(/kolab_pkey/);
  expect(await rejection(kolab.db.query(`insert into kolab(id, owner_id, title) values ('ORDERS', 'acme', 'Again')`))).toMatch(/kolab_name_check/);
  // Two calls at once: exactly one wins.
  const results = await Promise.allSettled([kolab.createKolab('shop', { owner: 'alice' }), kolab.createKolab('shop', { owner: 'bob' })]);
  expect(results.map((r) => r.status).sort()).toStrictEqual(['fulfilled', 'rejected']);
  expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/the kolab name shop is taken/);
  expect((await kolab.listKolabs()).map((k) => k.id)).toStrictEqual(['billing', 'orders', 'shop']);
});

test("a grant its owner lacks is refused: an agent is never granted more than its owner holds (TEN11, D30)", async () => {
  const { kolab } = await twoAccounts();
  await kolab.addActor('carol');
  await kolab.grant('orders', 'carol', 'write', { layers: ['technical'] });
  await kolab.addActor('carol-eng', { owner: 'carol' });

  expect(await rejection(kolab.grant('orders', 'carol-eng', 'maintain')))
    .toMatch(/AccessError: carol-eng's owner carol holds Write on the technical layer in kolab orders, so carol-eng can't be granted Maintain: an agent never holds more access than its owner/);
  expect(await rejection(kolab.grant('orders', 'carol-eng', 'write', { layers: ['functional'] }))).toMatch(/can't be granted Write on the functional layer/);
  expect(await rejection(kolab.grant('orders', 'carol-eng', 'write'))).toMatch(/can't be granted Write on both layers/);
  expect(await rejection(kolab.grant('billing', 'carol-eng', 'read'))).toMatch(/carol holds no access in kolab billing/);
  await kolab.grant('orders', 'carol-eng', 'write', { layers: ['technical'] });
  await kolab.grant('orders', 'carol-eng', 'read');   // less is fine, and replaces the grant
  expect(await kolab.access('carol-eng', 'orders')).toStrictEqual({ level: 'read', layers: [] });
  expect((await kolab.db.query(`select count(*)::int as n from kolab_grant where agent_id = 'carol-eng'`)).rows[0]).toStrictEqual({ n: 1 });
});

test("an agent's grant is checked against its owner's when its session opens", async () => {
  const { kolab } = await twoAccounts();
  await kolab.addActor('carol');
  await kolab.grant('orders', 'carol', 'write');
  await kolab.addActor('carol-pm', { owner: 'carol' });
  await kolab.grant('orders', 'carol-pm', 'write');

  // Carol's own grant shrinks to Write on the technical layer only. Her agent's grant still
  // says both, but it opens a session holding only what she does.
  await kolab.grant('orders', 'carol', 'write', { layers: ['technical'] });
  const pm = await kolab.openSession('carol-pm', 'product', { kolab: 'orders' });
  expect((await kolab.sessionInfo(pm)).access).toStrictEqual({ level: 'write', layers: ['technical'] });
  expect(await rejection(kolab.draft(pm, 'orders-spec', { elements: els({ R1: 'Orders can be cancelled by staff.' }) })))
    .toMatch(/AccessError: carol-pm may not write the functional layer of kolab orders: it holds Write on the technical layer, its own grant cut down to its owner carol's/);
  await kolab.endSession(pm);

  // With nothing left of carol's, her agent can't open one at all, though its own grant stands.
  await kolab.revoke('orders', 'carol');
  expect(await rejection(kolab.openSession('carol-pm', 'product', { kolab: 'orders' })))
    .toMatch(/AccessError: carol-pm has no access to kolab orders: an agent's access is its own grant there, never more than its owner carol's/);
  // Her grant back, and its session opens as before.
  await kolab.grant('orders', 'carol', 'write');
  expect((await kolab.sessionInfo(await kolab.openSession('carol-pm', 'product', { kolab: 'orders' }))).access).toStrictEqual(WRITE_BOTH);
});

test("an agent's sessions narrow when its owner's grant shrinks, and end when it goes", async () => {
  const { kolab } = await twoAccounts();
  await kolab.addActor('carol');
  await kolab.grant('orders', 'carol', 'write');
  await kolab.addActor('carol-pm', { owner: 'carol' });
  await kolab.grant('orders', 'carol-pm', 'write');
  const pm = await kolab.openSession('carol-pm', 'product');   // its one kolab
  const draft = await kolab.draft(pm, 'orders-spec', { elements: els({ R1: 'Orders can be cancelled by staff.' }) });
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));

  // Narrowed: carol drops to Read. The session stays open and can still read and ask, but
  // can't draft, in Kolab or in the database.
  expect(await kolab.grant('orders', 'carol', 'read')).toStrictEqual({ ended: 0 });
  expect(await kolab.sessionOpen(pm)).toBe(true);
  expect((await kolab.sessionInfo(pm)).access).toStrictEqual({ level: 'read', layers: [] });
  expect(await rejection(kolab.draft(pm, 'orders-spec', { elements: els({ R1: 'Orders can be cancelled by anyone.' }) }))).toMatch(/AccessError: carol-pm may not write the functional layer of kolab orders: it holds Read/);
  expect(await rejection(asAgent(kolab, pm, `insert into element(version_id, element_id, ord, text, fingerprint) values ($1, 'R2', 1, 'x', 'x')`, [draft])))
    .toMatch(/row-level security/);
  expect((await asAgent(kolab, pm, `select id from node`)).map((r) => r.id)).toStrictEqual(['orders-spec']);
  await kolab.raiseQuery(pm, 'kj:orders-spec#R1', 'Who may cancel?');
  expect(events.filter((e) => 'session' in e)).toStrictEqual([]);

  // Ended: carol's access goes. The session ends, its token is revoked, and listeners are told
  // so its streams close (D41).
  expect(await kolab.revoke('orders', 'carol')).toStrictEqual({ ended: 1 });
  expect(await kolab.sessionOpen(pm)).toBe(false);
  expect(events).toContainEqual({ session: 'ended', id: sessionKey(pm) });
  expect(await asAgent(kolab, pm, `select id from node`)).toStrictEqual([]);
});

test('a session ends when its own access goes, whether by a grant, a team or an organization', async () => {
  const { kolab } = await twoAccounts();
  await kolab.addOrganization('acme');
  await kolab.addActor('dan');
  await kolab.addMember('acme', 'dan');
  await kolab.addTeam('acme', 'eng');
  await kolab.addTeam('acme', 'platform', { parent: 'eng' });
  await kolab.addTeamMember('acme/platform', 'dan');
  await kolab.createKolab('acme-api', { owner: 'acme' });
  await kolab.grant('acme-api', 'acme/eng', 'write', { layers: ['technical'] });   // the parent team's grant reaches its child's members

  const s = await kolab.openSession('dan', 'engineer');
  expect((await kolab.sessionInfo(s)).access).toStrictEqual({ level: 'write', layers: ['technical'] });
  expect(await kolab.removeTeamMember('acme/platform', 'dan')).toStrictEqual({ ended: 1 });
  expect(await kolab.sessionOpen(s)).toBe(false);

  // Membership with a base permission, then leaving the organization.
  await kolab.addActor('erin');
  await kolab.addMember('acme', 'erin');
  await kolab.createKolab('acme-web', { owner: 'acme', base: 'read' });
  const e = await kolab.openSession('erin', 'product', { kolab: 'acme-web' });
  expect((await kolab.sessionInfo(e)).access).toStrictEqual({ level: 'read', layers: [] });
  expect(await kolab.removeMember('acme', 'erin')).toStrictEqual({ ended: 1 });
  expect(await kolab.sessionOpen(e)).toBe(false);
});

test('an organization can own agents: they work in its kolabs, and hold nothing in anyone else\'s', async () => {
  const { kolab, bob } = await twoAccounts();
  await kolab.addOrganization('acme', { name: 'Acme' });
  await kolab.createKolab('acme-api', { owner: 'acme' });
  await kolab.addActor('acme-bot', { owner: 'acme' });
  expect(await kolab.actor('acme-bot')).toStrictEqual({ id: 'acme-bot', name: 'acme-bot', kind: 'agent', owner: 'acme' });
  expect(await kolab.listActors({ owner: 'acme' })).toHaveLength(1);

  // Not until it is granted access, and then only what it is granted.
  expect(await rejection(kolab.openSession('acme-bot', 'product'))).toMatch(/AccessError: acme-bot has no access to any kolab/);
  await kolab.grant('acme-api', 'acme-bot', 'write', { layers: ['functional'] });
  const s = await kolab.openSession('acme-bot', 'product');
  expect(await kolab.sessionInfo(s)).toMatchObject({ actor: 'acme-bot', kind: 'agent', owner: 'acme', kolab: 'acme-api', access: { level: 'write', layers: ['functional'] } });
  await kolab.createNode(s, 'functional_spec', 'API', 'api');
  const v = await kolab.commit(s, 'api', { elements: els({ A1: 'Requests are authenticated.' }) });
  expect(await kolab.author(v)).toStrictEqual({ actor: 'acme-bot', kind: 'agent', owner: 'acme', role: 'product' });

  // An organization holds nothing in a kolab it doesn't own, so neither can its agents.
  expect(await rejection(kolab.grant('billing', 'acme-bot', 'read'))).toMatch(/AccessError: acme-bot's owner acme holds no access in kolab billing/);
  expect((await kolab.listNodes(undefined, await kolab.sessionKolab(bob))).map((n) => n.id)).toStrictEqual(['billing-spec']);
  // An organization is never a grantee itself.
  expect(await rejection(kolab.grant('acme-api', 'acme', 'read'))).toMatch(/TenancyError: acme is an organization: grant access to its members or teams/);
});

test('access follows the GitHub model: owners, organization owners, base permission, teams, collaborators, visibility (TEN6–TEN10)', async () => {
  const kolab = await openKolab();
  await kolab.addOrganization('acme');
  for (const id of ['olga', 'mia', 'tom', 'otto', 'pat']) await kolab.addActor(id);
  await kolab.addMember('acme', 'olga', 'owner');
  await kolab.addMember('acme', 'mia');
  await kolab.addMember('acme', 'tom');
  await kolab.addTeam('acme', 'eng');
  await kolab.addTeamMember('acme/eng', 'tom');
  await kolab.createKolab('api', { owner: 'acme', base: 'triage', visibility: 'internal' });
  await kolab.grant('api', 'acme/eng', 'write', { layers: ['technical'] });
  await kolab.grant('api', 'otto', 'write', { layers: ['functional'] });   // an outside collaborator
  await kolab.createKolab('site', { owner: 'pat', visibility: 'public' });

  const access = async (actor: string, k: string) => (await kolab.access(actor, k));
  expect(await access('olga', 'api')).toStrictEqual({ level: 'admin', layers: ['functional', 'technical'] });
  expect(await access('mia', 'api')).toStrictEqual({ level: 'triage', layers: [] });
  expect(await access('tom', 'api')).toStrictEqual({ level: 'write', layers: ['technical'] });
  expect(await access('otto', 'api')).toStrictEqual({ level: 'write', layers: ['functional'] });
  expect(await access('pat', 'api')).toStrictEqual({ level: null, layers: [] });
  expect(await access('pat', 'site')).toStrictEqual({ level: 'admin', layers: ['functional', 'technical'] });
  expect(await access('mia', 'site')).toStrictEqual({ level: 'read', layers: [] });   // public

  // What a grant may say.
  expect(await rejection(kolab.grant('api', 'mia', 'read', { layers: ['functional'] }))).toMatch(/TenancyError: only a Write grant names its layers/);
  expect(await rejection(kolab.grant('api', 'mia', 'write', { layers: [] }))).toMatch(/TenancyError: a Write grant names the layers it covers/);
  expect(await rejection(kolab.grant('site', 'acme/eng', 'read'))).toMatch(/TenancyError: team acme\/eng belongs to acme; only the owning organization's teams/);
  expect(await rejection(kolab.grant('api', 'nobody', 'read'))).toMatch(/TenancyError: no person, team or agent nobody/);
  expect(await rejection(kolab.addTeamMember('acme/eng', 'pat'))).toMatch(/TenancyError: pat isn't a member of acme/);
  expect(await rejection(kolab.addOrganization('mia'))).toMatch(/TenancyError: account mia already exists/);
  expect(await rejection(kolab.addActor('acme'))).toMatch(/ActorError: account acme already exists/);
  // The database's own checks.
  expect(await rejection(kolab.db.query(`insert into kolab_grant(kolab_id, user_id, level, functional, technical) values ('api', 'pat', 'read', true, false)`))).toMatch(/kolab_grant_layers/);
  expect(await rejection(kolab.db.query(`insert into kolab_grant(kolab_id, user_id, agent_id, level, functional, technical) values ('api', 'pat', 'pat', 'read', false, false)`))).toMatch(/kolab_grant_one_grantee|kolab_grant_agent/);
  expect(await rejection(kolab.db.query(`insert into org_member(org_id, user_id) values ('mia', 'pat')`))).toMatch(/org_member_org_id_org_kind_fkey/);
});

test('openSession needs the kolab named when an actor reaches several', async () => {
  const { kolab, alice } = await twoAccounts();
  await kolab.endSession(alice);
  await kolab.grant('billing', 'alice', 'read');
  expect(await rejection(kolab.openSession('alice', 'product'))).toMatch(/AccessError: alice can reach the kolabs billing, orders; name the one to open the session in/);
  expect((await kolab.sessionInfo(await kolab.openSession('alice', 'product', { kolab: 'billing' }))).access).toStrictEqual({ level: 'read', layers: [] });
  expect(await rejection(kolab.openSession('bob', 'product', { kolab: 'nowhere' }))).toMatch(/TenancyError: no kolab nowhere/);
  expect(TenancyError.name).toBe('TenancyError');
  expect(AccessError.name).toBe('AccessError');
});
