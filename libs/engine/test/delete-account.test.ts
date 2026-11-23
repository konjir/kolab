// A person deletes their own account (konjir_delete_my_account, migration 0060; Lee's decision of
// 2026-11-23, "remove me, keep my words"), from konnect's app, naming themselves. They leave every
// kolab, their sign-ins, sessions and push devices end, their agents go, and their identity and
// profile are deleted; a kolab they alone were in is erased. What they and their agents sent stays,
// shown as from a deleted account, and their id is never handed out again: the same GitHub account
// signing in later is a new person, with nothing of the old one's. Refused while they own a kolab
// someone else is in, to anyone but the person themselves, and to an agent's or any other sign-in.
import { expect, test } from '@jest/globals';
import { AccountDeletionBlocked, sessionKey } from '@konjir/engine';
import { appSignIn, openKolab, rejection, type TestKolab } from '@konjir/engine/testing';

const GITHUB = (subject: string, login: string) => ({ provider: 'github', subject, login });

/**
 * Ann owns `anns`, where Bo writes and Bo's agent too; Bo owns `bos`, which only he and his agent
 * are in. Both signed up with GitHub and are signed in through konnect's app, Bo with a push
 * device. They have talked: a DM each way, a channel message each, and one from Bo's agent.
 */
async function world() {
  const k = await openKolab();
  for (const [subject, login] of [['11', 'ann'], ['22', 'bo']]) expect(await k.signInWith(GITHUB(subject, login))).toStrictEqual({ actor: login, created: true });
  await k.addActor('bo-claude', { owner: 'bo' });
  await k.createKolab('anns', { owner: 'ann' });
  await k.createKolab('bos', { owner: 'bo' });
  await k.grant('anns', 'bo', 'write');
  await k.grant('anns', 'bo-claude', 'write');
  await k.grant('bos', 'bo-claude', 'write');
  const ann = await appSignIn(k, 'ann', 'anns');
  const bo = await appSignIn(k, 'bo', 'anns');
  const agent = await k.openSession('bo-claude', 'engineer', { kolab: 'anns' });
  await k.registerPushDevice(bo.access, 'ExponentPushToken[bo-phone]', 'ios');
  const hi = await k.sendMessage(ann.access, 'bo', 'Hi Bo');
  await k.sendMessage(bo.access, 'ann', 'Hi Ann', { replyTo: hi.id });
  await k.sendChannelMessage(ann.access, 'general', 'Standup at ten', { mentions: ['bo'] });
  await k.sendChannelMessage(bo.access, 'general', 'I will be there');
  await k.sendChannelMessage(agent, 'general', 'Build is green');
  const ended: string[] = [];
  k.onEvent((e) => { if ('session' in e && e.session === 'ended') ended.push(e.id); });
  return { k, ann, bo, agent, ended };
}

const count = async (k: TestKolab, sql: string, params: unknown[] = []) => Number((await k.db.query<{ n: string }>(`select count(*) as n from ${sql}`, params)).rows[0].n);

test('a person deletes their account: they leave every kolab, a kolab only they were in is erased, every sign-in, session and device ends, and their identity and profile go', async () => {
  const { k, ann, bo, agent, ended } = await world();
  expect(await k.deleteOwnAccount(bo.access, 'bo')).toStrictEqual({ deleted: 'bo', left: ['anns'], erased: ['bos'], agents: 1, revoked: 1, ended: 2, devices: 1 });

  // Every session of theirs and their agent's ended, and was told; none answers now.
  expect(ended).toEqual(expect.arrayContaining([bo.session, sessionKey(agent)]));
  expect(await k.sessionOpen(bo.access)).toBe(false);
  expect(await rejection(k.readMessages(agent))).toMatch(/session/);
  // The sign-in is revoked and its refresh tokens gone: no refresh renews it.
  expect(await rejection(k.refreshGrant({ refreshToken: bo.refresh, clientId: bo.client }))).toMatch(/invalid_grant|refresh token is unknown|invalid_client/);
  expect(await count(k, `oauth_grant where person_id = 'bo' and revoked_at is null`)).toBe(0);
  expect(await count(k, `oauth_refresh_token t join oauth_grant g on g.id = t.grant_id where g.person_id = 'bo'`)).toBe(0);
  // The app's registration only Bo used went; Ann's stays.
  expect(await count(k, `oauth_client where id = $1`, [bo.client])).toBe(0);
  expect(await count(k, `oauth_client where id = $1`, [ann.client])).toBe(1);
  // Push devices, grants, the identity: none left. The kolab only Bo was in is gone.
  expect(await count(k, `push_device where actor_id = 'bo'`)).toBe(0);
  expect(await count(k, `kolab_grant where user_id = 'bo' or agent_id = 'bo-claude'`)).toBe(0);
  expect(await count(k, `identity where actor_id = 'bo' or subject = '22'`)).toBe(0);
  expect(await count(k, `kolab where id = 'bos'`)).toBe(0);
  // What is left of Bo is the tombstone: the rows, archived and deleted, named by id alone.
  expect((await k.db.query(`select id, name, archived_at is not null as archived, deleted_at is not null as deleted from account where id = 'bo'`)).rows)
    .toStrictEqual([{ id: 'bo', name: 'bo', archived: true, deleted: true }]);
  expect((await k.db.query(`select id, name from actor where id in ('bo', 'bo-claude') order by id`)).rows).toStrictEqual([{ id: 'bo', name: 'bo' }, { id: 'bo-claude', name: 'bo-claude' }]);

  // Ann's kolab goes on without Bo: not a member, his words still there, from a deleted account.
  expect((await k.membersPage(ann.access)).items.map((m) => m.actor)).toStrictEqual(['ann']);
  const general = (await k.channelMessagesPage(ann.access, 'general')).items;
  expect(general.map((m) => [m.from, m.message, m.from_deleted ?? false])).toStrictEqual([
    ['bo-claude', 'Build is green', true], ['bo', 'I will be there', true], ['ann', 'Standup at ten', false],
  ]);
  const dms = (await k.messagesPage(ann.access, { with: 'bo' })).items;
  expect(dms.map((m) => [m.from, m.to, m.message, m.from_deleted ?? false, m.to_deleted ?? false]).sort()).toStrictEqual([
    ['ann', 'bo', 'Hi Bo', false, true], ['bo', 'ann', 'Hi Ann', true, false],
  ]);
  const [conversation] = (await k.conversationsPage(ann.access)).items;
  expect([conversation.with, conversation.last.from_deleted]).toStrictEqual(['bo', true]);
  // Nobody can message them now.
  expect(await rejection(k.sendMessage(ann.access, 'bo', 'Still there?'))).toMatch(/not a member/);

  // The audit log records the event, with counts, never the person's data.
  const audited = (await k.auditLog({ subject: 'bo' })).find((e) => e.action === 'account.deleted')!;
  expect(audited).toMatchObject({ action: 'account.deleted', kolab: null, subject: 'bo', by: 'bo', detail: { left: 1, erased: 1, agents: 1, revoked: 1, ended: 2, devices: 1 } });
  expect(JSON.stringify(audited)).not.toMatch(/22|github/);
});

test('the id is never handed out again: the same GitHub account signs up as a new person, with nothing of the old one\'s; nobody else gets the name either', async () => {
  const { k, ann, bo } = await world();
  await k.deleteOwnAccount(bo.access, 'bo');
  // The same GitHub account, signing in again: a new person, bo_2.
  expect(await k.signInWith(GITHUB('22', 'bo'))).toStrictEqual({ actor: 'bo_2', created: true });
  expect(await k.reachable('bo_2')).toStrictEqual([]);
  expect(await rejection(k.openSession('bo_2', 'product', { kolab: 'anns' }))).toMatch(/access|reach|no grant|kolab anns/i);
  // Someone else whose GitHub login is now bo: never the old id either.
  expect((await k.signInWith(GITHUB('99', 'Bo'))).actor).toBe('bo_3');
  // Bo's old messages are still the deleted account's, not the new person's.
  expect((await k.channelMessagesPage(ann.access, 'general')).items.filter((m) => m.from === 'bo').map((m) => m.from_deleted)).toStrictEqual([true]);

  // An admin can't bring it back, link it again, or free its name; nor can the database.
  expect(await rejection(k.unarchive({ actor: 'bo' }))).toMatch(/bo deleted their account, which is for good/);
  expect(await rejection(k.unarchive({ actor: 'bo-claude' }))).toMatch(/bo deleted their account, which is for good/);
  expect(await rejection(k.linkIdentity('bo', { provider: 'github', subject: '77' }))).toMatch(/bo deleted their account/);
  expect(await rejection(k.addActor('BO'))).toMatch(/taken|exists/);
  await expect(k.db.query(`update account set archived_at = null where id = 'bo'`)).rejects.toThrow(/a deleted account never changes again/);
  await expect(k.db.query(`update account set deleted_at = null where id = 'bo'`)).rejects.toThrow(/a deleted account never changes again/);
  await expect(k.db.query(`delete from account where id = 'bo'`)).rejects.toThrow(/a deleted account is kept/);
  await expect(k.db.query(`update actor set name = 'Bo B.' where id = 'bo'`)).rejects.toThrow(/kept as they are/);
  await expect(k.db.query(`insert into identity(provider, subject, actor_id, login, linked_by) values ('github', '78', 'bo', 'bo', 'admin')`)).rejects.toThrow(/deleted their account/);
  await expect(k.db.query(`update account set deleted_at = now() where id = 'ann'`)).rejects.toThrow(/account_deleted_check/);
});

test('only the person, from their own sign-in through konnect\'s app, naming themselves: never another person, an agent, or any other sign-in, and nothing changes', async () => {
  const { k, ann, bo, agent } = await world();
  const handIssued = await k.openSession('bo', 'product', { kolab: 'anns' });
  expect(await rejection(k.deleteOwnAccount(agent, 'bo'))).toMatch(/AccessError: bo-claude is an agent: only a person deletes their account/);
  expect(await rejection(k.deleteOwnAccount(agent, 'bo-claude'))).toMatch(/AccessError: bo-claude is an agent/);
  expect(await rejection(k.deleteOwnAccount(handIssued, 'bo'))).toMatch(/AccessError: this session is no sign-in through an app: deleting an account is for konnect's own app/);
  // Another person's sign-in can only ever name its own account.
  expect(await rejection(k.deleteOwnAccount(ann.access, 'bo'))).toMatch(/TenancyError: name the account to delete: type ann/);
  expect(await rejection(k.deleteOwnAccount(bo.access, ''))).toMatch(/name the account to delete: type bo/);
  expect(await rejection(k.deleteOwnAccount(bo.access, undefined as unknown as string))).toMatch(/name the account to delete/);
  // Signed out, its token reaches nothing.
  const other = await appSignIn(k, 'bo', 'anns');
  await k.endSession(other.access);
  expect(await rejection(k.deleteOwnAccount(other.access, 'bo'))).toMatch(/RoleError: no open session/);
  // A Konjir admin is refused until another admin revokes that.
  await k.makeAdmin('bo');
  expect(await rejection(k.deleteOwnAccount(bo.access, 'bo'))).toMatch(/you are a Konjir admin/);
  await k.removeAdmin('bo');
  // Nothing changed through any of it.
  expect(await count(k, `identity where actor_id = 'bo'`)).toBe(1);
  expect(await count(k, `account where id = 'bo' and archived_at is null and deleted_at is null`)).toBe(1);
  expect(await k.sessionOpen(bo.access)).toBe(true);
  expect(await k.sessionOpen(agent)).toBe(true);
});

test('refused while they own a kolab someone else is in, or one with documents, or alone own an organization with members: each named, and nothing changes', async () => {
  const { k, ann, bo } = await world();
  await k.createKolab('docs', { owner: 'ann' });
  const annDocs = await k.openSession('ann', 'product', { kolab: 'docs' });
  await k.createNode(annDocs, 'spec', 'Orders', 'orders');
  await k.createKolab('quiet', { owner: 'ann' });
  await k.addOrganization('acme');
  await k.addMember('acme', 'ann', 'owner');
  await k.addMember('acme', 'bo', 'member');
  const refused = await k.deleteOwnAccount(ann.access, 'ann').then(() => undefined, (e: unknown) => e);
  expect(refused).toBeInstanceOf(AccountDeletionBlocked);
  expect((refused as AccountDeletionBlocked).blockers.map((b) => [b.kind, b.name, b.reason])).toStrictEqual([
    ['kolab', 'anns', 'members'], ['kolab', 'docs', 'documents'], ['organization', 'acme', 'organization'],
  ]);
  expect((refused as Error).message).toMatch(/your account can't be deleted yet: kolab anns is yours and has 2 other members: hand it over, or erase it.*kolab docs is yours and holds documents: archive it.*only owner of organization acme/);
  // Nothing changed: not even the kolab that would have been erased.
  expect(await count(k, `kolab where id in ('anns', 'docs', 'quiet')`)).toBe(3);
  expect(await count(k, `identity where actor_id = 'ann'`)).toBe(1);
  expect(await k.sessionOpen(ann.access)).toBe(true);

  // Bo is a member of acme, not its owner: he deletes his account, and leaves it.
  await k.deleteOwnAccount(bo.access, 'bo');
  expect(await count(k, `org_member where user_id = 'bo'`)).toBe(0);
  const removed = (await k.auditLog({ subject: 'bo' })).filter((e) => e.action === 'member.removed').map((e) => e.detail);
  expect(removed).toStrictEqual([{ org: 'acme', deleted: true }]);
});
