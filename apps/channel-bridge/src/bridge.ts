/**
 * The Kolab side of the bridge: an MCP client of Kolab that subscribes to the
 * session's inbox and answers over subscriptions/listen, reads each resource
 * Kolab signals, and hands a channel message for each change to `forward`.
 * It reconnects, with backoff, whenever Kolab goes away.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describeChange, type ChannelMessage } from './messages.js';

export interface BridgeOptions {
  url: string;
  token: string;
  /** Deliver a message to the Claude Code session. */
  forward(message: ChannelMessage): Promise<void>;
  /** A line for the operator (stderr). Never carries the token. */
  log(line: string): void;
  /** Reconnect delays: doubles from `initialMs` up to `maxMs`. */
  backoff?: { initialMs: number; maxMs: number };
}

export interface Whoami { actor: string; role: string; layer: string; subscribe: string[] }

const VERSION = '0.1.0';

export class KolabBridge {
  private stopped = false;
  private wake!: () => void;
  /** Resolves once stop() is called. */
  private readonly stopping = new Promise<'stopped'>((resolve) => { this.wake = () => resolve('stopped'); });
  private running?: Promise<void>;
  /** The last contents seen of each resource, so a change is described against what came before. */
  private readonly seen = new Map<string, unknown>();
  /** Updates are handled one at a time, in arrival order. */
  private queue: Promise<void> = Promise.resolve();
  private refusedToldClaude = false;
  /** Who this session is, once Kolab has said. */
  me?: Whoami;
  /** Resolves each time a subscription is open; for tests and logs. */
  onListening?: (me: Whoami) => void;

  constructor(private readonly opts: BridgeOptions) {}

  start() {
    this.running ??= this.run();
    return this;
  }

  async stop() {
    this.stopped = true;
    this.wake();
    await this.running;
  }

  /** Any text fit to log or send: the token never appears in it. */
  redact(text: string) {
    return this.opts.token ? text.split(this.opts.token).join('***') : text;
  }

  private log(line: string) {
    this.opts.log(this.redact(line));
  }

  private async run() {
    const { initialMs, maxMs } = this.opts.backoff ?? { initialMs: 1000, maxMs: 30_000 };
    let delay = initialMs;
    let everConnected = false;
    while (!this.stopped) {
      let client: Client | undefined;
      try {
        client = await this.connect();
        const me = await this.whoami(client);
        this.me = me;
        this.refusedToldClaude = false;
        // A read Kolab refuses (the session was ended while the stream stayed open) drops
        // this connection, so the loop reconnects and whoami reports the refusal.
        let drop!: () => void;
        const dropped = new Promise<'refused'>((resolve) => { drop = () => resolve('refused'); });
        // On the first connection, the first read of each resource is a baseline, not news.
        const first = !everConnected;
        const c = client;
        const enqueue = (uri: string) => {
          this.queue = this.queue.then(() => this.update(c, uri, first)).catch((e) => {
            this.log(`could not read ${uri}: ${messageOf(e)}`);
            if (isRefusal(e)) drop();
          });
        };
        client.setNotificationHandler('notifications/resources/updated', (n) => enqueue(n.params.uri));
        // Listen first, then read: a change landing in between is then both signalled and read.
        const subscription = await client.listen({ resourceSubscriptions: me.subscribe });
        // Read each resource now: a baseline on first connect, and on a reconnect,
        // whatever changed while the bridge was away.
        for (const uri of me.subscribe) enqueue(uri);
        await this.queue;
        this.log(`${everConnected ? 'reconnected' : 'connected'} to Kolab at ${safeUrl(this.opts.url)} as ${me.actor} (${me.role}); watching ${me.subscribe.join(', ')}`);
        everConnected = true;
        delay = initialMs;
        this.onListening?.(me);
        const how = await Promise.race([subscription.closed, dropped, this.stopping]);
        if (how === 'refused' || how === 'stopped') await subscription.close().catch(() => undefined);
        if (how === 'stopped') break;
        this.log(how === 'refused' ? 'Kolab refused a read with this token; reconnecting' : `Kolab ended the subscription (${how}); reconnecting`);
      } catch (e) {
        if (this.stopped) break;
        const msg = messageOf(e);
        if (isRefusal(e)) {
          this.log(`Kolab at ${safeUrl(this.opts.url)} refused the token; retrying in ${Math.round(delay / 1000)}s`);
          if (!this.refusedToldClaude) {
            this.refusedToldClaude = true;
            await this.opts.forward({
              content: `The Konjir channel can't sign in to Kolab at ${safeUrl(this.opts.url)}: Kolab refused its session token (revoked or mistyped). Inbox changes won't arrive until KONJIR_TOKEN is fixed and Claude Code restarts. Tell the user.`,
              meta: { kind: 'bridge', status: 'refused' },
            }).catch(() => undefined);
          }
        } else {
          this.log(`cannot reach Kolab at ${safeUrl(this.opts.url)} (${msg}); retrying in ${Math.round(delay / 1000)}s`);
        }
      } finally {
        await client?.close().catch(() => undefined);
      }
      if (this.stopped) break;
      await this.sleep(delay);
      delay = Math.min(delay * 2, maxMs);
    }
  }

  private async connect() {
    // 'auto' talks 2026-07-28 to Kolab, which subscriptions/listen needs.
    const client = new Client({ name: 'konjir-channel-bridge', version: VERSION }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.opts.token}` } },
    }));
    return client;
  }

  private async whoami(client: Client): Promise<Whoami> {
    const r = await client.callTool({ name: 'konjir_whoami', arguments: {} });
    if (r.isError) throw new Error((r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n'));
    const me = r.structuredContent as Whoami | undefined;
    if (!me?.subscribe?.length) throw new Error('konjir_whoami named no resources to subscribe to; is this an agent session token?');
    return me;
  }

  /** Read `uri` and forward what changed since it was last seen. A baseline read forwards nothing. */
  private async update(client: Client, uri: string, baseline = false) {
    const r = await client.readResource({ uri }, { cacheMode: 'bypass' });
    const c = r.contents[0];
    const body = c && 'text' in c ? JSON.parse(c.text) as unknown : null;
    const had = this.seen.has(uri);
    const before = this.seen.get(uri);
    this.seen.set(uri, body);
    if (baseline && !had) return;
    const message = describeChange(uri, had ? before : undefined, body);
    if (message) await this.opts.forward({ content: this.redact(message.content), meta: message.meta });
  }

  private sleep(ms: number) {
    return Promise.race([new Promise<void>((r) => setTimeout(r, ms).unref()), this.stopping.then(() => undefined)]);
  }
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
