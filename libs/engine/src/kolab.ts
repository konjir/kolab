import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import {
  type Address, type QuoteSelector, fingerprint, formatAddress, isKolabName, isNodeName, MAX_QUOTE, normalize, parseAddress,
  parseNodeRef, resolveSpan,
} from '@konjir/address';
import { migrate, openDb, type Db, type Listening } from '@konjir/db';
import {
  ACCESS_LEVELS, FINDING_KINDS, LAYERS, LAYER_OF_KIND, LAYER_OF_ROLE, ORG_ROLES, PLAN_KINDS, ROLES, VISIBILITIES,
  type Access, type AccessLevel, type Actor, type ActorKind, type Author, type KolabRow, type OrgRole, type Visibility,
  type DeltaInput, type DeltaKind, type ElementInput, type ElementRow, type Finding, type GateResult, type Kind, type KolabEvent, type Layer,
  type MarkRow, type OverrideResolution, type Query, type QueryKind, type QueryState, type Resolution, type CheckContext, type CheckResult, type Checks,
  type ReviewRequestState, type ReviewRequestView, type ReviewVerdictKind, type Role, type SubmissionView, type VersionRow,
  type VersionState,
} from '@konjir/types';

// ---------------------------------------------------------------------------
// Row types used only inside the engine (shared types are in @konjir/types)
// ---------------------------------------------------------------------------

interface DeltaRow {
  id: string; version_id: string; element_id: string; kind: DeltaKind;
  text: string | null; parent_element_id: string | null; ord: number | null;
  base_version_id: string | null; base_fingerprint: string | null;
  state: 'clean' | 'dirty' | 'orphaned';
}
interface EdgeRow {
  id: string; kind: string; source_version_id: string; source_element_id: string | null;
  target_version_id: string; target_element_id: string | null;
  target_selector: QuoteSelector | null; target_fingerprint: string;
}

/**
 * An override resolution waiting on its review (W2.5): what commitStep records, in the transaction
 * that commits the resolution, before its cascade runs. It waits on the resolution's version
 * (version.resolves, W1.6), so a review that takes days, or a restart, loses nothing, and a fold
 * of the resolution carries it. Only the version that commits records anything.
 */
interface Ruling {
  markId: string; actor: string; resolution: OverrideResolution; amendedText: string | null;
  /** The (base, parent, child) fingerprints the ruling becomes precedent for; none for an orphan. */
  triple?: [string | null, string, string];
}

export class RoleError extends Error { name = 'RoleError'; }
/**
 * About actors and their sessions: an actor that doesn't exist or already does, an invalid id,
 * an agent whose owner isn't a person, or an actor whose session is already open.
 */
export class ActorError extends Error { name = 'ActorError'; }

/**
 * Access refused: a session whose actor can't do this in its kolab, an agent granted more than
 * its owner holds, or something named in another kolab than the session's.
 */
export class AccessError extends Error { name = 'AccessError'; }
/** About accounts, kolabs, teams and grants: one that doesn't exist or already does, or an invalid name. */
export class TenancyError extends Error { name = 'TenancyError'; }

/** A team's name within its organization (team_name_check). */
const TEAM_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The advisory lock that orders changes of access against sessions opening, so a session can't
 * open on access that a concurrent change is taking away without that change ending it.
 */
const ACCESS_LOCK = 0x4b4a0006;

/** An actor id: letters, digits, '.', '_', '-' and '@', starting with a letter or digit (actor_id_check). */
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
/** The author of Kolab's own work, in the role 'system'. Never an actor. */
export const SYSTEM_ACTOR = 'kolab';
export class GateError extends Error { name = 'GateError'; }

/**
 * Thrown inside a fold's commit step when the version it folds was settled meanwhile, abandoned by
 * its author, say: the fold, `fold`, must not commit an edit its author withdrew.
 */
class OriginalSettled extends GateError {
  constructor(readonly fold: string, message: string) { super(message); }
}

/** How many approvals a version needs to commit: one, from another actor with Write on its layer (D19, D25). */
export const REQUIRED_APPROVALS = 1;

/** The role that writes a layer. */
const ROLE_OF_LAYER = Object.fromEntries(ROLES.map((r) => [LAYER_OF_ROLE[r], r])) as Record<Layer, Role>;
/** Thrown by review when Kolab's checks themselves fail (throw), rather than refuse the version. The draft stays drafted. */
export class ChecksError extends Error { name = 'ChecksError'; }
/**
 * A version committed, but the cascade it runs (marks, rebases of its variants, its own
 * catch-up) stopped part way, on an error this names. The commit stands; whatever the cascade
 * hadn't reached yet is reached by the node's next commit, or its parent's.
 */
export class CascadeError extends Error { name = 'CascadeError'; }

/**
 * How events and logs name a session: the sha256 of its id, base64url. The id is the bearer
 * token, so it never leaves the process; events cross processes (W2.2) and can reach logs.
 */
export const sessionKey = (id: string) => createHash('sha256').update(id).digest('base64url');

type Q = Pick<Db, 'query' | 'exec'>;

/** Tells every listener in every process about `e`, once the transaction it's called in commits. */
type Signal = (e: KolabEvent) => Promise<void>;

/**
 * The Postgres channel that carries engine events between Kolab processes (API5). NOTIFY is
 * per database, so only the processes serving one kolab hear each other.
 */
export const EVENT_CHANNEL = 'konjir_events';

/**
 * What goes over EVENT_CHANNEL: the event, and the Kolab that sent it, which has already told
 * its own listeners. `resync` stands in for an event too long for NOTIFY: re-read everything.
 */
type Notice = { from: string; event: KolabEvent } | { from: string; resync: true };

/**
 * What a Kolab's listener goes through after `listen` (API5): its connection is lost; it is back
 * and every subscriber has been told to re-read (`restored`); or it is back but telling them
 * failed, and is retried in `retryInMs` (`error` is fit to log).
 */
export type ListenerState =
  | { state: 'lost' }
  | { state: 'restored' }
  | { state: 'resync_failed'; retryInMs: number; error: string };

/** A session token's pattern: a session id, which is its bearer token. */
const SESSION_TOKEN = /kjs_[A-Za-z0-9_-]+/g;

/** An error's message, fit to log: any session token in it is masked. */
export function maskTokens(e: unknown): string {
  return String((e as { message?: unknown })?.message ?? e).replace(SESSION_TOKEN, 'kjs_***');
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

const hasKeys = (x: Record<string, unknown>, ...keys: string[]) =>
  Object.keys(x).length === keys.length && keys.every((k) => k in x);

/**
 * Whether `x` is exactly a KolabEvent Kolab could have sent: its fields and no others. Each
 * new kind of event adds its check here.
 */
export function isKolabEvent(x: unknown): x is KolabEvent {
  if (!isObject(x)) return false;
  if (x.inbox === 'layer') return hasKeys(x, 'inbox', 'layer') && LAYERS.includes(x.layer as Layer);
  if (x.inbox === 'actor') return hasKeys(x, 'inbox', 'actor') && typeof x.actor === 'string' && ACTOR_ID.test(x.actor);
  // A session's sessionKey: a sha256, base64url, never the token itself.
  if (x.session === 'ended') return hasKeys(x, 'session', 'id') && typeof x.id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x.id);
  return false;
}

function isNotice(x: unknown): x is Notice {
  if (!isObject(x) || typeof x.from !== 'string') return false;
  return x.resync === true || isKolabEvent(x.event);
}

// ---------------------------------------------------------------------------
// Kolab
// ---------------------------------------------------------------------------

export class Kolab {
  private constructor(readonly db: Db, private submissionChecks: Checks, private checks: Checks) {}

  private listeners = new Set<(e: KolabEvent) => void>();
  /** Names this Kolab in what it notifies, so it can skip its own notifications when it hears them. */
  private readonly origin = randomBytes(9).toString('base64url');
  private listening?: Promise<Listening | undefined>;
  private listenerWatchers = new Set<(s: ListenerState) => void>();
  /** Counts the listener's losses and reconnects, so a resync can tell it has been overtaken. */
  private listenEpoch = 0;
  private closed = false;

  /**
   * Postgres at `databaseUrl`; otherwise PGlite, in memory by default or persisted to `dataDir`
   * across restarts. The database is first brought to the newest migration (DAT2).
   *
   * Kolab's checks are structural (structuralChecks), and it makes no model call (REV5, VER7):
   * semantic review is done by reviewing agents, through recordReview (konjir_review). Tests may
   * substitute their own: `submissionChecks` for a person's version as it is submitted, to veto
   * one, and `checks` for everything else (Kolab's own rebases, folds, plans and rulings, VER12),
   * to inject a write at an exact point.
   */
  static async open(opts: { submissionChecks?: Checks; checks?: Checks; dataDir?: string; databaseUrl?: string } = {}): Promise<Kolab> {
    const db = openDb(opts);
    try {
      await migrate(db);
    } catch (e) {
      await db.close().catch(() => undefined);
      throw e;
    }
    return new Kolab(db, opts.submissionChecks ?? structuralChecks, opts.checks ?? structuralChecks);
  }

  async close() {
    this.closed = true;
    const listening = this.listening;
    this.listening = undefined;
    await (await listening?.catch(() => undefined))?.close();
    await this.db.close();
  }

  /**
   * Be told when an inbox gains or loses work, or a session ends, here or, once `listen` has
   * been called, in any other Kolab process on the same Postgres database. Every engine event
   * arrives, whatever its kind, and only once its change has committed. Returns an unsubscribe
   * function.
   */
  onEvent(fn: (e: KolabEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * Hear the events of other Kolab processes on this database (API5), over Postgres
   * LISTEN/NOTIFY on one connection of this process's own. Idempotent. On PGlite there are no
   * other processes, and it does nothing.
   *
   * When the connection is lost, the listener re-establishes it. Whatever was committed
   * meanwhile wasn't heard, so once the LISTEN is back this Kolab resyncs: its own listeners
   * are told to re-read everything a subscriber could hold.
   */
  async listen(): Promise<void> {
    this.listening ??= this.db.listen(EVENT_CHANNEL, (p) => this.heard(p), {
      applicationName: this.listenerName,
      onListening: ({ reconnected }) => { if (reconnected) void this.resyncAfterReconnect(); },
      onConnectionLost: () => { this.listenEpoch++; this.tellListener({ state: 'lost' }); },
      onBadPayload: () => this.dropped('isn\'t JSON'),
    });
    try {
      await this.listening;
    } catch (e) {
      this.listening = undefined;
      throw e;
    }
  }

  /**
   * Whether this Kolab hears other processes now: its LISTEN is in place. Undefined when there's
   * no listener to ask: on PGlite, or before `listen` has succeeded.
   */
  async listenerConnected(): Promise<boolean | undefined> {
    const l = await this.listening?.catch(() => undefined);
    return l?.connected();
  }

  /**
   * Be told what this Kolab's listener goes through after `listen`: lost, restored once every
   * subscriber has been told to re-read, or a resync that failed and will be retried. Returns an
   * unsubscribe function.
   */
  onListenerState(fn: (s: ListenerState) => void): () => void {
    this.listenerWatchers.add(fn);
    return () => { this.listenerWatchers.delete(fn); };
  }

  private tellListener(s: ListenerState) {
    for (const fn of this.listenerWatchers) {
      try { fn(s); } catch { /* a watcher's failure is its own */ }
    }
  }

  /**
   * After the listener reconnects: resync until it succeeds, backing off from 1 s to 30 s, unless
   * the listener is lost again first (its next reconnect resyncs) or this Kolab closes. Only a
   * resync that signalled everything reports `restored`.
   */
  private async resyncAfterReconnect() {
    const epoch = ++this.listenEpoch;
    const overtaken = () => epoch !== this.listenEpoch || this.closed;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.resync();
      } catch (e) {
        if (overtaken()) return;
        const retryInMs = Math.min(1000 * 2 ** attempt, 30_000);
        this.tellListener({ state: 'resync_failed', retryInMs, error: maskTokens(e) });
        await new Promise((r) => setTimeout(r, retryInMs).unref());
        if (overtaken()) return;
        continue;
      }
      if (!overtaken()) this.tellListener({ state: 'restored' });
      return;
    }
  }

  private dropCount = 0;
  /** How many notifications on the channel this Kolab has dropped: not JSON, or not a Kolab event. */
  get droppedNotifications() { return this.dropCount; }

  /** The listening connection's application_name, unique to this Kolab. */
  private get listenerName() { return `kolab-listen-${this.origin}`; }

  /**
   * A notification from the channel. Anyone who can connect to the database can NOTIFY on it,
   * so anything that isn't a Notice carrying a valid event is dropped, and logged without its
   * payload, which may carry a session's id.
   */
  private heard(p: unknown) {
    const n = isNotice(p) ? p : undefined;
    if (!n) return this.dropped('isn\'t a Kolab event');
    if (n.from === this.origin) return; // told our own listeners when it committed
    if ('resync' in n) void this.resync().catch((e) => console.error(`kolab: could not resync after a long event: ${maskTokens(e)}`));
    else this.dispatch(n.event);
  }

  private dropped(why: string) {
    this.dropCount++;
    console.error(`kolab: dropped a notification on ${EVENT_CHANNEL} that ${why} (${this.dropCount} so far)`);
  }

  /**
   * Tells this Kolab's listeners that everything a subscriber could hold may have changed: for
   * a change too big to name, or after missing changes while the listener reconnected. That is
   * every layer's inbox, and the answers of each actor with an open session, since only an open
   * session can subscribe to them (an ended one's streams are closed before the next signal).
   * One query, before anything is signalled, so a failure signals nothing and the whole resync
   * can be retried. Each subscriber re-reads; an inbox that didn't change reads the same.
   */
  private async resync() {
    const r = await this.db.query<{ actor: string }>(`select distinct actor_id as actor from session where ended_at is null order by actor_id`);
    for (const layer of LAYERS) this.dispatch({ inbox: 'layer', layer });
    for (const { actor } of r.rows) this.dispatch({ inbox: 'actor', actor });
  }

  private dispatch(e: KolabEvent) {
    for (const fn of this.listeners) {
      try { fn(e); } catch { /* a listener's failure never fails a write */ }
    }
  }

  // ---- write contexts ------------------------------------------------------

  /**
   * One transaction, with a `signal` for the events its change causes (API5). Each is notified
   * inside the transaction, so Postgres delivers it to other processes only if it commits, and
   * this process's listeners hear it once the transaction has committed. Never on a rollback.
   *
   * With `lock`, the transaction first locks that node's row, so it is the only one writing the
   * node's versions until it ends (W1.17). It locks as Kolab's own login, before any `set local
   * role`, since kj_agent may not lock rows. Each transaction locks at most one node, so two can
   * never wait on each other. On PGlite, one connection, a transaction has the database to itself
   * anyway, and everything inside it must go through `tx`.
   */
  private async inTransaction<T>(fn: (tx: Db, signal: Signal) => Promise<T>, lock?: string): Promise<T> {
    let events = new Map<string, KolabEvent>();
    const result = await this.db.transaction(async (tx) => {
      if (lock) await tx.query(`select 1 from node where id = $1 for no key update`, [lock]);
      // Each attempt starts empty, so a transaction ever run again would notify again.
      const sent = events = new Map<string, KolabEvent>();
      return fn(tx, async (event) => {
        const key = JSON.stringify(event);
        if (sent.has(key)) return; // Postgres folds a repeated notification in one transaction too
        sent.set(key, event);
        const notice: Notice = { from: this.origin, event };
        await tx.notify(EVENT_CHANNEL, JSON.stringify(notice), () => JSON.stringify({ from: this.origin, resync: true } satisfies Notice));
      });
    });
    for (const e of events.values()) this.dispatch(e);
    return result;
  }

  /** Signals the inbox of a version's layer. */
  private async signalLayerOf(tx: Q, signal: Signal, versionId: string) {
    const r = await tx.query<{ layer: Layer }>(`select layer from version where id = $1`, [versionId]);
    if (!r.rows[0]) throw new Error(`no version ${versionId}`);
    await signal({ inbox: 'layer', layer: r.rows[0].layer });
  }

  /** Agent writes run as kj_agent; row-level security re-checks the layer. `lock` as for inTransaction. */
  private asAgent<T>(sessionId: string, fn: (tx: Q, signal: Signal) => Promise<T>, lock?: string): Promise<T> {
    return this.inTransaction(async (tx, signal) => {
      await tx.exec('set local role kj_agent');
      await tx.query(`select set_config('kj.session', $1, true)`, [sessionId]);
      return fn(tx, signal);
    }, lock);
  }

  /** Kolab's own work: rebases, review transitions, the cascade. `lock` as for inTransaction. */
  private asSystem<T>(fn: (tx: Q, signal: Signal) => Promise<T>, lock?: string): Promise<T> {
    return this.inTransaction(async (tx, signal) => {
      await tx.exec('set local role kj_system');
      return fn(tx, signal);
    }, lock);
  }

  // ---- actors and sessions (dynamic separation of duty) --------------------

  /**
   * Registers a person, who is also a user account by the same id, or with `owner` an agent
   * owned by that account: a user or an organization (D30). An agent is an actor of its own: it
   * holds its own sessions and authors its own versions.
   */
  async addActor(id: string, opts: { name?: string; owner?: string } = {}) {
    const { name = id, owner } = opts;
    if (!ACTOR_ID.test(id)) throw new ActorError(`"${id}" isn't a valid actor id: use letters, digits, '.', '_', '-' and '@', starting with a letter or digit`);
    if (id === SYSTEM_ACTOR) throw new ActorError(`"${SYSTEM_ACTOR}" is reserved for Kolab's own work`);
    if (await this.findActor(id)) throw new ActorError(`actor ${id} already exists`);
    if (owner !== undefined && !(await this.findAccount(owner))) {
      if ((await this.findActor(owner))?.kind === 'agent') throw new ActorError(`${owner} is an agent; an agent's owner must be a person or an organization`);
      throw new ActorError(`no account ${owner} to own ${id}`);
    }
    if (owner === undefined && await this.findAccount(id)) throw new ActorError(`account ${id} already exists`);
    try {
      await this.db.transaction(async (tx) => {
        if (owner === undefined) await tx.query(`insert into account(id, kind, name) values ($1, 'user', $2)`, [id, name]);
        await tx.query(`insert into actor(id, name, kind, owner_id) values ($1, $2, $3, $4)`,
          [id, name, owner === undefined ? 'person' : 'agent', owner ?? null]);
      });
    } catch (e) {
      // Another admin call added it between the check and the insert.
      if (String(e).includes('actor_pkey')) throw new ActorError(`actor ${id} already exists`);
      if (String(e).includes('account_pkey')) throw new ActorError(`account ${id} already exists`);
      throw e;
    }
  }

  private async findActor(id: string): Promise<Actor | undefined> {
    return (await this.db.query<Actor>(
      `select id, name, kind, owner_id as owner from actor where id = $1`, [id])).rows[0];
  }

  /** An actor, with the account that owns it when it's an agent. */
  async actor(id: string): Promise<Actor> {
    const a = await this.findActor(id);
    if (!a) throw new ActorError(`no actor ${id}`);
    return a;
  }

  /** Every actor, or with `owner` that account's agents. */
  async listActors(opts: { owner?: string } = {}): Promise<Actor[]> {
    return (await this.db.query<Actor>(
      `select id, name, kind, owner_id as owner from actor
        where $1::text is null or owner_id = $1 order by id`, [opts.owner ?? null])).rows;
  }

  /**
   * Who wrote a version: its actor, that actor's owner, and the role it acted in (ROL4).
   * Two agents of one person are different authors with the same owner (D25, D33).
   */
  async author(versionId: string): Promise<Author> {
    const v = await this.version(versionId);
    if (v.active_role === 'system') return { actor: v.actor_id, kind: 'system', owner: null, role: v.active_role };
    const a = await this.findActor(v.actor_id);
    if (!a) throw new ActorError(`version ${versionId} names actor ${v.actor_id}, who doesn't exist`);
    return { actor: v.actor_id, kind: a.kind, owner: a.owner, role: v.active_role };
  }

  /**
   * Opens a session for an actor in one kolab, with one active role. The session id doubles as
   * the agent's bearer token, so it is random, not a sortable ULID. Each actor holds at most one
   * open session (ENF4), so a person's agents each hold their own.
   *
   * The actor must be able to reach the kolab. Without `kolab`, it is the one kolab the actor
   * can reach. An agent's access is checked against its owner's as the session opens, and on
   * every write after: it is its own grant, never more than its owner's (D30).
   */
  async openSession(actorId: string, role: Role, opts: { kolab?: string } = {}): Promise<string> {
    const actor = await this.findActor(actorId);
    if (!actor) throw new ActorError(`no actor ${actorId}; add it first`);
    let kolab = opts.kolab;
    if (kolab === undefined) {
      const reach = await this.reachable(actorId);
      if (reach.length !== 1) {
        throw new AccessError(reach.length
          ? `${actorId} can reach the kolabs ${reach.join(', ')}; name the one to open the session in`
          : `${actorId} has no access to any kolab; grant it access to one first`);
      }
      kolab = reach[0];
    }
    await this.requireKolab(kolab);
    const id = `kjs_${randomBytes(24).toString('base64url')}`;
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
        await tx.query(`insert into session(id, actor_id, active_role, kolab_id) values ($1, $2, $3, $4)`, [id, actorId, role, kolab]);
        // Checked as it opens, and again on every use (session), so a grant revoked meanwhile still binds it.
        const access = await accessIn(tx, actorId, kolab);
        if (!access.level) {
          throw new AccessError(`${actorId} has no access to kolab ${kolab}`
            + (actor.kind === 'agent' ? `: an agent's access is its own grant there, never more than its owner ${actor.owner}'s` : ''));
        }
      });
    } catch (e) {
      if (String(e).includes('one_open_session_per_actor')) {
        throw new ActorError(`${actorId} already has an open session; end it before opening another`);
      }
      throw e;
    }
    return id;
  }

  /**
   * End a session, revoking its token, and tell listeners so its open streams close (D41).
   * The event names the session by sessionKey, never by its token.
   */
  async endSession(id: string) {
    await this.inTransaction(async (tx, signal) => {
      const r = await tx.query(`update session set ended_at = now() where id = $1 returning id`, [id]);
      if (r.rows.length) await signal({ session: 'ended', id: sessionKey(id) });
    });
  }

  /** Which of `ids` are open sessions, in one query. */
  async openSessions(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const r = await this.db.query<{ id: string }>(`select id from session where id = any($1) and ended_at is null`, [ids]);
    return new Set(r.rows.map((x) => x.id));
  }

  /** Whether `id` is an open session: its token is still good. */
  async sessionOpen(id: string): Promise<boolean> {
    const r = await this.db.query(`select 1 from session where id = $1 and ended_at is null`, [id]);
    return r.rows.length > 0;
  }

  private async session(id: string): Promise<Session> {
    const r = await this.db.query<Omit<Session, 'access'>>(
      `select s.actor_id, s.active_role, s.kolab_id as kolab, a.kind, a.owner_id as owner
         from session s join actor a on a.id = s.actor_id
        where s.id = $1 and s.ended_at is null`, [id]);
    if (!r.rows[0]) throw new RoleError(`no open session ${id}`);
    const s = { ...r.rows[0], access: await accessIn(this.db, r.rows[0].actor_id, r.rows[0].kolab) };
    // Access is computed on each use, so a session narrows the moment its access (or, for an
    // agent, its owner's) does. One that can no longer reach its kolab at all is ended here, if
    // no change of access ended it already, and its streams are told (D41).
    if (!s.access.level) {
      await this.endUnreachable();
      throw new AccessError(`${s.actor_id} can no longer reach kolab ${s.kolab}; its session has ended`);
    }
    return s;
  }

  /**
   * A session that may write `layer` in its kolab: its role's layer, covered by its access.
   * With `kolab`, what it writes must be in the session's own kolab.
   */
  private async requireLayer(sessionId: string, layer: Layer, kolab?: string) {
    const s = await this.session(sessionId);
    if (LAYER_OF_ROLE[s.active_role] !== layer) {
      throw new RoleError(`a ${s.active_role} session may not write the ${layer} layer`);
    }
    if (kolab !== undefined && kolab !== s.kolab) throw new AccessError(`that is not in kolab ${s.kolab}, the kolab this session works in`);
    if (!s.access.layers.includes(layer)) {
      throw new AccessError(`${s.actor_id} may not write the ${layer} layer of kolab ${s.kolab}: it holds ${describeAccess(s.access)}`
        + (s.kind === 'agent' ? `, its own grant cut down to its owner ${s.owner}'s` : ''));
    }
    return s;
  }

  /** The kolab a session works in, which its actor can still reach (TEN12). */
  async sessionKolab(sessionId: string): Promise<string> {
    return (await this.session(sessionId)).kolab;
  }

  /**
   * Refuses a node, by its id, outside the session's kolab, as if it didn't exist, so a session
   * learns nothing of another kolab (TEN12).
   */
  async requireNodeIn(sessionId: string, nodeId: string): Promise<void> {
    const kolab = await this.sessionKolab(sessionId);
    const r = await this.db.query(`select 1 from node where id = $1 and kolab_id = $2`, [nodeId, kolab]);
    if (!r.rows.length) throw new Error(`no node ${nodeId} in kolab ${kolab}`);
  }

  // ---- naming nodes (DAT11, ADR3) --------------------------------------------

  /**
   * Runs reads for `where`. A session's run as kj_agent in that session, so row-level security
   * bounds them as well as Kolab: its own kolab, and in any other it holds Read on, only nodes and
   * committed versions with their elements and questions (0008). Kolab's own (`system`) run on
   * its login, unchecked.
   */
  private read<T>(where: Where, fn: (q: Q) => Promise<T>): Promise<T> {
    return 'session' in where ? this.asAgent(where.session, (tx) => fn(tx)) : fn(this.db);
  }

  /** The node called `name` in `kolab`, if there is one. */
  private async findNode(q: Q, kolab: string, name: string): Promise<NodeRow | undefined> {
    return (await q.query<NodeRow>(`select * from node where kolab_id = $1 and name = $2`, [kolab, name])).rows[0];
  }

  /**
   * Where a session reads `kolab` (its own when undefined): its own kolab, or another it holds at
   * least Read on (TEN12). Kolab's own reads (`system`) check nothing. Anything else is refused
   * exactly as a node that doesn't exist, so the refusal says nothing of whether the kolab or the
   * node does. Row-level security repeats this as the reads run (read).
   */
  private async readingKolab(where: Where, kolab: string | undefined, name: string): Promise<string> {
    if ('system' in where) return kolab ?? where.system;
    const s = await this.session(where.session);
    if (kolab === undefined || kolab === s.kolab) return s.kolab;
    if (!(await accessIn(this.db, s.actor_id, kolab)).level) throw new Error(`no node ${name} in kolab ${kolab}`);
    return kolab;
  }

  /**
   * The node an address or node reference names, read from `where` (DAT11, ADR3, D8). The short
   * form, `kj:<node>` or `<node>`, is the node of that name in the session's kolab (or the kolab
   * `system` names). The full form, `kj:<kolab>/<node>` or `<kolab>/<node>`, names its kolab, and
   * resolves from anywhere: in another kolab than the session's, it needs Read there (TEN12).
   */
  async locateNode(where: Where, ref: { kolab?: string; node: string } | string): Promise<NodeRow> {
    const r = typeof ref === 'string' ? parseNodeRef(ref) : ref;
    const kolab = await this.readingKolab(where, r.kolab, r.node);
    const node = await this.read(where, (q) => this.findNode(q, kolab, r.node));
    if (!node) throw new Error(`no node ${r.node} in kolab ${kolab}`);
    return node;
  }

  /**
   * The node the admin token names (it works in no kolab): `<kolab>/<node>`, or a name alone when
   * exactly one kolab has a node of that name. A name several kolabs have is refused, naming them.
   */
  async nodeForAdmin(ref: string): Promise<NodeRow> {
    const r = parseNodeRef(ref);
    if (r.kolab !== undefined) return this.locateNode({ system: r.kolab }, r);
    const all = (await this.db.query<NodeRow>(`select * from node where name = $1 order by kolab_id`, [r.node])).rows;
    if (all.length === 1) return all[0];
    if (!all.length) throw new Error(`no node ${r.node} in any kolab`);
    throw new GateError(`kolabs ${all.map((n) => n.kolab_id).join(', ')} each have a node ${r.node}: name it as <kolab>/${r.node}`);
  }

  /**
   * The node a session names for work in its own kolab: what it lists, drafts, submits, links
   * from or asks about. A full form naming another kolab is refused, from the address alone, so
   * the refusal says nothing of that kolab: `what` says what can't yet cross kolabs.
   */
  async nodeIn(sessionId: string, ref: { kolab?: string; node: string } | string, what = 'working on a node'): Promise<NodeRow> {
    const r = typeof ref === 'string' ? parseNodeRef(ref) : ref;
    const s = await this.session(sessionId);
    if (r.kolab !== undefined && r.kolab !== s.kolab) {
      throw new AccessError(`${r.kolab}/${r.node} is in kolab ${r.kolab}, and this session works in kolab ${s.kolab}: ${what} across kolabs isn't supported yet`);
    }
    return this.locateNode({ session: sessionId }, { node: r.node });
  }

  /**
   * The version an address names: the one it pins, or with no @version its node's latest
   * committed version. Undefined if there is none. Read from `where`, as locateNode.
   */
  async locateVersion(where: Where, address: Address | string): Promise<{ node: NodeRow; version?: VersionRow }> {
    const a = typeof address === 'string' ? parseAddress(address) : address;
    const node = await this.locateNode(where, a);
    const version = await this.read(where, async (q) => (a.version === undefined
      ? await q.query<VersionRow>(`select * from version where node_id = $1 and state = 'committed' order by seq desc limit 1`, [node.id])
      : await q.query<VersionRow>(`select * from version where node_id = $1 and seq = $2`, [node.id, a.version])).rows[0]);
    // A reader outside the node's kolab sees only committed versions: another kolab's drafts and
    // rejected versions are as if they weren't there (row-level security holds it to this too).
    if (version && version.state !== 'committed' && 'session' in where && (await this.sessionKolab(where.session)) !== node.kolab_id) {
      return { node, version: undefined };
    }
    return { node, version };
  }

  /**
   * A node's version as a session reads it, with its elements and the questions on the node
   * (DAT11): one of its own kolab's, or `<kolab>/<node>` in another it holds Read on, where only
   * committed versions show. Every read runs as kj_agent, so row-level security bounds it too.
   * Addresses in the questions are written to be read in the session's kolab.
   */
  async readNode(sessionId: string, ref: string, version?: number) {
    const where = { session: sessionId };
    const { node, version: v } = await this.locateVersion(where, { ...parseNodeRef(ref), version });
    if (!v) throw new Error(`${ref} has no ${version === undefined ? 'committed version' : `version ${version}`}`);
    const from = await this.sessionKolab(sessionId);
    return this.read(where, async (q) => ({
      node, version: v, from,
      elements: await this.elements(v.id, q),
      queries: await this.listQueries({ node: node.id, from }, q),
    }));
  }

  /**
   * The version an address names for a write in the session's kolab: a link's source or target,
   * or a variant's parent. Another kolab's is refused (links across kolabs, LNK8, and forks wait
   * on a binding decision). A draft only with `allowDraft`.
   */
  async versionIn(sessionId: string, address: Address | string, opts: { allowDraft?: boolean; what: string }): Promise<VersionRow> {
    const a = typeof address === 'string' ? parseAddress(address) : address;
    const node = await this.nodeIn(sessionId, a, opts.what);
    const { version } = await this.locateVersion({ session: sessionId }, { node: node.name, version: a.version });
    const at = formatAddress({ node: node.name, version: a.version });
    if (!version) throw new Error(a.version === undefined ? `${node.name} has no committed version` : `${node.name} has no version ${a.version}`);
    if (!opts.allowDraft && version.state !== 'committed') throw new GateError(`${at} is ${version.state}, not committed`);
    return version;
  }

  // ---- accounts, kolabs, teams and grants (TEN1–TEN11) -----------------------

  private async findAccount(id: string) {
    return (await this.db.query<{ id: string; kind: 'user' | 'organization' }>(`select id, kind from account where id = $1`, [id])).rows[0];
  }

  /** Registers an organization: an account that owns kolabs and agents, with members and teams. */
  async addOrganization(id: string, opts: { name?: string } = {}) {
    if (!ACTOR_ID.test(id) || id === SYSTEM_ACTOR) throw new TenancyError(`"${id}" isn't a valid account id: use letters, digits, '.', '_', '-' and '@', starting with a letter or digit`);
    if (await this.findAccount(id)) throw new TenancyError(`account ${id} already exists`);
    try {
      await this.db.query(`insert into account(id, kind, name) values ($1, 'organization', $2)`, [id, opts.name ?? id]);
    } catch (e) {
      if (String(e).includes('account_pkey')) throw new TenancyError(`account ${id} already exists`);
      throw e;
    }
  }

  private async requireAccount(id: string, kind?: 'user' | 'organization') {
    const a = await this.findAccount(id);
    if (!a) throw new TenancyError(`no account ${id}`);
    if (kind && a.kind !== kind) throw new TenancyError(`${id} is ${a.kind === 'user' ? 'a user' : 'an organization'}, not ${kind === 'user' ? 'a user' : 'an organization'}`);
    return a;
  }

  private async requireKolab(name: string): Promise<KolabRow> {
    const k = (await this.db.query<KolabRow>(
      `select id, owner_id as owner, title, visibility, base_permission from kolab where id = $1`, [name])).rows[0];
    if (!k) throw new TenancyError(`no kolab ${name}`);
    return k;
  }

  /**
   * Creates a kolab owned by an account. Its name is unique across all of Konjir (TEN4), so
   * one taken by any other account is refused.
   */
  async createKolab(name: string, opts: { owner: string; title?: string; visibility?: Visibility; base?: AccessLevel }) {
    if (!isKolabName(name)) throw new TenancyError(`"${name}" isn't a valid kolab name: use lowercase letters, digits and '-', starting with a letter or digit`);
    if (opts.visibility !== undefined && !VISIBILITIES.includes(opts.visibility)) throw new TenancyError(`visibility is one of ${VISIBILITIES.join(', ')}`);
    if (opts.base !== undefined && !ACCESS_LEVELS.includes(opts.base)) throw new TenancyError(`a base permission is one of ${ACCESS_LEVELS.join(', ')}`);
    const owner = await this.requireAccount(opts.owner);
    if (opts.base !== undefined && owner.kind !== 'organization') throw new TenancyError('only an organization\'s kolab has a base permission');
    const taken = () => new TenancyError(`the kolab name ${name} is taken: kolab names are unique across all of Konjir`);
    if ((await this.db.query(`select 1 from kolab where id = $1`, [name])).rows.length) throw taken();
    try {
      await this.db.query(`insert into kolab(id, owner_id, title, visibility, base_permission) values ($1, $2, $3, $4, $5)`,
        [name, opts.owner, opts.title ?? name, opts.visibility ?? 'private', opts.base ?? null]);
    } catch (e) {
      if (String(e).includes('kolab_pkey')) throw taken();   // made by another call since the check
      throw e;
    }
  }

  /** Every kolab, or with `owner` that account's. */
  async listKolabs(opts: { owner?: string } = {}): Promise<KolabRow[]> {
    return (await this.db.query<KolabRow>(
      `select id, owner_id as owner, title, visibility, base_permission from kolab
        where $1::text is null or owner_id = $1 order by id`, [opts.owner ?? null])).rows;
  }

  /** Adds a user to an organization, or changes their role in it. Owners administer every kolab it owns. */
  async addMember(org: string, user: string, role: OrgRole = 'member') {
    if (!ORG_ROLES.includes(role)) throw new TenancyError(`a member's role is one of ${ORG_ROLES.join(', ')}`);
    await this.requireAccount(org, 'organization');
    await this.requireAccount(user, 'user');
    return this.changeAccess((tx) => tx.query(
      `insert into org_member(org_id, user_id, role) values ($1, $2, $3)
       on conflict (org_id, user_id) do update set role = excluded.role`, [org, user, role]));
  }

  /** Removes a user from an organization and its teams. Their sessions narrow, or end if nothing is left. */
  async removeMember(org: string, user: string) {
    await this.requireAccount(org, 'organization');
    return this.changeAccess(async (tx) => {
      await tx.query(`delete from team_member where user_id = $2 and team_id in (select id from team where org_id = $1)`, [org, user]);
      await tx.query(`delete from org_member where org_id = $1 and user_id = $2`, [org, user]);
    });
  }

  /** Creates a team in an organization, under `parent` (a team of the same organization) if given. Returns its id, `<org>/<name>`. */
  async addTeam(org: string, name: string, opts: { parent?: string } = {}): Promise<string> {
    if (!TEAM_NAME.test(name)) throw new TenancyError(`"${name}" isn't a valid team name: use lowercase letters, digits and '-', starting with a letter or digit`);
    await this.requireAccount(org, 'organization');
    const id = `${org}/${name}`;
    const parent = opts.parent === undefined ? null : opts.parent.includes('/') ? opts.parent : `${org}/${opts.parent}`;
    if (parent && !(await this.db.query(`select 1 from team where id = $1 and org_id = $2`, [parent, org])).rows.length) {
      throw new TenancyError(`no team ${parent} in ${org} to nest ${id} under`);
    }
    if ((await this.db.query(`select 1 from team where id = $1`, [id])).rows.length) throw new TenancyError(`team ${id} already exists`);
    await this.db.query(`insert into team(id, org_id, name, parent_id) values ($1, $2, $3, $4)`, [id, org, name, parent]);
    return id;
  }

  /** Adds a member of the team's organization to the team. */
  async addTeamMember(team: string, user: string) {
    const t = (await this.db.query<{ org_id: string }>(`select org_id from team where id = $1`, [team])).rows[0];
    if (!t) throw new TenancyError(`no team ${team}`);
    if (!(await this.db.query(`select 1 from org_member where org_id = $1 and user_id = $2`, [t.org_id, user])).rows.length) {
      throw new TenancyError(`${user} isn't a member of ${t.org_id}; add them to it first`);
    }
    return this.changeAccess((tx) => tx.query(`insert into team_member(team_id, user_id) values ($1, $2) on conflict do nothing`, [team, user]));
  }

  /** Removes a user from a team. Their sessions narrow, or end if nothing is left. */
  async removeTeamMember(team: string, user: string) {
    if (!(await this.db.query(`select 1 from team where id = $1`, [team])).rows.length) throw new TenancyError(`no team ${team}`);
    return this.changeAccess((tx) => tx.query(`delete from team_member where team_id = $1 and user_id = $2`, [team, user]));
  }

  /**
   * Grants access to a kolab, replacing any grant the grantee had there: to a person, a team
   * (`<org>/<team>`, of the organization that owns the kolab) or an agent (TEN9). A Write grant
   * covers `layers`, both by default (TEN8). An agent may never be granted more than its owner
   * holds there (D30): a higher level, or a layer its owner can't write, is refused. A grant
   * that lowers access narrows the grantee's sessions (and its agents'), and ends any that can
   * no longer reach the kolab.
   */
  async grant(kolab: string, to: string, level: AccessLevel, opts: { layers?: Layer[] } = {}) {
    if (!ACCESS_LEVELS.includes(level)) throw new TenancyError(`a level is one of ${ACCESS_LEVELS.join(', ')}`);
    const k = await this.requireKolab(kolab);
    let layers: Layer[];
    if (level === 'write') {
      layers = [...new Set(opts.layers ?? LAYERS)];
      if (!layers.length || layers.some((l) => !LAYERS.includes(l))) throw new TenancyError(`a Write grant names the layers it covers: ${LAYERS.join(', ')}, or both`);
    } else {
      layers = level === 'read' || level === 'triage' ? [] : [...LAYERS];
      if (opts.layers && (opts.layers.length !== layers.length || opts.layers.some((l) => !layers.includes(l)))) {
        throw new TenancyError(`only a Write grant names its layers: ${level} covers ${layers.length ? 'both' : 'none'}`);
      }
    }
    const grantee = await this.grantee(to, k);
    return this.changeAccess(async (tx) => {
      if (grantee.column === 'agent_id') {
        // Against what its owner holds now, in this transaction.
        const owner = await ownerAccess(tx, grantee.owner!, kolab);
        const over = ACCESS_LEVELS.indexOf(level) > (owner.level ? ACCESS_LEVELS.indexOf(owner.level) : -1)
          || layers.some((l) => !owner.layers.includes(l));
        if (over) {
          throw new AccessError(`${to}'s owner ${grantee.owner} holds ${describeAccess(owner)} in kolab ${kolab}, so ${to} can't be granted ${describeAccess({ level, layers })}: an agent never holds more access than its owner`);
        }
      }
      await tx.query(`delete from kolab_grant where kolab_id = $1 and ${grantee.column} = $2`, [kolab, grantee.id]);
      await tx.query(`insert into kolab_grant(kolab_id, ${grantee.column}, level, functional, technical) values ($1, $2, $3, $4, $5)`,
        [kolab, grantee.id, level, layers.includes('functional'), layers.includes('technical')]);
    });
  }

  /** Removes a grantee's grant on a kolab. Sessions narrow, and any that can no longer reach it end. */
  async revoke(kolab: string, to: string) {
    const grantee = await this.grantee(to, await this.requireKolab(kolab));
    return this.changeAccess((tx) => tx.query(`delete from kolab_grant where kolab_id = $1 and ${grantee.column} = $2`, [kolab, grantee.id]));
  }

  /** Who a grant names: a team if it has a '/', else an actor: a person (by their user account) or an agent. */
  private async grantee(to: string, k: KolabRow): Promise<{ column: 'user_id' | 'team_id' | 'agent_id'; id: string; owner?: string }> {
    if (to.includes('/')) {
      const t = (await this.db.query<{ org_id: string }>(`select org_id from team where id = $1`, [to])).rows[0];
      if (!t) throw new TenancyError(`no team ${to}`);
      if (t.org_id !== k.owner) throw new TenancyError(`team ${to} belongs to ${t.org_id}; only the owning organization's teams are granted access to kolab ${k.id}`);
      return { column: 'team_id', id: to };
    }
    const a = await this.findActor(to);
    if (!a) {
      if (await this.findAccount(to)) throw new TenancyError(`${to} is an organization: grant access to its members or teams`);
      throw new TenancyError(`no person, team or agent ${to}`);
    }
    return a.kind === 'person' ? { column: 'user_id', id: to } : { column: 'agent_id', id: to, owner: a.owner! };
  }

  /** An actor's access to a kolab: for an agent, its own grant cut down to its owner's (D30). */
  async access(actorId: string, kolab: string): Promise<Access> {
    return accessIn(this.db, actorId, kolab);
  }

  /**
   * The kolabs an actor holds access to through ownership, membership or a grant: not those it
   * could only read because they are public or internal. Only these are candidates, so it costs
   * one kj_access per kolab the actor is tied to, not per kolab in Konjir.
   */
  async reachable(actorId: string): Promise<string[]> {
    return (await this.db.query<{ id: string }>(
      `with recursive teams(id) as (
         select team_id from team_member where user_id = $1
         union
         select t.parent_id from team t join teams on t.id = teams.id where t.parent_id is not null
       ), candidates(id) as (
         select k.id from kolab k where k.owner_id = $1
         union select k.id from kolab k join org_member m on m.org_id = k.owner_id and m.user_id = $1
                where m.role = 'owner' or k.base_permission is not null
         union select g.kolab_id from kolab_grant g where g.user_id = $1 or g.agent_id = $1 or g.team_id in (select id from teams)
       )
       select c.id from candidates c where (select a.rank from kj_access($1, c.id) a) >= 1 order by c.id`, [actorId])).rows.map((r) => r.id);
  }

  /**
   * Changes who holds what, then ends every open session that can no longer reach its kolab,
   * in the same transaction, and tells listeners so their streams close (D41). Sessions that
   * can still reach it narrow by themselves: access is computed on each use. Returns how many
   * sessions ended.
   */
  private async changeAccess(fn: (tx: Q) => Promise<unknown>): Promise<{ ended: number }> {
    return this.inTransaction(async (tx, signal) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
      await fn(tx);
      return { ended: await endUnreachableIn(tx, signal) };
    });
  }

  /** Ends every open session that can no longer reach its kolab, and tells listeners (D41). */
  private async endUnreachable(): Promise<number> {
    return this.inTransaction(async (tx, signal) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
      return endUnreachableIn(tx, signal);
    });
  }

  // ---- nodes and versions --------------------------------------------------

  /**
   * Creates a node in the session's kolab, called `name` (a ULID by default), and returns its id.
   * A name is unique within its kolab, not across Konjir: addresses carry the kolab (DAT11, D8).
   * The id is the name, or '~' and a ULID when another kolab's node already holds that id; either
   * way, nothing outside the session's kolab shows (TEN12).
   */
  async createNode(sessionId: string, kind: Kind, title: string, name: string = ulid()): Promise<string> {
    if (!isNodeName(name)) throw new GateError(`"${name}" isn't a valid node name: it may not contain '/', '@', '#', '~' or whitespace`);
    const s = await this.requireLayer(sessionId, LAYER_OF_KIND[kind]);
    const taken = () => new GateError(`the node name ${name} is taken in kolab ${s.kolab}; choose another`);
    if (await this.findNode(this.db, s.kolab, name)) throw taken();
    // Each candidate id in turn: the name, then '~' and a ULID, which no name can be (node_id_name_check).
    for (const id of [name, `~${ulid()}`]) {
      try {
        await this.db.query(`insert into node(id, name, kind, layer, title, kolab_id) values ($1, $2, $3, $4, $5, $6)`,
          [id, name, kind, LAYER_OF_KIND[kind], title, s.kolab]);
        return id;
      } catch (e) {
        if (String(e).includes('node_kolab_name_key')) throw taken();   // made by another call since the check
        if (!String(e).includes('node_pkey')) throw e;
      }
    }
    throw taken();   // a ULID taken too: never, in practice
  }

  async version(id: string): Promise<VersionRow> {
    const r = await this.db.query<VersionRow>(`select * from version where id = $1`, [id]);
    if (!r.rows[0]) throw new Error(`no version ${id}`);
    return r.rows[0];
  }

  async latestCommitted(nodeId: string): Promise<VersionRow | undefined> {
    const r = await this.db.query<VersionRow>(
      `select * from version where node_id = $1 and state = 'committed' order by seq desc limit 1`, [nodeId]);
    return r.rows[0];
  }

  async elements(versionId: string, q: Q = this.db): Promise<ElementRow[]> {
    const r = await q.query<ElementRow>(
      `select element_id, parent_element_id, ord, text, fingerprint from element where version_id = $1 order by ord`,
      [versionId]);
    return r.rows;
  }

  private async deltas(versionId: string): Promise<DeltaRow[]> {
    const r = await this.db.query<DeltaRow>(`select * from delta where version_id = $1`, [versionId]);
    return r.rows;
  }

  /**
   * Draft a new version. Give either full `elements` (Kolab diffs them into
   * a delta against the parent) or explicit `deltas` (a variant's exceptions).
   * `parent` defaults to this node's latest committed version.
   */
  async draft(sessionId: string, nodeId: string,
    input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string }): Promise<string> {
    await this.requireNodeIn(sessionId, nodeId);   // another kolab's node reads as no node at all
    const node = await this.node(nodeId);
    const s = await this.requireLayer(sessionId, node.layer, node.kolab_id);
    return this.writeDraft(nodeId, node.layer, s, input, (fn) => this.asAgent(sessionId, fn, nodeId));
  }

  /**
   * Applies a ruling of Lee's to a node (D47): a new version, written as `actor` in the role that
   * writes the node's layer, that commits after structural checks only, with no review request,
   * as Kolab's own rebases do (VER12): the ruling is already the approval. Only the admin token
   * reaches it (konjir_admin_apply_ruling); an agent session never does. It goes through the same
   * per-node commit step as any other commit, so a stale one is rejected (CAS7), and its note
   * records the ruling and who applied it.
   */
  async applyRuling(nodeId: string, input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string },
    ruling: { id: string; actor: string }): Promise<GateResult> {
    if (!/^D\d+$/.test(ruling.id)) throw new GateError(`a ruling is named by its Decisions Log ID, such as D47, not "${ruling.id}"`);
    const node = await this.node(nodeId);
    await this.actor(ruling.actor);
    // The actor it is written as must be able to write that layer there: refused before anything is written.
    const access = await accessIn(this.db, ruling.actor, node.kolab_id);
    if (!access.layers.includes(node.layer)) {
      throw new AccessError(`${ruling.actor} may not write the ${node.layer} layer of kolab ${node.kolab_id}: it holds ${describeAccess(access)}; apply the ruling as an actor that does`);
    }
    const author = { actor_id: ruling.actor, active_role: ROLE_OF_LAYER[node.layer], kolab: node.kolab_id };
    const id = await this.writeDraft(nodeId, node.layer, author, input, (fn) => this.asSystem(fn, nodeId));
    return this.judge(id, undefined, ruling.id);
  }

  /** A draft's version, with its elements and deltas, written by `as` (an agent's session, or Kolab). */
  private async writeDraft(nodeId: string, layer: Layer, s: { actor_id: string; active_role: string; kolab: string },
    input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string },
    as: (fn: (tx: Q, signal: Signal) => Promise<void>) => Promise<void>): Promise<string> {

    // A variant's new version keeps its foreign parent and carries its
    // existing exceptions forward; a plain node's parent is its own last version.
    const latest = await this.latestCommitted(nodeId);
    let parentId = input.parent ?? latest?.id ?? null;
    let carried: Omit<DeltaRow, 'id' | 'version_id'>[] = [];
    if (!input.parent && latest?.parent_version_id
        && (await this.version(latest.parent_version_id)).node_id !== nodeId) {
      parentId = latest.parent_version_id;
      if (!input.elements) {
        const touched = new Set((input.deltas ?? []).map((d) => d.element));
        carried = (await this.deltas(latest.id))
          .filter((d) => !touched.has(d.element_id))
          .map(({ id: _i, version_id: _v, ...rest }) => rest);
      }
    }
    let parentEls: ElementRow[] = [];
    if (parentId) {
      const p = await this.version(parentId);
      // A variant of another kolab's spec is a fork, which waits on a binding decision (KON).
      if (p.kolab_id !== s.kolab) throw new AccessError(`parent ${parentId} is not in kolab ${s.kolab}, the kolab this session works in`);
      if (p.state !== 'committed') throw new GateError(`parent ${parentId} has not cleared review`);
      await this.refuseCycle(nodeId, parentId);
      parentEls = await this.elements(parentId);
    }

    let deltaRows: Omit<DeltaRow, 'id' | 'version_id'>[];
    if (input.elements) {
      deltaRows = diff(parentEls, input.elements.map((e) => ({ ...e, id: e.id ?? ulid() })), parentId);
    } else {
      const byId = new Map(parentEls.map((e) => [e.element_id, e]));
      deltaRows = [...carried, ...(input.deltas ?? []).map((d) => {
        const base = byId.get(d.element);
        if (d.kind !== 'add' && !base) throw new Error(`cannot ${d.kind} ${d.element}: not in parent`);
        return {
          element_id: d.element, kind: d.kind, text: d.text ?? null,
          parent_element_id: d.parent ?? base?.parent_element_id ?? null, ord: null,
          base_version_id: d.kind === 'add' ? null : parentId,
          base_fingerprint: base?.fingerprint ?? null, state: 'clean' as const,
        };
      })];
    }

    const els = materialize(parentEls, deltaRows);
    const id = ulid();
    // Built on the live version read above: if the node moves on before this commits, review sees it.
    await as(async (tx) => writeVersion(tx, {
      id, node_id: nodeId, seq: await nextSeq(tx, nodeId), parent_version_id: parentId, base_version_id: latest?.id ?? null,
      layer, actor_id: s.actor_id, active_role: s.active_role,
    }, els, deltaRows));
    return id;
  }

  /**
   * Submits a draft for review on behalf of a session, which must be able to write the draft's
   * layer in its own kolab: Read is not enough to decide when someone's draft becomes truth.
   */
  async submit(sessionId: string, versionId: string): Promise<GateResult> {
    const v = await this.version(versionId);
    await this.requireLayer(sessionId, v.layer, v.kolab_id);
    return this.review(versionId);
  }

  /**
   * Submits a draft: Kolab's checks, then review (REV2, REV4). Drafted -> in_review, or
   * drafted -> committed | rejected.
   *
   * A version of a person's or an agent's gets Kolab's structural checks (REV1, REV5): Kolab runs
   * no model. If it passes, it moves to in_review, with a review
   * request for each other actor holding Write on its layer (reviewersFor), and commits once one of
   * them approves (recordReview). With no such reviewer, the checks alone commit it, and its review
   * note says so (VER11). A rebase Kolab makes itself commits after structural checks only (VER12).
   *
   * Optimistic concurrency (CAS7): a draft commits only while its node's live
   * version is still its base, the version it was built on. Otherwise it was
   * overtaken; see settleOvertaken. The check runs before Kolab's checks, to spare
   * them a stale draft, again under the node's lock as the draft enters review, and again in the
   * commit step, under the node's lock, so nothing can commit between the check and the commit
   * (W1.17). The result names the version that actually committed, or that waits in review.
   */
  async review(versionId: string): Promise<GateResult> {
    return this.judge(versionId);
  }

  /**
   * `approvedBy`: this is a fold of a version already approved, which commits on structural checks,
   * carrying the approval, and only while that version is still in review (foldRecord).
   */
  private async judge(versionId: string, approvedBy?: string, ruling?: string): Promise<GateResult> {
    const v = await this.version(versionId);
    const here = `${await this.nameOf(v.node_id)}@${v.seq}`;
    if (v.state === 'in_review' && !approvedBy) return this.resubmit(v);
    if (v.state !== 'drafted') throw new GateError(`${here} is ${v.state}, not drafted`);
    const newer = await overtakenBy(this.db, v);
    if (newer) return this.settleOvertaken(v, newer, approvedBy, ruling);
    const human = v.active_role !== 'system';
    const plan = PLAN_KINDS.includes((await this.node(v.node_id)).kind);
    // Kolab's own rebases, folds of approved versions and plan versions get structural checks only
    // (VER12, VER3, PLN2).
    const gate = human && !approvedBy && !plan && !ruling ? this.submissionChecks : this.checks;
    let verdict: CheckResult;
    try {
      verdict = await gate(await this.checkContext(v));
    } catch (e) {
      throw new ChecksError(`Kolab's checks failed on ${versionId}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    if (!verdict.ok) {
      // A person's version goes back to its author, still drafted, with the reason (VER2, D33);
      // Kolab's own rebases, and folds, have no author to return to and are rejected.
      // A ruling applied through the admin token has no author to return to either (D47).
      if (!human || v.folded_from || ruling) await this.reject(versionId, verdict.note ?? null);
      else await this.asSystem((tx) => tx.query(`update version set review_note = $2 where id = $1 and state = 'drafted'`, [versionId, verdict.note ?? null]));
      return { ...verdict, version: versionId };
    }
    let note = verdict.note ?? null;
    let unreviewed = false;
    if (human && approvedBy) {
      note = `Approved by ${approvedBy}, then rebased by Kolab onto its node's newer version; ${note ?? ''}`.trim();
    } else if (ruling) {
      note = `Applied as ruling ${ruling} through the admin token, written as ${v.actor_id}: the ruling is the approval, so structural checks alone committed it, without review (D47). ${note ?? ''}`.trim();
    } else if (human && plan) {
      note = `${note ?? ''} A plan version commits after structural checks, without review (PLN2).`.trim();
    } else if (human) {
      const reviewers = await this.reviewersFor(v);
      if (reviewers.length) {
        const inReview = `${note ?? 'Kolab\'s checks passed.'} Waiting for one approval from ${reviewers.join(', ')}.`;
        const late = await this.enterReview(v, reviewers, inReview);
        if (isRefused(late)) return { ok: false, note: late.refused, version: versionId };
        if (late) return this.settleOvertaken(v, late);
        return { ok: false, note: inReview, version: versionId, in_review: true, reviewers };
      }
      unreviewed = true;
      note = `${note ?? ''} ${NO_REVIEWER(v.layer)}`.trim();
    }
    // The node may have moved on while the checks ran.
    const late = await this.commitStep(v, note, approvedBy ? { record: (tx, signal, overtaken) => this.foldRecord(tx, signal, v, overtaken) } : {});
    if (isRefused(late)) return { ok: false, note: late.refused, version: versionId };
    if (late && late !== 'waiting') return this.settleOvertaken(v, late, approvedBy, ruling);
    await this.afterCommit(v, []);
    return { ok: true, note: note ?? undefined, version: versionId, ...(unreviewed ? { unreviewed } : {}) };
  }

  /**
   * A version resubmitted while it waits in review: reviewers are found again (reviewersFor). If any
   * remain, each gets an open request and anyone no longer eligible loses theirs. If none remain,
   * Kolab's structural checks commit it, unreviewed, as they would have at submission (VER11).
   */
  private async resubmit(v: VersionRow): Promise<GateResult> {
    const reviewers = await this.reviewersFor(v);
    if (reviewers.length) {
      await this.asSystem(async (tx, signal) => {
        const now = (await tx.query<{ state: VersionState }>(`select state from version where id = $1`, [v.id])).rows[0].state;
        if (now !== 'in_review') throw new GateError(`${await nameIn(tx, v.node_id)}@${v.seq} is ${now}, no longer in review`);
        await tx.query(`update review_request set state = 'withdrawn', decided_at = now() where version_id = $1 and state = 'open' and reviewer_id <> all($2)`, [v.id, reviewers]);
        const open = new Set((await tx.query<{ reviewer_id: string }>(`select reviewer_id from review_request where version_id = $1 and state = 'open'`, [v.id])).rows.map((r) => r.reviewer_id));
        for (const reviewer of reviewers.filter((x) => !open.has(x))) {
          await tx.query(`insert into review_request(id, version_id, reviewer_id) values ($1, $2, $3)`, [ulid(), v.id, reviewer]);
        }
        await signal({ inbox: 'layer', layer: v.layer });
        await signal({ inbox: 'actor', actor: v.actor_id });
      }, v.node_id);
      return { ok: false, note: `Still in review: waiting for one approval from ${reviewers.join(', ')}.`, version: v.id, in_review: true, reviewers };
    }
    const verdict = await this.checks(await this.checkContext(v));
    if (!verdict.ok) return { ...verdict, version: v.id, in_review: true };
    const note = `${verdict.note ?? ''} Everyone who could review it has gone: ${NO_REVIEWER(v.layer)}`.trim();
    const late = await this.commitStep(v, note, { from: 'in_review' });
    if (isRefused(late)) return { ok: false, note: late.refused, version: v.id };
    if (late && late !== 'waiting') return this.settleOvertaken(v, late);
    await this.afterCommit(v, []);
    return { ok: true, note, version: v.id, unreviewed: true };
  }

  /**
   * Run in an approved fold's commit step, under the node's lock (`v` is the fold). Unless the fold
   * was overtaken in turn, the version it folds must still be in review: an author who abandoned it
   * meanwhile keeps the edit out. That version is settled as folded into this one, in the same
   * transaction, and its approvals are copied onto the fold, so the author's answers show the fold
   * committed with the approval.
   */
  private async foldRecord(tx: Q, signal: Signal, v: VersionRow, overtaken: boolean): Promise<boolean> {
    if (overtaken || !v.folded_from) return true;
    const o = (await tx.query<{ state: VersionState; review_note: string | null; node_id: string; seq: number; layer: Layer; actor_id: string }>(
      `select state, review_note, node_id, seq, layer, actor_id from version where id = $1`, [v.folded_from])).rows[0];
    if (o.state !== 'in_review') {
      throw new OriginalSettled(v.id, `${await nameIn(tx, o.node_id)}@${o.seq} was ${o.review_note ?? o.state} while Kolab folded it onto its node's newer version; nothing committed`);
    }
    const approvals = (await tx.query<{ reviewer_id: string; note: string | null; findings: Finding[] | null }>(
      `select reviewer_id, note, findings from review_request where version_id = $1 and state = 'approved' order by created_at, reviewer_id`, [v.folded_from])).rows;
    for (const a of approvals) {
      await tx.query(`insert into review_request(id, version_id, reviewer_id, state, note, findings, decided_at) values ($1, $2, $3, 'approved', $4, $5, now())`,
        [ulid(), v.id, a.reviewer_id, a.note, a.findings ? JSON.stringify(a.findings) : null]);
    }
    await tx.query(`update version set state = 'rejected', review_note = $2 where id = $1`, [v.folded_from, `folded into ${v.id}`]);
    await tx.query(`update review_request set state = 'withdrawn', decided_at = now() where version_id = $1 and state = 'open'`, [v.folded_from]);
    await signal({ inbox: 'layer', layer: o.layer });
    await signal({ inbox: 'actor', actor: o.actor_id });
    return true;
  }

  /**
   * Who may review a version (VER11, VER16, D25, D33): every actor other than its author whose
   * access in the version's kolab includes Write on its layer (kj_access: its grants, its teams'
   * and its organization's, an agent's cut down to its owner's), connected or not, whatever role
   * any session of its is in. Separation of duty is per agent, so another agent of the author's
   * owner counts, and so does the owner.
   */
  async reviewersFor(v: Pick<VersionRow, 'actor_id' | 'layer' | 'kolab_id'>): Promise<string[]> {
    const r = await this.db.query<{ id: string }>(
      `select a.id from actor a cross join lateral kj_access(a.id, $1) x
        where a.id <> $2 and x.rank >= 3 and (case $3 when 'functional' then x.functional else x.technical end)
        order by a.id`,
      [v.kolab_id, v.actor_id, v.layer]);
    return r.rows.map((x) => x.id);
  }

  /**
   * Drafted -> in_review, with an open review request for each reviewer, under the node's lock,
   * so a draft that something overtook never enters review: that returns the overtakers instead.
   * Each request lands in its reviewer's inbox, and the author's answers show the submission.
   */
  private enterReview(v: VersionRow, reviewers: string[], note: string): Promise<Overtaker[] | { refused: string } | undefined> {
    return this.asSystem(async (tx, signal) => {
      const newer = await overtakenBy(tx, v);
      if (newer) return newer;
      const refused = await this.authorRefusal(tx, signal, v);
      if (refused) return { refused };
      const r = await tx.query(`update version set state = 'in_review', review_note = $2 where id = $1 and state = 'drafted' returning id`,
        [v.id, note]);
      if (!r.rows.length) throw new GateError(`${v.id} is no longer drafted: another review settled it first`);
      for (const reviewer of reviewers) {
        await tx.query(`insert into review_request(id, version_id, reviewer_id) values ($1, $2, $3)`, [ulid(), v.id, reviewer]);
      }
      await signal({ inbox: 'layer', layer: v.layer });
      await signal({ inbox: 'actor', actor: v.actor_id });
      return undefined;
    }, v.node_id);
  }

  /**
   * A reviewer's verdict on a version in review (konjir_review; REV2, VER6, VER8, VER9). The
   * reviewer must hold Write on the version's layer and not be its author. An approval commits the
   * version once it has REQUIRED_APPROVALS, through the same serialized commit step as any other;
   * its layer leaks commit and raise questions, while a contradiction may only come with a request
   * for changes. A request for changes returns the version to drafted, for its author to resubmit
   * or redraft, and withdraws the other requests. A version overtaken while it waited is settled
   * as any other: folded if only Kolab's rebases overtook it, else rejected as stale.
   */
  async recordReview(sessionId: string, versionId: string,
    input: { verdict: ReviewVerdictKind; note?: string; findings?: Finding[] }): Promise<GateResult> {
    const v = await this.version(versionId);
    const s = await this.requireLayer(sessionId, v.layer, v.kolab_id);
    const here = `${await this.nameOf(v.node_id)}@${v.seq}`;
    if (s.actor_id === v.actor_id) throw new GateError(`${s.actor_id} wrote ${here}; another actor with Write on the ${v.layer} layer must review it`);
    const findings = input.findings ?? [];
    for (const f of findings) {
      if (!FINDING_KINDS.includes(f.kind)) throw new GateError(`a finding is a contradiction or a layer_leak, not ${f.kind}`);
      if (!f.elements?.length || !f.explanation?.trim()) throw new GateError('each finding names the elements involved and explains itself');
    }
    if (input.verdict === 'approve' && findings.some((f) => f.kind === 'contradiction')) {
      throw new GateError('a contradiction stops a version from committing (VER9): request changes instead of approving');
    }
    /** Why a version can't take a verdict: what settled it, from its own record. */
    const settled = (state: VersionState, note: string | null) => new GateError(
      state === 'committed' ? `${here} is committed already: ${note ?? 'another verdict committed it'}`
        : state === 'rejected' ? `${here} was rejected (${note ?? 'no reason recorded'}); there is nothing to review`
          : `${here} is back with its author as a draft (${note ?? 'not submitted'}); it isn't in review`);
    if (v.state !== 'in_review') throw settled(v.state, (await this.reviewNote(v.id)));
    const said = input.note?.trim() ? `: ${input.note.trim()}` : '.';
    const record = async (tx: Q, state: ReviewRequestState) => {
      const now = (await tx.query<{ state: VersionState; review_note: string | null }>(`select state, review_note from version where id = $1`, [v.id])).rows[0];
      if (now.state !== 'in_review') throw settled(now.state, now.review_note);
      const json = findings.length ? JSON.stringify(findings) : null;
      const mine = await tx.query(
        `update review_request set state = $3, note = $4, findings = $5, decided_at = now()
          where version_id = $1 and reviewer_id = $2 and state = 'open' returning id`,
        [v.id, s.actor_id, state, input.note ?? null, json]);
      if (!mine.rows.length) {
        // A reviewer who gained Write on the layer after the version was submitted.
        await tx.query(`insert into review_request(id, version_id, reviewer_id, state, note, findings, decided_at)
                        values ($1, $2, $3, $4, $5, $6, now())`, [ulid(), v.id, s.actor_id, state, input.note ?? null, json]);
      }
    };

    if (input.verdict === 'request_changes') {
      await this.asSystem(async (tx, signal) => {
        await record(tx, 'changes_requested');
        await tx.query(`update review_request set state = 'withdrawn', decided_at = now() where version_id = $1 and state = 'open'`, [v.id]);
        await tx.query(`update version set state = 'drafted', review_note = $2 where id = $1`, [v.id, `Changes requested by ${s.actor_id}${said}`]);
        await signal({ inbox: 'layer', layer: v.layer });
        await signal({ inbox: 'actor', actor: v.actor_id });
      }, v.node_id);
      return { ok: false, note: `Changes requested by ${s.actor_id}${said}`, version: v.id, findings };
    }

    const note = `Approved by ${s.actor_id}${said}`;
    const late = await this.commitStep(v, note, {
      from: 'in_review',
      record: async (tx, signal) => {
        await record(tx, 'approved');
        const approvals = await tx.query<{ n: number }>(
          `select count(*)::int as n from review_request where version_id = $1 and state = 'approved'`, [v.id]);
        await signal({ inbox: 'layer', layer: v.layer });
        await signal({ inbox: 'actor', actor: v.actor_id });
        return approvals.rows[0].n >= REQUIRED_APPROVALS;
      },
    });
    if (late === 'waiting') return { ok: false, note: `${note} More approvals are needed.`, version: v.id, in_review: true };
    if (isRefused(late)) return { ok: false, note: late.refused, version: v.id };
    if (late) return this.settleOvertaken(v, late, s.actor_id);
    await this.afterCommit(v, findings);
    return { ok: true, note, version: v.id, findings };
  }

  /**
   * An author abandons their own draft, in review or not: it is rejected (VER2), and any review
   * requests for it are withdrawn. The check and the change happen under the node's lock, as a
   * commit's do, so an abandon never lands on a version an approval just committed. Returns the
   * state it leaves, or throws when the version was already settled.
   */
  async abandon(sessionId: string, versionId: string): Promise<VersionState> {
    const v = await this.version(versionId);
    const s = await this.session(sessionId);
    const here = `${await this.nameOf(v.node_id)}@${v.seq}`;
    if (s.actor_id !== v.actor_id) throw new GateError(`only ${v.actor_id}, who wrote ${here}, can abandon it`);
    await this.asSystem(async (tx, signal) => {
      const now = (await tx.query<{ state: VersionState }>(`select state from version where id = $1`, [v.id])).rows[0].state;
      if (now !== 'drafted' && now !== 'in_review') throw new GateError(`${here} is ${now}; only a draft or a version in review can be abandoned`);
      await this.rejectIn(tx, signal, v.id, `abandoned by ${s.actor_id}`);
    }, v.node_id);
    return 'rejected';
  }

  private async reviewNote(versionId: string): Promise<string | null> {
    return (await this.db.query<{ review_note: string | null }>(`select review_note from version where id = $1`, [versionId])).rows[0]?.review_note ?? null;
  }

  /**
   * The cascade a commit runs, and what the version's review found: layer leaks become marks and
   * questions. (A resolution of an override it carries recorded its ruling in the commit step.)
   */
  private async afterCommit(v: VersionRow, findings: Finding[]) {
    try {
      await this.onCommit(v.id);
      await this.raiseLayerLeaks(v, await this.findingsOf(v.id, findings));
    } catch (e) {
      if (e instanceof CascadeError) throw e;   // a variant's cascade, further down, names itself
      throw new CascadeError(`${await this.nameOf(v.node_id)}@${v.seq} committed, but its cascade did not finish: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }

  /**
   * What a committed version's review found, once each: `given`, and its approvers' findings (VER9).
   * Kolab's own checks report none (REV5).
   */
  private async findingsOf(versionId: string, given: Finding[]): Promise<Finding[]> {
    const stored = (await this.db.query<{ findings: Finding[] | null }>(
      `select findings from review_request where version_id = $1 and state = 'approved'`, [versionId])).rows;
    const all = [...given, ...stored.flatMap((r) => r.findings ?? [])];
    const seen = new Set<string>();
    return all.filter((f) => { const k = JSON.stringify([f.kind, f.elements, f.explanation]); return !seen.has(k) && !!seen.add(k); });
  }

  /**
   * A version enters review, or commits, only while its author may still write its layer there
   * (D30): one whose author lost Write since drafting is rejected, whoever submits or approves it,
   * and this says why. Kolab's own rebases carry no author to check. Run under the node's lock.
   */
  private async authorRefusal(tx: Q, signal: Signal, v: VersionRow): Promise<string | undefined> {
    if (v.active_role === 'system') return undefined;
    const author = await accessIn(tx, v.actor_id, v.kolab_id!);
    if (author.layers.includes(v.layer)) return undefined;
    const refused = `rejected: its author ${v.actor_id} no longer holds Write on the ${v.layer} layer of kolab ${v.kolab_id} (${describeAccess(author)})`;
    await this.rejectIn(tx, signal, v.id, refused);
    return refused;
  }

  /**
   * The commit step, serialized per node (W1.17). Under a lock on the node's row, the version
   * commits only if the node's live version is still its base. Otherwise it commits nothing and
   * returns the versions that overtook it. `from` is the state it commits from: drafted, or
   * in_review for an approval. `record`, run first under the same lock, records the verdict
   * that commits it, which stands even if the version was overtaken (`overtaken` says whether
   * it was); it returns whether the version now has the approvals it needs, and if not, nothing
   * commits and this returns 'waiting'.
   */
  private commitStep(v: VersionRow, note: string | null, opts: {
    from?: 'drafted' | 'in_review'; record?: (tx: Q, signal: Signal, overtaken: boolean) => Promise<boolean>;
  } = {}): Promise<Overtaker[] | 'waiting' | { refused: string } | undefined> {
    const from = opts.from ?? 'drafted';
    return this.asSystem(async (tx, signal) => {
      const newer = await overtakenBy(tx, v);
      if (opts.record && !(await opts.record(tx, signal, !!newer))) return 'waiting' as const;
      if (newer) return newer;
      const refused = await this.authorRefusal(tx, signal, v);
      if (refused) return { refused };
      const r = await tx.query(`update version set state = 'committed', review_note = $2 where id = $1 and state = $3 returning id`,
        [v.id, note, from]);
      if (!r.rows.length) throw new GateError(`${v.id} is no longer ${from === 'drafted' ? 'drafted' : 'in review'}: another review settled it first`);
      await tx.query(`update review_request set state = 'withdrawn', decided_at = now() where version_id = $1 and state = 'open'`, [v.id]);
      // An override resolution records its ruling as it commits, before its cascade (W2.5, OVR9).
      const ruling = (await tx.query<{ resolves: Ruling | null }>(`select resolves from version where id = $1`, [v.id])).rows[0]?.resolves;
      if (ruling) await this.recordRuling(tx, signal, ruling);
      return undefined;
    }, v.node_id);
  }

  /**
   * A version that `newer`, the node's commits since its base, overtook. When only Kolab's own
   * rebases overtook a draft, nothing human is lost: the draft is folded into a fresh rebase onto
   * the current parent. The fold is built on the newest of `newer`, the versions judged here, so
   * if anything else commits meanwhile, the fold is overtaken in turn and judged again. When
   * anyone else's commit overtook the draft, it is rejected for redrafting. A rebase of Kolab's
   * own that was overtaken is dropped; its caller (rebase) catches up whatever overtook it.
   *
   * The same holds for a version in review, at its approval or when someone else commits to its
   * node while it waits (withdrawStale). `approvedBy` names the reviewer who approved it: its fold
   * then commits on structural checks, since the edit it carries was reviewed; a fold of a version
   * not yet reviewed goes into review itself.
   */
  private async settleOvertaken(v: VersionRow, newer: Overtaker[], approvedBy?: string, ruling?: string): Promise<GateResult> {
    if (v.active_role === 'system') {
      const note = `superseded: ${await this.nameOf(v.node_id)} committed a newer version while this rebase waited`;
      await this.reject(v.id, note);
      return { ok: false, note, version: v.id, stale: true };
    }
    const human = newer.some((r) => r.active_role !== 'system');
    const parent = v.parent_version_id ? await this.version(v.parent_version_id) : undefined;
    if (human || !parent || parent.node_id === v.node_id) {
      const note = 'stale draft: the node committed a newer version; redraft against it';
      await this.reject(v.id, note);
      return { ok: false, note, version: v.id, stale: true };
    }
    const latestParent = (await this.latestCommitted(parent.node_id))!;
    // Folding keeps the draft's authorship (so a later stale draft still sees a
    // human commit and is rejected) and the dependencies the draft declared.
    let folded: GateResult;
    try {
      // A ruling's fold is still the ruling: it commits after structural checks only (D47).
      folded = await this.rebase(v, latestParent, { author: v, edgesFrom: v.id, base: newer.at(-1)!.id, approvedBy, ruling });
    } catch (e) {
      // The author abandoned the approved version while it was being folded: drop the fold.
      if (!(e instanceof OriginalSettled)) throw e;
      await this.reject(e.fold, `not committed: ${e.message}`);
      return { ok: false, note: e.message, version: v.id };
    }
    // An approved fold settled its original as it committed (foldRecord); any other is settled here.
    await this.reject(v.id, folded.ok || folded.in_review ? `folded into ${folded.version}`
      : `overtaken by Kolab's rebases; folding it into ${folded.version} failed: ${folded.note ?? ''}`);
    return folded;
  }

  private async checkContext(v: VersionRow): Promise<CheckContext> {
    return { version: v, elements: await this.elements(v.id), node: await this.node(v.node_id) };
  }

  /**
   * Layer leaks commit, then ask. A functional spec that names implementation
   * asks its own author to rewrite. A binding that changes behavior asks the
   * spec it links to, since only the functional layer can approve behavior.
   */
  private async raiseLayerLeaks(v: VersionRow, findings: Finding[]) {
    const node = await this.node(v.node_id);
    for (const f of findings.filter((x) => x.kind === 'layer_leak')) {
      const element = f.elements[0] ?? null;
      const markId = await this.mark({ version_id: v.id, element_id: element, triggered_by: v.id, reason: 'role_boundary', note: f.explanation });
      const here = formatAddress({ node: node.name, version: v.seq, element: element ?? undefined });
      if (node.layer === 'functional') {
        await this.ask(v.id, element, markId,
          `The review gate thinks ${here} specifies implementation, not behavior: ${f.explanation} Rewrite it as behavior, or answer to keep it as is.`);
        continue;
      }
      const link = (await this.db.query<{ target_version_id: string; target_element_id: string | null; tnode: string; tkolab: string; tseq: number }>(
        `select e.target_version_id, e.target_element_id, tn.name as tnode, tn.kolab_id as tkolab, t.seq as tseq
           from edge e join version t on t.id = e.target_version_id join node tn on tn.id = t.node_id
          where e.source_version_id = $1 and e.source_element_id is not distinct from $2 and t.layer = 'functional'
          order by e.id limit 1`, [v.id, element])).rows[0];
      const spec = link ? formatAddress({ kolab: link.tkolab, node: link.tnode, version: link.tseq, element: link.target_element_id ?? undefined }, { from: node.kolab_id }) : 'the spec';
      await this.ask(link?.target_version_id ?? v.id, link?.target_element_id ?? element, markId,
        `The review gate thinks binding ${here} changes behavior beyond ${spec}: ${f.explanation} If this behavior is intended, amend the spec and answer; if not, answer "no" and the binding must change.`);
    }
  }

  /**
   * Rejects a draft, or a version in review, and withdraws its open review requests, so they leave
   * their reviewers' inboxes and the author's answers show the outcome. Only commitStep commits
   * one; a version another review already settled stays as it is.
   */
  private reject(versionId: string, note: string | null): Promise<boolean> {
    return this.asSystem((tx, signal) => this.rejectIn(tx, signal, versionId, note));
  }

  /** reject, inside a transaction of the caller's. Returns whether anything changed. */
  private async rejectIn(tx: Q, signal: Signal, versionId: string, note: string | null): Promise<boolean> {
    const r = await tx.query<{ layer: Layer; actor_id: string }>(
      `update version set state = 'rejected', review_note = $2 where id = $1 and state in ('drafted', 'in_review') returning layer, actor_id`,
      [versionId, note]);
    const withdrawn = await tx.query(`update review_request set state = 'withdrawn', decided_at = now() where version_id = $1 and state = 'open' returning id`, [versionId]);
    if (r.rows[0] && withdrawn.rows.length) {
      await signal({ inbox: 'layer', layer: r.rows[0].layer });
      await signal({ inbox: 'actor', actor: r.rows[0].actor_id });
    }
    return r.rows.length > 0;
  }

  /**
   * A version that committed overtook every other version of its node in review: unless it is a
   * rebase of Kolab's own, which they fold onto at approval instead, they are stale (CAS7), so
   * they are rejected now, and leave their reviewers' inboxes, rather than when approved.
   */
  private async withdrawStale(v: VersionRow) {
    if (v.active_role === 'system') return;
    const waiting = await this.db.query<{ id: string }>(
      `select id from version where node_id = $1 and state = 'in_review' and id <> $2 order by seq`, [v.node_id, v.id]);
    const at = `${await this.nameOf(v.node_id)}@${v.seq}`;
    for (const { id } of waiting.rows) {
      await this.reject(id, `stale draft: ${at}, by ${v.actor_id}, committed while this waited in review; redraft against it`);
    }
  }

  /**
   * draft + review, for callers that don't need the two steps apart. Returns the committed version.
   * A version that waits in review (it has reviewers) throws a GateError; draft and review it apart.
   */
  async commit(sessionId: string, nodeId: string,
    input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string }): Promise<string> {
    const id = await this.draft(sessionId, nodeId, input);
    const result = await this.review(id);
    if (result.in_review) throw new GateError(`${await this.nameOf(nodeId)} waits in review by ${result.reviewers?.join(', ') ?? 'its reviewers'}; it commits once one approves it`);
    if (result.stale) throw new GateError(`review rejected: ${result.note ?? ''}`);
    if (!result.ok) throw new GateError(`the checks returned it to its author, still drafted: ${result.note ?? ''}`);
    return result.version;
  }

  // ---- addressing ----------------------------------------------------------

  /**
   * Resolve an address (string or object) to content + fingerprint, read from `where` (DAT11).
   * The short form names a node in the session's kolab (or the kolab `where` gives); the full
   * form names its kolab and resolves from anywhere its reader holds Read (locateNode). Without
   * `where`, only the full form resolves. A node that isn't there, or can't be read, is refused;
   * a version or element that isn't there is an orphan.
   */
  async resolve(address: Address | string, where: Where): Promise<Resolution & { versionId?: string }> {
    const a = typeof address === 'string' ? parseAddress(address) : address;
    const { version: v } = await this.locateVersion(where, a);
    if (!v) return { status: 'orphan' };
    const els = await this.read(where, (q) => this.elements(v.id, q));
    return { ...resolveInElements(els, a.element ?? null, a.selector ?? null), versionId: v.id };
  }

  /** Kolab's own resolution of a scope within a version it already holds, unchecked. */
  async resolveIn(versionId: string, elementId: string | null, selector: QuoteSelector | null): Promise<Resolution> {
    return resolveInElements(await this.elements(versionId), elementId, selector);
  }

  // ---- edges ---------------------------------------------------------------

  async link(sessionId: string, e: {
    kind: 'derivation' | 'dependency' | 'equivalence';
    source: string; sourceElement?: string;
    target: string; targetElement?: string; selector?: QuoteSelector;
  }): Promise<string> {
    const src = await this.version(e.source);
    const s = await this.requireLayer(sessionId, src.layer, src.kolab_id);
    const tgt = await this.version(e.target);
    // A link into another kolab needs Read on it and a mark when that goes (LNK8, D3), which wait
    // on a binding decision: until then, a link stays inside its kolab.
    if (tgt.kolab_id !== s.kolab) throw new AccessError(`the link target is not in kolab ${s.kolab}, the kolab this session works in`);
    if (tgt.state !== 'committed') {
      throw new GateError(`nothing may derive from ${e.target}: it has not cleared review`);
    }
    if (e.selector && normalize(e.selector.exact).length > MAX_QUOTE) {
      throw new Error(`the quote is ${normalize(e.selector.exact).length} characters; quote at most ${MAX_QUOTE}: `
        + `the few words you rely on, with several words either side as prefix and suffix. `
        + `To rely on a whole requirement, link to its element instead, without a selector.`);
    }
    const r = await this.resolveIn(e.target, e.targetElement ?? null, e.selector ?? null);
    if (r.status !== 'ok') throw new Error(await this.linkRefusal(tgt, e.targetElement ?? null, e.selector ?? null, r.status));
    // One edge per (source scope, target scope): duplicates would multiply marks.
    const dup = await this.db.query<{ id: string }>(
      `select id from edge where kind = $1 and source_version_id = $2
          and source_element_id is not distinct from $3 and target_version_id = $4
          and target_element_id is not distinct from $5 and target_selector is not distinct from $6::jsonb`,
      [e.kind, e.source, e.sourceElement ?? null, e.target, e.targetElement ?? null,
        e.selector ? JSON.stringify(e.selector) : null]);
    if (dup.rows[0]) return dup.rows[0].id;
    const id = ulid();
    await this.asAgent(sessionId, (tx) => tx.query(
      `insert into edge(id, kind, source_version_id, source_element_id, target_version_id,
                        target_element_id, target_selector, target_fingerprint)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, e.kind, e.source, e.sourceElement ?? null, e.target, e.targetElement ?? null,
        e.selector ? JSON.stringify(e.selector) : null, r.fingerprint]));
    return id;
  }

  /**
   * Why a link target doesn't resolve exactly, and how to fix it. A quoted span must stand as
   * written with its prefix or suffix still around it (D42), so a selector that is fuzzy is a bad
   * selector: the refusal quotes the current words with their current context to link to instead.
   */
  private async linkRefusal(tgt: VersionRow, elementId: string | null, selector: QuoteSelector | null,
    status: 'fuzzy' | 'orphan'): Promise<string> {
    const name = (await this.node(tgt.node_id)).name;
    const at = (sel?: QuoteSelector) => formatAddress({ node: name, version: tgt.seq, element: elementId ?? undefined, selector: sel });
    const subtree = elementId ? subtreeText(await this.elements(tgt.id), elementId) : undefined;
    if (subtree === undefined) {
      return `target does not resolve exactly (orphan): ${at()} has no element ${elementId}. Read the target with konjir_read_node and link to an element it has.`;
    }
    const span = selector ? resolveSpan(subtree, selector) : undefined;
    if (span?.status === 'fuzzy') {
      const text = normalize(subtree);
      const suggestion = { exact: span.content, ...spanContext(text, span.start, span.end) };
      return `target does not resolve exactly (fuzzy): ${JSON.stringify(normalize(selector!.exact))} does not stand as quoted `
        + `with its prefix or suffix in ${at()}; the nearest match reads ${JSON.stringify(span.content)}. `
        + `A prefix or suffix of one word or of punctuation is too little to tell. `
        + `Quote the current words with several words of their current context either side, e.g. ${at(suggestion)}`;
    }
    return `target does not resolve exactly (${status}): the quoted words are not in ${at()}. `
      + `Read the element with konjir_read_node and quote words it has now, with the words just before and after them as prefix and suffix.`;
  }

  // ---- the cascade ---------------------------------------------------------

  private async onCommit(versionId: string) {
    const v = await this.version(versionId);
    await this.withdrawStale(v);
    await this.supersedePrevious(v);
    await this.markStaleOverrides(v);
    await this.clearAddressed(v);
    const direct: string[] = [];

    // 1. Direct: every live edge pinned to an older version of this node.
    const inbound = await this.db.query<EdgeRow>(
      `select e.* from edge e
         join version t on t.id = e.target_version_id
         join version s on s.id = e.source_version_id
        where t.node_id = $1 and e.target_version_id <> $2
          and ${LIVE('s')}
          and not exists (select 1 from invalidation i where i.edge_id = e.id and i.state = 'open')`,
      [v.node_id, v.id]);
    for (const e of inbound.rows) {
      const markId = await this.checkEdge(e, v.id);
      if (markId) direct.push(markId);
    }

    // 2. Catch-up: if this version was drafted while its upstream moved on, its
    //    outbound edges may be pinned to targets that are no longer current.
    const outbound = await this.db.query<EdgeRow & { latest: string }>(
      `select e.*, (select l.id from version l where l.node_id = t.node_id and l.state = 'committed'
                     order by l.seq desc limit 1) as latest
         from edge e join version t on t.id = e.target_version_id
        where e.source_version_id = $1
          and not exists (select 1 from invalidation i where i.edge_id = e.id and i.state = 'open')`,
      [v.id]);
    for (const e of outbound.rows) {
      if (e.latest === e.target_version_id) continue;
      const markId = await this.checkEdge(e, e.latest);
      if (markId) direct.push(markId);
    }

    // 3. Transitive marks, one walk per direct mark, deduplicated across walks.
    for (const markId of direct) await this.propagate(markId);

    // 4. Children (variants) of an older version of this node rebase onto it.
    const children = await this.db.query<VersionRow>(
      `select c.* from version c join version p on p.id = c.parent_version_id
        where p.node_id = $1 and c.node_id <> $1 and p.id <> $2 and c.state = 'committed'
          and ${LIVE('c')}`,
      [v.node_id, v.id]);
    //    Each rebases the variant's live version as it is now, never the one listed, which
    //    someone may have committed past since.
    for (const c of children.rows) await this.catchUp(c.node_id);

    // 5. Catch-up for this version itself: drafted against a parent that has since moved on.
    await this.catchUp(v.node_id);
  }

  /**
   * If a variant's live version sits on an older version of its parent node, rebase it onto the
   * parent's latest. Every path that leaves a variant behind ends here: the parent's storm, the
   * variant's own commit, and a rebase dropped because something overtook it.
   */
  private async catchUp(nodeId: string) {
    const live = await this.latestCommitted(nodeId);
    if (!live?.parent_version_id) return;
    const p = await this.version(live.parent_version_id);
    if (p.node_id === nodeId) return;
    const latestParent = (await this.latestCommitted(p.node_id))!;
    if (latestParent.id !== p.id) await this.rebaseOrMark(live, latestParent);
    else await this.settleRebaseFailed(live);
  }

  /**
   * A variant whose live version sits on its parent's latest version has nothing left to
   * rebase, so its open rebase_failed mark settles, with its question: whether a rebase of
   * Kolab's passed or the variant committed onto that version itself (D44).
   */
  private async settleRebaseFailed(live: VersionRow) {
    const open = await this.db.query<{ id: string }>(
      `select i.id from invalidation i join version v on v.id = i.version_id
        where v.node_id = $1 and i.reason = 'rebase_failed' and i.state = 'open'`, [live.node_id]);
    for (const { id } of open.rows) {
      const at = `${await this.nameOf(live.node_id)}@${live.seq}`;
      await this.closeMark(id, `${at} sits on the parent's latest version`, `resolved: ${at} sits on the parent's latest version`);
    }
  }

  /** Re-resolve an edge against a newer target version: re-pin if unchanged, else mark. */
  private async checkEdge(e: EdgeRow, against: string): Promise<string | null> {
    const r = await this.resolveIn(against, e.target_element_id, e.target_selector);
    if (r.status === 'ok' && r.fingerprint === e.target_fingerprint) {
      // Content-identical: a cheap pointer bump, not a regeneration.
      await this.asSystem((tx) => tx.query(`update edge set target_version_id = $2 where id = $1`, [e.id, against]));
      return null;
    }
    const reason = r.status === 'orphan' ? 'orphaned' : r.status === 'fuzzy' ? 'fuzzy_reanchor' : 'changed';
    return this.mark({
      version_id: e.source_version_id, element_id: e.source_element_id, edge_id: e.id,
      triggered_by: against, reason,
    });
  }

  /**
   * Transitive marks: walk edges downstream of a dirty (version, element).
   * A (version, element) already marked by this commit gets another cause
   * rather than a second mark; it clears only when every cause has cleared.
   * The walk never re-enters the change itself: the element of the triggering
   * version that changed (its whole version, if the edge addressed all of it).
   * Other elements of the triggering version are reachable like any other.
   * It follows every live edge into any version of a node it reaches, not only the version it
   * reached: an edge that carries an open mark of its own is still pinned to an older version, and
   * its dependent relies on the element all the same (W2.5). That includes an edge whose own mark
   * says its target was orphaned: if an element with the same id comes back and is then marked,
   * the edge's address resolves to it again, so its dependent gets an upstream_dirty mark too.
   * (Edge lookups by target version have no index of their own yet; see W2.5's follow-up.)
   */
  private async propagate(markId: string) {
    const m = await this.markRow(markId);
    const changed = m.edge_id
      ? (await this.db.query<{ target_element_id: string | null }>(
          `select target_element_id from edge where id = $1`, [m.edge_id])).rows[0]?.target_element_id ?? null
      : null;
    const r = await this.db.query<{ version_id: string; element_id: string | null }>(
      `with recursive walk(version_id, element_id) as (
         select $1::text, $2::text
         union
         select e.source_version_id, e.source_element_id
           from walk w
           join version wv on wv.id = w.version_id
           join version t on t.node_id = wv.node_id
           join edge e on e.target_version_id = t.id
           join version s on s.id = e.source_version_id
          where (w.element_id is null or e.target_element_id is null or e.target_element_id = w.element_id)
            and not (e.source_version_id = $3 and ($4::text is null or e.source_element_id is not distinct from $4::text))
            and ${LIVE('s')}
       )
       select version_id, element_id from walk
        where not (version_id = $1 and element_id is not distinct from $2)`,
      [m.version_id, m.element_id, m.triggered_by, changed]);
    for (const row of r.rows) {
      const existing = await this.db.query<{ id: string }>(
        `select id from invalidation where version_id = $1 and element_id is not distinct from $2
            and triggered_by = $3 and reason = 'upstream_dirty' and state = 'open'`,
        [row.version_id, row.element_id, m.triggered_by]);
      const target = existing.rows[0]?.id
        ?? await this.mark({ ...row, triggered_by: m.triggered_by, reason: 'upstream_dirty' });
      await this.asSystem((tx) => tx.query(
        `insert into invalidation_cause(mark_id, cause_id) values ($1, $2) on conflict do nothing`, [target, markId]));
    }
  }

  // ---- overrides: the three-way rule ---------------------------------------

  /**
   * A rebase that fails for a reason of the variant's own (its checks refused it or failed, a gate
   * refused it) marks the variant, and the cascade carries on, so one
   * variant's failure never leaves the ones after it behind (W1.17). Anything else, such as a
   * lost connection or a failure in the cascade of a rebase that did commit, propagates: the
   * parent's caller gets a CascadeError rather than a success with variants silently left behind.
   */
  private async rebaseOrMark(child: VersionRow, newParent: VersionRow) {
    try {
      await this.rebase(child, newParent);
    } catch (e) {
      if (!(e instanceof GateError || e instanceof ChecksError)) throw e;
      await this.rebaseFailed(child.node_id, newParent.id, `Rebasing onto the new parent failed: ${e.message}. Commit a new version to rebase it, or wait for the parent's next commit.`);
    }
  }

  /**
   * Marks a variant whose rebase failed, on its live version, with a question. A variant holds
   * at most one open rebase_failed mark (D44): a later failure re-points that mark at the newer
   * parent, moves it to the live version and rewords its question instead of adding another.
   * Should a variant ever hold more than one, the canonical one is the one whose parent version
   * is newest, then the newest created: the rule migration 0004 used to merge them. The mark
   * settles when the variant sits on its parent's latest version (settleRebaseFailed).
   */
  private async rebaseFailed(nodeId: string, newParent: string, question: string) {
    const live = (await this.latestCommitted(nodeId))!.id;
    const open = (await this.db.query<{ id: string }>(
      `select i.id from invalidation i
         join version v on v.id = i.version_id
         join version t on t.id = i.triggered_by
        where v.node_id = $1 and i.reason = 'rebase_failed' and i.state = 'open'
        order by t.seq desc, i.created_at desc, i.id desc limit 1`, [nodeId])).rows[0];
    if (!open) {
      const markId = await this.mark({ version_id: live, element_id: null, triggered_by: newParent, reason: 'rebase_failed' });
      await this.ask(live, null, markId, question);
      return;
    }
    await this.asSystem(async (tx, signal) => {
      await tx.query(`update invalidation set triggered_by = $2, version_id = $3 where id = $1`, [open.id, newParent, live]);
      await tx.query(`update query set question = $2 where invalidation_id = $1 and state = 'open'`, [open.id, question]);
      await this.signalLayerOf(tx, signal, live);
    });
  }

  /**
   * `child` rebased onto `newParent`, through the review gate. The new version is built on
   * `base`, by default `child` itself. If the node has moved on past it by commit time, a rebase
   * of Kolab's own is dropped, and the variant's live version is caught up here instead, so
   * nothing depends on the overtaking version's own cascade getting that far.
   */
  private async rebase(child: VersionRow, newParent: VersionRow,
    opts: { author?: Pick<VersionRow, 'actor_id' | 'active_role'>; edgesFrom?: string; base?: string; approvedBy?: string; ruling?: string } = {}): Promise<GateResult> {
    const parentEls = await this.elements(newParent.id);
    const byId = new Map(parentEls.map((e) => [e.element_id, e]));
    const oldEls = new Map((await this.elements(child.id)).map((e) => [e.element_id, e]));
    const kept: Omit<DeltaRow, 'id' | 'version_id'>[] = [];

    for (const d of await this.deltas(child.id)) {
      const { id: _id, version_id: _v, ...rest } = d;
      if (d.kind === 'add') { kept.push(rest); continue; }
      const pe = byId.get(d.element_id);

      if (!pe) {
        if (d.kind === 'remove') continue; // parent removed it too: converged
        const old = oldEls.get(d.element_id)!;
        kept.push({ ...rest, parent_element_id: old.parent_element_id, ord: old.ord, state: 'orphaned' });
        continue;
      }
      if (pe.fingerprint === d.base_fingerprint) {
        // Parent's text is what the override was written against (or reverted to it).
        kept.push({ ...rest, base_version_id: newParent.id, state: 'clean' });
        continue;
      }
      if (d.kind === 'override' && fingerprint(d.text!) === pe.fingerprint) continue; // converged

      const childFp = d.kind === 'remove' ? 'REMOVED' : fingerprint(d.text!);
      const p = await this.db.query<{ resolution: OverrideResolution; amended_text: string | null }>(
        `select resolution, amended_text from precedent
          where base_fingerprint = $1 and parent_fingerprint = $2 and child_fingerprint = $3 and kolab_id = $4`,
        [d.base_fingerprint, pe.fingerprint, childFp, child.kolab_id]);
      const prec = p.rows[0];
      if (prec?.resolution === 'adopt_parent') continue;
      if (prec) {
        kept.push({
          ...rest, text: prec.resolution === 'amend' ? prec.amended_text : d.text,
          base_version_id: newParent.id, base_fingerprint: pe.fingerprint, state: 'clean',
        });
        continue;
      }
      kept.push({ ...rest, state: 'dirty' }); // the override still stands; base stays where it was
    }

    const id = ulid();
    const els = materialize(parentEls, kept);
    await this.asSystem(async (tx) => {
      await writeVersion(tx, {
        id, node_id: child.node_id, seq: await nextSeq(tx, child.node_id), parent_version_id: newParent.id,
        base_version_id: opts.base ?? child.id, layer: child.layer,
        actor_id: opts.author?.actor_id ?? SYSTEM_ACTOR, active_role: opts.author?.active_role ?? 'system',
      }, els, kept);
      if (opts.edgesFrom) await copyEdges(tx, opts.edgesFrom, id, new Set(els.map((e) => e.element_id)));
      if (opts.author) {
        // A fold carries what waits on the person's version, the resolution it makes, and
        // remembers the version it folds, the first of a chain of folds.
        await tx.query(`update version f set folded_from = $2, resolves = c.resolves
                          from version c where f.id = $1 and c.id = $3`, [id, child.folded_from ?? child.id, child.id]);
      }
    }, child.node_id);

    // A rebase of Kolab's own commits after structural checks only (VER12). A fold carries a
    // person's edit: approved already, it does the same; otherwise it goes into review.
    let verdict: GateResult;
    try {
      verdict = await this.judge(id, opts.approvedBy, opts.ruling);
    } catch (e) {
      // The checks fell over: the rebase never committed, and nothing will resubmit it.
      if (e instanceof ChecksError) await this.reject(id, e.message);
      throw e;
    }
    if (verdict.stale) {
      // Overtaken, it failed nothing. Whatever overtook it may still be behind the parent.
      await this.catchUp(child.node_id);
      return verdict;
    }
    if (verdict.in_review) return verdict;   // a fold, waiting for its reviewers
    if (!verdict.ok) {
      // The node stays on whatever it last committed; the mark goes there.
      await this.rebaseFailed(child.node_id, newParent.id, `Rebasing onto the new parent failed review: ${verdict.note ?? ''}`);
      return verdict;
    }
    // A rebase that passed settled any earlier failed one in its own cascade: the variant's
    // catch-up found it on the parent's latest version (settleRebaseFailed).
    return verdict;
  }

  /**
   * An author who edits a marked element in a version drafted after the mark
   * was raised has addressed it: rewriting the element in response to the
   * upstream change is the "check and fix" a clear would otherwise record.
   * The edge re-pins to the current target and anything the mark caused clears.
   * An element left untouched keeps its mark, so a fix has to be deliberate.
   * The same goes for a transitive (upstream_dirty) mark: revising the element settles its mark
   * (LNK6, CAS4), whatever caused it, as clearing it would. A link whose target is gone can't
   * re-pin, so its mark stays open until it is re-linked.
   */
  private async clearAddressed(v: VersionRow) {
    if (v.active_role === 'system') return; // Kolab's own rebases address nothing
    // What this version revised: elements whose text or place in the tree differs from the node's
    // previous version. Not every element with a delta: a variant carries its overrides forward
    // into each version, and an override it didn't touch addresses nothing (W2.5).
    const before = await this.db.query<{ id: string }>(
      `select id from version where node_id = $1 and seq < $2 and state = 'committed' order by seq desc limit 1`, [v.node_id, v.seq]);
    const was = new Map((before.rows[0] ? await this.elements(before.rows[0].id) : []).map((e) => [e.element_id, e]));
    const revised = (await this.elements(v.id))
      .filter((e) => was.get(e.element_id)?.fingerprint !== e.fingerprint || was.get(e.element_id)?.parent_element_id !== e.parent_element_id)
      .map((e) => e.element_id);
    if (!revised.length) return;
    const addressedBy = `addressed by version ${v.seq} of ${await this.nameOf(v.node_id)}`;
    const marks = await this.db.query<MarkRow & { target_node: string }>(
      `select i.*, tv.node_id as target_node
         from invalidation i
         join edge e on e.id = i.edge_id
         join version tv on tv.id = e.target_version_id
         join version me on me.id = $1
        where i.version_id = me.id and i.state = 'open' and i.element_id = any($2)
          and i.reason in ('changed', 'fuzzy_reanchor')
          and i.created_at < me.created_at`, [v.id, revised]);
    for (const m of marks.rows) {
      const e = (await this.db.query<EdgeRow>(`select * from edge where id = $1`, [m.edge_id])).rows[0];
      const latest = (await this.latestCommitted(m.target_node))!;
      const r = await this.resolveIn(latest.id, e.target_element_id, e.target_selector);
      if (r.status === 'orphan') continue;
      await this.asSystem((tx) => tx.query(
        `update edge set target_version_id = $2, target_fingerprint = $3 where id = $1`, [e.id, latest.id, r.fingerprint]));
      await this.closeMark(m.id, addressedBy);
    }
    const answered = await this.db.query<{ id: string }>(
      `select i.id from invalidation i
         join version me on me.id = $1
        where i.version_id = me.id and i.state = 'open' and i.element_id = any($2)
          and i.reason in ('query_answered', 'upstream_dirty')
          and i.created_at < me.created_at`, [v.id, revised]);
    for (const m of answered.rows) await this.closeMark(m.id, addressedBy);
  }

  /**
   * Every non-clean override on a live version has exactly one open mark and query, and they say
   * what holds now: an override that was dirty and is now orphaned, or the reverse, has its mark
   * and question reworded rather than kept as they were raised.
   */
  private async markStaleOverrides(v: VersionRow) {
    for (const d of await this.deltas(v.id)) {
      if (d.state === 'clean') continue;
      const reason = d.state === 'dirty' ? 'override_stale' : 'override_orphaned';
      const question = d.state === 'dirty'
        ? `The parent changed ${d.element_id}, which you override. Reaffirm, adopt the parent's text, or amend?`
        : `The parent deleted ${d.element_id}, which you override. Keep it as your own addition, or drop it?`;
      const open = (await this.db.query<{ id: string; reason: string }>(
        `select id, reason from invalidation where delta_id = $1 and state = 'open'`, [d.id])).rows[0];
      if (open) {
        if (open.reason !== reason) {
          await this.asSystem(async (tx, signal) => {
            await tx.query(`update invalidation set reason = $2, triggered_by = $3 where id = $1`, [open.id, reason, v.parent_version_id]);
            await tx.query(`update query set question = $2 where invalidation_id = $1 and state = 'open'`, [open.id, question]);
            await signal({ inbox: 'layer', layer: v.layer });
          });
        }
        continue;
      }
      const markId = await this.mark({
        version_id: v.id, element_id: d.element_id, delta_id: d.id, triggered_by: v.parent_version_id!, reason,
      });
      await this.ask(v.id, d.element_id, markId, question);
    }
  }

  /** Resolve a stale or orphaned override. Records precedent for the triple. */
  async resolveOverride(sessionId: string, markId: string, resolution: OverrideResolution, amendedText?: string) {
    const m = await this.markRow(markId);
    if (!m.delta_id || m.state !== 'open') throw new Error(`${markId} is not an open override mark`);
    const v = await this.version(m.version_id);
    const s = await this.requireLayer(sessionId, v.layer, v.kolab_id);
    const deltas = await this.deltas(v.id);
    const d = deltas.find((x) => x.id === m.delta_id)!;
    const parentEls = await this.elements(v.parent_version_id!);
    const pe = parentEls.find((e) => e.element_id === d.element_id);

    const next = deltas.flatMap(({ id: _i, version_id: _v, ...rest }) => {
      if (rest.element_id !== d.element_id) return [rest];
      if (resolution === 'adopt_parent') return [];
      const text = resolution === 'amend' ? amendedText! : rest.text;
      if (!pe) return [{ ...rest, kind: 'add' as const, text, base_version_id: null, base_fingerprint: null, state: 'clean' as const }];
      return [{ ...rest, text, base_version_id: v.parent_version_id, base_fingerprint: pe.fingerprint, state: 'clean' as const }];
    });

    const id = ulid();
    await this.asAgent(sessionId, async (tx) => writeVersion(tx, {
      id, node_id: v.node_id, seq: await nextSeq(tx, v.node_id), parent_version_id: v.parent_version_id,
      base_version_id: v.id, layer: v.layer, actor_id: s.actor_id, active_role: s.active_role,
    }, materialize(parentEls, next), next), v.node_id);
    const ruling: Ruling = {
      markId, actor: s.actor_id, resolution, amendedText: amendedText ?? null,
      triple: pe ? [d.base_fingerprint, pe.fingerprint, d.kind === 'remove' ? 'REMOVED' : fingerprint(d.text!)] : undefined,
    };
    await this.asSystem((tx) => tx.query(`update version set resolves = $2 where id = $1`, [id, JSON.stringify(ruling)]));

    // The resolution is itself a new version: it must clear the gate, and its review if it has
    // reviewers, before the mark closes, the query is answered, or precedent is set. The ruling waits
    // on the version (version.resolves), and commitStep records all three as it commits, before the
    // cascade, whenever that is.
    const verdict = await this.review(id);
    return { version: id, verdict };
  }

  // ---- clearing ------------------------------------------------------------

  /** "I checked; my dependent still holds." Re-pins the edge and clears what it caused. */
  async clear(sessionId: string, markId: string) {
    const m = await this.markRow(markId);
    const v = await this.version(m.version_id);
    const s = await this.requireLayer(sessionId, v.layer, v.kolab_id);
    if (m.delta_id) throw new Error('use resolveOverride for override marks');
    if (m.edge_id) {
      const e = (await this.db.query<EdgeRow>(`select * from edge where id = $1`, [m.edge_id])).rows[0];
      const tNode = (await this.version(e.target_version_id)).node_id;
      const latest = (await this.latestCommitted(tNode))!;
      const r = await this.resolveIn(latest.id, e.target_element_id, e.target_selector);
      if (r.status === 'orphan') throw new GateError('the target no longer exists; re-link instead of clearing');
      await this.asSystem((tx) => tx.query(
        `update edge set target_version_id = $2, target_fingerprint = $3 where id = $1`, [e.id, latest.id, r.fingerprint]));
    }
    await this.closeMark(markId, s.actor_id);
  }

  /**
   * A resolution's ruling, inside the transaction that commits it (version.resolves): the precedent for
   * its triple in its kolab, unless one already stands there (the first ruling stands), and its mark closed, with
   * its question answered by the ruling and the actor who made it.
   */
  private async recordRuling(tx: Q, signal: Signal, r: Ruling) {
    if (r.triple) {
      await tx.query(
        // In the kolab of the mark it settles: precedent is per kolab (TEN13).
        `insert into precedent(id, base_fingerprint, parent_fingerprint, child_fingerprint, resolution, amended_text, ruled_by, kolab_id)
         values ($1,$2,$3,$4,$5,$6,$7, (select i.kolab_id from invalidation i where i.id = $8)) on conflict do nothing`,
        [ulid(), ...r.triple, r.resolution, r.amendedText, r.actor, r.markId]);
    }
    await this.closeMarkIn(tx, signal, r.markId, r.actor, { answer: r.resolution, by: r.actor });
  }

  /**
   * Clears a mark, and the marks it alone caused, and with `answer` answers the mark's
   * question, all in one transaction that signals every layer whose inbox lost work.
   */
  private async closeMark(markId: string, by: string, answer?: string) {
    await this.asSystem((tx, signal) => this.closeMarkIn(tx, signal, markId, by, answer === undefined ? undefined : { answer, by }));
  }

  private async closeMarkIn(tx: Q, signal: Signal, markId: string, by: string, answer?: { answer: string; by: string }) {
    const closed = await tx.query<{ version_id: string }>(
      `update invalidation set state = 'cleared', cleared_by = $2 where id = $1 returning version_id`, [markId, by]);
    if (!closed.rows[0]) throw new Error(`no mark ${markId}`);
    await this.signalLayerOf(tx, signal, closed.rows[0].version_id);
    if (answer !== undefined) {
      await tx.query(`update query set state = 'answered', answer = $2, answered_by = $3 where invalidation_id = $1 and state = 'open'`,
        [markId, answer.answer, answer.by]);
    }
    const caused = await tx.query<{ mark_id: string }>(
      `delete from invalidation_cause where cause_id = $1 returning mark_id`, [markId]);
    for (const { mark_id } of caused.rows) {
      const cascaded = await tx.query<{ version_id: string }>(
        `update invalidation set state = 'cleared', cleared_by = $2
          where id = $1 and state = 'open'
            and not exists (select 1 from invalidation_cause c where c.mark_id = $1)
         returning version_id`,
        [mark_id, `cause ${markId} cleared`]);
      for (const r of cascaded.rows) await this.signalLayerOf(tx, signal, r.version_id);
    }
  }

  // ---- queries (the lightweight tier) ---------------------------------------

  /**
   * Ask a question, or leave a note, against an address. It lands on the layer
   * that owns the answer: the version the address resolves to. Anyone may ask.
   *
   * `from` names the asker's own element that waits on the answer (drafts
   * allowed). When a question is answered, that element gets a
   * `query_answered` mark, so the answer reaches the work that relied on it
   * even if the spec text never changes. A note doesn't block anything, so a
   * reply to it marks nothing.
   */
  async raiseQuery(sessionId: string, address: Address | string, question: string,
    opts: { kind?: QueryKind; from?: Address | string } = {}): Promise<string> {
    const s = await this.session(sessionId);
    const a = typeof address === 'string' ? parseAddress(address) : address;
    // Anyone with access may ask (Q1), about what is in the kolab they work in: a question
    // across kolabs would cross with a link's rules (LNK8), which wait on a binding decision.
    await this.nodeIn(sessionId, a, 'asking');
    const r = await this.resolve(a, { session: sessionId });
    if (!r.versionId || r.status === 'orphan') throw new Error(`cannot ask about ${typeof address === 'string' ? address : JSON.stringify(address)}: it does not resolve`);
    let from: { version: string; element: string | null } | undefined;
    if (opts.from) {
      const f = typeof opts.from === 'string' ? parseAddress(opts.from) : opts.from;
      await this.nodeIn(sessionId, f, 'waiting on an answer');
      const fr = await this.resolve(f, { session: sessionId });
      if (!fr.versionId || fr.status === 'orphan') throw new Error(`from ${formatAddress(f)} does not resolve`);
      if ((await this.version(fr.versionId)).layer !== LAYER_OF_ROLE[s.active_role]) {
        throw new RoleError(`from must be an element of your own layer (${LAYER_OF_ROLE[s.active_role]})`);
      }
      from = { version: fr.versionId, element: f.element ?? null };
    }
    const id = ulid();
    await this.asSystem(async (tx, signal) => {
      await tx.query(
        `insert into query(id, version_id, element_id, selector, kind, question, raised_by, from_version_id, from_element_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, r.versionId, a.element ?? null, a.selector ? JSON.stringify(a.selector) : null, opts.kind ?? 'question',
          question, s.actor_id, from?.version ?? null, from?.element ?? null]);
      await this.signalLayerOf(tx, signal, r.versionId!);
    });
    return id;
  }

  /** Only the layer that owns the answer may answer. Override and edge questions resolve through their own verbs. */
  async answerQuery(sessionId: string, queryId: string, answer: string) {
    const q = (await this.db.query<{
      version_id: string; element_id: string | null; invalidation_id: string | null; state: string;
      kind: QueryKind; question: string; raised_by: string | null; from_version_id: string | null; from_element_id: string | null;
    }>(`select * from query where id = $1`, [queryId])).rows[0];
    if (!q) throw new Error(`no query ${queryId}`);
    if (q.state !== 'open') throw new GateError(`query ${queryId} is already answered`);
    const mark = q.invalidation_id ? await this.markRow(q.invalidation_id) : undefined;
    if (mark && mark.reason !== 'role_boundary') {
      throw new GateError(`query ${queryId} is about a dirty mark; resolve it with konjir_resolve_override or konjir_clear_mark`);
    }
    const v = await this.version(q.version_id);
    const s = await this.requireLayer(sessionId, v.layer, v.kolab_id);
    // The owner's queue shrinks and the asker's answers grow, in the transaction that answers.
    await this.inTransaction(async (tx, signal) => {
      await tx.query(`update query set state = 'answered', answer = $2, answered_by = $3 where id = $1`, [queryId, answer, s.actor_id]);
      await signal({ inbox: 'layer', layer: v.layer });
      if (q.raised_by) await signal({ inbox: 'actor', actor: q.raised_by });
    });
    // A boundary question is settled by the layer that owns the answer; its mark goes with it.
    if (mark && mark.state === 'open') await this.closeMark(mark.id, `answered by ${s.actor_id}: ${answer}`);
    if (q.kind === 'question' && q.from_version_id) await this.markAsker(q, v, answer);
  }

  /**
   * The element that asked now has its answer: mark it on its node's live
   * version (the draft it was asked from may have committed, or been
   * superseded since). If the element is gone, the asker still sees the
   * answer through list_queries mine=true.
   */
  private async markAsker(q: { element_id: string | null; question: string; from_version_id: string | null; from_element_id: string | null },
    asked: VersionRow, answer: string) {
    const fromNode = (await this.version(q.from_version_id!)).node_id;
    const live = await this.latestCommitted(fromNode) ?? await this.version(q.from_version_id!);
    if (q.from_element_id && !(await this.elements(live.id)).some((e) => e.element_id === q.from_element_id)) return;
    const on = formatAddress({ node: await this.nameOf(asked.node_id), element: q.element_id ?? undefined });
    await this.mark({
      version_id: live.id, element_id: q.from_element_id, reason: 'query_answered',
      triggered_by: (await this.latestCommitted(asked.node_id))?.id ?? asked.id,
      note: `${on}: you asked "${q.question}"; answered: "${answer}"`,
    });
  }

  // ---- inspection ----------------------------------------------------------

  async sessionInfo(sessionId: string) {
    const s = await this.session(sessionId);
    return {
      session: sessionId, actor: s.actor_id, kind: s.kind, owner: s.owner,
      role: s.active_role, layer: LAYER_OF_ROLE[s.active_role], kolab: s.kolab, access: s.access,
    };
  }

  /** Nodes, of one kind if given, in one kolab if given, with the names addresses give them. */
  async listNodes(kind?: Kind, kolab?: string) {
    return (await this.db.query<{ id: string; name: string; kolab: string; kind: Kind; layer: Layer; title: string; latest: number | null; drafts: number; in_review: number }>(
      `select n.id, n.name, n.kolab_id as kolab, n.kind, n.layer, n.title,
              (select max(seq) from version v where v.node_id = n.id and v.state = 'committed') as latest,
              (select count(*)::int from version v where v.node_id = n.id and v.state = 'drafted') as drafts,
              (select count(*)::int from version v where v.node_id = n.id and v.state = 'in_review') as in_review
         from node n where ($1::text is null or n.kind = $1) and ($2::text is null or n.kolab_id = $2)
        order by n.kind, n.name, n.kolab_id`, [kind ?? null, kolab ?? null])).rows;
  }

  /**
   * Edges into (upstream) or out of (downstream) a version, with human-readable addresses: the
   * short form in the version's own kolab.
   */
  async lineage(versionId: string, direction: 'upstream' | 'downstream') {
    const cols = `e.id, e.kind, e.source_element_id, sn.name as source_node, sn.kolab_id as source_kolab, sv.seq as source_seq,
                  e.target_element_id, e.target_selector, tn.name as target_node, tn.kolab_id as target_kolab, tv.seq as target_seq
             from edge e join version sv on sv.id = e.source_version_id join version tv on tv.id = e.target_version_id
             join node sn on sn.id = sv.node_id join node tn on tn.id = tv.node_id`;
    const sql = direction === 'upstream'
      ? `select ${cols} where e.source_version_id = $1`
      : `select ${cols} where tv.node_id = (select node_id from version where id = $1) and ${LIVE('sv')}`;
    const from = (await this.version(versionId)).kolab_id;
    const rows = (await this.db.query<{
      id: string; kind: string; source_element_id: string | null; source_node: string; source_kolab: string; source_seq: number;
      target_element_id: string | null; target_selector: QuoteSelector | null; target_node: string; target_kolab: string; target_seq: number;
    }>(sql, [versionId])).rows;
    return rows.map((r) => ({
      edge: r.id,
      kind: r.kind,
      source: formatAddress({ kolab: r.source_kolab, node: r.source_node, version: r.source_seq, element: r.source_element_id ?? undefined }, { from }),
      target: formatAddress({ kolab: r.target_kolab, node: r.target_node, version: r.target_seq, element: r.target_element_id ?? undefined, selector: r.target_selector ?? undefined }, { from }),
    }));
  }

  /**
   * Open marks with the addresses involved, so an agent can act without more lookups. `node` is a
   * node's id. Addresses are in the short form of the mark's own kolab.
   */
  async describeMarks(filter: { layer?: Layer; node?: string; kolab?: string } = {}) {
    const rows = (await this.db.query<MarkRow & {
      node: string; seq: number; layer: Layer; trig_node: string; trig_kolab: string; trig_seq: number;
      t_element: string | null; t_selector: QuoteSelector | null; cause_count: number; kolab_id: string;
    }>(
      `select i.*, n.name as node, v.seq, v.layer, tn.name as trig_node, tn.kolab_id as trig_kolab, tv.seq as trig_seq,
              e.target_element_id as t_element, e.target_selector as t_selector,
              (select count(*)::int from invalidation_cause c where c.mark_id = i.id) as cause_count
         from invalidation i
         join version v on v.id = i.version_id
         join node n on n.id = v.node_id
         join version tv on tv.id = i.triggered_by
         join node tn on tn.id = tv.node_id
         left join edge e on e.id = i.edge_id
        where i.state = 'open'
          and ($1::text is null or v.layer = $1)
          and ($2::text is null or v.node_id = $2)
          and ($3::text is null or i.kolab_id = $3)
        order by i.created_at, i.id`, [filter.layer ?? null, filter.node ?? null, filter.kolab ?? null])).rows;
    return rows.map((r) => {
      const from = r.kolab_id;
      const trig = (a: Omit<Address, 'node' | 'kolab'>) => formatAddress({ kolab: r.trig_kolab, node: r.trig_node, ...a }, { from });
      return {
        mark: r.id,
        reason: r.reason,
        dirty: formatAddress({ node: r.node, version: r.seq, element: r.element_id ?? undefined }),
        layer: r.layer,
        because: r.reason === 'query_answered' ? r.note ?? 'your question was answered'
          : r.note ? `review gate: ${r.note}`
          : r.edge_id
          ? `${trig({ element: r.t_element ?? undefined, selector: r.t_selector ?? undefined })} changed in version ${r.trig_seq}`
          : r.reason === 'upstream_dirty' ? `${r.cause_count} upstream mark(s) are open`
          : `parent ${trig({}).slice('kj:'.length)} version ${r.trig_seq}`,
        next: NEXT_STEP[r.reason] ?? '',
      };
    });
  }

  /**
   * Questions and notes. `node` is a node's id. Addresses are written to be read in kolab `from`:
   * by default the query's own, where the short form is enough.
   */
  async listQueries(filter: {
    layer?: Layer; state?: QueryState; raisedBy?: string; node?: string; kind?: QueryKind; kolab?: string; from?: string;
  } = {}, q: Q = this.db): Promise<Query[]> {
    const rows = (await q.query<{
      id: string; kind: QueryKind; node: string; seq: number; element_id: string | null; kolab_id: string;
      selector: QuoteSelector | null; question: string; state: string; answer: string | null; answered_by: string | null;
      raised_by: string | null; mark: string | null; from_node: string | null; from_kolab: string | null; from_seq: number | null; from_element_id: string | null;
    }>(
      `select q.id, q.kind, n.name as node, v.seq, q.element_id, q.kolab_id, q.selector, q.question, q.state, q.answer, q.answered_by,
              q.raised_by, q.invalidation_id as mark, fn.name as from_node, fn.kolab_id as from_kolab, fv.seq as from_seq, q.from_element_id
         from query q join version v on v.id = q.version_id
         join node n on n.id = v.node_id
         left join version fv on fv.id = q.from_version_id
         left join node fn on fn.id = fv.node_id
        where ($1::text is null or v.layer = $1) and ($2::text is null or q.state = $2)
          and ($3::text is null or q.raised_by = $3) and ($4::text is null or v.node_id = $4)
          and ($5::text is null or q.kind = $5) and ($6::text is null or q.kolab_id = $6)
        order by q.id`,
      [filter.layer ?? null, filter.state ?? null, filter.raisedBy ?? null, filter.node ?? null, filter.kind ?? null, filter.kolab ?? null])).rows;
    return rows.map((r) => ({
      id: r.id, kind: r.kind,
      address: formatAddress({ kolab: r.kolab_id, node: r.node, version: r.seq, element: r.element_id ?? undefined, selector: r.selector ?? undefined }, { from: filter.from ?? r.kolab_id }),
      question: r.question, state: r.state, answer: r.answer, answered_by: r.answered_by, raised_by: r.raised_by,
      from: r.from_node ? formatAddress({ kolab: r.from_kolab!, node: r.from_node, version: r.from_seq!, element: r.from_element_id ?? undefined }, { from: filter.from ?? r.kolab_id }) : null,
      mark: r.mark,
    }));
  }

  /**
   * Open review requests, each waiting in its reviewer's inbox (REV2, VER17), oldest first. With
   * `reviewer`, only theirs; with `layer`, only on versions of that layer.
   */
  async reviewRequests(filter: { reviewer?: string; layer?: Layer; kolab?: string } = {}): Promise<ReviewRequestView[]> {
    const rows = (await this.db.query<{ id: string; node_id: string; seq: number; author: string; reviewer: string; created_at: Date | string }>(
      `select r.id, n.name as node_id, v.seq, v.actor_id as author, r.reviewer_id as reviewer, r.created_at
         from review_request r join version v on v.id = r.version_id join node n on n.id = v.node_id
        where r.state = 'open' and v.state = 'in_review'
          and ($1::text is null or r.reviewer_id = $1) and ($2::text is null or v.layer = $2) and ($3::text is null or r.kolab_id = $3)
        order by r.created_at, r.reviewer_id, r.id`, [filter.reviewer ?? null, filter.layer ?? null, filter.kolab ?? null])).rows;
    return rows.map((r) => ({
      request: r.id, subject: `kj:${r.node_id}@${r.seq}`, subject_kind: 'version' as const, author: r.author, reviewer: r.reviewer,
      requested_at: new Date(r.created_at).toISOString(),
      next: `Read it with konjir_read_node node=${r.node_id} version=${r.seq}. Check each element states one testable intent, that no two contradict each other or what they link to, and that none belongs to the other layer. Then konjir_review node=${r.node_id} version=${r.seq} verdict=approve, or verdict=request_changes with a note and findings (contradiction or layer_leak, naming the elements). The konjir_reviewer_instructions prompt says how.`,
    }));
  }

  /**
   * An author's versions that went into review, newest first, with each verdict: what their
   * answers show them, so a request for changes, an approval or a stale draft reaches them.
   */
  async submissions(author: string, opts: { kolab?: string; limit?: number } = {}): Promise<SubmissionView[]> {
    const versions = (await this.db.query<VersionRow & { review_note: string | null }>(
      `select v.* from version v
        where v.actor_id = $1 and exists (select 1 from review_request r where r.version_id = v.id)
          and ($3::text is null or v.kolab_id = $3)
        order by v.created_at desc, v.id desc limit $2`, [author, opts.limit ?? 20, opts.kolab ?? null])).rows;
    const out: SubmissionView[] = [];
    for (const v of versions) {
      const verdicts = (await this.db.query<{ reviewer_id: string; state: ReviewRequestState; note: string | null; findings: Finding[] | null }>(
        `select reviewer_id, state, note, findings from review_request where version_id = $1 order by created_at, reviewer_id, id`, [v.id])).rows;
      const name = await this.nameOf(v.node_id);
      const subject = `kj:${name}@${v.seq}`;
      const fold = v.state === 'rejected' ? (await this.db.query<{ node_id: string; seq: number }>(
        `select n.name as node_id, f.seq from version f join node n on n.id = f.node_id where f.folded_from = $1 order by (f.state = 'committed') desc, f.seq desc limit 1`, [v.id])).rows[0] : undefined;
      const foldedInto = fold && v.review_note?.startsWith('folded into ') ? `kj:${fold.node_id}@${fold.seq}` : undefined;
      out.push({
        subject, state: v.state, note: v.review_note, ...(foldedInto ? { folded_into: foldedInto } : {}),
        verdicts: verdicts.map((r) => ({ reviewer: r.reviewer_id, state: r.state, note: r.note, findings: r.findings ?? [] })),
        next: v.state === 'in_review' ? 'Waiting for a reviewer; nothing to do.'
          : v.state === 'drafted' ? `Changes were requested. Draft a new version that addresses them (and konjir_abandon node=${name} version=${v.seq}), or resubmit this one unchanged with konjir_submit_for_review if you disagree, saying why with konjir_annotate.`
          : v.state === 'committed' ? 'Committed.'
          : foldedInto ? `Folded into ${foldedInto}, which carries this edit, onto Kolab's rebase; nothing to do.`
          : 'Rejected; see the note.',
      });
    }
    return out;
  }

  async openMarks(): Promise<MarkRow[]> {
    return (await this.db.query<MarkRow>(`select * from invalidation where state = 'open' order by created_at, id`)).rows;
  }

  async openQueries() {
    return (await this.db.query<{ id: string; version_id: string; element_id: string | null; question: string }>(
      `select id, version_id, element_id, question from query where state = 'open'`)).rows;
  }

  /** The name addresses give a node, by its id. */
  private async nameOf(id: string): Promise<string> {
    return (await this.node(id)).name;
  }

  /** A node by its id. */
  async node(id: string): Promise<NodeRow> {
    const r = await this.db.query<NodeRow>(`select * from node where id = $1`, [id]);
    if (!r.rows[0]) throw new Error(`no node ${id}`);
    return r.rows[0];
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Variants may not form a loop (A extends B extends A): each rebase would
   * trigger the other forever. Walk the parent chain, collapsing runs of the
   * same node (ordinary evolution), and refuse if this node reappears.
   */
  private async refuseCycle(nodeId: string, parentId: string) {
    const r = await this.db.query<{ node_id: string; name: string }>(
      `with recursive up(id, node_id, parent_version_id, depth) as (
         select id, node_id, parent_version_id, 0 from version where id = $1
         union all
         select v.id, v.node_id, v.parent_version_id, u.depth + 1
           from version v join up u on v.id = u.parent_version_id
       )
       select up.node_id, n.name from up join node n on n.id = up.node_id order by depth`, [parentId]);
    const chain = r.rows.filter((n, i, a) => i === 0 || a[i - 1].node_id !== n.node_id);
    if (chain[0]?.node_id === nodeId) chain.shift();
    if (chain.some((n) => n.node_id === nodeId)) {
      throw new GateError(`${await this.nameOf(nodeId)} would inherit from itself through ${chain.map((n) => n.name).join(' -> ')}`);
    }
  }

  private async markRow(id: string): Promise<MarkRow> {
    const r = await this.db.query<MarkRow>(`select * from invalidation where id = $1`, [id]);
    if (!r.rows[0]) throw new Error(`no mark ${id}`);
    return r.rows[0];
  }

  private async mark(m: {
    version_id: string; element_id: string | null; triggered_by: string; reason: string;
    edge_id?: string; delta_id?: string; note?: string;
  }): Promise<string> {
    const id = ulid();
    await this.asSystem(async (tx, signal) => {
      await tx.query(
        `insert into invalidation(id, version_id, element_id, edge_id, delta_id, triggered_by, reason, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, m.version_id, m.element_id, m.edge_id ?? null, m.delta_id ?? null, m.triggered_by, m.reason, m.note ?? null]);
      await this.signalLayerOf(tx, signal, m.version_id);
    });
    return id;
  }

  private async ask(versionId: string, elementId: string | null, markId: string, question: string) {
    await this.asSystem(async (tx, signal) => {
      await tx.query(
        `insert into query(id, version_id, element_id, invalidation_id, question) values ($1,$2,$3,$4,$5)`,
        [ulid(), versionId, elementId, markId, question]);
      await this.signalLayerOf(tx, signal, versionId);
    });
  }

  /**
   * A newly committed version supersedes its node's previous live version.
   * Outbound edges carry forward (for elements that still exist), and open
   * marks move with them: nothing is silently forgotten by re-versioning.
   */
  private async supersedePrevious(v: VersionRow) {
    const prev = await this.db.query<VersionRow>(
      `select * from version where node_id = $1 and seq < $2 and state = 'committed' order by seq desc limit 1`,
      [v.node_id, v.seq]);
    const p = prev.rows[0];
    if (!p) return;
    const live = new Set((await this.elements(v.id)).map((e) => e.element_id));
    const at = `${await this.nameOf(v.node_id)}@${v.seq}`;
    await this.asSystem(async (tx, signal) => {
      await copyEdges(tx, p.id, v.id, live);
      // Edge and transitive marks move to the new version.
      await tx.query(`update invalidation set version_id = $2 where version_id = $1 and state = 'open' and delta_id is null`, [p.id, v.id]);
      // An override mark follows its element if the new version's override is still not clean;
      // otherwise the new version resolved it and the mark clears.
      await tx.query(
        `update invalidation i set version_id = $2, delta_id = nd.id
           from delta od, delta nd
          where i.version_id = $1 and i.state = 'open' and i.delta_id = od.id
            and nd.version_id = $2 and nd.element_id = od.element_id and nd.state <> 'clean'`, [p.id, v.id]);
      const settled = await tx.query<{ id: string }>(
        `update invalidation set state = 'cleared', cleared_by = $2
          where version_id = $1 and state = 'open' and delta_id is not null returning id`, [p.id, `superseded by ${v.id}`]);
      // Its question goes with it: nothing could answer it once the mark is cleared. Kolab answers
      // it, since nobody ruled; a resolution closed its own mark and question as it committed.
      if (settled.rows.length) {
        await tx.query(`update query set state = 'answered', answer = $2, answered_by = $3 where invalidation_id = any($1) and state = 'open'`,
          [settled.rows.map((r) => r.id), `resolved: ${at} no longer holds this override dirty or orphaned`, SYSTEM_ACTOR]);
        await signal({ inbox: 'layer', layer: v.layer });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Kolab's own checks: structural only (VER5, REV1). Kolab makes no model call (REV5); whether
 * elements contradict each other or leak across layers is for its reviewers (konjir_review), and
 * the note says plainly what was and wasn't checked.
 */
export const structuralChecks: Checks = ({ elements }) => {
  const problems: string[] = [];
  const ids = new Set(elements.map((e) => e.element_id));
  const seen = new Map<string, string>();
  for (const e of elements) {
    const t = normalize(e.text);
    if (!t) problems.push(`${e.element_id} is empty`);
    else if (seen.has(t)) problems.push(`${e.element_id} repeats ${seen.get(t)} word for word`);
    else seen.set(t, e.element_id);
    if (e.parent_element_id && !ids.has(e.parent_element_id)) problems.push(`${e.element_id} sits under ${e.parent_element_id}, which doesn't exist`);
  }
  if (!elements.length) problems.push('the version has no elements');
  return problems.length
    ? { ok: false, note: `Structural review failed: ${problems.join('; ')}.` }
    : { ok: true, note: 'Structural review passed (non-empty, no duplicates, well-formed tree). Kolab checks structure only: contradictions and layer leaks are for its reviewers.' };
};

/** What a commit with no reviewer says (VER11). */
const NO_REVIEWER = (layer: Layer) =>
  `No one other than its author holds Write on the ${layer} layer, so these checks alone committed it, unreviewed (VER11).`;

const NEXT_STEP: Record<string, string> = {
  changed: 'Check whether this still holds against the new upstream text. If yes, konjir_clear_mark; if not, draft a new version that addresses it.',
  fuzzy_reanchor: 'The quoted span changed: its words were edited, or they now appear only without the prefix and suffix you quoted (a copy elsewhere). Re-read the target and either clear the mark or re-link, quoting the current words with their current context.',
  orphaned: 'The target no longer exists. Re-link to its replacement, or remove the dependency in a new draft.',
  upstream_dirty: 'Something this depends on is dirty. Wait for that mark to clear, or check it yourself and clear the upstream mark.',
  override_stale: 'The parent changed text you override. konjir_resolve_override with reaffirm, adopt_parent, or amend.',
  override_orphaned: 'The parent deleted text you override. konjir_resolve_override with reaffirm (keep as your own) or adopt_parent (drop it).',
  review_failed: 'The review gate rejected this version. Draft a version that resolves what the query names.',
  rebase_failed: 'Rebasing onto the new parent failed, for the reason the query gives. Commit a version that resolves it: on your current parent, and Kolab rebases it onto the new one; or with parent set to the parent\'s latest version. Or wait for the parent\'s next commit. The mark and its question settle once this variant sits on its parent\'s latest version.',
  role_boundary: 'The review gate thinks this crosses the layer boundary. A question went to the layer that owns the answer; the mark clears when it is answered. Meanwhile, work continues at risk.',
  query_answered: 'A question this element was waiting on has been answered. Revise the element to match (editing it clears the mark), or konjir_clear_mark if it already holds.',
};

/**
 * A version is live if no later committed version of its node exists. A
 * pending draft does not supersede it: the cascade must keep reaching the
 * committed version until the draft actually commits (then catch-up runs).
 */
function LIVE(alias: string) {
  return `not exists (select 1 from version later where later.node_id = ${alias}.node_id
            and later.seq > ${alias}.seq and later.state = 'committed')`;
}

function diff(parent: ElementRow[], next: (ElementInput & { id: string })[],
  parentVersionId: string | null): Omit<DeltaRow, 'id' | 'version_id'>[] {
  const byId = new Map(parent.map((e) => [e.element_id, e]));
  const out: Omit<DeltaRow, 'id' | 'version_id'>[] = [];
  next.forEach((e, ord) => {
    const id = e.id!;
    const p = byId.get(id);
    const base = { element_id: id, text: e.text, parent_element_id: e.parent ?? null, ord, state: 'clean' as const };
    if (!p) out.push({ ...base, kind: 'add', base_version_id: null, base_fingerprint: null });
    else if (p.fingerprint !== fingerprint(e.text) || p.parent_element_id !== (e.parent ?? null) || p.ord !== ord) {
      out.push({ ...base, kind: 'override', base_version_id: parentVersionId, base_fingerprint: p.fingerprint });
    }
  });
  const nextIds = new Set(next.map((e) => e.id));
  for (const p of parent) {
    if (!nextIds.has(p.element_id)) {
      out.push({ element_id: p.element_id, kind: 'remove', text: null, parent_element_id: p.parent_element_id,
        ord: null, base_version_id: parentVersionId, base_fingerprint: p.fingerprint, state: 'clean' });
    }
  }
  return out;
}

/** Parent elements overlaid by deltas. Dirty and orphaned overrides still apply. */
function materialize(parent: ElementRow[], deltas: Omit<DeltaRow, 'id' | 'version_id'>[]): ElementRow[] {
  const map = new Map(parent.map((e) => [e.element_id, { ...e }]));
  let maxOrd = parent.reduce((m, e) => Math.max(m, e.ord), -1);
  const removed = new Set<string>();
  for (const d of deltas) {
    if (d.kind === 'remove') { removed.add(d.element_id); continue; }
    const existing = map.get(d.element_id);
    const text = d.text ?? existing?.text ?? '';
    map.set(d.element_id, {
      element_id: d.element_id,
      parent_element_id: d.parent_element_id ?? existing?.parent_element_id ?? null,
      ord: d.ord ?? existing?.ord ?? ++maxOrd,
      text,
      fingerprint: fingerprint(text),
    });
  }
  // Removing an element removes its subtree.
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of map.values()) {
      if (e.parent_element_id && removed.has(e.parent_element_id) && !removed.has(e.element_id)) {
        removed.add(e.element_id); grew = true;
      }
    }
  }
  return [...map.values()].filter((e) => !removed.has(e.element_id)).sort((a, b) => a.ord - b.ord);
}

/**
 * The context a quote selector should record: whole words either side of [start, end), at least
 * three with a letter or digit and 16 characters (D42 needs two to agree), or all there is up to
 * the element's edge. A run of a script written without spaces gives its 32 nearest characters.
 */
function spanContext(text: string, start: number, end: number): { prefix?: string; suffix?: string } {
  const take = (words: string[]): string[] => {
    const out: string[] = [];
    let meaningful = 0;
    for (const w of words) {
      if (meaningful >= 3 && out.join(' ').length >= 16) break;
      const cps = [...w];
      if (cps.length > 32 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(w)) {
        out.push(cps.slice(0, 32).join(''));
        break;
      }
      out.push(w);
      if (/[\p{L}\p{N}]/u.test(w)) meaningful++;
    }
    return out;
  };
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end).trimStart();
  // The prefix is read away from the quote: its words last to first, each spelled backwards.
  const backwards = (w: string) => [...w].reverse().join('');
  const prefixWords = take(before ? before.split(' ').reverse().map(backwards) : []).map(backwards).reverse();
  const suffixWords = take(after ? after.split(' ') : []);
  const prefix = prefixWords.join(' ');
  const suffix = suffixWords.join(' ');
  return { ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
}

/** An element plus its descendants, in order. The scope an element address covers. */
function subtreeText(els: ElementRow[], rootId: string): string | undefined {
  if (!els.some((e) => e.element_id === rootId)) return undefined;
  const kids = new Map<string, ElementRow[]>();
  for (const e of els) {
    if (!e.parent_element_id) continue;
    (kids.get(e.parent_element_id) ?? kids.set(e.parent_element_id, []).get(e.parent_element_id)!).push(e);
  }
  const out: string[] = [];
  const walk = (id: string) => {
    const e = els.find((x) => x.element_id === id)!;
    out.push(normalize(e.text));
    for (const k of kids.get(id) ?? []) walk(k.element_id);
  };
  walk(rootId);
  return out.join('\n');
}

/**
 * Carry outbound edges from one version of a node to another. An edge whose
 * source element no longer exists is dropped. An edge the destination already
 * has (same kind, source element, target node, target scope) is not
 * duplicated. Open marks follow their edge either way.
 */
async function copyEdges(tx: Q, from: string, to: string, liveElements: Set<string>) {
  const out = await tx.query<EdgeRow>(`select * from edge where source_version_id = $1`, [from]);
  for (const e of out.rows) {
    if (e.source_element_id && !liveElements.has(e.source_element_id)) continue;
    const selector = e.target_selector ? JSON.stringify(e.target_selector) : null;
    const existing = await tx.query<{ id: string }>(
      `select d.id from edge d
         join version dt on dt.id = d.target_version_id
         join version et on et.id = $6
        where d.source_version_id = $1 and d.kind = $2
          and d.source_element_id is not distinct from $3
          and dt.node_id = et.node_id
          and d.target_element_id is not distinct from $4
          and d.target_selector is not distinct from $5::jsonb`,
      [to, e.kind, e.source_element_id, e.target_element_id, selector, e.target_version_id]);
    let nid = existing.rows[0]?.id;
    if (!nid) {
      nid = ulid();
      await tx.query(
        `insert into edge(id, kind, source_version_id, source_element_id, target_version_id,
                          target_element_id, target_selector, target_fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [nid, e.kind, to, e.source_element_id, e.target_version_id, e.target_element_id, selector, e.target_fingerprint]);
    }
    await tx.query(`update invalidation set edge_id = $2 where edge_id = $1 and state = 'open'`, [e.id, nid]);
  }
}

/** A node's name, by its id, read in `q` (inside a transaction, where `this.db` can't be used on PGlite). */
async function nameIn(q: Q, nodeId: string): Promise<string> {
  return (await q.query<{ name: string }>(`select name from node where id = $1`, [nodeId])).rows[0].name;
}

/**
 * The node's next version number. Call it only in a transaction that holds the node's lock
 * (inTransaction's `lock`), which keeps two writers from taking the same number.
 */
async function nextSeq(tx: Q, nodeId: string): Promise<number> {
  const r = await tx.query<{ n: number }>(`select coalesce(max(seq), 0) + 1 as n from version where node_id = $1`, [nodeId]);
  return r.rows[0].n;
}

/** A node: `name` is how addresses name it, unique in its kolab; `id` is Kolab's own key for it. */
export interface NodeRow { id: string; name: string; kind: Kind; layer: Layer; title: string; kolab_id: string }

/**
 * Where an address is read: in a session, which reads its own kolab and any other it holds Read
 * on, as kj_agent under row-level security; or `system`, Kolab's own reads, on its login with no
 * access checked, where the short form names a node in that kolab. Never give `system` for
 * anything a session asked for.
 */
export type Where = { session: string } | { system: string };

/** An open session: its actor, role and kolab, and the actor's access there now. */
interface Session {
  actor_id: string; active_role: Role; kolab: string; kind: ActorKind; owner: string | null; access: Access;
}

/** Ends, in `tx`, every open session that can no longer reach its kolab. Returns how many. */
async function endUnreachableIn(tx: Q, signal: Signal): Promise<number> {
  const r = await tx.query<{ id: string }>(
    `update session s set ended_at = now()
      where s.ended_at is null and (select a.rank from kj_access(s.actor_id, s.kolab_id) a) = 0
     returning s.id`);
  for (const { id } of r.rows) await signal({ session: 'ended', id: sessionKey(id) });
  return r.rows.length;
}

/** An actor's access to a kolab, from kj_access: the database is the one place it is computed. */
async function accessIn(q: Q, actorId: string, kolab: string): Promise<Access> {
  const r = (await q.query<{ rank: number; functional: boolean; technical: boolean }>(
    `select rank, functional, technical from kj_access($1, $2)`, [actorId, kolab])).rows[0];
  return toAccess(r);
}

function toAccess(r: { rank: number; functional: boolean; technical: boolean } | undefined): Access {
  if (!r || r.rank < 1) return { level: null, layers: [] };
  return { level: ACCESS_LEVELS[r.rank - 1], layers: LAYERS.filter((l) => (l === 'functional' ? r.functional : r.technical)) };
}

/**
 * What an agent's owner holds in a kolab: a user's own access; an organization holds all of
 * its own kolabs and nothing of anyone else's (as kj_access computes it).
 */
async function ownerAccess(q: Q, owner: string, kolab: string): Promise<Access> {
  const r = (await q.query<{ kind: string; owns: boolean }>(
    `select a.kind, exists (select 1 from kolab k where k.id = $2 and k.owner_id = a.id) as owns from account a where a.id = $1`,
    [owner, kolab])).rows[0];
  if (r?.kind === 'user') return accessIn(q, owner, kolab);
  return r?.owns ? { level: 'admin', layers: [...LAYERS] } : { level: null, layers: [] };
}

/** "Write on the functional layer", "Read", "no access". */
function describeAccess(a: Access): string {
  if (!a.level) return 'no access';
  const level = a.level[0].toUpperCase() + a.level.slice(1);
  if (a.level !== 'write') return level;
  return a.layers.length === 2 ? `${level} on both layers` : a.layers.length ? `${level} on the ${a.layers[0]} layer` : `${level} on no layer`;
}

/** Whether a commit step refused the version, because its author can no longer write its layer. */
const isRefused = (x: unknown): x is { refused: string } => typeof x === 'object' && x !== null && 'refused' in x;

/** A version committed since another's base: it overtook that one. */
type Overtaker = { id: string; active_role: string };

/**
 * The node's versions committed since `v`'s base, oldest first, or undefined if its base is still the
 * live version. Committed versions only ever commit on the live version, so their seqs rise in
 * commit order, and anything committed above the base's seq came after it.
 */
async function overtakenBy(q: Q, v: VersionRow): Promise<Overtaker[] | undefined> {
  const r = await q.query<Overtaker>(
    `select id, active_role from version
      where node_id = $1 and state = 'committed' and id <> $3
        and seq > coalesce((select seq from version where id = $2), 0)
      order by seq`, [v.node_id, v.base_version_id, v.id]);
  return r.rows.length ? r.rows : undefined;
}

async function writeVersion(tx: Q, v: Omit<VersionRow, 'state'>, els: ElementRow[],
  deltas: Omit<DeltaRow, 'id' | 'version_id'>[]) {
  await tx.query(
    `insert into version(id, node_id, seq, parent_version_id, base_version_id, layer, state, actor_id, active_role)
     values ($1,$2,$3,$4,$5,$6,'drafted',$7,$8)`,
    [v.id, v.node_id, v.seq, v.parent_version_id, v.base_version_id, v.layer, v.actor_id, v.active_role]);
  for (const e of els) {
    await tx.query(
      `insert into element(version_id, element_id, parent_element_id, ord, text, fingerprint)
       values ($1,$2,$3,$4,$5,$6)`,
      [v.id, e.element_id, e.parent_element_id, e.ord, e.text, e.fingerprint]);
  }
  for (const d of deltas) {
    await tx.query(
      `insert into delta(id, version_id, element_id, kind, text, parent_element_id, ord,
                         base_version_id, base_fingerprint, state)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ulid(), v.id, d.element_id, d.kind, d.text, d.parent_element_id, d.ord,
        d.base_version_id, d.base_fingerprint, d.state]);
  }
}

/** Resolves a scope (whole version, element subtree, or span) within a version's elements. */
function resolveInElements(els: ElementRow[], elementId: string | null, selector: QuoteSelector | null): Resolution {
  if (!elementId) {
    const content = els.map((e) => `${e.element_id}:${e.parent_element_id ?? ''}:${e.fingerprint}`).join('\n');
    return { status: 'ok', content, fingerprint: fingerprint(content) };
  }
  const subtree = subtreeText(els, elementId);
  if (subtree === undefined) return { status: 'orphan' };
  if (!selector) return { status: 'ok', content: subtree, fingerprint: fingerprint(subtree) };
  const span = resolveSpan(subtree, selector);
  if (span.status === 'orphan') return { status: 'orphan' };
  return {
    status: span.status === 'exact' ? 'ok' : 'fuzzy',
    content: span.content,
    fingerprint: fingerprint(span.content),
  };
}
