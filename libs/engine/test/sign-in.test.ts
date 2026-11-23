// Signing up and in with an identity provider, and Kolab's OAuth grants (D55): who a new person
// becomes, what an access token reaches and for how long, rotation, replay and revocation, and
// row-level security refusing an expired or rotated token on its own.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { APP_DEV_REDIRECT_URIS, ActorError, ArchivedSignInError, APP_HTTPS_REDIRECT_URIS, APP_PREVIEW_REDIRECT_URI, APP_REDIRECT_URI, Kolab, OAuthGrantError, appRedirect, onPersonsDevice, redirectUriMatches, sessionKey, signUpNames, validRedirectUri } from '../src/index.js';
import { els, openKolab, people, persistentStore, rejection } from '../src/testing.js';

const onPostgres = !!process.env.KONJIR_TEST_DATABASE_URL;

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

test('migration 0028: a sign-in\'s "N of M" is both or neither, each 1 to 99, N no more than M, whatever writes it (D97)', async () => {
  const kolab = await openKolab();
  const client = (await kolab.registerClient({ name: 'Test client', redirectUris: ['http://127.0.0.1:9/cb'] })).id;
  const { binding } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256('v'.repeat(43)), step: { n: 2, of: 3 } });
  const id = sessionKey(binding);
  expect((await kolab.db.query(`select step, steps from oauth_request where id = $1`, [id])).rows).toStrictEqual([{ step: 2, steps: 3 }]);
  for (const [step, steps] of [[5, 4], [0, 4], [1, 100], [1, null], [null, 2], [-1, 2]]) {
    expect([step, steps, await rejection(kolab.db.query(`update oauth_request set step = $2, steps = $3 where id = $1`, [id, step, steps]))])
      .toStrictEqual([step, steps, expect.stringMatching(/oauth_request_step/)]);
  }
  for (const [step, steps] of [[null, null], [1, 1], [99, 99], [3, 7]]) {
    await kolab.db.query(`update oauth_request set step = $2, steps = $3 where id = $1`, [id, step, steps]);
  }
  // The engine keeps only a valid one: anything else is stored as neither.
  const bad = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256('w'.repeat(43)), step: { n: 3, of: 2 } });
  expect((await kolab.db.query(`select step, steps from oauth_request where id = $1`, [sessionKey(bad.binding)])).rows).toStrictEqual([{ step: null, steps: null }]);
});

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
  expect(await kolab.signInWith(github('9', 'acme-bot'))).toStrictEqual({ actor: 'gh_acme-bot', created: true });   // nor for an organization's (D30)
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

test('redirect URIs: https, or http only on loopback (any port there); never another app\'s scheme, javascript:, data:, a fragment or credentials', () => {
  for (const ok of ['https://app.example.com/cb', 'https://xn--bcher-kva.example/cb', 'https://203.0.113.9/cb', 'https://[2001:db8::1]/cb', 'http://127.0.0.1:33418/callback', 'http://localhost/cb', 'http://[::1]:8080/cb']) expect([ok, validRedirectUri(ok)]).toStrictEqual([ok, true]);
  for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://a.example/cb#x', 'https://a.example/cb#', 'https://u:p@a.example/cb',
    'http://u@127.0.0.1/cb', 'http://@127.0.0.1/cb', 'myapp:/cb', 'com.example.app:/oauth', 'not a url',
    // Hosts a CSP source can't name, which the URL parser lets through: never registered.
    'https://a_b.example/cb', 'https://a;b.example/cb', 'https://-a.example/cb', 'https://a-.example/cb', 'https://999.1.1.1/cb', `https://${'a'.repeat(64)}.example/cb`]) {
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

test('konnect\'s own app\'s redirect URIs: its https link always, its development builds\' <scheme>:/oauth only where allowed, and the production scheme never; matched as strings, no look-alike, other form, case, query, fragment or host', async () => {
  const dev = ['com.konjir.konnect.dev:/oauth', 'com.konjir.konnect.preview:/oauth'];
  expect([APP_REDIRECT_URI, APP_PREVIEW_REDIRECT_URI, APP_DEV_REDIRECT_URIS]).toStrictEqual(['https://www.konjir.com/konnect/app/oauth', 'https://www.konjir.com/konnect/app/preview/oauth', dev]);
  expect(APP_HTTPS_REDIRECT_URIS).toStrictEqual([APP_REDIRECT_URI, APP_PREVIEW_REDIRECT_URI]);
  // The https links, production's and preview's, each on its own path: the app's on every Kolab, and a valid https redirect anywhere.
  for (const devSchemes of [false, true]) {
    for (const link of APP_HTTPS_REDIRECT_URIS) {
      expect([devSchemes, link, validRedirectUri(link, devSchemes), appRedirect(link, devSchemes)]).toStrictEqual([devSchemes, link, true, true]);
    }
  }
  // One build's link never stands in for the other's.
  expect(redirectUriMatches([APP_REDIRECT_URI], APP_PREVIEW_REDIRECT_URI)).toBe(false);
  expect(redirectUriMatches([APP_PREVIEW_REDIRECT_URI], APP_REDIRECT_URI)).toBe(false);
  // The development builds' schemes: only where allowed.
  for (const ok of dev) {
    expect([ok, validRedirectUri(ok, true), appRedirect(ok, true), redirectUriMatches([ok], ok, true)]).toStrictEqual([ok, true, true, true]);
    expect([ok, redirectUriMatches([ok], ok)]).toStrictEqual([ok, false]);
    expect([ok, validRedirectUri(ok, false), appRedirect(ok, false), validRedirectUri(ok)]).toStrictEqual([ok, false, false, false]);
  }
  // The production build's own scheme is no redirect URI at all: production signs in through the https link.
  expect([validRedirectUri('com.konjir.konnect:/oauth', true), appRedirect('com.konjir.konnect:/oauth', true)]).toStrictEqual([false, false]);
  // Look-alikes of the https link are https redirects like any other, never the app's.
  for (const other of ['https://www.konjir.com/konnect/app/oauth/', 'https://www.konjir.com/konnect/app/oauth?x=1', 'https://konjir.com/konnect/app/oauth',
    'https://www.konjir.com/konnect/app/OAUTH', 'https://WWW.konjir.com/konnect/app/oauth', 'https://www.konjir.com:443/konnect/app/oauth', 'https://www.konjir.com.evil.example/konnect/app/oauth',
    'https://www.konjir.com/konnect/app/preview/oauth/', 'https://www.konjir.com/konnect/app/preview/oauth?x=1', 'https://www.konjir.com/konnect/app/preview', 'https://www.konjir.com/konnect/app/dev/oauth',
    'https://www.konjir.com/konnect/app/oauth/preview', 'https://www.konjir.com/konnect/app/Preview/oauth']) {
    expect([other, appRedirect(other, true)]).toStrictEqual([other, false]);
  }
  for (const bad of [
    // Look-alike schemes: a suffix, a longer name, another variant, a prefix of one.
    'com.konjir.konnect.evil:/oauth', 'com.konjir.konnectx:/oauth', 'com.konjir.konnect.devx:/oauth', 'com.konjir:/oauth', 'konnect:/oauth', 'com.konjir.konnect-dev:/oauth',
    'org.konjir.konnect:/oauth', 'xcom.konjir.konnect.dev:/oauth', ' com.konjir.konnect.dev:/oauth', 'com.konjir.konnect.dev:/oauth ',
    // Another case: matched as written, as registered.
    'COM.KONJIR.KONNECT.DEV:/oauth', 'Com.Konjir.Konnect.Dev:/oauth', 'com.konjir.konnect.dev:/OAUTH',
    // Other forms: an authority, empty or not, a host, another path.
    'com.konjir.konnect.dev://oauth', 'com.konjir.konnect.dev:///oauth', 'com.konjir.konnect.dev://evil.com/oauth', 'com.konjir.konnect.dev://u@evil.com/oauth',
    'com.konjir.konnect.dev:oauth', 'com.konjir.konnect.dev:/oauth/', 'com.konjir.konnect.dev:/oauth/x', 'com.konjir.konnect.dev:/oauth2', 'com.konjir.konnect.dev:/', 'com.konjir.konnect.dev:',
    'com.konjir.konnect.dev:/./oauth', 'com.konjir.konnect.dev:/x/../oauth', 'com.konjir.konnect.dev:/%6Fauth',
    // A query, a fragment (even empty), smuggled characters.
    'com.konjir.konnect.dev:/oauth?x=1', 'com.konjir.konnect.dev:/oauth?', 'com.konjir.konnect.dev:/oauth#x', 'com.konjir.konnect.dev:/oauth#', 'com.konjir.konnect.dev:/oauth\n', 'com.konjir.konnect.dev:/oauth%00',
  ]) {
    expect([bad, validRedirectUri(bad, true), appRedirect(bad, true)]).toStrictEqual([bad, false, false]);
    // Registered beside the real ones, a look-alike given at authorization is never taken for one.
    expect([bad, redirectUriMatches(dev, bad, true)]).toStrictEqual([bad, false]);
  }
  // One variant's redirect never stands in for another's.
  expect(redirectUriMatches(['com.konjir.konnect.preview:/oauth'], 'com.konjir.konnect.dev:/oauth', true)).toBe(false);
  // Registration takes them where allowed, alone or beside others, and refuses a look-alike, naming the ones it takes.
  const kolab = await openKolab();
  expect((await kolab.registerClient({ redirectUris: [APP_REDIRECT_URI, ...dev] })).redirectUris).toStrictEqual([APP_REDIRECT_URI, ...dev]);
  expect((await kolab.registerClient({ redirectUris: ['com.konjir.konnect.dev:/oauth', 'https://app.example/cb'] })).redirectUris).toHaveLength(2);
  const e = await kolab.registerClient({ redirectUris: ['com.konjir.konnect.evil:/oauth'] }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(OAuthGrantError);
  expect((e as OAuthGrantError).message).toBe('com.konjir.konnect.evil:/oauth isn\'t a redirect URI Kolab sends codes to: use https, or http on a loopback address, with no fragment or credentials; the only app schemes are konnect\'s own development builds\', com.konjir.konnect.dev:/oauth, com.konjir.konnect.preview:/oauth');
  // A Kolab that doesn't allow them, as production: the https link alone, and no scheme at all, the development builds' included.
  const production = await openKolab({ appDevSchemes: false });
  expect((await production.registerClient({ redirectUris: [APP_REDIRECT_URI] })).redirectUris).toStrictEqual([APP_REDIRECT_URI]);
  expect((await production.registerClient({ redirectUris: [APP_PREVIEW_REDIRECT_URI] })).redirectUris).toStrictEqual([APP_PREVIEW_REDIRECT_URI]);
  for (const scheme of ['com.konjir.konnect:/oauth', ...dev]) {
    const refused = await production.registerClient({ redirectUris: [scheme] }).catch((x: unknown) => x);
    expect([scheme, (refused as OAuthGrantError).message]).toStrictEqual([scheme, `${scheme} isn't a redirect URI Kolab sends codes to: use https, or http on a loopback address, with no fragment or credentials`]);
  }
});

test('a client is on the person\'s own device when every redirect URI is loopback, or every one is konnect\'s own app\'s; never a mix', () => {
  expect(onPersonsDevice(['http://127.0.0.1:9/cb', 'http://[::1]:9/cb'], false)).toBe(true);
  expect(onPersonsDevice([APP_REDIRECT_URI], false)).toBe(true);
  expect(onPersonsDevice([APP_PREVIEW_REDIRECT_URI], false)).toBe(true);
  expect(onPersonsDevice([APP_PREVIEW_REDIRECT_URI, 'https://app.example/cb'], false)).toBe(false);
  expect(onPersonsDevice([APP_REDIRECT_URI, 'com.konjir.konnect.dev:/oauth', 'com.konjir.konnect.preview:/oauth'], true)).toBe(true);
  // A development build's scheme counts only where it is allowed.
  expect(onPersonsDevice(['com.konjir.konnect.dev:/oauth'], false)).toBe(false);
  for (const mixed of [
    [APP_REDIRECT_URI, 'https://app.example/cb'], ['https://app.example/cb', APP_REDIRECT_URI],
    [APP_REDIRECT_URI, 'http://127.0.0.1:9/cb'], ['http://127.0.0.1:9/cb', 'https://app.example/cb'],
    ['https://app.example/cb'], ['http://localhost:9/cb'], ['com.konjir.konnect.evil:/oauth'], ['com.konjir.konnect:/oauth'], [],
  ]) expect([mixed, onPersonsDevice(mixed, true)]).toStrictEqual([mixed, false]);
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
  await kolab.createNode(t.accessToken, 'spec', 'Orders', 'orders');

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

test('a refresh token is used once: again before its successor is used, for up to refreshRetryS, it gets the same answer while that is still the grant\'s, refused otherwise; again after its successor is used, or later, is a replay, which revokes the grant and ends its session', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice');
  const { actor } = await kolab.signInWith(github('8', 'ann'));
  await kolab.grant('test', actor, 'write');
  expect(kolab.oauth.refreshRetryS).toBe(120);
  const signIn = async () => {
    const a = await authorized(kolab, actor, { as: { kind: 'self' }, kolab: 'test', role: 'engineer' });
    return { a, t: await a.tokens() };
  };
  const ended: string[] = [];
  kolab.onEvent((e) => { if ('session' in e) ended.push(e.id); });
  const usedAgo = (token: string, s: number) => kolab.db.query(`update oauth_refresh_token set used_at = now() - make_interval(secs => $2) where key = $1`, [sessionKey(token), s]);

  const { a, t } = await signIn();
  const r1 = await kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client });
  // Another client can't use it.
  expect(await rejection(kolab.refreshGrant({ refreshToken: r1.refreshToken, clientId: 'kjcl_someoneelse0000000000' }))).toMatch(/invalid|unknown/);
  // Again at once (its answer lost on the way, or a concurrent request): the same answer, nothing revoked and nothing new.
  const again = await kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client });
  expect([again.accessToken, again.refreshToken, again.session, again.scope]).toStrictEqual([r1.accessToken, r1.refreshToken, r1.session, r1.scope]);
  expect(again.expiresIn).toBeGreaterThan(0);
  expect(again.expiresIn).toBeLessThanOrEqual(900);
  // A phone whose network dropped, the successor still unused: the same answer, up to the bound.
  await usedAgo(t.refreshToken, 100);
  const later = await kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client });
  expect([later.accessToken, later.refreshToken]).toStrictEqual([r1.accessToken, r1.refreshToken]);
  expect(await kolab.sessionOpen(r1.accessToken)).toBe(true);
  // What it keeps to answer the same is sealed: no token is in the database as written.
  const rows = JSON.stringify((await kolab.db.query(`select * from oauth_refresh_token`)).rows);
  for (const secret of [r1.accessToken, r1.refreshToken]) expect(rows).not.toContain(secret);
  expect((await kolab.db.query<{ n: number }>(`select count(*)::int as n from oauth_refresh_token where successor is not null`)).rows[0].n).toBe(1);
  // A successor no longer the grant's live answer (its access token replaced) is never given out again, and revokes nothing.
  await kolab.db.query(`update session set token_key = $2 where id = $1`, [r1.session, sessionKey('kjs_replaced')]);
  expect(await rejection(kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client }))).toMatch(/invalid_grant|refresh token is unknown/);
  await kolab.db.query(`update session set token_key = $2 where id = $1`, [r1.session, sessionKey(r1.accessToken)]);
  expect(await kolab.sessionOpen(r1.accessToken)).toBe(true);
  // A sealed answer tampered with, or moved to another row, opens nothing: refused, nothing revoked.
  const sealed = (await kolab.db.query<{ successor: string }>(`select successor from oauth_refresh_token where key = $1`, [sessionKey(t.refreshToken)])).rows[0].successor;
  const [v, iv, body, tag] = sealed.split('.');
  const flipped = Buffer.from(body, 'base64url');
  flipped[0] ^= 1;
  for (const bad of [`${v}.${iv}.${flipped.toString('base64url')}.${tag}`, `${v}.${iv}.${body}.${Buffer.from(tag, 'base64url').subarray(0, 12).toString('base64url')}`, `${v}.${iv}.${body}`, `${sealed}.x`]) {
    await kolab.db.query(`update oauth_refresh_token set successor = $2 where key = $1`, [sessionKey(t.refreshToken), bad]);
    expect(await rejection(kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client }))).toMatch(/invalid_grant|refresh token is unknown/);
  }
  expect(await kolab.sessionOpen(r1.accessToken)).toBe(true);
  // Another row's sealed answer, copied into a used token's row, opens nothing there either.
  const other = await signIn();
  const o1 = await kolab.refreshGrant({ refreshToken: other.t.refreshToken, clientId: other.a.client });
  await kolab.db.query(`update oauth_refresh_token set successor = $2 where key = $1`, [sessionKey(other.t.refreshToken), sealed]);
  expect(await rejection(kolab.refreshGrant({ refreshToken: other.t.refreshToken, clientId: other.a.client }))).toMatch(/invalid_grant|refresh token is unknown/);
  expect(await kolab.sessionOpen(o1.accessToken)).toBe(true);
  await kolab.db.query(`update oauth_refresh_token set successor = $2 where key = $1`, [sessionKey(t.refreshToken), sealed]);
  expect((await kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client })).refreshToken).toBe(r1.refreshToken);
  expect(ended).toStrictEqual([]);

  // Once its successor is used in turn, the first token again is a replay: the grant is revoked, and its session ends.
  const r2 = await kolab.refreshGrant({ refreshToken: r1.refreshToken, clientId: a.client });
  expect(await kolab.sessionOpen(r2.accessToken)).toBe(true);
  expect(await rejection(kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client }))).toMatch(/OAuthGrantError/);
  expect(await kolab.sessionOpen(r2.accessToken)).toBe(false);
  expect(ended).toStrictEqual([t.session]);
  expect(await rejection(kolab.refreshGrant({ refreshToken: r2.refreshToken, clientId: a.client }))).toMatch(/revoked|unknown/);

  // The successor's access token presented in a request: the successor is in use, and a retry of the refresh before it is a replay.
  const u = await signIn();
  const u1 = await kolab.refreshGrant({ refreshToken: u.t.refreshToken, clientId: u.a.client });
  expect((await kolab.refreshGrant({ refreshToken: u.t.refreshToken, clientId: u.a.client })).accessToken).toBe(u1.accessToken);
  expect(await kolab.liveSession(u1.accessToken)).toMatchObject({ granted: true });
  expect((await kolab.db.query<{ n: number }>(`select count(*)::int as n from oauth_refresh_token where grant_id = (select grant_id from oauth_refresh_token where key = $1) and successor is not null`, [sessionKey(u.t.refreshToken)])).rows[0].n).toBe(0);
  expect(await rejection(kolab.refreshGrant({ refreshToken: u.t.refreshToken, clientId: u.a.client }))).toMatch(/OAuthGrantError/);
  expect(await kolab.sessionOpen(u1.accessToken)).toBe(false);
  // So does any engine call made with it.
  const w = await signIn();
  const w1 = await kolab.refreshGrant({ refreshToken: w.t.refreshToken, clientId: w.a.client });
  await kolab.sessionInfo(w1.accessToken);
  expect(await rejection(kolab.refreshGrant({ refreshToken: w.t.refreshToken, clientId: w.a.client }))).toMatch(/OAuthGrantError/);
  expect(await kolab.sessionOpen(w1.accessToken)).toBe(false);

  // Past the bound, the successor still unused: a replay too.
  const b = await signIn();
  const b1 = await kolab.refreshGrant({ refreshToken: b.t.refreshToken, clientId: b.a.client });
  await usedAgo(b.t.refreshToken, kolab.oauth.refreshRetryS + 1);
  expect(await rejection(kolab.refreshGrant({ refreshToken: b.t.refreshToken, clientId: b.a.client }))).toMatch(/OAuthGrantError/);
  expect(await kolab.sessionOpen(b1.accessToken)).toBe(false);
  expect(ended).toStrictEqual([t.session, u.t.session, w.t.session, b.t.session]);
  expect(await rejection(kolab.refreshGrant({ refreshToken: b1.refreshToken, clientId: b.a.client }))).toMatch(/revoked|unknown/);
});

test('a request with the access token from before a refresh, checked as the refresh commits, clears nothing the refresh sealed: its lost answer\'s retry still gets the same answer', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice');
  const { actor } = await kolab.signInWith(github('8', 'ann'));
  await kolab.grant('test', actor, 'write');
  const a = await authorized(kolab, actor, { as: { kind: 'self' }, kolab: 'test', role: 'engineer' });
  const t = await a.tokens();
  // A request with A1 passes its check; then, before its seals are cleared, the refresh R1 -> A2/R2 commits and seals R1.
  const query = kolab.db.query.bind(kolab.db);
  let r1: Awaited<ReturnType<typeof kolab.refreshGrant>> | undefined;
  kolab.db.query = (async (sql: string, params?: unknown[]) => {
    if (!r1 && /set successor = null\s+where t\.grant_id/.test(sql)) r1 = await kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client });
    return query(sql, params);
  }) as typeof kolab.db.query;
  expect(await kolab.liveSession(t.accessToken)).toMatchObject({ granted: true });
  kolab.db.query = query;
  expect(r1).toBeDefined();
  // R1's seal survived the stale request: the retry is the same answer, nothing revoked.
  expect((await kolab.db.query<{ successor: string | null }>(`select successor from oauth_refresh_token where key = $1`, [sessionKey(t.refreshToken)])).rows[0].successor).not.toBeNull();
  const again = await kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client });
  expect([again.accessToken, again.refreshToken]).toStrictEqual([r1!.accessToken, r1!.refreshToken]);
  expect(await kolab.sessionOpen(r1!.accessToken)).toBe(true);
  // The new access token's own use clears it, and a retry after that is a replay.
  await kolab.liveSession(r1!.accessToken);
  expect(await rejection(kolab.refreshGrant({ refreshToken: t.refreshToken, clientId: a.client }))).toMatch(/OAuthGrantError/);
  expect(await kolab.sessionOpen(r1!.accessToken)).toBe(false);
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

test('whoever takes a name first keeps it: a person lee-claude who signed up before lee stays a person, and lee\'s label claude is refused', async () => {
  const kolab = await openKolab();
  expect(await kolab.signInWith(github('31', 'lee-claude'))).toStrictEqual({ actor: 'lee-claude', created: true });   // no lee yet
  expect(await kolab.signInWith(github('32', 'lee'))).toStrictEqual({ actor: 'lee', created: true });
  expect(await kolab.actor('lee-claude')).toMatchObject({ kind: 'person', owner: null });   // shown as a person, never as lee's agent
  expect(await rejection(kolab.addOwnAgent('lee', 'claude'))).toMatch(/lee-claude is a person here, not an agent of yours: choose another label/);
  await kolab.addOrganization('lee-bots');
  expect(await rejection(kolab.addOwnAgent('lee', 'bots'))).toMatch(/lee-bots is an organization here/);
  expect(await kolab.addOwnAgent('lee', 'pm')).toBe('lee-pm');
  // And now lee exists, a newcomer whose login reads as lee's agent doesn't take it.
  expect(await kolab.signInWith(github('33', 'lee-eng'))).toStrictEqual({ actor: 'gh_lee-eng', created: true });
});

test('D56 on every use: an agent holds nothing where its owner reads only by visibility, and loses its access, and session, when the owner\'s team grant goes', async () => {
  const kolab = await openKolab();
  const { actor: zoe } = await kolab.signInWith(github('40', 'zoe'));
  await kolab.addOrganization('acme');
  await kolab.addMember('acme', zoe);
  await kolab.addTeam('acme', 'devs');
  await kolab.addTeamMember('acme/devs', zoe);
  await kolab.createKolab('pub-app', { owner: 'acme', visibility: 'public' });
  await kolab.grant('pub-app', 'acme/devs', 'write');
  const t = await (await authorized(kolab, zoe, { as: { kind: 'new-agent', label: 'claude' }, kolab: 'pub-app', role: 'product' })).tokens();
  expect((await kolab.access('zoe-claude', 'pub-app')).level).toBe('write');
  const ended: string[] = [];
  kolab.onEvent((e) => { if ('session' in e) ended.push(e.id); });
  await kolab.revoke('pub-app', 'acme/devs');
  expect(await kolab.access(zoe, 'pub-app')).toStrictEqual({ level: 'read', layers: [] });   // public: she still reads it
  expect(await kolab.access('zoe-claude', 'pub-app')).toStrictEqual({ level: null, layers: [] });   // her agent, nothing
  expect(ended).toStrictEqual([t.session]);
  expect(await kolab.sessionOpen(t.accessToken)).toBe(false);
  // An admin's grant to an agent counts no more than its owner lends: nothing here.
  expect(await rejection(kolab.grant('pub-app', 'zoe-claude', 'read'))).toMatch(/holds no access/);

  // A plain member of the owning organization, of a public kolab with no base permission, reads it only by its visibility.
  await kolab.createKolab('pub2', { owner: 'acme', visibility: 'public' });
  expect(await rejection(authorized(kolab, zoe, { as: { kind: 'agent', agent: 'zoe-claude' }, kolab: 'pub2', role: 'product' }))).toMatch(/only because it is public/);
  expect((await kolab.db.query(`select 1 from kolab_grant where kolab_id = 'pub2'`)).rows).toStrictEqual([]);
  // An internal kolab she reads as a member, through the organization: her agent may read it too.
  await kolab.createKolab('inside', { owner: 'acme', visibility: 'internal' });
  const inside = await (await authorized(kolab, zoe, { as: { kind: 'agent', agent: 'zoe-claude' }, kolab: 'inside', role: 'product' })).tokens();
  expect((await kolab.sessionInfo(inside.accessToken)).access).toStrictEqual({ level: 'read', layers: [] });
});

(onPostgres ? test : test.skip)('two Kolab processes at once: the agent cap and rate, and the kolab cap, hold in the database', async () => {
  const store = await persistentStore();
  const a = await openKolab(store);
  const b = await openKolab(store);
  const { actor } = await a.signInWith(github('50', 'par'));
  a.oauth.agentsPerPerson = b.oauth.agentsPerPerson = 10;
  const agents = await Promise.allSettled(['a', 'b', 'c', 'd', 'e', 'f'].map((l, i) => (i % 2 ? a : b).addOwnAgent(actor, l)));
  expect(agents.filter((x) => x.status === 'fulfilled').length).toBe(3);   // 3 in 10 minutes, across both
  expect((await a.listActors({ owner: actor })).length).toBe(3);
  a.ownKolabs.max = b.ownKolabs.max = 2;
  a.ownKolabs.burst = b.ownKolabs.burst = 100;
  const kolabs = await Promise.allSettled(['k1', 'k2', 'k3', 'k4'].map((n, i) => (i % 2 ? a : b).makeOwnKolab(actor, `par-${n}`, n)));
  expect(kolabs.filter((x) => x.status === 'fulfilled').length).toBe(2);
  a.ownKolabs.burst = b.ownKolabs.burst = 1;
  a.ownKolabs.max = b.ownKolabs.max = 10;
  expect(await rejection(b.makeOwnKolab(actor, 'par-k5', 'k5'))).toMatch(/wait a while/);
  // One consent form, submitted to both at once, makes one thing.
  const client = (await a.registerClient({ redirectUris: ['http://127.0.0.1:9/cb'] })).id;
  a.ownKolabs.burst = b.ownKolabs.burst = 100;
  const { binding, state } = await a.beginAuthorization({ provider: 'github', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256('v'.repeat(43)) });
  const { csrf } = await a.identifyAuthorization(binding, state, actor);
  const tries = await Promise.allSettled([a, b, a, b].map((k, i) => k.consent(binding, csrf, { as: { kind: 'self' }, kolab: { name: `par-c${i}`, title: 'c' }, role: 'product' })));
  expect(tries.filter((x) => x.status === 'fulfilled').length).toBe(1);
});

// ---- a person's own session makes its agents up front (D59, W3.7) ----

test('createOwnAgent: a person\'s session makes <person>-<label>, and finds it again rather than make it twice; it grants nothing', async () => {
  const kolab = await openKolab();
  const { actor: ann } = await kolab.signInWith(github('70', 'ann'));
  await kolab.makeOwnKolab(ann, 'anns', 'Ann\'s');
  const s = await kolab.openSession(ann, 'product', { kolab: 'anns' });
  expect(await kolab.createOwnAgent(s, 'product')).toStrictEqual({ agent: 'ann-product', created: true, owner: 'ann' });
  expect(await kolab.createOwnAgent(s, 'product')).toStrictEqual({ agent: 'ann-product', created: false, owner: 'ann' });
  expect(await kolab.actor('ann-product')).toMatchObject({ kind: 'agent', owner: 'ann' });
  // Its access comes at consent, capped by its owner's (D30): none yet.
  expect((await kolab.access('ann-product', 'anns')).level).toBeNull();
  expect((await kolab.createOwnAgent(s, 'engineer')).created).toBe(true);
  expect((await kolab.createOwnAgent(s, 'engineer')).created).toBe(false);
  expect((await kolab.listActors({ owner: ann })).map((a) => a.id)).toStrictEqual(['ann-engineer', 'ann-product']);
});

test('createOwnAgent refuses an agent\'s session, a bad label, a name someone else holds, and an archived agent of yours, and another account\'s namespace; keeps D56\'s limits, the cap on live agents only; archiveOwnAgent frees a place', async () => {
  const kolab = await openKolab();
  const { actor: ann } = await kolab.signInWith(github('71', 'ann'));
  await kolab.makeOwnKolab(ann, 'anns', 'Ann\'s');
  const s = await kolab.openSession(ann, 'product', { kolab: 'anns' });
  // An agent's session makes no agents.
  const { agent } = await kolab.createOwnAgent(s, 'cli');
  await kolab.grant('anns', agent, 'write', { layers: ['functional'] });
  const agentSession = await kolab.openSession(agent, 'product', { kolab: 'anns' });
  expect(await rejection(kolab.createOwnAgent(agentSession, 'more'))).toMatch(/AccessError: ann-cli is an agent: only a person makes agents/);
  expect(await rejection(kolab.archiveOwnAgent(agentSession, 'cli'))).toMatch(/only a person archives their agents/);
  // Labels: lowercase letters, digits and '-', at most 24.
  for (const bad of ['', 'Product', '-x', 'a b', 'x'.repeat(25), '../etc']) {
    expect(await rejection(kolab.createOwnAgent(s, bad))).toMatch(/isn't a valid agent label/);
  }
  // Not free: held by a person who signed up first, an organization, another account's agent, or a
  // case variant. One message whoever holds it, so the verb probes nothing.
  await kolab.addActor('ann-pm');
  await kolab.addOrganization('ann-bots');
  await kolab.addActor('ann-x', { owner: 'ann-bots' });
  await kolab.addActor('Ann-Up');
  for (const taken of ['pm', 'bots', 'x', 'up']) {
    expect(await rejection(kolab.createOwnAgent(s, taken))).toBe(`ActorError: the name ann-${taken} isn't available: choose another label`);
  }
  // Another account's namespace: ann-pm owns ann-pm-*, and ann-bots ann-bots-*, so ann can't squat them.
  for (const squat of ['pm-product', 'bots-engineer', 'PM-x'.toLowerCase()]) {
    expect(await rejection(kolab.createOwnAgent(s, squat))).toBe(`ActorError: the name ann-${squat} isn't available: choose another label`);
  }
  // A label merely starting like another's is fine: ann-pmx isn't ann-pm's.
  expect((await kolab.createOwnAgent(s, 'pmx')).created).toBe(true);
  // Archived: refused, never brought back by reuse.
  await kolab.archive({ actor: 'ann-cli' });
  expect(await rejection(kolab.createOwnAgent(s, 'cli'))).toMatch(/your agent ann-cli is archived/);
  // At most 3 made in 10 minutes (ann-cli and ann-pmx were two), archived ones included.
  expect((await kolab.createOwnAgent(s, 'a')).created).toBe(true);
  expect(await rejection(kolab.createOwnAgent(s, 'c'))).toMatch(/you made 3 agents in the last 10 minutes/);
  // Reusing one already made still works at the limit.
  expect(await kolab.createOwnAgent(s, 'a')).toStrictEqual({ agent: 'ann-a', created: false, owner: 'ann' });
  // The cap counts live agents only: ann-pmx and ann-a, with ann-cli archived.
  await kolab.db.query(`update actor set created_at = now() - interval '1 hour' where owner_id = $1`, [ann]);
  kolab.oauth.agentsPerPerson = 2;
  expect(await rejection(kolab.createOwnAgent(s, 'c'))).toMatch(/^ActorError: you have 2 live agents, the most a person may have here \(2\)\. Yours, least recently used first \(dates UTC\): .*\. Archive one you no longer use \(konjir archive_agent label=<label>\)$/);
  // Archiving one of hers frees its place; its sessions end; its name stays hers, archived.
  const pmx = await kolab.openSession('ann-pmx', 'product', { kolab: 'anns' }).catch(() => undefined);
  expect(await kolab.archiveOwnAgent(s, 'pmx')).toMatchObject({ archived: 'ann-pmx' });
  if (pmx) expect(await kolab.sessionOpen(pmx)).toBe(false);
  expect((await kolab.createOwnAgent(s, 'c')).created).toBe(true);
  expect(await rejection(kolab.createOwnAgent(s, 'pmx'))).toMatch(/your agent ann-pmx is archived/);
  // Only her own live agents, and only as a person: the rest refused alike.
  for (const label of ['pmx', 'nobody', 'pm', 'x', 'Bad']) expect(await rejection(kolab.archiveOwnAgent(s, label))).toMatch(/you have no live agent ann-/);
});

test('listOwnAgents (D106): a person\'s agents, when each was made and last used Kolab, its kolabs and access, whether a session is open, archived ones only when asked; and the refusal at the cap names the live ones, least recently used first, those signed in now last', async () => {
  const kolab = await openKolab();
  const { actor: ann } = await kolab.signInWith(github('75', 'ann'));
  await kolab.makeOwnKolab(ann, 'anns', 'Ann\'s');
  await kolab.makeOwnKolab(ann, 'old', 'Old');
  const s = await kolab.openSession(ann, 'product', { kolab: 'anns' });
  for (const label of ['pm', 'eng', 'qa']) await kolab.createOwnAgent(s, label);
  // An agent of hers whose name doesn't start ann-, as Konjir's admin may add one.
  await kolab.addActor('bot', { owner: ann });
  await kolab.db.query(`update actor set created_at = timestamptz '2026-10-01T00:00:00Z' where owner_id = $1`, [ann]);
  await kolab.grant('anns', 'ann-pm', 'write', { layers: ['functional'] });
  await kolab.grant('anns', 'ann-eng', 'write', { layers: ['functional', 'technical'] });
  // A grant that gives nothing now (its kolab archived) isn't listed.
  await kolab.grant('old', 'ann-qa', 'read');
  await kolab.archive({ kolab: 'old' }, { by: 'kolab' });
  // ann-pm works now; ann-eng worked a while ago, its session ended; ann-qa and bot never have.
  await kolab.openSession('ann-pm', 'product', { kolab: 'anns' });
  await kolab.endSession(await kolab.openSession('ann-eng', 'engineer', { kolab: 'anns' }));
  await kolab.db.query(`update session set started_at = timestamptz '2026-10-25T12:00:00Z' where actor_id = 'ann-eng'`);

  const listed = await kolab.listOwnAgents(s);
  const made = '2026-10-01T00:00:00.000Z';
  expect(listed).toStrictEqual({
    agents: [
      { agent: 'ann-eng', label: 'eng', archive_with: 'label=eng', made, last_used: '2026-10-25T12:00:00.000Z', kolabs: [{ kolab: 'anns', access: { level: 'write', layers: ['functional', 'technical'] } }], session_open: false, archived: false },
      { agent: 'ann-pm', label: 'pm', archive_with: 'label=pm', made, last_used: expect.any(String), kolabs: [{ kolab: 'anns', access: { level: 'write', layers: ['functional'] } }], session_open: true, archived: false },
      { agent: 'ann-qa', label: 'qa', archive_with: 'label=qa', made, last_used: null, kolabs: [], session_open: false, archived: false },
      { agent: 'bot', label: null, archive_with: 'agent=bot', made, last_used: null, kolabs: [], session_open: false, archived: false },
    ],
    live: 4, limit: 10,
  });
  expect(Date.now() - Date.parse(listed.agents[1].last_used!)).toBeLessThan(60_000);
  // The latest of its sessions opening and its grant being issued or renewed, which sets the
  // grant's expiry to then plus the refresh token's life.
  await kolab.db.query(`update session set started_at = timestamptz '2026-10-20T08:00:00Z' where actor_id = 'ann-pm'`);
  expect((await kolab.listOwnAgents(s)).agents[1].last_used).toBe('2026-10-20T08:00:00.000Z');
  await kolab.db.query(`insert into oauth_grant(id, client_id, actor_id, person_id, scope, created_at, expires_at)
                        values ('${'g'.repeat(22)}', 'kjcl_${'c'.repeat(22)}', 'ann-eng', $1, 'konjir', timestamptz '2026-10-24T00:00:00Z',
                                timestamptz '2026-10-27T09:30:00Z' + $2 * interval '1 second')`, [ann, kolab.oauth.refreshTtlS]);
  expect((await kolab.listOwnAgents(s)).agents[0].last_used).toBe('2026-10-27T09:30:00.000Z');

  // At the cap, the refusal names them: never used first, then by last use, and those signed in
  // now last, whatever their dates (ann-pm's session opened on the 20th); then how to archive one.
  kolab.oauth.agentsPerPerson = 4;
  expect(await rejection(kolab.createOwnAgent(s, 'more'))).toBe('ActorError: you have 4 live agents, the most a person may have here (4). '
    + 'Yours, least recently used first (dates UTC): qa (never used), agent=bot (never used), eng (last used 2026-10-27), pm (signed in now). '
    + 'Archive one you no longer use (konjir archive_agent label=<label>, or agent=<name> for one shown so)');

  // Archived, by label or by whole name: left out, and out of live, unless asked for.
  await kolab.archiveOwnAgent(s, { label: 'qa' });
  await kolab.archiveOwnAgent(s, { agent: 'bot' });
  const after = await kolab.listOwnAgents(s);
  expect([after.agents.map((a) => a.agent), after.live]).toStrictEqual([['ann-eng', 'ann-pm'], 2]);
  const all = await kolab.listOwnAgents(s, { archived: true });
  expect(all.agents.map((a) => [a.agent, a.archived])).toStrictEqual([['ann-eng', false], ['ann-pm', false], ['ann-qa', true], ['bot', true]]);
  expect(all.live).toBe(2);
  // By whole name, only a live agent of hers: anyone else's, or none, refused alike; and label or agent, one.
  const { actor: bob } = await kolab.signInWith(github('76', 'bob'));
  await kolab.makeOwnKolab(bob, 'bobs', 'Bob\'s');
  await kolab.addActor('bob-x', { owner: bob });
  for (const agent of ['bob-x', 'bob', 'bot', 'nobody', 'ann-qa']) expect(await rejection(kolab.archiveOwnAgent(s, { agent }))).toBe(`ActorError: you have no live agent ${agent}`);
  expect(await rejection(kolab.archiveOwnAgent(s, { label: 'eng', agent: 'ann-eng' }))).toMatch(/by label=<label> or agent=<name>, one of them/);
  expect(await rejection(kolab.archiveOwnAgent(s, {}))).toMatch(/by label=<label> or agent=<name>, one of them/);

  // Only a person's own session: an agent's lists nothing, and another person sees only their own.
  const engSession = await kolab.openSession('ann-eng', 'engineer', { kolab: 'anns' });
  expect(await rejection(kolab.listOwnAgents(engSession))).toBe('AccessError: ann-eng is an agent: only a person lists their agents. Sign in as yourself to list them');
  expect(await rejection(kolab.archiveOwnAgent(engSession, { agent: 'ann-pm' }))).toMatch(/AccessError: ann-eng is an agent: only a person archives their agents/);
  expect(await kolab.listOwnAgents(await kolab.openSession(bob, 'product', { kolab: 'bobs' }))).toMatchObject({ agents: [{ agent: 'bob-x', label: 'x', archive_with: 'label=x' }], live: 1, limit: 4 });
});

test('createOwnAgent at once: one label made once, whoever asks; distinct labels held to 3 in 10 minutes', async () => {
  const kolab = await openKolab();
  const { actor: ann } = await kolab.signInWith(github('73', 'ann'));
  await kolab.makeOwnKolab(ann, 'anns', 'Ann\'s');
  const s = await kolab.openSession(ann, 'product', { kolab: 'anns' });
  const same = await Promise.all([1, 2, 3, 4].map(() => kolab.createOwnAgent(s, 'product')));
  expect(same.map((r) => r.agent)).toStrictEqual(['ann-product', 'ann-product', 'ann-product', 'ann-product']);
  expect(same.filter((r) => r.created).length).toBe(1);
  const many = await Promise.allSettled(['a', 'b', 'c', 'd', 'e'].map((l) => kolab.createOwnAgent(s, l)));
  expect(many.filter((m) => m.status === 'fulfilled').length).toBe(2);
  expect((await kolab.listActors({ owner: ann })).length).toBe(3);
});

(onPostgres ? test : test.skip)('createOwnAgent from two Kolab processes at once, on Postgres: the cap, the rate and reuse hold in the database', async () => {
  const store = await persistentStore();
  const a = await openKolab(store);
  const b = await openKolab(store);
  const { actor } = await a.signInWith(github('74', 'pia'));
  await a.makeOwnKolab(actor, 'pias', 'Pia\'s');
  const s = await a.openSession(actor, 'product', { kolab: 'pias' });
  const same = await Promise.all([a, b, a, b].map((k) => k.createOwnAgent(s, 'product')));
  expect(new Set(same.map((r) => r.agent))).toStrictEqual(new Set(['pia-product']));
  expect(same.filter((r) => r.created).length).toBe(1);
  const many = await Promise.allSettled(['a', 'b', 'c', 'd', 'e', 'f'].map((l, i) => (i % 2 ? a : b).createOwnAgent(s, l)));
  expect(many.filter((m) => m.status === 'fulfilled').length).toBe(2);   // 3 in 10 minutes in all, pia-product included
  expect((await b.listActors({ owner: actor })).length).toBe(3);
  await a.db.query(`update actor set created_at = now() - interval '1 hour' where owner_id = $1`, [actor]);
  a.oauth.agentsPerPerson = b.oauth.agentsPerPerson = 4;
  const capped = await Promise.allSettled(['g', 'h', 'i'].map((l, i) => (i % 2 ? a : b).createOwnAgent(s, l)));
  expect(capped.filter((m) => m.status === 'fulfilled').length).toBe(1);
  expect((await a.listActors({ owner: actor })).length).toBe(4);
});

/** A sign-in sent to Apple, whose answer names `subject`, an account new to Kolab: it waits for a username (awaitUsername). */
async function awaitingUsername(kolab: Kolab, subject: string) {
  const client = (await kolab.registerClient({ name: 'Test client', redirectUris: ['http://127.0.0.1:9/cb'] })).id;
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await kolab.beginAuthorization({ provider: 'apple', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256(verifier), clientState: 'xyz' });
  expect(await kolab.signInKnown({ provider: 'apple', subject })).toBeUndefined();
  const { csrf } = await kolab.awaitUsername(binding, state, subject);
  return { binding, state, csrf, client, verifier };
}

const APPLE_SUB = '001234.0123456789abcdef0123456789abcdef.1234';

test('Sign in with Apple: a first sign-in names no one until its person chooses a username; then that person is made, by that name, and found again by Apple\'s id alone', async () => {
  const kolab = await openKolab();
  const w = await awaitingUsername(kolab, APPLE_SUB);
  expect(await kolab.pendingAuthorization(w.binding)).toMatchObject({ provider: 'apple', person: null, choosingUsername: true });
  // Nothing to consent to meanwhile, and the provider's answer counts once.
  expect(await rejection(kolab.consent(w.binding, w.csrf, { as: { kind: 'self' }, kolab: { name: 'x', title: 'x' }, role: 'product' }))).toBeTruthy();
  expect(await rejection(kolab.awaitUsername(w.binding, w.state, APPLE_SUB))).toMatch(/expired, was already used/);
  expect(await rejection(kolab.identifyAuthorization(w.binding, w.state, 'anyone'))).toMatch(/expired, was already used/);
  // Another browser's form token is no good.
  expect(await rejection(kolab.chooseUsername(w.binding, 'x'.repeat(43), 'ada'))).toMatch(/expired, was already used/);

  const made = await kolab.chooseUsername(w.binding, w.csrf, ' @Ada-L ');
  // The form's token stays the sign-in's, for its consent form too.
  expect(made).toStrictEqual({ actor: 'ada-l', created: true, csrf: w.csrf });
  expect(await kolab.actor('ada-l')).toMatchObject({ kind: 'person', name: 'ada-l', owner: null });
  expect(await kolab.identities('ada-l')).toStrictEqual([{ provider: 'apple', subject: APPLE_SUB, login: 'ada-l' }]);
  expect(await kolab.pendingAuthorization(w.binding)).toMatchObject({ person: 'ada-l', choosingUsername: false });
  // The same form posted again (Continue pressed twice, or Back and Continue) names whoever it made, whatever name it carries.
  expect(await kolab.chooseUsername(w.binding, w.csrf, 'ada2')).toStrictEqual({ actor: 'ada-l', created: false, csrf: w.csrf });
  expect((await kolab.db.query(`select id from actor where id = 'ada2'`)).rows).toStrictEqual([]);
  const { code } = await kolab.consent(w.binding, made.csrf, { as: { kind: 'self' }, kolab: { name: 'adas', title: 'Ada\'s' }, role: 'product' });
  // Once consented to, the sign-in is spent: its form names no one again.
  expect(await rejection(kolab.chooseUsername(w.binding, w.csrf, 'ada-l'))).toMatch(/expired, was already used/);
  const t = await kolab.exchangeCode({ code, clientId: w.client, redirectUri: 'http://127.0.0.1:9/cb', codeVerifier: w.verifier });
  expect(t).toMatchObject({ actor: 'ada-l', kolab: 'adas' });

  // Signing in again: Apple's id alone finds them, with no username to choose.
  expect(await kolab.signInKnown({ provider: 'apple', subject: APPLE_SUB })).toBe('ada-l');
  // An archived person doesn't sign in.
  await kolab.archive({ actor: 'ada-l' });
  await expect(kolab.signInKnown({ provider: 'apple', subject: APPLE_SUB })).rejects.toThrow(ArchivedSignInError);
  expect(await rejection(kolab.signInKnown({ provider: 'apple', subject: APPLE_SUB }))).toMatch(/ada-l is archived/);
});

test('a person archived while their username page is open: Continue stops, ArchivedSignInError (an ActorError), whether the page was posted before or not', async () => {
  const kolab = await openKolab();
  // The same Apple account, its username page open in two tabs: one makes zoe, who is archived.
  const one = await awaitingUsername(kolab, APPLE_SUB);
  const two = await awaitingUsername(kolab, APPLE_SUB);
  expect(await kolab.chooseUsername(one.binding, one.csrf, 'zoe')).toMatchObject({ actor: 'zoe', created: true });
  await kolab.archive({ actor: 'zoe' });
  for (const w of [two, one]) {
    const e = await kolab.chooseUsername(w.binding, w.csrf, 'zed').then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ArchivedSignInError);
    expect(e).toBeInstanceOf(ActorError);
    expect([(e as Error).name, (e as Error).message]).toStrictEqual(['ActorError', 'zoe is archived, so it can\'t sign in; an admin can unarchive it']);
  }
  expect(await kolab.pendingAuthorization(two.binding)).toMatchObject({ person: null, choosingUsername: true });
});

test('with GitHub\'s sign-in on this Kolab, a username chosen at an Apple sign-up is never a GitHub account\'s, in any case; a name GitHub can\'t be asked about is refused too, and the same form tries again', async () => {
  const kolab = await openKolab();
  const accounts = new Map([['octocat', { subject: '583231', login: 'octocat', person: true }], ['acme-inc', { subject: '9', login: 'Acme-Inc', person: false }]]);
  let down = false;
  const asked: string[] = [];
  const find = async (login: string) => {
    asked.push(login);
    if (down) throw new Error('GitHub answered 503');
    return accounts.get(login.toLowerCase());
  };
  const w = await awaitingUsername(kolab, APPLE_SUB);
  for (const name of ['octocat', 'OctoCat', '@octocat']) {
    expect(await rejection(kolab.chooseUsername(w.binding, w.csrf, name, { github: find }))).toBe('ActorError: That is a GitHub username: to use it, sign in with GitHub.');
  }
  expect(await rejection(kolab.chooseUsername(w.binding, w.csrf, 'acme-inc', { github: find }))).toBe('ActorError: acme-inc is a GitHub organization\'s name: choose another username');
  // Asked lowercased, and only once Kolab's own checks pass: a name Kolab refuses itself isn't looked up.
  expect(asked).toStrictEqual(['octocat', 'octocat', 'octocat', 'acme-inc']);
  expect(await rejection(kolab.chooseUsername(w.binding, w.csrf, 'admin', { github: find }))).toMatch(/admin is reserved/);
  expect(asked).toHaveLength(4);
  // GitHub can't be asked: refused, never taken on trust.
  down = true;
  expect(await rejection(kolab.chooseUsername(w.binding, w.csrf, 'ada', { github: find }))).toBe('ActorError: Kolab couldn\'t check with GitHub whether ada is a GitHub username just now: try again in a minute');
  expect(await kolab.pendingAuthorization(w.binding)).toMatchObject({ person: null, choosingUsername: true });
  expect((await kolab.db.query(`select id from actor where id in ('octocat', 'ada')`)).rows).toStrictEqual([]);
  // A name GitHub doesn't have is free.
  down = false;
  expect(await kolab.chooseUsername(w.binding, w.csrf, 'ada', { github: find })).toMatchObject({ actor: 'ada', created: true });
  // octocat, signing up with GitHub later, is octocat.
  expect(await kolab.signInWith(github('583231', 'octocat'))).toStrictEqual({ actor: 'octocat', created: true });
});

/**
 * Two chooseUsername calls held at the GitHub lookup until both have reached it, so both pass every
 * check before either inserts: the second's insert then meets the first's row (a unique key).
 */
function barrier(n: number) {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return async () => { if (++arrived === n) open(); await opened; return undefined; };
}

test('Continue pressed twice at once makes the person once: the second post meets the first\'s username (account_pkey) and names the person the first made', async () => {
  const kolab = await openKolab();
  const w = await awaitingUsername(kolab, APPLE_SUB);
  const held = barrier(2);
  const [a, b] = await Promise.all([1, 2].map(() => kolab.chooseUsername(w.binding, w.csrf, 'gail', { github: held })));
  expect([a, b].map((r) => r.actor)).toStrictEqual(['gail', 'gail']);
  expect([a, b].map((r) => r.created).sort()).toStrictEqual([false, true]);
  expect([a.csrf, b.csrf]).toStrictEqual([w.csrf, w.csrf]);
  expect(await kolab.identities('gail')).toStrictEqual([{ provider: 'apple', subject: APPLE_SUB, login: 'gail' }]);
  expect(await kolab.pendingAuthorization(w.binding, { csrf: w.csrf })).toMatchObject({ person: 'gail', choosingUsername: false });
});

test('the same Apple account choosing two names in two tabs at once is one person (identity_pkey): the second names whoever the first made, and its name isn\'t made', async () => {
  const kolab = await openKolab();
  const one = await awaitingUsername(kolab, APPLE_SUB);
  const two = await awaitingUsername(kolab, APPLE_SUB);
  const held = barrier(2);
  const [a, b] = await Promise.all([kolab.chooseUsername(one.binding, one.csrf, 'hana', { github: held }), kolab.chooseUsername(two.binding, two.csrf, 'ivo', { github: held })]);
  expect(a.actor).toBe(b.actor);
  expect([a, b].map((r) => r.created).sort()).toStrictEqual([false, true]);
  const loser = a.actor === 'hana' ? 'ivo' : 'hana';
  expect((await kolab.db.query(`select id from actor where id = $1 union all select id from account where id = $1`, [loser])).rows).toStrictEqual([]);
  for (const w of [one, two]) expect(await kolab.pendingAuthorization(w.binding)).toMatchObject({ person: a.actor, choosingUsername: false });
});

test('a username chosen at an Apple sign-up never claims a name that is held, in any case, by a live or archived person, account or organization, nor a reserved one, nor one that reads as someone\'s agent; the same form tries again', async () => {
  const kolab = await openKolab();
  await kolab.addActor('alice');
  await kolab.addOrganization('acme');
  await kolab.addActor('bob');
  await kolab.archive({ actor: 'bob' });
  expect(await kolab.signInWith(github('2001', 'Carol'))).toStrictEqual({ actor: 'carol', created: true });
  const w = await awaitingUsername(kolab, APPLE_SUB);
  const refused: [string, RegExp][] = [
    ['alice', /the username alice is taken/], ['ALICE', /the username alice is taken/], ['acme', /the username acme is taken/], ['bob', /the username bob is taken/],
    ['carol', /the username carol is taken/], ['kolab', /kolab is reserved/], ['admin', /admin is reserved/], ['konjir-ann', /reserved/],
    ['alice-pm', /reads as an agent of alice's/], ['acme-ops', /reads as an agent of acme's/], ['carol-2', /reads as an agent of carol's/],
    ['a', /2 to 39/], ['-ab', /2 to 39/], ['ab-', /2 to 39/], ['a--b', /2 to 39/], ['a_b', /2 to 39/], ['a.b', /2 to 39/], ['x'.repeat(40), /2 to 39/], ['', /2 to 39/],
  ];
  for (const [name, why] of refused) {
    expect([name, await rejection(kolab.chooseUsername(w.binding, w.csrf, name))]).toStrictEqual([name, expect.stringMatching(why)]);
  }
  // Nothing was made or linked, and the sign-in still waits, with the same form.
  expect(await kolab.pendingAuthorization(w.binding)).toMatchObject({ person: null, choosingUsername: true });
  expect(await kolab.identities('alice')).toStrictEqual([]);
  expect(await kolab.identities('carol')).toStrictEqual([{ provider: 'github', subject: '2001', login: 'Carol' }]);
  expect(await kolab.chooseUsername(w.binding, w.csrf, 'dee')).toMatchObject({ actor: 'dee', created: true });
  // GitHub's dee, signing up later, is someone else: a variant, never the Apple person.
  expect(await kolab.signInWith(github('2002', 'dee'))).toStrictEqual({ actor: 'dee_2', created: true });
});

test('the same Apple account signing up in two tabs is one person: the second sign-in names whoever the first made, whatever name it chose', async () => {
  const kolab = await openKolab();
  const one = await awaitingUsername(kolab, APPLE_SUB);
  const two = await awaitingUsername(kolab, APPLE_SUB);
  expect(await kolab.chooseUsername(one.binding, one.csrf, 'erin')).toMatchObject({ actor: 'erin', created: true });
  expect(await kolab.chooseUsername(two.binding, two.csrf, 'frank')).toMatchObject({ actor: 'erin', created: false });
  expect((await kolab.db.query(`select id from actor where id = 'frank'`)).rows).toStrictEqual([]);
  expect(await kolab.pendingAuthorization(two.binding)).toMatchObject({ person: 'erin', choosingUsername: false });
});

test('a sign-in waiting for a username, restarted for another account, forgets the first account\'s id', async () => {
  const kolab = await openKolab();
  const w = await awaitingUsername(kolab, APPLE_SUB);
  const { state } = await kolab.restartIdentification(w.binding, w.csrf);
  expect(await kolab.pendingAuthorization(w.binding)).toMatchObject({ person: null, choosingUsername: false });
  expect((await kolab.db.query(`select pending_subject from oauth_request where id = $1`, [sessionKey(w.binding)])).rows).toStrictEqual([{ pending_subject: null }]);
  // The new state waits for the next answer, which may name another account.
  expect(await kolab.awaitUsername(w.binding, state, '000999.feed.0001')).toMatchObject({ csrf: expect.any(String) });
});
