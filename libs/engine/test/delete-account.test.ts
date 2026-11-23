// A person deletes their own account (konjir_delete_my_account, migration 0060; Lee's decision of
// 2026-11-23, "remove me, keep my words"), from konnect's app, naming themselves. They leave every
// kolab, their sign-ins, sessions and push devices end, their agents go, and their identity and
// profile are deleted; a kolab only they were in is erased. Their id, the GitHub login they signed
// up with, is re-keyed to an opaque one, `deleted-<random>`, on every row that names it, their
// agents' too: what they and their agents sent stays, from that id, shown as from a deleted
// account. The old id, and `<old>-x`, is never handed out again: the same GitHub account signing
// in later is a new person, with nothing of the old one's. Refused while anything would be left
// that someone else is in or nobody could administer, each named with what to do, to anyone but
// the person themselves, and to an agent's or any other sign-in; and nothing changes.
import { expect, test } from '@jest/globals';
import { ACTOR_ID_COLUMNS, AccountDeletionBlocked, ERASED_WITH_KOLAB, KEPT_WITH_KOLAB, sessionKey } from '@konjir/engine';
import { appSignIn, openKolab, rejection, type TestKolab } from '@konjir/engine/testing';

const GITHUB = (subject: string, login: string) => ({ provider: 'github', subject, login });
const DELETED = /^deleted-[0-9a-f]{12}$/;
const ROOT = 'a'.repeat(40);

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
  await k.sendChannelMessage(ann.access, 'general', 'Standup at ten, @bo', { mentions: ['bo'] });
  await k.sendChannelMessage(bo.access, 'general', 'I will be there');
  await k.sendChannelMessage(agent, 'general', 'Build is green');
  const ended: string[] = [];
  k.onEvent((e) => { if ('session' in e && e.session === 'ended') ended.push(e.id); });
  return { k, ann, bo, agent, ended };
}

const count = async (k: TestKolab, sql: string, params: unknown[] = []) => Number((await k.db.query<{ n: string }>(`select count(*) as n from ${sql}`, params)).rows[0].n);
/** The id a deleted account was re-keyed to: the only deleted account there is. */
const deletedId = async (k: TestKolab) => (await k.db.query<{ id: string }>(`select id from account where deleted_at is not null`)).rows.map((r) => r.id);
/** The blockers of a refused deletion: kind, name and reason of each. */
const blocked = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(AccountDeletionBlocked);
  const { blockers } = e as AccountDeletionBlocked;
  return { blockers: blockers.map((b) => [b.kind, b.name, b.reason]), why: blockers.map((b) => b.why), message: (e as Error).message };
};

/**
 * Every row of every table that still names one of `ids`: a text column equal to it, an array that
 * holds it, a JSON value with it as a string anywhere in it. Message bodies are the words people
 * wrote, kept as written, so they are left out.
 */
async function naming(k: TestKolab, ids: string[]): Promise<string[]> {
  const cols = (await k.db.query<{ t: string; c: string; type: string }>(
    `select table_name as t, column_name as c, data_type as type from information_schema.columns
      where table_schema = 'public' and data_type in ('text', 'jsonb', 'ARRAY') order by 1, 2`)).rows;
  const out: string[] = [];
  for (const { t, c, type } of cols) {
    if (c === 'body') continue;
    const where = type === 'text' ? `${c} = any($1::text[])`
      : type === 'ARRAY' ? `${c}::text[] && $1::text[]`
      : `exists (select 1 from unnest($1::text[]) v where jsonb_path_exists(${c}, '$.** ? (@ == $v)', jsonb_build_object('v', v)))`;
    const n = await count(k, `${t} where ${where}`, [ids]);
    if (n) out.push(`${t}.${c}: ${n}`);
  }
  return out;
}

test('a person deletes their account: they leave every kolab, a kolab only they were in is erased, every sign-in, session and device ends, and their identity and profile go', async () => {
  const { k, ann, bo, agent, ended } = await world();
  expect(await k.deleteOwnAccount(bo.access, 'bo')).toStrictEqual({ deleted: 'bo', left: ['anns'], erased: ['bos'], agents: 1, revoked: 1, ended: 2, devices: 1 });

  // Every session of theirs and their agent's ended, and was told; none answers now.
  expect(ended).toEqual(expect.arrayContaining([bo.session, sessionKey(agent)]));
  expect(await k.sessionOpen(bo.access)).toBe(false);
  expect(await rejection(k.readMessages(agent))).toMatch(/session/);
  // The sign-in is revoked and its refresh tokens gone: no refresh renews it.
  expect(await rejection(k.refreshGrant({ refreshToken: bo.refresh, clientId: bo.client }))).toMatch(/invalid_grant|refresh token is unknown|invalid_client/);
  const [gone] = await deletedId(k);
  expect(gone).toMatch(DELETED);
  expect(await count(k, `oauth_grant where person_id = $1 and revoked_at is null`, [gone])).toBe(0);
  expect(await count(k, `oauth_refresh_token t join oauth_grant g on g.id = t.grant_id where g.person_id = $1`, [gone])).toBe(0);
  // The app's registration only Bo used went; Ann's stays.
  expect(await count(k, `oauth_client where id = $1`, [bo.client])).toBe(0);
  expect(await count(k, `oauth_client where id = $1`, [ann.client])).toBe(1);
  // Push devices, grants, the identity: none left. The kolab only Bo was in is gone.
  expect(await count(k, `push_device where actor_id = $1`, [gone])).toBe(0);
  expect(await count(k, `kolab_grant where user_id = $1 or agent_id like $2`, [gone, `${gone}-%`])).toBe(0);
  expect(await count(k, `identity where actor_id = $1 or subject = '22'`, [gone])).toBe(0);
  expect(await count(k, `kolab where id = 'bos'`)).toBe(0);
  // What is left of Bo is the tombstone, under an id that says nothing of him: archived, deleted,
  // named by that id alone; his agent's the same.
  expect((await k.db.query(`select id, name, archived_at is not null as archived, deleted_at is not null as deleted from account where deleted_at is not null`)).rows)
    .toStrictEqual([{ id: gone, name: gone, archived: true, deleted: true }]);
  expect((await k.db.query(`select id, name, owner_id as owner from actor where id like 'deleted-%' order by id`)).rows)
    .toStrictEqual([{ id: gone, name: gone, owner: null }, { id: `${gone}-1`, name: `${gone}-1`, owner: gone }]);
  expect(await count(k, `actor where id in ('bo', 'bo-claude')`)).toBe(0);
  expect(await count(k, `account where id = 'bo'`)).toBe(0);

  // Ann's kolab goes on without Bo: not a member, his words still there, from the deleted account's id.
  expect((await k.membersPage(ann.access)).items.map((m) => m.actor)).toStrictEqual(['ann']);
  const general = (await k.channelMessagesPage(ann.access, 'general')).items;
  expect(general.map((m) => [m.from, m.message, m.from_deleted ?? false, m.mentions])).toStrictEqual([
    [`${gone}-1`, 'Build is green', true, []], [gone, 'I will be there', true, []], ['ann', 'Standup at ten, @bo', false, [gone]],
  ]);
  const dms = (await k.messagesPage(ann.access, { with: gone })).items;
  expect(dms.map((m) => [m.from, m.to, m.message, m.from_deleted ?? false, m.to_deleted ?? false]).sort()).toStrictEqual([
    ['ann', gone, 'Hi Bo', false, true], [gone, 'ann', 'Hi Ann', true, false],
  ]);
  const [conversation] = (await k.conversationsPage(ann.access)).items;
  expect([conversation.with, conversation.last.from_deleted]).toStrictEqual([gone, true]);
  // Nobody can message them now, by either id.
  expect(await rejection(k.sendMessage(ann.access, gone, 'Still there?'))).toMatch(/not a member/);
  expect(await rejection(k.sendMessage(ann.access, 'bo', 'Still there?'))).toMatch(/not a member|no member|no actor/);

  // The audit log records the event, with counts, never the person's data; every row of it that
  // named Bo names the new id now.
  const audited = (await k.auditLog({ subject: gone })).find((e) => e.action === 'account.deleted')!;
  expect(audited).toMatchObject({ action: 'account.deleted', kolab: null, subject: gone, by: gone, detail: { left: 1, erased: 1, agents: 1, revoked: 1, ended: 2, devices: 1 } });
  expect(JSON.stringify(audited)).not.toMatch(/22|github/);
  expect(await k.auditLog({ subject: 'bo' })).toStrictEqual([]);
  // And nothing anywhere names bo or bo-claude.
  expect(await naming(k, ['bo', 'bo-claude'])).toStrictEqual([]);
});

test('the old id is never handed out again, in any case, nor `<old>-x`; the same GitHub account signs up as a new person, with nothing of the old one\'s', async () => {
  const { k, ann, bo } = await world();
  // A person whose name merely starts as Bo's did keeps their own namespace.
  expect((await k.signInWith(GITHUB('33', 'bo-smith'))).actor).toBe('gh_bo-smith');
  await k.addActor('bob', {});
  await k.deleteOwnAccount(bo.access, 'bo');
  const [gone] = await deletedId(k);
  // The same GitHub account, signing in again: a new person, bo_2.
  expect(await k.signInWith(GITHUB('22', 'bo'))).toStrictEqual({ actor: 'bo_2', created: true });
  expect(await k.reachable('bo_2')).toStrictEqual([]);
  expect(await rejection(k.openSession('bo_2', 'product', { kolab: 'anns' }))).toMatch(/access|reach|no grant|kolab anns/i);
  // Someone else whose GitHub login is now Bo, or bo-claude: never the old ids, nor in their namespace.
  expect((await k.signInWith(GITHUB('99', 'Bo'))).actor).toBe('bo_3');
  expect((await k.signInWith(GITHUB('98', 'BO-claude'))).actor).toBe('gh_bo-claude');
  expect((await k.signInWith(GITHUB('97', 'bo-x'))).actor).toBe('gh_bo-x');
  // Nor anyone a deleted account's id: those are deleted accounts' alone.
  expect((await k.signInWith(GITHUB('96', 'deleted-abc'))).actor).toBe('gh_deleted-abc');
  // Bo's old messages are the deleted account's, not the new person's.
  expect((await k.channelMessagesPage(ann.access, 'general')).items.filter((m) => m.from === gone).map((m) => m.from_deleted)).toStrictEqual([true]);
  expect((await k.channelMessagesPage(ann.access, 'general')).items.filter((m) => m.from.startsWith('bo')).map((m) => m.from)).toStrictEqual([]);

  // Not by an admin, in any case, nor `<old>-x` for anyone; nor a deleted account's id.
  for (const name of ['bo', 'BO', 'bo-claude', 'Bo-Claude', 'bo-x', 'bo-claude-2']) {
    expect([name, await rejection(k.addActor(name))]).toStrictEqual([name, expect.stringMatching(/isn't available|taken|exists/)]);
  }
  expect(await rejection(k.addActor('bo-x', { owner: 'ann' }))).toMatch(/isn't available/);
  expect(await rejection(k.addOrganization('bo'))).toMatch(/isn't available/);
  expect(await rejection(k.addActor('deleted-0123456789ab'))).toMatch(/isn't available/);
  expect(await rejection(k.addActor(`${gone}-2`, { owner: 'ann' }))).toMatch(/isn't available/);
  // A person's agents are theirs: bo_2's are bo_2-*, and gh_bo-smith's gh_bo-smith-*; and bob, not Bo, keeps his.
  expect(await k.addOwnAgent('bo_2', 'claude')).toBe('bo_2-claude');
  expect(await k.addOwnAgent('gh_bo-smith', 'claude')).toBe('gh_bo-smith-claude');
  expect(await k.addOwnAgent('bob', 'claude')).toBe('bob-claude');
  // The database holds to it, whatever writes: the old names, the new ones.
  await expect(k.db.query(`insert into account(id, kind, name, created_by) values ('Bo', 'user', 'Bo', 'admin')`)).rejects.toThrow(/never given to anyone again/);
  await expect(k.db.query(`insert into actor(id, name, kind, owner_id, created_by) values ('bo-y', 'bo-y', 'agent', 'ann', 'admin')`)).rejects.toThrow(/never given to anyone again/);
  await expect(k.db.query(`insert into account(id, kind, name, created_by) values ('deleted-zz', 'organization', 'Z', 'admin')`)).rejects.toThrow(/deleted account's, and no one else's/);
  await expect(k.db.query(`update actor set id = 'deleted-zz' where id = 'ann'`)).rejects.toThrow(/deleted account's, and no one else's/);
  // The retired names are kept as their digests, never as the names.
  expect(await count(k, `retired_name`)).toBe(2);
  expect(await count(k, `retired_name where digest in ('bo', 'bo-claude')`)).toBe(0);
  await expect(k.db.query(`delete from retired_name`)).rejects.toThrow(/never removed/);

  // An admin can't bring it back, link it again, or free its name; nor can the database.
  expect(await rejection(k.unarchive({ actor: gone }))).toMatch(/deleted their account, which is for good/);
  expect(await rejection(k.unarchive({ actor: `${gone}-1` }))).toMatch(/deleted their account, which is for good/);
  expect(await rejection(k.linkIdentity(gone, { provider: 'github', subject: '77' }))).toMatch(/deleted their account/);
  await expect(k.db.query(`update account set archived_at = null where id = $1`, [gone])).rejects.toThrow(/a deleted account never changes again/);
  await expect(k.db.query(`update account set deleted_at = null where id = $1`, [gone])).rejects.toThrow(/a deleted account never changes again/);
  await expect(k.db.query(`update account set id = 'bo' where id = $1`, [gone])).rejects.toThrow(/never given to anyone again|never changes again/);
  await expect(k.db.query(`delete from account where id = $1`, [gone])).rejects.toThrow(/a deleted account is kept/);
  await expect(k.db.query(`update actor set name = 'Bo B.' where id = $1`, [gone])).rejects.toThrow(/kept as they are/);
  await expect(k.db.query(`update actor set owner_id = 'ann' where id = $1`, [`${gone}-1`])).rejects.toThrow(/kept as they are/);
  await expect(k.db.query(`update actor set kind = 'person' where id = $1`, [`${gone}-1`])).rejects.toThrow(/kept as they are|actor_owner_check/);
  await expect(k.db.query(`insert into identity(provider, subject, actor_id, login, linked_by) values ('github', '78', $1, 'bo', 'admin')`, [gone])).rejects.toThrow(/deleted their account/);
  await expect(k.db.query(`update account set deleted_at = now() where id = 'ann'`)).rejects.toThrow(/account_deleted_check/);
  // A re-key is Kolab's own login's alone, inside a deletion: a message never changes otherwise.
  await expect(k.db.query(`update message set sent_by = 'ann' where sent_by = $1`, [gone])).rejects.toThrow(/never edited or removed/);
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
  expect(await count(k, `retired_name`)).toBe(0);
  expect(await k.sessionOpen(bo.access)).toBe(true);
  expect(await k.sessionOpen(agent)).toBe(true);
});

test('refused while they own a live kolab someone else is in, or with documents, or with a repository, or alone own an organization with members: each named with what works, and nothing changes', async () => {
  const { k, ann, bo } = await world();
  await k.createKolab('docs', { owner: 'ann' });
  const annDocs = await k.openSession('ann', 'product', { kolab: 'docs' });
  await k.createNode(annDocs, 'spec', 'Orders', 'orders');
  await k.endSession(annDocs);
  await k.createKolab('code', { owner: 'ann' });
  const annCode = await k.openSession('ann', 'product', { kolab: 'code' });
  await k.registerRepository(annCode, { url: 'https://github.com/ann/code', root_sha: ROOT });
  await k.endSession(annCode);
  await k.createKolab('quiet', { owner: 'ann' });
  // An archived kolab never blocks, whoever is in it.
  await k.createKolab('old', { owner: 'ann' });
  await k.grant('old', 'bo', 'read');
  await k.archive({ kolab: 'old' });
  await k.addOrganization('acme');
  await k.addMember('acme', 'ann', 'owner');
  await k.addMember('acme', 'bo', 'member');
  const refused = await blocked(k.deleteOwnAccount(ann.access, 'ann'));
  expect(refused.blockers).toStrictEqual([
    ['kolab', 'anns', 'members'], ['kolab', 'code', 'repository'], ['kolab', 'docs', 'documents'], ['organization', 'acme', 'organization'],
  ]);
  // What each says to do is what works: archive the kolab (its owner can, with members in it), or
  // remove its members; an organization's, a Konjir admin.
  expect(refused.why).toStrictEqual([
    'kolab anns is yours and has 2 other members: archive it (konjir_archive_kolab), which you can do with them in it, or remove them (konjir_remove_member)',
    'kolab code is yours and has a repository registered to it, which is never removed: archive it (konjir_archive_kolab), which keeps it',
    'kolab docs is yours and holds documents: archive it (konjir_archive_kolab), which keeps them',
    'you are the only owner of organization acme, which has 1 other member: ask a Konjir admin to make one of them an owner, or to remove them',
  ]);
  expect(refused.message).toMatch(/^your account can't be deleted yet: kolab anns is yours .*\. Deal with each first, then delete your account again$/);
  expect(refused.message).not.toMatch(/hand it over/);
  // Nothing changed: not even the kolab that would have been erased.
  expect(await count(k, `kolab where id in ('anns', 'docs', 'code', 'quiet', 'old')`)).toBe(5);
  expect(await count(k, `identity where actor_id = 'ann'`)).toBe(1);
  expect(await count(k, `retired_name`)).toBe(0);
  expect(await k.sessionOpen(ann.access)).toBe(true);

  // Bo is a member of acme, not its owner: he deletes his account, and leaves it; and the archived
  // kolab he was in keeps nothing of him.
  await k.deleteOwnAccount(bo.access, 'bo');
  const [gone] = await deletedId(k);
  expect(await count(k, `org_member where user_id = $1`, [gone])).toBe(0);
  expect(await count(k, `kolab_grant where kolab_id = 'old'`)).toBe(0);
  const removed = (await k.auditLog({ subject: gone })).filter((e) => e.action === 'member.removed').map((e) => e.detail);
  expect(removed).toStrictEqual([{ org: 'acme', deleted: true }]);
});

test('a kolab only they are in, but with a repository registered to it, blocks: archived, it doesn\'t, and it stays archived, as nobody can own it again; erasing it says the same, never a database error', async () => {
  const { k, bo } = await world();
  const inBos = await k.openSession('bo', 'product', { kolab: 'bos' });
  await k.registerRepository(inBos, { url: 'https://github.com/bo/bos', root_sha: ROOT });
  const refused = await blocked(k.deleteOwnAccount(bo.access, 'bo'));
  expect(refused.blockers).toStrictEqual([['kolab', 'bos', 'repository']]);
  expect(refused.message).not.toMatch(/foreign key|violates|23503/);
  expect(await rejection(k.eraseOwnKolab(inBos, 'bos'))).toBe('TenancyError: kolab bos has a repository registered to it, which is never removed, so it can\'t be erased: archive it instead, which keeps it');
  expect(await count(k, `retired_name`)).toBe(0);

  await k.archiveOwnKolab(inBos, 'bos');
  expect(await k.deleteOwnAccount(bo.access, 'bo')).toMatchObject({ deleted: 'bo', erased: [], left: ['anns', 'bos'] });
  const [gone] = await deletedId(k);
  // The archived kolab is the deleted account's, under its new id, and stays archived.
  expect((await k.db.query(`select owner_id as owner, archived_at is not null as archived from kolab where id = 'bos'`)).rows).toStrictEqual([{ owner: gone, archived: true }]);
  expect((await k.db.query(`select registered_by from repository where kolab_id = 'bos'`)).rows).toStrictEqual([{ registered_by: gone }]);
  expect(await rejection(k.unarchive({ kolab: 'bos' }))).toBe(`TenancyError: kolab bos belonged to ${gone}, who deleted their account: it stays archived, as no one can own it again`);
});

test('whatever else the erase can\'t remove, the person is told nothing changed, never what the database said', async () => {
  const { k, bo } = await world();
  // Something Kolab doesn't know of that refers to the kolab Bo alone is in.
  await k.db.exec(`create table elsewhere (kolab_id text references kolab(id)); insert into elsewhere values ('bos')`);
  const e = await rejection(k.deleteOwnAccount(bo.access, 'bo'));
  expect(e).toBe('TenancyError: your account couldn\'t be deleted: something of yours is still in use. Nothing was changed; try again, or ask a Konjir admin');
  expect(await count(k, `account where id = 'bo' and deleted_at is null`)).toBe(1);
  expect(await count(k, `retired_name`)).toBe(0);
  expect(await k.sessionOpen(bo.access)).toBe(true);
});

test('an organization they alone own blocks while it has other members, owns live agents, or has a live kolab anyone else is in or that holds documents; else its kolabs only they are in go, and it is archived for good', async () => {
  const { k, bo } = await world();
  await k.addOrganization('acme');
  await k.addMember('acme', 'bo', 'owner');
  await k.createKolab('acme-web', { owner: 'acme' });
  await k.grant('acme-web', 'ann', 'read');
  await k.createKolab('acme-docs', { owner: 'acme' });
  // One session of Bo's by hand at a time (one_open_session_per_machine): each ended once used.
  const by = async (kolab: string, fn: (s: string) => Promise<unknown>) => { const s = await k.openSession('bo', 'product', { kolab }); await fn(s); await k.endSession(s); };
  await by('acme-docs', (s) => k.createNode(s, 'spec', 'Orders', 'orders'));
  await k.createKolab('acme-chat', { owner: 'acme' });
  await k.addActor('acme-bot', { owner: 'acme' });
  let refused = await blocked(k.deleteOwnAccount(bo.access, 'bo'));
  expect(refused.blockers).toStrictEqual([['organization', 'acme', 'agents'], ['kolab', 'acme-docs', 'documents'], ['kolab', 'acme-web', 'members']]);
  expect(refused.why).toStrictEqual([
    'organization acme, which you alone own, owns 1 live agent: ask a Konjir admin to archive it',
    'kolab acme-docs, of organization acme, which you alone own, holds documents: archive it (konjir_archive_kolab), which keeps them',
    'kolab acme-web, of organization acme, which you alone own, has 1 other member: archive it (konjir_archive_kolab), which you can do with them in it, or remove them (konjir_remove_member)',
  ]);
  // Another member blocks it as a whole: what to do with its kolabs is for them too.
  await k.addMember('acme', 'ann', 'member');
  refused = await blocked(k.deleteOwnAccount(bo.access, 'bo'));
  expect(refused.blockers).toStrictEqual([['organization', 'acme', 'organization'], ['organization', 'acme', 'agents']]);
  await k.removeMember('acme', 'ann');

  // Dealt with: the agent archived, the kolabs with others or documents archived.
  await k.archive({ actor: 'acme-bot' });
  await by('acme-web', (s) => k.archiveOwnKolab(s, 'acme-web'));
  await by('acme-docs', (s) => k.archiveOwnKolab(s, 'acme-docs'));
  expect(await k.deleteOwnAccount(bo.access, 'bo')).toMatchObject({ erased: ['bos', 'acme-chat'] });
  expect(await count(k, `kolab where id = 'acme-chat'`)).toBe(0);
  // The organization is archived, by the deleted account: nobody can administer it, so it stays so.
  const [gone] = await deletedId(k);
  expect((await k.db.query(`select archived_at is not null as archived from account where id = 'acme'`)).rows).toStrictEqual([{ archived: true }]);
  expect((await k.db.query(`select done_by from archive_event where target_kind = 'organization' and target_id = 'acme'`)).rows).toStrictEqual([{ done_by: gone }]);
  expect(await rejection(k.unarchive({ organization: 'acme' }))).toBe('TenancyError: organization acme was archived when its only owner deleted their account: it stays archived, as no one can administer it');
  // An organization with another owner is only left.
  expect(await count(k, `org_member where org_id = 'acme'`)).toBe(0);
});

test('every row that named them, in live and archived kolabs alike, names the new id; what archived kolabs kept of them is scrubbed; nothing dangles', async () => {
  const { k, bo, agent } = await world();
  // Bo writes a document in Ann's kolab, holds a lease there, and made Ann an admin once.
  await k.createKolab('docs', { owner: 'ann' });
  await k.grant('docs', 'bo', 'write');
  const boDocs = await k.openSession('bo', 'product', { kolab: 'docs' });
  await k.createNode(boDocs, 'spec', 'Payments', 'payments');
  await k.endSession(boDocs);
  await k.claimLease(agent, 'test-db');
  await k.endSession(agent);
  await k.makeAdmin('bo');
  await k.makeAdmin('ann', { by: 'bo' });
  await k.removeAdmin('bo');
  // An archived kolab of Bo's, with his words and his agent's, an invitation to him, his prefs, and a session that said where he was.
  await k.createKolab('old', { owner: 'bo' });
  await k.grant('old', 'ann', 'read');
  await k.grant('old', 'bo-claude', 'write');
  const boOld = await k.openSession('bo', 'product', { kolab: 'old' });
  await k.sendChannelMessage(boOld, 'general', 'Last one out');
  await k.sendChannelMessage(await k.openSession('bo-claude', 'engineer', { kolab: 'old' }), 'general', 'Lights off');
  await k.db.query(`insert into kolab_invitation(id, kolab_id, provider, subject, login, level, invited_by) values ('ivt_0123456789abcdef', 'old', 'github', '22', 'bo', 'read', 'ann')`);
  await k.db.query(`insert into notification_pref(kolab_id, actor_id, level) values ('old', 'bo', 'all')`);
  await k.db.query(`update session set place = 'Bo''s MacBook' where actor_id = 'bo'`);
  await k.archive({ kolab: 'old' });

  await k.deleteOwnAccount(bo.access, 'bo');
  const [gone] = await deletedId(k);
  // Nothing anywhere names bo or bo-claude: not a message, mention, receipt, document, lease,
  // admin, audit or archive row, live or archived.
  expect(await naming(k, ['bo', 'bo-claude'])).toStrictEqual([]);
  // The rows are there, under the new ids.
  expect((await k.db.query(`select created_by from node where name = 'payments'`)).rows).toStrictEqual([{ created_by: gone }]);
  expect((await k.db.query(`select granted_by from konjir_admin where actor_id = 'ann'`)).rows).toStrictEqual([{ granted_by: gone }]);
  expect((await k.db.query(`select owner_id as owner from kolab where id = 'old'`)).rows).toStrictEqual([{ owner: gone }]);
  expect((await k.db.query(`select sent_by, body from channel_message where kolab_id = 'old' order by sent_at`)).rows)
    .toStrictEqual([{ sent_by: gone, body: 'Last one out' }, { sent_by: `${gone}-1`, body: 'Lights off' }]);
  // What the archived kolab kept of Bo himself is gone: the invitation to him, his prefs, where he was.
  expect(await count(k, `kolab_invitation where kolab_id = 'old'`)).toBe(0);
  expect(await count(k, `notification_pref where kolab_id = 'old'`)).toBe(0);
  expect(await count(k, `session where actor_id = any($1::text[]) and (place is not null or (machine_key is not null and machine_key <> 'agent'))`, [[gone, `${gone}-1`]])).toBe(0);
  // Ann's own access there is as it was; the words people wrote stay as they wrote them.
  expect(await count(k, `kolab_grant where kolab_id = 'old' and user_id = 'ann'`)).toBe(1);
  expect(await count(k, `channel_message where body = 'Standup at ten, @bo'`)).toBe(1);
  // Every foreign key that names an actor or an account finds it, as the database checks it: a row
  // whose key's columns are all set names a row that is there.
  const fks = (await k.db.query<{ t: string; cols: string[]; ref: string; refs: string[] }>(
    `select f.conrelid::regclass::text as t, f.confrelid::regclass::text as ref,
            array(select a.attname::text from unnest(f.conkey) with ordinality u(n, o) join pg_attribute a on a.attrelid = f.conrelid and a.attnum = u.n order by u.o) as cols,
            array(select a.attname::text from unnest(f.confkey) with ordinality u(n, o) join pg_attribute a on a.attrelid = f.confrelid and a.attnum = u.n order by u.o) as refs
       from pg_constraint f where f.contype = 'f' and f.confrelid in ('actor'::regclass, 'account'::regclass)`)).rows;
  for (const { t, cols, ref, refs } of fks) {
    const dangling = await count(k, `${t} x where ${cols.map((c) => `x.${c} is not null`).join(' and ')}
      and not exists (select 1 from ${ref} r where ${cols.map((c, i) => `r.${refs[i]} = x.${c}`).join(' and ')})`);
    expect([t, cols, dangling]).toStrictEqual([t, cols, 0]);
  }
});

test('every column that names an actor is carried by a foreign key or re-keyed by Kolab, and every reference to a kolab is erased with it or keeps it from being erased', async () => {
  const k = await openKolab();
  const fk = new Set((await k.db.query<{ col: string }>(
    `select replace(f.conrelid::regclass::text, '"', '') || '.' || a.attname as col from pg_constraint f
       join pg_attribute a on a.attrelid = f.conrelid and a.attnum = any(f.conkey)
      where f.contype = 'f' and f.confrelid in ('actor'::regclass, 'account'::regclass) and a.attgenerated = ''`)).rows.map((r) => r.col));
  const rekeyed = new Set(ACTOR_ID_COLUMNS.map((c) => `${c.table}.${c.column}`));
  // Columns whose names read as an actor's but hold something else.
  const NOT_ACTORS = new Set([
    'identity.subject', 'kolab_invitation.subject',   // an identity provider's id for a person, never an actor's
    'invalidation.triggered_by',                      // a version
    'case_file.superseded_by',                        // a case file
    'outbox.claimed_by',                              // a Kolab process
    'audit_event.subject',                            // re-keyed for the actions whose subject is an actor (ACTOR_ID_COLUMNS)
    'archive_event.target_id',                        // re-keyed where it is an actor (ACTOR_ID_COLUMNS)
    'rate_event.owner_id',                            // a deleted account's rate events go
  ]);
  const actorish = (await k.db.query<{ col: string }>(
    `select table_name || '.' || column_name as col from information_schema.columns
      where table_schema = 'public' and data_type = 'text'
        and (column_name like '%\\_by' or column_name in ('actor_id', 'owner_id', 'owner', 'holder', 'subject', 'sent_to', 'person_id', 'agent_id',
             'reviewer_id', 'user_id', 'assignee_id', 'assignee_from', 'assignee_to', 'target_id'))
      order by 1`)).rows.map((r) => r.col);
  expect(actorish.filter((c) => !fk.has(c) && !rekeyed.has(c) && !NOT_ACTORS.has(c))).toStrictEqual([]);
  // ACTOR_ID_COLUMNS names real columns with no foreign key of their own.
  for (const c of rekeyed) expect([c, actorish.includes(c), fk.has(c)]).toStrictEqual([c, true, false]);

  const toKolab = (await k.db.query<{ col: string }>(
    `select replace(f.conrelid::regclass::text, '"', '') || '.' || a.attname as col from pg_constraint f
       join pg_attribute a on a.attrelid = f.conrelid and a.attnum = any(f.conkey)
      where f.contype = 'f' and f.confrelid = 'kolab'::regclass order by 1`)).rows.map((r) => r.col);
  const known = new Set([...ERASED_WITH_KOLAB.map((t) => `${t}.kolab_id`), 'kolab_grant.kolab_id', 'oauth_code.kolab', 'session.kolab_id',
    ...KEPT_WITH_KOLAB.map((x) => `${x.table}.${x.column}`)]);
  expect(toKolab.filter((c) => !known.has(c))).toStrictEqual([]);
});
