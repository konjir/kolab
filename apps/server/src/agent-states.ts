import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Kolab, LimitError } from '@konjir/engine';
import { AGENT_STATE_FRESH_SECONDS, AGENT_STATES, MAX_AGENT_STATES, isSessionEnded, type AgentState, type SaidState } from '@konjir/types';
import { KOLAB, SERVER_OPTIONS, type ServerOptions } from './tokens.js';

/** What one session of an agent last said (konjir_say_state), and when, by this process's clock. */
type Entry = { actor: string; kolab: string; state: AgentState; at: number };

/** Which state wins when several sessions of one agent say different ones: the one that answers soonest. */
const RANK: Record<AgentState, number> = { idle: 0, working: 1, running: 2 };

/** How often entries past AGENT_STATE_FRESH_SECONDS are swept away, besides when the store is full. */
export const AGENT_STATE_SWEEP_MS = 30_000;

/**
 * What running agents say they are doing (konjir_say_state), for konjir_list_members' `state`.
 *
 * Kept in memory, in this server process, never in the database: it is said twice a minute by
 * every running agent, and is worth nothing once it is old. It is per process: with more than one
 * server process, a list knows only the agents that told the process serving it.
 *
 * - By session id (its key): `{ actor, kolab, state, at }`. A session's next call replaces its
 *   entry; `gone` removes it; so does the session ending (a SessionEndedEvent, from this process or
 *   another, as ListenStreams closes streams on).
 * - An entry older than AGENT_STATE_FRESH_SECONDS is ignored, and swept every AGENT_STATE_SWEEP_MS.
 * - At most MAX_AGENT_STATES entries: past that, a new session's entry is refused (after sweeping
 *   the stale ones), never someone else's fresh one evicted.
 * - Read by (kolab, actor), so no kolab's list ever shows another kolab's states.
 */
@Injectable()
export class AgentStates implements OnModuleInit, OnModuleDestroy {
  private readonly bySession = new Map<string, Entry>();
  /** The sessions with an entry, by kolab and actor (`<kolab>\n<actor>`). */
  private readonly byMember = new Map<string, Set<string>>();
  private readonly now: () => number;
  private unsubscribe?: () => void;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(SERVER_OPTIONS) options: ServerOptions,
  ) {
    this.now = options.agentStateClock ?? Date.now;
  }

  onModuleInit() {
    this.unsubscribe = this.kolab.onEvent((e) => { if (isSessionEnded(e)) this.forget(e.id); });
    this.sweeper = setInterval(() => this.sweep(), AGENT_STATE_SWEEP_MS);
    this.sweeper.unref();
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    clearInterval(this.sweeper);
  }

  /** How many sessions have an entry, stale or not. */
  get size() { return this.bySession.size; }

  /** Records what the session `session` of `actor` in `kolab` says; `gone` forgets it. */
  say(session: string, actor: string, kolab: string, state: SaidState) {
    if (state === 'gone') return this.forget(session);
    if (!(AGENT_STATES as readonly string[]).includes(state)) throw new LimitError(`state is one of ${[...AGENT_STATES, 'gone'].join(', ')}`);
    if (!this.bySession.has(session) && this.bySession.size >= MAX_AGENT_STATES) {
      this.sweep();
      if (this.bySession.size >= MAX_AGENT_STATES) {
        throw new LimitError(`this server keeps what ${MAX_AGENT_STATES} sessions say at once, and is full: say it again in a minute`);
      }
    }
    this.forget(session);
    this.bySession.set(session, { actor, kolab, state, at: this.now() });
    const key = memberKey(kolab, actor);
    const set = this.byMember.get(key) ?? new Set<string>();
    set.add(session);
    this.byMember.set(key, set);
  }

  /** The best fresh state any session of `actor` in `kolab` said, or null. */
  stateOf(kolab: string, actor: string): AgentState | null {
    const sessions = this.byMember.get(memberKey(kolab, actor));
    if (!sessions) return null;
    const since = this.now() - AGENT_STATE_FRESH_SECONDS * 1000;
    let best: AgentState | null = null;
    for (const id of sessions) {
      const e = this.bySession.get(id);
      if (e && e.at >= since && (best === null || RANK[e.state] < RANK[best])) best = e.state;
    }
    return best;
  }

  /** Forgets what the session said, if it said anything. */
  forget(session: string) {
    const e = this.bySession.get(session);
    if (!e) return;
    this.bySession.delete(session);
    const key = memberKey(e.kolab, e.actor);
    const set = this.byMember.get(key);
    set?.delete(session);
    if (set && !set.size) this.byMember.delete(key);
  }

  /** Forgets every entry past AGENT_STATE_FRESH_SECONDS. */
  sweep() {
    const since = this.now() - AGENT_STATE_FRESH_SECONDS * 1000;
    for (const [id, e] of this.bySession) if (e.at < since) this.forget(id);
  }
}

const memberKey = (kolab: string, actor: string) => `${kolab}\n${actor}`;
