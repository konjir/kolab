// Signing up and in with an identity provider, and Kolab's OAuth grants (D55): who a new person
// becomes, what an access token reaches and for how long, rotation, replay and revocation, and
// row-level security refusing an expired or rotated token on its own.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { Kolab, OAuthGrantError, redirectUriMatches, sessionKey, signUpNames, validRedirectUri } from '../src/index.js';
import { els, openKolab, people, rejection } from '../src/testing.js';

const github = (subject: string, login: string, name?: string) => ({ provider: 'github', subject, login, name });
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

/** A whole authorization for `person`, straight through the engine: begin, identify, consent, and the code exchanged. */
async function authorized(kolab: Kolab, person: string, choice: Parameters<Kolab['consent']>[2], opts: { clientId?: string; selfOnly?: boolean } = {}) {
  const client = opts.clientId ?? (await kolab.registerClient({ name: 'Test client', redirectUris: ['http://127.0.0.1:9/cb'] })).id;
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256(verifier), clientState: 'xyz' });
  const { csrf } = await kolab.identifyAuthorization(binding, state, person);
  const { code, redirectUri, clientState } = await kolab.consent(binding, csrf, choice, { selfOnly: opts.selfOnly });
  expect([redirectUri, clientState]).toStrictEqual(['http://127.0.0.1:9/cb', 'xyz']);
  return { client, code, verifier, tokens: () => kolab.exchangeCode({ code, clientId: client, redirectUri, codeVerifier: verifier }) };
}

test('a first sign-in signs a person up, named after their login; a later one, by the same id, finds them, whatever their login is now', async () => {
  const kolab = await openKolab();
  expect(await kolab.signInWith(github('1001', 'LeeNorris', 'Lee Norris'))).toStrictEqual({ actor: 'leenorris', created: true });
  expect(await kolab.actor('leenorris')).toMatchObject({ kind: 'person', name: 'Lee Norris', owner: null });
  expect(await kolab.listKolabs()).toStrictEqual([]);   // nobody's kolab is touched
  // GitHub logins change hands; the id doesn't.
  expect(await kolab.signInWith(github('1001', 'lee-renamed'))).toStrictEqual({ actor: 'leenorris', created: false });
  expect(await kolab.identities('leenorris')).toStrictEqual([{ provider: 'github', subject: '1001', login: 'lee-renamed' }]);
});

test('a login that is taken, in any case, by a live or archived account or actor, or reserved, signs up as a variant no GitHub login can be', async () => {
  const kolab = await openKolab();
  await kolab.addActor('alice');
  await kolab.addOrganization('acme');
  await kolab.addActor('bob');
  await kolab.archive({ actor: 'bob' });
  await kolab.addActor('carol-pm', { owner: 'alice' });
  // An existing person is never matched by name: a GitHub user called alice is someone else.
  expect(await kolab.signInWith(github('1', 'Alice'))).toStrictEqual({ actor: 'alice_2', created: true });
  expect(await kolab.signInWith(github('2', 'alice'))).toStrictEqual({ actor: 'alice_3', created: true });
  expect(await kolab.signInWith(github('3', 'ACME'))).toStrictEqual({ actor: 'acme_2', created: true });
  expect(await kolab.signInWith(github('4', 'bob'))).toStrictEqual({ actor: 'bob_2', created: true });   // archived names stay reserved (D52)
  expect(await kolab.signInWith(github('5', 'carol-pm'))).toStrictEqual({ actor: 'carol-pm_2', created: true });
  expect(await kolab.signInWith(github('6', 'kolab'))).toStrictEqual({ actor: 'gh_kolab', created: true });
  expect(await kolab.signInWith(github('7', 'konjir-site'))).toStrictEqual({ actor: 'gh_konjir-site', created: true });
  expect([...signUpNames('Konjir')].slice(0, 2)).toStrictEqual(['gh_konjir', 'gh_konjir_2']);
  // Words an admin or Kolab itself would be taken for.
  for (const [i, w] of ['admin', 'Root', 'system', 'support'].entries()) {
    expect(await kolab.signInWith(github(`70${i}`, w))).toStrictEqual({ actor: `gh_${w.toLowerCase()}`, created: true });
  }
  // A login that reads as an existing person's agent, <person>-<label>, can't pass for one (D30).
  expect(await kolab.signInWith(github('8', 'Alice-Claude'))).toStrictEqual({ actor: 'gh_alice-claude', created: true });
  expect(await kolab.signInWith(github('9', 'acme-bot'))).toStrictEqual({ actor: 'acme-bot', created: true });   // acme is an organization, not a person
  expect(await kolab.signInWith(github('10', 'nobody-here'))).toStrictEqual({ actor: 'nobody-here', created: true });
  expect(await kolab.actor('alice')).toMatchObject({ kind: 'person' });   // untouched
});

test('an archived person does not sign in; an admin links an existing person to their identity, once', async () => {
  const kolab = await openKolab();
  await kolab.addActor('lee');
  await kolab.linkIdentity('lee', { provider: 'github', subject: '42', login: 'icedlee337' });
  expect(await kolab.signInWith(github('42', 'icedlee337'))).toStrictEqual({ actor: 'lee', created: false });
  expect(await rejection(kolab.linkIdentity('lee', { provider: 'github', subject: '43' }))).toMatch(/already linked to a github identity/);
  await kolab.addActor('pat');
  expect(await rejection(kolab.linkIdentity('pat', { provider: 'github', subject: '42' }))).toMatch(/already linked to lee/);
  await kolab.addActor('pat-bot', { owner: 'pat' });
  expect(await rejection(kolab.linkIdentity('pat-bot', { provider: 'github', subject: '44' }))).toMatch(/only a person signs in/);
  expect(await rejection(kolab.db.query(`insert into identity(provider, subject, actor_id, login) values ('github', '45', 'pat-bot', 'x')`))).toMatch(/only a person has an identity/);
  await kolab.archive({ actor: 'lee' });
  expect(await rejection(kolab.signInWith(github('42', 'icedlee337')))).toMatch(/lee is archived, so it can't sign in/);
});

test('redirect URIs: https, or http only on loopback (any port there); never an app scheme, javascript:, data:, a fragment or credentials', () => {
  for (const ok of ['https://app.example.com/cb', 'http://127.0.0.1:33418/callback', 'http://localhost/cb', 'http://[::1]:8080/cb']) expect([ok, validRedirectUri(ok)]).toStrictEqual([ok, true]);
  for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://a.example/cb#x', 'https://a.example/cb#', 'https://u:p@a.example/cb',
    'http://u@127.0.0.1/cb', 'http://@127.0.0.1/cb', 'myapp:/cb', 'com.example.app:/oauth', 'not a url']) {
    expect([bad, validRedirectUri(bad)]).toStrictEqual([bad, false]);
  }
  expect(redirectUriMatches(['http://localhost:5000/cb'], 'http://localhost:61234/cb')).toBe(true);   // RFC 8252 §7.3
  expect(redirectUriMatches(['http://localhost:5000/cb'], 'http://localhost:61234/other')).toBe(false);
  expect(redirectUriMatches(['http://localhost:5000/cb'], 'http://127.0.0.1:5000/cb')).toBe(false);
  expect(redirectUriMatches(['https://a.example/cb'], 'https://a.example/cb/')).toBe(false);
  expect(redirectUriMatches(['https://a.example/cb'], 'https://a.example:444/cb')).toBe(false);
  // Only the loopback port may vary: never a fragment or credentials (OAuth 2.1 §2.3).
  expect(redirectUriMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:9/cb#x')).toBe(false);
  expect(redirectUriMatches(['http://127.0.0.1/cb'], 'http://u:p@127.0.0.1:9/cb')).toBe(false);
});

test('an access token is a session token that expires; refreshing rotates both tokens and keeps the session, its id, kolab and role', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice');
  const { actor } = await kolab.signInWith(github('7', 'alice'));   // alice_2: someone new
  await kolab.grant('test', actor, 'write', { layers: ['functional'] });
  const t = await (await authorized(kolab, actor, { as: { kind: 'self' }, kolab: 'test', role: 'product' })).tokens();
  expect(t).toMatchObject({ actor, kolab: 'test', role: 'product', expiresIn: 900, scope: 'konjir kolab:test role:product' });
  expect(t.accessToken).toMatch(/^kjs_/);
  expect(t.refreshToken).toMatch(/^kjr_/);
  // Nothing stored is a token.
  const stored = JSON.stringify((await kolab.db.query(`select * from session`)).rows) + JSON.stringify((await kolab.db.query(`select * from oauth_refresh_token`)).rows);
  for (const secret of [t.accessToken, t.refreshToken]) expect(stored).not.toContain(secret);
  expect((await kolab.sessionInfo(t.accessToken)).session).toBe(t.session);
  await kolab.createNode(t.accessToken, 'functional_spec', 'Orders', 'orders');

  const r = await kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: (await kolab.db.query<{ client_id: string }>(`select client_id from oauth_grant`)).rows[0].client_id });
  expect([r.session, r.kolab, r.role, r.actor]).toStrictEqual([t.session, 'test', 'product', actor]);
  expect(r.accessToken).not.toBe(t.accessToken);
  // The old access token reaches nothing now; the new one does.
  expect(await kolab.sessionOpen(t.accessToken)).toBe(false);
  expect(await rejection(kolab.sessionKolab(t.accessToken))).toMatch(/no open session/);
  expect((await kolab.sessionInfo(r.accessToken)).session).toBe(t.session);
  expect(await kolab.liveSessions([t.session])).toStrictEqual(new Set([t.session]));

  // Expired: neither Kolab nor row-level security lets it in.
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where id = $1`, [t.session]);
  expect(await kolab.sessionOpen(r.accessToken)).toBe(false);
  expect(await rejection(kolab.draft(r.accessToken, 'orders', { elements: els({ R1: 'x' }) }))).toMatch(/no open session/);
  const asAgent = await kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(r.accessToken)]);
    return (await tx.query<{ kolab: string | null; actor: string | null }>(`select kj_session_kolab() as kolab, kj_session_actor() as actor`)).rows[0];
  });
  expect(asAgent).toStrictEqual({ kolab: null, actor: null });
  // But the session lives on, for its streams and its refresh.
  expect(await kolab.liveSessions([t.session])).toStrictEqual(new Set([t.session]));
});

test('a refresh token is used once: again at once is a race, refused; again later is a replay, which revokes the grant and ends its session', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice');
  const { actor } = await kolab.signInWith(github('8', 'ann'));
  await kolab.grant('test', actor, 'write');
  const a = await authorized(kolab, actor, { as: { kind: 'self' }, kolab: 'test', role: 'engineer' });
  const t = await a.tokens();
  const ended: string[] = [];
  kolab.onEvent((e) => { if ('session' in e) ended.push(e.id); });
  const r1 = await kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client });
  // Another client can't use it.
  expect(await rejection(kolab.refreshGrant({ refreshToken: r1.refreshToken, clientId: 'kjcl_someoneelse0000000000' }))).toMatch(/invalid|unknown/);
  // At once: a concurrent request, refused, nothing revoked.
  const race = await kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client }).catch((e: OAuthGrantError) => e.code);
  expect(race).toBe('invalid_grant');
  expect(await kolab.sessionOpen(r1.accessToken)).toBe(true);
  // Later: a replay.
  await kolab.db.query(`update oauth_refresh_token set used_at = now() - interval '1 minute' where key = $1`, [sessionKey(t.refreshToken)]);
  expect(await rejection(kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client }))).toMatch(/OAuthGrantError/);
  expect(await kolab.sessionOpen(r1.accessToken)).toBe(false);
  expect(ended).toStrictEqual([t.session]);
  expect(await rejection(kolab.refreshGrant({ refreshToken: r1.refreshToken, clientId: a.client }))).toMatch(/revoked|unknown/);
});

test('a code is used once, by its client, at its redirect URI, with its PKCE verifier; used again, it revokes what it opened', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice');
  const { actor } = await kolab.signInWith(github('9', 'dee'));
  await kolab.grant('test', actor, 'read');
  const a = await authorized(kolab, actor, { as: { kind: 'self' }, kolab: 'test', role: 'product' });
  const bad = (p: Partial<Parameters<Kolab['exchangeCode']>[0]>) =>
    kolab.exchangeCode({ code: a.code, clientId: a.client, redirectUri: 'http://127.0.0.1:9/cb', codeVerifier: a.verifier, ...p }).catch((e: OAuthGrantError) => e.code);
  expect(await bad({ codeVerifier: randomBytes(32).toString('base64url') })).toBe('invalid_grant');
  expect(await bad({ codeVerifier: 'short' })).toBe('invalid_grant');
  expect(await bad({ redirectUri: 'http://127.0.0.1:9/other' })).toBe('invalid_grant');
  expect(await bad({ clientId: 'kjcl_another0000000000000000' })).toBe('invalid_grant');
  const t = await a.tokens();   // none of those used it up
  expect(await kolab.sessionOpen(t.accessToken)).toBe(true);
  expect(await bad({})).toBe('invalid_grant');
  expect(await kolab.sessionOpen(t.accessToken)).toBe(false);   // the replay revoked the grant
  // An expired code.
  const b = await authorized(kolab, actor, { as: { kind: 'self' }, kolab: 'test', role: 'product' });
  await kolab.db.query(`update oauth_code set expires_at = now() - interval '1 second' where key = $1`, [sessionKey(b.code)]);
  expect(await b.tokens().catch((e: OAuthGrantError) => e.code)).toBe('invalid_grant');
});

test('a sign-in counts only with its binding and state, once; consent needs its token, once', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice');
  const c = await kolab.registerClient({ redirectUris: ['https://app.example/cb'] });
  const begin = () => kolab.beginAuthorization({ provider: 'github', clientId: c.id, redirectUri: 'https://app.example/cb', codeChallenge: s256('v'.repeat(43)) });
  const one = await begin();
  const two = await begin();
  expect(await rejection(kolab.identifyAuthorization(one.binding, two.state, 'alice'))).toMatch(/another browser|start again/);   // a mixed-up state
  expect(await rejection(kolab.identifyAuthorization(randomBytes(32).toString('base64url'), one.state, 'alice'))).toMatch(/start again/);
  const { csrf } = await kolab.identifyAuthorization(one.binding, one.state, 'alice');
  expect(await rejection(kolab.identifyAuthorization(one.binding, one.state, 'alice'))).toMatch(/already used|start again/);
  const choice = { as: { kind: 'self' as const }, kolab: 'test', role: 'product' as const };
  expect(await rejection(kolab.consent(one.binding, randomBytes(32).toString('base64url'), choice))).toMatch(/expired or was already used/);
  await kolab.consent(one.binding, csrf, choice);
  expect(await rejection(kolab.consent(one.binding, csrf, choice))).toMatch(/expired or was already used/);
  // Expired.
  const three = await begin();
  await kolab.db.query(`update oauth_request set expires_at = now() - interval '1 second' where id = $1`, [sessionKey(three.binding)]);
  expect(await rejection(kolab.identifyAuthorization(three.binding, three.state, 'alice'))).toMatch(/expired/);
});

test('consent: a new kolab of your own, a new agent capped by its owner (D30), the newest sign-in for an actor winning (ENF4), people only for the web', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['technical'] });
  const { actor: zoe } = await kolab.signInWith(github('10', 'zoe'));
  // Someone new, with no kolab: they make their first on the way (D54).
  const own = await (await authorized(kolab, zoe, { as: { kind: 'self' }, kolab: { name: 'zoes-shop', title: 'Zoe\'s shop' }, role: 'product' })).tokens();
  expect(await kolab.sessionInfo(own.accessToken)).toMatchObject({ actor: 'zoe', kolab: 'zoes-shop', role: 'product', access: { level: 'admin' } });
  expect(await rejection(authorized(kolab, zoe, { as: { kind: 'self' }, kolab: { name: 'konjir-x', title: 'x' }, role: 'product' }))).toMatch(/reserved/);
  // Her agent, made at consent, works in her kolab as itself, with what she holds, at most Write.
  const agent = await (await authorized(kolab, zoe, { as: { kind: 'new-agent', label: 'claude' }, kolab: 'zoes-shop', role: 'engineer' })).tokens();
  expect(await kolab.sessionInfo(agent.accessToken)).toMatchObject({ actor: 'zoe-claude', kind: 'agent', owner: 'zoe', access: { level: 'write', layers: ['functional', 'technical'] } });
  expect(await kolab.sessionOpen(own.accessToken)).toBe(true);   // a different actor: both sessions stand
  // In a kolab where she holds only Write on technical, her agent gets no more.
  await kolab.grant('test', zoe, 'write', { layers: ['technical'] });
  const there = await (await authorized(kolab, zoe, { as: { kind: 'agent', agent: 'zoe-claude' }, kolab: 'test', role: 'engineer' })).tokens();
  expect((await kolab.sessionInfo(there.accessToken)).access).toStrictEqual({ level: 'write', layers: ['technical'] });
  expect(await kolab.sessionOpen(agent.accessToken)).toBe(false);   // the newest sign-in as zoe-claude won
  // Someone else's agent, or an agent for the web, is refused.
  await kolab.addActor('alice-bot', { owner: 'alice' });
  expect(await rejection(authorized(kolab, zoe, { as: { kind: 'agent', agent: 'alice-bot' }, kolab: 'test', role: 'engineer' }))).toMatch(/no agent alice-bot of yours/);
  expect(await rejection(authorized(kolab, zoe, { as: { kind: 'agent', agent: 'zoe-claude' }, kolab: 'test', role: 'engineer' }, { selfOnly: true }))).toMatch(/for people/);
  // A kolab she reads only because it is public gives her agents nothing (D56), and stores no grant.
  await kolab.addOrganization('pubs');
  await kolab.createKolab('open-door', { owner: 'pubs', visibility: 'public' });
  expect(await rejection(authorized(kolab, zoe, { as: { kind: 'agent', agent: 'zoe-claude' }, kolab: 'open-door', role: 'product' }))).toMatch(/only because it is public/);
  expect((await kolab.db.query(`select 1 from kolab_grant where kolab_id = 'open-door'`)).rows).toStrictEqual([]);
  // As herself, she may read it.
  expect((await kolab.sessionInfo(await (await authorized(kolab, zoe, { as: { kind: 'self' }, kolab: 'open-door', role: 'product' })).tokens().then((t) => t.accessToken))).access.level).toBe('read');
  // Through a team of an organization she belongs to, her agent's grant is stored, and follows her access down (D30).
  await kolab.addOrganization('acme');
  await kolab.createKolab('acme-app', { owner: 'acme' });
  await kolab.addMember('acme', zoe);
  await kolab.addTeam('acme', 'devs');
  await kolab.addTeamMember('acme/devs', zoe);
  await kolab.grant('acme-app', 'acme/devs', 'write', { layers: ['functional'] });
  const viaTeam = await (await authorized(kolab, zoe, { as: { kind: 'agent', agent: 'zoe-claude' }, kolab: 'acme-app', role: 'product' })).tokens();
  expect((await kolab.sessionInfo(viaTeam.accessToken)).access).toStrictEqual({ level: 'write', layers: ['functional'] });
  await kolab.grant('acme-app', 'acme/devs', 'read');
  expect(await rejection(kolab.draft(viaTeam.accessToken, 'x', { elements: [] }))).toMatch(/./);
  expect((await kolab.access('zoe-claude', 'acme-app'))).toStrictEqual({ level: 'read', layers: [] });
  // A kolab she can't reach.
  await kolab.addOrganization('other');
  await kolab.createKolab('secret', { owner: 'other' });
  expect(await rejection(authorized(kolab, zoe, { as: { kind: 'self' }, kolab: 'secret', role: 'product' }))).toMatch(/no kolab secret you can reach/);
});

test('revoking a refresh or access token ends its grant\'s session and tells its listeners (D41); a hand-issued token is left alone', async () => {
  const kolab = await openKolab();
  await people(kolab, ['alice', 'bob']);
  const { actor } = await kolab.signInWith(github('11', 'eve'));
  await kolab.grant('test', actor, 'write');
  const ended: string[] = [];
  kolab.onEvent((e) => { if ('session' in e) ended.push(e.id); });
  const a = await (await authorized(kolab, actor, { as: { kind: 'self' }, kolab: 'test', role: 'product' })).tokens();
  expect(await kolab.revokeToken(a.refreshToken)).toBe(true);
  expect(await kolab.sessionOpen(a.accessToken)).toBe(false);
  const b = await (await authorized(kolab, actor, { as: { kind: 'self' }, kolab: 'test', role: 'product' })).tokens();
  expect(await kolab.revokeToken(b.accessToken, { clientId: 'kjcl_notthisone000000000000' })).toBe(false);
  expect(await kolab.revokeToken(b.accessToken)).toBe(true);
  expect(ended).toStrictEqual([a.session, b.session]);
  const hand = await kolab.openSession('bob', 'engineer');
  expect(await kolab.revokeToken(hand)).toBe(false);
  expect(await kolab.sessionOpen(hand)).toBe(true);
  // Switching kolab or role keeps the grant: the refresh token still renews the new session.
  const c = await (await authorized(kolab, actor, { as: { kind: 'self' }, kolab: 'test', role: 'product' })).tokens();
  const moved = await kolab.switchSession(c.accessToken, { kolab: 'test', role: 'engineer' });
  const client = (await kolab.db.query<{ client_id: string }>(`select client_id from oauth_grant order by created_at desc limit 1`)).rows[0].client_id;
  const r = await kolab.refreshGrant({ refreshToken: c.refreshToken, clientId: client });
  expect(r.role).toBe('engineer');
  expect(await kolab.sessionOpen(moved)).toBe(false);
  expect(await kolab.sessionOpen(r.accessToken)).toBe(true);
});

test('one consent form makes one thing: submissions at once are refused but one; a failed one can be corrected', async () => {
  const kolab = await openKolab();
  const { actor } = await kolab.signInWith(github('20', 'quinn'));
  const client = (await kolab.registerClient({ redirectUris: ['http://127.0.0.1:9/cb'] })).id;
  const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256('v'.repeat(43)) });
  const { csrf } = await kolab.identifyAuthorization(binding, state, actor);
  // A mistake first: the claim is released, so the page can be corrected.
  expect(await rejection(kolab.consent(binding, csrf, { as: { kind: 'self' }, kolab: { name: 'Bad Name', title: 'x' }, role: 'product' }))).toMatch(/valid kolab name/);
  const tries = await Promise.allSettled(['a', 'b', 'c'].map((l) =>
    kolab.consent(binding, csrf, { as: { kind: 'new-agent', label: l }, kolab: { name: `quinn-${l}`, title: l }, role: 'product' })));
  expect(tries.filter((t) => t.status === 'fulfilled').length).toBe(1);
  expect((await kolab.listKolabs({ owner: actor })).length).toBe(1);
  expect((await kolab.listActors({ owner: actor })).length).toBe(1);
});

test('the cap on a person\'s agents holds for calls at once; unused registered clients are pruned', async () => {
  const kolab = await openKolab();
  const { actor } = await kolab.signInWith(github('21', 'rho'));
  kolab.oauth.agentsPerPerson = 2;
  const made = await Promise.allSettled(['a', 'b', 'c'].map((l) => kolab.addOwnAgent(actor, l)));
  expect(made.filter((m) => m.status === 'fulfilled').length).toBe(2);
  expect((await kolab.listActors({ owner: actor })).length).toBe(2);

  const unused = await kolab.registerClient({ redirectUris: ['http://127.0.0.1:9/cb'] });
  const used = await kolab.registerClient({ redirectUris: ['http://127.0.0.1:9/cb'] });
  const fresh = await kolab.registerClient({ redirectUris: ['http://127.0.0.1:9/cb'] });
  await kolab.oauthClient(used.id, { use: true });
  await kolab.db.query(`update oauth_client set created_at = now() - interval '2 days' where id = any($1)`, [[unused.id, used.id]]);
  expect(await kolab.pruneClients()).toBe(1);
  expect(await kolab.oauthClient(unused.id)).toBeUndefined();
  await kolab.db.query(`update oauth_client set last_used_at = now() - interval '31 days' where id = $1`, [used.id]);
  expect(await kolab.pruneClients()).toBe(1);
  expect([await kolab.oauthClient(used.id), (await kolab.oauthClient(fresh.id))?.id]).toStrictEqual([undefined, fresh.id]);
});
