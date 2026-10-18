// Kolab as an OAuth 2.1 authorization server (D55), over HTTP, with a stub identity provider in
// place of GitHub: discovery, registration, PKCE, redirect URIs, state and CSRF, consent, tokens,
// expiry, refresh and revocation, and the web interface signing in through it.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { closeAtEnd, openKolab, people, setup } from '@konjir/engine/testing';
import { StubIdentity, startServer } from '../src/server.js';

const CB = 'http://127.0.0.1:9/cb';
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

async function serve(kolab: Kolab, opts: { identity?: StubIdentity | null; handIssuedTokens?: boolean; webTokenSignIn?: boolean } = {}) {
  const identity = opts.identity === null ? undefined : opts.identity ?? new StubIdentity();
  const server = await startServer({ adminToken: 'admin-token', kolab, webRoot: null, identity, handIssuedTokens: opts.handIssuedTokens, webTokenSignIn: opts.webTokenSignIn });
  closeAtEnd(server);
  return { base: new URL(server.url).origin, mcp: server.url, idp: identity as StubIdentity };
}

/** A browser: a cookie jar (paths aside), following redirects within Kolab, stopping at one that leaves it. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const name = kv.slice(0, kv.indexOf('=')).trim();
      const value = kv.slice(kv.indexOf('=') + 1).trim();
      if (!value || /max-age=0/i.test(c)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
  }
  async fetch(url: string | URL, init: RequestInit = {}) {
    const headers = { ...(init.headers as Record<string, string> | undefined), cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    const res = await fetch(new URL(url, this.base), { ...init, headers, redirect: 'manual' });
    this.keep(res);
    return res;
  }
  async go(url: string | URL, init?: RequestInit): Promise<{ res: Response; at: URL; left?: URL }> {
    let at = new URL(url, this.base);
    let res = await this.fetch(at, init);
    for (let i = 0; i < 10 && res.status >= 300 && res.status < 400; i++) {
      const next = new URL(res.headers.get('location')!, at);
      if (next.origin !== new URL(this.base).origin) return { res, at, left: next };
      at = next;
      res = await this.fetch(next);
    }
    return { res, at };
  }
  /** Submits the consent page's form, as the page would: from Kolab's origin, urlencoded. */
  consent(form: Record<string, string>) {
    return this.go('/oauth/consent', {
      method: 'POST', headers: { origin: this.base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
    });
  }
}

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

async function register(base: string, redirectUris = [CB]) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test harness', redirect_uris: redirectUris, grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' }) });
  return { status: r.status, body: await r.json() as { client_id: string; error?: string } };
}

function authorizeUrl(base: string, client: string, p: { verifier?: string; state?: string; redirect?: string; scope?: string; method?: string; challenge?: string | null } = {}) {
  const u = new URL('/oauth/authorize', base);
  const q: Record<string, string> = {
    response_type: 'code', client_id: client, redirect_uri: p.redirect ?? CB, state: p.state ?? 'client-state',
    code_challenge_method: p.method ?? 'S256', resource: `${base}/mcp`,
  };
  if (p.challenge !== null) q.code_challenge = p.challenge ?? s256(p.verifier ?? 'v'.repeat(43));
  if (p.scope) q.scope = p.scope;
  u.search = new URLSearchParams(q).toString();
  return u;
}

const token = (base: string, form: Record<string, string>) => fetch(`${base}/oauth/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
}).then(async (r) => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json() as Record<string, string> }));

const initialize = (mcp: string, bearer?: string) => fetch(mcp, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }),
});

/** Signs `who` in at the stub and returns the consent page, its token and the browser. */
async function toConsent(base: string, idp: StubIdentity, client: string, who: { subject: string; login: string; name?: string }, p: Parameters<typeof authorizeUrl>[2] = {}) {
  const browser = new Browser(base);
  idp.next(who);
  const { res } = await browser.go(authorizeUrl(base, client, p));
  const html = await res.text();
  return { browser, html, status: res.status, csrf: csrfOf(html) };
}

test('discovery: /mcp challenges with its protected-resource metadata, which names Kolab as its authorization server', async () => {
  const { kolab } = await setup();
  const { base, mcp } = await serve(kolab);
  const r = await initialize(mcp);
  expect(r.status).toBe(401);
  expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  expect(prm).toStrictEqual({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['konjir'], resource_name: 'Kolab' });
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  expect(as).toMatchObject({
    issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    grant_types_supported: ['authorization_code', 'refresh_token'], authorization_response_iss_parameter_supported: true,
  });
  // Without an identity provider there is no OAuth to discover.
  const none = await serve(await openKolab(), { identity: null });
  expect((await fetch(`${none.base}/.well-known/oauth-authorization-server`)).status).toBe(404);
});

test('a person signs up with the identity provider, consents, and their client gets short-lived tokens that refresh, reach /mcp, and revoke', async () => {
  const { kolab } = await setup();
  const { base, mcp, idp } = await serve(kolab);
  const reg = await register(base);
  expect(reg.status).toBe(201);
  expect(reg.body).toMatchObject({ client_id: expect.stringMatching(/^kjcl_/), token_endpoint_auth_method: 'none', redirect_uris: [CB] });
  const client = reg.body.client_id;
  const verifier = randomBytes(32).toString('base64url');

  const c = await toConsent(base, idp, client, { subject: '501', login: 'Zed', name: 'Zed Z' }, { verifier, scope: 'konjir role:engineer' });
  expect(c.status).toBe(200);
  expect(c.html).toContain('Welcome: you are <code>zed</code> here');
  expect(c.html).toContain('Test harness');
  expect(c.html).toMatch(/value="engineer" checked/);   // preselected from the scope
  expect(c.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const done = await c.browser.consent({ csrf: c.csrf, decision: 'allow', as: 'new-agent', agent_label: 'harness', kolab: '@new', new_kolab_name: 'zeds', new_kolab_title: 'Zed\'s', role: 'engineer' });
  expect(done.left?.origin + done.left!.pathname).toBe(CB);
  expect(done.left!.searchParams.get('state')).toBe('client-state');
  expect(done.left!.searchParams.get('iss')).toBe(base);   // RFC 9207
  const code = done.left!.searchParams.get('code')!;
  expect(code).toMatch(/^kjc_/);

  const t = await token(base, { grant_type: 'authorization_code', client_id: client, code, redirect_uri: CB, code_verifier: verifier, resource: `${base}/mcp` });
  expect(t.status).toBe(200);
  expect(t.cache).toBe('no-store');
  expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'konjir kolab:zeds role:engineer' });
  expect(await kolab.sessionInfo(t.body.access_token)).toMatchObject({ actor: 'zed-harness', kind: 'agent', owner: 'zed', kolab: 'zeds', role: 'engineer' });
  expect((await initialize(mcp, t.body.access_token)).status).toBe(200);

  // Expired: /mcp refuses it, and a refresh brings a new one.
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'zed-harness' and ended_at is null`);
  expect((await initialize(mcp, t.body.access_token)).status).toBe(401);
  const r = await token(base, { grant_type: 'refresh_token', client_id: client, refresh_token: t.body.refresh_token });
  expect(r.status).toBe(200);
  expect(r.body.refresh_token).not.toBe(t.body.refresh_token);
  expect((await initialize(mcp, r.body.access_token)).status).toBe(200);
  expect((await initialize(mcp, t.body.access_token)).status).toBe(401);

  // Revoked: the session ends.
  const rv = await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: r.body.refresh_token, client_id: client }).toString() });
  expect(rv.status).toBe(200);
  expect((await initialize(mcp, r.body.access_token)).status).toBe(401);
  expect((await token(base, { grant_type: 'refresh_token', client_id: client, refresh_token: r.body.refresh_token })).body.error).toBe('invalid_grant');
  // No secret Kolab issued is stored.
  const dump = JSON.stringify((await kolab.db.query(`select * from session`)).rows) + JSON.stringify((await kolab.db.query(`select * from oauth_code`)).rows)
    + JSON.stringify((await kolab.db.query(`select * from oauth_refresh_token`)).rows) + JSON.stringify((await kolab.db.query(`select * from oauth_request`)).rows);
  for (const secret of [code, t.body.access_token, t.body.refresh_token, r.body.access_token, r.body.refresh_token, c.csrf]) expect(dump).not.toContain(secret);
});

test('PKCE is required, S256 only, and the verifier must match; a refused request is a page, never a redirect', async () => {
  const { kolab } = await setup();
  const { base, idp } = await serve(kolab);
  const client = (await register(base)).body.client_id;
  for (const p of [{ challenge: null }, { method: 'plain' }, { challenge: 'short' }]) {
    const { res, left } = await new Browser(base).go(authorizeUrl(base, client, p));
    expect([res.status, left, (await res.text()).includes('PKCE is required')]).toStrictEqual([400, undefined, true]);
  }
  const bad = authorizeUrl(base, client);
  bad.searchParams.set('response_type', 'token');
  expect([(await new Browser(base).go(bad)).res.status, (await new Browser(base).go(bad)).left]).toStrictEqual([400, undefined]);
  await kolab.grant('test', 'alice', 'write');
  const verifier = randomBytes(32).toString('base64url');
  const c = await toConsent(base, idp, client, { subject: '502', login: 'yan' }, { verifier });
  await kolab.grant('test', 'yan', 'write');
  const { left } = await c.browser.consent({ csrf: c.csrf, decision: 'allow', as: 'self', kolab: 'kolab:test', role: 'product' });
  const code = left!.searchParams.get('code')!;
  const wrong = await token(base, { grant_type: 'authorization_code', client_id: client, code, redirect_uri: CB, code_verifier: randomBytes(32).toString('base64url') });
  expect([wrong.status, wrong.body.error]).toStrictEqual([400, 'invalid_grant']);
  const right = await token(base, { grant_type: 'authorization_code', client_id: client, code, redirect_uri: CB, code_verifier: verifier });
  expect(right.status).toBe(200);
  // A code used twice revokes what it opened.
  const twice = await token(base, { grant_type: 'authorization_code', client_id: client, code, redirect_uri: CB, code_verifier: verifier });
  expect(twice.body.error).toBe('invalid_grant');
  expect(await kolab.sessionOpen(right.body.access_token)).toBe(false);
});

test('redirect URIs: registered ones only, exactly, so nothing is sent to an address the client did not register', async () => {
  const { kolab } = await setup();
  const { base } = await serve(kolab);
  for (const bad of [['http://evil.example/cb'], ['javascript:alert(1)'], [], ['https://a.example/cb#frag'], ['com.example.app:/cb'], ['http://u@localhost/cb']]) {
    expect(await register(base, bad)).toMatchObject({ status: 400, body: { error: 'invalid_redirect_uri' } });
  }
  expect((await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CB], token_endpoint_auth_method: 'client_secret_basic' }) })).status).toBe(400);
  const client = (await register(base, ['https://app.example/cb', 'http://localhost:5000/cb'])).body.client_id;
  for (const redirect of ['https://app.example/cb/../evil', 'https://app.example/cb2', 'https://evil.example/cb', 'http://127.0.0.1:5000/cb', 'http://localhost:5000/cb#x', 'http://u:p@localhost:5000/cb']) {
    const { res, left } = await new Browser(base).go(authorizeUrl(base, client, { redirect }));
    expect([redirect, res.status, left]).toStrictEqual([redirect, 400, undefined]);   // a page, never a redirect
  }
  const unknown = await new Browser(base).go(authorizeUrl(base, 'kjcl_nobody0000000000000000', {}));
  expect([unknown.res.status, unknown.left]).toStrictEqual([400, undefined]);
  // A loopback redirect may change its port (RFC 8252 §7.3): it goes on to sign in.
  const loop = await new Browser(base).go(authorizeUrl(base, client, { redirect: 'http://localhost:61234/cb' }));
  expect(loop.left?.toString() ?? loop.at.pathname).toMatch(/oauth\/callback\/stub|access_denied/);
  // A resource other than this Kolab's MCP endpoint is refused, on a page.
  const u = authorizeUrl(base, client, { redirect: 'https://app.example/cb' });
  u.searchParams.set('resource', 'https://other.example/mcp');
  const target = await new Browser(base).go(u);
  expect([target.res.status, target.left, (await target.res.text()).includes('issues tokens for')]).toStrictEqual([400, undefined, true]);
});

test('state and CSRF: the provider\'s answer counts only in the browser that asked, with its state; consent only from Kolab\'s page, with its token', async () => {
  const { kolab } = await setup();
  const { base, idp } = await serve(kolab);
  const client = (await register(base)).body.client_id;
  // The provider sends its answer to another browser (no binding cookie): refused.
  const victim = new Browser(base);
  idp.next({ subject: '503', login: 'xia' });
  const first = await victim.fetch(authorizeUrl(base, client));
  const callback = first.headers.get('location')!;
  const attacker = new Browser(base);
  expect((await attacker.go(callback)).res.status).toBe(400);
  // The right browser, with a tampered state: refused.
  const tampered = new URL(callback);
  tampered.searchParams.set('state', randomBytes(32).toString('base64url'));
  expect((await victim.go(tampered)).res.status).toBe(400);
  // The consent form: from another origin, or with no origin, or the wrong token, refused.
  const c = await toConsent(base, idp, client, { subject: '504', login: 'wu' });
  const form = { csrf: c.csrf, decision: 'allow', as: 'self', kolab: '@new', new_kolab_name: 'wus', new_kolab_title: 'Wu', role: 'product' };
  const post = (headers: Record<string, string>, body = form) => c.browser.fetch('/oauth/consent', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
  expect((await post({ origin: 'http://evil.example' })).status).toBe(403);
  expect((await post({})).status).toBe(403);
  expect((await post({ origin: base }, { ...form, csrf: randomBytes(32).toString('base64url') })).status).toBe(400);
  expect((await new Browser(base).fetch('/oauth/consent', { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() })).status).toBe(400);
  // The real one works once.
  expect((await c.browser.consent(form)).left?.searchParams.get('code')).toMatch(/^kjc_/);
  expect((await post({ origin: base })).status).toBe(400);
  // Denying tells the client so.
  const d = await toConsent(base, idp, client, { subject: '505', login: 'vic' });
  expect((await d.browser.consent({ csrf: d.csrf, decision: 'deny' })).left?.searchParams.get('error')).toBe('access_denied');
  // Cancelling at the provider does too.
  const e = new Browser(base);
  idp.as = undefined;
  expect((await e.go(authorizeUrl(base, client))).left?.searchParams.get('error')).toBe('access_denied');
  // The pages can't be framed and load nothing from elsewhere.
  const page = await toConsent(base, idp, client, { subject: '506', login: 'ula' });
  void page;
  const h = await new Browser(base).fetch(authorizeUrl(base, 'kjcl_nobody0000000000000000'));
  expect(h.headers.get('x-frame-options')).toBe('DENY');
  expect(h.headers.get('content-security-policy')).toMatch(/default-src 'none'.*frame-ancestors 'none'/);
});

test('sign-up names: a login taken by a live or archived account, or reserved, signs up as a variant; an archived person can\'t sign in', async () => {
  const kolab = await openKolab();
  await people(kolab, ['alice', 'bob']);
  await kolab.archive({ actor: 'bob' });
  const { base, idp } = await serve(kolab);
  const client = (await register(base)).body.client_id;
  expect((await toConsent(base, idp, client, { subject: '601', login: 'ALICE' })).html).toContain('you are <code>alice_2</code> here, new to Kolab');
  expect((await toConsent(base, idp, client, { subject: '602', login: 'bob' })).html).toContain('<code>bob_2</code>');
  expect((await toConsent(base, idp, client, { subject: '603', login: 'kolab' })).html).toContain('<code>gh_kolab</code>');
  await kolab.archive({ actor: 'alice_2' });
  const archived = await toConsent(base, idp, client, { subject: '601', login: 'ALICE' });
  expect([archived.status, archived.html.includes('alice_2 is archived')]).toStrictEqual([403, true]);
});

test('the web interface signs a person in with the identity provider, refreshes their token as it expires, and signs out for good', async () => {
  const { kolab } = await setup();
  const { base, idp } = await serve(kolab);
  const browser = new Browser(base);
  expect(await (await browser.fetch('/api/session/methods', { headers: { origin: base } })).json()).toStrictEqual({ provider: 'Stub', token: false });
  // Token sign-in is off once there is an identity provider.
  const hand = await kolab.openSession('carol', 'product');
  expect((await browser.fetch('/api/session', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token: hand }) })).status).toBe(403);

  idp.next({ subject: '701', login: 'tess' });
  const consent = await browser.go('/api/session/oauth/start');
  const html = await consent.res.text();
  expect(html).not.toContain('name="as"');   // the web interface is for people: no agents
  const done = await browser.consent({ csrf: csrfOf(html), decision: 'allow', kolab: '@new', new_kolab_name: 'tess', new_kolab_title: 'Tess', role: 'product' });
  expect([done.at.pathname, done.at.search]).toStrictEqual(['/', '']);   // back on the page, with no sign-in error (no web build here, so it says so)
  expect([...browser.cookies.keys()].sort()).toStrictEqual(['konjir_refresh', 'konjir_session']);
  const me = () => browser.fetch('/api/me', { headers: { origin: base } });
  expect(await (await me()).json()).toMatchObject({ actor: 'tess', kind: 'person', kolab: 'tess', role: 'product' });

  // The access token expires: the next call refreshes it, and both cookies change.
  const before = browser.cookies.get('konjir_session');
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'tess' and ended_at is null`);
  const calls = await Promise.all([me(), me(), me()]);   // at once: one refresh, shared
  expect(calls.map((r) => r.status)).toStrictEqual([200, 200, 200]);
  expect(browser.cookies.get('konjir_session')).not.toBe(before);
  expect((await me()).status).toBe(200);

  // Signing out ends the session and revokes the refresh token.
  const refresh = decodeURIComponent(browser.cookies.get('konjir_refresh')!);
  expect((await browser.fetch('/api/session', { method: 'DELETE', headers: { origin: base } })).status).toBe(204);
  expect(browser.cookies.size).toBe(0);
  expect(await kolab.refreshGrant({ refreshToken: refresh, clientId: 'konjir-web' }).catch((e: { code: string }) => e.code)).toBe('invalid_grant');

  // A state that isn't this browser's is refused, and so is the web client at the token endpoint.
  const stray = await new Browser(base).go('/api/session/oauth/callback?code=kjc_x&state=nope');
  expect(stray.at.search).toMatch(/signin_error=/);
  expect((await token(base, { grant_type: 'authorization_code', client_id: 'konjir-web', code: 'kjc_x', redirect_uri: `${base}/api/session/oauth/callback`, code_verifier: 'v'.repeat(43) })).status).toBe(401);
});

test('hand-issued tokens can be turned off; the admin token works either way', async () => {
  const { kolab, product } = await setup();
  const { mcp } = await serve(kolab, { handIssuedTokens: false });
  expect((await initialize(mcp, product)).status).toBe(401);
  expect((await initialize(mcp, 'admin-token')).status).toBe(200);
  const on = await serve(kolab);
  expect((await initialize(on.mcp, product)).status).toBe(200);
});

test('a web page\'s event stream outlives no access token: when it expires the stream closes without `ended`, and reconnecting refreshes it', async () => {
  const { kolab, product, engineer } = await setup();
  await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] });
  const { base, idp } = await serve(kolab);
  const browser = new Browser(base);
  idp.next({ subject: '801', login: 'sol' });
  await kolab.signInWith({ provider: 'stub', subject: '801', login: 'sol' });
  await kolab.grant('test', 'sol', 'write');
  const html = await (await browser.go('/api/session/oauth/start')).res.text();
  await browser.consent({ csrf: csrfOf(html), decision: 'allow', kolab: 'kolab:test', role: 'product' });
  const read = async (res: Response) => {
    const text: string[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) return text.join(''); text.push(decoder.decode(value, { stream: true })); if (text.join('').includes('"ready"')) break; }
    return { reader, decoder, text };
  };
  const res = await browser.fetch('/api/events', { headers: { origin: base } });
  const open = await read(res) as { reader: ReadableStreamDefaultReader<Uint8Array>; decoder: TextDecoder; text: string[] };
  expect(open.text.join('')).toContain('retry: 1000');
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'sol' and ended_at is null`);
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'Which orders?');
  for (;;) { const { value, done } = await open.reader.read(); if (done) break; open.text.push(open.decoder.decode(value, { stream: true })); }
  expect(open.text.join('')).not.toContain('"ended"');
  // The browser reconnects: the guard refreshes the token, and the stream opens again.
  const again = await browser.fetch('/api/events', { headers: { origin: base } });
  expect(again.status).toBe(200);
  await again.body?.cancel();
});

test('GitHub: Kolab asks for no scope, sends PKCE and its state, reads who signed in by their id, and revokes the token it was given', async () => {
  const { GitHubIdentity } = await import('../src/oauth/identity.js');
  const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : undefined, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (url.endsWith('/login/oauth/access_token')) return Response.json({ access_token: 'gho_secret', token_type: 'bearer', scope: '' });
    if (url.endsWith('/user')) return Response.json({ id: 12345, login: 'Octo', name: 'Octo Cat' });
    return new Response(null, { status: 204 });
  };
  const gh = new GitHubIdentity({ clientId: 'Iv1.abc', clientSecret: 'shh', fetch: fake });
  const u = new URL(gh.authorizationUrl({ redirectUri: 'https://kolab.example/oauth/callback/github', state: 'st', codeChallenge: 'ch' }));
  expect([u.origin + u.pathname, u.searchParams.get('client_id'), u.searchParams.get('state'), u.searchParams.get('code_challenge'), u.searchParams.get('code_challenge_method'), u.searchParams.get('scope')])
    .toStrictEqual(['https://github.com/login/oauth/authorize', 'Iv1.abc', 'st', 'ch', 'S256', null]);
  expect(await gh.identify({ code: 'c0de', redirectUri: 'https://kolab.example/oauth/callback/github', codeVerifier: 'ver' })).toStrictEqual({ subject: '12345', login: 'Octo', name: 'Octo Cat' });
  await new Promise((r) => setTimeout(r, 10));
  expect(new URLSearchParams(calls[0].body)).toMatchObject(new URLSearchParams({ client_id: 'Iv1.abc', client_secret: 'shh', code: 'c0de', redirect_uri: 'https://kolab.example/oauth/callback/github', code_verifier: 'ver' }));
  expect(calls[1]).toMatchObject({ url: 'https://api.github.com/user', auth: 'Bearer gho_secret' });
  expect(calls[2]).toMatchObject({ url: 'https://api.github.com/applications/Iv1.abc/token', method: 'DELETE' });
  // A refusal says so without the response's body.
  const refusing = new GitHubIdentity({ clientId: 'x', clientSecret: 'y', fetch: async () => Response.json({ error: 'bad_verification_code' }) });
  await expect(refusing.identify({ code: 'no', redirectUri: 'r', codeVerifier: 'v' })).rejects.toThrow(/didn't accept the sign-in \(bad_verification_code\)/);
});

test('limits are per address and per client, counted only once the client checks out; revocation needs the token\'s own client', async () => {
  const { kolab } = await setup();
  const { base, idp } = await serve(kolab);
  // Ten registrations an hour from one address.
  const regs = [];
  for (let i = 0; i < 11; i++) regs.push((await register(base)).status);
  expect(regs).toStrictEqual([...Array(10).fill(201), 429]);
  // Requests naming no client, or an unknown one, use up nothing.
  for (let i = 0; i < 40; i++) expect((await new Browser(base).fetch('/oauth/authorize?client_id=kjcl_nobody0000000000000000')).status).toBe(400);
  const client = (await kolab.registerClient({ redirectUris: [CB] })).id;
  const statuses = [];
  for (let i = 0; i < 31; i++) { idp.as = { subject: '900', login: 'lim' }; statuses.push((await new Browser(base).fetch(authorizeUrl(base, client))).status); }
  expect(statuses.slice(0, 30).every((st) => st === 302)).toBe(true);
  expect(statuses[30]).toBe(429);

  // Revocation: without the token's own client, refused; with another client, nothing happens.
  const other = (await kolab.registerClient({ redirectUris: [CB] })).id;
  const { actor } = await kolab.signInWith({ provider: 'stub', subject: '901', login: 'rev' });
  await kolab.grant('test', actor, 'read');
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await kolab.beginAuthorization({ provider: 'stub', clientId: client, redirectUri: CB, codeChallenge: s256(verifier) });
  const { csrf } = await kolab.identifyAuthorization(binding, state, actor);
  const { code } = await kolab.consent(binding, csrf, { as: { kind: 'self' }, kolab: 'test', role: 'product' });
  const t = await kolab.exchangeCode({ code, clientId: client, redirectUri: CB, codeVerifier: verifier });
  const revoke = (form: Record<string, string>) => fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  expect((await revoke({ token: t.refreshToken })).status).toBe(401);
  expect((await revoke({ token: t.refreshToken, client_id: 'konjir-web' })).status).toBe(401);
  expect((await revoke({ token: t.refreshToken, client_id: other })).status).toBe(200);
  expect(await kolab.sessionOpen(t.accessToken)).toBe(true);
  expect((await revoke({ token: t.refreshToken, client_id: client })).status).toBe(200);
  expect(await kolab.sessionOpen(t.accessToken)).toBe(false);
});

test('behind the TLS proxy the sign-in cookies are __Host-: Secure, Path=/, no Domain', async () => {
  const { request } = await import('node:http');
  const { createServer } = await import('node:http');
  const kolab = await openKolab();
  const port = await new Promise<number>((resolve) => { const t = createServer().listen(0, '127.0.0.1', () => { const p = (t.address() as { port: number }).port; t.close(() => resolve(p)); }); });
  const idp = new StubIdentity();
  closeAtEnd(await startServer({ adminToken: 'admin-token', kolab, port, webRoot: null, publicHost: 'kolab.example.com', identity: idp }));
  const client = (await kolab.registerClient({ redirectUris: [CB] })).id;
  const get = (path: string) => new Promise<string[]>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host: 'kolab.example.com' } }, (x) => { x.resume(); resolve(x.headers['set-cookie'] ?? []); }).on('error', reject).end();
  });
  const u = new URL(authorizeUrl('https://kolab.example.com', client));
  expect((await get(u.pathname + u.search))[0]).toMatch(/^__Host-konjir_oauth=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  expect((await get('/api/session/oauth/start'))[0]).toMatch(/^__Host-konjir_web_oauth=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=900$/);
});

test('sign-in limits are per address, an IPv6 /64 as one, with no per-client bucket: the web client can\'t be locked out by a few addresses', async () => {
  const { addressKey } = await import('../src/oauth/oauth.controller.js');
  expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
  expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  expect(addressKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
  expect(addressKey('2001:0db8:0001:0002:ffff:1:2:3')).toBe('2001:db8:1:2::/64');
  expect(addressKey('[2001:db8::5]')).toBe('2001:db8:0:0::/64');
  expect(addressKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');

  const { request, createServer } = await import('node:http');
  const kolab = await openKolab();
  const port = await new Promise<number>((resolve) => { const t = createServer().listen(0, '127.0.0.1', () => { const p = (t.address() as { port: number }).port; t.close(() => resolve(p)); }); });
  const idp = new StubIdentity();
  idp.as = { subject: '950', login: 'many' };
  closeAtEnd(await startServer({ adminToken: 'admin-token', kolab, port, webRoot: null, publicHost: 'kolab.example.com', identity: idp }));
  const web = new URL('https://kolab.example.com/oauth/authorize');
  web.search = new URLSearchParams({ response_type: 'code', client_id: 'konjir-web', redirect_uri: 'https://kolab.example.com/api/session/oauth/callback', state: 's', code_challenge: s256('v'.repeat(43)), code_challenge_method: 'S256' }).toString();
  const from = (ip: string, path = web.pathname + web.search) => new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host: 'kolab.example.com', 'x-forwarded-for': ip } }, (x) => { x.resume(); resolve(x.statusCode!); }).on('error', reject).end();
  });
  // Two addresses spend their own budgets; a third still signs in.
  for (const ip of ['198.51.100.1', '198.51.100.2']) {
    const got = [];
    for (let i = 0; i < 31; i++) got.push(await from(ip));
    expect([ip, got.slice(0, 30).every((st) => st === 302), got[30]]).toStrictEqual([ip, true, 429]);
  }
  expect(await from('198.51.100.3')).toBe(302);
  // One /64 is one address, however many it holds.
  for (let i = 0; i < 30; i++) expect(await from(`2001:db8:7:7::${(i + 1).toString(16)}`)).toBe(302);
  expect(await from('2001:db8:7:7:ffff::1')).toBe(429);
  expect(await from('2001:db8:7:8::1')).toBe(302);
  // A refused request (an unknown client) spends nothing.
  for (let i = 0; i < 40; i++) expect(await from('198.51.100.9', '/oauth/authorize?client_id=kjcl_nobody0000000000000000')).toBe(400);
  expect(await from('198.51.100.9')).toBe(302);
});

test('a request with no address to count by is refused, and sign-in has no total for many addresses to use up', async () => {
  const { Limit, clientAddress } = await import('../src/oauth/oauth.controller.js');
  const req = (remoteAddress: string | undefined, xff?: string) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as never;
  expect(clientAddress(req(undefined), {})).toBeUndefined();
  expect(clientAddress(req('127.0.0.1'), { publicHost: 'k.example' })).toBe('ip:127.0.0.1');
  expect(clientAddress(req('127.0.0.1', '203.0.113.1, 198.51.100.4'), { publicHost: 'k.example' })).toBe('ip:198.51.100.4');
  expect(clientAddress(req('203.0.113.9', '198.51.100.4'), { publicHost: 'k.example' })).toBe('ip:203.0.113.9');   // not through the proxy: XFF ignored
  const limit = new Limit(30, Infinity, 60_000);
  expect(limit.take(undefined)).toBe(false);
  // 200 addresses, each at its own limit, and the 201st still gets in.
  for (let a = 0; a < 200; a++) for (let i = 0; i < 30; i++) expect(limit.take(`ip:10.0.${a >> 8}.${a & 255}`)).toBe(true);
  expect(limit.take('ip:10.9.9.9')).toBe(true);
  expect(limit.take('ip:10.0.0.0')).toBe(false);
});
