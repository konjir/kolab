// `konjir connect opencode` from a real browser (W3.7, D59; one page, Lee's instruction of
// 2026-11-01): Ann, new here, signs in on Kolab's setup page, which names her new kolab and two new
// agents with nothing to choose, and clicks Allow; konjir connect writes opencode.json; then each
// entry signs in as OpenCode's `opencode mcp auth` does (the MCP
// SDK's auth(), the entry's oauth.scope as its client metadata's scope, a loopback listener for the
// code), and Kolab's page arrives with that entry's agent, kolab and role chosen: she only clicks
// Allow. Needs the konjir CLI built (`npx nx run konjir:build`), which this imports.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auth, type OAuthClientProvider, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import { SIGNIN_ANN } from '../playwright.config.js';

// The konjir CLI, as it is built: loaded at run time, so the web project's type-check stays its own.
interface Client { close(): Promise<void> }
interface Cli {
  connectHarness(opts: Record<string, unknown>, io: Record<string, unknown>): Promise<unknown>;
  parseAgents(values: string[]): unknown;
  setup(url: string, opts: { scope: string; mint: boolean; clientName: string; log: (l: string) => void; open: (u: URL) => Promise<void> }): Promise<unknown>;
  connect(url: string, token: string): Promise<Client>;
  call(client: Client, verb: string, args?: Record<string, unknown>): Promise<unknown>;
}
const KONJIR: string = 'konjir';
const cli = () => import(KONJIR) as Promise<Cli>;

/** A page locked to one agent (D97): its fixed fields, and no choices at all. */
const locked = async (page: Page) => {
  await expect(page.locator('input[type=radio]')).toHaveCount(0);
  return page.$$eval('input[type=hidden][name=as], input[type=hidden][name=kolab], input[type=hidden][name=role]', (els) => els.map((e) => (e as HTMLInputElement).value));
};

/** OpenCode's loopback listener for the code. */
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

/** `opencode mcp auth <name>` in `cwd`, its tokens kept in OpenCode's own store (`store`), never the project. */
async function opencodeAuth(page: Page, cwd: string, name: string, store: Map<string, StoredOAuthTokens>, shown: Map<string, string[]>): Promise<number> {
  const entry = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')).mcp[name] as { url: string; oauth?: { scope?: string } };
  const app = await listener();
  try {
    let info: StoredOAuthClientInformation | undefined;
    let verifier = '';
    let opened: URL | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() { return app.url; },
      get clientMetadata() {
        return { redirect_uris: [app.url], client_name: 'OpenCode', client_uri: 'https://opencode.ai', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(entry.oauth?.scope ? { scope: entry.oauth.scope } : {}) };
      },
      state: () => `state-${name}`,
      clientInformation: () => info,
      saveClientInformation: (i) => { info = i; },
      tokens: () => store.get(name),
      saveTokens: (t) => { store.set(name, t); },
      redirectToAuthorization: (u) => { opened = u; },
      saveCodeVerifier: (v) => { verifier = v; },
      codeVerifier: () => verifier,
    };
    if (await auth(provider, { serverUrl: entry.url }) !== 'REDIRECT') return 1;
    await page.goto(opened!.toString());
    // The page is locked to the entry's agent, and its heading names it.
    await expect(page.getByRole('heading', { name: `Sign in as ann-${name.replace('konjir-', '')}` })).toBeVisible();
    shown.set(name, await locked(page));
    await page.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL((u) => u.toString().startsWith(app.url));
    const back = app.hits[0];
    return await auth(provider, { serverUrl: entry.url, authorizationCode: back.searchParams.get('code')!, iss: back.searchParams.get('iss') ?? undefined }) === 'AUTHORIZED' ? 0 : 1;
  } finally {
    await app.close();
  }
}

test('konjir connect opencode: Ann allows one setup page, which makes her kolab and two agents, and each entry then signs in as its own agent on a page locked to it', async ({ page }) => {
  const { call, connect, connectHarness, parseAgents, setup } = await cli();
  process.env.KONJIR_CREDENTIALS = join(mkdtempSync(join(tmpdir(), 'konjir-e2e-')), 'credentials.json');
  const mcp = `${SIGNIN_ANN}/mcp`;
  const project = mkdtempSync(join(tmpdir(), 'konjir-e2e-project-'));
  const store = new Map<string, StoredOAuthTokens>();
  const shown = new Map<string, string[]>();
  const lines: string[] = [];

  await connectHarness({ harness: 'opencode', url: mcp, kolab: 'anns', agents: parseAgents([]), global: false, force: false, auth: true, cwd: project, env: {} }, {
    log: (l: string) => lines.push(l),
    run: (_cmd: string, args: string[], { cwd }: { cwd: string }) => opencodeAuth(page, cwd, args[2], store, shown),
    // The one setup page: new here, her kolab and both agents are made on it. Nothing to choose.
    setup: (r: { url: string; scope: string; mint: boolean; clientName: string }) => setup(r.url, {
      ...r, log: (l: string) => lines.push(l),
      open: async (u) => {
        await page.goto(u.toString());
        await expect(page.getByRole('heading', { name: 'Set up 2 agents in anns' })).toBeVisible();
        await expect(page.getByText('New: made now, private, yours')).toBeVisible();
        await expect(page.locator('input[type=radio], input[type=text]')).toHaveCount(0);
        await page.getByRole('button', { name: 'Allow' }).click();
      },
    }),
  });

  expect(shown.get('konjir-product')).toStrictEqual(['agent:ann-product', 'kolab:anns', 'product']);
  expect(shown.get('konjir-engineer')).toStrictEqual(['agent:ann-engineer', 'kolab:anns', 'engineer']);
  expect(lines).toContain('Connected: each entry works as its own agent in anns.');

  const product = await connect(mcp, store.get('konjir-product')!.access_token);
  const engineer = await connect(mcp, store.get('konjir-engineer')!.access_token);
  try {
    expect(await call(product, 'whoami')).toMatchObject({ actor: 'ann-product', owner: 'ann', kolab: 'anns', role: 'product' });
    expect(await call(engineer, 'whoami')).toMatchObject({ actor: 'ann-engineer', owner: 'ann', kolab: 'anns', role: 'engineer' });
  } finally {
    await product.close();
    await engineer.close();
  }
  // No sign-in as Ann is kept anywhere: the setup's token was used once, then revoked.
  expect(existsSync(process.env.KONJIR_CREDENTIALS!)).toBe(false);
  const text = readFileSync(join(project, 'opencode.json'), 'utf8');
  for (const t of store.values()) { expect(text).not.toContain(t.access_token); expect(text).not.toContain(t.refresh_token!); }
});
