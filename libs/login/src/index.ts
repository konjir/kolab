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
 *
 * The channel bridge (W3.5) is a konjir process like any other here: it signs in through this same
 * client, keeps its sign-in in the same file under the same lock, and so shares one sign-in, one
 * grant and one session with the CLI for the same MCP URL.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { escapeHtml, standalonePage, standalonePageCss } from '@konjir/brand';
import {
  Client, StreamableHTTPClientTransport, UnauthorizedError,
  type FetchLike, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

/** What the CLI keeps for one Kolab: its registration, its tokens and what it discovered. */
interface Saved { client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens; discovery?: OAuthDiscoveryState }

/** A URL fit to print: no credentials, no query, no fragment. */
export function safeUrl(url: string | URL): string {
  try {
    const u = new URL(String(url));
    u.username = ''; u.password = ''; u.search = ''; u.hash = '';
    return u.toString();
  } catch {
    return '(not a URL)';
  }
}

/** Whether a URL's host is this machine: 127.0.0.0/8, ::1 or localhost. */
export function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Refuses a Kolab URL a sign-in can't safely use: anything but https, or http to this machine
 * (loopback, for local development). Over http to another host a network could read the refresh
 * token, which lasts 30 days, and answer Kolab's discovery in its place.
 */
export function checkKolabUrl(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`${safeUrl(url)} isn't a URL: set KONJIR_URL or --url to Kolab's MCP URL, such as https://kolab.konjir.com/mcp`); }
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && isLoopback(u.hostname)) return u;
  if (u.protocol === 'http:') throw new Error(`konjir signs in to Kolab only over https, or http on this machine: ${safeUrl(url)} is http to another host, where the network could read your sign-in. Use its https URL`);
  throw new Error(`konjir signs in to Kolab only over https, or http on this machine: ${safeUrl(url)} is ${u.protocol.replace(/:$/, '')}`);
}

/**
 * Refuses a sign-in link that isn't Kolab's own: Kolab is its own authorization server, so its
 * authorize endpoint is <the MCP URL's origin>/oauth/authorize, over https or http on loopback.
 * Anything else (another host, another path, a file: or custom scheme), which only a hostile or
 * impersonated Kolab would name, is never opened or shown.
 */
export function checkAuthorizeUrl(u: URL, kolabUrl: string): URL {
  const kolab = checkKolabUrl(kolabUrl);
  const scheme = u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname));
  if (!scheme || u.origin !== kolab.origin || u.pathname !== '/oauth/authorize' || u.username || u.password) {
    throw new Error(`Kolab at ${safeUrl(kolabUrl)} sent its sign-in to ${safeUrl(u)}, which isn't its own ${kolab.origin}/oauth/authorize, so konjir opens nothing. Check KONJIR_URL`);
  }
  return u;
}

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

/**
 * The MCP URLs the credentials file keeps a sign-in for (tokens kept), in the file's order: what
 * konjir uses when no URL is given (D106). Read without the lock, to choose a URL only; a file that
 * isn't there keeps none, and one that can't be read is left for StoredLogin to name.
 */
export function keptSignIns(path: string = credentialsPath()): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, Saved>).filter(([, s]) => !!s && typeof s === 'object' && !!s.tokens).map(([url]) => url);
}

/**
 * Where one agent's own sign-in is kept, apart from the CLI's: `agents/<agent>.json` beside the
 * credentials file. `konjir connect claude` signs each Konjir channel entry in there (W3.8), and the
 * channel bridge started with KONJIR_AGENT uses it, so two entries, each its own agent, never share
 * one sign-in. The agent's id is a Kolab actor id, checked, so it can't name a path elsewhere.
 */
export function agentCredentialsPath(agent: string, env: Record<string, string | undefined> = process.env): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent)) throw new Error(`KONJIR_AGENT ${JSON.stringify(agent)} isn't an agent's id: lowercase letters, digits and -`);
  return join(dirname(credentialsPath(env)), 'agents', `${agent}.json`);
}

/**
 * The agent's credentials file, its folder made ready: `agents/` is konjir's own, whatever folder
 * KONJIR_CREDENTIALS names, so it is made 0700, and refused if it is a symbolic link, belongs to
 * someone else, or others may write in it (another local user could then replace the agent's file).
 */
export function agentCredentials(agent: string, env: Record<string, string | undefined> = process.env): string {
  const file = agentCredentialsPath(agent, env);
  const dir = dirname(file);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (codeOf(e) !== 'EEXIST') throw e; }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} isn't a folder of konjir's (it is a symbolic link, or not a folder), so konjir won't keep an agent's sign-in there: remove it`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to someone else, so konjir won't keep an agent's sign-in there: remove it, or set KONJIR_CREDENTIALS to a file in a folder of your own`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return file;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A lock untouched for longer than this is taken for a crashed or frozen holder's, and broken. */
const LOCK_STALE_MS = 30_000;
/** How often a holder touches its lock, so a long refresh never reads as stale. */
const LOCK_TOUCH_MS = 10_000;
/** How long to wait for another konjir's lock before giving up, by default. */
const LOCK_WAIT_MS = 40_000;
/**
 * The longest one hold may last: a refresh takes well under a second. Past it the heartbeat stops
 * and the lock is let go, so a hold leaked by an error that escaped the SDK (in a long `konjir
 * watch`, say) never keeps other konjir waiting.
 */
const LOCK_MAX_HOLD_MS = 30_000;
// Staleness compares this machine's clock with the file's mtime: the credentials folder is assumed
// local. On a network mount with clocks more than LOCK_STALE_MS apart, a live lock can read as stale.

const codeOf = (e: unknown) => (e as { code?: string } | undefined)?.code;

/** Locks this process holds, by path: the owner's id, and the timer that keeps it fresh. Removed if it exits holding them. */
const held = new Map<string, { owner: string; touch: ReturnType<typeof setInterval> }>();
process.once('exit', () => { for (const [path, h] of held) { try { if (readFileSync(path, 'utf8') === h.owner) unlinkSync(path); } catch { /* gone */ } } });

/**
 * A lock file beside the credentials, `<file>.lock`, made with O_EXCL. It holds its owner's id, a
 * random nonce, and only that owner removes it. Holding it is checked against the file itself, not
 * only this process's memory, so a holder whose lock was broken (it stalled past LOCK_STALE_MS)
 * knows. Re-entrant for one owner. A lock path that is a symbolic link is refused, never followed.
 */
export class FileLock {
  constructor(readonly path: string, private readonly waitMs = LOCK_WAIT_MS, private readonly maxHoldMs = LOCK_MAX_HOLD_MS) {}

  /** The lock's owner as the file says, or undefined when there is none; throws on a symbolic link. */
  private ownerOnDisk(): string | undefined {
    let st;
    try { st = lstatSync(this.path); } catch (e) { if (codeOf(e) === 'ENOENT') return undefined; throw e; }
    if (st.isSymbolicLink()) throw new Error(`${this.path} is a symbolic link, so konjir won't use it as its lock: remove it`);
    try { return readFileSync(this.path, 'utf8'); } catch (e) { if (codeOf(e) === 'ENOENT') return undefined; throw e; }
  }

  async acquire(owner: string) {
    if (this.holds(owner)) return;
    const end = Date.now() + this.waitMs;
    let why = 'another konjir holds it';
    for (;;) {
      try {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const fd = openSync(this.path, 'wx', 0o600);
        try { writeSync(fd, owner); } finally { closeSync(fd); }
        const since = Date.now();
        const touch = setInterval(() => {
          if (Date.now() - since >= this.maxHoldMs) { this.release(owner); return; }   // held too long: let go
          try { if (this.holds(owner)) { const t = new Date(); utimesSync(this.path, t, t); } } catch { /* checked when it matters */ }
        }, Math.min(LOCK_TOUCH_MS, this.maxHoldMs));
        touch.unref();
        const before = held.get(this.path);
        if (before) clearInterval(before.touch);   // a lock of this process's that was broken, and taken anew
        held.set(this.path, { owner, touch });
        return;
      } catch (e) {
        // On Windows a file pending delete answers EPERM, EACCES or EBUSY for a while: wait, as for EEXIST.
        const pending = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(codeOf(e) ?? '');
        if (pending) {
          if (Date.now() > end) throw new Error(`konjir couldn't take ${this.path} (${codeOf(e)}): if no konjir is running, remove that file`);
          await sleep(15 + Math.random() * 35);
          continue;
        }
        if (codeOf(e) !== 'EEXIST') throw new Error(`konjir couldn't take ${this.path} (${codeOf(e) ?? e}); check that folder is yours to write in`);
      }
      // Someone holds it. Only ENOENT means it was released meanwhile: anything else waits, until the deadline.
      let st;
      try { st = lstatSync(this.path); } catch (e) {
        if (codeOf(e) === 'ENOENT') continue;
        why = `konjir can't read it (${codeOf(e) ?? e})`;
      }
      if (st?.isSymbolicLink()) throw new Error(`${this.path} is a symbolic link, so konjir won't use it as its lock: remove it`);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        const broke = this.breakStale(st.mtimeMs);
        if (broke === true) continue;
        if (broke) why = broke;
      }
      if (Date.now() > end) throw new Error(`konjir couldn't take ${this.path}: ${why}. If no konjir is running, remove that file`);
      await sleep(15 + Math.random() * 35);
    }
  }

  /**
   * Breaks a stale lock atomically: moves it aside to a name of its own, then checks that what it
   * moved is the lock that was stale. One that turns out fresh (taken anew meanwhile) is put back if
   * the place is still free. Returns true when the path is free to try again, or why it couldn't be.
   */
  private breakStale(staleMtime: number): true | string | undefined {
    const aside = `${this.path}.${randomBytes(8).toString('hex')}.stale`;
    try { renameSync(this.path, aside); } catch (e) {
      if (codeOf(e) === 'ENOENT') return true;
      return `its stale lock can't be removed (${codeOf(e) ?? e})`;
    }
    let moved;
    try { moved = lstatSync(aside); } catch (e) { return `konjir moved its stale lock aside to ${aside} but can't read it (${codeOf(e) ?? e})`; }
    if (moved.mtimeMs !== staleMtime) {
      // A fresh lock was moved: give it back, without ever replacing one made since. A rare race
      // remains: a third konjir may take the free place between the move and the link, and then it
      // and the moved lock's holder both hold it until the holder next checks (it may already have
      // read the tokens). Kolab's 10 s refresh grace usually limits that to "run konjir login".
      try {
        linkSync(aside, this.path);
      } catch (e) {
        if (codeOf(e) === 'EEXIST') { try { unlinkSync(aside); } catch { /* left aside */ } return true; }
        // No hard links on this filesystem (FAT, some SMB or FUSE mounts): move it back if the place
        // is still free; never delete it, since it is a live holder's lock.
        try { lstatSync(this.path); } catch (f) {
          if (codeOf(f) === 'ENOENT') { try { renameSync(aside, this.path); return true; } catch { /* below */ } }
        }
        return `konjir moved a live lock aside to ${aside} and couldn't put it back (${codeOf(e) ?? e})`;
      }
    }
    // Left behind only by a crash between the move and this, or a failed unlink.
    try { unlinkSync(aside); } catch { /* best effort */ }
    return true;
  }

  release(owner: string) {
    const h = held.get(this.path);
    if (h?.owner !== owner) return;
    clearInterval(h.touch);
    held.delete(this.path);
    try { if (this.ownerOnDisk() === owner) unlinkSync(this.path); } catch { /* gone */ }
  }

  /** Whether `owner` holds the lock now: in this process's memory and in the file. */
  holds(owner: string) {
    if (held.get(this.path)?.owner !== owner) return false;
    try {
      if (this.ownerOnDisk() === owner) return true;
    } catch { /* not ours to trust */ }
    // Broken by another konjir while this one stalled: no longer held.
    const h = held.get(this.path)!;
    clearInterval(h.touch);
    held.delete(this.path);
    return false;
  }

  /** Whether `owner` thought it held the lock (this process's memory), whatever the file says now. */
  thinksHeld(owner: string) { return held.get(this.path)?.owner === owner; }
}

class Store {
  readonly lock: FileLock;
  /**
   * `managed`: the folder is konjir's own default one, `…/konjir`, which it keeps at 0700. A folder
   * named through KONJIR_CREDENTIALS (or a path given) is the person's: never changed, only warned of
   * when others may write in it.
   */
  constructor(readonly path: string, private readonly managed: boolean, lockWaitMs?: number, lockMaxHoldMs?: number) { this.lock = new FileLock(`${path}.lock`, lockWaitMs, lockMaxHoldMs); }
  private warned = false;
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
      if (this.managed) {
        // konjir's own folder, made before more open: closed to others too.
        try { chmodSync(dir, 0o700); } catch { /* the file is 0600 */ }
      } else if (!this.warned) {
        this.warned = true;
        try {
          if (statSync(dir).mode & 0o022) console.error(`warning: others may write in ${dir}, which holds your konjir sign-in (${this.path}); konjir leaves the folder as it is`);
        } catch { /* made just now */ }
      }
      // Written whole to a new file of a random name (a `.tmp` left behind only if the write or rename throws) (O_EXCL: never through a link someone left there), then moved into place.
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
  /** With `fresh` (a new `konjir login`), whether this instance has saved its own tokens yet: until it has, it sees none. */
  private savedOwn = false;
  /** The registration this instance saved, if any: what its own tokens were issued to. */
  private ownClient?: StoredOAuthClientInformation;
  /** With `yieldTo`, whether another konjir's sign-in was kept in place of this one's, which was revoked. */
  yielded = false;
  readonly expectedState = randomBytes(24).toString('base64url');
  /**
   * `fresh`: a new sign-in, which ignores the tokens kept from before (they stay kept, and working,
   * until it saves its own). `yieldTo`, with `fresh`: the refresh token kept when it started ('' for
   * none); if, when it saves, another konjir has kept a sign-in since, that one is kept and this
   * one's tokens are revoked (the channel bridge's own sign-in yields to a `konjir login`).
   * `lockWaitMs`: how long to wait for another konjir's lock. The URL must be https, or http on
   * loopback (checkKolabUrl).
   */
  constructor(readonly url: string, private readonly opts: { path?: string; redirectUrl?: string; onAuthorize?: (u: URL) => void | Promise<void>; fresh?: boolean; yieldTo?: string; lockWaitMs?: number; lockMaxHoldMs?: number; clientName?: string; skipUrlCheck?: boolean } = {}) {
    // skipUrlCheck: only for logout --forget, which reads and drops the entry and contacts nothing.
    if (!opts.skipUrlCheck) checkKolabUrl(url);
    // Only konjir's own default folder is kept at 0700; one named through KONJIR_CREDENTIALS is the person's.
    this.store = new Store(opts.path ?? credentialsPath(), !opts.path && !process.env.KONJIR_CREDENTIALS, opts.lockWaitMs, opts.lockMaxHoldMs);
  }
  get redirectUrl() { return this.opts.redirectUrl ?? REDIRECT; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? 'konjir CLI', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() { return this.expectedState; }
  /**
   * This instance's own registration once it has one (a fresh sign-in), so a `konjir login` that
   * registered meanwhile can't swap the client its code was issued to; otherwise the one kept.
   */
  clientInformation() { return this.ownClient ?? this.store.get(this.url).client; }
  /** What a save of `tokens` keeps: with them, the registration they were issued to, when this instance made it. */
  private withTokens(s: Saved, tokens: StoredOAuthTokens): Saved { return { ...s, tokens, ...(this.ownClient ? { client: this.ownClient } : {}) }; }
  saveClientInformation(client: StoredOAuthClientInformation) { this.ownClient = client; return this.store.set(this.url, (s) => ({ ...s, client }), this.owner); }
  /** The credentials file. */
  get file() { return this.store.path; }
  /**
   * Read afresh each time, so a refresh another konjir made is seen. Asked by the authorization flow
   * (with `ctx`), that is, about to refresh: the lock is taken first, and held until the new tokens
   * are saved, so no two konjir refresh with one refresh token.
   */
  async tokens(ctx?: unknown) {
    if (this.opts.fresh && !this.savedOwn) return undefined;
    if (ctx === undefined) return this.store.get(this.url).tokens;
    if (!this.store.get(this.url).tokens?.refresh_token) return this.store.get(this.url).tokens;
    await this.store.lock.acquire(this.owner);
    const t = this.store.get(this.url).tokens;
    this.refreshing = t?.refresh_token;
    if (!t) this.store.lock.release(this.owner);
    return t;
  }
  async saveTokens(tokens: StoredOAuthTokens) {
    this.savedOwn = true;
    const was = this.refreshing;
    if (was !== undefined && !this.store.lock.holds(this.owner)) {
      // The lock was broken while this refresh stalled. If another konjir has saved tokens since,
      // they are the live ones: keep them, and use them. If not, save these under a lock of their own.
      this.refreshing = undefined;
      if (this.store.get(this.url).tokens?.refresh_token !== was) return;
      await this.store.set(this.url, (s) => this.withTokens(s, tokens));
      return;
    }
    // The same refresh token, re-saved (the SDK stamping its issuer before it refreshes): still refreshing, still locked.
    if (was !== undefined && tokens.refresh_token === was) {
      await this.store.set(this.url, (s) => this.withTokens(s, tokens), this.owner);
      return;
    }
    if (this.opts.fresh && this.opts.yieldTo !== undefined && was === undefined) {
      // A sign-in that yields: kept only if no other konjir kept one since it started, checked under the lock.
      let lost = false;
      await this.store.set(this.url, (s) => {
        const now = s.tokens?.refresh_token;
        if (now && now !== this.opts.yieldTo) { lost = true; return s; }
        return this.withTokens(s, tokens);
      }, this.owner);
      if (lost) {
        this.yielded = true;
        const client = this.ownClient ?? this.store.get(this.url).client;
        await revoke(this.url, { client, tokens }).catch(() => undefined);
      }
      return;
    }
    try {
      await this.store.set(this.url, (s) => this.withTokens(s, tokens), this.owner);
    } finally {
      this.refreshing = undefined;
      this.store.lock.release(this.owner);
    }
  }
  /** Lets go of the refresh lock, if this instance still has it: for an error that escaped the SDK's flow. */
  releaseLock() {
    this.refreshing = undefined;
    this.store.lock.release(this.owner);
  }
  /**
   * Lets go of the lock only if no refresh is in flight: for a long-lived process (the channel
   * bridge) between connections, where a refresh another request started may still be running.
   * A hold that leaked is let go by the lock's maximum hold.
   */
  releaseIdleLock() {
    if (this.refreshing === undefined) this.store.lock.release(this.owner);
  }
  /** Runs `fn` holding the lock (logout: read, revoke and forget at once, with no refresh between). */
  async locked<T>(fn: (owner: string) => Promise<T>): Promise<T> {
    await this.store.lock.acquire(this.owner);
    try { return await fn(this.owner); } finally { this.store.lock.release(this.owner); }
  }
  async redirectToAuthorization(u: URL) {
    this.store.lock.release(this.owner);
    if (!this.opts.onAuthorize) throw new Error(`your sign-in to ${safeUrl(this.url)} has ended or was revoked: run konjir login`);
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
  get fetch(): FetchLike { return this.fetchWith(fetch); }
  /** The same, sending each request through `inner` (one that adds an abort signal, say). */
  fetchWith(inner: FetchLike): FetchLike {
    return async (url, init) => {
      const res = await inner(url, init);
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
      return inner(url, { ...init, headers });
    };
  }
  /** Whether there is a sign-in to use. */
  get signedIn() { return !!this.store.get(this.url).tokens?.refresh_token; }
  /** The tokens kept now, read afresh: for masking them in what a process prints, never for printing. */
  secrets(): string[] {
    const t = this.store.get(this.url).tokens;
    return [t?.access_token, t?.refresh_token].filter((x): x is string => !!x);
  }
  saved() { return this.store.get(this.url); }
  forget(owner?: string) { return this.store.set(this.url, () => undefined, owner); }
}

/**
 * The command that opens a URL in the person's browser on `platform`, as a program and fixed
 * arguments, run with no shell: on Windows through url.dll's FileProtocolHandler, never `cmd /c
 * start`, which would split a URL at `&`.
 */
export function browserCommand(u: URL, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'darwin') return ['open', [u.toString()]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', u.toString()]];
  return ['xdg-open', [u.toString()]];
}

/**
 * Opens Kolab's sign-in in the person's browser, best effort (the URL is printed either way), and
 * only if it is Kolab's own /oauth/authorize (checkAuthorizeUrl): otherwise this throws, opening
 * nothing. `run` starts the command (tests stand one in).
 */
export function openBrowser(u: URL, kolabUrl: string, run: (cmd: string, args: string[]) => void = (cmd, args) => {
  try { execFile(cmd, args, { windowsHide: true }, () => undefined).unref(); } catch { /* printed instead */ }
}) {
  checkAuthorizeUrl(u, kolabUrl);
  const [cmd, args] = browserCommand(u);
  run(cmd, args);
}

/**
 * The style of the page the browser lands on once the code is back: Konjir's standalone page
 * (@konjir/brand), as Kolab's own sign-in pages are, so the last page of a sign-in looks like the
 * ones before it, and a line that says how it ended.
 */
const CALLBACK_CSS = [
  standalonePageCss(),
  '.kj-state{display:flex;align-items:center;gap:10px;margin:0;font-weight:600}',
  '.kj-state::before{content:"";flex:none;width:10px;height:10px;border-radius:var(--r-full);background:var(--clean)}',
  '.kj-state.stopped::before{background:var(--boundary)}',
  '.kj-next{margin:10px 0 0}',
].join('\n');
/** The page's whole policy: its one style sheet, by hash, and nothing else. It loads nothing, runs no script and is never framed. */
const CALLBACK_CSP = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(CALLBACK_CSS).digest('base64')}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
/** What the sign-in page is sent with. */
export const CALLBACK_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'content-security-policy': CALLBACK_CSP, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
};

/** The page the browser lands on once the code is back: it says how the sign-in ended and to return to the terminal, and loads nothing. */
export const callbackPage = (ok: boolean, text: string) => standalonePage({
  title: `${ok ? 'Signed in' : 'Sign-in stopped'} · Konjir`,
  css: CALLBACK_CSS,
  body: `<h1>${ok ? 'Signed in.' : 'Sign-in stopped.'}</h1>`
    + `<div class="card"><p class="kj-state${ok ? '' : ' stopped'}">${ok ? 'konjir has your sign-in.' : 'konjir was not signed in.'}</p>`
    + `<p class="kj-next muted">${escapeHtml(text)}</p></div>`,
});

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
    throw new Error(`couldn't reach Kolab at ${safeUrl(endpoint)} (${String((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message)})`);
  }
  if (!res.ok) throw new Error(`Kolab answered ${res.status} at ${safeUrl(endpoint)}`);
  if (saved.tokens?.access_token) await post(saved.tokens.access_token, 'access_token').catch(() => undefined);
  return 'revoked';
}

/** How a browser sign-in is started and finished: its scope, how the browser opens, where it says so, how long it may take. */
interface BrowserOpts {
  scope?: string; open?: (u: URL) => void | Promise<void>; log?: (line: string) => void; timeoutMs?: number; again?: string;
  /** What is said as the browser opens, before the link; by default, that it signs in to Kolab. */
  opening?: string;
  /**
   * What the sign-in's MCP connections tell Kolab they are (clientInfo): `konjir-cli` 0.6.0 by
   * default, as every published konnect's does; the kolab CLI gives its own, `kolab`, which opts in
   * to Kolab's wording for it (docs/plans/rebrand-and-site.md, step 1b).
   */
  clientInfo?: { name: string; version: string };
}

/** What a sign-in's MCP connections say they are when the caller doesn't say (BrowserOpts.clientInfo). */
const SIGN_IN_CLIENT = { name: 'konjir-cli', version: '0.6.0' };

/**
 * Signs a provider in through the person's browser: a loopback listener on a port of its own
 * (RFC 8252), Kolab's own authorization URL opened (with `scope`, which Kolab reads for what to
 * preselect), and only the answer that carries this sign-in's state taken. `make` builds the
 * provider for the listener's redirect URL. Resolves with the provider, signed in.
 */
async function signInWithBrowser<P extends OAuthClientProvider & { expectedState: string }>(url: string, make: (redirectUrl: string, onAuthorize: (u: URL) => Promise<void>) => P, opts: BrowserOpts): Promise<P> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    const provider = make(`http://127.0.0.1:${port}/callback`, async (u) => {
      // What to preselect on Kolab's page: the kolab and role (Kolab reads them from the scope).
      if (opts.scope) u.searchParams.set('scope', opts.scope);
      // Only Kolab's own sign-in page is ever printed or opened.
      checkAuthorizeUrl(u, url);
      log(`${opts.opening ?? 'Opening your browser to sign in to Kolab.'} If it doesn't open, go to:\n  ${u.toString()}`);
      await (opts.open ?? ((v: URL) => openBrowser(v, url)))(u);
    });
    const back = new Promise<URLSearchParams>((resolve, reject) => {
      const wait = opts.timeoutMs ?? SIGN_IN_WAIT_MS;
      const waited = !(wait % 60_000) ? `${wait / 60_000} minutes` : !(wait % 1000) ? `${wait / 1000} seconds` : `${wait} ms`;
      const timer = setTimeout(() => reject(new Error(`the sign-in took too long: it waited ${waited} for the browser${wait === SIGN_IN_WAIT_MS ? ', as long as Kolab\'s sign-in page lasts' : ''}; ${opts.again ?? 'run konjir login again'}`)), wait);
      timer.unref();
      server.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
        // Only the answer to this sign-in: its state, which only this process knows.
        if (u.searchParams.get('state') !== provider.expectedState) { res.writeHead(400, CALLBACK_HEADERS).end(callbackPage(false, 'That answer was for another sign-in. Return to your terminal.')); return; }
        clearTimeout(timer);
        const error = u.searchParams.get('error');
        res.writeHead(error ? 400 : 200, CALLBACK_HEADERS)
          .end(callbackPage(!error, error ? 'Return to your terminal: it says why.' : 'You can close this tab and return to your terminal.'));
        if (error) reject(new Error(`Kolab didn't sign you in: ${u.searchParams.get('error_description') ?? error}`));
        else resolve(u.searchParams);
      });
    });
    back.catch(() => undefined);
    const first = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
    const probe = new Client(opts.clientInfo ?? SIGN_IN_CLIENT, { versionNegotiation: { mode: 'auto' } });
    try {
      await probe.connect(first);
      await probe.close();
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      await first.finishAuth(await back);
    }
    return provider;
  } finally {
    server.close();
  }
}

/**
 * How long `konjir login` (and the channel's own sign-in) waits for the person in the browser: as
 * long as Kolab's sign-in page lasts, 20 minutes (its oauth.requestTtlS), so neither gives up while
 * the other still waits (W5.7).
 */
export const SIGN_IN_WAIT_MS = 20 * 60_000;

/**
 * Signs in (`konjir login`): `scope` may preselect the kolab and role on Kolab's page
 * (`konjir kolab:<name> role:<role>`). `open` is how the person's browser is sent to Kolab; by
 * default it is opened, and the URL printed to `log`. A sign-in kept from before is revoked first,
 * so no grant is left behind. Resolves once the CLI's session works, with who it is.
 *
 * `yieldTo`: the sign-in yields (see StoredLogin) to any kept since that refresh token was seen
 * ('' for none), as the caller saw it under the lock; never read here, where another konjir's
 * could slip in first. The reverse race, a `konjir login` that started first and saves last, keeps
 * the later one and leaves the other's grant to lapse unused within 30 days, as two `konjir login`s
 * at once always have.
 */
export async function login(url: string, opts: { path?: string; clientName?: string; yieldTo?: string } & BrowserOpts = {}) {
  checkKolabUrl(url);
  const log = opts.log ?? ((l: string) => console.error(l));
  // A fresh sign-in, which ignores the one kept from before: that one stays, and working, until this succeeds.
  const before = new StoredLogin(url, { path: opts.path }).saved();
  const provider = await signInWithBrowser(url, (redirectUrl, onAuthorize) => new StoredLogin(url, {
    path: opts.path, redirectUrl, fresh: true, clientName: opts.clientName, yieldTo: opts.yieldTo, onAuthorize,
  }), opts);
  const kept = new StoredLogin(url, { path: opts.path });
  const client = new Client(opts.clientInfo ?? SIGN_IN_CLIENT, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: kept, fetch: kept.fetch, onInsufficientScope: 'throw' }));
  let me;
  try {
    const r = await client.callTool({ name: 'konjir_whoami', arguments: {} });
    me = r.structuredContent as { actor: string; kind: string; owner: string | null; kolab: string; role: string; layer: string };
  } finally {
    await client.close();
  }
  // Replaced: the sign-in kept from before is revoked now, so its grant doesn't linger.
  if (!provider.yielded && before.tokens?.refresh_token && before.tokens.refresh_token !== kept.saved().tokens?.refresh_token) {
    await revoke(url, before).catch((e: Error) => log(`warning: the sign-in this one replaces wasn't revoked: ${e.message}. It lapses within 30 days unused.`));
  }
  // `yielded`: another konjir's sign-in, kept meanwhile, is the one kept and used; this one was revoked.
  return { ...me, yielded: provider.yielded };
}

/**
 * The scope of a person's own sign-in that names no kolab (konnect, Lee's instruction of
 * 2026-11-16): Kolab's page lists the invitations waiting for the account that signs in, to accept
 * or decline, and the kolabs the person is a member of; the person picks one there.
 */
export const CHOOSE_SCOPE = 'konjir choose:kolab';

/** A kolab's name as Kolab allows one: lowercase letters, digits and '-', starting with a letter or digit, at most 40. */
const KOLAB_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * What a person's own sign-in to a named team asks of Kolab's page beside the name: `join`, only
 * sign in to a team they are a member of, and refuse a free name as no such team; `create`, only
 * make a new team, and refuse a taken name, suggesting a free one. Without it, the name decides.
 */
export type TeamIntent = 'join' | 'create';

/**
 * The scope of a person's own make-or-switch sign-in to the kolab `name` (konnect's `team <name>`):
 * Kolab's page offers to make it, private and theirs, with no agent, if the name is free; signs them
 * in to it if they are a member; and refuses, suggesting a free name, if it is anyone else's. With
 * `intent`, an `intent:join` or `intent:create` word, which only narrows that (TeamIntent).
 */
export function teamScope(name: string, intent?: TeamIntent): string {
  if (!KOLAB_NAME.test(name)) throw new Error(`${JSON.stringify(name)} isn't a team's name: up to 40 lowercase letters, digits and '-', starting with a letter or digit`);
  if (intent !== undefined && intent !== 'join' && intent !== 'create') throw new Error(`${JSON.stringify(intent)} isn't an intent: join or create`);
  return intent ? `konjir team:${name} intent:${intent}` : `konjir team:${name}`;
}

/** A person's own sign-in, kept: the kolab it works in (the one chosen or made on Kolab's page), who it is, its role, and where its credentials are kept. */
export interface PersonSignIn {
  kolab: string; actor: string; role: string;
  /** The credentials file the sign-in is kept in, under the Kolab's MCP URL. */
  credentials: string;
  /** Another konjir's sign-in, kept meanwhile, was kept in place of this one (see login's yieldTo). */
  yielded: boolean;
}

/**
 * Kolab refused a sign-in on its page, or the person denied it there: `reason` says why, as Kolab
 * did; `suggest` is a free kolab name Kolab offered, when the name asked for is someone else's.
 */
export class SignInRefused extends Error {
  name = 'SignInRefused';
  constructor(message: string, readonly denied: boolean, readonly suggest?: string) { super(message); }
  /** The page had nothing to choose (signInChoosing): no invitation waits for the account, and it is a member of no kolab. */
  get nothingToChoose() { return this.message.startsWith('nothing to sign in to:'); }
}

/** Signs a person in as themselves through a scope that leaves the kolab to Kolab's page; see signInChoosing and signInToTeam. */
async function signInAsPerson(url: string, scope: string, opts: { path?: string; clientName?: string; yieldTo?: string } & Omit<BrowserOpts, 'scope'>, kolab?: string): Promise<PersonSignIn> {
  let me: Awaited<ReturnType<typeof login>>;
  try {
    me = await login(url, { again: 'start the sign-in again', ...opts, scope });
  } catch (e) {
    // Said as what it is: refused on Kolab's page (it names why), or denied there.
    const said = /^Kolab didn't sign you in: (.*)$/s.exec(String((e as Error)?.message ?? ''))?.[1];
    if (said === undefined) throw e;
    if (said === 'the person declined') throw new SignInRefused('you denied the sign-in on Kolab\'s page', true);
    const why = said.replace(/^the sign-in can't be allowed: /, '').replace(/\.$/, '');
    throw new SignInRefused(why, false, /The name ([a-z0-9][a-z0-9-]*) is free/.exec(why)?.[1]);
  }
  // Not what was asked for: what this attempt kept is revoked and forgotten, never left to be used.
  const wrong = me.kind !== 'person' ? `Kolab signed in ${me.actor}, an agent, where a person's own sign-in was asked for`
    : kolab !== undefined && me.kolab !== kolab ? `Kolab signed you in to kolab ${me.kolab}, not ${kolab}, which was asked for` : undefined;
  if (wrong) {
    if (!me.yielded) await logout(url, { path: opts.path, forget: true }).catch(() => undefined);
    throw new Error(`${wrong}: the sign-in was revoked. Run it again`);
  }
  return { kolab: me.kolab, actor: me.actor, role: me.role, credentials: opts.path ?? credentialsPath(), yielded: me.yielded };
}

/**
 * Signs the person in as themselves with no kolab named (konnect with no team): Kolab's page, in the
 * browser, lists the invitations waiting for the account that signs in and the kolabs they are a
 * member of, and they pick one there. The sign-in is kept as `login` keeps it, for the URL, in
 * `path` or the credentials file. Resolves with the kolab picked; throws SignInRefused if the person
 * denied it, or Kolab refused it.
 */
export function signInChoosing(url: string, opts: { path?: string; clientName?: string; yieldTo?: string } & Omit<BrowserOpts, 'scope'> = {}): Promise<PersonSignIn> {
  return signInAsPerson(url, CHOOSE_SCOPE, opts);
}

/**
 * Signs the person in as themselves to the kolab `name` (konnect's `team <name>`), making it,
 * private and theirs with no agent, when the name is free: Kolab's page says which, and the person
 * allows it there. Refused, when the name is someone else's, with SignInRefused, whose `suggest` is
 * a free name Kolab offered. With `intent`, only that: `join` refuses a free name (no such team) and
 * never makes one; `create` refuses a taken name, even the person's own team, with `suggest` set.
 * Kept as signInChoosing keeps it.
 */
export function signInToTeam(url: string, name: string, opts: { path?: string; clientName?: string; yieldTo?: string; intent?: TeamIntent } & Omit<BrowserOpts, 'scope'> = {}): Promise<PersonSignIn> {
  const { intent, ...rest } = opts;
  return signInAsPerson(url, teamScope(name, intent), rest, name);
}

/**
 * A sign-in kept in this process's memory only, never written anywhere: `konjir connect`'s setup
 * (setup), whose token is used once, then revoked.
 */
export class MemoryLogin implements OAuthClientProvider {
  private client?: StoredOAuthClientInformation;
  private kept?: StoredOAuthTokens;
  private discovery?: OAuthDiscoveryState;
  private verifier = '';
  readonly expectedState = randomBytes(24).toString('base64url');
  constructor(private readonly opts: { redirectUrl: string; onAuthorize?: (u: URL) => Promise<void>; clientName?: string }) {}
  get redirectUrl() { return this.opts.redirectUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: this.opts.clientName ?? 'konjir CLI', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state() { return this.expectedState; }
  clientInformation() { return this.client; }
  saveClientInformation(c: StoredOAuthClientInformation) { this.client = c; }
  tokens() { return this.kept; }
  saveTokens(t: StoredOAuthTokens) { this.kept = t; }
  async redirectToAuthorization(u: URL) {
    if (!this.opts.onAuthorize) throw new Error('this sign-in has ended');
    await this.opts.onAuthorize(u);
  }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  saveDiscoveryState(d: OAuthDiscoveryState) { this.discovery = d; }
  discoveryState() { return this.discovery; }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') this.client = undefined;
    if (scope === 'all' || scope === 'tokens') this.kept = undefined;
    if (scope === 'all' || scope === 'verifier') this.verifier = '';
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
  }
}

/** One agent a setup set up (konjir connect): made now or found again, and, when its sign-in was issued, its tokens. */
export interface SetupAgent { label: string; agent: string; role: string; made: boolean; tokens?: StoredOAuthTokens }

/**
 * What a setup gives konjir connect: who allowed it, the kolab (made now or theirs already), each
 * agent, and the client its agents' sign-ins were issued to, with what was discovered of Kolab, so
 * each agent's credentials file holds what that agent's own browser sign-in would have kept.
 */
export interface SetupDone {
  person: string; kolab: { id: string; made: boolean }; agents: SetupAgent[];
  client: StoredOAuthClientInformation; discovery?: OAuthDiscoveryState;
}

/**
 * `konjir connect`'s one sign-in (Lee's instruction of 2026-11-01): the browser opens once, at
 * Kolab's setup page, whose scope (`konjir kolab:<k> setup:<label>:<role> …`) names the kolab and
 * the agents; the person signs in and allows it there. Its code is exchanged, as any code is, for a
 * setup token, kept in memory only and used once, at Kolab's POST /oauth/setup: with `mint`, Kolab
 * issues each agent the person allowed its own grant and refresh token, to this sign-in's own
 * client (registered as `clientName`). The setup token is then revoked, whatever happened. Denied,
 * or refused on the page, it throws, saying why.
 */
export async function setup(url: string, opts: { scope: string; mint: boolean; clientName?: string } & Omit<BrowserOpts, 'scope'>): Promise<SetupDone> {
  checkKolabUrl(url);
  const memory = await signInWithBrowser(url, (redirectUrl, onAuthorize) => new MemoryLogin({ redirectUrl, onAuthorize, clientName: opts.clientName }),
    { again: 'run konjir connect again', ...opts }).catch((e: Error) => {
    // Said as what it is: refused on Kolab's page (it names why), or denied there.
    const said = /^Kolab didn't sign you in: (.*)$/s.exec(String(e?.message ?? ''))?.[1];
    if (said === undefined) throw e;
    throw new Error(said === 'the person declined' ? 'you denied the setup on Kolab\'s page: nothing was made or written' : `${said.replace(/\.$/, '')}. Nothing was made or written`);
  });
  const client = memory.clientInformation();
  const token = memory.tokens()?.access_token;
  if (!client || !token) throw new Error('Kolab didn\'t finish the setup: run konjir connect again');
  // Kolab is its own authorization server, on its own origin: the token goes nowhere else.
  const endpoint = new URL('/oauth/setup', url).toString();
  try {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: client.client_id, mint: opts.mint }),
      });
    } catch (e) {
      throw new Error(`couldn't reach Kolab at ${safeUrl(endpoint)} (${String((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message)})`);
    }
    type Answer = {
      error_description?: string; person?: string; kolab?: { id: string; made: boolean };
      agents?: { label: string; agent: string; role: string; made: boolean; access_token?: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string }[];
    };
    const body = await res.json().catch(() => ({})) as Answer;
    if (!res.ok || !body.person || !body.kolab || !Array.isArray(body.agents)) {
      throw new Error(`Kolab didn't finish the setup: ${body.error_description ?? `it answered ${res.status}`}. Run konjir connect again`);
    }
    // What the MCP SDK stamps on tokens it saves (the issuer they came from, SEP-2352), from the
    // setup's own: each agent's tokens carry the same, as its own sign-in's would.
    const { access_token: _a, refresh_token: _r, expires_in: _e, scope: _s, token_type: _t, ...stamp } = memory.tokens() ?? {} as StoredOAuthTokens;
    return {
      person: body.person, kolab: body.kolab, client, discovery: memory.discoveryState(),
      agents: body.agents.map((a) => ({
        label: a.label, agent: a.agent, role: a.role, made: a.made,
        ...(a.access_token && a.refresh_token
          ? { tokens: { access_token: a.access_token, token_type: a.token_type ?? 'Bearer', expires_in: a.expires_in, refresh_token: a.refresh_token, scope: a.scope, ...stamp } as StoredOAuthTokens }
          : {}),
      })),
    };
  } finally {
    // Used up already when it worked; revoked anyway, so a setup token never outlives konjir connect.
    await fetch(new URL('/oauth/revoke', url), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: 'access_token', client_id: client.client_id }).toString(),
    }).then((r) => r.body?.cancel(), () => undefined);
  }
}

/**
 * Revokes sign-ins a setup issued (konjir connect, when something after the setup fails): each
 * refresh token, which revokes its grant and ends its session, at Kolab's own /oauth/revoke, by the
 * client it was issued to. Returns how many Kolab confirmed; never throws.
 */
export async function revokeIssued(url: string, client: StoredOAuthClientInformation, tokens: StoredOAuthTokens[]): Promise<number> {
  let n = 0;
  for (const t of tokens) {
    if (!t.refresh_token) continue;
    try {
      if ((await revoke(url, { client, tokens: t })) === 'revoked') n++;
    } catch { /* counted as not revoked */ }
  }
  return n;
}

/**
 * Keeps an agent's sign-in, from a setup, in its credentials file (agentCredentials), as that
 * agent's own browser sign-in would have kept it: for the URL, the client its grant was issued to,
 * its tokens and what was discovered of Kolab. Whatever was kept there before is replaced under the
 * file's lock, and revoked at Kolab, best effort, so no grant of an earlier run lingers.
 */
export async function keepSignIn(url: string, path: string, saved: { client: StoredOAuthClientInformation; tokens: StoredOAuthTokens; discovery?: OAuthDiscoveryState }): Promise<void> {
  checkKolabUrl(url);
  const store = new Store(path, false);
  let before: Saved = {};
  await store.set(url, (s) => { before = s; return { client: saved.client, tokens: saved.tokens, ...(saved.discovery ? { discovery: saved.discovery } : {}) }; });
  if (before.tokens?.refresh_token && before.tokens.refresh_token !== saved.tokens.refresh_token) await revoke(url, before).catch(() => undefined);
}

/**
 * `konjir logout`: revokes the grant at Kolab (RFC 7009), then forgets the sign-in. If Kolab can't
 * be reached, or refuses, the sign-in is kept, so the person can try again, and this throws, saying
 * so; with `forget`, it is forgotten anyway, unrevoked, and that is said too.
 */
export async function logout(url: string, opts: { path?: string; forget?: boolean } = {}): Promise<{ had: boolean; revoked: boolean; why?: string }> {
  // A sign-in kept for a URL konjir no longer signs in over (http to another host, kept before the
  // check): --forget drops it without contacting Kolab, since that would send its tokens over http.
  let refused: string | undefined;
  try { checkKolabUrl(url); } catch (e) { refused = (e as Error).message; }
  if (refused && !opts.forget) throw new Error(`${refused}. To drop the sign-in kept for it without contacting Kolab, run konjir logout --forget`);
  const provider = new StoredLogin(url, { path: opts.path, skipUrlCheck: !!refused });
  if (refused) {
    return provider.locked(async (owner) => {
      const had = !!provider.saved().tokens;
      await provider.forget(owner);
      return { had, revoked: false, why: 'konjir doesn\'t contact Kolab over http to another host' };
    });
  }
  // Under the lock: no refresh rotates the tokens between reading them and revoking them.
  return provider.locked(async (owner) => {
    const saved = provider.saved();
    if (!saved.tokens) { await provider.forget(owner); return { had: false, revoked: false }; }
    let revoked = false;
    try {
      revoked = (await revoke(url, saved)) === 'revoked';
    } catch (e) {
      if (!opts.forget) throw new Error(`${(e as Error).message}, so your sign-in to ${safeUrl(url)} wasn't revoked and is still kept: run konjir logout again, or konjir logout --forget to drop it anyway`);
    }
    await provider.forget(owner);
    return { had: true, revoked };
  });
}
