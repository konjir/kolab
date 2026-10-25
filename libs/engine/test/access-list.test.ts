// Who holds access to a kolab, for its Admins (W3.6, API8): each person and agent with what they
// hold and where it comes from (owning the kolab, owning its organization, the base permission, an
// internal kolab's members, a direct grant, an outside collaborator's grant, a team's grant, an
// agent capped by its owner), and changing or removing direct grants with no admin of Konjir's.
// The rules: only a person with Admin, checked under the access lock; never the last Admin; Admin
// given only by the kolab's owners; an agent never above its owner (D30, D56), and capped when its
// owner's grant goes; revoking Read marks links across kolabs access_lost in the same change (D53);
// sessions that can no longer reach the kolab end, agents' included; archived kolabs refuse (D52);
// access from teams and the organization is shown, never changed here.
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { els, openKolab, rejection, TestKolab } from '@konjir/engine/testing';

/** Ann owns `anns`; Eli writes its technical layer, Fay administers it, and Eli's agent works there as an engineer. */
async function anns(kolab?: TestKolab) {
  const k = kolab ?? await openKolab();
  for (const id of ['ann', 'eli', 'fay']) await k.addActor(id);
  await k.addActor('eli-claude', { owner: 'eli' });
  await k.createKolab('anns', { owner: 'ann' });
  await k.grant('anns', 'eli', 'write', { layers: ['technical'] });
  await k.grant('anns', 'fay', 'admin');
  await k.grant('anns', 'eli-claude', 'write', { layers: ['technical'] });
  const ann = await k.openSession('ann', 'product', { kolab: 'anns' });
  const fay = await k.openSession('fay', 'product', { kolab: 'anns' });
  return { kolab: k, ann, fay };
}

test('an admin sees who holds access to a person\'s kolab and where it comes from; an agent is shown capped by its owner', async () => {
  const { kolab, ann, fay } = await anns();
  const view = await kolab.listAccess(ann);
  expect(view.kolab).toStrictEqual({ id: 'anns', owner: 'ann', owner_kind: 'user', visibility: 'private', base_permission: null });
  expect(view.teams).toStrictEqual([]);
  expect(view.holders).toStrictEqual([
    { actor: 'ann', kind: 'person', owner: null, access: { level: 'admin', layers: ['functional', 'technical'] },
      sources: [{ kind: 'owner', level: 'admin', layers: ['functional', 'technical'] }], grant: null, outside: false },
    { actor: 'fay', kind: 'person', owner: null, access: { level: 'admin', layers: ['functional', 'technical'] },
      sources: [{ kind: 'grant', level: 'admin', layers: ['functional', 'technical'] }], grant: { level: 'admin', layers: ['functional', 'technical'] }, outside: false },
    { actor: 'eli', kind: 'person', owner: null, access: { level: 'write', layers: ['technical'] },
      sources: [{ kind: 'grant', level: 'write', layers: ['technical'] }], grant: { level: 'write', layers: ['technical'] }, outside: false },
    { actor: 'eli-claude', kind: 'agent', owner: 'eli', access: { level: 'write', layers: ['technical'] },
      sources: [{ kind: 'grant', level: 'write', layers: ['technical'] }], grant: { level: 'write', layers: ['technical'] }, outside: false,
      cap: { level: 'write', layers: ['technical'] }, capped: false },
  ]);
  expect(await kolab.listAccess(fay)).toStrictEqual(view);

  // Eli drops to Read: his agent keeps its grant, but holds only what he lends it, and shows capped.
  await kolab.changeGrant(ann, 'eli', 'read');
  const agent = (await kolab.listAccess(ann)).holders.find((h) => h.actor === 'eli-claude')!;
  expect(agent).toMatchObject({ access: { level: 'read', layers: [] }, grant: { level: 'write', layers: ['technical'] }, cap: { level: 'read', layers: [] }, capped: true });
});

test('in an organization\'s kolab: its owners, the base permission, an internal kolab\'s members, nested teams, an outside collaborator and the organization\'s own agent', async () => {
  const kolab = await openKolab();
  await kolab.addOrganization('acme');
  for (const id of ['olga', 'mia', 'ben', 'otto']) await kolab.addActor(id);
  await kolab.addMember('acme', 'olga', 'owner');
  await kolab.addMember('acme', 'mia');
  await kolab.addMember('acme', 'ben');
  await kolab.createKolab('shop', { owner: 'acme', visibility: 'internal', base: 'triage' });
  await kolab.addTeam('acme', 'eng');
  await kolab.addTeam('acme', 'backend', { parent: 'eng' });
  await kolab.addTeamMember('acme/backend', 'ben');
  await kolab.grant('shop', 'acme/eng', 'write', { layers: ['technical'] });
  await kolab.grant('shop', 'otto', 'read');
  await kolab.addActor('acme-bot', { owner: 'acme' });
  await kolab.grant('shop', 'acme-bot', 'write');
  const olga = await kolab.openSession('olga', 'product', { kolab: 'shop' });

  const view = await kolab.listAccess(olga);
  expect(view.kolab).toStrictEqual({ id: 'shop', owner: 'acme', owner_kind: 'organization', visibility: 'internal', base_permission: 'triage' });
  expect(view.teams).toStrictEqual([{ team: 'acme/eng', level: 'write', layers: ['technical'], members: 1 }]);
  const by = Object.fromEntries(view.holders.map((h) => [h.actor, h]));
  expect(view.holders.map((h) => h.actor)).toStrictEqual(['olga', 'ben', 'acme-bot', 'mia', 'otto']);
  expect(by.olga.sources.map((s) => s.kind)).toStrictEqual(['org_owner', 'base', 'internal']);
  expect(by.ben).toMatchObject({ access: { level: 'write', layers: ['technical'] }, grant: null, outside: false });
  expect(by.ben.sources).toStrictEqual([
    { kind: 'base', level: 'triage', layers: [], org: 'acme' },
    { kind: 'internal', level: 'read', layers: [], org: 'acme' },
    { kind: 'team', level: 'write', layers: ['technical'], team: 'acme/eng' },
  ]);
  expect(by.mia).toMatchObject({ access: { level: 'triage', layers: [] }, grant: null });
  expect(by.otto).toMatchObject({ access: { level: 'read', layers: [] }, grant: { level: 'read', layers: [] }, outside: true, sources: [{ kind: 'grant', level: 'read', layers: [] }] });
  expect(by['acme-bot']).toMatchObject({ kind: 'agent', owner: 'acme', access: { level: 'write', layers: ['functional', 'technical'] }, cap: { level: 'admin', layers: ['functional', 'technical'] }, capped: false });


  // Access from a team, the base permission or owning the organization isn't changed here; and
  // someone unknown is refused exactly as someone known with no grant here, so nobody learns who signed up.
  const none = (who: string) => `TenancyError: ${who} holds no direct grant in kolab shop; access from owning it, its organization, the base permission or a team is changed where those are kept`;
  expect(await rejection(kolab.removeGrant(olga, 'ben'))).toBe(none('ben'));
  expect(await rejection(kolab.changeGrant(olga, 'mia', 'write'))).toBe(none('mia'));
  expect(await rejection(kolab.removeGrant(olga, 'nobody'))).toBe(none('nobody'));
  expect(await rejection(kolab.changeGrant(olga, 'nobody', 'read'))).toBe(none('nobody'));
  expect(await rejection(kolab.removeGrant(olga, 'acme/eng'))).toMatch(/a team's access is its grant to the team, kept with the organization's teams, not changed here/);
  expect((await kolab.listAccess(olga)).holders).toStrictEqual(view.holders);
});

test('only a person with Admin lists or changes access: Maintain, Write and agents are refused', async () => {
  const { kolab, ann } = await anns();
  const eli = await kolab.openSession('eli', 'engineer', { kolab: 'anns' });
  const agent = await kolab.openSession('eli-claude', 'engineer', { kolab: 'anns' });
  expect(await rejection(kolab.listAccess(eli))).toMatch(/AccessError: who holds access to kolab anns is for those with Admin there; you hold Write on the technical layer/);
  expect(await rejection(kolab.removeGrant(eli, 'fay'))).toMatch(/for those with Admin there/);
  expect(await rejection(kolab.listAccess(agent))).toMatch(/eli-claude is an agent: only a person manages who holds access to a kolab/);
  await kolab.changeGrant(ann, 'eli', 'maintain');
  expect(await rejection(kolab.changeGrant(eli, 'eli', 'admin'))).toMatch(/for those with Admin there; you hold Maintain/);
});

test('an admin changes a person\'s direct grant; Admin is given, and a granted Admin lowered, only by the kolab\'s owners', async () => {
  const { kolab, ann, fay } = await anns();
  expect(await kolab.changeGrant(fay, 'eli', 'write', { layers: ['functional', 'technical'] })).toStrictEqual({ ended: 0 });
  expect(await kolab.access('eli', 'anns')).toStrictEqual({ level: 'write', layers: ['functional', 'technical'] });
  await kolab.changeGrant(fay, 'eli', 'maintain');
  expect(await kolab.access('eli', 'anns')).toStrictEqual({ level: 'maintain', layers: ['functional', 'technical'] });
  expect(await rejection(kolab.changeGrant(fay, 'eli', 'read', { layers: ['functional'] }))).toMatch(/only a Write grant names its layers/);
  expect(await rejection(kolab.changeGrant(fay, 'eli', 'write', { layers: [] }))).toMatch(/names the layers it covers/);
  expect(await rejection(kolab.changeGrant(fay, 'eli', 'owner' as never))).toMatch(/a level is one of read, triage, write, maintain, admin/);
  // Fay holds Admin by a grant, not by owning anns: she can't give Admin. Ann owns it, and can.
  expect(await rejection(kolab.changeGrant(fay, 'eli', 'admin'))).toMatch(/AccessError: Admin in kolab anns is given by its owners/);
  await kolab.changeGrant(ann, 'eli', 'admin');
  expect((await kolab.access('eli', 'anns')).level).toBe('admin');
  // Eli now holds Admin the owners gave: Fay can neither lower nor remove it, since she couldn't restore it. Ann can.
  expect(await rejection(kolab.changeGrant(fay, 'eli', 'write'))).toMatch(/AccessError: eli holds Admin in kolab anns by a grant its owners gave: only they lower or remove it/);
  expect(await rejection(kolab.removeGrant(fay, 'eli'))).toMatch(/only they lower or remove it/);
  expect((await kolab.access('eli', 'anns')).level).toBe('admin');
  await kolab.changeGrant(ann, 'eli', 'write', { layers: ['technical'] });
  expect(await kolab.access('eli', 'anns')).toStrictEqual({ level: 'write', layers: ['technical'] });
  // Anyone may step down from their own Admin, while someone else holds it.
  await kolab.changeGrant(fay, 'fay', 'maintain');
  expect((await kolab.access('fay', 'anns')).level).toBe('maintain');
});

test('an agent\'s grant is only lowered or removed here: raising one is its owner\'s, at most Write, even for the kolab\'s owner (D56)', async () => {
  const { kolab, ann, fay } = await anns();
  for (const [agent, owner] of [['fay-claude', 'fay'], ['ann-claude', 'ann']]) {
    await kolab.addActor(agent, { owner });
    await kolab.grant('anns', agent, 'read');
  }
  await kolab.changeGrant(ann, 'eli-claude', 'read');
  const refused = /AccessError: an agent's grant is only lowered or removed here: raising (\S+)'s is for its owner, who lends their own agents up to their access, at most Write \(D56\)/;
  // Fay, an Admin by grant, raising her own agent to Maintain.
  expect(await rejection(kolab.changeGrant(fay, 'fay-claude', 'maintain'))).toMatch(refused);
  // Ann, the kolab's owner, raising hers to Admin.
  expect(await rejection(kolab.changeGrant(ann, 'ann-claude', 'admin'))).toMatch(refused);
  // Fay raising Eli's agent, without Eli.
  expect(await rejection(kolab.changeGrant(fay, 'eli-claude', 'write', { layers: ['technical'] }))).toMatch(refused);
  for (const agent of ['fay-claude', 'ann-claude', 'eli-claude']) expect(await kolab.access(agent, 'anns')).toStrictEqual({ level: 'read', layers: [] });

  // Lowering is allowed: a level down, or a layer fewer at Write; and so is removing.
  await kolab.grant('anns', 'ann-claude', 'write');
  expect(await kolab.changeGrant(fay, 'ann-claude', 'write', { layers: ['functional'] })).toStrictEqual({ ended: 0 });
  expect(await rejection(kolab.changeGrant(fay, 'ann-claude', 'write', { layers: ['technical'] }))).toMatch(refused);
  await kolab.changeGrant(fay, 'ann-claude', 'triage');
  expect(await kolab.access('ann-claude', 'anns')).toStrictEqual({ level: 'triage', layers: [] });
  expect(await kolab.removeGrant(fay, 'ann-claude')).toStrictEqual({ ended: 0 });
});

test('after an Admin lowers an agent, its owner raises it again within their own agents\' rules; a capped agent lowers to any level under its grant', async () => {
  const { kolab, ann, fay } = await anns();
  const lendAgain = (person: string, agent: string) =>
    (kolab as unknown as { grantOwnAgent(p: string, a: string, k: string): Promise<void> }).grantOwnAgent(person, agent, 'anns');
  // Fay lowers Eli's agent to Read; Eli lends it his access again, as signing it in does: Write on the technical layer.
  await kolab.changeGrant(fay, 'eli-claude', 'read');
  await lendAgain('eli', 'eli-claude');
  expect(await kolab.access('eli-claude', 'anns')).toStrictEqual({ level: 'write', layers: ['technical'] });
  // At most Write, and never above its owner: Ann's agent is lent Write, not Admin.
  await kolab.addActor('ann-claude', { owner: 'ann' });
  await lendAgain('ann', 'ann-claude');
  expect(await kolab.access('ann-claude', 'anns')).toStrictEqual({ level: 'write', layers: ['functional', 'technical'] });
  // A grant above those rules, from Konjir's admin, stands: lending never lowers it.
  await kolab.grant('anns', 'ann-claude', 'admin');
  await lendAgain('ann', 'ann-claude');
  expect((await kolab.access('ann-claude', 'anns')).level).toBe('admin');
  // Only the kolab's owners lower an agent's Admin here, and the refusal says where it came from.
  expect(await rejection(kolab.changeGrant(fay, 'ann-claude', 'maintain')))
    .toMatch(/AccessError: ann-claude, an agent, holds Admin in kolab anns by a grant from Konjir's admin or the kolab's owners: only the kolab's owners lower or remove it here/);
  await kolab.changeGrant(ann, 'ann-claude', 'maintain');

  // Eli drops to Read: his agent, stored at Write, is capped at Read, and may be lowered to Triage, between the two.
  await kolab.changeGrant(ann, 'eli', 'read');
  expect(await kolab.changeGrant(fay, 'eli-claude', 'triage')).toStrictEqual({ ended: 0 });
  expect((await kolab.db.query(`select level from kolab_grant where kolab_id = 'anns' and agent_id = 'eli-claude'`)).rows).toStrictEqual([{ level: 'triage' }]);
  expect(await kolab.access('eli-claude', 'anns')).toStrictEqual({ level: 'read', layers: [] });
});

test('an archived person\'s or agent\'s grant isn\'t changed, only removed (D52)', async () => {
  const { kolab, ann } = await anns();
  await kolab.archive({ actor: 'eli' });
  expect(await rejection(kolab.changeGrant(ann, 'eli', 'maintain'))).toMatch(/TenancyError: eli is archived, so its grant isn't changed; remove it, or unarchive eli first/);
  expect(await rejection(kolab.changeGrant(ann, 'eli-claude', 'read'))).toMatch(/eli-claude is archived/);
  expect((await kolab.db.query(`select level from kolab_grant where kolab_id = 'anns' and user_id = 'eli'`)).rows).toStrictEqual([{ level: 'write' }]);
  expect(await kolab.removeGrant(ann, 'eli')).toStrictEqual({ ended: 0 });
  expect((await kolab.db.query(`select 1 from kolab_grant where kolab_id = 'anns' and user_id = 'eli'`)).rows).toHaveLength(0);
});

test('the caller\'s session is checked again under the lock: one that ended after the first check changes nothing', async () => {
  const { kolab, ann } = await anns();
  // Ann's session ends between the first check and the lock (a sign-out, a switch, a revoked token).
  const k = kolab as unknown as { requireLiveKolab(...a: unknown[]): Promise<unknown> };
  const live = k.requireLiveKolab.bind(kolab);
  k.requireLiveKolab = async (...a: unknown[]) => { await kolab.endSession(ann); return live(...a); };
  expect(await rejection(kolab.removeGrant(ann, 'eli'))).toMatch(/RoleError: no open session for that token/);
  k.requireLiveKolab = live;
  expect((await kolab.access('eli', 'anns')).level).toBe('write');
});

test('an admin can\'t remove or lower the last Admin; one may step down while someone else holds Admin', async () => {
  const kolab = await openKolab();
  await kolab.addOrganization('acme');
  for (const id of ['olga', 'fay', 'gus']) await kolab.addActor(id);
  await kolab.createKolab('shop', { owner: 'acme' });
  // No owner of acme: Admin in shop comes only from grants.
  await kolab.grant('shop', 'fay', 'admin');
  await kolab.grant('shop', 'gus', 'admin');
  const fay = await kolab.openSession('fay', 'product', { kolab: 'shop' });
  const gus = await kolab.openSession('gus', 'product', { kolab: 'shop' });
  // Gus steps down to Write: his session narrows and stays open.
  expect(await kolab.changeGrant(gus, 'gus', 'write')).toStrictEqual({ ended: 0 });
  expect(await kolab.sessionOpen(gus)).toBe(true);
  expect((await kolab.sessionInfo(gus)).access.level).toBe('write');
  // Now Fay is the last Admin: neither lowering nor removing her own grant is allowed.
  expect(await rejection(kolab.changeGrant(fay, 'fay', 'maintain'))).toMatch(/AccessError: that would leave kolab shop with nobody holding Admin: give someone else Admin first/);
  expect(await rejection(kolab.removeGrant(fay, 'fay'))).toMatch(/nobody holding Admin/);
  expect((await kolab.access('fay', 'shop')).level).toBe('admin');
  // An agent with Admin doesn't count: only a person administers a kolab's access.
  await kolab.addActor('acme-bot', { owner: 'acme' });
  await kolab.grant('shop', 'acme-bot', 'admin');
  expect(await rejection(kolab.removeGrant(fay, 'fay'))).toMatch(/nobody holding Admin/);
  // With an owner of acme, who is Admin in all of its kolabs, Fay may step down, and her session then narrows.
  await kolab.addMember('acme', 'olga', 'owner');
  await kolab.changeGrant(fay, 'fay', 'read');
  expect((await kolab.sessionInfo(fay)).access.level).toBe('read');
  expect(await rejection(kolab.listAccess(fay))).toMatch(/you hold Read/);

  // In a person's kolab its owner is always Admin, so a granted Admin may go.
  const { kolab: k2, ann: ann2, fay: fay2 } = await anns();
  expect(await k2.removeGrant(ann2, 'fay')).toStrictEqual({ ended: 1 });
  expect(await k2.sessionOpen(fay2)).toBe(false);
});

test('removing a person\'s grant caps their agents and ends the sessions that can no longer reach the kolab, agents\' included', async () => {
  const { kolab, ann } = await anns();
  const eli = await kolab.openSession('eli', 'engineer', { kolab: 'anns' });
  const agent = await kolab.openSession('eli-claude', 'engineer', { kolab: 'anns' });
  const ended: string[] = [];
  kolab.onEvent((e) => { if ('session' in e && e.session === 'ended') ended.push(e.id); });
  expect(await kolab.removeGrant(ann, 'eli')).toStrictEqual({ ended: 2 });
  expect(await kolab.sessionOpen(eli)).toBe(false);
  expect(await kolab.sessionOpen(agent)).toBe(false);
  expect(ended).toHaveLength(2);
  // The agent's own grant stays, but gives nothing while its owner holds nothing; it is listed, to be
  // removed, without naming its owner, who holds nothing here now.
  expect(await kolab.access('eli-claude', 'anns')).toStrictEqual({ level: null, layers: [] });
  expect(await rejection(kolab.openSession('eli-claude', 'engineer', { kolab: 'anns' }))).toMatch(/no access|can't reach|holds nothing|no kolab/i);
  const view = await kolab.listAccess(ann);
  expect(view.holders.map((h) => h.actor)).toStrictEqual(['ann', 'fay', 'eli-claude']);
  expect(view.holders[2]).toMatchObject({ owner: null, access: { level: null, layers: [] }, cap: { level: null, layers: [] }, capped: true });
  expect(await kolab.removeGrant(ann, 'eli-claude')).toStrictEqual({ ended: 0 });
  expect((await kolab.listAccess(ann)).holders.map((h) => h.actor)).toStrictEqual(['ann', 'fay']);

  // Gone is gone: there is no grant left to remove.
  expect(await rejection(kolab.removeGrant(ann, 'eli'))).toMatch(/eli holds no direct grant/);
});

test('revoking Read marks the person\'s links and forks into the kolab access_lost in the same change (D53)', async () => {
  const kolab = await openKolab();
  for (const id of ['alice', 'bob']) await kolab.addActor(id);
  await kolab.createKolab('orders', { owner: 'alice' });
  await kolab.createKolab('billing', { owner: 'bob' });
  const alice = await kolab.openSession('alice', 'product', { kolab: 'orders' });
  const bob = await kolab.openSession('bob', 'product', { kolab: 'billing' });
  await kolab.createNode(bob, 'spec', 'Checkout', 'checkout');
  await kolab.commit(bob, 'checkout', { elements: els({ R1: 'Invoices are sent monthly.' }) });
  await kolab.grant('billing', 'alice', 'read');
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  const t = await kolab.versionIn(alice, 'kj:billing/checkout#R1', { what: 'linking', across: true });
  await kolab.link(alice, { kind: 'dependency', source: o1, sourceElement: 'O1', target: t.id, targetElement: 'R1' });

  // One transaction: if the mark failed, the grant would stay. Bob's page removes alice's Read.
  expect(await kolab.removeGrant(bob, 'alice')).toStrictEqual({ ended: 0 });
  expect((await kolab.describeMarks({ kolab: 'orders' })).map((m) => [m.reason, m.dirty])).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1']]);
  expect(await kolab.access('alice', 'billing')).toStrictEqual({ level: null, layers: [] });
  expect(await kolab.sessionOpen(alice)).toBe(true);   // her own kolab's session is untouched
});

test('an archived kolab refuses every change, and its admins\' sessions are gone with it (D52)', async () => {
  const { kolab, ann } = await anns();
  await kolab.archive({ kolab: 'anns' });
  expect(await rejection(kolab.removeGrant(ann, 'eli'))).toMatch(/ended|no open session|archived/);
  expect(await rejection(kolab.listAccess(ann))).toMatch(/ended|no open session|archived/);
  expect((await kolab.db.query(`select user_id from kolab_grant where kolab_id = 'anns' and user_id = 'eli'`)).rows).toHaveLength(1);
  await kolab.unarchive({ kolab: 'anns' });
  const again = await kolab.openSession('ann', 'product', { kolab: 'anns' });
  expect(await kolab.removeGrant(again, 'eli')).toStrictEqual({ ended: 0 });
});

test('at once: an owner removing an Admin while that Admin changes a grant, and two Admins stepping down; the lock serializes them, and one Admin always remains', async () => {
  const kolab = await openKolab();
  await kolab.addOrganization('acme');
  for (const id of ['olga', 'fay', 'gus', 'eli']) await kolab.addActor(id);
  await kolab.createKolab('shop', { owner: 'acme' });
  for (let round = 0; round < 3; round++) {
    // Olga, an owner of acme, removes Fay while Fay lowers Eli: Fay's change counts only if it ran first.
    await kolab.addMember('acme', 'olga', 'owner');
    await kolab.grant('shop', 'fay', 'admin');
    await kolab.grant('shop', 'eli', 'write');
    const olga = await kolab.openSession('olga', 'product', { kolab: 'shop' });
    const fay = await kolab.openSession('fay', 'product', { kolab: 'shop' });
    const [removed, lowered] = await Promise.allSettled([kolab.removeGrant(olga, 'fay'), kolab.changeGrant(fay, 'eli', 'read')]);
    expect(removed.status).toBe('fulfilled');
    expect((await kolab.access('fay', 'shop')).level).toBeNull();
    const eliLevel = (await kolab.access('eli', 'shop')).level;
    if (lowered.status === 'fulfilled') expect(eliLevel).toBe('read');
    else {
      expect(String(lowered.reason)).toMatch(/ended|needs Admin there|no open session|can no longer reach/);
      expect(eliLevel).toBe('write');
    }
    await kolab.endSession({ actor: 'olga' }).catch(() => undefined);
    await kolab.removeMember('acme', 'olga');

    // Fay and Gus step down at once, with no owner of acme: the second finds itself the last Admin.
    await kolab.grant('shop', 'fay', 'admin');
    await kolab.grant('shop', 'gus', 'admin');
    const f2 = await kolab.openSession('fay', 'product', { kolab: 'shop' });
    const g2 = await kolab.openSession('gus', 'product', { kolab: 'shop' });
    const stepped = await Promise.allSettled([kolab.changeGrant(f2, 'fay', 'write'), kolab.changeGrant(g2, 'gus', 'write')]);
    expect(stepped.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String((stepped.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/nobody holding Admin/);
    expect((await Promise.all(['fay', 'gus'].map(async (a) => (await kolab.access(a, 'shop')).level))).sort()).toStrictEqual(['admin', 'write']);
    for (const a of ['fay', 'gus']) await kolab.endSession({ actor: a }).catch(() => undefined);
    await kolab.revoke('shop', 'gus');
  }
});

test('a grant removed while its grantee opens a session: the session never outlives the grant', async () => {
  const kolab = await openKolab();
  const { ann } = await anns(kolab);
  for (let round = 0; round < 5; round++) {
    await kolab.grant('anns', 'eli', 'write', { layers: ['technical'] });
    const [removed, opened] = await Promise.allSettled([kolab.removeGrant(ann, 'eli'), kolab.openSession('eli', 'engineer', { kolab: 'anns' })]);
    expect(removed.status).toBe('fulfilled');
    if (opened.status === 'fulfilled') expect(await kolab.sessionOpen(opened.value)).toBe(false);
  }
});
