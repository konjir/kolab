import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { McpHttpService, type McpListenStream } from '@onivoro/server-mcp';
import { Kolab, maskTokens } from '@konjir/engine';
import { isSessionEnded } from '@konjir/types';
import { KOLAB } from './tokens.js';

/**
 * An agent's stream, with the token KonjirAuth verified for it, and its session's id as the
 * client (which an OAuth session keeps as its access token rotates). The break-glass token's
 * streams are never closed here; a raised admin's, a session's, are.
 */
type AgentStream = McpListenStream & { authInfo: NonNullable<McpListenStream['authInfo']> };
const isAgent = (s: McpListenStream): s is AgentStream => !!s.authInfo && s.authInfo.scopes.includes('agent');

/**
 * Ending an agent session closes its subscriptions/listen streams, and nothing more is
 * signalled to its revoked token (API4, D41), through @onivoro/server-mcp's McpHttpService,
 * which tracks every listen stream on this instance with the auth it was opened with.
 *
 * - A stream lives as long as the access token it opened with: once that token no longer reaches
 *   its session, because it expired or a refresh rotated it (D55), or the session ended, the
 *   stream closes, and nothing more is signalled to it. A client with a refreshed token listens
 *   again. Besides the check before each signal, every SWEEP_MS the open streams are checked, so
 *   a quiet stream doesn't outlive its token either.
 * - When a session ends (a SessionEndedEvent, from this process or another, by its
 *   id, its key), its streams close gracefully: the listen request's result, which the client
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
/** How often the open listen streams are checked against their tokens, besides before each signal. */
export const SWEEP_MS = 30_000;

@Injectable()
export class ListenStreams implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ListenStreams.name);
  private unsubscribe?: () => void;
  private sweep?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(McpHttpService) private readonly mcp: McpHttpService,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.kolab.onEvent((e) => { if (isSessionEnded(e)) this.closeSession(e.id); });
    this.sweep = setInterval(() => void this.closeEnded(), SWEEP_MS);
    this.sweep.unref();
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    clearInterval(this.sweep);
  }

  /** Close every listen stream of the session with this id (its key). Other sessions' streams are left alone. */
  closeSession(key: string) {
    return this.mcp.closeListenStreams((s) => isAgent(s) && s.authInfo.clientId === key);
  }

  /**
   * Before a change is signalled: close every stream whose token no longer reaches an open
   * session (ended, expired or rotated), in one query however many streams there are. False if the check failed, so the caller holds
   * the signal back rather than signal a session it couldn't check.
   */
  async closeEnded(): Promise<boolean> {
    const checked = new Set(this.mcp.getListenStreams().filter(isAgent).map((s) => s.authInfo.token));
    if (!checked.size) return true;
    let open: Set<string>;
    try {
      open = await this.kolab.openSessions([...checked]);
    } catch (e) {
      this.logger.warn(`could not check ${checked.size} listening session(s) before signalling a change, so it wasn't signalled: ${maskTokens(e)}`);
      return false;
    }
    // Only the sessions checked: a stream opened meanwhile has passed the gate on its own.
    this.mcp.closeListenStreams((s) => isAgent(s) && checked.has(s.authInfo.token) && !open.has(s.authInfo.token));
    return true;
  }
}
