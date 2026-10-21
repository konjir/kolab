/**
 * The Kolab side of the bridge: an MCP client of Kolab that subscribes to the
 * session's inbox and answers over subscriptions/listen, reads each resource
 * Kolab signals, and hands a channel message for each change to `forward`.
 * It reconnects, with backoff, whenever Kolab goes away or stops answering.
 *
 * It reaches Kolab with a hand-issued session token (KONJIR_TOKEN), or with a
 * sign-in kept by @konjir/login (W3.5, D55), the one `konjir login` keeps for
 * the same MCP URL. A sign-in's access token lasts 15 minutes, and Kolab closes
 * a listen stream when its token expires or a refresh rotates it (API4): the
 * bridge then connects again, the MCP client refreshing the token under the
 * credentials file's lock, and re-reads what changed meanwhile.
 */
import { Client, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import { safeUrl, type StoredLogin } from '@konjir/login';
import { describeChange, describeStartup, type ChannelMessage } from './messages.js';
import { VERSION } from './version.js';

export interface BridgeOptions {
  url: string;
  /** A hand-issued session token (KONJIR_TOKEN). Exactly one of `token` and `login` is given. */
  token?: string;
  /** A kept OAuth sign-in, refreshed as it expires (W3.5). */
  login?: StoredLogin;
  /** Deliver a message to the Claude Code session. */
  forward(message: ChannelMessage): Promise<void>;
  /** A line for the operator (stderr). Never carries a token. */
  log(line: string): void;
  /**
   * Reconnect delays: doubles from `initialMs` up to `maxMs`, back to `initialMs` only once a
   * stream has lived `steadyMs` (60 s by default), so a Kolab that admits and closes at once is
   * not asked again every second.
   */
  backoff?: { initialMs: number; maxMs: number; steadyMs?: number };
  /** How often to check on Kolab while listening, and how long to wait for the reply. */
  liveness?: { intervalMs: number; timeoutMs: number };
  /** The fetch the Kolab transport uses (tests stand in a network here). */
  fetch?: FetchLike;
}

export interface Whoami { actor: string; role: string; layer: string; subscribe: string[] }

/** Kolab answered, but the token can't drive a channel: it isn't an agent session token. */
class NotAnAgentToken extends Error {}

/** No sign-in is kept for the URL (the credentials file has none, or it was forgotten). */
class SignedOut extends Error {}

/** Why a connection ended, other than the subscription closing. */
type Ended = 'refused' | 'unresponsive' | 'stopped';

export class KolabBridge {
  private stopped = false;
  private wake!: () => void;
  /** Resolves once stop() is called. */
  private readonly stopping = new Promise<'stopped'>((resolve) => { this.wake = () => resolve('stopped'); });
  /** The connection in use, so stop() can close it. */
  private client?: Client;
  /** Aborts every request to Kolab, connecting included, when stop() is called. */
  private readonly abort = new AbortController();
  private running?: Promise<void>;
  /** The last contents seen of each resource, so a change is described against what came before. */
  private readonly seen = new Map<string, unknown>();
  /** Updates are handled one at a time, in arrival order. */
  private queue: Promise<void> = Promise.resolve();
  /** The startup summary goes out once, on the first connection that reads the inbox. */
  private summarized = false;
  /** Whether a sign-in was ever kept while this bridge ran: one gone since was signed out. */
  private hadSignIn = false;
  /** The problem last reported, so a retry loop doesn't repeat itself. */
  private lastProblem?: string;
  /** Who this session is, once Kolab has said. */
  me?: Whoami;
  /** Called each time a subscription is open and caught up; for tests. */
  onListening?: (me: Whoami) => void;

  constructor(private readonly opts: BridgeOptions) {
    if (!!opts.token === !!opts.login) throw new Error('the bridge takes a token or a sign-in, exactly one');
  }

  /** What the bridge reaches Kolab with, as the person knows it. */
  private get credential() { return this.opts.login ? `the sign-in konjir login keeps for ${safeUrl(this.opts.url)}` : 'KONJIR_TOKEN'; }

  start() {
    this.running ??= this.run();
    return this;
  }

  /** Stop listening. Requests in flight are ended, not waited out. */
  async stop() {
    this.stopped = true;
    this.wake();
    this.abort.abort();
    await this.client?.close().catch(() => undefined);
    await this.running;
  }

  /**
   * Any text fit to log or send: no token appears in it. The token given, the sign-in's tokens as
   * kept now, and anything shaped like a Kolab secret (a session or access token kjs_, a refresh
   * token kjr_, a code kjc_) are masked.
   */
  redact(text: string) {
    let secrets: string[] = [];
    try { secrets = this.opts.login?.secrets() ?? []; } catch { /* an unreadable file: the pattern below still masks */ }
    for (const s of [this.opts.token, ...secrets]) if (s) text = text.split(s).join('***');
    return text.replace(/\bkj[src]_[A-Za-z0-9_-]+/g, '***');
  }

  private log(line: string) {
    this.opts.log(this.redact(line));
  }

  /** Report a problem once: to the log, and to the session if `tell` is given. Repeats are dropped. */
  private async problem(key: string, line: string, tell?: ChannelMessage) {
    if (this.lastProblem === key) return;
    this.lastProblem = key;
    this.log(line);
    if (tell) await this.opts.forward({ content: this.redact(tell.content), meta: tell.meta }).catch(() => undefined);
  }

  private async run() {
    const { initialMs, maxMs, steadyMs = 60_000 } = this.opts.backoff ?? { initialMs: 1000, maxMs: 30_000 };
    let delay = initialMs;
    let everConnected = false;
    while (!this.stopped) {
      let client: Client | undefined;
      try {
        if (this.opts.login) {
          if (!this.opts.login.signedIn) throw new SignedOut('none');
          this.hadSignIn = true;
        }
        client = this.client = this.newClient();
        await client.connect(this.transport());
        const me = await this.whoami(client);
        this.me = me;

        let end!: (why: Ended) => void;
        const ended = new Promise<Ended>((resolve) => { end = resolve; });
        let endedBy: Ended | undefined;
        const stop = (why: Ended) => { endedBy ??= why; end(why); };
        // Kolab closes an ended session's streams (D41). A read it refuses all the same
        // (a Kolab from before that) ends this connection, so the loop reconnects and
        // the reconnect reports the refusal.
        const c = client;
        const enqueue = (uri: string, onBody?: (body: unknown) => void) => {
          this.queue = this.queue.then(() => this.update(c, uri, onBody)).catch((e) => {
            this.log(`could not read ${uri}: ${messageOf(e)}`);
            if (isRefusal(e)) stop('refused');
          });
        };
        client.setNotificationHandler('notifications/resources/updated', (n) => enqueue(n.params.uri));
        // Listen first, then read: a change landing in between is then both signalled and read.
        const subscription = await client.listen({ resourceSubscriptions: me.subscribe });
        // Read each resource: a baseline the first time it is read, and on a reconnect,
        // whatever changed while the bridge was away.
        const firstReads: { uri: string; body: unknown }[] = [];
        for (const uri of me.subscribe) enqueue(uri, (body) => firstReads.push({ uri, body }));
        await this.queue;

        if (endedBy) {
          await subscription.close().catch(() => undefined);
          this.log(`Kolab refused a read with ${this.credential}; reconnecting`);
        } else {
          this.lastProblem = undefined;
          this.log(`${everConnected ? 'reconnected' : 'connected'} to Kolab at ${safeUrl(this.opts.url)} as ${me.actor} (${me.role}); watching ${me.subscribe.join(', ')}`);
          everConnected = true;
          if (!this.summarized && firstReads.length) {
            this.summarized = true;
            const summary = describeStartup(firstReads);
            if (summary) await this.opts.forward({ content: this.redact(summary.content), meta: summary.meta });
          }
          this.onListening?.(me);
          const alive = this.watchLiveness(client, stop);
          const opened = Date.now();
          const how = await Promise.race([subscription.closed.then(() => 'closed' as const), ended, this.stopping]);
          alive();
          if (Date.now() - opened >= steadyMs) delay = initialMs;
          if (how !== 'closed') await subscription.close().catch(() => undefined);
          if (how === 'stopped') break;
          this.log(how === 'refused' ? `Kolab refused a read with ${this.credential}; reconnecting`
            : how === 'unresponsive' ? 'Kolab stopped answering; reconnecting'
            : this.opts.login ? 'Kolab closed the subscription stream (its access token expired or was renewed, or Kolab restarted); reconnecting'
            : 'Kolab closed the subscription stream; reconnecting');
        }
      } catch (e) {
        if (this.stopped) break;
        const msg = messageOf(e);
        const login = this.opts.login;
        if (login && (e instanceof SignedOut || /has ended or was revoked: run konjir login/.test(msg))) {
          // No sign-in, or it ended (revoked, lapsed, or replaced by a newer one as the same actor, ENF4).
          // The bridge never opens the browser again by itself: it waits, re-reading the credentials
          // file, for konjir login to sign in again, and goes on with no restart.
          delay = maxMs;
          // A bridge that has listened with a sign-in and now has none was signed out (the MCP client forgets refused tokens).
          const none = e instanceof SignedOut && !this.hadSignIn;
          await this.problem(none ? 'no-sign-in' : 'signed-out',
            `${none ? 'no sign-in is kept' : 'the sign-in kept has ended or was revoked'} for ${safeUrl(this.opts.url)}; waiting for konjir login, checking every ${Math.round(maxMs / 1000)}s`, {
              content: `The Konjir channel ${none ? 'has no sign-in to' : 'was signed out of'} Kolab at ${safeUrl(this.opts.url)}${none ? '' : ': its sign-in ended or was revoked'}, so inbox changes won't arrive. Tell the user to run konjir login --url ${safeUrl(this.opts.url)} in a terminal, choosing the agent this session works as. The channel picks the sign-in up by itself, with no restart.`,
              meta: { kind: 'bridge', status: none ? 'unconfigured' : 'signed_out' },
            });
        } else if (login && (isRefusal(e) || listenRefusal(e) === 'session_ended')) {
          // Refused mid-way (the session ended as the stream opened, say): the next connection
          // refreshes the sign-in, or finds it ended and says so.
          await this.problem('refused', `Kolab at ${safeUrl(this.opts.url)} refused the sign-in's token; trying again`);
        } else if (e instanceof NotAnAgentToken) {
          delay = maxMs;
          await this.problem('not-agent', `KONJIR_TOKEN is not an agent session token: ${msg}. Retrying every ${Math.round(maxMs / 1000)}s`, {
            content: `The Konjir channel's KONJIR_TOKEN is not an agent session token (it may be the admin token), so it has no inbox to listen to. Restart Claude Code with KONJIR_TOKEN set to this agent's session token from konjir admin_open_session. Tell the user.`,
            meta: { kind: 'bridge', status: 'misconfigured' },
          });
        } else if (isRefusal(e) || listenRefusal(e) === 'session_ended') {
          await this.problem('refused', `Kolab at ${safeUrl(this.opts.url)} refused the token; retrying`, {
            content: `The Konjir channel can't sign in to Kolab at ${safeUrl(this.opts.url)}: Kolab refused its session token (revoked or mistyped). Inbox changes won't arrive until KONJIR_TOKEN is fixed and Claude Code restarts. Tell the user.`,
            meta: { kind: 'bridge', status: 'refused' },
          });
        } else if (listenRefusal(e)) {
          // Kolab couldn't check the session just now ('gate_failed', 'gate_timeout') or was shutting down ('closed').
          await this.problem(`listen-refused:${listenRefusal(e)}`, `Kolab at ${safeUrl(this.opts.url)} couldn't open the subscription just now (${listenRefusal(e)}); retrying with backoff`);
        } else {
          await this.problem(`unreachable:${msg}`, `cannot reach Kolab at ${safeUrl(this.opts.url)} (${msg}); retrying with backoff`);
        }
      } finally {
        await client?.close().catch(() => undefined);
        if (this.client === client) this.client = undefined;
        // A hold this connection leaked is let go, but never a refresh still in flight (its lock and its
        // compare-and-swap protect the tokens another konjir saves meanwhile); the lock's maximum hold covers the rest.
        this.opts.login?.releaseIdleLock();
      }
      if (this.stopped) break;
      await this.sleep(delay);
      delay = Math.min(delay * 2, maxMs);
    }
  }

  private newClient() {
    // 'auto' talks 2026-07-28 to Kolab, which subscriptions/listen needs.
    return new Client({ name: 'konjir-channel-bridge', version: VERSION }, { versionNegotiation: { mode: 'auto' } });
  }

  private transport() {
    // Every request, token requests included, ends when stop() is called.
    const aborting: FetchLike = (input, init) => (this.opts.fetch ?? fetch)(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, this.abort.signal]) : this.abort.signal,
    });
    const login = this.opts.login;
    // With a sign-in, the MCP client refreshes the access token as it expires, under the credentials
    // file's lock, and a request refused while another konjir refreshed is sent again with the new token.
    return new StreamableHTTPClientTransport(new URL(this.opts.url), login
      ? { authProvider: login, fetch: login.fetchWith(aborting) }
      : { requestInit: { headers: { Authorization: `Bearer ${this.opts.token}` } }, fetch: aborting });
  }

  /**
   * Check on Kolab while listening, since a half-open connection looks just like a quiet
   * inbox. 2026-07-28 has no ping, so the check is a konjir_whoami call with a timeout.
   * A refusal ends the connection as refused; anything else, as unresponsive.
   * Returns a function that stops the checks.
   */
  private watchLiveness(client: Client, ended: (why: Ended) => void) {
    const { intervalMs, timeoutMs } = this.opts.liveness ?? { intervalMs: 30_000, timeoutMs: 10_000 };
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      client.callTool({ name: 'konjir_whoami', arguments: {} }, { timeout: timeoutMs }).then(
        () => { busy = false; },
        (e) => { busy = false; this.log(`liveness check failed: ${messageOf(e)}`); ended(isRefusal(e) ? 'refused' : 'unresponsive'); },
      );
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async whoami(client: Client): Promise<Whoami> {
    const r = await client.callTool({ name: 'konjir_whoami', arguments: {} });
    const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    if (r.isError) throw new NotAnAgentToken(text.split('\n')[0].replace(/\. Your session role.*$/, ''));
    const me = r.structuredContent as Whoami | undefined;
    if (!me?.subscribe?.length) throw new NotAnAgentToken('konjir_whoami named no resources to subscribe to');
    return me;
  }

  /**
   * Read `uri` and forward what changed since it was last seen. The first read of a
   * resource is a baseline: it forwards nothing, and goes to `onFirst`.
   */
  private async update(client: Client, uri: string, onFirst?: (body: unknown) => void) {
    const r = await client.readResource({ uri }, { cacheMode: 'bypass' });
    const c = r.contents[0];
    const body = c && 'text' in c ? JSON.parse(c.text) as unknown : null;
    const had = this.seen.has(uri);
    const before = this.seen.get(uri);
    this.seen.set(uri, body);
    if (!had) { onFirst?.(body); return; }
    const message = describeChange(uri, before, body);
    if (message) await this.opts.forward({ content: this.redact(message.content), meta: message.meta });
  }

  private sleep(ms: number) {
    return Promise.race([new Promise<void>((r) => setTimeout(r, ms).unref()), this.stopping.then(() => undefined)]);
  }
}

/**
 * Why Kolab refused a listen stream in-band (JSON-RPC -32003, "Listen stream refused"), or
 * undefined for any other error. 'session_ended' is the token revoked, as a 401 is; any other
 * reason ('gate_failed', 'gate_timeout', 'closed') is worth retrying. So is 'not_subscribable'
 * (D50): the stream asked for another kolab's resources, as one listed by a Kolab from before
 * D50 during a rolling deploy might, and the retry asks konjir_whoami for them afresh. (The bridge stands alone,
 * so this repeats the CLI's listenRefusal rather than import it.)
 */
export function listenRefusal(e: unknown): string | undefined {
  const err = e as { code?: unknown; data?: { reason?: unknown } } | undefined;
  if (err?.code !== -32003) return undefined;
  return typeof err.data?.reason === 'string' ? err.data.reason : 'refused';
}

/** Kolab refused the token: a 401 on connect, or invalid_token on a read. */
function isRefusal(e: unknown) {
  return /\b401\b|invalid_token|invalid Konjir token|Unauthorized/i.test(messageOf(e));
}

function messageOf(e: unknown) {
  const err = e as { message?: string; cause?: unknown };
  const cause = err?.cause ? ` (${String((err.cause as { message?: string }).message ?? err.cause)})` : '';
  return `${String(err?.message ?? e)}${cause}`;
}


