/**
 * `konjir login`: one command connects a shell harness to Kolab, with no admin (W3.4, D55). The CLI
 * signs in as any MCP client does, through Kolab's OAuth 2.1 authorization server: it registers
 * itself (RFC 7591) as a public client whose redirect is a loopback address (RFC 8252), opens the
 * browser at Kolab's sign-in, where the person signs in with GitHub and chooses who the CLI works as
 * (an agent of theirs by default, D30), in which kolab and role, and receives the code on a port of
 * its own on 127.0.0.1. Its tokens are kept in a file only the person can read, and every later
 * `konjir` command uses them, refreshing the 15-minute access token as it expires. `konjir logout`
 * revokes the grant and forgets them.
 *
 * Several konjir processes may share the file at once (a `konjir watch` beside other commands, a
 * harness's parallel calls). Kolab's refresh tokens rotate, and one used twice is refused, so the
 * file has a lock: every write takes it, and a refresh holds it from reading the refresh token to
 * saving the next one. A process that finds its access token refused while another refreshed waits
 * for the lock and uses the new token, rather than refresh again, and tokens are forgotten only if
 * they are still the ones that failed.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Client, StreamableHTTPClientTransport, UnauthorizedError,
  type FetchLike, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A lock held longer than this is taken for a crashed holder's, and broken. */
const LOCK_STALE_MS = 30_000;
/** How long to wait for another konjir's lock before giving up. */
const LOCK_WAIT_MS = 40_000;

/** Locks this process holds, removed if it exits holding them. */
const held = new Map<string, string>();
process.once('exit', () => { for (const [path, owner] of held) { try { if (readFileSync(path, 'utf8') === owner) unlinkSync(path); } catch { /* gone */ } } });

/**
 * A lock file beside the credentials, `<file>.lock`, made with O_EXCL: it holds its owner's id, so
 * only that owner removes it. Re-entrant for one owner.
 */
class FileLock {
  constructor(readonly path: string) {}
  async acquire(owner: string) {
    if (held.get(this.path) === owner) return;
    const end = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const fd = openSync(this.path, 'wx', 0o600);
        try { writeSync(fd, owner); } finally { closeSync(fd); }
        held.set(this.path, owner);
        return;
      } catch (e) {
        if ((e as { code?: string }).code !== 'EEXIST') throw e;
      }
      try {
        if (Date.now() - statSync(this.path).mtimeMs > LOCK_STALE_MS) { unlinkSync(this.path); continue; }
      } catch { continue; }   // released meanwhile
      if (Date.now() > end) throw new Error(`another konjir has held ${this.path} for too long; if none is running, remove that file`);
      await sleep(15 + Math.random() * 35);
    }
  }
  release(owner: string) {
    if (held.get(this.path) !== owner) return;
    held.delete(this.path);
    try { if (readFileSync(this.path, 'utf8') === owner) unlinkSync(this.path); } catch { /* gone */ }
  }
  holds(owner: string) { return held.get(this.path) === owner; }
}

class Store {
  readonly lock: FileLock;
  constructor(readonly path: string) { this.lock = new FileLock(`${path}.lock`); }
  private all(): Record<string, Saved> {
    if (!existsSync(this.path)) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.path, 'utf8')); } catch { parsed = undefined; }
    // Never overwritten when it can't be read: it may hold other Kolabs' sign-ins.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${this.path} isn't konjir's credentials (not valid JSON), so konjir won't touch it: fix it or move it away, then run konjir login`);
    }
    return parsed as Record<string, Saved>;
  }
  get(url: string): Saved { return this.all()[url] ?? {}; }
  /** Changes one Kolab's entry, under the lock: `owner`'s if it holds it, or taken for this write alone. */
  async set(url: string, change: (s: Saved) => Saved | undefined, owner?: string) {
    const own = owner !== undefined && this.lock.holds(owner);
    const me = own ? owner : `w_${randomBytes(12).toString('hex')}`;
    if (!own) await this.lock.acquire(me);
    try {
      const all = this.all();
      const next = change(all[url] ?? {});
      if (next) all[url] = next; else delete all[url];
      const dir = dirname(this.path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // A folder made before, more open, is closed to others too.
      try { chmodSync(dir, 0o700); } catch { /* not ours to change; the file is 0600 */ }
      // Written whole to a new file of a random name (O_EXCL: never through a link someone left there), then moved into place.
      const tmp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.path);
    } finally {
      if (!own) this.lock.release(me);
    }
  }
}

/** The bearer token a request carries, if any. */
function bearerOf(init?: RequestInit): string | undefined {
  const v = new Headers(init?.headers).get('authorization');
  return v?.startsWith('Bearer ') ? v.slice(7) : undefined;
}

/**
 * The CLI as an OAuth client of one Kolab, its state in the credentials file. Interactive (during
 * `konjir login`), it sends the person to the browser; otherwise, a sign-in that is needed again is
 * an error saying to run `konjir login`.
 */
export class StoredLogin implements OAuthClientProvider {
  private readonly store: Store;
  private verifier = '';
  /** This instance's id on the lock. */
  private readonly owner = `p${process.pid}_${randomBytes(12).toString('hex')}`;
  /** The refresh token this instance last read to refresh with: the only one it may forget. */
  private refreshing?: string;
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
  saveClientInformation(client: StoredOAuthClientInformation) { return this.store.set(this.url, (s) => ({ ...s, client }), this.owner); }
  /**
   * Read afresh each time, so a refresh another konjir made is seen. Asked by the authorization flow
   * (with `ctx`), that is, about to refresh: the lock is taken first, and held until the new tokens
   * are saved, so no two konjir refresh with one refresh token.
   */
  async tokens(ctx?: unknown) {
    if (ctx === undefined) return this.store.get(this.url).tokens;
    if (!this.store.get(this.url).tokens?.refresh_token) return this.store.get(this.url).tokens;
    await this.store.lock.acquire(this.owner);
    const t = this.store.get(this.url).tokens;
    this.refreshing = t?.refresh_token;
    if (!t) this.store.lock.release(this.owner);
    return t;
  }
  async saveTokens(tokens: StoredOAuthTokens) {
    try {
      await this.store.set(this.url, (s) => ({ ...s, tokens }), this.owner);
    } finally {
      this.refreshing = undefined;
      this.store.lock.release(this.owner);
    }
  }
  async redirectToAuthorization(u: URL) {
    this.store.lock.release(this.owner);
    if (!this.opts.onAuthorize) throw new Error(`your sign-in to ${this.url} has ended or was revoked: run konjir login`);
    await this.opts.onAuthorize(u);
  }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  saveDiscoveryState(discovery: OAuthDiscoveryState) { return this.store.set(this.url, (s) => ({ ...s, discovery }), this.owner); }
  discoveryState() { return this.store.get(this.url).discovery; }
  /**
   * What Kolab refused, forgotten: tokens only if they are still the ones this instance refreshed
   * with (compare and swap), so another konjir's newer tokens are kept, and used on the retry.
   */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'verifier') { this.verifier = ''; return; }
    const failed = this.refreshing;
    return this.store.set(this.url, (s) => {
      if (scope === 'all') return undefined;
      const { client, tokens, discovery } = s;
      const dropTokens = scope === 'client' || (scope === 'tokens' && (failed === undefined || tokens?.refresh_token === failed));
      return { client: scope === 'client' ? undefined : client, tokens: dropTokens ? undefined : tokens, discovery: scope === 'discovery' ? undefined : discovery };
    }, this.owner);
  }
  /**
   * The fetch for this sign-in's MCP requests: one whose access token was refused while another
   * konjir refreshed waits for that refresh to finish (the lock) and is sent again with the new
   * token, rather than refresh once more.
   */
  get fetch(): FetchLike {
    return async (url, init) => {
      const res = await fetch(url, init);
      const sent = bearerOf(init);
      if (res.status !== 401 || !sent) return res;
      const waiter = `f_${randomBytes(12).toString('hex')}`;
      await this.store.lock.acquire(waiter);
      this.store.lock.release(waiter);
      const now = this.store.get(this.url).tokens?.access_token;
      if (!now || now === sent) return res;
      await res.text().catch(() => undefined);
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${now}`);
      return fetch(url, { ...init, headers });
    };
  }
  /** Whether there is a sign-in to use. */
  get signedIn() { return !!this.store.get(this.url).tokens?.refresh_token; }
  saved() { return this.store.get(this.url); }
  forgetTokens() { return this.store.set(this.url, (s) => ({ ...s, tokens: undefined })); }
  forget() { return this.store.set(this.url, () => undefined); }
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
 * Revokes a kept sign-in at Kolab's own /oauth/revoke (RFC 7009): its refresh token, which revokes
 * the grant, and its access token. Throws, saying why, if Kolab couldn't be reached or refused.
 */
async function revoke(url: string, saved: Saved): Promise<'revoked' | 'nothing'> {
  const refresh = saved.tokens?.refresh_token;
  const client = saved.client?.client_id;
  if (!refresh || !client) return 'nothing';
  // Kolab is its own authorization server, on its own origin: the tokens go nowhere else.
  const endpoint = new URL('/oauth/revoke', url).toString();
  const post = (token: string, hint: string) => fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, token_type_hint: hint, client_id: client }).toString(),
  });
  let res: Response;
  try { res = await post(refresh, 'refresh_token'); } catch (e) {
    throw new Error(`couldn't reach Kolab at ${endpoint} (${String((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message)})`);
  }
  if (!res.ok) throw new Error(`Kolab answered ${res.status} at ${endpoint}`);
  if (saved.tokens?.access_token) await post(saved.tokens.access_token, 'access_token').catch(() => undefined);
  return 'revoked';
}

/**
 * Signs in (`konjir login`): `scope` may preselect the kolab and role on Kolab's page
 * (`konjir kolab:<name> role:<role>`). `open` is how the person's browser is sent to Kolab; by
 * default it is opened, and the URL printed to `log`. A sign-in kept from before is revoked first,
 * so no grant is left behind. Resolves once the CLI's session works, with who it is.
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
    // A fresh sign-in, whatever was kept before: the old one revoked first, so its grant doesn't linger.
    const before = provider.saved();
    if (before.tokens) {
      await revoke(url, before).catch((e: Error) => log(`warning: the sign-in kept from before wasn't revoked: ${e.message}. It lapses within 30 days unused.`));
      await provider.forgetTokens();
    }
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
    const kept = new StoredLogin(url, { path: opts.path });
    const client = new Client({ name: 'konjir-cli', version: '0.6.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: kept, fetch: kept.fetch }));
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

/**
 * `konjir logout`: revokes the grant at Kolab (RFC 7009), then forgets the sign-in. If Kolab can't
 * be reached, or refuses, the sign-in is kept, so the person can try again, and this throws, saying
 * so; with `forget`, it is forgotten anyway, unrevoked, and that is said too.
 */
export async function logout(url: string, opts: { path?: string; forget?: boolean } = {}): Promise<{ had: boolean; revoked: boolean }> {
  const provider = new StoredLogin(url, { path: opts.path });
  const saved = provider.saved();
  if (!saved.tokens) { await provider.forget(); return { had: false, revoked: false }; }
  let revoked = false;
  try {
    revoked = (await revoke(url, saved)) === 'revoked';
  } catch (e) {
    if (!opts.forget) throw new Error(`${(e as Error).message}, so your sign-in to ${url} wasn't revoked and is still kept: run konjir logout again, or konjir logout --forget to drop it anyway`);
  }
  await provider.forget();
  return { had: true, revoked };
}
