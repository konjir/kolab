// Admins are people, not a token (W2.22, D69): who is a Konjir admin, who made them one, the
// last-admin rule while the break-glass token is disabled, an admin's own signed-in session asking
// to be raised and the raise completed only by its person's browser step (Lee's ruling of
// 2026-10-23), each step recorded in the audit log, and hand-issued sessions expiring. Never an
// agent (D30, D56).
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { ADMIN_DOER, ADMIN_ELEVATION_S } from '@konjir/types';
import { Kolab, sessionKey } from '../src/index.js';
import { openKolab, people, rejection, type TestKolab } from '../src/testing.js';

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

/**
 * The browser step of a raise, as /oauth/raise and the raise page drive it: a sign-in of Kolab's
 * own carrying the request, the identity provider saying `person` signed in, and the page's form.
 */
async function browserStep(kolab: Kolab, request: string, person: string) {
  const { binding, state } = await kolab.beginAuthorization({
    provider: 'github', clientId: 'konjir-raise', redirectUri: 'http://127.0.0.1:9/oauth/raise', codeChallenge: s256(randomBytes(32).toString('base64url')), raise: request,
  });
  const { csrf } = await kolab.identifyAuthorization(binding, state, person);
  return { binding, csrf, complete: () => kolab.completeRaise(binding, csrf) };
}

/** Asks for a raise of the session `token` reaches, and completes it in the browser as `person`. */
async function raise(kolab: Kolab, token: string, person: string) {
  const { request } = await kolab.requestRaise(token);
  return (await browserStep(kolab, request, person)).complete();
}

/** `person` signs in with the identity provider, as `as` (themselves by default), and gets an access token. */
async function signedIn(kolab: Kolab, person: string, as: Parameters<Kolab['consent']>[2]['as'] = { kind: 'self' }): Promise<string> {
  const client = (await kolab.registerClient({ name: 'Test client', redirectUris: ['http://127.0.0.1:9/cb'] })).id;
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256(verifier) });
  const { csrf } = await kolab.identifyAuthorization(binding, state, person);
  const { code, redirectUri } = await kolab.consent(binding, csrf, { as, kolab: 'test', role: 'product' });
  return (await kolab.exchangeCode({ code, clientId: client, redirectUri, codeVerifier: verifier })).accessToken;
}

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
  // Nor is an admin who can't sign in (L1): Bob has no linked identity, so he could never raise a session.
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

test('asking for a raise raises nothing: only the browser step, as the session\'s own person, raises it for 15 minutes, recorded as them', async () => {
  const kolab = await admins();
  await kolab.makeAdmin('lee');
  const lee = await signedIn(kolab, 'lee');
  const key = (await kolab.liveSession(lee))!.id;
  expect(await kolab.liveSession(lee)).toMatchObject({ actor: 'lee', granted: true, admin: 'eligible' });

  // Asked for, over MCP or the CLI: a link's secret, and the session stays as it was.
  const asked = await kolab.requestRaise(lee);
  expect(asked).toMatchObject({ request: expect.stringMatching(/^kje_[A-Za-z0-9_-]{43}$/), actor: 'lee', session: key });
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: 'eligible' });
  expect(await kolab.pendingRaise(asked.request)).toMatchObject({ actor: 'lee', session: key, sessionStarted: expect.any(String),
    client: { id: expect.stringMatching(/^kjcl_/), firstParty: false, name: 'Test client', redirectOrigins: ['http://127.0.0.1:9'] } });
  expect(await auditOf(kolab, 'lee')).toStrictEqual([['admin.granted', 'lee', ADMIN_DOER]]);
  // Kolab keeps only its hash.
  expect((await kolab.db.query(`select id from admin_raise`)).rows).toStrictEqual([{ id: sessionKey(asked.request) }]);

  // Another person's browser never completes it: not Ann, an admin herself, signing in with her own GitHub.
  await kolab.makeAdmin('ann');
  const ann = await browserStep(kolab, asked.request, 'ann');
  expect(await rejection(ann.complete())).toMatch(/AccessError: this raise is for lee's session, and only lee can complete it: you signed in as ann/);
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: 'eligible' });
  // Nor does a raise's sign-in pass as a consent to anything.
  expect(await rejection(kolab.consent(ann.binding, ann.csrf, { as: { kind: 'self' }, kolab: 'test', role: 'product' }))).toMatch(/OAuthGrantError: this sign-in expired or was already used/);

  // Lee's own browser step does, once.
  const before = Date.now();
  const mine = await browserStep(kolab, asked.request, 'lee');
  const raised = await mine.complete();
  expect(raised).toMatchObject({ actor: 'lee', session: key });
  const until = Date.parse(raised.until);
  expect(until).toBeGreaterThanOrEqual(before + ADMIN_ELEVATION_S * 1000 - 5_000);
  expect(until).toBeLessThanOrEqual(Date.now() + ADMIN_ELEVATION_S * 1000 + 5_000);
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: 'raised' });
  expect((await kolab.auditLog({ subject: 'lee' }))[0]).toMatchObject({ action: 'admin.elevated', by: 'lee', detail: { session: key, until: raised.until } });
  expect(await rejection(mine.complete())).toMatch(/OAuthGrantError: this raise expired or was already used/);
  expect(await kolab.pendingRaise(asked.request)).toBeUndefined();
  // A link already used starts no other browser step that completes.
  expect(await rejection((await browserStep(kolab, asked.request, 'lee')).complete())).toMatch(/this raise expired or was already used/);

  // It lapses on its own; asked for and confirmed again, it renews; lowered, it ends now.
  await kolab.db.query(`update session set admin_until = now() - interval '1 second' where actor_id = 'lee'`);
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: 'eligible' });
  await raise(kolab, lee, 'lee');
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: 'raised' });
  expect(await kolab.lowerRaise(lee)).toMatchObject({ actor: 'lee', lowered: true });
  expect(await kolab.lowerRaise(lee)).toMatchObject({ lowered: false });
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: 'eligible' });
  expect((await auditOf(kolab, 'lee')).map(([action, , by]) => [action, by])).toStrictEqual([
    ['admin.lowered', 'lee'], ['admin.elevated', 'lee'], ['admin.elevated', 'lee'], ['admin.granted', ADMIN_DOER],
  ]);

  // Declined on its page, the request is used up: a later browser step with the same link never raises (L1).
  const declined = await kolab.requestRaise(lee);
  const no = await browserStep(kolab, declined.request, 'lee');
  expect(await kolab.declineAuthorization(no.binding, no.csrf)).toBeDefined();
  expect(await kolab.pendingRaise(declined.request)).toBeUndefined();
  expect(await rejection((await browserStep(kolab, declined.request, 'lee')).complete())).toMatch(/this raise expired or was already used/);
  // Cancelled at the identity provider (before anyone is identified), likewise.
  const cancelled = await kolab.requestRaise(lee);
  const { binding: cb, state: cs } = await kolab.beginAuthorization({
    provider: 'github', clientId: 'konjir-raise', redirectUri: 'http://127.0.0.1:9/oauth/raise', codeChallenge: s256('c'.repeat(43)), raise: cancelled.request,
  });
  expect(await kolab.abandonAuthorization(cb, cs)).toBeDefined();
  expect(await kolab.pendingRaise(cancelled.request)).toBeUndefined();
  expect(await rejection((await browserStep(kolab, cancelled.request, 'lee')).complete())).toMatch(/this raise expired or was already used/);
  // Another sign-in of the same link, still at the provider when the first is declined, is dead too.
  const twice = await kolab.requestRaise(lee);
  const waiting = await kolab.beginAuthorization({
    provider: 'github', clientId: 'konjir-raise', redirectUri: 'http://127.0.0.1:9/oauth/raise', codeChallenge: s256('d'.repeat(43)), raise: twice.request,
  });
  const firstTry = await browserStep(kolab, twice.request, 'lee');
  await kolab.declineAuthorization(firstTry.binding, firstTry.csrf);
  const { csrf: lateCsrf } = await kolab.identifyAuthorization(waiting.binding, waiting.state, 'lee');
  expect(await rejection(kolab.completeRaise(waiting.binding, lateCsrf))).toMatch(/this raise expired or was already used/);
  expect((await kolab.db.query(`select count(*)::int as n from admin_raise where cancelled_at is not null`)).rows).toStrictEqual([{ n: 3 }]);
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: 'eligible' });

  // A request lapses with its sign-in's 20 minutes.
  const old = await kolab.requestRaise(lee);
  const late = await browserStep(kolab, old.request, 'lee');
  await kolab.db.query(`update admin_raise set expires_at = now() - interval '1 second' where id = $1`, [sessionKey(old.request)]);
  expect(await kolab.pendingRaise(old.request)).toBeUndefined();
  expect(await rejection(late.complete())).toMatch(/this raise expired or was already used/);
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: 'eligible' });
});

test('a raise completes only while its session is open and its person still an admin; never for an agent, a hand-issued session or a non-admin', async () => {
  const kolab = await admins();
  await kolab.makeAdmin('lee');
  const lee = await signedIn(kolab, 'lee');

  // Removed as an admin between asking and the browser step: refused, and removing lowers what was raised.
  const asked = await kolab.requestRaise(lee);
  const step = await browserStep(kolab, asked.request, 'lee');
  await kolab.removeAdmin('lee');
  expect(await rejection(step.complete())).toMatch(/AccessError: lee is not a Konjir admin/);
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: 'none' });
  expect(await rejection(kolab.requestRaise(lee))).toMatch(/AccessError: lee is not a Konjir admin/);
  await kolab.makeAdmin('lee');
  await raise(kolab, lee, 'lee');
  await kolab.removeAdmin('lee');
  expect((await kolab.db.query(`select admin_until from session where actor_id = 'lee' and ended_at is null`)).rows).toStrictEqual([{ admin_until: null }]);
  // Made an admin again, no session of theirs starts out raised (N1).
  await kolab.db.query(`update session set admin_until = now() + interval '10 minutes' where actor_id = 'lee'`);
  await kolab.makeAdmin('lee');
  expect(await kolab.liveSession(lee)).toMatchObject({ admin: 'eligible' });

  // The session ended between asking and the browser step: refused.
  const gone = await kolab.requestRaise(lee);
  const goneStep = await browserStep(kolab, gone.request, 'lee');
  await kolab.endSession(lee, { signingOut: true });
  expect(await kolab.pendingRaise(gone.request)).toBeUndefined();
  expect(await rejection(goneStep.complete())).toMatch(/RoleError: the session this raise was asked for has ended/);

  // An agent of an admin's, signed in through the same provider, never asks: nor a hand-issued session, nor a person who isn't an admin.
  const agent = await signedIn(kolab, 'lee', { kind: 'agent', agent: 'lee-claude' });
  expect(await kolab.liveSession(agent)).toMatchObject({ actor: 'lee-claude', admin: 'none' });
  expect(await rejection(kolab.requestRaise(agent))).toMatch(/RoleError: lee-claude is an agent, and an agent never runs admin verbs/);
  expect(await rejection(kolab.lowerRaise(agent))).toMatch(/RoleError: lee-claude is an agent/);
  const handIssued = await kolab.openSession('lee', 'product');
  expect(await kolab.liveSession(handIssued)).toMatchObject({ actor: 'lee', granted: false, admin: 'none' });
  expect(await rejection(kolab.requestRaise(handIssued))).toMatch(/RoleError: admin verbs run only from a session you signed in to yourself/);
  const ann = await signedIn(kolab, 'ann');
  expect(await kolab.liveSession(ann)).toMatchObject({ admin: 'none' });
  expect(await rejection(kolab.requestRaise(ann))).toMatch(/AccessError: ann is not a Konjir admin/);
  expect(await rejection(kolab.requestRaise('kjs_nothing'))).toMatch(/RoleError: no open session/);
  expect(await kolab.pendingRaise('kje_nothing')).toBeUndefined();
  expect(await rejection(kolab.beginAuthorization({ provider: 'github', clientId: 'konjir-raise', redirectUri: 'http://127.0.0.1:9/oauth/raise', codeChallenge: s256('x'), raise: 'nothing' })))
    .toMatch(/OAuthGrantError: that is not a raise link/);
  // An agent's session raised by hand in the database still runs nothing: the person check is on every request.
  await kolab.db.query(`update session set admin_until = now() + interval '1 hour' where actor_id = 'lee-claude'`);
  expect(await kolab.liveSession(agent)).toMatchObject({ admin: 'none' });
});

test('a raise and a removal at once: the person is never left an admin\'s raised session without being one (N1)', async () => {
  const kolab = await admins();
  await kolab.makeAdmin('lee');
  await kolab.makeAdmin('ann');
  const lee = await signedIn(kolab, 'lee');
  const step = await browserStep(kolab, (await kolab.requestRaise(lee)).request, 'lee');
  const [raised, removed] = await Promise.allSettled([step.complete(), kolab.removeAdmin('lee', { by: 'ann', breakGlass: false })]);
  expect(removed.status).toBe('fulfilled');
  expect(await kolab.isAdmin('lee')).toBe(false);
  // Whichever went first, nothing is left raised: a raise after the removal is refused, and one before it is lowered by it.
  if (raised.status === 'rejected') expect(String(raised.reason)).toMatch(/AccessError: lee is not a Konjir admin/);
  expect((await kolab.db.query(`select admin_until from session where actor_id = 'lee' and ended_at is null`)).rows).toStrictEqual([{ admin_until: null }]);
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
