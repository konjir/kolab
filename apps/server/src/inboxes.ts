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
   * changes, whichever Kolab process on the database made the change (API5). An inbox is one
   * kolab's, so a change in one kolab signals no other's (D50). First, ListenStreams closes the
   * streams of any session that has ended (D41).
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
    else this.logger.warn('push across processes restored: the LISTEN connection is back, and every inbox with a listening session was signalled again for what changed meanwhile');
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
    uri: 'konjir://inbox/{kolab}/{layer}',
    isTemplate: true,
    title: 'A layer\'s work queue in your kolab',
    description: 'Open questions and notes the layer owns in your session\'s kolab, open marks on its work there, the review requests waiting for you on it, and the open case files about its elements, waiting for a position or a ruling. Subscribe to your own layer\'s inbox, as konjir_whoami lists it; it is updated whenever that queue changes. Only your own kolab\'s inboxes can be read or subscribed to.',
    mimeType: 'application/json',
  })
  async inbox(uri: URL, vars: Record<string, string | string[]>, context?: McpHandlerContext) {
    const layer = String(vars.layer) as Layer;
    const session = sessionOf(context?.authInfo);
    if (!session) throw new RoleError('reading an inbox needs an agent session token');
    const me = await this.kolab.sessionInfo(session);
    // Only the session's own kolab (TEN12). Another kolab's inbox reads as if it didn't exist.
    if (!LAYERS.includes(layer) || decoded(vars.kolab) !== me.kolab) throw new Error(`no inbox ${uri.href}`);
    const kolab = me.kolab;
    const body = {
      kolab,
      layer,
      queries: await this.kolab.queriesFor(session, { layer, state: 'open' }),
      marks: await this.kolab.describeMarks({ layer, kolab }),
      // Each review request waits in its own reviewer's inbox (REV2).
      reviews: await this.kolab.reviewRequests({ layer, reviewer: me.actor, kolab }),
      // Case files about the layer's elements, waiting for their other position or a ruling (CASE1, CASE2).
      // Read as the session, so one that holds only Read sees none (D49).
      cases: await this.kolab.casesFor(session, { layer, state: 'open' }),
    };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
  }

  @McpResource({
    name: 'konjir_answers',
    uri: 'konjir://answers/{kolab}/{actor}',
    isTemplate: true,
    title: 'Answers to what you raised in your kolab',
    description: 'Your questions and notes in your session\'s kolab with their replies, the versions you submitted there for review with their verdicts, and the case files you opened or hold a position on there, with their rulings. Updated whenever one of them is answered, reviewed, argued or ruled on. Only your own answers, in your own kolab, can be read or subscribed to.',
    mimeType: 'application/json',
  })
  async answers(uri: URL, vars: Record<string, string | string[]>, context?: McpHandlerContext) {
    const session = sessionOf(context?.authInfo);
    if (!session) throw new RoleError('reading answers needs an agent session token');
    const me = await this.kolab.sessionInfo(session);
    if (decoded(vars.actor) !== me.actor || decoded(vars.kolab) !== me.kolab) {
      throw new RoleError('you can only read your own answers, in your session\'s kolab');
    }
    const body = { kolab: me.kolab, actor: me.actor, queries: await this.kolab.queriesFor(session, { raisedBy: me.actor }), submissions: await this.kolab.submissions(me.actor, { kolab: me.kolab }),
      // Most recently changed first, so a case file just argued or ruled on is always among them.
      cases: await this.kolab.casesFor(session, { actor: me.actor, limit: 20 }),
    };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
  }
}

/** A URI template variable, decoded; undefined if it doesn't decode, so a malformed one reads as any other wrong one. */
function decoded(v: string | string[] | undefined): string | undefined {
  try {
    return decodeURIComponent(String(v));
  } catch {
    return undefined;
  }
}
