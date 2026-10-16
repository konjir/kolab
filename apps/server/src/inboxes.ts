import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { McpResource, McpToolRegistry, type McpHandlerContext } from '@onivoro/server-mcp';
import { Kolab, RoleError } from '@konjir/engine';
import { LAYERS, isInboxEvent, type Layer } from '@konjir/types';
import { sessionOf } from './results.js';
import { KOLAB } from './tokens.js';
import { uriOf } from './uris.js';

/** Each layer's inbox and each actor's answers, and the push that signals them. */
@Injectable()
export class Inboxes implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(McpToolRegistry) private readonly registry: McpToolRegistry,
  ) {}

  /**
   * Push: every open subscriptions/listen stream that subscribed to an inbox hears when it changes.
   * ListenStreams holds back what a stream of an ended session would hear.
   */
  onModuleInit() {
    this.unsubscribe = this.kolab.onEvent((e) => { if (isInboxEvent(e)) this.registry.notifyResourceUpdated(uriOf(e)); });
  }

  onModuleDestroy() {
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
    if (!sessionOf(context?.authInfo)) throw new RoleError('reading an inbox needs an agent session token');
    const body = {
      layer,
      queries: await this.kolab.listQueries({ layer, state: 'open' }),
      marks: await this.kolab.describeMarks({ layer }),
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
    const body = { actor: me.actor, queries: await this.kolab.listQueries({ raisedBy: me.actor }) };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
  }
}
