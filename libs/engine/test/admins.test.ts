// Admins are people, not a token (W2.22, D69): who is a Konjir admin, who made them one, the
// last-admin rule while the break-glass token is disabled, an admin's own signed-in session running
// the admin verbs for as long as they are one (D111), each change recorded in the audit log, and
// hand-issued sessions expiring. Never an agent (D30, D56).
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { ADMIN_DOER } from '@konjir/types';
import { Kolab, sessionKey } from '../src/index.js';
import { openKolab, people, rejection, type TestKolab } from '../src/testing.js';

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

/** `person` signs in with the identity provider, as `as` (themselves by default), and gets their tokens and the client that holds them. */
async function signIn(kolab: Kolab, person: string, as: Parameters<Kolab['consent']>[2]['as'] = { kind: 'self' }) {
  const client = (await kolab.registerClient({ name: 'Test client', redirectUris: ['http://127.0.0.1:9/cb'] })).id;
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256(verifier) });
  const { csrf } = await kolab.identifyAuthorization(binding, state, person);
  const { code, redirectUri } = await kolab.consent(binding, csrf, { as, kolab: 'test', role: 'product' });
  return { ...await kolab.exchangeCode({ code, clientId: client, redirectUri, codeVerifier: verifier }), client };
}

/** As signIn, for the access token alone. */
const signedIn = async (...a: Parameters<typeof signIn>) => (await signIn(...a)).accessToken;

/** What refreshing these tokens gets: refused, as the OAuth error's code. */
const refreshRefusal = (kolab: Kolab, t: Awaited<ReturnType<typeof signIn>>) =>
  kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: t.client }).then(() => 'refreshed', (e: { code: string }) => e.code);

async function admins() {
  const kolab = await openKolab();
  await people(kolab, ['lee', 'ann', 'bob']);
  // Lee and Ann sign in with GitHub; Bob has no identity linked, so he never could (L1).
  await kolab.linkIdentity('lee', { provider: 'github', subject: '1001', login: 'lee' }, { by: ADMIN_DOER });
  await kolab.linkIdentity('ann', { provider: 'github', subject: '1002', login: 'ann' }, { by: ADMIN_DOER });
  await kolab.addActor('lee-claude', { owner: 'lee' });
  await kolab.grant('test', 'lee-claude', 'write');
  return kolab;
}

const auditOf = async (kolab: TestKolab, subject: string) =>
  (await kolab.auditLog({ subject })).filter((e) => e.action.startsWith('admin.')).map((e) => [e.action, e.subject, e.by]);

test('a person is made a Konjir admin, by the break-glass token or another admin, each recorded; never an agent, nor anyone archived or unknown', async () => {
  const kolab = await admins();
  expect(await kolab.makeAdmin('lee', { by: ADMIN_DOER })).toBe(true);
  expect(await kolab.makeAdmin('lee', { by: ADMIN_DOER })).toBe(false);   // already one: nothing changes or is recorded again
  expect(await kolab.makeAdmin('ann', { by: 'lee' })).toBe(true);
  expect(await kolab.isAdmin('lee')).toBe(true);
  expect(await kolab.isAdmin('bob')).toBe(false);
  expect((await kolab.admins()).map((a) => [a.actor, a.granted_by, a.archived])).toStrictEqual([['ann', 'lee', false], ['lee', ADMIN_DOER, false]]);
  expect(await auditOf(kolab, 'lee')).toStrictEqual([['admin.granted', 'lee', ADMIN_DOER]]);
  expect(await auditOf(kolab, 'ann')).toStrictEqual([['admin.granted', 'ann', 'lee']]);

  expect(await rejection(kolab.makeAdmin('lee-claude'))).toMatch(/ActorError: lee-claude is an agent, and an agent is never a Konjir admin/);
  expect(await rejection(kolab.makeAdmin('nobody'))).toMatch(/ActorError: no actor nobody/);
  await kolab.archive({ actor: 'bob' });
  expect(await rejection(kolab.makeAdmin('bob'))).toMatch(/ActorError: bob is archived/);
  expect(await rejection(kolab.makeAdmin('lee', { by: '' }))).toMatch(/must name who made it/);

  // The database refuses an agent, and an admin made or removed with no record of it, whatever writes.
  expect(await rejection(kolab.db.transaction(async (tx) => {
    await tx.query(`insert into audit_event(action, subject, done_by) values ('admin.granted', 'lee-claude', 'admin')`);
    await tx.query(`insert into konjir_admin(actor_id, granted_by) values ('lee-claude', 'admin')`);
  }))).toMatch(/lee-claude is not a person; only a person can be a Konjir admin/);
  expect(await rejection(kolab.db.query(`insert into konjir_admin(actor_id, granted_by) values ('bob', 'admin')`))).toMatch(/must be recorded in the audit log/);
  expect(await rejection(kolab.db.query(`delete from konjir_admin where actor_id = 'ann'`))).toMatch(/must be recorded in the audit log/);
  expect(await kolab.isAdmin('ann')).toBe(true);
});

test('the last live admin is never removed or archived while the break-glass token is disabled; with it enabled, they may be', async () => {
  const kolab = await admins();
  await kolab.makeAdmin('lee');
  await kolab.makeAdmin('ann');
  expect(await kolab.removeAdmin('ann', { by: 'lee', breakGlass: false })).toBe(true);
  expect(await auditOf(kolab, 'ann')).toStrictEqual([['admin.revoked', 'ann', 'lee'], ['admin.granted', 'ann', ADMIN_DOER]]);
  expect(await rejection(kolab.removeAdmin('lee', { by: 'lee', breakGlass: false })))
    .toMatch(/TenancyError: lee is the last Konjir admin, and the break-glass admin token is disabled here/);
  expect(await rejection(kolab.archive({ actor: 'lee' }, { breakGlass: false }))).toMatch(/lee is the last live Konjir admin/);
  expect(await kolab.isAdmin('lee')).toBe(true);
  expect(await auditOf(kolab, 'lee')).toStrictEqual([['admin.granted', 'lee', ADMIN_DOER]]);   // the refused removal left no record
  expect((await kolab.listActors()).map((a) => a.id)).toContain('lee');

  // An archived admin isn't one left: with ann archived, lee is still the last.
  await kolab.makeAdmin('ann');
  await kolab.archive({ actor: 'ann' });
  expect(await rejection(kolab.removeAdmin('lee', { breakGlass: false }))).toMatch(/lee is the last Konjir admin/);
  expect(await kolab.removeAdmin('ann', { breakGlass: false })).toBe(true);
  // Nor is an admin who can't sign in (L1): Bob has no linked identity, so he could never open a session that runs the admin verbs.
  await kolab.makeAdmin('bob');
  expect((await kolab.admins()).map((a) => [a.actor, a.signs_in])).toStrictEqual([['bob', false], ['lee', true]]);
  expect(await rejection(kolab.removeAdmin('lee', { breakGlass: false }))).toMatch(/lee is the last Konjir admin, .* one who signs in with the identity provider/);
  expect(await rejection(kolab.archive({ actor: 'lee' }, { breakGlass: false }))).toMatch(/lee is the last live Konjir admin/);
  expect(await kolab.removeAdmin('bob', { breakGlass: false })).toBe(true);

  // With the break-glass enabled, the last admin may go: the token still administers.
  expect(await kolab.removeAdmin('lee', { breakGlass: true })).toBe(true);
  expect(await kolab.removeAdmin('lee', { breakGlass: true })).toBe(false);
  expect(await kolab.admins()).toStrictEqual([]);
});

test('two admins removing each other at once, with the break-glass disabled: one goes, the other stays', async () => {
  const kolab = await admins();
  await kolab.makeAdmin('lee');
  await kolab.makeAdmin('ann');
  const both = await Promise.allSettled([kolab.removeAdmin('ann', { by: 'lee', breakGlass: false }), kolab.removeAdmin('lee', { by: 'ann', breakGlass: false })]);
  expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(String((both.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/is the last Konjir admin/);
  expect(await kolab.admins()).toHaveLength(1);
});

test('an admin\'s own signed-in session runs the admin verbs from the moment they sign in, for as long as they are one, read on every request', async () => {
  const kolab = await admins();
  await kolab.makeAdmin('lee');
  const lee = await signedIn(kolab, 'lee');
  expect(await kolab.liveSession(lee)).toMatchObject({ actor: 'lee', granted: true, admin: true });

  // Removed, the same session runs them no more, at once; it stays open for the rest of its work.
  await kolab.removeAdmin('lee');
  expect(await kolab.liveSession(lee)).toMatchObject({ actor: 'lee', granted: true, admin: false });
  // Made an admin again, it does again: nothing is kept on the session.
  await kolab.makeAdmin('lee');
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: true });
  // A person made an admin while signed in runs them on their next request.
  const ann = await signedIn(kolab, 'ann');
  expect(await kolab.liveSession(ann)).toMatchObject({ admin: false });
  await kolab.makeAdmin('ann', { by: 'lee' });
  expect(await kolab.liveSession(ann)).toMatchObject({ admin: true });
  // It lasts as long as the session does.
  await kolab.endSession(lee, { signingOut: true });
  expect(await kolab.liveSession(lee)).toBeUndefined();
  // None of that is an audit row but the grants and revocations themselves.
  expect((await auditOf(kolab, 'lee')).map(([action]) => action)).toStrictEqual(['admin.granted', 'admin.revoked', 'admin.granted']);
});

test('an agent of an admin\'s, a hand-issued session of an admin\'s and a person who isn\'t an admin never run the admin verbs', async () => {
  const kolab = await admins();
  await kolab.makeAdmin('lee');
  const agent = await signedIn(kolab, 'lee', { kind: 'agent', agent: 'lee-claude' });
  expect(await kolab.liveSession(agent)).toMatchObject({ actor: 'lee-claude', granted: true, admin: false });
  const handIssued = await kolab.openSession('lee', 'product');
  expect(await kolab.liveSession(handIssued)).toMatchObject({ actor: 'lee', granted: false, admin: false });
  const ann = await signedIn(kolab, 'ann');
  expect(await kolab.liveSession(ann)).toMatchObject({ actor: 'ann', granted: true, admin: false });
  // The database refuses an agent in konjir_admin (the first test's kj_admin_is_person). Written there past that check, it still runs nothing: the person check is on every request.
  await kolab.db.exec(`alter table konjir_admin disable trigger user;
    insert into konjir_admin(actor_id, granted_by) values ('lee-claude', 'admin');
    alter table konjir_admin enable trigger user`);
  expect(await kolab.liveSession(agent)).toMatchObject({ actor: 'lee-claude', admin: false });
  expect(await kolab.liveSession('kjs_nothing')).toBeUndefined();
});

test('archiving an admin ends their session for good: its access and refresh tokens are refused, and stay refused after unarchiving; a new sign-in is an admin again', async () => {
  const kolab = await admins();
  await kolab.makeAdmin('lee');
  const old = await signIn(kolab, 'lee');
  expect(await kolab.liveSession(old.accessToken)).toMatchObject({ admin: true });

  await kolab.archive({ actor: 'lee' });
  expect(await kolab.liveSession(old.accessToken)).toBeUndefined();
  expect(await refreshRefusal(kolab, old)).toBe('invalid_grant');

  await kolab.unarchive({ actor: 'lee' });
  expect(await kolab.liveSession(old.accessToken)).toBeUndefined();
  expect(await refreshRefusal(kolab, old)).toBe('invalid_grant');

  expect(await kolab.liveSession(await signedIn(kolab, 'lee'))).toMatchObject({ actor: 'lee', admin: true });
});

test('ending an admin\'s session, by its key or by its actor, refuses its refresh token too', async () => {
  const kolab = await admins();
  await kolab.makeAdmin('lee');
  const byKey = await signIn(kolab, 'lee');
  await kolab.endSession({ key: (await kolab.liveSession(byKey.accessToken))!.id }, { by: ADMIN_DOER });
  expect(await kolab.liveSession(byKey.accessToken)).toBeUndefined();
  expect(await refreshRefusal(kolab, byKey)).toBe('invalid_grant');

  const byActor = await signIn(kolab, 'lee');
  await kolab.endSession({ actor: 'lee' }, { by: ADMIN_DOER });
  expect(await kolab.liveSession(byActor.accessToken)).toBeUndefined();
  expect(await refreshRefusal(kolab, byActor)).toBe('invalid_grant');
});

test('the audit log\'s past admin.elevated and admin.lowered rows stay valid and readable; nothing writes them now', async () => {
  const kolab = await admins();
  await kolab.db.query(`insert into audit_event(action, subject, detail, done_by) values
    ('admin.elevated', 'lee', '{"session":"s","until":"2026-10-23T00:00:00.000Z"}', 'lee'), ('admin.lowered', 'lee', '{"session":"s"}', 'lee')`);
  expect((await kolab.auditLog({ subject: 'lee' })).filter((e) => e.action === 'admin.elevated' || e.action === 'admin.lowered').map((e) => [e.action, e.by]).sort())
    .toStrictEqual([['admin.elevated', 'lee'], ['admin.lowered', 'lee']]);
  await kolab.makeAdmin('ann');
  await signedIn(kolab, 'ann');
  expect((await auditOf(kolab, 'ann')).map(([action]) => action)).toStrictEqual(['admin.granted']);
});

test('a hand-issued session expires 30 days after it opens, and is then refused like an ended one', async () => {
  const kolab = await admins();
  expect(kolab.sessions.handIssuedTtlS).toBe(30 * 86_400);
  const before = Date.now();
  const token = await kolab.openSession('ann', 'product');
  const s = (await kolab.liveSession(token))!;
  expect(s.granted).toBe(false);
  expect(s.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 86_400_000 - 5_000);
  expect(s.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000 + 5_000);
  expect(await kolab.sessionOpen(token)).toBe(true);
  expect(await kolab.liveSessions([s.id])).toStrictEqual(new Set([s.id]));

  // Expired: Kolab, its listen streams and row-level security all refuse it.
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where id = $1`, [s.id]);
  expect(await kolab.liveSession(token)).toBeUndefined();
  expect(await kolab.sessionOpen(token)).toBe(false);
  expect(await kolab.liveSessions([s.id])).toStrictEqual(new Set());
  expect(await rejection(kolab.sessionInfo(token))).toMatch(/RoleError: no open session for that token/);
  const underRls = await kolab.db.transaction(async (tx) => {
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(token)]);
    return (await tx.query<{ id: string | null }>(`select kj_session_id() as id`)).rows[0].id;
  });
  expect(underRls).toBeNull();
  // It holds no place: Ann opens another, and the expired one is ended as it does.
  const again = await kolab.openSession('ann', 'product');
  expect(await kolab.liveSession(again)).toMatchObject({ actor: 'ann' });
  expect((await kolab.db.query(`select ended_at is not null as ended, ended_by from session where id = $1`, [s.id])).rows).toStrictEqual([{ ended: true, ended_by: ADMIN_DOER }]);

  // An agent's hand-issued session in the other role keeps it from reviewing only while it lasts (CAN_REVIEW).
  const agentSession = await kolab.openSession('lee-claude', 'engineer');
  expect(await kolab.ableToReview({ layer: 'functional', kolab_id: 'test' }, ['lee-claude'])).toStrictEqual([]);
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where id = $1`, [sessionKey(agentSession)]);
  expect(await kolab.ableToReview({ layer: 'functional', kolab_id: 'test' }, ['lee-claude'])).toStrictEqual(['lee-claude']);

  // The lifetime is configurable.
  kolab.sessions.handIssuedTtlS = 3_600;
  await kolab.endSession({ actor: 'bob' }, { by: ADMIN_DOER });
  const short = (await kolab.liveSession(await kolab.openSession('bob', 'product')))!;
  expect(short.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000 + 5_000);
  expect(short.expiresAt!.getTime() - Date.now()).toBeGreaterThan(3_600_000 - 60_000);
});

test('each use of the break-glass token is recorded, by admin, naming the verb', async () => {
  const kolab = await admins();
  await kolab.recordBreakGlass('konjir_admin_make_admin');
  expect(await kolab.auditLog({ subject: 'konjir_admin_make_admin' })).toMatchObject([{ action: 'break_glass.used', by: ADMIN_DOER, kolab: null }]);
});
