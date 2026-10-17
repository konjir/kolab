import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { McpHttpService, type McpListenStream } from '@onivoro/server-mcp';
import { Kolab, sessionKey } from '@konjir/engine';
import { isSessionEnded } from '@konjir/types';
import { redact } from './auth.js';
import { KOLAB } from './tokens.js';

/** An agent's stream, with the token KonjirAuth verified for it. The admin token's streams are never closed here. */
type AgentStream = McpListenStream & { authInfo: NonNullable<McpListenStream['authInfo']> };
const isAgent = (s: McpListenStream): s is AgentStream => !!s.authInfo && !s.authInfo.scopes.includes('admin');

/**
 * Ending an agent session closes its subscriptions/listen streams, and nothing more is
 * signalled to its revoked token (API4, D41), through @onivoro/server-mcp's McpHttpService,
 * which tracks every listen stream on this instance with the auth it was opened with.
 *
 * - When a session ends (a SessionEndedEvent, from this process or another, by its
 *   sessionKey), its streams close gracefully: the listen request's result, which the client
 *   reads as the server closing the subscription, then the end of the response. One still
 *   opening is refused instead.
 * - Before each change is signalled, Inboxes calls closeEnded: one query over every listening
 *   session, closing the streams of any that has ended without an event (directly in the
 *   database, say). So the gate is before anything is written.
 * - A stream opened with an ended session is refused by KonjirAuth.acceptListenStream, and a
 *   new request with its token by KonjirAuth (401).
 *
 * A stream's authInfo holds its bearer token: never log a stream, or the list of them.
 */
@Injectable()
export class ListenStreams implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ListenStreams.name);
  private unsubscribe?: () => void;

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(McpHttpService) private readonly mcp: McpHttpService,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.kolab.onEvent((e) => { if (isSessionEnded(e)) this.closeSession(e.id); });
  }

  onModuleDestroy() {
    this.unsubscribe?.();
  }

  /** Close every listen stream of the session with this sessionKey. Other sessions' streams are left alone. */
  closeSession(key: string) {
    return this.mcp.closeListenStreams((s) => isAgent(s) && sessionKey(s.authInfo.token) === key);
  }

  /**
   * Before a change is signalled: close the streams of every listening session that has ended,
   * in one query however many streams there are. False if the check failed, so the caller holds
   * the signal back rather than signal a session it couldn't check.
   */
  async closeEnded(): Promise<boolean> {
    const checked = new Set(this.mcp.getListenStreams().filter(isAgent).map((s) => s.authInfo.token));
    if (!checked.size) return true;
    let open: Set<string>;
    try {
      open = await this.kolab.openSessions([...checked]);
    } catch (e) {
      this.logger.warn(`could not check ${checked.size} listening session(s) before signalling a change, so it wasn't signalled: ${redact(e)}`);
      return false;
    }
    // Only the sessions checked: a stream opened meanwhile has passed the gate on its own.
    this.mcp.closeListenStreams((s) => isAgent(s) && checked.has(s.authInfo.token) && !open.has(s.authInfo.token));
    return true;
  }
}
