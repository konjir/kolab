/**
 * The Kolab side of the bridge: an MCP client of Kolab that subscribes to the
 * session's inbox and answers over subscriptions/listen, reads each resource
 * Kolab signals, and hands a channel message for each change to `forward`.
 * It reconnects, with backoff, whenever Kolab goes away or stops answering.
 */
import { Client, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import { describeChange, describeStartup, type ChannelMessage } from './messages.js';
import { VERSION } from './version.js';

export interface BridgeOptions {
  url: string;
  token: string;
  /** Deliver a message to the Claude Code session. */
  forward(message: ChannelMessage): Promise<void>;
  /** A line for the operator (stderr). Never carries the token. */
  log(line: string): void;
  /** Reconnect delays: doubles from `initialMs` up to `maxMs`. */
  backoff?: { initialMs: number; maxMs: number };
  /** How often to check on Kolab while listening, and how long to wait for the reply. */
  liveness?: { intervalMs: number; timeoutMs: number };
  /** The fetch the Kolab transport uses (tests stand in a network here). */
  fetch?: FetchLike;
}

export interface Whoami { actor: string; role: string; layer: string; subscribe: string[] }

/** Kolab answered, but the token can't drive a channel: it isn't an agent session token. */
class NotAnAgentToken extends Error {}

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
  /** The problem last reported, so a retry loop doesn't repeat itself. */
  private lastProblem?: string;
  /** Who this session is, once Kolab has said. */
  me?: Whoami;
  /** Called each time a subscription is open and caught up; for tests. */
  onListening?: (me: Whoami) => void;

  constructor(private readonly opts: BridgeOptions) {}

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

  /** Any text fit to log or send: the token never appears in it. */
  redact(text: string) {
    return this.opts.token ? text.split(this.opts.token).join('***') : text;
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
    const { initialMs, maxMs } = this.opts.backoff ?? { initialMs: 1000, maxMs: 30_000 };
    let delay = initialMs;
    let everConnected = false;
    while (!this.stopped) {
      let client: Client | undefined;
      try {
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
          this.log('Kolab refused a read with this token; reconnecting');
        } else {
          this.lastProblem = undefined;
          this.log(`${everConnected ? 'reconnected' : 'connected'} to Kolab at ${safeUrl(this.opts.url)} as ${me.actor} (${me.role}); watching ${me.subscribe.join(', ')}`);
          everConnected = true;
          delay = initialMs;
          if (!this.summarized && firstReads.length) {
            this.summarized = true;
            const summary = describeStartup(firstReads);
            if (summary) await this.opts.forward({ content: this.redact(summary.content), meta: summary.meta });
          }
          this.onListening?.(me);
          const alive = this.watchLiveness(client, stop);
          const how = await Promise.race([subscription.closed.then(() => 'closed' as const), ended, this.stopping]);
          alive();
          if (how !== 'closed') await subscription.close().catch(() => undefined);
          if (how === 'stopped') break;
          this.log(how === 'refused' ? 'Kolab refused a read with this token; reconnecting'
            : how === 'unresponsive' ? 'Kolab stopped answering; reconnecting'
            : 'Kolab closed the subscription stream; reconnecting');
        }
      } catch (e) {
        if (this.stopped) break;
        const msg = messageOf(e);
        if (e instanceof NotAnAgentToken) {
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
    return new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.opts.token}` } },
      fetch: (input, init) => (this.opts.fetch ?? fetch)(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, this.abort.signal]) : this.abort.signal,
      }),
    });
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

/** The URL fit to print: no credentials, no query. */
function safeUrl(url: string) {
  try {
    const u = new URL(url);
    u.username = ''; u.password = ''; u.search = '';
    return u.toString();
  } catch {
    return '(invalid KONJIR_URL)';
  }
}
