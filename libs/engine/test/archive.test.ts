// Archiving kolabs, organizations and actors (D52; DAT10, TEN2, TEN4, TEN11): an archived one is
// left out of listings and can't be used, its data is kept for audit, and its name stays reserved.
// Its sessions end, and their streams are told (D41). The engine refuses it, and so does the
// database: kj_access gives nothing there, so row-level security does too, and no role at all may
// write an archived kolab's data or open a session in it (0014).
import { expect, test } from '@jest/globals';
import { MIGRATIONS, migrate } from '@konjir/db';
import { NameTakenError, sessionKey, type Kolab } from '@konjir/engine';
import type { KolabEvent } from '@konjir/types';
import { els, openKolab, rejection } from '@konjir/engine/testing';

const NONE = { level: null, layers: [] };

/** Runs `sql` as kj_agent in `session`, so row-level security applies. */
const asAgent = <T extends Record<string, unknown>>(kolab: Kolab, session: string, sql: string, params: unknown[] = []) =>
  kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(session)]);
    return (await tx.query<T>(sql, params)).rows;
  });

/** The sessions whose end was signalled, by key, as listeners hear them (D41). */
function endings(kolab: Kolab) {
  const ended: string[] = [];
  kolab.onEvent((e: KolabEvent) => { if ('session' in e && e.session === 'ended') ended.push(e.id); });
  return ended;
}

/**
 * The organization acme owns the kolab `orders`, with a spec in it. Ann is an owner of acme, Bob
 * a member with a grant; ann-pm is Ann's agent and acme-bot acme's. Each has a session there. Bob
 * also owns a kolab of his own, `notes`.
 */
async function world() {
  const kolab = await openKolab();
  await kolab.addOrganization('acme');
  await kolab.addActor('ann');
  await kolab.addActor('bob');
  await kolab.addMember('acme', 'ann', 'owner');
  await kolab.addMember('acme', 'bob');
  await kolab.createKolab('orders', { owner: 'acme' });
  await kolab.createKolab('notes', { owner: 'bob' });
  await kolab.grant('orders', 'bob', 'write', { layers: ['technical'] });
  const ann = await kolab.openSession('ann', 'product', { kolab: 'orders' });
  // Alone on the functional layer, Ann commits the spec without review (W1.6).
  await kolab.createNode(ann, 'functional_spec', 'Orders', 'orders-spec');
  await kolab.commit(ann, 'orders-spec', { elements: els({ R1: 'Orders can be cancelled.' }) });
  await kolab.addActor('ann-pm', { owner: 'ann' });
  await kolab.grant('orders', 'ann-pm', 'write', { layers: ['functional'] });
  await kolab.addActor('acme-bot', { owner: 'acme' });
  await kolab.grant('orders', 'acme-bot', 'read');
  const s = {
    ann,
    bob: await kolab.openSession('bob', 'engineer', { kolab: 'orders' }),
    pm: await kolab.openSession('ann-pm', 'product', { kolab: 'orders' }),
    bot: await kolab.openSession('acme-bot', 'engineer', { kolab: 'orders' }),
  };
  return { kolab, s };
}

test('an archived kolab ends its sessions, refuses new ones and every write, and is hidden from listings; its data is kept', async () => {
  const { kolab, s } = await world();
  const ended = endings(kolab);
  const draft = await kolab.draft(s.ann, 'orders-spec', { elements: els({ R1: 'Orders can be cancelled by staff.' }) });

  expect(await kolab.archive({ kolab: 'orders' })).toStrictEqual({ archived: { kolab: 'orders' }, kolabs: [], agents: [], ended: 4 });
  // Every session in it ended, in the same transaction, and each was signalled so its streams close.
  expect(ended.sort()).toStrictEqual(Object.values(s).map(sessionKey).sort());
  expect(await kolab.openSessions(Object.values(s))).toStrictEqual(new Set());
  expect(await rejection(kolab.sessionInfo(s.ann))).toMatch(/no open session/);

  // No session opens there, for anyone, and nobody holds anything in it.
  expect(await rejection(kolab.openSession('ann', 'product', { kolab: 'orders' })))
    .toMatch(/TenancyError: kolab orders is archived, so it opens no session; its data is kept, and an admin can unarchive it/);
  expect(await kolab.access('ann', 'orders')).toStrictEqual(NONE);
  expect(await kolab.access('ann-pm', 'orders')).toStrictEqual(NONE);
  expect(await kolab.reachable('bob')).toStrictEqual(['notes']);
  // Nothing about it changes through the admin verbs either.
  expect(await rejection(kolab.grant('orders', 'bob', 'read'))).toMatch(/kolab orders is archived, so it grants no access/);
  expect(await rejection(kolab.applyRuling('orders-spec', { elements: els({ R1: 'x' }) }, { id: 'D52', actor: 'ann' })))
    .toMatch(/kolab orders is archived, so it takes no ruling/);
  // Removing a grant only takes away access it can't use: that is allowed.
  await kolab.revoke('orders', 'acme-bot');

  // Hidden from listings; listed, flagged, only when asked for.
  expect((await kolab.listKolabs()).map((k) => k.id)).toStrictEqual(['notes']);
  expect((await kolab.listKolabs({ archived: true })).map((k) => [k.id, k.archived])).toStrictEqual([['notes', false], ['orders', true]]);
  expect(await kolab.listKolabs({ owner: 'acme' })).toStrictEqual([]);

  // Its data is kept, and Kolab's own reads, the admin token's, still see it.
  expect((await kolab.node('orders-spec')).kolab_id).toBe('orders');
  expect((await kolab.listNodes(undefined, 'orders')).map((n) => n.name)).toStrictEqual(['orders-spec']);
  expect((await kolab.version(draft)).state).toBe('drafted');

  // The database refuses any write to it, from any role: Kolab's own login included.
  const v1 = (await kolab.latestCommitted('orders-spec'))!;
  for (const sql of [
    `insert into node(id, name, kind, layer, title, kolab_id) values ('n2', 'n2', 'functional_spec', 'functional', 'N2', 'orders')`,
    `update element set text = 'Rewritten.' where version_id = '${v1.id}'`,
    `delete from element where version_id = '${v1.id}'`,
    `update version set state = 'rejected' where id = '${draft}'`,
    `insert into kolab_grant(kolab_id, agent_id, level, functional, technical) values ('orders', 'acme-bot', 'read', false, false)`,
    `update kolab_grant set level = 'admin', functional = true, technical = true where kolab_id = 'orders' and user_id = 'bob'`,
    `insert into session(id, actor_id, active_role, kolab_id, expires_at) values ('${sessionKey('kjs_sneak')}', 'ann', 'product', 'orders', now() + interval '1 day')`,
  ]) expect(await rejection(kolab.db.query(sql))).toMatch(/kolab orders is archived/);
  // Row-level security follows kj_access: a session there, however it came to be open, reads and writes nothing.
  await kolab.db.exec(`alter table session disable trigger session_openable`);
  await kolab.db.query(`insert into session(id, actor_id, active_role, kolab_id, opened_by, expires_at) values ($1, 'ann', 'product', 'orders', 'admin', now() + interval '1 day')`, [sessionKey('kjs_backdoor')]);
  await kolab.db.exec(`alter table session enable trigger session_openable`);
  expect(await asAgent(kolab, 'kjs_backdoor', `select id from node`)).toStrictEqual([]);
  expect(await asAgent(kolab, 'kjs_backdoor', `select kj_session_kolab() as k, kj_session_layer() as l, kj_session_readable_kolabs() as r`))
    .toStrictEqual([{ k: null, l: null, r: [] }]);
  // And the engine ends it the moment it is used.
  expect(await rejection(kolab.sessionInfo('kjs_backdoor'))).toMatch(/AccessError: ann can no longer reach kolab orders; its session has ended/);

  // Its name stays reserved, refused in the words a live kolab's is, so the refusal says nothing
  // of an archived one; only the error itself, for the admin token's verbs, names it.
  const taken = await kolab.createKolab('orders', { owner: 'bob' }).catch((e) => e);
  expect(String(taken)).toBe('TenancyError: the kolab name orders is taken: kolab names are unique across all of Konjir');
  expect(taken).toBeInstanceOf(NameTakenError);
  expect(taken.archived).toStrictEqual({ kind: 'kolab', id: 'orders' });
  expect(await kolab.createKolab('notes', { owner: 'bob' }).catch((e) => [String(e), e.archived])).toStrictEqual([
    'TenancyError: the kolab name notes is taken: kolab names are unique across all of Konjir', undefined]);

  // Archiving twice is refused, plainly.
  expect(await rejection(kolab.archive({ kolab: 'orders' }))).toMatch(/TenancyError: kolab orders is already archived/);
});

test('an unarchived kolab is as it was: its grants count again, its draft goes on, and sessions open anew', async () => {
  const { kolab, s } = await world();
  const draft = await kolab.draft(s.ann, 'orders-spec', { elements: els({ R1: 'Orders can be cancelled by staff.' }) });
  await kolab.archive({ kolab: 'orders' });
  expect(await kolab.unarchive({ kolab: 'orders' })).toStrictEqual({ unarchived: { kolab: 'orders' }, kolabs: [], agents: [] });
  expect(await rejection(kolab.unarchive({ kolab: 'orders' }))).toMatch(/TenancyError: kolab orders isn't archived/);
  // The old tokens stay ended; new sessions hold what they held before.
  expect(await kolab.openSessions(Object.values(s))).toStrictEqual(new Set());
  const ann = await kolab.openSession('ann', 'product', { kolab: 'orders' });
  const bob = await kolab.openSession('bob', 'engineer', { kolab: 'orders' });
  expect((await kolab.sessionInfo(bob)).access).toStrictEqual({ level: 'write', layers: ['technical'] });
  // Ann's draft from before goes on to review by her agent, as any other.
  expect(await kolab.submit(ann, draft)).toMatchObject({ in_review: true, reviewers: ['ann-pm'] });
  expect((await kolab.listKolabs()).map((k) => k.id)).toStrictEqual(['notes', 'orders']);
});

test("an archived organization takes its kolabs and agents with it, and its members' grants stop counting there", async () => {
  const { kolab, s } = await world();
  const ended = endings(kolab);
  // Bob works in his own kolab now: acme's archiving leaves that session be.
  await kolab.endSession(s.bob);
  const bobNotes = await kolab.openSession('bob', 'product', { kolab: 'notes' });
  const before = ended.length;

  expect(await kolab.archive({ organization: 'acme' })).toMatchObject({ archived: { organization: 'acme' }, kolabs: ['orders'], agents: ['acme-bot'] });
  expect(await kolab.openSessions([...Object.values(s), bobNotes])).toStrictEqual(new Set([bobNotes]));
  expect(ended.slice(before).sort()).toStrictEqual([s.ann, s.pm, s.bot].map(sessionKey).sort());
  // Its owner and members hold nothing there; its agent nothing anywhere.
  expect(await kolab.access('ann', 'orders')).toStrictEqual(NONE);
  expect(await kolab.access('bob', 'orders')).toStrictEqual(NONE);
  expect(await kolab.access('acme-bot', 'orders')).toStrictEqual(NONE);
  expect(await kolab.access('bob', 'notes')).toMatchObject({ level: 'admin' });
  expect((await kolab.listKolabs()).map((k) => k.id)).toStrictEqual(['notes']);
  expect((await kolab.listActors()).map((a) => a.id)).toStrictEqual(['ann', 'ann-pm', 'bob']);
  expect((await kolab.listActors({ archived: true })).filter((a) => a.archived).map((a) => a.id)).toStrictEqual(['acme-bot']);

  // Nothing new uses it, and its name stays reserved, for an organization and a person alike.
  expect(await rejection(kolab.openSession('acme-bot', 'engineer', { kolab: 'orders' })))
    .toMatch(/ActorError: acme-bot's owner acme is archived, so acme-bot opens no session; unarchive acme first/);
  expect(await rejection(kolab.openSession('ann', 'product', { kolab: 'orders' })))
    .toMatch(/TenancyError: kolab orders is archived with its owner acme, so it opens no session; unarchive acme to restore it/);
  expect(await rejection(kolab.createKolab('orders-2', { owner: 'acme' }))).toMatch(/organization acme is archived, so it owns no new kolab/);
  expect(await rejection(kolab.addMember('acme', 'bob', 'owner'))).toMatch(/organization acme is archived, so it takes no members/);
  expect(await rejection(kolab.addTeam('acme', 'eng'))).toMatch(/organization acme is archived, so it gets no new team/);
  expect(await rejection(kolab.addActor('acme-bot-2', { owner: 'acme' }))).toMatch(/acme is archived, so it can't own a new agent/);
  expect(await rejection(kolab.addOrganization('acme'))).toBe('TenancyError: account acme already exists');
  expect(await rejection(kolab.addActor('acme'))).toBe('ActorError: account acme already exists');
  expect(await rejection(kolab.addActor('ACME', { owner: 'bob' }))).toBe('ActorError: the name ACME is taken: acme holds it, and names must differ in more than case');
  expect((await kolab.addOrganization('Acme').catch((e) => e)).archived).toStrictEqual({ kind: 'organization', id: 'acme' });
  // A member can still be removed: that takes away only what counts for nothing now.
  await kolab.removeMember('acme', 'bob');

  // What went with its owner comes back with its owner, and only then.
  expect(await rejection(kolab.unarchive({ kolab: 'orders' }))).toMatch(/TenancyError: kolab orders isn't archived/);
  await kolab.archive({ kolab: 'orders' });   // archived on its own as well, now
  expect(await rejection(kolab.unarchive({ kolab: 'orders' }))).toMatch(/the owner of kolab orders, acme, is archived too; unarchive acme, then kolab orders/);
  expect(await rejection(kolab.unarchive({ actor: 'acme-bot' }))).toMatch(/TenancyError: acme-bot isn't archived/);
  expect(await kolab.unarchive({ organization: 'acme' })).toStrictEqual({ unarchived: { organization: 'acme' }, kolabs: [], agents: ['acme-bot'] });
  // orders stays archived, since it was archived on its own; acme's agent is back, with its grant.
  expect(await kolab.access('ann', 'orders')).toStrictEqual(NONE);
  await kolab.unarchive({ kolab: 'orders' });
  expect(await kolab.access('ann', 'orders')).toMatchObject({ level: 'admin' });
  expect(await kolab.access('acme-bot', 'orders')).toStrictEqual({ level: 'read', layers: [] });
});

test("an archived person's sessions end, and their agents' too; their name stays reserved", async () => {
  const { kolab, s } = await world();
  const ended = endings(kolab);
  expect(await kolab.archive({ actor: 'ann' })).toStrictEqual({ archived: { actor: 'ann' }, kolabs: [], agents: ['ann-pm'], ended: 2 });
  expect(ended.sort()).toStrictEqual([sessionKey(s.ann), sessionKey(s.pm)].sort());
  expect(await kolab.openSessions(Object.values(s))).toStrictEqual(new Set([s.bob, s.bot]));
  // Neither she nor her agent opens a session, or holds anything, anywhere.
  expect(await rejection(kolab.openSession('ann', 'product', { kolab: 'orders' }))).toMatch(/ActorError: ann is archived, so it opens no session; unarchive it first/);
  expect(await rejection(kolab.openSession('ann-pm', 'product', { kolab: 'orders' })))
    .toMatch(/ActorError: ann-pm's owner ann is archived, so ann-pm opens no session; unarchive ann first/);
  expect(await kolab.access('ann-pm', 'orders')).toStrictEqual(NONE);
  expect(await rejection(kolab.grant('orders', 'ann', 'read'))).toMatch(/ann is archived, so it is granted nothing/);
  expect(await rejection(kolab.addMember('acme', 'ann'))).toMatch(/ann is archived, so it joins no organization/);
  expect(await rejection(kolab.applyRuling('orders-spec', { elements: els({ R1: 'x' }) }, { id: 'D52', actor: 'ann' })))
    .toMatch(/ann is archived, so nothing is written as it/);
  // The kolab carries on for everyone else; her work in it is kept, and still hers.
  expect((await kolab.sessionInfo(s.bob)).access).toStrictEqual({ level: 'write', layers: ['technical'] });
  expect(await kolab.author((await kolab.latestCommitted('orders-spec'))!.id)).toMatchObject({ actor: 'ann', kind: 'person' });
  // Hidden from listings, she and her agent; the name is refused for a new person, agent or organization.
  expect((await kolab.listActors()).map((a) => a.id)).toStrictEqual(['acme-bot', 'bob']);
  expect(await rejection(kolab.addActor('ann'))).toBe('ActorError: actor ann already exists');
  expect(await rejection(kolab.addActor('Ann'))).toBe('ActorError: the name Ann is taken: ann holds it, and names must differ in more than case');
  expect(await rejection(kolab.addActor('ann-pm', { owner: 'bob' }))).toBe('ActorError: actor ann-pm already exists');
  expect(await rejection(kolab.addOrganization('ANN-PM'))).toBe('TenancyError: the name ANN-PM is taken: ann-pm holds it, and names must differ in more than case');
  expect((await kolab.addOrganization('ann').catch((e) => e)).archived).toStrictEqual({ kind: 'actor', id: 'ann' });
  // A live name is refused alike, in any case, and an agent can't take an organization's.
  expect(await rejection(kolab.addActor('BOB', { owner: 'acme' }))).toMatch(/the name BOB is taken: bob holds it/);
  expect(await rejection(kolab.addActor('acme', { owner: 'bob' }))).toBe('ActorError: account acme already exists');
  // The database refuses her a session too.
  expect(await rejection(kolab.db.query(`insert into session(id, actor_id, active_role, kolab_id, expires_at) values ($1, 'ann-pm', 'product', 'orders', now() + interval '1 day')`, [sessionKey('kjs_x')])))
    .toMatch(/actor ann-pm is archived/);

  // Her agent comes back with her, and only then.
  expect(await rejection(kolab.unarchive({ actor: 'ann-pm' }))).toMatch(/TenancyError: ann-pm isn't archived/);
  await kolab.unarchive({ actor: 'ann' });
  expect((await kolab.sessionInfo(await kolab.openSession('ann-pm', 'product', { kolab: 'orders' }))).access).toStrictEqual({ level: 'write', layers: ['functional'] });
});

test('an archived agent alone: its session ends, its owner and the kolab carry on', async () => {
  const { kolab, s } = await world();
  expect(await kolab.archive({ actor: 'ann-pm' })).toStrictEqual({ archived: { actor: 'ann-pm' }, kolabs: [], agents: [], ended: 1 });
  expect(await kolab.openSessions(Object.values(s))).toStrictEqual(new Set([s.ann, s.bob, s.bot]));
  expect(await rejection(kolab.openSession('ann-pm', 'product', { kolab: 'orders' }))).toMatch(/ActorError: ann-pm is archived, so it opens no session/);
  expect((await kolab.listActors({ owner: 'ann' }))).toStrictEqual([]);
  expect((await kolab.listActors({ owner: 'ann', archived: true }))).toStrictEqual([{ id: 'ann-pm', name: 'ann-pm', kind: 'agent', owner: 'ann', archived: true }]);
  // A person's archive lives on their account: the database keeps it off a person's actor row.
  expect(await rejection(kolab.db.query(`update actor set archived_at = now() where id = 'ann'`))).toMatch(/actor_archived_is_agent/);
  expect(await rejection(kolab.archive({ actor: 'acme' }))).toMatch(/TenancyError: acme is an organization: name it as organization=acme/);
  expect(await rejection(kolab.archive({ actor: 'nobody' }))).toMatch(/ActorError: no actor nobody/);
  await kolab.unarchive({ actor: 'ann-pm' });
  expect((await kolab.listActors({ owner: 'ann' })).map((a) => a.id)).toStrictEqual(['ann-pm']);
});

test("an archived kolab's outbox jobs wait, unclaimed, and run once it is unarchived", async () => {
  const { kolab } = await world();
  const v1 = (await kolab.latestCommitted('orders-spec'))!;
  // A cascade still owed, as a stopped process leaves it (its work is idempotent).
  await kolab.db.query(`insert into outbox(id, kind, version_id) values ('01JOB0000000000000000000AA', 'after_commit', $1)`, [v1.id]);
  await kolab.archive({ kolab: 'orders' });
  expect(await kolab.drainOutbox()).toBe(0);
  expect((await kolab.db.query(`select attempts from outbox`)).rows).toStrictEqual([{ attempts: 0 }]);
  await kolab.unarchive({ kolab: 'orders' });
  expect(await kolab.drainOutbox()).toBe(1);
  expect((await kolab.db.query(`select 1 from outbox`)).rows).toStrictEqual([]);
});

test("a person's own kolab stays live for the others who work in it; only an organization's go with it (D52)", async () => {
  const { kolab, s } = await world();
  await kolab.addActor('carol');
  await kolab.grant('notes', 'carol', 'write');
  const carol = await kolab.openSession('carol', 'product', { kolab: 'notes' });
  await kolab.endSession(s.bob);
  const bob = await kolab.openSession('bob', 'product', { kolab: 'notes' });
  expect(await kolab.archive({ actor: 'bob' })).toStrictEqual({ archived: { actor: 'bob' }, kolabs: [], agents: [], ended: 1 });
  expect(await kolab.openSessions([carol, bob])).toStrictEqual(new Set([carol]));
  expect(await kolab.access('bob', 'notes')).toStrictEqual(NONE);
  expect((await kolab.sessionInfo(carol)).access).toMatchObject({ level: 'write' });
  await kolab.createNode(carol, 'functional_spec', 'Notes', 'notes-spec');
  expect((await kolab.listKolabs()).map((k) => k.id)).toStrictEqual(['notes', 'orders']);
  // Bob owns no new kolab while archived.
  expect(await rejection(kolab.createKolab('notes-2', { owner: 'bob' }))).toMatch(/bob is archived, so it owns no new kolab/);
});

test('archiving checks and changes under the access lock, and every archive and unarchive is logged, never rewritten', async () => {
  const { kolab } = await world();
  const both = await Promise.allSettled([kolab.archive({ organization: 'acme' }), kolab.archive({ organization: 'acme' })]);
  expect(both.map((r) => r.status).sort()).toStrictEqual(['fulfilled', 'rejected']);
  expect(String((both.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/organization acme is already archived/);
  await kolab.unarchive({ organization: 'acme' }, { by: 'lee' });
  await kolab.archive({ kolab: 'notes' });
  expect((await kolab.db.query(`select target_kind, target_id, archived, done_by from archive_event order by id`)).rows).toStrictEqual([
    { target_kind: 'organization', target_id: 'acme', archived: true, done_by: 'admin' },
    { target_kind: 'organization', target_id: 'acme', archived: false, done_by: 'lee' },
    { target_kind: 'kolab', target_id: 'notes', archived: true, done_by: 'admin' },
  ]);
  expect(await rejection(kolab.db.query(`update archive_event set done_by = 'someone'`))).toMatch(/only ever added to/);
  expect(await rejection(kolab.db.query(`delete from archive_event`))).toMatch(/only ever added to/);
});

test('an ended session in an archived kolab, or of an archived actor, never reopens', async () => {
  const { kolab, s } = await world();
  await kolab.archive({ actor: 'ann-pm' });
  expect(await rejection(kolab.db.query(`update session set ended_at = null where id = $1`, [sessionKey(s.pm)]))).toMatch(/actor ann-pm is archived/);
  await kolab.archive({ kolab: 'orders' });
  expect(await rejection(kolab.db.query(`update session set ended_at = null where id = $1`, [sessionKey(s.bob)]))).toMatch(/kolab orders is archived/);
});

test('every table of kolab data refuses writes to an archived kolab: each has the statement-level kolab_writable triggers', async () => {
  const kolab = await openKolab();
  // Not the audit log (0024): removing a grant on an archived kolab is allowed, and is still recorded.
  const tables = (await kolab.db.query<{ t: string }>(
    `select table_name as t from information_schema.columns
      where table_schema = 'public' and column_name = 'kolab_id' and table_name not in ('session', 'outbox', 'audit_event') order by 1`)).rows.map((r) => r.t);
  const triggers = (await kolab.db.query<{ t: string; name: string; level: string }>(
    `select event_object_table as t, trigger_name as name, action_orientation as level from information_schema.triggers
      where trigger_name like 'kolab_writable%'`)).rows;
  expect(tables.length).toBeGreaterThanOrEqual(15);
  for (const t of tables) {
    const mine = triggers.filter((x) => x.t === t);
    const want = t === 'kolab_grant' ? ['kolab_writable_insert', 'kolab_writable_update'] : ['kolab_writable_delete', 'kolab_writable_insert', 'kolab_writable_update'];
    expect([t, [...new Set(mine.map((x) => x.name))].sort()]).toStrictEqual([t, want]);
    expect(mine.every((x) => x.level === 'STATEMENT')).toBe(true);
  }
});

test("an outbox job running when its kolab is archived is released as it was, not counted as an attempt", async () => {
  const { kolab } = await world();
  const v1 = (await kolab.latestCommitted('orders-spec'))!;
  await kolab.db.query(`insert into outbox(id, kind, version_id, attempts, claim, claimed_until)
                        values ('01JOB0000000000000000000AB', 'after_commit', $1, 9, 'tok', now() + interval '1 minute')`, [v1.id]);
  await kolab.archive({ kolab: 'orders' });
  // The run's writes hit the archive, and its failure is handed back as a run's would be.
  await (kolab as unknown as { fail(job: object, e: unknown): Promise<void> })
    .fail({ token: 'tok', kind: 'after_commit', versionId: v1.id }, new Error('kolab orders is archived'));
  expect((await kolab.db.query(`select state, attempts, claim, last_error from outbox`)).rows)
    .toStrictEqual([{ state: 'pending', attempts: 8, claim: null, last_error: null }]);
});

test("a later migration may backfill an archived kolab's rows; nothing else may, not even with the runner's flag set", async () => {
  const { kolab } = await world();
  await kolab.archive({ kolab: 'orders' });
  const backfill = { version: MIGRATIONS.length + 1, name: 'backfill', sql: `update node set title = 'Backfilled' where kolab_id = 'orders'` };
  expect(await rejection(kolab.db.query(backfill.sql))).toMatch(/kolab orders is archived/);
  expect(await migrate(kolab.db, { migrations: [...MIGRATIONS, backfill] })).toMatchObject({ applied: [backfill.version] });
  expect((await kolab.node('orders-spec')).title).toBe('Backfilled');
  // The flag counts only on Kolab's own login, in the runner's transaction: never as kj_agent or kj_system.
  const as = (role: string) => kolab.db.transaction(async (tx) => {
    await tx.query(`select set_config('kj.migrating', 'on', true)`);
    if (role) await tx.exec(`set local role ${role}`);
    return (await tx.query<{ m: boolean }>(`select kj_migrating() as m`)).rows[0].m;
  });
  expect(await as('')).toBe(true);
  expect(await as('kj_system')).toBe(false);
  expect(await as('kj_agent')).toBe(false);
  expect((await kolab.db.query<{ m: boolean }>(`select kj_migrating() as m`)).rows[0].m).toBe(false);
});
