// Sign in with Apple beside GitHub (Lee, 2026-11-23; Apple's guideline 4.8, for konnect's app):
// AppleIdentity against a fake Apple, with keys made here (its authorize URL, its client secret, its
// token exchange, and its id_token checks); and over HTTP, Kolab's sign-in page with a button for
// each provider, a first Apple sign-in choosing a username before anyone is made, a later one found
// by Apple's id alone, and the nonce binding a code to its own sign-in. Nothing reaches Apple.
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { closeAtEnd, openKolab } from '@konjir/engine/testing';
import { APPLE_ORIGIN, applePrivateKey } from '../src/oauth/identity.js';
import { NOTHING_TO_CHOOSE_UNINVITABLE } from '../src/oauth/oauth.controller.js';
import { AppleIdentity, StubIdentity, startServer } from '../src/server.js';

const SERVICES = 'com.konjir.kolab.signin';
const TEAM = '7Y8QD34KJQ';
const KEY_ID = 'ABCDE12345';
const FAKE = 'https://apple.test';
const CB = 'http://127.0.0.1:9/cb';
const APP = 'https://www.konjir.com/konnect/app/oauth';
const VERIFIER = 'v'.repeat(43);
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const SUB = '001234.0123456789abcdef0123456789abcdef.1234';

/** The team's Sign in with Apple key, as the .p8 file Apple gives: an EC P-256 private key, PKCS #8 PEM. */
const teamKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = teamKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

/** Apple's own signing keys, and one that isn't Apple's. */
const appleKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (k: KeyObject, kid: string) => ({ ...k.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' });

/** An id_token as Apple's token endpoint gives it, signed by `key` (Apple's by default); `claims` override its claims. */
function idToken(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'apple-1' })}.${b64({ iss: APPLE_ORIGIN, aud: SERVICES, iat: now, exp: now + 600, sub: SUB, auth_time: now, nonce_supported: true, ...claims })}`;
  return `${input}.${sign('sha256', Buffer.from(input), opts.key ?? appleKey.privateKey).toString('base64url')}`;
}

/** A fake Apple: its keys at /auth/keys, and its token endpoint answering with whatever `answer` gives, each call recorded. */
function fakeApple(answer: (form: URLSearchParams) => Response | Promise<Response>, keys = [jwk(appleKey.publicKey, 'apple-1')]) {
  const calls: { url: string; method: string; form?: URLSearchParams }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const form = init?.body ? new URLSearchParams(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', form });
    if (url === `${FAKE}/auth/keys`) return Response.json({ keys });
    if (url === `${FAKE}/auth/token`) return answer(form!);
    return new Response(null, { status: 404 });
  };
  return { fetch, calls };
}

const apple = (fetch: typeof globalThis.fetch, extra: { now?: () => number } = {}) =>
  new AppleIdentity({ servicesId: SERVICES, teamId: TEAM, keyId: KEY_ID, privateKey: P8, origin: FAKE, fetch, ...extra });

test('Apple: the authorize URL asks for no scope, so Apple answers with a GET, and carries the state and, as its nonce, the sign-in\'s PKCE challenge', () => {
  const idp = apple(fakeApple(() => new Response(null, { status: 500 })).fetch);
  const u = new URL(idp.authorizationUrl({ redirectUri: 'https://kolab.konjir.com/oauth/callback/apple', state: 'sid.st', codeChallenge: 'ch', prompt: 'select_account' }));
  expect(u.origin + u.pathname).toBe(`${FAKE}/auth/authorize`);
  expect(Object.fromEntries(u.searchParams)).toStrictEqual({
    client_id: SERVICES, redirect_uri: 'https://kolab.konjir.com/oauth/callback/apple', response_type: 'code', response_mode: 'query', state: 'sid.st', nonce: 'ch',
  });
  expect(idp.authorizationOrigin).toBe(FAKE);
  // In production, Apple's own origin, which the pages' form-action names.
  expect(new AppleIdentity({ servicesId: SERVICES, teamId: TEAM, keyId: KEY_ID, privateKey: P8 }).authorizationOrigin).toBe('https://appleid.apple.com');
  expect([idp.id, idp.label, 'lookup' in idp]).toStrictEqual(['apple', 'Apple', false]);
});

test('Apple: the client secret is an ES256 JWT the team\'s key signs, kid the key id, from the team for the Services ID to Apple, lasting five minutes', () => {
  const at = Date.parse('2026-11-23T12:00:00Z');
  const secret = apple(fakeApple(() => new Response(null)).fetch, { now: () => at }).clientSecret();
  const [h, b, sig] = secret.split('.');
  expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toStrictEqual({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  expect(JSON.parse(Buffer.from(b, 'base64url').toString())).toStrictEqual({ iss: TEAM, iat: at / 1000, exp: at / 1000 + 300, aud: 'https://appleid.apple.com', sub: SERVICES });
  // r and s, 32 bytes each, as JOSE writes ES256; it verifies with the key's public half.
  expect(Buffer.from(sig, 'base64url')).toHaveLength(64);
  expect(verify('sha256', Buffer.from(`${h}.${b}`), { key: teamKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
});

test('Apple: the code is exchanged with a fresh client secret, and who signed in is the id_token\'s sub, once its signature, issuer, audience, expiry and nonce check out; Apple\'s tokens go no further', async () => {
  const nonce = s256(VERIFIER);
  const { fetch, calls } = fakeApple(() => Response.json({ access_token: 'a.secret', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r.secret', id_token: idToken({ nonce }) }));
  const idp = apple(fetch);
  expect(await idp.identify({ code: 'c0de', redirectUri: 'https://kolab.konjir.com/oauth/callback/apple', codeVerifier: VERIFIER })).toStrictEqual({ subject: SUB });
  const token = calls.find((c) => c.url === `${FAKE}/auth/token`)!;
  expect(token.method).toBe('POST');
  expect([...token.form!.keys()].sort()).toStrictEqual(['client_id', 'client_secret', 'code', 'grant_type', 'redirect_uri']);
  expect(Object.fromEntries([...token.form!].filter(([k]) => k !== 'client_secret'))).toStrictEqual({ client_id: SERVICES, code: 'c0de', grant_type: 'authorization_code', redirect_uri: 'https://kolab.konjir.com/oauth/callback/apple' });
  expect(token.form!.get('client_secret')!.split('.')).toHaveLength(3);
  // Apple's keys once, then the token; nothing else is called, and nothing is revoked.
  expect(calls.map((c) => c.url)).toStrictEqual([`${FAKE}/auth/token`, `${FAKE}/auth/keys`]);
  await idp.identify({ code: 'again', redirectUri: 'r', codeVerifier: VERIFIER });
  expect(calls.filter((c) => c.url === `${FAKE}/auth/keys`)).toHaveLength(1);

  // Refused, saying so without the answer's body.
  const refusing = apple(fakeApple(() => Response.json({ error: 'invalid_grant' }, { status: 400 })).fetch);
  await expect(refusing.identify({ code: 'no', redirectUri: 'r', codeVerifier: VERIFIER })).rejects.toThrow(/^Apple didn't accept the sign-in \(invalid_grant\)$/);
  const noToken = apple(fakeApple(() => Response.json({ access_token: 'a.secret' })).fetch);
  await expect(noToken.identify({ code: 'no', redirectUri: 'r', codeVerifier: VERIFIER })).rejects.toThrow(/^Apple didn't accept the sign-in \(200\)$/);
});

test('Apple: an id_token that isn\'t Apple\'s, isn\'t for this Services ID, has expired, or isn\'t for this sign-in is refused, though it came from the token endpoint', async () => {
  const nonce = s256(VERIFIER);
  const now = Math.floor(Date.now() / 1000);
  const cases: [string, string, RegExp][] = [
    ['good', idToken({ nonce }), /^$/],
    ['bad signature', idToken({ nonce }, { key: otherKey.privateKey }), /isn't signed by Apple/],
    ['unknown key', idToken({ nonce }, { key: otherKey.privateKey, kid: 'not-apple' }), /isn't signed by Apple/],
    ['alg none', `${b64({ alg: 'none', kid: 'apple-1' })}.${b64({ iss: APPLE_ORIGIN, aud: SERVICES, exp: now + 600, sub: SUB, nonce })}.x`, /isn't signed RS256/],
    ['HS256', idToken({ nonce }, { alg: 'HS256' }), /isn't signed RS256/],
    ['wrong audience', idToken({ nonce, aud: 'com.someone.else' }), /isn't for this Services ID/],
    ['audience list', idToken({ nonce, aud: [SERVICES] }), /isn't for this Services ID/],
    ['wrong issuer', idToken({ nonce, iss: 'https://evil.example' }), /wasn't issued by Apple/],
    ['expired', idToken({ nonce, exp: now - 120 }), /expired/],
    ['no expiry', idToken({ nonce, exp: undefined }), /expired/],
    ['from the future', idToken({ nonce, iat: now + 3600 }), /issued in the future/],
    ['another sign-in\'s nonce', idToken({ nonce: s256('w'.repeat(43)) }), /isn't for this sign-in/],
    ['no nonce', idToken({}), /isn't for this sign-in/],
    ['unusable sub', idToken({ nonce, sub: 'a b' }), /names no usable account/],
    ['not a JWT', 'abc.def', /isn't a JWT/],
  ];
  for (const [what, token, why] of cases) {
    const idp = apple(fakeApple(() => Response.json({ id_token: token }), [jwk(appleKey.publicKey, 'apple-1')]).fetch);
    const got = await idp.identify({ code: 'c', redirectUri: 'r', codeVerifier: VERIFIER }).then(() => '', (e: Error) => e.message);
    expect([what, got]).toStrictEqual([what, expect.stringMatching(why)]);
    // An error never carries the token.
    expect(got).not.toContain(token.split('.')[2] ?? token);
  }
});

test('Apple: a key id Apple\'s keys don\'t name asks for them again, at most once a minute, so Apple\'s key rotation is picked up and a forged kid can\'t make Kolab hammer Apple', async () => {
  let t = Date.parse('2026-11-23T12:00:00Z');
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let keys = [jwk(appleKey.publicKey, 'apple-1')];
  let token = '';
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    calls.push(String(input));
    return String(input).endsWith('/auth/keys') ? Response.json({ keys }) : Response.json({ id_token: token });
  };
  const idp = apple(fetch, { now: () => t });
  const identify = () => idp.identify({ code: 'c', redirectUri: 'r', codeVerifier: VERIFIER }).then((w) => w.subject, (e: Error) => e.message);
  const nowS = () => Math.floor(t / 1000);
  token = idToken({ nonce: s256(VERIFIER), iat: nowS(), exp: nowS() + 600 });
  expect(await identify()).toBe(SUB);
  // Apple rotates to a key Kolab hasn't seen: asked for again at once, the cache being older than a minute.
  keys = [jwk(appleKey.publicKey, 'apple-1'), jwk(rotated.publicKey, 'apple-2')];
  t += 61_000;
  token = idToken({ nonce: s256(VERIFIER), iat: nowS(), exp: nowS() + 600 }, { key: rotated.privateKey, kid: 'apple-2' });
  expect(await identify()).toBe(SUB);
  const fetched = () => calls.filter((c) => c.endsWith('/auth/keys')).length;
  expect(fetched()).toBe(2);
  // A kid no one has: refused, and Apple asked again only once in the minute.
  token = idToken({ nonce: s256(VERIFIER), iat: nowS(), exp: nowS() + 600 }, { key: otherKey.privateKey, kid: 'forged' });
  for (let i = 0; i < 3; i++) expect(await identify()).toMatch(/isn't signed by Apple/);
  expect(fetched()).toBe(2);
});

test('Apple: its settings are checked when Kolab starts, the private key as the .p8 file, joined by \\n, or its body alone, and nothing else', () => {
  const body = P8.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
  for (const text of [P8, P8.replace(/\n/g, '\\n'), body]) expect(applePrivateKey(text).asymmetricKeyType).toBe('ec');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  expect(() => applePrivateKey(rsa)).toThrow(/isn't an EC P-256 key/);
  expect(() => applePrivateKey('not a key')).toThrow(/isn't a PEM private key/);
  const base = { servicesId: SERVICES, teamId: TEAM, keyId: KEY_ID, privateKey: P8 };
  expect(() => new AppleIdentity({ ...base, teamId: '7y8qd34kjq' })).toThrow(/team id is ten uppercase/);
  expect(() => new AppleIdentity({ ...base, keyId: 'short' })).toThrow(/key id is ten uppercase/);
  expect(() => new AppleIdentity({ ...base, servicesId: 'not a services id' })).toThrow(/reverse-DNS/);
  expect(() => new AppleIdentity({ ...base, privateKey: '' })).toThrow(/needs the Services ID, the team id, the key id and the private key/);
  // An error names what is wrong, never the key.
  try { applePrivateKey(`${body.slice(0, 40)}garbage`); } catch (e) { expect(String(e)).not.toContain(body.slice(0, 40)); }
});

// ---- over HTTP --------------------------------------------------------------------------------

/** A browser: cookies kept, Kolab's redirects followed, stopping at one that leaves it. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  async go(url: string | URL, init: RequestInit = {}): Promise<{ res: Response; html: string; left?: URL }> {
    let at = new URL(url, this.base);
    for (let i = 0; ; i++) {
      const res = await fetch(at, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string> | undefined), cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
      for (const c of res.headers.getSetCookie()) {
        const kv = c.split(';')[0];
        const name = kv.slice(0, kv.indexOf('='));
        if (/max-age=0/i.test(c)) this.cookies.delete(name); else this.cookies.set(name, kv.slice(kv.indexOf('=') + 1));
      }
      if (res.status < 300 || res.status >= 400 || i > 10) return { res, html: await res.text() };
      const next = new URL(res.headers.get('location')!, at);
      if (next.origin !== new URL(this.base).origin) return { res, html: '', left: next };
      at = next;
      init = {};
    }
  }
  /** Posts a form of Kolab's, as its page would: from Kolab's origin unless `origin` says otherwise. */
  post(path: string, fields: Record<string, string>, origin = this.base) {
    return this.go(path, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  }
}

const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? '';
const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];
const csp = (res: Response) => res.headers.get('content-security-policy') ?? '';
const hrefs = (html: string) => [...html.matchAll(/<a class="idp[^"]*" href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

/** Kolab with GitHub's stand-in and the real AppleIdentity against a fake Apple, which answers each code with the id_token `tokens` holds for it. */
async function serve(kolab: Kolab) {
  const github = new StubIdentity({ label: 'GitHub' });
  const tokens = new Map<string, string>();
  const fake = fakeApple((form) => {
    const t = tokens.get(form.get('code')!);
    return t ? Response.json({ access_token: 'a.x', id_token: t }) : Response.json({ error: 'invalid_grant' }, { status: 400 });
  });
  const appleIdp = apple(fake.fetch);
  const server = await startServer({ adminToken: 'admin-token', kolab, webRoot: null, identity: [github, appleIdp] });
  closeAtEnd(server);
  return { base: new URL(server.url).origin, github, tokens, calls: fake.calls };
}

async function register(base: string, redirectUris = [CB]) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'konnect', redirect_uris: redirectUris }) });
  return (await r.json() as { client_id: string }).client_id;
}

function authorize(base: string, client: string, opts: { scope?: string; redirect?: string } = {}) {
  const u = new URL('/oauth/authorize', base);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: client, redirect_uri: opts.redirect ?? CB, state: 'client-state', code_challenge: s256(VERIFIER), code_challenge_method: 'S256',
    resource: `${base}/mcp`, ...(opts.scope ? { scope: opts.scope } : {}),
  }).toString();
  return u;
}

/**
 * The person presses Sign in with Apple on Kolab's sign-in page and signs in there as `sub`: Apple
 * answers Kolab's callback with a code whose id_token carries the nonce Kolab asked for (or
 * `nonce`). Returns the page Kolab shows then.
 */
async function withApple(base: string, tokens: Map<string, string>, client: string, sub = SUB, opts: { scope?: string; redirect?: string; nonce?: string; browser?: Browser } = {}) {
  const browser = opts.browser ?? new Browser(base);
  const page = await browser.go(authorize(base, client, opts));
  expect(titleOf(page.html)).toBe('Sign in · Kolab');
  const toApple = await browser.go(hrefs(page.html)[0]);
  const at = toApple.left!;
  expect(at.origin + at.pathname).toBe(`${FAKE}/auth/authorize`);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  tokens.set(code, idToken({ sub, nonce: opts.nonce ?? at.searchParams.get('nonce') }));
  const back = new URL(at.searchParams.get('redirect_uri')!);
  back.search = new URLSearchParams({ code, state: at.searchParams.get('state')! }).toString();
  return { ...(await browser.go(back)), browser, at };
}

test('with GitHub and Apple, Kolab\'s sign-in page offers a button for each, Sign in with Apple first and as Apple draws it, each leading to its provider for the same request', async () => {
  const kolab = await openKolab();
  const { base } = await serve(kolab);
  const client = await register(base);
  const browser = new Browser(base);
  const page = await browser.go(authorize(base, client));
  expect(page.res.status).toBe(200);
  // Nothing started yet: no sign-in's cookie until a provider is chosen.
  expect(browser.cookies.size).toBe(0);
  expect(page.html).toContain('<strong>konnect</strong> asks to work in Kolab, and gets its answer at <code>http://127.0.0.1:9</code>.');
  expect(page.html).toMatch(/<a class="idp apple" href="[^"]+"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="[^"]+"\/><\/svg><span>Sign in with Apple<\/span><\/a>\n<a class="idp" href="[^"]+">Sign in with GitHub<\/a>/);
  // Apple's colors: white on the dark theme, black on the light, in the system font.
  expect(page.html).toContain('a.idp.apple{background:#fff;border-color:#fff;color:#000;font-family:-apple-system');
  expect(page.html).toContain('@media (prefers-color-scheme: light){a.idp.apple{background:#000;border-color:#000;color:#fff}}');
  // Links, not forms: the page's policy needs no provider's origin.
  expect(csp(page.res)).toContain('form-action \'self\';');
  const [toApple, toGitHub] = hrefs(page.html).map((h) => new URL(h, base));
  for (const [u, id] of [[toApple, 'apple'], [toGitHub, 'stub']] as const) {
    expect(u.pathname).toBe('/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toStrictEqual({ ...Object.fromEntries(authorize(base, client).searchParams), provider: id });
  }
  const apple = await browser.go(toApple);
  expect(apple.left!.origin).toBe(FAKE);
  expect(apple.left!.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(apple.left!.searchParams.get('redirect_uri')).toBe(`${base}/oauth/callback/apple`);
  // A provider Kolab doesn't have is no choice: the page again.
  expect(titleOf((await new Browser(base).go(`${authorize(base, client)}&provider=facebook`)).html)).toBe('Sign in · Kolab');
  // The web page's one button names both, and leads to this page.
  expect(await (await fetch(`${base}/api/session/methods`, { headers: { origin: base } })).json()).toStrictEqual({ provider: 'GitHub or Apple', token: false });
});

test('a first Sign in with Apple asks the person to choose a username, refuses one that is taken, then makes them and goes on to consent; the next finds them by Apple\'s id alone', async () => {
  const kolab = await openKolab();
  const { base, tokens, github } = await serve(kolab);
  // A GitHub person called zed is someone else, whom no Apple sign-in can reach by name.
  await kolab.signInWith({ provider: 'stub', subject: '77', login: 'zed' });
  const client = await register(base);

  const first = await withApple(base, tokens, client);
  expect(first.res.status).toBe(200);
  expect(titleOf(first.html)).toBe('Choose your username · Kolab');
  expect(first.html).toContain('Signed in with Apple. Welcome: you are new to Kolab.');
  expect(first.html).toContain('<form class="card" method="post" action="/oauth/username">');
  // Cancel leads back to the app, so the page names its redirect URI; nothing else.
  expect(csp(first.res)).toContain('form-action \'self\' http://127.0.0.1:9;');
  const form = { sign_in: field(first.html, 'sign_in'), csrf: field(first.html, 'csrf') };
  // No one is made yet, and nothing can be consented to.
  expect(await kolab.identities('zed')).toStrictEqual([{ provider: 'stub', subject: '77', login: 'zed' }]);
  expect((await first.browser.post('/oauth/consent', { ...form, decision: 'allow', as: 'self', kolab: '@new', new_kolab_name: 'x', role: 'product' })).res.status).toBe(400);
  // Only Kolab's own page chooses.
  expect((await first.browser.post('/oauth/username', { ...form, decision: 'choose', username: 'zara' }, 'https://evil.example')).res.status).toBe(403);
  // The provider's answer counts once.
  expect((await first.browser.go(new URL(`/oauth/callback/apple?code=again&state=${encodeURIComponent(first.at.searchParams.get('state')!)}`, base))).html).toMatch(/Apple&#39;s answer for this sign-in was already used/);

  const taken = await first.browser.post('/oauth/username', { ...form, decision: 'choose', username: 'Zed' });
  expect(taken.res.status).toBe(400);
  expect(taken.html).toContain('the username zed is taken: choose another');
  expect(field(taken.html, 'username')).toBe('Zed');
  expect(await kolab.identities('zed')).toStrictEqual([{ provider: 'stub', subject: '77', login: 'zed' }]);
  const agentLike = await first.browser.post('/oauth/username', { ...form, decision: 'choose', username: 'zed-bot' });
  expect(agentLike.html).toContain('zed-bot reads as an agent of zed&#39;s');

  const chosen = await first.browser.post('/oauth/username', { ...form, decision: 'choose', username: 'zara' });
  expect(chosen.res.status).toBe(200);
  expect(titleOf(chosen.html)).toBe('Sign in · Kolab');
  expect(chosen.html).toContain('Signed in with Apple as <code>zara</code>. Welcome: you are <code>zara</code> here, new to Kolab.');
  expect(await kolab.identities('zara')).toStrictEqual([{ provider: 'apple', subject: SUB, login: 'zara' }]);
  const done = await first.browser.post('/oauth/consent', { sign_in: field(chosen.html, 'sign_in'), csrf: field(chosen.html, 'csrf'), decision: 'allow', as: 'self', kolab: '@new', new_kolab_name: 'zaras', role: 'product' });
  expect(done.left!.origin + done.left!.pathname).toBe(CB);
  const t = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: done.left!.searchParams.get('code')!, client_id: client, redirect_uri: CB, code_verifier: VERIFIER }).toString() });
  expect(t.status).toBe(200);
  const { access_token } = await t.json() as { access_token: string };
  expect(await kolab.sessionOpen(access_token)).toBe(true);
  expect((await kolab.db.query(`select actor_id, kolab_id from session where actor_id = 'zara'`)).rows).toStrictEqual([{ actor_id: 'zara', kolab_id: 'zaras' }]);

  // Again: Apple's id alone finds zara, and there is no username to choose.
  const again = await withApple(base, tokens, client);
  expect(titleOf(again.html)).toBe('Sign in · Kolab');
  expect(again.html).toContain('Signed in with Apple as <code>zara</code>. You are <code>zara</code> here.');
  // GitHub's sign-in beside it still works as it did.
  github.next({ subject: '77', login: 'zed' });
  const page = await new Browser(base).go(authorize(base, client));
  const viaGitHub = await new Browser(base).go(hrefs(page.html)[1]);
  expect(viaGitHub.html).toContain('Signed in with GitHub as <code>zed</code>. You are <code>zed</code> here.');
});

test('Apple\'s answer counts only for its own sign-in: a code whose id_token carries another sign-in\'s nonce, a callback at the wrong provider, and a cancelled username are refused', async () => {
  const kolab = await openKolab();
  const { base, tokens } = await serve(kolab);
  const client = await register(base);

  // The nonce of some other sign-in (a code taken from someone else's): Kolab doesn't trust who it names.
  const stolen = await withApple(base, tokens, client, SUB, { nonce: s256('w'.repeat(43)) });
  expect(stolen.res.status).toBe(502);
  expect(stolen.html).toContain('Apple didn&#39;t confirm who signed in.');
  expect(await kolab.signInKnown({ provider: 'apple', subject: SUB })).toBeUndefined();

  // A sign-in sent to Apple, answered at GitHub's callback.
  const browser = new Browser(base);
  const page = await browser.go(authorize(base, client));
  const at = (await browser.go(hrefs(page.html)[0])).left!;
  const wrong = await browser.go(`/oauth/callback/stub?code=x&state=${encodeURIComponent(at.searchParams.get('state')!)}`);
  expect(wrong.res.status).toBe(400);
  expect(wrong.html).toContain('This sign-in was sent to Apple, not GitHub.');
  expect((await browser.go('/oauth/callback/facebook?code=x&state=y')).res.status).toBe(404);

  // Cancelled at the username page: the app is told, and no one is made.
  const first = await withApple(base, tokens, client);
  const cancelled = await first.browser.post('/oauth/username', { sign_in: field(first.html, 'sign_in'), csrf: field(first.html, 'csrf'), decision: 'cancel' });
  expect(Object.fromEntries(cancelled.left!.searchParams)).toMatchObject({ error: 'access_denied', state: 'client-state' });
  expect(await kolab.signInKnown({ provider: 'apple', subject: SUB })).toBeUndefined();
  // That form is spent.
  expect((await first.browser.post('/oauth/username', { sign_in: field(first.html, 'sign_in'), csrf: field(first.html, 'csrf'), decision: 'choose', username: 'zara' })).res.status).toBe(400);
});

test('konnect\'s app: an Apple person with no team is told an invite link, not their username, reaches them; with a team, its page offers another Apple account, under a policy that names Apple', async () => {
  const kolab = await openKolab();
  const { base, tokens } = await serve(kolab);
  const loopback = await register(base);
  const first = await withApple(base, tokens, loopback, SUB, { scope: 'konjir choose:kolab' });
  const chosen = await first.browser.post('/oauth/username', { sign_in: field(first.html, 'sign_in'), csrf: field(first.html, 'csrf'), decision: 'choose', username: 'yuki' });
  expect(titleOf(chosen.html)).toBe('Choose where to sign in · Kolab');
  expect(chosen.html).toContain('An account you sign in to with Apple can\'t be invited by name, so to join someone else\'s, ask its owner for an invite link');
  expect(chosen.html).not.toContain('invite your Apple account');
  const closed = await first.browser.post('/oauth/consent', { sign_in: field(chosen.html, 'sign_in'), csrf: field(chosen.html, 'csrf'), decision: 'deny' });
  expect(closed.left!.searchParams.get('error_description')).toBe(NOTHING_TO_CHOOSE_UNINVITABLE);
  expect(NOTHING_TO_CHOOSE_UNINVITABLE).toMatch(/^nothing to sign in to:/);

  // With a team, konnect's own app gets the page about who signed in, whose other-account form leads to Apple.
  await kolab.makeOwnKolab('yuki', 'yukis', 'Yuki\'s');
  const app = await register(base, [APP]);
  const p = await withApple(base, tokens, app, SUB, { scope: 'konjir choose:kolab', redirect: APP });
  expect(titleOf(p.html)).toBe('Continue as @yuki · Kolab');
  expect(p.html).toContain('Use a different Apple account');
  expect(csp(p.res)).toContain(`form-action 'self' https://www.konjir.com ${FAKE};`);
  const other = await p.browser.post('/oauth/consent', { sign_in: field(p.html, 'sign_in'), csrf: field(p.html, 'csrf'), pick: 'other-account' });
  expect(other.left!.origin + other.left!.pathname).toBe(`${FAKE}/auth/authorize`);
  // Apple has no account picker to ask for.
  expect(other.left!.searchParams.has('prompt')).toBe(false);
});

test('an Apple person invited by a GitHub username they don\'t have is no one\'s: the refusal says an invite link reaches someone who signs in with Apple', async () => {
  const kolab = await openKolab();
  const { github } = await serve(kolab);
  const { actor } = await kolab.signInWith({ provider: 'stub', subject: '88', login: 'owner' });
  await kolab.makeOwnKolab(actor, 'owners', 'Owner\'s');
  const session = await kolab.openSession(actor, 'product', { kolab: 'owners', by: 'admin' });
  expect(github.lookup).toBeDefined();
  const r = await kolab.inviteAccounts(session, ['yuki'], { provider: 'stub', find: github.lookup! }).then(() => '', (e: Error) => e.message);
  expect(r).toMatch(/no GitHub account yuki: check the spelling\. Nothing was invited\. Someone who signs in to Kolab with Apple has no GitHub account to invite by: make them an invite link on Kolab's web page instead/);
});
