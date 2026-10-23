// Invites (W3.4; P15, D55): a kolab's admins bring a teammate in with a link, with no admin of
// Konjir's. Who may make one, what it grants and to whom, once; what kills it (expiry, revocation,
// its maker losing Admin, an archived kolab); that accepting never lowers anyone's access; the
// limits; the invite riding a web sign-in to the consent page; and that no agent reads an invite.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { INVITE_TOKEN, Kolab, maskTokens, sessionKey } from '../src/index.js';
import { openKolab, persistentStore, rejection, TestKolab } from '../src/testing.js';

const onPostgres = !!process.env.KONJIR_TEST_DATABASE_URL;
const github = (subject: string, login: string) => ({ provider: 'github', subject, login });
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

/** Ann, signed up, owns `anns`, and works there as product. */
async function anns(kolab?: TestKolab) {
  const k = kolab ?? await openKolab();
  const { actor: ann } = await k.signInWith(github('11', 'ann'));
  await k.makeOwnKolab(ann, 'anns', 'Ann\'s');
  const session = await k.openSession(ann, 'product', { kolab: 'anns' });
  return { kolab: k, ann, session };
}

test('an admin invites a teammate with a link; the person who signs in with it is granted its access, once, and works there', async () => {
  const { kolab, session } = await anns();
  const { token, invite } = await kolab.createInvite(session, { level: 'write', layers: ['technical'] });
  expect(token).toMatch(INVITE_TOKEN);
  expect(invite).toMatchObject({ kolab: 'anns', level: 'write', layers: ['technical'], invited_by: 'ann', state: 'open', accepted_by: null });
  // Kolab keeps only its key (P1): the secret is nowhere in the database.
  const rows = (await kolab.db.query<{ key: string }>(`select * from kolab_invite`)).rows;
  expect(rows.map((r) => r.key)).toStrictEqual([sessionKey(token)]);
  expect(JSON.stringify(rows)).not.toContain(token);
  expect(maskTokens(new Error(`bad ${token}`))).toBe('bad kji_***');

  // Whoever holds it sees what it offers…
  expect(await kolab.previewInvite(token)).toStrictEqual({
    kolab: 'anns', title: 'Ann\'s', owner: 'ann', level: 'write', layers: ['technical'], invited_by: 'ann', expires_at: invite.expires_at,
  });
  // …and a new person, signed up a moment ago with nothing, joins with it.
  const { actor: eli } = await kolab.signInWith(github('12', 'eli'));
  expect(await kolab.reachable(eli)).toStrictEqual([]);
  expect(await kolab.acceptInvite(token, eli)).toStrictEqual({ kolab: 'anns', access: { level: 'write', layers: ['technical'] } });
  const eng = await kolab.openSession(eli, 'engineer', { kolab: 'anns' });
  expect((await kolab.sessionInfo(eng)).access).toStrictEqual({ level: 'write', layers: ['technical'] });

  // Once: a second use, by anyone, is refused, and the link offers nothing now.
  const { actor: zed } = await kolab.signInWith(github('13', 'zed'));
  expect(await rejection(kolab.acceptInvite(token, zed))).toMatch(/this invite is unknown, already used, revoked or expired/);
  expect(await kolab.previewInvite(token)).toBeUndefined();
  expect(await kolab.reachable(zed)).toStrictEqual([]);
  expect(await kolab.listInvites(session)).toMatchObject([{ id: invite.id, state: 'accepted', accepted_by: 'eli' }]);
  // Nonsense, or a token of another kind, is refused the same way.
  expect(await kolab.previewInvite('kji_nope')).toBeUndefined();
  expect(await rejection(kolab.acceptInvite(`kji_${randomBytes(32).toString('base64url')}`, zed))).toMatch(/unknown, already used/);
});

test('only a person with Admin invites, never with Admin, and a Write invite names its layers as a grant does', async () => {
  const { kolab, ann, session } = await anns();
  const { actor: eli } = await kolab.signInWith(github('12', 'eli'));
  await kolab.grant('anns', eli, 'maintain');
  const maintainer = await kolab.openSession(eli, 'product', { kolab: 'anns' });
  expect(await rejection(kolab.createInvite(maintainer, { level: 'read' }))).toMatch(/needs Admin there; you hold Maintain/);
  expect(await rejection(kolab.listInvites(maintainer))).toMatch(/for those with Admin there/);
  // An agent of the owner's, whatever its grant, invites nobody.
  const agent = await kolab.addOwnAgent(ann, 'claude');
  await kolab.grant('anns', agent, 'write');
  const agentSession = await kolab.openSession(agent, 'product', { kolab: 'anns' });
  expect(await rejection(kolab.createInvite(agentSession, { level: 'read' }))).toMatch(/is an agent: only a person invites people/);
  // Admin is the owners' to give.
  expect(await rejection(kolab.createInvite(session, { level: 'admin' as never }))).toMatch(/Admin is given by the kolab's owners/);
  expect(await rejection(kolab.createInvite(session, { level: 'read', layers: ['functional'] }))).toMatch(/only a Write grant names its layers/);
  expect(await rejection(kolab.createInvite(session, { level: 'write', layers: [] }))).toMatch(/names the layers it covers/);
  expect((await kolab.createInvite(session, { level: 'write' })).invite.layers).toStrictEqual(['functional', 'technical']);
  expect((await kolab.createInvite(session, { level: 'maintain' })).invite.layers).toStrictEqual(['functional', 'technical']);
  // An agent never accepts one: it gets its access from its owner (D30, D56).
  const { token } = await kolab.createInvite(session, { level: 'read' });
  expect(await rejection(kolab.acceptInvite(token, agent))).toMatch(/only a person accepts an invite/);
  expect(await kolab.previewInvite(token)).toBeDefined();
});

test('an invite dies when it expires, when an admin revokes it, when its maker loses Admin, and with an archived kolab', async () => {
  const { kolab, ann, session } = await anns();
  const { actor: eli } = await kolab.signInWith(github('12', 'eli'));
  const gone = /unknown, already used, revoked or expired/;

  const expired = await kolab.createInvite(session, { level: 'read' });
  await kolab.db.query(`update kolab_invite set expires_at = now() - interval '1 second' where id = $1`, [expired.invite.id]);
  expect(await kolab.previewInvite(expired.token)).toBeUndefined();
  expect(await rejection(kolab.acceptInvite(expired.token, eli))).toMatch(gone);

  const revoked = await kolab.createInvite(session, { level: 'read' });
  await kolab.revokeInvite(session, revoked.invite.id);
  expect(await rejection(kolab.revokeInvite(session, revoked.invite.id))).toMatch(/no open invite/);
  expect(await rejection(kolab.acceptInvite(revoked.token, eli))).toMatch(gone);
  expect((await kolab.listInvites(session)).map((i) => [i.id, i.state])).toEqual(expect.arrayContaining([[expired.invite.id, 'expired'], [revoked.invite.id, 'revoked']]));

  // Bea, an admin by grant, invites; once she loses Admin, her invite is no good.
  const { actor: bea } = await kolab.signInWith(github('14', 'bea'));
  await kolab.grant('anns', bea, 'admin');
  const beas = await kolab.openSession(bea, 'product', { kolab: 'anns' });
  const hers = await kolab.createInvite(beas, { level: 'write', layers: ['functional'] });
  await kolab.grant('anns', bea, 'write');
  expect(await kolab.previewInvite(hers.token)).toBeUndefined();
  expect(await rejection(kolab.acceptInvite(hers.token, eli))).toMatch(gone);
  await kolab.grant('anns', bea, 'admin');   // given back: it is good again, until it expires
  expect(await kolab.previewInvite(hers.token)).toBeDefined();

  // An archived kolab takes no invites, and its open ones are no good (D52).
  const open = await kolab.createInvite(session, { level: 'read' });
  await kolab.archive({ kolab: 'anns' });
  expect(await kolab.previewInvite(open.token)).toBeUndefined();
  expect(await rejection(kolab.acceptInvite(open.token, eli))).toMatch(gone);
  expect(await rejection(kolab.db.query(`update kolab_invite set revoked_at = now() where id = $1`, [open.invite.id]))).toMatch(/kolab anns is archived/);
  expect(await kolab.reachable(eli)).toStrictEqual([]);
  expect(ann).toBe('ann');
});

test('accepting never lowers anyone\'s access: as much already stands, and a grant is raised to cover both', async () => {
  const { kolab, session } = await anns();
  const { actor: eli } = await kolab.signInWith(github('12', 'eli'));
  await kolab.grant('anns', eli, 'maintain');
  await kolab.acceptInvite((await kolab.createInvite(session, { level: 'read' })).token, eli);
  expect(await kolab.access(eli, 'anns')).toStrictEqual({ level: 'maintain', layers: ['functional', 'technical'] });

  const { actor: fay } = await kolab.signInWith(github('15', 'fay'));
  await kolab.grant('anns', fay, 'write', { layers: ['functional'] });
  await kolab.acceptInvite((await kolab.createInvite(session, { level: 'write', layers: ['technical'] })).token, fay);
  expect(await kolab.access(fay, 'anns')).toStrictEqual({ level: 'write', layers: ['functional', 'technical'] });

  const { actor: gus } = await kolab.signInWith(github('16', 'gus'));
  await kolab.grant('anns', gus, 'read');
  await kolab.acceptInvite((await kolab.createInvite(session, { level: 'write', layers: ['functional'] })).token, gus);
  expect(await kolab.access(gus, 'anns')).toStrictEqual({ level: 'write', layers: ['functional'] });
  expect((await kolab.db.query(`select count(*)::int as n from kolab_grant where kolab_id = 'anns' and user_id = 'gus'`)).rows).toStrictEqual([{ n: 1 }]);
});

test('accepting always writes the person\'s own grant, even where a public kolab, a team or a base permission already reaches them, so their agents may borrow it (D56)', async () => {
  const { kolab, ann, session } = await anns();
  await kolab.db.query(`update kolab set visibility = 'public' where id = 'anns'`);
  const { actor: eli } = await kolab.signInWith(github('12', 'eli'));
  expect(await kolab.access(eli, 'anns')).toStrictEqual({ level: 'read', layers: [] });   // only because it is public
  await kolab.acceptInvite((await kolab.createInvite(session, { level: 'read' })).token, eli);
  expect((await kolab.db.query(`select level from kolab_grant where kolab_id = 'anns' and user_id = 'eli'`)).rows).toStrictEqual([{ level: 'read' }]);
  // The grant is Eli's own, so an agent of his may read there; and it stands if the kolab goes private.
  const agent = await kolab.addOwnAgent(eli, 'claude');
  await kolab.grant('anns', agent, 'read');
  expect((await kolab.sessionInfo(await kolab.openSession(agent, 'product', { kolab: 'anns' }))).access).toStrictEqual({ level: 'read', layers: [] });
  await kolab.db.query(`update kolab set visibility = 'private' where id = 'anns'`);
  expect(await kolab.access(eli, 'anns')).toStrictEqual({ level: 'read', layers: [] });
  expect(ann).toBe('ann');
});

test('accepting at consent and issuing the code are one transaction: if issuing fails, the invite is unused and nothing is granted', async () => {
  const { kolab, session } = await anns();
  const { token } = await kolab.createInvite(session, { level: 'write', layers: ['technical'] });
  const { actor: eli } = await kolab.signInWith(github('12', 'eli'));
  const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: 'konjir-web', redirectUri: 'http://127.0.0.1:9/api/session/oauth/callback', codeChallenge: s256('v'.repeat(43)), invite: token });
  const { csrf } = await kolab.identifyAuthorization(binding, state, eli);
  await kolab.db.exec(`create function fail_code() returns trigger language plpgsql as $$ begin raise exception 'no codes today'; end $$;
                       create trigger fail_code before insert on oauth_code for each row execute function fail_code();`);
  expect(await rejection(kolab.consent(binding, csrf, { as: { kind: 'self' }, kolab: { invite: true }, role: 'engineer' }, { selfOnly: true }))).toMatch(/no codes today/);
  expect(await kolab.previewInvite(token)).toBeDefined();
  expect((await kolab.db.query(`select 1 from kolab_grant where user_id = 'eli'`)).rows).toStrictEqual([]);
  // Fixed, the same sign-in goes through: the claim was released.
  await kolab.db.exec(`drop trigger fail_code on oauth_code`);
  await kolab.consent(binding, csrf, { as: { kind: 'self' }, kolab: { invite: true }, role: 'engineer' }, { selfOnly: true });
  expect(await kolab.access(eli, 'anns')).toStrictEqual({ level: 'write', layers: ['technical'] });
});

test('invite limits: so many open per kolab, so many an hour per person, counted in the database', async () => {
  const { kolab, session } = await anns();
  kolab.invites.openPerKolab = 2;
  const one = await kolab.createInvite(session, { level: 'read' });
  await kolab.createInvite(session, { level: 'read' });
  expect(await rejection(kolab.createInvite(session, { level: 'read' }))).toMatch(/has 2 open invites, the most it may hold \(2\)/);
  await kolab.revokeInvite(session, one.invite.id);
  await kolab.createInvite(session, { level: 'read' });
  kolab.invites.openPerKolab = 50;
  kolab.invites.perPersonPerHour = 3;
  expect(await rejection(kolab.createInvite(session, { level: 'read' }))).toMatch(/you made 3 invites in the last hour/);
});

test('a web sign-in carries an invite to the consent page, which offers to join; consenting accepts it, once', async () => {
  const { kolab, session } = await anns();
  const { token } = await kolab.createInvite(session, { level: 'write', layers: ['technical'] });
  const { actor: eli } = await kolab.signInWith(github('12', 'eli'));
  const begin = async (invite?: string) => {
    const verifier = randomBytes(32).toString('base64url');
    const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: 'konjir-web', redirectUri: 'http://127.0.0.1:9/api/session/oauth/callback', codeChallenge: s256(verifier), invite });
    const { csrf } = await kolab.identifyAuthorization(binding, state, eli);
    return { binding, csrf, verifier };
  };
  const a = await begin(token);
  const pending = (await kolab.pendingAuthorization(a.binding))!;
  expect(pending.inviteKey).toBe(sessionKey(token));
  expect((await kolab.consentOptions(eli, { inviteKey: pending.inviteKey })).invite).toMatchObject({ kolab: 'anns', level: 'write', layers: ['technical'], invited_by: 'ann' });
  const { code } = await kolab.consent(a.binding, a.csrf, { as: { kind: 'self' }, kolab: { invite: true }, role: 'engineer' }, { selfOnly: true });
  const t = await kolab.exchangeCode({ code, clientId: 'konjir-web', redirectUri: 'http://127.0.0.1:9/api/session/oauth/callback', codeVerifier: a.verifier });
  expect(await kolab.sessionInfo(t.accessToken)).toMatchObject({ actor: 'eli', kolab: 'anns', role: 'engineer', access: { level: 'write', layers: ['technical'] } });

  // Used: a second sign-in with it offers nothing, and choosing it is refused.
  const b = await begin(token);
  expect((await kolab.consentOptions(eli, { inviteKey: (await kolab.pendingAuthorization(b.binding))!.inviteKey })).invite).toBeUndefined();
  expect(await rejection(kolab.consent(b.binding, b.csrf, { as: { kind: 'self' }, kolab: { invite: true }, role: 'product' }, { selfOnly: true }))).toMatch(/unknown, already used/);
  // A sign-in with no invite can't choose one; nor does a malformed secret ride along.
  const c = await begin('not-an-invite');
  expect((await kolab.pendingAuthorization(c.binding))!.inviteKey).toBeNull();
  expect(await rejection(kolab.consent(c.binding, c.csrf, { as: { kind: 'self' }, kolab: { invite: true }, role: 'product' }))).toMatch(/carries no invite/);
  // Only a person, through the web page, joins with one: not a client acting as an agent, even if one carried it.
  const fresh = await kolab.createInvite(session, { level: 'read' });
  const d = await begin(fresh.token);
  expect(await rejection(kolab.consent(d.binding, d.csrf, { as: { kind: 'new-agent', label: 'cli' }, kolab: { invite: true }, role: 'product' }))).toMatch(/accepted by a person, on Kolab's own web page/);
  expect(await kolab.previewInvite(fresh.token)).toBeDefined();   // untouched
});

test('no agent reads, writes or counts invites: kj_agent and kj_system are granted nothing on them', async () => {
  const { kolab, session } = await anns();
  await kolab.createInvite(session, { level: 'read' });
  for (const role of ['kj_agent', 'kj_system']) {
    const asRole = (sql: string) => kolab.db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(session)]);
      await tx.query(sql);
    });
    expect(await rejection(asRole(`select key from kolab_invite`))).toMatch(/permission denied/);
    expect(await rejection(asRole(`update kolab_invite set revoked_at = now()`))).toMatch(/permission denied/);
    expect(await rejection(asRole(`select invite_key from oauth_request`))).toMatch(/permission denied/);
  }
});

(onPostgres ? test : test.skip)('two Kolab processes at once: one invite is accepted once, and a kolab\'s open invites stay under its cap', async () => {
  const store = await persistentStore();
  const a = await openKolab(store);
  const b = await openKolab(store);
  const { session } = await anns(a);
  const { token } = await a.createInvite(session, { level: 'write', layers: ['technical'] });
  const people = [];
  for (let i = 0; i < 6; i++) people.push((await a.signInWith(github(`3${i}`, `p${i}`))).actor);
  const tries = await Promise.allSettled(people.map((p, i) => (i % 2 ? a : b).acceptInvite(token, p)));
  expect(tries.filter((x) => x.status === 'fulfilled').length).toBe(1);
  const joined = (await a.db.query<{ user_id: string }>(`select user_id from kolab_grant where kolab_id = 'anns' and user_id is not null`)).rows;
  expect(joined.length).toBe(1);

  a.invites.openPerKolab = b.invites.openPerKolab = 3;
  const made = await Promise.allSettled([a, b, a, b, a, b].map((k) => k.createInvite(session, { level: 'read' })));
  expect(made.filter((x) => x.status === 'fulfilled').length).toBe(3);
});
