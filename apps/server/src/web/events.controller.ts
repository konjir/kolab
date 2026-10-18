import { Controller, Get, HttpException, Inject, Injectable, Logger, type OnModuleDestroy, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Kolab, maskTokens, versionsRevision } from '@konjir/engine';
import { isInboxEvent, isSessionEnded, type KolabEvent, type WebEvent, type WebMe } from '@konjir/types';
import { KOLAB, WEB_OPTIONS, type WebOptions } from '../tokens.js';
import { WebSession, WebSessionGuard, WebSessionId, WebWho } from './auth.js';

/** The most event streams one session may hold open at once: a few tabs, not a flood. */
export const MAX_STREAMS_PER_SESSION = 6;

/**
 * One page's stream: the access token it opened with, and its session's id (key). A stream lives
 * as long as its token: when the token expires or rotates (D55) but the session lives on, the
 * stream closes without `ended`, and the browser reconnects, refreshing the token as it does.
 */
interface Stream { token: string; key: string; kolab: string; send(e: WebEvent): void; end(why?: 'ended'): void }

/**
 * The open event streams of this process, by kolab. Commits signal no inbox, so this process
 * checks each kolab that has a stream open for new versions, once per interval, however many
 * streams are open there, one check at a time (the next is scheduled only when the last is done),
 * and tells every stream in that kolab. Closing the server ends every stream.
 */
@Injectable()
export class WebStreams implements OnModuleDestroy {
  private readonly logger = new Logger('WebEvents');
  private readonly byKolab = new Map<string, { streams: Set<Stream>; timer?: ReturnType<typeof setTimeout>; revision?: string; first?: Promise<void> }>();
  private readonly perSession = new Map<string, number>();

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(WEB_OPTIONS) private readonly options: WebOptions,
  ) {}

  /** Whether the session may open another stream. */
  canOpen(key: string) {
    return (this.perSession.get(key) ?? 0) < MAX_STREAMS_PER_SESSION;
  }

  /** Adds a stream; resolves once its kolab's versions are known, so a commit after that is seen. */
  add(s: Stream): Promise<void> {
    this.perSession.set(s.key, (this.perSession.get(s.key) ?? 0) + 1);
    let k = this.byKolab.get(s.kolab);
    if (!k) {
      k = { streams: new Set() };
      this.byKolab.set(s.kolab, k);
    }
    k.streams.add(s);
    // The kolab's first stream checks at once, to know where its versions stand; the checks then repeat.
    k.first ??= this.check(s.kolab);
    return k.first;
  }

  remove(s: Stream) {
    const n = (this.perSession.get(s.key) ?? 1) - 1;
    if (n > 0) this.perSession.set(s.key, n); else this.perSession.delete(s.key);
    const k = this.byKolab.get(s.kolab);
    if (!k?.streams.delete(s) || k.streams.size) return;
    clearTimeout(k.timer);
    this.byKolab.delete(s.kolab);
  }

  private schedule(kolab: string) {
    const k = this.byKolab.get(kolab);
    if (k) k.timer = setTimeout(() => void this.check(kolab), this.options.versionsPollMs ?? 3000);
  }

  /** One check of a kolab's versions, read as one of its streams' sessions reads. */
  private async check(kolab: string) {
    const k = this.byKolab.get(kolab);
    if (!k) return;
    try {
      for (const s of [...k.streams]) {
        let now: string;
        try {
          now = await versionsRevision(this.kolab, s.token);
        } catch (e) {
          // That session ended or lost its access, or its token expired: tell its page, and try the next stream's.
          const state = await tokenState(this.kolab, s).catch(() => 'live' as const);
          if (state !== 'live') { s.end(state === 'ended' ? 'ended' : undefined); continue; }
          throw e;
        }
        if (k.revision !== undefined && now !== k.revision) for (const t of k.streams) t.send({ type: 'changed', what: 'versions' });
        k.revision = now;
        break;
      }
    } catch (e) {
      this.logger.warn(`could not check kolab ${kolab}'s versions for its web pages: ${maskTokens(e)}`);
    } finally {
      if (this.byKolab.get(kolab) === k && k.streams.size) this.schedule(kolab);
    }
  }

  onModuleDestroy() {
    for (const k of [...this.byKolab.values()]) for (const s of [...k.streams]) s.end();
  }
}

/**
 * GET /api/events: the web interface's server-sent events (API8), one stream per open page, at
 * most MAX_STREAMS_PER_SESSION per session (429 beyond).
 *
 * It sends signals, never content; the page re-reads what it shows:
 * - `changed` `layer` when a layer's inbox changes (a question, a note, a mark, a review request),
 *   from this process or any other on the database (API5), as the MCP inboxes are signalled, and
 *   only for the session's own kolab: each event names its kolab (D50).
 * - `changed` `answers` when the session's own actor's answers change.
 * - `changed` `versions` when a version is written or changes state in the session's kolab (WebStreams).
 * - `ended` when the session ends (D41), and the stream closes. The session is checked before each
 *   signal, as /mcp's listen streams are, so a session ended any other way ends its stream too.
 *
 * A comment every 20 s keeps proxies from closing an idle stream.
 */
@Controller('api')
@UseGuards(WebSessionGuard)
export class WebEventsController {
  private readonly logger = new Logger('WebEvents');

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(WebStreams) private readonly streams: WebStreams,
  ) {}

  @Get('events')
  events(@WebSession() s: string, @WebSessionId() key: string, @WebWho() me: WebMe, @Req() req: Request, @Res() res: Response) {
    if (req.destroyed || res.destroyed) return;
    if (!this.streams.canOpen(key)) {
      const e = new HttpException({ error: 'too_many_streams', message: `a session may hold ${MAX_STREAMS_PER_SESSION} event streams at once; close a tab` }, 429);
      res.status(429).json(e.getResponse());
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    // Reconnect soon after a close that isn't the session's end: an access token's expiry (D55).
    res.write('retry: 1000\n\n');

    let ended = false;
    const pending = new Map<string, WebEvent>();
    let scheduled = false;
    const send = (e: WebEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
    const stream: Stream = {
      token: s, key, kolab: me.kolab, send,
      end: (why) => {
        if (ended) return;
        ended = true;
        if (why) send({ type: 'ended' });
        unsubscribe();
        clearInterval(ping);
        this.streams.remove(stream);
        res.end();
      },
    };

    /** Signals what changed, once the session is checked: a session ended meanwhile gets `ended` instead. */
    const flush = async () => {
      scheduled = false;
      if (ended) return;
      const events = [...pending.values()];
      pending.clear();
      try {
        const state = await tokenState(this.kolab, stream);
        if (state !== 'live') return stream.end(state === 'ended' ? 'ended' : undefined);
      } catch (e) {
        this.logger.warn(`could not check a web session before signalling it, so it wasn't signalled: ${maskTokens(e)}`);
        return;
      }
      for (const e of events) send(e);
    };
    const queue = (e: WebEvent) => {
      pending.set(JSON.stringify(e), e);
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => void flush());
    };
    const unsubscribe = this.kolab.onEvent((e: KolabEvent) => {
      if (isSessionEnded(e)) { if (e.id === key) stream.end('ended'); return; }
      if (!isInboxEvent(e)) return;
      // Push signals name their kolab (D50): only the session's own reaches its page.
      if (e.kolab !== me.kolab) return;
      if (e.inbox === 'layer') queue({ type: 'changed', what: 'layer', layer: e.layer });
      else if (e.actor === me.actor) queue({ type: 'changed', what: 'answers' });
    });
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20_000);
    // The response closes when the client goes (or the server closes the connection). Everything
    // from the guard to here is synchronous, so a client gone already is seen as destroyed above.
    res.on('close', () => stream.end());
    void this.streams.add(stream).then(() => send({ type: 'ready' }));
  }
}

/**
 * Where a stream's token stands: still `live`; `expired`, or rotated by a refresh (D55), while its
 * session lives on, so the page reconnects; or `ended` with its session.
 */
async function tokenState(kolab: Kolab, s: Pick<Stream, 'token' | 'key'>): Promise<'live' | 'expired' | 'ended'> {
  if (await kolab.sessionOpen(s.token)) return 'live';
  return (await kolab.liveSessions([s.key])).has(s.key) ? 'expired' : 'ended';
}
