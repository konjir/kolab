// An MCP client signing in from a real browser (D55), as OpenCode's `opencode mcp auth` does: the
// MCP SDK's own auth() registers the client, sends the browser to /oauth/authorize, and waits on a
// loopback listener for the code; the person consents in Chromium; the SDK exchanges the code and
// reaches /mcp. Kolab's consent page once had `form-action 'self'`, under which Chromium blocks the
// 303 to the app's own listener after the consent has gone through, and clears the binding cookie
// with it: the page stays put, a second Allow finds no cookie, and the sign-in fails.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { auth, type OAuthClientProvider, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import { SHORT_TTL_S, SIGNIN, SIGNIN_SHORT } from '../playwright.config.js';

/** The app's loopback listener, as OpenCode runs one at http://127.0.0.1:19876/mcp/oauth/callback. */
async function listener(): Promise<{ url: string; hits: URL[]; close: () => Promise<void> }> {
  const hits: URL[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(new URL(req.url ?? '/', 'http://127.0.0.1'));
    res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Signed in</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp/oauth/callback`, hits, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/**
 * An MCP app that starts a sign-in at `kolab`, as OpenCode's McpOAuthProvider: it registers itself
 * (RFC 7591) with its loopback redirect, keeps everything in memory, and hands the browser one
 * authorization URL.
 */
async function begin(kolab: string, redirectUrl: string, state: string) {
  const app = { opened: [] as URL[], info: undefined as StoredOAuthClientInformation | undefined, tokens: undefined as StoredOAuthTokens | undefined, verifier: '' };
  const provider: OAuthClientProvider = {
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() {
      return { redirect_uris: [redirectUrl], client_name: 'OpenCode', client_uri: 'https://opencode.ai', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    },
    state: () => state,
    clientInformation: () => app.info,
    saveClientInformation: (i) => { app.info = i; },
    tokens: () => app.tokens,
    saveTokens: (t) => { app.tokens = t; },
    redirectToAuthorization: (u) => { app.opened.push(u); },
    saveCodeVerifier: (v) => { app.verifier = v; },
    codeVerifier: () => app.verifier,
  };
  const mcp = `${kolab}/mcp`;
  expect(await auth(provider, { serverUrl: mcp })).toBe('REDIRECT');
  expect(app.opened).toHaveLength(1);
  return {
    app, url: app.opened[0],
    /** The app's listener got `back`: it exchanges the code, then reaches /mcp with its token. */
    async finish(back: URL) {
      expect(await auth(provider, { serverUrl: mcp, authorizationCode: back.searchParams.get('code')!, iss: back.searchParams.get('iss') ?? undefined })).toBe('AUTHORIZED');
      const r = await fetch(mcp, {
        method: 'POST',
        headers: { authorization: `Bearer ${app.tokens!.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'opencode', version: '0' } } }),
      });
      expect(r.status).toBe(200);
    },
  };
}

/** Every CSP violation the page reports, and every page Kolab answered 400. */
function troubles(page: Page) {
  const seen: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy/.test(m.text())) seen.push(m.text()); });
  page.on('response', (r) => { if (r.status() === 400 && !r.url().includes('/mcp/oauth/callback')) seen.push(`400 ${new URL(r.url()).pathname}`); });
  return seen;
}

const consentShown = (page: Page) => expect(page.getByRole('heading', { name: 'Sign in to Kolab' })).toBeVisible();

test('an MCP client signs in as OpenCode does: one authorize, the consent page, then the 303 to its own loopback listener, and tokens that reach /mcp', async ({ page }) => {
  const app = await listener();
  try {
    const c = await begin(SIGNIN, app.url, 'opencode-state');
    // Where the browser is sent: Kolab's authorize, with PKCE, the loopback redirect, and Kolab's /mcp as the resource.
    expect(c.url.origin + c.url.pathname).toBe(`${SIGNIN}/oauth/authorize`);
    expect(Object.fromEntries(c.url.searchParams)).toMatchObject({
      response_type: 'code', client_id: expect.stringMatching(/^kjcl_/), code_challenge_method: 'S256', redirect_uri: app.url, state: 'opencode-state', resource: `${SIGNIN}/mcp`,
    });
    const seen = troubles(page);
    const shown = await page.goto(c.url.toString());
    await consentShown(page);
    // The page's forms may lead on to the app's own listener, and nowhere else but Kolab.
    expect((await shown!.allHeaders())['content-security-policy']).toContain(`form-action 'self' ${new URL(app.url).origin};`);
    await expect(page.getByText('OpenCode')).toBeVisible();

    await page.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL((u) => u.toString().startsWith(app.url));
    expect(seen).toStrictEqual([]);
    expect(app.hits).toHaveLength(1);
    expect([app.hits[0].searchParams.get('state'), app.hits[0].searchParams.get('iss')]).toStrictEqual(['opencode-state', SIGNIN]);
    await c.finish(app.hits[0]);
  } finally {
    await app.close();
  }
});

test('Deny goes back to the app too, past the page\'s form-action', async ({ page }) => {
  const app = await listener();
  try {
    const c = await begin(SIGNIN, app.url, 'deny-state');
    const seen = troubles(page);
    await page.goto(c.url.toString());
    await page.getByRole('button', { name: 'Deny' }).click();
    await page.waitForURL((u) => u.toString().startsWith(app.url));
    expect(seen).toStrictEqual([]);
    expect([app.hits[0].searchParams.get('error'), app.hits[0].searchParams.get('state')]).toStrictEqual(['access_denied', 'deny-state']);
  } finally {
    await app.close();
  }
});

test('two OpenCode-style sign-ins interleaved in one browser both go through: each keeps a binding cookie of its own', async ({ context }) => {
  const first = await listener();
  const second = await listener();
  try {
    const one = await begin(SIGNIN, first.url, 'first');
    const two = await begin(SIGNIN, second.url, 'second');
    const earlier = await context.newPage();
    const later = await context.newPage();
    const seen = [troubles(earlier), troubles(later)];
    // Both reach their consent pages before either is confirmed.
    await earlier.goto(one.url.toString());
    await consentShown(earlier);
    await later.goto(two.url.toString());
    await consentShown(later);
    expect((await context.cookies(`${SIGNIN}/oauth/consent`)).filter((c) => c.name.startsWith('konjir_oauth_'))).toHaveLength(2);

    // The earlier one first, then the later: each lands at its own app.
    await earlier.getByRole('button', { name: 'Allow' }).click();
    await earlier.waitForURL((u) => u.toString().startsWith(first.url));
    await later.getByRole('button', { name: 'Allow' }).click();
    await later.waitForURL((u) => u.toString().startsWith(second.url));
    expect(seen.flat()).toStrictEqual([]);
    expect([first.hits.map((h) => h.searchParams.get('state')), second.hits.map((h) => h.searchParams.get('state'))]).toStrictEqual([['first'], ['second']]);
    await one.finish(first.hits[0]);
    await two.finish(second.hits[0]);
    expect((await context.cookies(`${SIGNIN}/oauth/consent`)).filter((c) => c.name.startsWith('konjir_oauth_'))).toStrictEqual([]);
  } finally {
    await first.close();
    await second.close();
  }
});

test('a consent submitted after the sign-in expired says so, and how long a sign-in lasts', async ({ page }) => {
  const app = await listener();
  try {
    // A Kolab whose sign-ins last SHORT_TTL_S seconds, binding cookie and all.
    const c = await begin(SIGNIN_SHORT, app.url, 'late');
    await page.goto(c.url.toString());
    await consentShown(page);
    await page.waitForTimeout((SHORT_TTL_S + 1) * 1000);
    // By now the browser has dropped the cookie too: Kolab tells by the form's own token.
    expect((await page.context().cookies(`${SIGNIN_SHORT}/oauth/consent`)).filter((k) => k.name.startsWith('konjir_oauth_'))).toStrictEqual([]);
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page.getByText(`This sign-in expired: it lasts ${SHORT_TTL_S} seconds from when the app opened it.`)).toBeVisible();
    expect(app.hits).toStrictEqual([]);
  } finally {
    await app.close();
  }
});
