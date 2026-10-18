/**
 * `konjir login`: one command connects a shell harness to Kolab, with no admin (W3.4, D55). The CLI
 * signs in as any MCP client does, through Kolab's OAuth 2.1 authorization server: it registers
 * itself (RFC 7591) as a public client whose redirect is a loopback address (RFC 8252), opens the
 * browser at Kolab's sign-in, where the person signs in with GitHub and chooses who the CLI works as
 * (an agent of theirs by default, D30), in which kolab and role, and receives the code on a port of
 * its own on 127.0.0.1. Its tokens are kept in a file only the person can read, and every later
 * `konjir` command uses them, refreshing the 15-minute access token as it expires. `konjir logout`
 * revokes the grant and forgets them.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Client, StreamableHTTPClientTransport, UnauthorizedError,
  type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

/** What the CLI keeps for one Kolab: its registration, its tokens and what it discovered. */
interface Saved { client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens; discovery?: OAuthDiscoveryState }

/** The registered redirect: a loopback address, whose port Kolab lets change at each sign-in (RFC 8252 §7.3). */
const REDIRECT = 'http://127.0.0.1/callback';

/**
 * Where the CLI keeps its sign-ins: KONJIR_CREDENTIALS, or credentials.json in the konjir folder of
 * $XDG_CONFIG_HOME (~/.config by default), keyed by the Kolab's MCP URL. The folder is the person's
 * alone (0700) and the file too (0600): it holds a refresh token, which is a bearer secret.
 */
export function credentialsPath(env: Record<string, string | undefined> = process.env): string {
  if (env.KONJIR_CREDENTIALS) return env.KONJIR_CREDENTIALS;
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'konjir', 'credentials.json');
}

class Store {
  constructor(readonly path: string) {}
  private all(): Record<string, Saved> {
    if (!existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, Saved>; } catch { return {}; }
  }
  get(url: string): Saved { return this.all()[url] ?? {}; }
  set(url: string, change: (s: Saved) => Saved | undefined) {
    const all = this.all();
    const next = change(all[url] ?? {});
    if (next) all[url] = next; else delete all[url];
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Written whole, then moved into place, so another konjir reading it never sees half a file.
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

/**
 * The CLI as an OAuth client of one Kolab, its state in the credentials file. Interactive (during
 * `konjir login`), it sends the person to the browser; otherwise, a sign-in that is needed again is
 * an error saying to run `konjir login`.
 */
export class StoredLogin implements OAuthClientProvider {
  private readonly store: Store;
  private verifier = '';
  readonly expectedState = randomBytes(24).toString('base64url');
  constructor(readonly url: string, private readonly opts: { path?: string; redirectUrl?: string; onAuthorize?: (u: URL) => void | Promise<void> } = {}) {
    this.store = new Store(opts.path ?? credentialsPath());
  }
  get redirectUrl() { return this.opts.redirectUrl ?? REDIRECT; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'konjir CLI', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() { return this.expectedState; }
  clientInformation() { return this.store.get(this.url).client; }
  saveClientInformation(client: StoredOAuthClientInformation) { this.store.set(this.url, (s) => ({ ...s, client })); }
  // Read afresh each time, so a refresh another konjir made is seen.
  tokens() { return this.store.get(this.url).tokens; }
  saveTokens(tokens: StoredOAuthTokens) { this.store.set(this.url, (s) => ({ ...s, tokens })); }
  async redirectToAuthorization(u: URL) {
    if (!this.opts.onAuthorize) throw new Error(`your sign-in to ${this.url} has ended or was revoked: run konjir login`);
    await this.opts.onAuthorize(u);
  }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  saveDiscoveryState(discovery: OAuthDiscoveryState) { this.store.set(this.url, (s) => ({ ...s, discovery })); }
  discoveryState() { return this.store.get(this.url).discovery; }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'verifier') { this.verifier = ''; return; }
    this.store.set(this.url, (s) => {
      if (scope === 'all') return undefined;
      const { client, tokens, discovery } = s;
      return { client: scope === 'client' ? undefined : client, tokens: scope === 'tokens' ? undefined : tokens, discovery: scope === 'discovery' ? undefined : discovery };
    });
  }
  /** Whether there is a sign-in to use. */
  get signedIn() { return !!this.store.get(this.url).tokens?.refresh_token; }
  forgetTokens() { this.store.set(this.url, (s) => ({ ...s, tokens: undefined })); }
  forget() { this.store.set(this.url, () => undefined); }
}

/** Opens a URL in the person's browser, best effort; the URL is printed either way. */
function openBrowser(u: URL) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [u.toString()]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', u.toString()]] : ['xdg-open', [u.toString()]];
  try { spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref(); } catch { /* printed below */ }
}

/** The page the browser lands on once the code is back: it says to return to the terminal, and loads nothing. */
const done = (ok: boolean, text: string) => `<!doctype html><meta charset="utf-8"><title>konjir</title><p>${ok ? 'Signed in.' : 'Sign-in stopped.'} ${text.replace(/[&<>"']/g, '')}</p>`;

/**
 * Signs in (`konjir login`): `scope` may preselect the kolab and role on Kolab's page
 * (`konjir kolab:<name> role:<role>`). `open` is how the person's browser is sent to Kolab; by
 * default it is opened, and the URL printed to `log`. Resolves once the CLI's session works, with
 * who it is.
 */
export async function login(url: string, opts: { path?: string; scope?: string; open?: (u: URL) => void | Promise<void>; log?: (line: string) => void; timeoutMs?: number } = {}) {
  const log = opts.log ?? ((l: string) => console.error(l));
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    const provider = new StoredLogin(url, {
      path: opts.path, redirectUrl: `http://127.0.0.1:${port}/callback`,
      onAuthorize: async (u) => {
        // What to preselect on Kolab's page: the kolab and role (Kolab reads them from the scope).
        if (opts.scope) u.searchParams.set('scope', opts.scope);
        log(`Opening your browser to sign in to Kolab. If it doesn't open, go to:\n  ${u.toString()}`);
        await (opts.open ?? openBrowser)(u);
      },
    });
    provider.forgetTokens();   // a fresh sign-in, whatever was kept before
    const back = new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the sign-in took too long; run konjir login again')), opts.timeoutMs ?? 5 * 60_000);
      server.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
        // Only the answer to this sign-in: its state, which only this process knows.
        if (u.searchParams.get('state') !== provider.expectedState) { res.writeHead(400, { 'content-type': 'text/html' }).end(done(false, 'That answer was for another sign-in.')); return; }
        clearTimeout(timer);
        const error = u.searchParams.get('error');
        res.writeHead(error ? 400 : 200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
          .end(done(!error, error ? 'Return to your terminal.' : 'You can close this tab and return to your terminal.'));
        if (error) reject(new Error(`Kolab didn't sign you in: ${u.searchParams.get('error_description') ?? error}`));
        else resolve(u.searchParams);
      });
    });
    back.catch(() => undefined);
    const first = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
    const probe = new Client({ name: 'konjir-cli', version: '0.6.0' }, { versionNegotiation: { mode: 'auto' } });
    try {
      await probe.connect(first);
      await probe.close();
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      await first.finishAuth(await back);
    }
    const client = new Client({ name: 'konjir-cli', version: '0.6.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: new StoredLogin(url, { path: opts.path }) }));
    try {
      const r = await client.callTool({ name: 'konjir_whoami', arguments: {} });
      return r.structuredContent as { actor: string; kind: string; owner: string | null; kolab: string; role: string; layer: string };
    } finally {
      await client.close();
    }
  } finally {
    server.close();
  }
}

/** `konjir logout`: revokes the grant at Kolab (RFC 7009) and forgets the sign-in. Says whether there was one. */
export async function logout(url: string, opts: { path?: string } = {}): Promise<boolean> {
  const provider = new StoredLogin(url, { path: opts.path });
  const saved = { tokens: provider.tokens(), client: provider.clientInformation() };
  if (!saved.tokens) { provider.forget(); return false; }
  // Kolab is its own authorization server, on its own origin: the refresh token goes nowhere else.
  const endpoint = new URL('/oauth/revoke', url).toString();
  if (saved.client?.client_id && saved.tokens.refresh_token) {
    await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: saved.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: saved.client.client_id }).toString(),
    }).catch(() => undefined);
  }
  provider.forget();
  return true;
}
