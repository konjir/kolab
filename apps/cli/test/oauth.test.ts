// An MCP client signs a person in through Kolab's OAuth 2.1 authorization server (D55), as Claude
// Code does: the MCP SDK's own client discovers it from /mcp's 401, registers itself, authorizes
// with PKCE, and its token works. The identity provider is a stub in place of GitHub. Its access
// token expires and refreshes by itself; revoking the grant ends the session and closes its
// listen streams (D41).
import { expect, test } from '@jest/globals';
import {
  Client, StreamableHTTPClientTransport, UnauthorizedError,
  type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { StubIdentity, startServer } from '@konjir/server';
import { call } from '../src/cli.js';
import { closeAtEnd, commitReviewed, els, people, testStore, openKolab } from '@konjir/engine/testing';

const CALLBACK = 'http://127.0.0.1:9/callback';

/** What an MCP client keeps between runs: its registration, tokens, verifier and discovery. */
class Harness implements OAuthClientProvider {
  info?: StoredOAuthClientInformation;
  saved?: StoredOAuthTokens;
  verifier = '';
  discovery?: OAuthDiscoveryState;
  authorizationUrl?: URL;
  get redirectUrl() { return CALLBACK; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Harness', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state() { return 'harness-state'; }
  clientInformation() { return this.info; }
  saveClientInformation(i: StoredOAuthClientInformation) { this.info = i; }
  tokens() { return this.saved; }
  saveTokens(t: StoredOAuthTokens) { this.saved = t; }
  redirectToAuthorization(u: URL) { this.authorizationUrl = u; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  saveDiscoveryState(s: OAuthDiscoveryState) { this.discovery = s; }
  discoveryState() { return this.discovery; }
}

/** The person's browser: follows Kolab's redirects with its cookies, and submits the consent page as `form` says. */
async function browse(start: URL, form: Record<string, string>): Promise<URL> {
  const jar = new Map<string, string>();
  const go = async (url: URL, init: RequestInit = {}) => {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; jar.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)); }
    return res;
  };
  let url = start;
  let res = await go(url);
  while (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get('location')!, url); res = await go(url); }
  const html = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const signIn = /name="sign_in" value="([^"]+)"/.exec(html)?.[1];
  if (!csrf) throw new Error(`no consent page at ${url.pathname}: ${res.status}`);
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, sign_in: signIn ?? '', decision: 'allow', ...form }).toString(),
  });
  return new URL(done.headers.get('location')!);
}

async function connectWithOAuth(url: string, harness: Harness, form: Record<string, string>) {
  const client = () => new Client({ name: 'harness', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  const first = client();
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: harness });
  await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(harness.authorizationUrl).toBeDefined();
  const back = await browse(harness.authorizationUrl!, form);
  expect(back.searchParams.get('state')).toBe('harness-state');
  await transport.finishAuth(back.searchParams);
  const c = client();
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: harness }));
  closeAtEnd(c);
  return c;
}

test('an MCP client signs a person in with OAuth, as their agent; its token refreshes by itself; its listen stream closes when the token expires, and when the grant is revoked', async () => {
  const kolab = await openKolab(await testStore());
  await people(kolab, 'lee');   // someone else, in a kolab Rae can't reach
  const idp = new StubIdentity().next({ subject: '9001', login: 'Rae', name: 'Rae' });
  const server = await startServer({ adminToken: 'oauth-admin', kolab, identity: idp, webRoot: null });
  closeAtEnd(server);

  const harness = new Harness();
  const agent = await connectWithOAuth(server.url, harness, { as: 'new-agent', agent_label: 'claude', kolab: '@new', new_kolab_name: 'raes', new_kolab_title: 'Rae\'s', role: 'product' });
  expect(harness.info?.client_id).toMatch(/^kjcl_/);   // registered itself (RFC 7591)
  expect(harness.saved).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'konjir kolab:raes role:product' });
  expect(await call(agent, 'whoami')).toMatchObject({ actor: 'rae-claude', kind: 'agent', owner: 'rae', kolab: 'raes', role: 'product', layer: 'functional' });
  await call(agent, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });

  // The access token expires; the next call refreshes it, by itself, and goes through.
  const first = harness.saved!;
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'rae-claude' and ended_at is null`);
  expect(await call(agent, 'list_nodes')).toMatchObject([{ id: 'orders', title: 'Orders' }]);
  expect(harness.saved!.access_token).not.toBe(first.access_token);
  expect(harness.saved!.refresh_token).not.toBe(first.refresh_token);

  // A spec Rae and her agent review together, so a question on it changes the functional inbox.
  const rae = await kolab.openSession('rae', 'product', { kolab: 'raes' });
  await commitReviewed(kolab, rae, harness.saved!.access_token, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  const engineer = await kolab.switchSession(rae, { kolab: 'raes', role: 'engineer' });

  // Its listen stream lives as long as its access token: once that expires, the stream closes
  // before anything more is signalled to it (D41, D55), and the client listens again, refreshed.
  const listen = async () => {
    const box = { closed: false, updates: 0 };
    const sub = await agent.listen({ resourceSubscriptions: ['konjir://inbox/raes/functional'] });
    void sub.closed.then(() => { box.closed = true; }, () => { box.closed = true; });
    return box;
  };
  const until = async (what: () => boolean) => {
    const end = Date.now() + 5000;
    while (!what() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return what();
  };
  let updates = 0;
  agent.setNotificationHandler('notifications/resources/updated', () => { updates++; });
  const stream = await listen();
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'By whom?');
  expect(await until(() => updates === 1)).toBe(true);
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'rae-claude' and ended_at is null`);
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'And when?');
  expect(await until(() => stream.closed)).toBe(true);
  expect(updates).toBe(1);   // nothing reached the expired token
  // Listening again refreshes the token, by itself.
  const before = harness.saved!.access_token;
  const second = await listen();
  expect(harness.saved!.access_token).not.toBe(before);
  // …and revoking the grant ends the session, which closes the stream (D41).
  const revoked = await fetch(new URL('/oauth/revoke', server.url), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: harness.saved!.refresh_token!, client_id: harness.info!.client_id }).toString(),
  });
  expect(revoked.status).toBe(200);
  expect(await until(() => second.closed)).toBe(true);
  // The revoked token is refused; the client would have to authorize again.
  const fresh = new Client({ name: 'stale', version: '0' });
  await expect(fresh.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: `Bearer ${harness.saved!.access_token}` } },
  }))).rejects.toThrow();
});
