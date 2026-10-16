import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/server';
import { Kolab } from '@konjir/engine';
import { isSessionEnded } from '@konjir/types';
import { KOLAB, SERVER_OPTIONS, type ServerOptions } from './tokens.js';

type Next = (error?: unknown) => void;

/**
 * Each agent session's open subscriptions/listen streams, so that ending the session
 * closes them and nothing more is signalled to its revoked token (API4, D41).
 *
 * The MCP SDK serves listen streams itself and broadcasts every change to all of them,
 * with no hook per stream. So this sits in front of it, on the HTTP response of each
 * listen request an agent token makes:
 * - when the session ends (a SessionEndedEvent, from this process or, once events cross
 *   processes, another), each of its streams is closed gracefully: the listen request's
 *   JSON-RPC result, which the client reads as the server closing the subscription, then
 *   the end of the response. The SDK sees the response close and drops the stream.
 * - before each change notification is written, the session is checked again, as a
 *   backstop for a session ended without an event (directly in the database, say). A
 *   session found ended closes the stream the same way, and the notification isn't sent.
 * A reconnect with the ended token is refused (401) by KonjirAuth.
 */
@Injectable()
export class ListenStreams implements OnModuleInit, OnModuleDestroy {
  private readonly bySession = new Map<string, Set<ListenStream>>();
  private unsubscribe?: () => void;

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(SERVER_OPTIONS) private readonly options: ServerOptions,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.kolab.onEvent((e) => { if (isSessionEnded(e)) this.closeSession(e.id); });
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    for (const streams of this.bySession.values()) for (const s of streams) s.close();
    this.bySession.clear();
  }

  /** The number of streams open; for tests. */
  get openCount() {
    let n = 0;
    for (const streams of this.bySession.values()) n += streams.size;
    return n;
  }

  /** Close every open listen stream of a session. Other sessions' streams are left alone. */
  closeSession(session: string) {
    for (const s of [...(this.bySession.get(session) ?? [])]) s.close();
  }

  /** Middleware on POST /mcp: watch the response of each listen request an agent token makes. */
  track(req: IncomingMessage & { body?: unknown }, res: ServerResponse, next: Next) {
    const id = listenRequestId(req.body);
    const token = bearerOf(req.headers.authorization);
    if (id !== undefined && token && token !== this.options.adminToken) {
      new ListenStream(res, id, () => this.kolab.sessionOpen(token), {
        opened: (s) => this.add(token, s),
        closed: (s) => this.remove(token, s),
      });
    }
    next();
  }

  private add(session: string, s: ListenStream) {
    let streams = this.bySession.get(session);
    if (!streams) this.bySession.set(session, streams = new Set());
    streams.add(s);
  }

  private remove(session: string, s: ListenStream) {
    const streams = this.bySession.get(session);
    if (!streams?.delete(s)) return;
    if (!streams.size) this.bySession.delete(session);
  }
}

/**
 * One listen response. It becomes a stream once the SDK answers with an event stream; a
 * refusal (401, or a JSON-RPC error) passes through untouched. From then on, writes go out
 * in order, each change notification only after the session is found still open.
 */
class ListenStream {
  private active = false;
  private closed = false;
  /** Writes in order: a notification waiting on its session check holds back what follows. */
  private tail: Promise<void> = Promise.resolve();
  private readonly write: ServerResponse['write'];
  private readonly end: ServerResponse['end'];

  constructor(
    private readonly res: ServerResponse,
    private readonly id: string | number,
    private readonly sessionOpen: () => Promise<boolean>,
    private readonly hooks: { opened(s: ListenStream): void; closed(s: ListenStream): void },
  ) {
    this.write = res.write.bind(res) as ServerResponse['write'];
    this.end = res.end.bind(res) as ServerResponse['end'];
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;

    res.writeHead = ((...args: unknown[]) => {
      const out = writeHead(...args);
      if (!this.active && args[0] === 200 && /^text\/event-stream/i.test(contentTypeOf(res, args))) this.open();
      return out;
    }) as ServerResponse['writeHead'];

    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (!this.active) return (this.write as (...a: unknown[]) => boolean)(chunk, ...rest);
      this.then(async () => {
        if (isChangeNotification(chunk) && !(await this.stillOpen())) return this.close();
        if (!this.closed) (this.write as (...a: unknown[]) => boolean)(chunk);
      });
      return true;
    }) as ServerResponse['write'];

    res.end = ((...args: unknown[]) => {
      if (!this.active) return (this.end as (...a: unknown[]) => ServerResponse)(...args);
      this.then(() => { if (!this.closed) this.finish(() => (this.end as (...a: unknown[]) => ServerResponse)(...args)); });
      return res;
    }) as ServerResponse['end'];

    res.once('close', () => this.finish());
  }

  /** The SDK answered with an event stream: track it, and check its session once now. */
  private open() {
    this.active = true;
    this.hooks.opened(this);
    // A session ended between its auth check and now has had its event already.
    this.then(async () => { if (!(await this.stillOpen())) this.close(); });
  }

  /** Close the stream as the server: the listen request's result, then the end of the response. */
  close() {
    if (this.closed) return;
    this.finish(() => {
      if (this.res.writableEnded || this.res.destroyed) return;
      const result = { resultType: 'complete', _meta: { [SUBSCRIPTION_ID_META_KEY]: this.id } };
      this.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: this.id, result })}\n\n`);
      this.end();
    });
  }

  private finish(last?: () => void) {
    if (this.closed) return;
    this.closed = true;
    this.hooks.closed(this);
    last?.();
  }

  private async stillOpen() {
    // A check that fails closes the stream: the client reconnects, and is checked again then.
    try { return await this.sessionOpen(); } catch { return false; }
  }

  private then(step: () => void | Promise<void>) {
    this.tail = this.tail.then(step).catch(() => { try { this.close(); } catch { /* the response is already gone */ } });
  }
}

/** The id of a subscriptions/listen request, or undefined for any other body. */
function listenRequestId(body: unknown): string | number | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const m = body as { method?: unknown; id?: unknown };
  return m.method === 'subscriptions/listen' && (typeof m.id === 'string' || typeof m.id === 'number') ? m.id : undefined;
}

/** The content type a writeHead call sets: from its headers argument, or one set before it. */
function contentTypeOf(res: ServerResponse, args: unknown[]) {
  const headers = args.find((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a));
  const given = headers && Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  return String(given ?? res.getHeader('content-type') ?? '');
}

function bearerOf(header: string | undefined) {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1];
}

/** An SSE frame carrying a change notification. The subscription's acknowledgement and keep-alives aren't. */
function isChangeNotification(chunk: unknown) {
  const text = typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : '';
  return /"method":"notifications\/(resources\/updated|resources\/list_changed|tools\/list_changed|prompts\/list_changed)"/.test(text);
}
