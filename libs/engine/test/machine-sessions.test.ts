// Sessions per machine (W6.1; D103, ENF4, DEL7): a sign-in ends only the session it replaces, the
// same actor's from the same machine. A person holds one open session on each machine they sign in
// through (each OAuth client, each browser, each hand-issued token); an agent holds one, whatever it
// signs in through. A person lists their own sessions and ends one.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { AGENT_MACHINE, Kolab, sessionKey, TOKEN_MACHINE, webMachine } from '../src/index.js';
import { openKolab, people, rejection, TEST_KOLAB } from '../src/testing.js';
import { ADMIN_DOER } from '@konjir/types';

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const CB = 'http://127.0.0.1:9/cb';

/** A sign-in through `client` (a new one by default), as `person`, acting as `as`, straight through the engine. */
async function signIn(kolab: Kolab, person: string, o: { client?: string; agent?: string; role?: 'product' | 'engineer'; machine?: string; place?: string } = {}) {
  const client = o.client ?? (await kolab.registerClient({ name: 'Test harness', redirectUris: [CB] })).id;
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri: CB, codeChallenge: s256(verifier) });
  const { csrf } = await kolab.identifyAuthorization(binding, state, person);
  const { code } = await kolab.consent(binding, csrf, { as: o.agent ? { kind: 'agent', agent: o.agent } : { kind: 'self' }, kolab: TEST_KOLAB, role: o.role ?? 'product' });
  const t = await kolab.exchangeCode({ code, clientId: client, redirectUri: CB, codeVerifier: verifier, ...(o.machine ? { machine: o.machine } : {}), ...(o.place ? { place: o.place } : {}) });
  return { client, ...t };
}

const endedEvents = (kolab: Kolab) => {
  const ended: string[] = [];
  kolab.onEvent((e) => { if ('session' in e && e.session === 'ended') ended.push(e.id); });
  return ended;
};

const openOf = async (kolab: Kolab, actor: string) =>
  (await kolab.db.query<{ id: string; machine_key: string }>(`select id, machine_key from session where actor_id = $1 and ended_at is null order by id`, [actor])).rows;

test('a person holds a session on each machine: a sign-in ends only theirs on the same machine, and tells only its streams (D103)', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  const ended = endedEvents(kolab);
  const laptop = await signIn(kolab, 'alice');
  const desktop = await signIn(kolab, 'alice');
  const browser = randomBytes(32).toString('base64url');
  const web = await signIn(kolab, 'alice', { machine: webMachine(browser), place: 'Firefox on\nmacOS\u0000' });
  const token = await kolab.openSession('alice', 'product');
  // An admin opens a person one session at a time, as ever: their tokens are one machine.
  expect(await rejection(kolab.openSession('alice', 'engineer'))).toMatch(/ActorError: alice already has an open session; end it before opening another/);
  for (const t of [laptop.accessToken, desktop.accessToken, web.accessToken, token]) expect(await kolab.sessionOpen(t)).toBe(true);
  expect(ended).toStrictEqual([]);
  // What she is shown of where: printable, on one line.
  expect((await kolab.db.query(`select place from session where id = $1`, [web.session])).rows).toStrictEqual([{ place: 'Firefox on macOS' }]);
  expect((await openOf(kolab, 'alice')).map((s) => s.machine_key).sort()).toStrictEqual([
    `client:${desktop.client}`, `client:${laptop.client}`, webMachine(browser), TOKEN_MACHINE,
  ].sort());

  // Again on the laptop, through the client it keeps: only the laptop's old session ends.
  const again = await signIn(kolab, 'alice', { client: laptop.client });
  expect(ended).toStrictEqual([laptop.session]);
  expect(await kolab.sessionOpen(laptop.accessToken)).toBe(false);
  for (const t of [again.accessToken, desktop.accessToken, web.accessToken, token]) expect(await kolab.sessionOpen(t)).toBe(true);
  expect(await kolab.refreshGrant({ refreshToken: laptop.refreshToken, clientId: laptop.client }).catch((e: { code: string }) => e.code)).toBe('invalid_grant');
  // Again in the same browser, through any client: only the browser's.
  const web2 = await signIn(kolab, 'alice', { machine: webMachine(browser) });
  expect(ended).toStrictEqual([laptop.session, web.session]);
  expect(await kolab.sessionOpen(desktop.accessToken)).toBe(true);
  // Who ended each is recorded: the person signing in (W2.20).
  expect((await kolab.db.query(`select ended_by from session where id = any($1) order by id`, [[laptop.session, web.session]])).rows).toStrictEqual([{ ended_by: 'alice' }, { ended_by: 'alice' }]);
  // A machine is named only as webMachine names one.
  expect(await rejection(signIn(kolab, 'alice', { machine: 'client:kjcl_someone-elses' }))).toMatch(/names its machine only as webMachine gives it/);

  // Switching kolab or role stays on the machine: a sign-in there again still replaces it.
  await kolab.grant(TEST_KOLAB, 'alice', 'write');
  const switched = await kolab.switchSession(desktop.accessToken, { kolab: TEST_KOLAB, role: 'engineer' });
  const switchedId = (await kolab.liveSession(switched))!.id;
  expect((await kolab.db.query(`select machine_key from session where id = $1`, [switchedId])).rows).toStrictEqual([{ machine_key: `client:${desktop.client}` }]);
  await signIn(kolab, 'alice', { client: desktop.client });
  expect(await kolab.sessionOpen(switched)).toBe(false);
  expect(await kolab.sessionOpen(again.accessToken)).toBe(true);
  void web2;
});

test('an agent holds one session, whatever it signs in through: its newest sign-in wins, and an admin opens it no second (ENF4)', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await kolab.addActor('alice-pm', { owner: 'alice' });
  await kolab.grant(TEST_KOLAB, 'alice-pm', 'write', { layers: ['functional'] });
  const ended = endedEvents(kolab);
  const first = await signIn(kolab, 'alice', { agent: 'alice-pm' });
  const second = await signIn(kolab, 'alice', { agent: 'alice-pm' });   // another client: another harness entry
  expect(first.client).not.toBe(second.client);
  expect(ended).toStrictEqual([first.session]);
  expect(await kolab.sessionOpen(first.accessToken)).toBe(false);
  expect(await kolab.sessionOpen(second.accessToken)).toBe(true);
  expect((await openOf(kolab, 'alice-pm')).map((s) => s.machine_key)).toStrictEqual([AGENT_MACHINE]);
  expect(await rejection(kolab.openSession('alice-pm', 'product'))).toMatch(/alice-pm already has an open session; end it before opening another/);
  // Its owner signing in as herself ends nothing of its.
  await signIn(kolab, 'alice');
  expect(await kolab.sessionOpen(second.accessToken)).toBe(true);

  // The database holds it too: an agent's session is on `agent`, a person's never, and one open session per actor and machine.
  const insert = (actor: string, machine: string) => kolab.db.query(
    `insert into session(id, actor_id, active_role, kolab_id, expires_at, opened_by, machine_key) values ($1, $2, 'product', $3, now() + interval '1 hour', 'kolab', $4)`,
    [randomBytes(32).toString('base64url'), actor, TEST_KOLAB, machine]);
  await kolab.endSession({ actor: 'alice-pm' });
  expect(await rejection(insert('alice-pm', 'client:kjcl_aaaaaaaaaaaaaaaaaaaaaaaaaa'))).toMatch(/an agent holds one session/);
  expect(await rejection(insert('alice', AGENT_MACHINE))).toMatch(/never agent/);
  await insert('alice', 'token:one');
  expect(await rejection(insert('alice', 'token:one'))).toMatch(/one_open_session_per_machine/);
  expect(await rejection(kolab.db.query(`insert into session(id, actor_id, active_role, kolab_id, expires_at, opened_by) values ($1, 'alice', 'product', $2, now() + interval '1 hour', 'kolab')`,
    [randomBytes(32).toString('base64url'), TEST_KOLAB]))).toMatch(/session_machine_open/);
});

test('a person lists their own sessions and ends one; an agent does neither, and an admin ends every one of a person\'s by actor (D103)', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const ended = endedEvents(kolab);
  const cli = await signIn(kolab, 'alice');
  await kolab.db.query(`update oauth_client set name = 'konjir CLI' where id = $1`, [cli.client]);
  const web = await signIn(kolab, 'alice', { machine: webMachine(randomBytes(32).toString('base64url')), place: 'Firefox on macOS' });
  // Kolab's own web client is the browser's: its sessions say so.
  await kolab.db.query(`update oauth_grant set client_id = 'konjir-web' where id = (select grant_id from session where id = $1)`, [web.session]);
  const token = await kolab.openSession('alice', 'product');
  const bobs = await signIn(kolab, 'bob', { role: 'engineer' });

  // Most recently used first: a refresh is a use.
  await kolab.db.query(`update session set started_at = now() - interval '2 hours' where actor_id = 'alice'`);
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where id = $1`, [cli.session]);
  const renewed = await kolab.refreshGrant({ refreshToken: cli.refreshToken, clientId: cli.client });
  const list = (await kolab.listOwnSessions(web.accessToken)).sessions;
  expect(list[0].session).toBe(cli.session);
  expect(list.map((s) => s.session).sort()).toStrictEqual([cli.session, web.session, sessionKey(token)].sort());
  expect(list[0]).toMatchObject({ current: false, via: 'app', where: 'konjir CLI', kolab: TEST_KOLAB, role: 'product', expires_at: null });
  expect(Date.parse(list[0].last_used)).toBeGreaterThan(Date.parse(list[0].started_at));
  expect(list.find((s) => s.session === web.session)).toMatchObject({ current: true, via: 'web', where: 'Kolab\'s web page, Firefox on macOS', expires_at: null });
  expect(list.find((s) => s.session === sessionKey(token))).toMatchObject({ current: false, via: 'token', where: 'a token an admin opened', expires_at: expect.any(String) });
  expect(list.every((s) => s.last_used >= s.started_at)).toBe(true);
  expect(list.map((s) => s.session)).not.toContain(bobs.session);   // only her own

  // She ends the CLI's by a prefix of its id: its grant is revoked as hers, and its streams are told.
  expect(await kolab.endOwnSession(web.accessToken, { session: cli.session.slice(0, 8) })).toStrictEqual({ ended: cli.session, current: false });
  expect(ended).toStrictEqual([cli.session]);
  expect(await kolab.sessionOpen(renewed.accessToken)).toBe(false);
  expect((await kolab.db.query(`select g.revoked_by, s.ended_by from session s join oauth_grant g on g.id = s.grant_id where s.id = $1`, [cli.session])).rows)
    .toStrictEqual([{ revoked_by: 'alice', ended_by: 'alice' }]);
  expect(await kolab.refreshGrant({ refreshToken: renewed.refreshToken, clientId: cli.client }).catch((e: { code: string }) => e.code)).toBe('invalid_grant');
  // A hand-issued one ends by her too; the others go on.
  expect(await kolab.endOwnSession(web.accessToken, { session: sessionKey(token) })).toStrictEqual({ ended: sessionKey(token), current: false });
  expect((await kolab.db.query(`select ended_by from session where id = $1`, [sessionKey(token)])).rows).toStrictEqual([{ ended_by: 'alice' }]);
  expect(await kolab.sessionOpen(web.accessToken)).toBe(true);
  expect(await kolab.sessionOpen(bobs.accessToken)).toBe(true);
  // Anything but an open session of hers is refused alike: an ended one, bob's, nonsense.
  for (const s of [cli.session, bobs.session, bobs.session.slice(0, 9)]) {
    expect(await rejection(kolab.endOwnSession(web.accessToken, { session: s }))).toBe(`Error: you have no open session ${s}`);
  }
  for (const s of ['short', 'not/an id', 42, undefined]) {
    expect(await rejection(kolab.endOwnSession(web.accessToken, { session: s }))).toMatch(/ActorError: name the session to end by its id, or at least its first 8 characters/);
  }
  // Her own: it signs her out.
  expect(await kolab.endOwnSession(web.accessToken, { session: web.session })).toStrictEqual({ ended: web.session, current: true });
  expect(await kolab.sessionOpen(web.accessToken)).toBe(false);

  // An agent lists and ends no sessions, its own or its owner's.
  await kolab.addActor('alice-pm', { owner: 'alice' });
  await kolab.grant(TEST_KOLAB, 'alice-pm', 'write', { layers: ['functional'] });
  const agent = await kolab.openSession('alice-pm', 'product');
  expect(await rejection(kolab.listOwnSessions(agent))).toMatch(/AccessError: alice-pm is an agent: only a person lists their sessions/);
  expect(await rejection(kolab.endOwnSession(agent, { session: sessionKey(agent) }))).toMatch(/AccessError: alice-pm is an agent: only a person ends their sessions/);

  // An admin ending a person by actor ends every session of theirs, and tells each.
  const one = await signIn(kolab, 'alice');
  const two = await signIn(kolab, 'alice');
  const all = await kolab.endSessions({ actor: 'alice' }, { by: ADMIN_DOER });
  expect(all).toStrictEqual([one.session, two.session].sort());
  expect(ended.slice(-2).sort()).toStrictEqual(all);
  expect(await kolab.endSession({ actor: 'alice' })).toBe(null);
});
