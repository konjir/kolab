import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SERVER_INFO_META_KEY, SUBSCRIPTION_ID_META_KEY, type AuthInfo } from '@modelcontextprotocol/server';
import { Kolab, sessionKey } from '@konjir/engine';
import { isSessionEnded } from '@konjir/types';
import { KOLAB, SERVER_INFO } from './tokens.js';

type Next = (error?: unknown) => void;
type Request = IncomingMessage & { body?: unknown; auth?: AuthInfo };

/**
 * Each agent session's open subscriptions/listen streams, so that ending the session
 * closes them and nothing more is signalled to its revoked token (API4, D41).
 *
 * A temporary bridge: neither @onivoro/server-mcp nor the MCP SDK can close or gate a
 * single listen stream yet (the SDK serves them itself and broadcasts every change to
 * all of them). So this watches the HTTP response of each listen request, in front of
 * the SDK, until onivoro offers that (say McpHttpService.closeListenStreams(predicate)
 * and a listen gate).
 *
 * - A stream is tracked once the SDK answers with an event stream, under the identity
 *   KonjirAuth verified for that request (req.auth). The admin token's streams aren't.
 * - When a session ends (a SessionEndedEvent, from this process or, once events cross
 *   processes, another), its streams close gracefully: after the SDK's acknowledgement,
 *   the listen request's result, which the client reads as the server closing the
 *   subscription, then the end of the response. The SDK sees the response close and
 *   drops the stream.
 * - Before each change is signalled, Inboxes calls closeEnded: one query over every
 *   tracked session, closing the streams of any that has ended without an event
 *   (directly in the database, say). So the gate is before the SDK writes, not on frames.
 * A reconnect with the ended token is refused (401) by KonjirAuth.
 */
@Injectable()
export class ListenStreams implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ListenStreams.name);
  /** By sessionKey: the session's token (to check it) and its open streams. */
  private readonly bySession = new Map<string, { token: string; streams: Set<ListenStream> }>();
  private unsubscribe?: () => void;

  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  onModuleInit() {
    this.unsubscribe = this.kolab.onEvent((e) => { if (isSessionEnded(e)) this.closeSession(e.id); });
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    for (const key of [...this.bySession.keys()]) this.closeSession(key);
    this.bySession.clear();
  }

  /** The number of streams open; for tests. */
  get openCount() {
    let n = 0;
    for (const { streams } of this.bySession.values()) n += streams.size;
    return n;
  }

  /** Close every open listen stream of the session with this sessionKey. Other sessions' streams are left alone. */
  closeSession(key: string) {
    for (const s of [...(this.bySession.get(key)?.streams ?? [])]) s.close();
  }

  /**
   * Before a change is signalled: close the streams of every tracked session that has
   * ended, in one query however many streams there are. False if the check failed, so
   * the caller holds the signal back rather than signal a session it couldn't check.
   */
  async closeEnded(): Promise<boolean> {
    const checked = [...this.bySession].map(([key, { token }]) => ({ key, token }));
    if (!checked.length) return true;
    let open: Set<string>;
    try {
      open = await this.kolab.openSessions(checked.map((c) => c.token));
    } catch (e) {
      this.logger.warn(`could not check ${checked.length} listening session(s) before signalling a change, so it wasn't signalled: ${redact(e)}`);
      return false;
    }
    for (const { key, token } of checked) if (!open.has(token)) this.closeSession(key);
    return true;
  }

  /** Middleware on POST to the MCP route: watch the response of each listen request. */
  track(req: Request, res: ServerResponse, next: Next) {
    const id = listenRequestId(req.body);
    if (id !== undefined) new ListenStream(req, res, id, this);
    next();
  }

  /** A stream opened with this verified identity. */
  opened(s: ListenStream, token: string) {
    const key = sessionKey(token);
    let entry = this.bySession.get(key);
    if (!entry) this.bySession.set(key, entry = { token, streams: new Set() });
    entry.streams.add(s);
    // A session ended between its auth check and now has had its event already.
    this.kolab.sessionOpen(token).then(
      (open) => { if (!open) s.close(); },
      (e) => this.logger.warn(`could not check a new listen stream's session; it stays open until the next change checks it: ${redact(e)}`),
    );
    return key;
  }

  closed(s: ListenStream, key: string) {
    const entry = this.bySession.get(key);
    if (!entry?.streams.delete(s)) return;
    if (!entry.streams.size) this.bySession.delete(key);
  }
}

/**
 * One listen response. It becomes a stream once the SDK answers with an event stream; a
 * refusal (401, or a JSON-RPC error) passes through untouched. Writes pass straight
 * through, with their arguments and return value, until the stream is closed.
 */
class ListenStream {
  private state: 'pending' | 'open' | 'closed' = 'pending';
  private key?: string;
  /** The SDK's first frame, the acknowledgement, has gone out; a close waits for it. */
  private acknowledged = false;
  private closeWanted = false;
  private readonly write: (...args: unknown[]) => boolean;
  private readonly end: (...args: unknown[]) => ServerResponse;

  constructor(req: Request, private readonly res: ServerResponse, private readonly id: string | number, private readonly owner: ListenStreams) {
    this.write = res.write.bind(res) as (...args: unknown[]) => boolean;
    this.end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;

    res.writeHead = ((...args: unknown[]) => {
      const out = writeHead(...args);
      // Onivoro authenticated this same request before the SDK answered: req.auth is what KonjirAuth verified.
      const auth = req.auth;
      if (this.state === 'pending' && args[0] === 200 && /^text\/event-stream/i.test(contentTypeOf(res, args))
        && auth && !auth.scopes.includes('admin')) {
        this.state = 'open';
        this.key = owner.opened(this, auth.token);
      }
      return out;
    }) as ServerResponse['writeHead'];

    res.write = ((...args: unknown[]) => {
      if (this.state === 'closed') {
        // The stream is closed: what the SDK still writes is dropped, as written.
        const done = args.find((a) => typeof a === 'function') as (() => void) | undefined;
        if (done) queueMicrotask(done);
        return true;
      }
      const ok = this.write(...args);
      if (this.state === 'open' && !this.acknowledged) {
        this.acknowledged = true;
        if (this.closeWanted) this.close();
      }
      return ok;
    }) as ServerResponse['write'];

    res.end = ((...args: unknown[]) => {
      if (this.state === 'closed') return res;
      this.finish();
      return this.end(...args);
    }) as ServerResponse['end'];

    res.once('close', () => this.finish());
  }

  /** Close the stream as the server: after the acknowledgement, the listen request's result, then the end of the response. */
  close() {
    if (this.state !== 'open') return;
    if (!this.acknowledged) { this.closeWanted = true; return; }
    this.finish();
    if (this.res.writableEnded || this.res.destroyed) return;
    // The SDK's own graceful close (listenRouter's teardown(true)), which it can't be asked to send.
    const result = { resultType: 'complete', _meta: { [SUBSCRIPTION_ID_META_KEY]: this.id, [SERVER_INFO_META_KEY]: SERVER_INFO } };
    this.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: this.id, result })}\n\n`);
    this.end();
  }

  private finish() {
    if (this.state === 'closed') return;
    const wasOpen = this.state === 'open';
    this.state = 'closed';
    if (wasOpen && this.key) this.owner.closed(this, this.key);
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

/** An error fit to log: any session token in it is masked. */
function redact(e: unknown) {
  return String((e as { message?: unknown })?.message ?? e).replace(/kjs_[A-Za-z0-9_-]+/g, 'kjs_***');
}
