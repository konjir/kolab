import { Controller, Get, Inject, Injectable, Logger, type OnModuleDestroy, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Kolab, maskTokens, sessionKey, versionsRevision } from '@konjir/engine';
import { isInboxEvent, isSessionEnded, type KolabEvent, type WebEvent } from '@konjir/types';
import { KOLAB, WEB_OPTIONS, type WebOptions } from '../tokens.js';
import { WebSession, WebSessionGuard } from './auth.js';

/** Open event streams, so closing the server ends them, and their timers, at once. */
@Injectable()
export class WebStreams implements OnModuleDestroy {
  readonly open = new Set<() => void>();
  onModuleDestroy() {
    for (const end of [...this.open]) end();
  }
}

/**
 * GET /api/events: the web interface's server-sent events (API8), one stream per open page.
 *
 * It sends signals, never content; the page re-reads what it shows:
 * - `changed` `layer` when a layer's inbox changes (a question, a note, a mark, a review request),
 *   from this process or any other on the database (API5), as the MCP inboxes are signalled. Push
 *   signals name a layer, not a kolab, so a page re-reads its own kolab's (README, Tenancy is
 *   partial). An event that names a kolab other than the session's is dropped.
 * - `changed` `answers` when the session's own actor's answers change.
 * - `changed` `versions` when a version is written or changes state in the session's kolab. A
 *   commit signals no inbox, so the stream checks the kolab's versions every few seconds.
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
    @Inject(WEB_OPTIONS) private readonly options: WebOptions,
    @Inject(WebStreams) private readonly streams: WebStreams,
  ) {}

  @Get('events')
  async events(@WebSession() s: string, @Req() req: Request, @Res() res: Response) {
    const me = await this.kolab.sessionInfo(s);
    const key = sessionKey(s);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    const send = (e: WebEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };

    let ended = false;
    const pending = new Map<string, WebEvent>();
    let scheduled = false;
    let revision: string | undefined;
    const end = (why?: 'ended') => {
      if (ended) return;
      ended = true;
      if (why) send({ type: 'ended' });
      unsubscribe();
      clearInterval(ping);
      clearInterval(poll);
      this.streams.open.delete(end);
      res.end();
    };
    this.streams.open.add(end);

    /** Signals what changed, once the session is checked: a session ended meanwhile gets `ended` instead. */
    const flush = async () => {
      scheduled = false;
      if (ended) return;
      const events = [...pending.values()];
      pending.clear();
      try {
        if (!(await this.kolab.sessionOpen(s))) return end('ended');
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
      if (isSessionEnded(e)) { if (e.id === key) end('ended'); return; }
      if (!isInboxEvent(e)) return;
      // Push signals per kolab (D50) may name the kolab: then only the session's own is signalled.
      const named = (e as { kolab?: unknown }).kolab;
      if (typeof named === 'string' && named !== me.kolab) return;
      if (e.inbox === 'layer') queue({ type: 'changed', what: 'layer', layer: e.layer });
      else if (e.actor === me.actor) queue({ type: 'changed', what: 'answers' });
    });

    const check = async () => {
      if (ended) return;
      try {
        const now = await versionsRevision(this.kolab, s);
        if (revision !== undefined && now !== revision) queue({ type: 'changed', what: 'versions' });
        revision = now;
      } catch (e) {
        // The session ended or lost its access (which ends it): tell the page. Anything else, try again next time.
        if (!(await this.kolab.sessionOpen(s).catch(() => true))) return end('ended');
        this.logger.warn(`could not check a web session's kolab for new versions: ${maskTokens(e)}`);
      }
    };
    const poll = setInterval(() => void check(), this.options.versionsPollMs ?? 3000);
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20_000);
    req.on('close', () => end());
    send({ type: 'ready' });
    await check();
  }
}
