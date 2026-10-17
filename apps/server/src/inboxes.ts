import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { McpResource, McpToolRegistry, type McpHandlerContext } from '@onivoro/server-mcp';
import { Kolab, RoleError, type ListenerState } from '@konjir/engine';
import { LAYERS, isInboxEvent, type Layer } from '@konjir/types';
import { ListenStreams } from './listen-streams.js';
import { sessionOf } from './results.js';
import { KOLAB } from './tokens.js';
import { uriOf } from './uris.js';

/** Each layer's inbox and each actor's answers, and the push that signals them. */
@Injectable()
export class Inboxes implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;
  private unwatch?: () => void;
  private readonly logger = new Logger('Push');

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(McpToolRegistry) private readonly registry: McpToolRegistry,
    @Inject(ListenStreams) private readonly streams: ListenStreams,
  ) {}

  /** Changes waiting to be signalled, gathered so one write's several changes cost one session check. */
  private readonly pending = new Set<string>();
  private scheduled = false;

  /**
   * Push: every open subscriptions/listen stream that subscribed to an inbox hears when it
   * changes, whichever Kolab process on the database made the change (API5). First,
   * ListenStreams closes the streams of any session that has ended (D41).
   */
  async onModuleInit() {
    this.unsubscribe = this.kolab.onEvent((e) => {
      if (!isInboxEvent(e)) return;
      this.pending.add(uriOf(e));
      if (this.scheduled) return;
      this.scheduled = true;
      setImmediate(() => void this.signal());
    });
    // After boot, a lost listener degrades push, not the server: say so as it happens.
    this.unwatch = this.kolab.onListenerState((s) => this.report(s));
    // A server that can't hear other processes at boot doesn't start.
    await this.kolab.listen();
  }

  /**
   * Logs when this process stops hearing other processes' changes, and when it hears them again.
   * The listener re-establishes the connection itself and the Kolab resyncs (Kolab.listen); this
   * reports what actually happened, however short the outage.
   */
  report(s: ListenerState) {
    if (s.state === 'lost') this.logger.error('push across processes is down: the LISTEN connection is lost, so this process\'s subscribers miss changes made through other processes until it reconnects');
    else if (s.state === 'resync_failed') this.logger.error(`push across processes: the LISTEN connection is back, but signalling what changed meanwhile failed (${s.error}); retrying in ${Math.round(s.retryInMs / 1000)} s`);
    else this.logger.warn('push across processes restored: the LISTEN connection is back, and every inbox was signalled again for what changed meanwhile');
  }

  private async signal() {
    this.scheduled = false;
    const uris = [...this.pending];
    this.pending.clear();
    if (!(await this.streams.closeEnded())) return;
    for (const uri of uris) this.registry.notifyResourceUpdated(uri);
  }

  onModuleDestroy() {
    this.unwatch?.();
    this.unsubscribe?.();
  }

  @McpResource({
    name: 'konjir_inbox',
    uri: 'konjir://inbox/{layer}',
    isTemplate: true,
    title: 'A layer\'s work queue',
    description: 'Open questions and notes the layer owns, and open marks on its work. Subscribe to your own layer\'s inbox; it is updated whenever that queue changes.',
    mimeType: 'application/json',
  })
  async inbox(uri: URL, vars: Record<string, string | string[]>, context?: McpHandlerContext) {
    const layer = String(vars.layer) as Layer;
    if (!LAYERS.includes(layer)) throw new Error(`no inbox ${uri.href}`);
    const session = sessionOf(context?.authInfo);
    if (!session) throw new RoleError('reading an inbox needs an agent session token');
    // The layer's queue in the session's own kolab (TEN12).
    const kolab = await this.kolab.sessionKolab(session);
    const body = {
      layer,
      queries: await this.kolab.listQueries({ layer, state: 'open', kolab }),
      marks: await this.kolab.describeMarks({ layer, kolab }),
    };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
  }

  @McpResource({
    name: 'konjir_answers',
    uri: 'konjir://answers/{actor}',
    isTemplate: true,
    title: 'Answers to what you raised',
    description: 'Your questions and notes with their replies. Updated whenever one of them is answered.',
    mimeType: 'application/json',
  })
  async answers(uri: URL, vars: Record<string, string | string[]>, context?: McpHandlerContext) {
    const session = sessionOf(context?.authInfo);
    if (!session) throw new RoleError('reading answers needs an agent session token');
    const me = await this.kolab.sessionInfo(session);
    if (decodeURIComponent(String(vars.actor)) !== me.actor) throw new RoleError('you can only read your own answers');
    const body = { actor: me.actor, queries: await this.kolab.listQueries({ raisedBy: me.actor, kolab: me.kolab }) };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
  }
}
