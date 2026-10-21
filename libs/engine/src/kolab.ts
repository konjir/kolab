import { createHash, randomBytes } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { monotonicFactory, ulid } from 'ulid';
import {
  type Address, type QuoteSelector, fingerprint, formatAddress, isKolabName, isNodeName, MAX_QUOTE, normalize, parseAddress,
  parseNodeRef, resolveSpan,
} from '@konjir/address';
import { migrate, openDb, type Db, type Listening } from '@konjir/db';
import {
  ACCESS_LEVELS, FINDING_KINDS, INVITE_LEVELS, isInboxEvent, LAYERS, LAYER_OF_KIND, LAYER_OF_ROLE, ORG_ROLES, PLAN_KINDS, POSITION_VERDICTS, ROLES, RULING_EFFECTS, VISIBILITIES,
  type OutboxKind, type OutboxState,
  type CaseFileState, type CaseFileView, type PositionVerdict, type RulingEffect, type RulingView,
  type Access, type AccessHolder, type AccessLevel, type AccessSource, type KolabAccessView, type InviteLevel, type InvitePreview, type InviteView, type Actor, type ActorKind, type Archivable, type ArchiveTarget, type Author, type KolabRow, type OrgRole, type Visibility,
  type DeltaInput, type DeltaKind, type EdgeKind, type ElementInput, type LinkRef, type ElementRow, type Finding, type GateResult, type Kind, type KolabEvent, type Layer,
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
  /** The edge's own kolab, its source's, and its target's, which may be another (LNK8). */
  kolab_id: string; target_kolab_id: string;
  /** Who declared the link, or last vouched for it: across kolabs, whose Read it rests on. */
  held_by: string | null;
}

/**
 * What a link is, apart from the versions it joins: the identity copyEdges carries forward by, and
 * a link_removal row records (0012). `carried` says whether the version the draft was built on
 * has such a link, which its commit would otherwise carry forward.
 */
interface LinkIdentity {
  kind: string; source_element_id: string | null; target_node_id: string;
  target_element_id: string | null; target_selector: QuoteSelector | null; carried: boolean;
}

/** Matches a link_removal row `r` against an edge `e` whose target version is `t`. */
const REMOVES = (r: string, e: string, t: string) =>
  `${r}.kind = ${e}.kind and ${r}.source_element_id is not distinct from ${e}.source_element_id
   and ${r}.target_node_id = ${t}.node_id and ${r}.target_element_id is not distinct from ${e}.target_element_id
   and ${r}.target_selector is not distinct from ${e}.target_selector`;

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

/**
 * An OAuth request refused (D55), with the error code RFC 6749 gives it (`invalid_grant`,
 * `invalid_request`, `access_denied`, `invalid_redirect_uri`, …), which the authorization server
 * answers with.
 */
export class OAuthGrantError extends Error {
  name = 'OAuthGrantError';
  constructor(readonly code: string, message: string) { super(message); }
}

/** A client registered with Kolab's authorization server (RFC 7591): public, with no secret. */
export interface OAuthClient { id: string; name: string; redirectUris: string[] }

/** An authorization waiting for its person to sign in, or to consent. */
export interface PendingAuthorization {
  clientId: string; redirectUri: string; clientState: string | null; scope: string | null; provider: string;
  /** The person, once the identity provider has said who signed in. */
  person: string | null;
  /** The key of the invite the web interface's sign-in carries (W3.4), if any; never a registered client's. */
  inviteKey: string | null;
}

/**
 * What a person consents to: who the client acts as, in which kolab (or a new one of theirs, or the
 * one the sign-in's invite names, W3.4), in which role.
 */
export interface ConsentChoice {
  as: { kind: 'self' } | { kind: 'agent'; agent: string } | { kind: 'new-agent'; label: string };
  kolab: string | { name: string; title: string } | { invite: true };
  role: Role;
}

/** What the token endpoint hands a client: the secrets, shown once, and the session they reach. */
export interface OAuthTokens {
  accessToken: string; refreshToken: string; expiresIn: number; scope: string;
  /** The session's id, its key. */
  session: string; actor: string; kolab: string; role: Role;
}

/** An identity provider's name, as the identity table holds it. */
const IDP_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A provider's id for a person: GitHub's is a number. */
const IDP_SUBJECT = /^[A-Za-z0-9._@|:-]{1,200}$/;
/** A PKCE S256 challenge (RFC 7636 §4.2): the base64url sha256 of the verifier. */
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** A PKCE verifier (RFC 7636 §4.1). */
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** The scope a grant carries: Konjir's, with the kolab and role its session works in. */
export const grantedScope = (kolab: string, role: Role) => `konjir kolab:${kolab} role:${role}`;

/** Words no one signs up as, beside Kolab's own actor and anything starting `konjir` (D55). */
const RESERVED_PERSON_NAMES = new Set(['kolab', 'admin', 'administrator', 'root', 'system', 'superuser', 'support', 'security', 'staff', 'owner', 'agent', 'anonymous', 'nobody', 'null', 'undefined']);

/**
 * Names a person may not sign up as (D55): Kolab's own actor, the words an admin or Kolab itself
 * would be taken for, and anything starting `konjir`, as for kolab names (D15, D54).
 */
export const isReservedPersonName = (name: string) => RESERVED_PERSON_NAMES.has(name.toLowerCase()) || name.toLowerCase().startsWith('konjir');

/**
 * The names a new person signing up as `login` tries, in order: the login, lowercased, then
 * `<login>_2` to `<login>_20`, then one with a random suffix. A GitHub login never holds '_', so
 * no variant is ever another GitHub user's own login. A reserved name tries `gh_<login>` instead,
 * and so does one `agentLike` says reads as someone's agent, `<person>-<label>` (D30).
 */
export function* signUpNames(login: string, agentLike: (name: string) => boolean = () => false): Generator<string> {
  const base = login.toLowerCase().replace(/[^a-z0-9.@-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 39) || 'person';
  const root = isReservedPersonName(base) || agentLike(base) ? `gh_${base}` : base;
  if (!isReservedPersonName(root)) yield root;
  for (let i = 2; i <= 20; i++) yield `${root}_${i}`;
  yield `${root}_${randomBytes(4).toString('hex')}`;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * A host a redirect URI may name: a DNS hostname (labels of letters, digits and hyphens, neither
 * starting nor ending with one, at most 63 each and 253 in all, as the URL parser leaves it:
 * lowercased, an IDN in punycode), an IPv4 address, or an IPv6 literal in brackets. So it can be
 * written as a CSP source on the consent page (formActionSource), but for an IPv6 literal, which
 * CSP can't name. `a_b` or `a;b`, which the URL parser lets through, are refused.
 */
export function validRedirectHost(host: string): boolean {
  if (/^\[[0-9a-f:.]+\]$/.test(host)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.').every((o) => Number(o) <= 255);
  return host.length <= 253 && host.split('.').every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * Whether Kolab may send codes to `uri` (OAuth 2.1 §2.3.1, RFC 8252): an https URL, or http on a
 * loopback address, on a host validRedirectHost allows. Never a fragment or credentials (written as `#`, `user@` or `user:pass@`, even
 * empty), and no other scheme: no app's own scheme, and never javascript:, data:, file: and the like.
 */
export function validRedirectUri(uri: string): boolean {
  if (typeof uri !== 'string' || uri.length > 2000 || uri.includes('#')) return false;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.username || u.password || /^[a-z]+:\/\/[^/?]*@/i.test(uri)) return false;
  if (u.protocol === 'https:') return !!u.hostname && validRedirectHost(u.hostname);
  if (u.protocol === 'http:') return LOOPBACK_HOSTS.has(u.hostname);
  return false;
}

/**
 * Whether a redirect URI that validRedirectUri refused would pass but for a trailing dot on its
 * host (`https://example.com./cb`, a fully qualified name), so its refusal can say so.
 */
function trailingDotHost(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (!u.hostname.endsWith('.')) return false;
  u.hostname = u.hostname.replace(/\.+$/, '');
  return validRedirectUri(u.href);
}

/**
 * Whether a redirect URI given at authorization matches one a client registered: a valid one
 * (validRedirectUri: no fragment or credentials), exactly, but for the port of a loopback http
 * URI, which a native client picks when it runs (RFC 8252 §7.3).
 */
export function redirectUriMatches(registered: string[], given: string): boolean {
  if (!validRedirectUri(given)) return false;
  if (registered.includes(given)) return true;
  let g: URL;
  try { g = new URL(given); } catch { return false; }
  if (g.protocol !== 'http:' || !LOOPBACK_HOSTS.has(g.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
    } catch { return false; }
  });
}
/**
 * A name another kolab, account or actor holds. The message is the same whether that one is live
 * or archived, so whoever asked learns only that the name is taken; `archived` names the archived
 * holder, for the admin token's verbs to say so (D52).
 */
export class NameTakenError extends TenancyError {
  constructor(message: string, readonly archived?: { kind: Archivable; id: string }, name: 'TenancyError' | 'ActorError' = 'TenancyError') {
    super(message);
    this.name = name;
  }
}

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
 * catch-up) stopped part way, on an error this names. The commit stands, and so does the
 * cascade's after_commit job in the outbox (W1.8): the worker runs it again after a backoff, and
 * the node's later cascades wait for it, in commit order.
 */
export class CascadeError extends Error { name = 'CascadeError'; }

/**
 * A session's key: the sha256 of its bearer token, base64url. It is the session's id in the
 * database, which stores no token (P1, migration 0011), and how events, logs and whoami name the
 * session. The token itself is shown once, when the session opens, and never leaves the process
 * after that: events cross processes (W2.2) and can reach logs.
 */
/** Kolab names kept for Konjir's own kolabs (D15, D54): `kolab`, and anything starting `konjir`. */
export const isReservedKolabName = (name: string) => name === 'kolab' || name.startsWith('konjir');

export const sessionKey = (id: string) => createHash('sha256').update(id).digest('base64url');

/** A sessionKey's form: 43 base64url characters. A token is `kjs_` and 32, so the two never look alike. */
export const SESSION_KEY = /^[A-Za-z0-9_-]{43}$/;

/** An invite's secret (W3.4): `kji_` and 32 random bytes, base64url. Kolab stores only its sessionKey. */
export const INVITE_TOKEN = /^kji_[A-Za-z0-9_-]{43}$/;

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
 * `work` says a job in the outbox is free for any process's worker to take (REV3, W1.8).
 */
type Notice = { from: string; event: KolabEvent } | { from: string; resync: true } | { from: string; work: true };

/**
 * An inbox event as it goes over EVENT_CHANNEL (D50): its kolab rides on the notice, beside an
 * `event` in the shape a release before D50 reads, which ignores a field it doesn't know on a
 * notice (W1.8) but would drop an event with one. So during a rolling deploy an older process
 * still hears a newer one's changes, and signals them as it always has.
 */
type WireNotice = { from: string; kolab?: string; event: Record<string, unknown> } | { from: string; resync: true } | { from: string; work: true };

/** A Notice as it is written to EVENT_CHANNEL. */
function wireOf(n: Notice): WireNotice {
  if (!('event' in n) || !isInboxEvent(n.event)) return n;
  const { kolab, ...event } = n.event;
  return { from: n.from, kolab, event };
}

/**
 * What a Kolab's listener goes through after `listen` (API5): its connection is lost; it is back
 * and every subscriber has been told to re-read (`restored`); or it is back but telling them
 * failed, and is retried in `retryInMs` (`error` is fit to log).
 */
export type ListenerState =
  | { state: 'lost' }
  | { state: 'restored' }
  | { state: 'resync_failed'; retryInMs: number; error: string };

/**
 * The patterns of Kolab's secrets: a session's bearer token (an OAuth access token is one too),
 * a refresh token and an authorization code (D55), and an invite (W3.4).
 */
const SECRETS = /(kj[srci])_[A-Za-z0-9_-]+/g;

/** An error's message, fit to log: any session token, refresh token or code in it is masked. */
export function maskTokens(e: unknown): string {
  return String((e as { message?: unknown })?.message ?? e).replace(SECRETS, '$1_***');
}

/**
 * The open session a bearer token reaches now, as the database's kj_session_id finds it (0018),
 * on `session s`, with the token's sessionKey as `$1`. A grant's session (D55) is reached by its
 * current access token, only until that token expires; a hand-issued session by its id, which is
 * its token's key (P1), and it never expires.
 */
const LIVE_SESSION = `s.ended_at is null and (s.token_key = $1 or (s.token_key is null and s.id = $1))
       and (s.expires_at is null or s.expires_at > now())`;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

const hasKeys = (x: Record<string, unknown>, ...keys: string[]) =>
  Object.keys(x).length === keys.length && keys.every((k) => k in x);

/**
 * Whether `x` is exactly a KolabEvent Kolab could have sent: its fields and no others. Each
 * new kind of event adds its check here.
 */
export function isKolabEvent(x: unknown): x is KolabEvent {
  if (!isObject(x)) return false;
  // An inbox event names its kolab (D50): a kolab's name, never an id or a token.
  if ('inbox' in x && !(typeof x.kolab === 'string' && isKolabName(x.kolab))) return false;
  if (x.inbox === 'layer') return hasKeys(x, 'inbox', 'kolab', 'layer') && LAYERS.includes(x.layer as Layer);
  if (x.inbox === 'actor') return hasKeys(x, 'inbox', 'kolab', 'actor') && typeof x.actor === 'string' && ACTOR_ID.test(x.actor);
  // A session's sessionKey: a sha256, base64url, never the token itself.
  if (x.session === 'ended') return hasKeys(x, 'session', 'id') && typeof x.id === 'string' && SESSION_KEY.test(x.id);
  return false;
}

/**
 * What a notification on EVENT_CHANNEL is: a Notice, a notice of a kind a later release sends
 * (`from`, no `event`, and one flag set to true, such as `work` is to a release before W1.8),
 * which this release ignores, or anything else, which it drops. Fields a later release adds to a
 * notice it knows are ignored too; a notice carrying an `event` must carry a valid one.
 *
 * An inbox event's kolab is the notice's `kolab` (WireNotice). One without it comes from a
 * release before D50, during a rolling deploy, and can't say which kolab changed: it is heard as
 * a resync, which tells every subscriber to re-read, rather than as that layer's change in every
 * kolab or in none.
 */
function noticeOf(x: unknown): Notice | 'later' | undefined {
  if (!isObject(x) || typeof x.from !== 'string') return undefined;
  if ('event' in x) {
    const e = x.event;
    if (isObject(e) && 'inbox' in e) {
      if ('kolab' in e) return undefined;   // the kolab rides on the notice, never in the event
      // A valid event but for its kolab, which a release before D50 doesn't send.
      if (!('kolab' in x)) return isKolabEvent({ ...e, kolab: 'k' }) ? { from: x.from, resync: true } : undefined;
      const event = { ...e, kolab: x.kolab };
      return isKolabEvent(event) ? { from: x.from, event } : undefined;
    }
    return isKolabEvent(e) ? { from: x.from, event: e } : undefined;
  }
  if (x.resync === true) return { from: x.from, resync: true };
  if (x.work === true) return { from: x.from, work: true };
  return Object.entries(x).some(([k, v]) => k !== 'from' && /^[a-z_]+$/.test(k) && v === true) ? 'later' : undefined;
}

// ---------------------------------------------------------------------------
// Kolab
// ---------------------------------------------------------------------------

/** A job in the outbox (REV3, W1.8): work a committed change still owes, until it is done. */
interface OutboxJob {
  id: string; kind: OutboxKind; version_id: string; claim: string;
  payload: { approvedBy?: string; ruling?: string; onto?: string; node?: string } | null; attempts: number;
}

/**
 * This process's claim on an outbox job while it runs the job's work. `check` throws once the
 * claim is lost (its lease lapsed, or another process took the job), so the work stops at its next
 * step rather than carry on beside another process's run.
 */
interface Claim { token: string; lost: boolean; check(): void }

/** Thrown at a step of a job's work when this process has lost its claim on the job. */
class ClaimLost extends Error { name = 'ClaimLost'; }

/**
 * Thrown by an after_commit job whose node still owes the cascade of an earlier version: it waits,
 * and runs once that one is done (a node's cascades run in commit order).
 */
class Deferred extends Error { name = 'Deferred'; }

/** How long a resync heard over the channel waits for others to fold into it. */
const RESYNC_DEBOUNCE_MS = 250;
/** How long a process's claim on an outbox job lasts unless renewed, by default. */
const OUTBOX_LEASE_MS = 30_000;
/** How often an idle worker looks for due jobs, by default, besides when it is told of one. */
const OUTBOX_POLL_MS = 5_000;
/** The longest a failed job waits before it is tried again. */
const OUTBOX_MAX_BACKOFF_S = 300;
/** A job that has failed this many times is dead: it waits for an admin to retry it. */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** How long close() waits, by default, for the outbox work this process is running. */
const CLOSE_WAIT_MS = 10_000;

/**
 * PGlite data directories open in this process, by how many Kolabs hold each. A PGlite directory is
 * one process's, so when the first Kolab opens one, any claim on its outbox is a stopped process's.
 */
const openDataDirs = new Map<string, number>();

/** One row of the outbox, as an admin reads it (konjir_admin_outbox). */
export interface OutboxJobView {
  id: string; kind: OutboxKind; state: OutboxState; subject: string; attempts: number;
  claimed_by: string | null; run_after: string; last_error: string | null; created_at: string;
  /** A rebase job's: the parent version whose commit queued it (the variant rebases onto its parent's latest when it runs). */
  after?: string;
}

/** A variant's queued rebase, as readNode shows it (D43, P6). */
export interface PendingRebase {
  state: OutboxState; attempts: number; queued_at: string;
  /** The parent version whose commit queued it; the rebase is onto the parent's latest when it runs. */
  after?: string;
  last_error?: string;
}

export class Kolab {
  private constructor(readonly db: Db, private submissionChecks: Checks, private checks: Checks,
    private readonly leaseMs: number, private readonly closeWaitMs: number, private readonly dataDir?: string) {}

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
  static async open(opts: {
    submissionChecks?: Checks; checks?: Checks; dataDir?: string; databaseUrl?: string;
    /** How long this process's claim on an outbox job lasts unless renewed (30 s by default). */
    outboxLeaseMs?: number;
    /** How long close() waits for outbox work this process is running (10 s by default). */
    closeWaitMs?: number;
  } = {}): Promise<Kolab> {
    const db = openDb(opts);
    const dataDir = !opts.databaseUrl && opts.dataDir ? resolvePath(opts.dataDir) : undefined;
    try {
      await migrate(db);
      // A PGlite directory is one process's: when no Kolab in this process holds it, any claim on
      // a job is a stopped process's, and is freed now rather than when its lease lapses.
      if (dataDir && !openDataDirs.get(dataDir)) {
        await db.query(`update outbox set claim = null, claimed_by = null, claimed_until = null where claim is not null`);
      }
    } catch (e) {
      await db.close().catch(() => undefined);
      throw e;
    }
    if (dataDir) openDataDirs.set(dataDir, (openDataDirs.get(dataDir) ?? 0) + 1);
    return new Kolab(db, opts.submissionChecks ?? structuralChecks, opts.checks ?? structuralChecks,
      opts.outboxLeaseMs ?? OUTBOX_LEASE_MS, opts.closeWaitMs ?? CLOSE_WAIT_MS, dataDir);
  }

  /**
   * Stops this Kolab's worker, waits up to closeWaitMs for the outbox work this process is
   * running, then frees the jobs it still holds, telling other processes' workers, and closes the
   * database. Work that hadn't finished stops part way, and is run again in full by whichever
   * process takes its job: every job's work is idempotent.
   */
  async close() {
    if (!this.closed && !this.stopping) {
      this.stopping = true;
      clearTimeout(this.worker?.timer);
      const running = [...this.running];
      if (running.length && this.closeWaitMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(running),
          new Promise((r) => { timer = setTimeout(r, this.closeWaitMs); timer.unref(); }),
        ]);
        clearTimeout(timer);
      }
      await this.freeClaims().catch(() => undefined);
      if (this.dataDir) {
        const n = (openDataDirs.get(this.dataDir) ?? 1) - 1;
        if (n > 0) openDataDirs.set(this.dataDir, n); else openDataDirs.delete(this.dataDir);
      }
    }
    this.closed = true;
    clearTimeout(this.worker?.timer);
    clearTimeout(this.resyncPending);
    for (const c of this.claims.values()) c.stop();
    this.claims.clear();
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
    const n = noticeOf(p);
    if (n === 'later') return;   // a kind of notice from a later release
    if (!n) return this.dropped('isn\'t a Kolab event');
    if (n.from === this.origin) return; // told our own listeners when it committed
    if ('work' in n) return this.wake();
    if ('resync' in n) this.resyncSoon();
    else this.dispatch(n.event);
  }

  /** A resync heard over the channel and not yet run: a burst of them costs one. */
  private resyncPending?: ReturnType<typeof setTimeout>;

  /**
   * Resync once, RESYNC_DEBOUNCE_MS after the first of a burst of resync notices: during a rolling
   * deploy, every inbox event from a release before D50 is heard as one, and each costs every
   * subscriber a re-read.
   */
  private resyncSoon() {
    if (this.resyncPending || this.closed) return;
    this.resyncPending = setTimeout(() => {
      this.resyncPending = undefined;
      if (this.closed) return;
      void this.resync().catch((e) => console.error(`kolab: could not resync after a resync notice: ${maskTokens(e)}`));
    }, RESYNC_DEBOUNCE_MS);
    this.resyncPending.unref();
  }

  private dropped(why: string) {
    this.dropCount++;
    console.error(`kolab: dropped a notification on ${EVENT_CHANNEL} that ${why} (${this.dropCount} so far)`);
  }

  /**
   * Tells this Kolab's listeners that everything a subscriber could hold may have changed: for
   * a change too big to name, or after missing changes while the listener reconnected. That is,
   * in each kolab with an open session, every layer's inbox and the answers of each actor with an
   * open session there, since only an open session can subscribe to them, and only to its own
   * kolab's (an ended one's streams are closed before the next signal). The admin token, which may
   * listen to any kolab's, isn't covered: a kolab with no open session gets no resync, so an admin
   * stream on it hears what changed meanwhile only at that kolab's next change. One query, before
   * anything is signalled, so a failure signals nothing and the whole resync can be retried.
   * Each subscriber re-reads; an inbox that didn't change reads the same.
   */
  private async resync() {
    const r = await this.db.query<{ kolab: string; actor: string }>(
      `select distinct kolab_id as kolab, actor_id as actor from session where ended_at is null order by kolab_id, actor_id`);
    for (const kolab of new Set(r.rows.map((x) => x.kolab))) {
      for (const layer of LAYERS) this.dispatch({ inbox: 'layer', kolab, layer });
    }
    for (const { kolab, actor } of r.rows) this.dispatch({ inbox: 'actor', kolab, actor });
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
  private async inTransaction<T>(fn: (tx: Db, signal: Signal) => Promise<T>, lock?: string, opts: { access?: boolean } = {}): Promise<T> {
    let events = new Map<string, KolabEvent>();
    const result = await this.db.transaction(async (tx) => {
      // With `access`, a shared hold on the access lock first, then the node's lock: every
      // transaction that takes both takes them in that order, and a change of access (which holds
      // the access lock alone, exclusively) can't land between a check of access and what it allows.
      if (opts.access) await tx.query(`select pg_advisory_xact_lock_shared($1)`, [ACCESS_LOCK]);
      if (lock) await tx.query(`select 1 from node where id = $1 for no key update`, [lock]);
      // Each attempt starts empty, so a transaction ever run again would notify again.
      const sent = events = new Map<string, KolabEvent>();
      return fn(tx, async (event) => {
        const key = JSON.stringify(event);
        if (sent.has(key)) return; // Postgres folds a repeated notification in one transaction too
        sent.set(key, event);
        const notice: Notice = { from: this.origin, event };
        await tx.notify(EVENT_CHANNEL, JSON.stringify(wireOf(notice)), () => JSON.stringify({ from: this.origin, resync: true } satisfies Notice));
      });
    });
    for (const e of events.values()) this.dispatch(e);
    return result;
  }

  /** Signals the inbox of a version's layer. */
  private async signalLayerOf(tx: Q, signal: Signal, versionId: string) {
    const r = await tx.query<{ layer: Layer; kolab_id: string }>(`select layer, kolab_id from version where id = $1`, [versionId]);
    if (!r.rows[0]) throw new Error(`no version ${versionId}`);
    await signal({ inbox: 'layer', kolab: r.rows[0].kolab_id, layer: r.rows[0].layer });
  }

  /** Agent writes run as kj_agent; row-level security re-checks the layer. `lock` as for inTransaction. */
  private asAgent<T>(sessionId: string, fn: (tx: Q, signal: Signal) => Promise<T>, lock?: string, opts: { access?: boolean } = {}): Promise<T> {
    return this.inTransaction(async (tx, signal) => {
      await tx.exec('set local role kj_agent');
      // The session's key, never its token, which never reaches the database (P1).
      await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(sessionId)]);
      return fn(tx, signal);
    }, lock, opts);
  }

  /** Kolab's own work: rebases, review transitions, the cascade. `lock` as for inTransaction. */
  private asSystem<T>(fn: (tx: Db, signal: Signal) => Promise<T>, lock?: string, opts: { access?: boolean } = {}): Promise<T> {
    return this.inTransaction(async (tx, signal) => {
      await tx.exec('set local role kj_system');
      return fn(tx, signal);
    }, lock, opts);
  }

  // ---- the outbox: durable waits (REV3, W1.8) --------------------------------

  /** Whether close() has begun: no new claims are taken, and the worker stops. */
  private stopping = false;
  /** The outbox work this process is running, which close() waits for. */
  private running = new Set<Promise<unknown>>();
  /** This process's claims, by token, each renewed while its work runs. */
  private claims = new Map<string, Claim & { kind: OutboxKind; versionId: string; stop(): void }>();
  /** Claims this process took as it wrote their jobs, by kind and version, until it runs them. */
  private written = new Map<string, string>();

  /** The lease a claim taken or renewed now gets, in SQL, from the clock (not the transaction's start). */
  private get leaseUntil() { return `clock_timestamp() + ${Math.max(1, Math.floor(this.leaseMs))} * interval '1 millisecond'`; }

  /**
   * Writes a job into the outbox, in `tx`, the transaction whose change owes the work: the job
   * exists if and only if that change commits. This process claims it as it writes it, since it
   * runs the work at once (runClaimed); if it stops first, the claim lapses and any process's
   * worker takes the job. A second job of the same kind for the same version adds nothing.
   */
  private async enqueue(tx: Q, kind: OutboxKind, versionId: string, payload?: OutboxJob['payload']) {
    const token = ulid();
    const r = await tx.query(
      `insert into outbox(id, kind, version_id, payload, attempts, claim, claimed_by, claimed_until)
       values ($1, $2, $3, $4, 1, $5, $6, ${this.leaseUntil})
       on conflict (kind, version_id) do nothing returning id`,
      [outboxId(), kind, versionId, payload && Object.keys(payload).length ? JSON.stringify(payload) : null, token, this.origin]);
    if (r.rows.length) this.written.set(`${kind}:${versionId}`, token);
  }

  /**
   * Runs the work that a job of this kind for this version owes, now, in the caller's call, under
   * this process's claim: the one it took as it wrote the job, or one it takes now if no live
   * process holds the job. The commit's caller still sees its cascade finish or fail. Returns
   * whether the work ran: not if another process holds the job, or if an after_commit job waits
   * for an earlier version's cascade on its node (it runs once that one is done).
   */
  private async runClaimed<T>(kind: OutboxKind, versionId: string, work: (claim: Claim) => Promise<T>):
    Promise<{ ran: true; result: T } | { ran: false }> {
    const key = `${kind}:${versionId}`;
    let token = this.written.get(key);
    this.written.delete(key);
    token ??= (await this.db.query<{ claim: string }>(
      `update outbox set claim = $3, claimed_by = $4, claimed_until = ${this.leaseUntil}, attempts = attempts + 1
        where kind = $1 and version_id = $2 and state = 'pending'
          and (claimed_until is null or claimed_until < clock_timestamp())
          and (claim is null or not (claim = any($5::text[]))) returning claim`,
      [kind, versionId, ulid(), this.origin, this.ownTokens()])).rows[0]?.claim;
    if (!token) return { ran: false };
    const outcome = await this.runToken({ token, kind, versionId }, work);
    if (outcome.state === 'failed') throw outcome.error;
    return outcome.state === 'done' ? { ran: true, result: outcome.result } : { ran: false };
  }

  /**
   * Runs a job's work under the claim `token`: renewed while it runs, deleted when the work is
   * done (then the next of its node's cascades runs), released if it is deferred, and on failure
   * freed to retry after a backoff, or dead after OUTBOX_MAX_ATTEMPTS. Every change to the job's
   * row matches the token, so a process whose claim lapsed and was taken by another touches
   * nothing.
   */
  private async runToken<T>(job: { token: string; kind: OutboxKind; versionId: string }, work: (claim: Claim) => Promise<T>):
    Promise<{ state: 'done'; result: T } | { state: 'deferred' | 'lost' } | { state: 'failed'; error: unknown }> {
    const claim = this.hold(job);
    const run = (async () => {
      try {
        const result = await work(claim);
        if (claim.lost) return { state: 'lost' as const };
        await this.finish(job);
        return { state: 'done' as const, result };
      } catch (error) {
        if (claim.lost || error instanceof ClaimLost) {
          console.error(`kolab: lost the claim on outbox job ${job.kind} for version ${job.versionId} while running it; another process runs it again`);
          return { state: 'lost' as const };
        }
        if (error instanceof Deferred) {
          // Run after all, if what it waited for finished meanwhile (release).
          if (await this.release(job).catch(() => false)) return { state: 'done' as const, result: undefined as T };
          return { state: 'deferred' as const };
        }
        await this.fail(job, error).catch(() => undefined);
        return { state: 'failed' as const, error };
      } finally {
        claim.stop();
      }
    })();
    this.running.add(run);
    try { return await run; } finally { this.running.delete(run); }
  }

  /**
   * Releases a job deferred behind an earlier cascade of its node, telling every process's worker
   * in the same transaction. The earlier one may have finished meanwhile, while this process still
   * held this one, so that its finisher couldn't run it: if nothing earlier is left, it runs now.
   * Returns whether it has run.
   */
  private async release(job: { token: string; kind: OutboxKind; versionId: string }): Promise<boolean> {
    await this.inTransaction(async (tx) => {
      await tx.query(`update outbox set claim = null, claimed_by = null, claimed_until = null, attempts = greatest(attempts - 1, 0) where claim = $1`, [job.token]);
      await this.notifyWork(tx);
    });
    const node = (await this.db.query<{ node_id: string }>(`select node_id from version where id = $1`, [job.versionId])).rows[0]?.node_id;
    if (node) await this.drainNode(node);
    return !(await this.db.query(`select 1 from outbox where kind = $1 and version_id = $2`, [job.kind, job.versionId])).rows.length;
  }

  /**
   * Holds a claim while its work runs: renews it every third of the lease, on PGlite too, so only
   * a stopped process's claim lapses. A renewal that finds the claim gone, or that fails for a
   * whole lease, marks it lost, and logs it.
   */
  private hold(job: { token: string; kind: OutboxKind; versionId: string }) {
    let lastRenewed = Date.now();
    const claim = {
      token: job.token, kind: job.kind, versionId: job.versionId, lost: false,
      check() { if (claim.lost) throw new ClaimLost(`lost the claim on outbox job ${job.kind} for version ${job.versionId}`); },
      stop: () => { clearInterval(timer); this.claims.delete(job.token); },
    };
    const lose = (why: string) => {
      if (claim.lost) return;
      claim.lost = true;
      claim.stop();
      if (!this.closed) console.error(`kolab: outbox job ${job.kind} for version ${job.versionId}: ${why}; its work stops at its next step`);
    };
    const timer = setInterval(() => {
      this.db.query(`update outbox set claimed_until = ${this.leaseUntil} where claim = $1 returning id`, [job.token]).then(
        (r) => { if (r.rows.length) lastRenewed = Date.now(); else lose('its claim was taken by another process'); },
        (e) => {
          if (this.closed) return;
          console.error(`kolab: could not renew the claim on outbox job ${job.kind} for version ${job.versionId}: ${maskTokens(e)}`);
          if (Date.now() - lastRenewed > this.leaseMs) lose('its claim could not be renewed for a whole lease');
        });
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    timer.unref();
    this.claims.set(job.token, claim);
    return claim;
  }

  /**
   * A job's work is done: the job goes, if this process still holds it. An after_commit job's node
   * may have later cascades waiting on it; they run next, in commit order.
   */
  private async finish(job: { token: string; kind: OutboxKind; versionId: string }) {
    const r = job.kind === 'rebase' ? await this.finishRebase(job) : await this.db.query(`delete from outbox where claim = $1 returning id`, [job.token]);
    if (!r.rows.length) console.error(`kolab: outbox job ${job.kind} for version ${job.versionId} was done, but another process had taken it meanwhile; it does it again, once more`);
    if (job.kind !== 'after_commit') return;
    const node = (await this.db.query<{ node_id: string }>(`select node_id from version where id = $1`, [job.versionId])).rows[0]?.node_id;
    if (node) await this.drainNode(node);
  }

  /**
   * A rebase job done, while a parent commit landed after the job had read its parent (enqueueRebases
   * set `again`): freed to run once more, now, rather than deleted, so that commit is never lost,
   * whether this run's rebase passed or failed (D43, D44). Under the job's row lock, which a
   * parent's commit step takes too, so a commit either sees the job still held and sets `again`,
   * or finds it gone and writes a new one. Otherwise it is deleted, in the same transaction.
   * Returns the job's row, as finish's delete would, unless another process had taken it.
   */
  private async finishRebase(job: { token: string; kind: OutboxKind; versionId: string }) {
    let rerun = false;
    const r = await this.inTransaction(async (tx) => {
      const row = (await tx.query<{ id: string; again: boolean; lapsed: boolean }>(
        `select id, coalesce((payload->>'again')::boolean, false) as again, claimed_until < clock_timestamp() as lapsed
           from outbox where claim = $1 for update`, [job.token])).rows[0];
      if (!row) return { rows: [] };
      // A run whose lease lapsed may have missed a parent commit that found the job unclaimed-looking,
      // so it never deletes the job: it frees it, to run once more (P6).
      if (!row.again && !row.lapsed) return tx.query(`delete from outbox where id = $1 returning id`, [row.id]);
      await tx.query(`update outbox set claim = null, claimed_by = null, claimed_until = null, attempts = 0, run_after = clock_timestamp(),
                        payload = payload - 'again' where id = $1`, [row.id]);
      await this.notifyWork(tx);
      rerun = true;
      return { rows: [row] };
    });
    if (rerun) this.wake();
    return r;
  }

  /**
   * Frees a job whose work failed, to be tried again after a backoff that doubles with each
   * attempt, from 1 s up to 5 minutes, and tells every process's worker, in the same transaction.
   * After OUTBOX_MAX_ATTEMPTS it is dead instead: no worker takes it again, and it, and any later
   * cascade of its node, waits for an admin to retry it (retryOutboxJob).
   */
  private async fail(job: { token: string; kind: OutboxKind; versionId: string }, error: unknown) {
    // A job claimed just before its kolab was archived fails on the archive (kolab_writable). That
    // is no attempt: it is released as it was, and waits, unclaimed, until the kolab is unarchived.
    const paused = await this.db.query(
      `update outbox o set claim = null, claimed_by = null, claimed_until = null, attempts = greatest(o.attempts - 1, 0)
        where o.claim = $1 and ${archivedKolabSql('o.kolab_id')} returning o.id`, [job.token]);
    if (paused.rows.length) {
      console.error(`kolab: outbox job ${job.kind} for version ${job.versionId} waits: its kolab was archived while it ran`);
      return;
    }
    const r = await this.inTransaction(async (tx) => {
      const freed = await tx.query<{ state: OutboxState; attempts: number }>(
        `update outbox set claim = null, claimed_by = null, claimed_until = null, last_error = $2,
                state = case when attempts >= $4 then 'dead' else 'pending' end,
                run_after = clock_timestamp() + least(power(2, greatest(attempts - 1, 0)), $3) * interval '1 second'
          where claim = $1 returning state, attempts`,
        [job.token, maskTokens(error).slice(0, 2000), OUTBOX_MAX_BACKOFF_S, OUTBOX_MAX_ATTEMPTS]);
      if (freed.rows[0]?.state === 'pending') await this.notifyWork(tx);
      return freed.rows[0];
    });
    if (r?.state === 'dead') {
      console.error(`kolab: outbox job ${job.kind} for version ${job.versionId} is dead after ${r.attempts} failed attempts: ${maskTokens(error)}. `
        + 'No worker runs it, or any later cascade of its node, until an admin retries it (konjir_admin_outbox retry=<id>).');
      // A variant whose rebase job died is behind its parent: it says so, with a rebase_failed mark
      // and question (D44), until the parent's next commit or the variant's own tries again.
      if (job.kind === 'rebase') await this.rebaseDied(job.versionId, error).catch((e) => console.error(`kolab: could not mark the variant whose rebase job died: ${maskTokens(e)}`));
    } else if (r && !this.closed) {
      console.error(`kolab: outbox job ${job.kind} for version ${job.versionId} failed (attempt ${r.attempts}); it will be tried again: ${maskTokens(error)}`);
    }
  }

  /** Frees every job this process still holds, telling other processes' workers (on close). */
  private async freeClaims() {
    const tokens = [...this.claims.keys(), ...this.written.values()];
    if (!tokens.length) return;
    await this.inTransaction(async (tx) => {
      const r = await tx.query(`update outbox set claim = null, claimed_by = null, claimed_until = null where claim = any($1) returning id`, [tokens]);
      if (r.rows.length) await this.notifyWork(tx);
    });
  }

  /** Tells every process's worker, once `tx` commits, that a job is free to take (API5). */
  private async notifyWork(tx: Db) {
    const work: Notice = { from: this.origin, work: true };
    await tx.notify(EVENT_CHANNEL, JSON.stringify(work), () => JSON.stringify(work));
  }

  private worker?: { pollMs: number; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; again: boolean };

  /**
   * Starts this Kolab's outbox worker (REV3, W1.8): it runs every job that is due at once, as a
   * server boots, then whenever another process says a job is free (over EVENT_CHANNEL, once
   * `listen` has been called), when a failed job's backoff or a stopped process's claim runs out,
   * and at least every `pollMs`. Jobs are taken one at a time, oldest first, each by one process
   * (`for update skip locked`), and a node's cascades in the order its versions committed.
   * Idempotent; closing the Kolab stops it.
   */
  startWorker(opts: { pollMs?: number } = {}) {
    if (this.worker || this.closed || this.stopping) return;
    this.worker = { pollMs: opts.pollMs ?? OUTBOX_POLL_MS, again: false };
    this.wake();
  }

  /** Has the worker, if started, look for due jobs now, or once more after the pass it is in. */
  private wake() {
    const w = this.worker;
    if (!w || this.closed || this.stopping) return;
    if (w.running) { w.again = true; return; }
    clearTimeout(w.timer);
    w.running = (async () => {
      do {
        w.again = false;
        try {
          await this.drainOutbox();
        } catch (e) {
          if (!this.closed) console.error(`kolab: the outbox worker could not read the outbox: ${maskTokens(e)}`);
        }
      } while (w.again && !this.closed && !this.stopping);
    })().finally(() => { w.running = undefined; void this.scheduleWorker(); });
  }

  /** Sets the worker's next pass: when the next job falls due or its claim lapses, or after pollMs. */
  private async scheduleWorker() {
    const w = this.worker;
    if (!w || this.closed || this.stopping) return;
    let ms = w.pollMs;
    try {
      const r = await this.db.query<{ ms: number | string | null }>(
        `select extract(epoch from min(greatest(run_after, coalesce(claimed_until, run_after))) - clock_timestamp()) * 1000 as ms
           from outbox o where state = 'pending' and not ${archivedKolabSql('o.kolab_id')}`);
      const next = r.rows[0]?.ms;
      if (next !== null && next !== undefined) ms = Math.min(ms, Math.max(20, Math.ceil(Number(next)) + 5));
    } catch { /* the next pass reads it again */ }
    if (this.closed || this.stopping || w.running) return;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => this.wake(), ms);
    w.timer.unref();
  }

  /**
   * The claims this process holds or has just written. Never taken over by this process itself,
   * even if one's lease lapsed while the event loop was busy: its run is still going, here.
   */
  private ownTokens(): string[] { return [...this.claims.keys(), ...this.written.values()]; }

  /** Claims, as this process, the job `which` picks (SQL naming one outbox id), if no live process holds it and it is due. */
  private async claimJob(which: string, params: unknown[]): Promise<OutboxJob | undefined> {
    if (this.closed || this.stopping) return undefined;
    const n = params.length;
    return (await this.db.query<OutboxJob>(
      `update outbox o set claim = $${n + 1}, claimed_by = $${n + 2}, claimed_until = ${this.leaseUntil}, attempts = o.attempts + 1
        where o.id = (${which}) and o.state = 'pending' and o.run_after <= clock_timestamp()
          and not ${archivedKolabSql('o.kolab_id')}   -- an archived kolab's jobs wait until it is unarchived (D52)
          and (o.claimed_until is null or o.claimed_until < clock_timestamp())
          and (o.claim is null or not (o.claim = any($${n + 3}::text[])))
       returning o.id, o.kind, o.version_id, o.claim, o.payload, o.attempts`, [...params, ulid(), this.origin, this.ownTokens()])).rows[0];
  }

  /**
   * Runs every outbox job that is due and that no live process holds, oldest first, until none is
   * left: a job written by a process that stopped before finishing it, or one whose work failed
   * and has waited out its backoff. An after_commit job waits while any earlier version of its
   * node still owes its cascade. Returns how many finished. The worker calls it; a test can too,
   * with `max` to run at most that many jobs.
   */
  async drainOutbox(opts: { max?: number } = {}): Promise<number> {
    let done = 0;
    for (let taken = 0; taken < (opts.max ?? Infinity); taken++) {
      const job = await this.claimJob(
        `select j.id from outbox j join version jv on jv.id = j.version_id
          where j.state = 'pending' and j.run_after <= clock_timestamp()
            and (j.claimed_until is null or j.claimed_until < clock_timestamp())
            and (j.claim is null or not (j.claim = any($3::text[])))
            and not ${archivedKolabSql('j.kolab_id')}
            and (j.kind <> 'after_commit' or not exists (
                  select 1 from outbox e join version ev on ev.id = e.version_id
                   where e.kind = 'after_commit' and ev.node_id = jv.node_id and ev.seq < jv.seq))
          order by j.id limit 1 for update of j skip locked`, []);
      if (!job) break;
      if ((await this.runJob(job)) === 'done') done++;
    }
    return done;
  }

  /**
   * Runs the cascades a node owes, in commit order, as long as the earliest is free to run: after
   * one finishes, the next, which may have been deferred to wait for it.
   */
  private async drainNode(nodeId: string) {
    for (;;) {
      const job = await this.claimJob(
        `select j.id from outbox j join version jv on jv.id = j.version_id
          where j.kind = 'after_commit' and jv.node_id = $1 order by jv.seq limit 1`, [nodeId]);
      if (!job || (await this.runJob(job)) !== 'done') return;
    }
  }

  /** Runs a job this process has just claimed. */
  private async runJob(job: OutboxJob): Promise<'done' | 'deferred' | 'lost' | 'failed'> {
    return (await this.runToken({ token: job.claim, kind: job.kind, versionId: job.version_id }, (claim) => this.perform(job, claim))).state;
  }

  /** The work a job owes, from its row alone. Each is idempotent: run again, it does nothing twice. */
  private async perform(job: OutboxJob, claim: Claim): Promise<unknown> {
    if (job.kind === 'after_commit') return this.cascade(await this.version(job.version_id), claim);
    if (job.kind === 'settle') return this.settleJob(job.version_id, job.payload ?? {}, claim);
    if (job.kind === 'rebase') return this.rebaseJob(job.version_id, job.payload?.node, claim);
    throw new Error(`no work for an outbox job of kind ${String(job.kind)}`);
  }

  /** The outbox's jobs, oldest first, or only those in `state`: for an admin (konjir_admin_outbox). */
  async outboxJobs(opts: { state?: OutboxState; kolab?: string } = {}): Promise<OutboxJobView[]> {
    if (opts.kolab !== undefined) await this.requireKolab(opts.kolab);
    const rows = (await this.db.query<{ id: string; kind: OutboxKind; state: OutboxState; kolab_id: string; name: string; seq: number;
      attempts: number; claimed_by: string | null; run_after: Date | string; last_error: string | null; created_at: Date | string;
      after_kolab: string | null; after_name: string | null; after_seq: number | null }>(
      `select o.id, o.kind, o.state, o.kolab_id, n.name, v.seq, o.attempts, o.claimed_by, o.run_after, o.last_error, o.created_at,
              an.kolab_id as after_kolab, an.name as after_name, av.seq as after_seq
         from outbox o join version v on v.id = o.version_id join node n on n.id = v.node_id
         left join version av on av.id = o.payload->>'onto' left join node an on an.id = av.node_id
        where ($1::text is null or o.state = $1) and ($2::text is null or o.kolab_id = $2) order by o.id`, [opts.state ?? null, opts.kolab ?? null])).rows;
    return rows.map((r) => ({
      id: r.id, kind: r.kind, state: r.state, subject: formatAddress({ kolab: r.kolab_id, node: r.name, version: r.seq }),
      attempts: r.attempts, claimed_by: r.claimed_by, run_after: new Date(r.run_after).toISOString(), last_error: r.last_error,
      created_at: new Date(r.created_at).toISOString(),
      ...(r.after_name ? { after: formatAddress({ kolab: r.after_kolab!, node: r.after_name, version: r.after_seq! }) } : {}),
    }));
  }

  /**
   * Retries a dead job, or one waiting out its backoff: due now, with its attempts counted afresh,
   * and every process's worker told. Returns whether there was such a job.
   */
  async retryOutboxJob(id: string): Promise<boolean> {
    const r = await this.inTransaction(async (tx) => {
      const freed = await tx.query<{ kind: string; version_id: string }>(
        `update outbox set state = 'pending', attempts = 0, run_after = clock_timestamp()
          where id = $1 and (claimed_until is null or claimed_until < clock_timestamp()) returning kind, version_id`, [id]);
      if (freed.rows.length) await this.notifyWork(tx);
      return freed.rows[0];
    });
    if (!r) return false;
    console.error(`kolab: outbox job ${r.kind} for version ${r.version_id} retried by an admin`);
    this.wake();
    return true;
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
    await this.requireFreeName(id, 'ActorError');
    const ownerAccount = owner === undefined ? undefined : await this.findAccount(owner);
    if (owner !== undefined && !ownerAccount) {
      if ((await this.findActor(owner))?.kind === 'agent') throw new ActorError(`${owner} is an agent; an agent's owner must be a person or an organization`);
      throw new ActorError(`no account ${owner} to own ${id}`);
    }
    if (ownerAccount?.archived) throw new ActorError(`${owner} is archived, so it can't own a new agent; unarchive it first`);
    try {
      await this.db.transaction(async (tx) => {
        if (owner === undefined) await tx.query(`insert into account(id, kind, name) values ($1, 'user', $2)`, [id, name]);
        await tx.query(`insert into actor(id, name, kind, owner_id) values ($1, $2, $3, $4)`,
          [id, name, owner === undefined ? 'person' : 'agent', owner ?? null]);
      });
    } catch (e) {
      // Another admin call added it between the check and the insert.
      if (/actor_pkey|actor_id_lower/.test(String(e))) throw new NameTakenError(`actor ${id} already exists`, undefined, 'ActorError');
      if (/account_pkey|account_id_lower/.test(String(e))) throw new NameTakenError(`account ${id} already exists`, undefined, 'ActorError');
      throw e;
    }
  }

  private async findActor(id: string): Promise<Actor | undefined> {
    return (await this.db.query<Actor>(
      `select id, name, kind, owner_id as owner from actor where id = $1`, [id])).rows[0];
  }

  /** Whether an actor is archived: by itself, or, for an agent, through its owner (D52); as kj_actor_archived computes it. */
  private async archivedActor(id: string): Promise<boolean> {
    return (await this.db.query<{ archived: boolean }>(`select kj_actor_archived($1) as archived`, [id])).rows[0].archived;
  }

  /** An actor, with the account that owns it when it's an agent. */
  async actor(id: string): Promise<Actor> {
    const a = await this.findActor(id);
    if (!a) throw new ActorError(`no actor ${id}`);
    return a;
  }

  /**
   * Every actor, or with `owner` that account's agents. Archived actors (D52), and agents of an
   * archived account, are left out; with `archived`, they are listed too, and every actor says
   * whether it is archived.
   */
  async listActors(opts: { owner?: string; archived?: boolean } = {}): Promise<Actor[]> {
    const rows = (await this.db.query<Actor & { archived: boolean }>(
      `select id, name, kind, owner_id as owner, kj_actor_archived(id) as archived from actor
        where $1::text is null or owner_id = $1 order by id`, [opts.owner ?? null])).rows;
    return opts.archived ? rows : rows.filter((a) => !a.archived).map(({ archived: _, ...a }) => a);
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
   * Opens a session for an actor in one kolab, with one active role, and returns its bearer
   * token: random, not a sortable ULID. This is the only time the token is shown. The database
   * stores only its sessionKey, as the session's id (P1), and every other method takes the token
   * and hashes it. Each actor holds at most one open session (ENF4), so a person's agents each
   * hold their own.
   *
   * The actor must be able to reach the kolab. Without `kolab`, it is the one kolab the actor
   * can reach. An agent's access is checked against its owner's as the session opens, and on
   * every write after: it is its own grant, never more than its owner's (D30).
   */
  async openSession(actorId: string, role: Role, opts: { kolab?: string } = {}): Promise<string> {
    const actor = await this.findActor(actorId);
    if (!actor) throw new ActorError(`no actor ${actorId}; add it first`);
    if (await this.archivedActor(actorId)) {
      throw new ActorError(actor.kind === 'agent' && !(await this.db.query(`select 1 from actor where id = $1 and archived_at is not null`, [actorId])).rows.length
        ? `${actorId}'s owner ${actor.owner} is archived, so ${actorId} opens no session; unarchive ${actor.owner} first`
        : `${actorId} is archived, so it opens no session; unarchive it first`);
    }
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
    await this.requireLiveKolab(kolab, 'opens no session');
    const id = newSessionToken();
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
        await insertSession(tx, id, { actor: actorId, role, kolab: kolab! });
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
      // Archived since the checks above: the database refuses it too (session_openable).
      if (/is archived/.test(String(e))) throw new TenancyError(String((e as Error).message ?? e));
      throw e;
    }
    return id;
  }

  /**
   * End a session, revoking its token, and tell listeners so its open streams close (D41).
   * The session is named by its token, by its sessionKey (`{ key }`, as whoami and events give
   * it), or by its actor (`{ actor }`, whose one open session it is), since the token is shown
   * only once. Returns the ended session's sessionKey, or null if there was no such open session.
   * The event names the session by sessionKey, never by its token.
   */
  async endSession(which: string | { key: string } | { actor: string }): Promise<string | null> {
    return this.inTransaction(async (tx, signal) => {
      const r = typeof which === 'object' && 'actor' in which
        ? await tx.query<{ id: string }>(`update session set ended_at = now() where actor_id = $1 and ended_at is null returning id`, [which.actor])
        : typeof which === 'string'
          // By its token: a grant's session by its current access token, expired or not, so signing out still works.
          ? await tx.query<{ id: string }>(`update session s set ended_at = now()
              where s.ended_at is null and (s.token_key = $1 or (s.token_key is null and s.id = $1)) returning s.id`, [sessionKey(which)])
          : await tx.query<{ id: string }>(`update session set ended_at = now() where id = $1 and ended_at is null returning id`, [which.key]);
      const key = r.rows[0]?.id ?? null;
      if (key) await signal({ session: 'ended', id: key });
      return key;
    });
  }

  /** Which of the session `tokens` still reach their open session, in one query (an expired access token doesn't). */
  async openSessions(tokens: string[]): Promise<Set<string>> {
    if (!tokens.length) return new Set();
    const keys = new Map(tokens.map((t) => [sessionKey(t), t]));
    const r = await this.db.query<{ key: string }>(
      `select coalesce(s.token_key, s.id) as key from session s
        where s.ended_at is null and (s.token_key = any($1) or (s.token_key is null and s.id = any($1)))
          and (s.expires_at is null or s.expires_at > now())`, [[...keys.keys()]]);
    return new Set(r.rows.map((x) => keys.get(x.key)!));
  }

  /**
   * Which of the sessions with these ids are still open, in one query, whatever their access
   * tokens' expiry: a grant's session lives until it ends or its grant lapses (D55). A listen
   * stream lives as long as its session (D41).
   */
  async liveSessions(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const r = await this.db.query<{ id: string }>(
      `select s.id from session s left join oauth_grant g on g.id = s.grant_id
        where s.id = any($1) and s.ended_at is null and (g.id is null or (g.revoked_at is null and g.expires_at > now()))`, [ids]);
    return new Set(r.rows.map((x) => x.id));
  }

  /**
   * The session a bearer token reaches now: its id (the key whoami and events name it by), and
   * when its access token expires (null for a hand-issued token, which never does), or undefined.
   */
  async liveSession(token: string): Promise<{ id: string; expiresAt: Date | null; granted: boolean } | undefined> {
    const r = await this.db.query<{ id: string; expires_at: Date | null; granted: boolean }>(
      `select s.id, s.expires_at, s.grant_id is not null as granted from session s where ${LIVE_SESSION}`, [sessionKey(token)]);
    const row = r.rows[0];
    return row && { id: row.id, expiresAt: row.expires_at === null ? null : new Date(row.expires_at), granted: row.granted };
  }

  /**
   * The kolab and actor of the open session whose token is `token`, or undefined if it isn't
   * open: what a listen stream may subscribe to (D50). One query, with no access check: a
   * session's kolab and actor never change, and one that has lost its access is ended, which
   * closes its streams (D41).
   */
  async sessionScope(token: string): Promise<{ kolab: string; actor: string } | undefined> {
    const r = await this.db.query<{ kolab: string; actor: string }>(
      `select s.kolab_id as kolab, s.actor_id as actor from session s where ${LIVE_SESSION}`, [sessionKey(token)]);
    return r.rows[0];
  }

  /** Whether `token` reaches an open session: it is still good, and, for an access token, hasn't expired. */
  async sessionOpen(token: string): Promise<boolean> {
    const r = await this.db.query(`select 1 from session s where ${LIVE_SESSION}`, [sessionKey(token)]);
    return r.rows.length > 0;
  }

  private async session(token: string): Promise<Session> {
    const r = await this.db.query<Omit<Session, 'access'>>(
      `select s.id, s.actor_id, s.active_role, s.kolab_id as kolab, a.kind, a.owner_id as owner
         from session s join actor a on a.id = s.actor_id
        where ${LIVE_SESSION}`, [sessionKey(token)]);
    if (!r.rows[0]) throw new RoleError('no open session for that token');
    const s = { ...r.rows[0], access: await accessIn(this.db, r.rows[0].actor_id, r.rows[0].kolab) };
    // Access is computed on each use, so a session narrows the moment its access (or, for an
    // agent, its owner's) does. One that can no longer reach its kolab at all is ended here, if
    // no change of access ended it already, and its streams are told (D41).
    if (!s.access.level) {
      await this.endUnreachable([s.actor_id]);
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
      throw new RoleError(`${withArticle(s.active_role)} session may not write the ${layer} layer`);
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

  /**
   * Runs read-only queries as a session reads (views.ts, for the web interface): as kj_agent in
   * that session, so row-level security bounds them as it bounds read_node, in a transaction made
   * read-only before `fn` runs, so a view can't write even where row-level security would let it.
   */
  readAs<T>(sessionId: string, fn: (q: Pick<Db, 'query'>) => Promise<T>): Promise<T> {
    return this.asAgent(sessionId, async (tx) => {
      await tx.exec('set local transaction_read_only = on');
      return fn(tx);
    });
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
   * A node's version as a session reads it, with its elements, the questions on the node, and
   * its rulings and open case files (DAT11, CASE4): one of its own kolab's, or `<kolab>/<node>` in another it holds Read on, where only
   * committed versions show. Every read runs as kj_agent, so row-level security bounds it too.
   * Addresses in the questions are written to be read in the session's kolab.
   */
  async readNode(sessionId: string, ref: string, version?: number) {
    const where = { session: sessionId };
    const { node, version: v } = await this.locateVersion(where, { ...parseNodeRef(ref), version });
    if (!v) throw new Error(`${ref} has no ${version === undefined ? 'committed version' : `version ${version}`}`);
    const from = await this.sessionKolab(sessionId);
    const read = await this.read(where, async (q) => ({
      node, version: v, from,
      elements: await this.elements(v.id, q),
      queries: await this.listQueries({ node: node.id, from }, q),
      // Precedent and open case files on the node: only its own kolab's ever show, since row-level
      // security gives a session no other kolab's (TEN13).
      rulings: await this.listRulings({ kolab: node.kolab_id, node: node.id }, q),
      cases: await this.listCases({ kolab: node.kolab_id, node: node.id, state: 'open' }, q),
    }));
    // The links it drops (0012), for its reviewers: private to its kolab, like its links (D49).
    // Its pending rebase is told to any reader in the node's kolab, one who holds only Read too
    // (D58): a reader from another kolab doesn't learn of it.
    return { ...read, removes: await this.removedLinks(where, v), ...(node.kolab_id === from ? { rebase: await this.pendingRebase(node.id) } : {}) };
  }

  /**
   * The rebase a variant still owes (D43, P6), if one is queued: the parent version whose commit
   * queued it, whether it is pending or dead (it failed too often and waits for an admin), its
   * attempts and its last error. Undefined when the variant owes none.
   */
  async pendingRebase(nodeId: string): Promise<PendingRebase | undefined> {
    // Only while the variant is behind its parent, and a pending job before a dead one: a job a
    // newer version of the variant made moot says nothing.
    const r = (await this.db.query<{ state: OutboxState; attempts: number; last_error: string | null; onto: string | null; created_at: Date | string }>(
      `select o.state, o.attempts, o.last_error, o.payload->>'onto' as onto, o.created_at
         from outbox o join version v on v.id = o.version_id
        where o.kind = 'rebase' and v.node_id = $1 and ${BEHIND('$1')}
        order by o.state = 'pending' desc, o.id desc limit 1`, [nodeId])).rows[0];
    if (!r) return undefined;
    // Never another kolab's address (D49, D53): a parent elsewhere goes unnamed.
    const onto = r.onto ? (await this.db.query<{ name: string; kolab_id: string; seq: number }>(
      `select n.name, n.kolab_id, v.seq from version v join node n on n.id = v.node_id
        where v.id = $1 and n.kolab_id = (select kolab_id from node where id = $2)`, [r.onto, nodeId])).rows[0] : undefined;
    // Nor what went wrong there: a fork's rebase, whatever queued it, keeps its error to itself.
    const parentKolab = (await this.db.query<{ kolab_id: string }>(
      `select p.kolab_id from version l join version p on p.id = l.parent_version_id
        where l.node_id = $1 and l.state = 'committed' order by l.seq desc limit 1`, [nodeId])).rows[0]?.kolab_id;
    const elsewhere = (!!r.onto && !onto) || (parentKolab !== undefined && parentKolab !== (await this.node(nodeId)).kolab_id);
    return {
      state: r.state, attempts: r.attempts, queued_at: new Date(r.created_at).toISOString(),
      ...(onto ? { after: formatAddress({ kolab: onto.kolab_id, node: onto.name, version: onto.seq }) } : {}),
      ...(r.last_error && !elsewhere ? { last_error: r.last_error } : {}),
    };
  }

  /**
   * The version an address names for a write: a link's source or target, or a variant's parent.
   * In the session's kolab, unless `across`: a link's target and a variant's parent may be another
   * kolab's committed version, where the session's actor holds Read (LNK8, KON9), found exactly as
   * a read finds it, so an address it can't read is a node that isn't there. Without `across`,
   * another kolab's is refused from the address alone. A draft only with `allowDraft`, and only in
   * the session's own kolab.
   */
  async versionIn(sessionId: string, address: Address | string, opts: { allowDraft?: boolean; across?: boolean; what: string }): Promise<VersionRow> {
    const a = typeof address === 'string' ? parseAddress(address) : address;
    const where = { session: sessionId };
    const node = opts.across ? await this.locateNode(where, a) : await this.nodeIn(sessionId, a, opts.what);
    const { version } = await this.locateVersion(where, { kolab: node.kolab_id, node: node.name, version: a.version });
    const from = await this.sessionKolab(sessionId);
    const name = node.kolab_id === from ? node.name : `${node.kolab_id}/${node.name}`;
    const at = formatAddress({ kolab: node.kolab_id, node: node.name, version: a.version }, { from });
    if (!version) throw new Error(a.version === undefined ? `${name} has no committed version` : `${name} has no version ${a.version}`);
    if (!opts.allowDraft && version.state !== 'committed') throw new GateError(`${at} is ${version.state}, not committed`);
    return version;
  }

  // ---- signing in, and Kolab as an OAuth 2.1 authorization server (D55) ----

  /**
   * The authorization server's lifetimes and limits (D55). An access token lives `accessTtlS`
   * (15 minutes); a grant lives `refreshTtlS` (30 days) past its last refresh; an authorization
   * code `codeTtlS`; a sign-in has `requestTtlS` to be consented to. A refresh token presented
   * again within `refreshGraceS` of its use is a concurrent request, refused without revoking
   * anything; later, a replay, which revokes its grant. A person owns at most `agentsPerPerson`
   * agents they made themselves.
   */
  readonly oauth = { accessTtlS: 900, refreshTtlS: 30 * 86_400, codeTtlS: 60, requestTtlS: 1200, refreshGraceS: 10, agentsPerPerson: 10 };

  /**
   * The person an identity provider says signed in (D55). An identity is the provider's own stable
   * id for someone (`subject`: GitHub's numeric user id), never their login, which can change
   * hands. The first time an identity signs in, it signs up: a new person, and their user account,
   * named after their login (lowercased), or, if a live or archived account or actor holds that
   * name in any case (D52), or it is reserved, a variant of it (signUpNames). An existing person is
   * never matched by name: an admin links one to an identity (linkIdentity). A person who is
   * archived, or whose identity is linked to an archived person, doesn't sign in.
   */
  async signInWith(who: { provider: string; subject: string; login: string; name?: string }): Promise<{ actor: string; created: boolean }> {
    if (!IDP_NAME.test(who.provider) || !IDP_SUBJECT.test(who.subject)) throw new ActorError('that identity provider gave no usable identity');
    const login = who.login.trim();
    if (!login || login.length > 200) throw new ActorError('that identity provider gave no usable login');
    const name = (who.name?.trim() || login).slice(0, 200);
    const linked = async () => {
      const id = (await this.db.query<{ actor_id: string }>(
        `update identity set login = $3, last_seen_at = now() where provider = $1 and subject = $2 returning actor_id`,
        [who.provider, who.subject, login])).rows[0]?.actor_id;
      if (id && await this.archivedActor(id)) throw new ActorError(`${id} is archived, so it can't sign in; an admin can unarchive it`);
      return id;
    };
    const known = await linked();
    if (known) return { actor: known, created: false };
    // A login that reads as an existing person's agent, `<person>-<label>`, signs up as gh_<login>,
    // so no one passes for someone's agent, or takes a name that person's agent would have (D30).
    const base = login.toLowerCase();
    const prefixes = [...base.matchAll(/-/g)].map((m) => base.slice(0, m.index));
    // An agent's owner is a person or an organization (D30).
    const people = prefixes.length ? new Set((await this.db.query<{ id: string }>(
      `select lower(id) as id from actor where kind = 'person' and lower(id) = any($1)
       union select lower(id) from account where kind = 'organization' and lower(id) = any($1)`, [prefixes])).rows.map((r) => r.id)) : new Set<string>();
    const agentLike = (name: string) => [...name.matchAll(/-/g)].some((m) => people.has(name.slice(0, m.index)));
    for (const candidate of signUpNames(login, agentLike)) {
      try {
        await this.requireFreeName(candidate, 'ActorError');
        await this.db.transaction(async (tx) => {
          await tx.query(`insert into account(id, kind, name) values ($1, 'user', $2)`, [candidate, name]);
          await tx.query(`insert into actor(id, name, kind) values ($1, $2, 'person')`, [candidate, name]);
          await tx.query(`insert into identity(provider, subject, actor_id, login) values ($1, $2, $3, $4)`, [who.provider, who.subject, candidate, login]);
        });
        return { actor: candidate, created: true };
      } catch (e) {
        // The same identity signed up at the same moment: it is that person.
        if (String(e).includes('identity_pkey')) {
          const again = await linked();
          if (again) return { actor: again, created: false };
        }
        if (e instanceof NameTakenError || /actor_pkey|actor_id_lower|account_pkey|account_id_lower/.test(String(e))) continue;
        throw e;
      }
    }
    throw new ActorError(`no free name for ${login} to sign up with; ask an admin`);
  }

  /** Links an existing person to an identity (admin), so their first sign-in with it reaches them. */
  async linkIdentity(actorId: string, who: { provider: string; subject: string; login?: string }) {
    if (!IDP_NAME.test(who.provider) || !IDP_SUBJECT.test(who.subject)) throw new ActorError('name the provider (github) and its id for the person (GitHub\'s numeric user id)');
    const a = await this.actor(actorId);
    if (a.kind !== 'person') throw new ActorError(`${actorId} is an agent: only a person signs in`);
    try {
      await this.db.query(`insert into identity(provider, subject, actor_id, login) values ($1, $2, $3, $4)`,
        [who.provider, who.subject, actorId, who.login ?? who.subject]);
    } catch (e) {
      if (String(e).includes('identity_pkey')) {
        const holder = (await this.db.query<{ actor_id: string }>(`select actor_id from identity where provider = $1 and subject = $2`, [who.provider, who.subject])).rows[0]?.actor_id;
        throw new ActorError(`that ${who.provider} identity is already linked to ${holder}`);
      }
      if (String(e).includes('identity_one_per_provider')) throw new ActorError(`${actorId} is already linked to a ${who.provider} identity`);
      throw e;
    }
  }

  /** A person's identities, provider and login. */
  async identities(actorId: string): Promise<{ provider: string; subject: string; login: string }[]> {
    return (await this.db.query<{ provider: string; subject: string; login: string }>(
      `select provider, subject, login from identity where actor_id = $1 order by provider`, [actorId])).rows;
  }

  /**
   * Registers a public client (RFC 7591): one with no secret, as every MCP client is, that receives
   * codes only at `redirectUris` (validRedirectUri). Returns its client id.
   */
  async registerClient(c: { name?: string; redirectUris: string[] }): Promise<OAuthClient> {
    const uris = [...new Set(c.redirectUris)];
    if (!uris.length || uris.length > 10) throw new OAuthGrantError('invalid_redirect_uri', 'register 1 to 10 redirect URIs');
    for (const u of uris) {
      if (validRedirectUri(u)) continue;
      const shown = u.slice(0, 200);
      if (trailingDotHost(u)) throw new OAuthGrantError('invalid_redirect_uri', `${shown} isn't a redirect URI Kolab sends codes to: its host ends in a dot, which Kolab doesn't allow (the consent page couldn't name it), so write the host without the trailing dot`);
      throw new OAuthGrantError('invalid_redirect_uri', `${shown} isn't a redirect URI Kolab sends codes to: use https, or http on a loopback address, with no fragment or credentials`);
    }
    const name = (c.name ?? '').trim().slice(0, 200) || 'An MCP client';
    const id = `kjcl_${randomBytes(18).toString('base64url')}`;
    await this.pruneClients();
    await this.db.query(`insert into oauth_client(id, name, redirect_uris) values ($1, $2, $3)`, [id, name, uris]);
    return { id, name, redirectUris: uris };
  }

  /**
   * Deletes registered clients no one uses: one never used a day after it registered, and one
   * unused for 30 days with no grant still live. Returns how many.
   */
  async pruneClients(): Promise<number> {
    return (await this.db.query(
      `delete from oauth_client c
        where (c.last_used_at is null and c.created_at < now() - interval '1 day'
               or c.last_used_at < now() - interval '30 days')
          and not exists (select 1 from oauth_grant g where g.client_id = c.id and g.revoked_at is null and g.expires_at > now())
          and not exists (select 1 from oauth_code k where k.client_id = c.id and k.expires_at > now())
       returning c.id`)).rows.length;
  }

  /** A registered client, or undefined. With `use`, it counts as used now (pruneClients). */
  async oauthClient(id: string, opts: { use?: boolean } = {}): Promise<OAuthClient | undefined> {
    const r = (await this.db.query<{ id: string; name: string; redirect_uris: string[] }>(opts.use
      ? `update oauth_client set last_used_at = now() where id = $1 returning id, name, redirect_uris`
      : `select id, name, redirect_uris from oauth_client where id = $1`, [id])).rows[0];
    return r && { id: r.id, name: r.name, redirectUris: r.redirect_uris };
  }

  /**
   * Starts an authorization (GET /oauth/authorize), already checked against its client. Returns two
   * secrets, each stored only as its key: `binding`, for the browser's cookie, and `state`, for the
   * identity provider, so the provider's answer counts only in the browser that asked, with the
   * state it was given (CSRF). Old requests and codes are cleared as it goes.
   */
  async beginAuthorization(r: { provider: string; clientId: string; redirectUri: string; clientState?: string; codeChallenge: string; scope?: string; resource?: string; invite?: string }): Promise<{ binding: string; state: string }> {
    if (!PKCE_CHALLENGE.test(r.codeChallenge)) throw new OAuthGrantError('invalid_request', 'code_challenge must be an S256 challenge: 43 base64url characters');
    // An invite rides along by its key only (W3.4); whether it is still good is checked when it is shown and when it is used.
    const inviteKey = r.invite !== undefined && INVITE_TOKEN.test(r.invite) ? sessionKey(r.invite) : null;
    const binding = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    // An expired request is kept 2 hours, unusable, so a late consent form can be told it expired:
    // as a tombstone, its keys and times only, what signInStatus reads. The update's condition is
    // migration 0021's index predicate, so it reaches only those not yet made tombstones.
    await this.db.query(`delete from oauth_request where expires_at < now() - interval '2 hours'`);
    await this.db.query(`update oauth_request set client_state = null, scope = null, resource = null, invite_key = null, redirect_uri = ''
      where expires_at < now() and (redirect_uri <> '' or client_state is not null or scope is not null or resource is not null or invite_key is not null)`);
    await this.db.query(`delete from oauth_code where expires_at < now() - interval '1 day'`);
    await this.db.query(
      `insert into oauth_request(id, state_key, provider, client_id, redirect_uri, client_state, code_challenge, scope, resource, expires_at, invite_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + $10 * interval '1 second', $11)`,
      [sessionKey(binding), sessionKey(state), r.provider, r.clientId, r.redirectUri, r.clientState ?? null, r.codeChallenge,
        r.scope ?? null, r.resource ?? null, this.oauth.requestTtlS, inviteKey]);
    return { binding, state };
  }

  /**
   * The identity provider's answer reached the browser that asked: the authorization is now the
   * person's to consent to. Returns the consent form's token (stored as its key). Refused if the
   * binding and state don't belong to one unexpired authorization not yet identified.
   */
  async identifyAuthorization(binding: string, state: string, person: string): Promise<{ csrf: string }> {
    const csrf = randomBytes(32).toString('base64url');
    const r = await this.db.query(
      `update oauth_request set actor_id = $3, csrf_key = $4
        where id = $1 and state_key = $2 and actor_id is null and expires_at > now() returning id`,
      [sessionKey(binding), sessionKey(state), person, sessionKey(csrf)]);
    if (!r.rows.length) throw new OAuthGrantError('access_denied', 'this sign-in expired, was already used, or was started in another browser; start again');
    return { csrf };
  }

  /**
   * The authorization a browser's binding names, while it lasts, for the consent page. With
   * `state`, only if that is the state sent to the identity provider for it, so a forged callback
   * is refused before its code reaches the provider (RFC 6749 §10.12). With `csrf`, only if that is
   * its consent form's token: a form from an earlier sign-in that this one replaced has another.
   */
  async pendingAuthorization(binding: string, opts: { state?: string; csrf?: string } = {}): Promise<PendingAuthorization | undefined> {
    const r = (await this.db.query<{ client_id: string; redirect_uri: string; client_state: string | null; scope: string | null; actor_id: string | null; provider: string; invite_key: string | null }>(
      `select client_id, redirect_uri, client_state, scope, actor_id, provider, invite_key from oauth_request
        where id = $1 and expires_at > now() and ($2::text is null or state_key = $2) and ($3::text is null or csrf_key = $3)`,
      [sessionKey(binding), opts.state === undefined ? null : sessionKey(opts.state), opts.csrf === undefined ? null : sessionKey(opts.csrf)])).rows[0];
    return r && { clientId: r.client_id, redirectUri: r.redirect_uri, clientState: r.client_state, scope: r.scope, person: r.actor_id, provider: r.provider, inviteKey: r.invite_key };
  }

  /**
   * What the consent page offers a person: the kolabs they can reach, with their access there, and
   * their own agents (D30), each live; and, for a sign-in that carries one (`inviteKey`), the invite,
   * while it is still good (W3.4).
   */
  async consentOptions(person: string, opts: { inviteKey?: string | null } = {}): Promise<{ kolabs: { id: string; title: string; access: Access }[]; agents: string[]; invite?: InvitePreview }> {
    const kolabs = [];
    for (const id of await this.reachable(person)) {
      const k = await this.requireKolab(id);
      if (!k.archived) kolabs.push({ id, title: k.title, access: await accessIn(this.db, person, id) });
    }
    const invite = opts.inviteKey ? await this.previewInviteByKey(opts.inviteKey) : undefined;
    return { kolabs, agents: (await this.listActors({ owner: person })).map((a) => a.id), ...(invite ? { invite } : {}) };
  }

  /**
   * The person consents (POST /oauth/consent, with the form's `csrf` token): the client may act as
   * them, or as an agent of theirs, in one kolab and role. A new kolab of their own (D54, with
   * makeOwnKolab's limits) or a new agent of theirs (addOwnAgent) may be made on the way. An agent
   * reaches the kolab by its own grant, never more than its owner holds there (D30): if it has
   * none, it is granted what its owner holds, at most Write. With `selfOnly` (the web interface,
   * which is for people), only the person themselves. Returns the authorization code, one use, and
   * where to send it; the authorization is used up.
   */
  async consent(binding: string, csrf: string, choice: ConsentChoice, opts: { selfOnly?: boolean } = {}): Promise<{ code: string; redirectUri: string; clientState: string | null }> {
    // Claimed first, before anything is made: a second submission of the form at once is refused.
    const req = (await this.db.query<{ client_id: string; redirect_uri: string; client_state: string | null; code_challenge: string; scope: string | null; resource: string | null; actor_id: string | null; invite_key: string | null }>(
      `update oauth_request set claimed_at = now()
        where id = $1 and csrf_key = $2 and expires_at > now() and actor_id is not null and claimed_at is null
       returning client_id, redirect_uri, client_state, code_challenge, scope, resource, actor_id, invite_key`, [sessionKey(binding), sessionKey(csrf)])).rows[0];
    if (!req?.actor_id) throw new OAuthGrantError('access_denied', 'this sign-in expired or was already used; start again');
    try {
      return await this.consentClaimed(binding, csrf, { ...req, actor_id: req.actor_id }, choice, opts);
    } catch (e) {
      // Released, so the person can correct the page and try again.
      await this.db.query(`update oauth_request set claimed_at = null where id = $1 and csrf_key = $2`, [sessionKey(binding), sessionKey(csrf)]).catch(() => undefined);
      throw e;
    }
  }

  private async consentClaimed(binding: string, csrf: string,
    req: { client_id: string; redirect_uri: string; client_state: string | null; code_challenge: string; scope: string | null; resource: string | null; actor_id: string; invite_key: string | null },
    choice: ConsentChoice, opts: { selfOnly?: boolean }): Promise<{ code: string; redirectUri: string; clientState: string | null }> {
    const person = req.actor_id;
    if (await this.archivedActor(person)) throw new ActorError(`${person} is archived, so it can't sign in`);
    if (!ROLES.includes(choice.role)) throw new RoleError(`a role is one of ${ROLES.join(', ')}`);
    if (opts.selfOnly && choice.as.kind !== 'self') throw new AccessError('the web interface is for people: sign in as yourself');
    const code = `kjc_${randomBytes(24).toString('base64url')}`;
    // One use: whichever submission deletes the request issues the code, in the transaction `tx`.
    const issue = async (tx: Q, actor: string, kolab: string) => {
      const used = await tx.query(`delete from oauth_request where id = $1 and csrf_key = $2 returning id`, [sessionKey(binding), sessionKey(csrf)]);
      if (!used.rows.length) throw new OAuthGrantError('access_denied', 'this sign-in was already used; start again');
      await tx.query(
        `insert into oauth_code(key, client_id, redirect_uri, code_challenge, person_id, actor_id, kolab, role, scope, resource, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + $11 * interval '1 second')`,
        [sessionKey(code), req.client_id, req.redirect_uri, req.code_challenge, person, actor, kolab, choice.role, grantedScope(kolab, choice.role), req.resource, this.oauth.codeTtlS]);
    };
    const issued = { code, redirectUri: req.redirect_uri, clientState: req.client_state };
    let kolab: string;
    if (typeof choice.kolab === 'string') kolab = choice.kolab;
    else if ('invite' in choice.kolab) {
      // The invite this sign-in carries (W3.4): accepted as the person, under the access lock, in the
      // one transaction that also issues the code, so either both happen or neither does.
      if (!req.invite_key) throw new AccessError('this sign-in carries no invite: choose a kolab');
      // Only a person, through Kolab's own web page, joins with one: never a registered client, nor as an agent.
      if (!opts.selfOnly || choice.as.kind !== 'self') throw new AccessError('an invite is accepted by a person, on Kolab\'s own web page');
      await this.acceptInviteByKey(req.invite_key, person, (tx, joined) => issue(tx, person, joined));
      return issued;
    } else {
      await this.makeOwnKolab(person, choice.kolab.name, choice.kolab.title);
      kolab = choice.kolab.name;
    }
    if (!(await accessIn(this.db, person, kolab)).level) throw new AccessError(`no kolab ${kolab} you can reach`);
    let actor = person;
    if (choice.as.kind === 'agent') {
      const a = await this.findActor(choice.as.agent);
      if (!a || a.kind !== 'agent' || a.owner !== person || await this.archivedActor(a.id)) throw new AccessError(`no agent ${choice.as.agent} of yours`);
      actor = a.id;
    } else if (choice.as.kind === 'new-agent') {
      actor = await this.addOwnAgent(person, choice.as.label);
    }
    if (actor !== person) await this.grantOwnAgent(person, actor, kolab);
    if (!(await accessIn(this.db, actor, kolab)).level) throw new AccessError(`${actor} has no access to kolab ${kolab}`);
    await this.db.transaction((tx) => issue(tx, actor, kolab));
    return issued;
  }

  /**
   * The identity provider answered with an error (the person cancelled there): the authorization
   * whose binding and state these are is dropped. Returns where to tell the client.
   */
  async abandonAuthorization(binding: string, state: string): Promise<{ redirectUri: string; clientState: string | null } | undefined> {
    const r = (await this.db.query<{ redirect_uri: string; client_state: string | null }>(
      `delete from oauth_request where id = $1 and state_key = $2 and actor_id is null and expires_at > now() returning redirect_uri, client_state`,
      [sessionKey(binding), sessionKey(state)])).rows[0];
    return r && { redirectUri: r.redirect_uri, clientState: r.client_state };
  }

  /** The person declined: the authorization is dropped. Returns where to tell the client, if it was theirs to decline. */
  async declineAuthorization(binding: string, csrf: string): Promise<{ redirectUri: string; clientState: string | null } | undefined> {
    const r = (await this.db.query<{ redirect_uri: string; client_state: string | null }>(
      `delete from oauth_request where id = $1 and csrf_key = $2 and expires_at > now() returning redirect_uri, client_state`, [sessionKey(binding), sessionKey(csrf)])).rows[0];
    return r && { redirectUri: r.redirect_uri, clientState: r.client_state };
  }

  /**
   * The bindings a browser holds, oldest sign-in first: those Kolab has no record of, then the
   * rest by when they started. For making room for a new sign-in in a browser at its cap.
   */
  async signInsByAge(bindings: string[]): Promise<string[]> {
    if (!bindings.length) return [];
    const keys = new Map(bindings.map((b) => [sessionKey(b), b]));
    const found = (await this.db.query<{ id: string }>(
      `select id from oauth_request where id = any($1::text[]) order by created_at, id`, [[...keys.keys()]])).rows.map((r) => keys.get(r.id)!);
    // Those Kolab has no record of (expired and gone, or never its own) are the oldest of all.
    return [...bindings.filter((b) => !found.includes(b)), ...found];
  }

  /**
   * What became of a sign-in that can't go on, for the page that says so, by any one of its secrets:
   * the browser's binding, the identity provider's state, or the consent form's token. `open` while
   * it lasts, `expired` once its `requestTtlS` is up (an expired one is kept 2 hours), and undefined
   * once it was used, declined or cancelled, or for a secret that names none.
   */
  async signInStatus(by: { binding: string } | { state: string } | { csrf: string }): Promise<'open' | 'expired' | undefined> {
    const [column, secret] = 'binding' in by ? ['id', by.binding] : 'state' in by ? ['state_key', by.state] : ['csrf_key', by.csrf];
    const r = (await this.db.query<{ open: boolean }>(`select expires_at > now() as open from oauth_request where ${column} = $1`, [sessionKey(secret)])).rows[0];
    return r === undefined ? undefined : r.open ? 'open' : 'expired';
  }

  /**
   * Exchanges an authorization code (POST /oauth/token, RFC 6749 §4.1.3) for an access token and a
   * refresh token: once, by the client it was issued to, at the same redirect URI, with the PKCE
   * verifier of its challenge (S256). A code used a second time revokes the grant it opened. The
   * grant's session opens in the consented kolab and role, under the access lock, with access
   * checked as any session's is; it replaces any session its actor already holds (ENF4: one each),
   * whose streams are told (D41), so the newest sign-in wins.
   */
  async exchangeCode(p: { code: string; clientId: string; redirectUri: string; codeVerifier: string; resource?: string }): Promise<OAuthTokens> {
    const key = sessionKey(p.code);
    const access = newSessionToken();
    const refresh = `kjr_${randomBytes(32).toString('base64url')}`;
    const grantId = randomBytes(24).toString('base64url');
    let replayed: string | null = null;
    const out = await this.inTransaction(async (tx, signal) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
      const c = (await tx.query<{ client_id: string; redirect_uri: string; code_challenge: string; person_id: string; actor_id: string; kolab: string; role: Role; scope: string; resource: string | null; expired: boolean; used_at: Date | null; grant_id: string | null }>(
        `select client_id, redirect_uri, code_challenge, person_id, actor_id, kolab, role, scope, resource, expires_at <= now() as expired, used_at, grant_id
           from oauth_code where key = $1 for update`, [key])).rows[0];
      if (!c || c.client_id !== p.clientId) return undefined;
      if (c.used_at) { replayed = c.grant_id; return undefined; }
      if (c.expired || c.redirect_uri !== p.redirectUri || !PKCE_VERIFIER.test(p.codeVerifier)
          || createHash('sha256').update(p.codeVerifier).digest('base64url') !== c.code_challenge) return undefined;
      if (p.resource !== undefined && c.resource !== null && p.resource !== c.resource) return undefined;
      // The newest sign-in wins: the actor's one open session ends (ENF4), and its streams close (D41).
      for (const { id } of (await tx.query<{ id: string }>(`update session set ended_at = now() where actor_id = $1 and ended_at is null returning id`, [c.actor_id])).rows) {
        await signal({ session: 'ended', id });
      }
      await tx.query(`insert into oauth_grant(id, client_id, actor_id, person_id, scope, resource, expires_at)
                      values ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 second')`,
        [grantId, c.client_id, c.actor_id, c.person_id, c.scope, c.resource, this.oauth.refreshTtlS]);
      await tx.query(`update oauth_code set used_at = now(), grant_id = $2 where key = $1`, [key, grantId]);
      const session = await insertSession(tx, access, { actor: c.actor_id, role: c.role, kolab: c.kolab, grant: grantId, ttlS: this.oauth.accessTtlS });
      if (!(await accessIn(tx, c.actor_id, c.kolab)).level) throw new OAuthGrantError('access_denied', `${c.actor_id} can no longer reach kolab ${c.kolab}`);
      await tx.query(`insert into oauth_refresh_token(key, grant_id, expires_at) values ($1, $2, now() + $3 * interval '1 second')`,
        [sessionKey(refresh), grantId, this.oauth.refreshTtlS]);
      return { accessToken: access, refreshToken: refresh, expiresIn: this.oauth.accessTtlS, scope: c.scope, session, actor: c.actor_id, kolab: c.kolab, role: c.role };
    }).catch((e) => {
      if (/is archived/.test(String(e))) throw new OAuthGrantError('access_denied', String((e as Error).message ?? e));
      throw e;
    });
    if (replayed) await this.revokeGrant(replayed);
    if (!out) throw new OAuthGrantError('invalid_grant', 'that authorization code is unknown, expired, already used, or was issued to another client, redirect URI or PKCE verifier');
    return out;
  }

  /**
   * Refreshes a grant (RFC 6749 §6): a new access token for its session, and a new refresh token
   * in place of the one used (rotation). The session keeps its id, kolab and role; its access is
   * checked again, and one that can no longer reach its kolab ends. A refresh token used once
   * before, past refreshGraceS, is a replay: the grant is revoked and its session ends (D41).
   */
  async refreshGrant(p: { refreshToken: string; clientId: string }): Promise<OAuthTokens> {
    const key = sessionKey(p.refreshToken);
    const access = newSessionToken();
    const refresh = `kjr_${randomBytes(32).toString('base64url')}`;
    let replayed: string | null = null;
    const out = await this.inTransaction(async (tx, signal) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
      const t = (await tx.query<{ grant_id: string; client_id: string; used_long_ago: boolean | null; dead: boolean; scope: string }>(
        `select t.grant_id, g.client_id, (t.used_at is not null and t.used_at < now() - $2 * interval '1 second') as used_long_ago,
                (t.used_at is not null or t.expires_at <= now() or g.revoked_at is not null or g.expires_at <= now()) as dead, g.scope
           from oauth_refresh_token t join oauth_grant g on g.id = t.grant_id where t.key = $1 for update of t`, [key, this.oauth.refreshGraceS])).rows[0];
      if (!t || t.client_id !== p.clientId) return undefined;
      if (t.used_long_ago) { replayed = t.grant_id; return undefined; }
      if (t.dead) return undefined;
      const s = (await tx.query<{ id: string; actor_id: string; kolab_id: string; active_role: Role }>(
        `select id, actor_id, kolab_id, active_role from session where grant_id = $1 and ended_at is null for update`, [t.grant_id])).rows[0];
      if (!s) return undefined;
      if (!(await accessIn(tx, s.actor_id, s.kolab_id)).level) {
        await tx.query(`update session set ended_at = now() where id = $1`, [s.id]);
        await signal({ session: 'ended', id: s.id });
        return 'unreachable' as const;
      }
      await tx.query(`update oauth_refresh_token set used_at = now() where key = $1`, [key]);
      await tx.query(`insert into oauth_refresh_token(key, grant_id, expires_at) values ($1, $2, now() + $3 * interval '1 second')`,
        [sessionKey(refresh), t.grant_id, this.oauth.refreshTtlS]);
      await tx.query(`update oauth_grant set expires_at = now() + $2 * interval '1 second' where id = $1`, [t.grant_id, this.oauth.refreshTtlS]);
      await tx.query(`update session set token_key = $2, expires_at = now() + $3 * interval '1 second' where id = $1`,
        [s.id, sessionKey(access), this.oauth.accessTtlS]);
      return { accessToken: access, refreshToken: refresh, expiresIn: this.oauth.accessTtlS, scope: grantedScope(s.kolab_id, s.active_role), session: s.id, actor: s.actor_id, kolab: s.kolab_id, role: s.active_role };
    });
    if (replayed) await this.revokeGrant(replayed);
    if (out === 'unreachable') throw new OAuthGrantError('invalid_grant', 'this grant\'s actor can no longer reach its kolab; sign in again');
    if (!out) throw new OAuthGrantError('invalid_grant', 'that refresh token is unknown, expired, revoked, already used, or was issued to another client; sign in again');
    return out;
  }

  /**
   * Revokes the grant a refresh token or an access token belongs to (RFC 7009), ending its session
   * so its streams close (D41). A hand-issued token, or one that matches nothing, is left alone,
   * and so is one issued to another client than `clientId` (RFC 7009 §2.1), which the public
   * endpoint always gives. Returns whether a grant was revoked.
   */
  async revokeToken(token: string, opts: { clientId?: string } = {}): Promise<boolean> {
    const key = sessionKey(token);
    const g = (await this.db.query<{ id: string; client_id: string }>(
      token.startsWith('kjr_')
        ? `select g.id, g.client_id from oauth_refresh_token t join oauth_grant g on g.id = t.grant_id where t.key = $1`
        : `select g.id, g.client_id from session s join oauth_grant g on g.id = s.grant_id where s.token_key = $1`, [key])).rows[0];
    if (!g || (opts.clientId !== undefined && opts.clientId !== g.client_id)) return false;
    await this.revokeGrant(g.id);
    return true;
  }

  /** Revokes a grant: no refresh renews it, and its session ends, telling its streams (D41). */
  private async revokeGrant(grantId: string): Promise<void> {
    await this.inTransaction(async (tx, signal) => {
      await tx.query(`update oauth_grant set revoked_at = coalesce(revoked_at, now()) where id = $1`, [grantId]);
      for (const { id } of (await tx.query<{ id: string }>(`update session set ended_at = now() where grant_id = $1 and ended_at is null returning id`, [grantId])).rows) {
        await signal({ session: 'ended', id });
      }
    });
  }

  /**
   * A person makes an agent of their own (D30, D55), `<person>-<label>`, to authorize a harness
   * as. The label is up to 24 lowercase letters, digits and '-'; the name must be free, as any
   * actor's (D52); a person makes at most `oauth.agentsPerPerson` agents, and at most 3 in 10 minutes.
   */
  async addOwnAgent(person: string, label: string): Promise<string> {
    const p = await this.actor(person);
    if (p.kind !== 'person') throw new AccessError(`${person} is an agent: only a person makes agents`);
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(label)) throw new ActorError(`"${label}" isn't a valid agent name: up to 24 lowercase letters, digits and '-', starting with a letter or digit`);
    const id = `${person}-${label}`;
    if (await this.archivedActor(person)) throw new ActorError(`${person} is archived, so it can't own a new agent`);
    // A person or organization already called that (who signed up first, D55) keeps the name; the
    // agent takes another label. Kolab shows every actor's kind and owner, so that person never
    // reads as this one's agent.
    const holder = (await this.db.query<{ kind: string }>(
      `select coalesce(a.kind, o.kind) as kind from (select $1::text as id) n
         left join actor a on lower(a.id) = lower(n.id) left join account o on lower(o.id) = lower(n.id)
        where a.id is not null or o.id is not null`, [id])).rows[0];
    if (holder && holder.kind !== 'agent') {
      throw new NameTakenError(`${id} is ${holder.kind === 'organization' ? 'an organization' : 'a person'} here, not an agent of yours: choose another label`, undefined, 'ActorError');
    }
    try {
      await this.requireFreeName(id, 'ActorError');
      // The cap, the rate (3 in 10 minutes) and the insert run under the access lock, counted in
      // the database, so calls at once, in this process or any other, can't pass either.
      await this.db.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
        const c = (await tx.query<{ owned: number; recent: number }>(
          `select count(*)::int as owned, count(*) filter (where created_at > now() - interval '10 minutes')::int as recent
             from actor where owner_id = $1`, [person])).rows[0];
        if (c.owned >= this.oauth.agentsPerPerson) throw new ActorError(`you have ${c.owned} agents, the most a person may make here (${this.oauth.agentsPerPerson})`);
        if (c.recent >= 3) throw new ActorError(`you made ${c.recent} agents in the last 10 minutes; wait a while before making another`);
        await tx.query(`insert into actor(id, name, kind, owner_id) values ($1, $1, 'agent', $2)`, [id, person]);
      });
    } catch (e) {
      if (/actor_pkey|actor_id_lower/.test(String(e))) throw new NameTakenError(`actor ${id} already exists`, undefined, 'ActorError');
      throw e;
    }
    return id;
  }

  /**
   * Gives a person's own agent access to a kolab where it has none (D30, D56): what its owner
   * holds there, at most Write, on the layers its owner writes, in any kolab the person reaches
   * by owning it, a grant, a team or their organization, an organization's included. The grant
   * stands, but never above its owner: an agent's access is its grant cut down, on every use, to
   * what its owner holds then (D30), so it follows the person's access down, and ends with it. A
   * kolab the person reads only because it is public gives their agents nothing, and no grant is
   * stored there. A grant an admin or the kolab's owners gave the agent stands as it is.
   */
  private async grantOwnAgent(person: string, agent: string, kolab: string) {
    if ((await accessIn(this.db, agent, kolab)).level) return;
    if (!(await accessIn(this.db, person, kolab)).level) throw new AccessError(`no kolab ${kolab} you can reach`);
    // What the person lends an agent: their access without what public visibility alone gives (kj_agent_cap, D56).
    const mine = await ownerAccess(this.db, person, kolab);
    if (!mine.level) {
      throw new AccessError(`you read kolab ${kolab} only because it is public, which gives your agents nothing there (D56): work there as yourself, or ask its owners for a grant`);
    }
    const writes = ACCESS_LEVELS.indexOf(mine.level) >= ACCESS_LEVELS.indexOf('write');
    if (writes && mine.layers.length) await this.grant(kolab, agent, 'write', { layers: mine.layers });
    else await this.grant(kolab, agent, writes ? 'read' : mine.level);
  }

  // ---- invites: a kolab's admins bring people in, with no admin of Konjir's (W3.4, P15) ----

  /**
   * An invite's limits (W3.4): it lasts `ttlS` (7 days) unless it is accepted or revoked first; a
   * kolab holds at most `openPerKolab` open ones; and a person makes at most `perPersonPerHour`,
   * counted in the database, so every Kolab process counts the same.
   */
  readonly invites = { ttlS: 7 * 86_400, openPerKolab: 50, perPersonPerHour: 20 };

  /**
   * A person with Admin in the session's kolab invites someone to it (W3.4): returns the invite's
   * secret, `kji_…`, shown this once (Kolab stores only its key, P1), for a link to hand over. Whoever
   * signs in with it, as a person, is granted `level` there once (acceptInvite). It never grants
   * Admin: the kolab's owners give that. A Write invite names its layers, both by default, as a
   * grant does (TEN8). The admin check, the limits and the insert run under the access lock.
   */
  async createInvite(sessionId: string, input: { level: InviteLevel; layers?: Layer[] }): Promise<{ token: string; invite: InviteView }> {
    const s = await this.session(sessionId);
    if (s.kind !== 'person') throw new AccessError(`${s.actor_id} is an agent: only a person invites people`);
    if (!INVITE_LEVELS.includes(input.level)) {
      throw new TenancyError(`an invite grants one of ${INVITE_LEVELS.join(', ')}: Admin is given by the kolab's owners, never by an invite`);
    }
    const layers = layersOf(input.level, input.layers);
    const token = `kji_${randomBytes(32).toString('base64url')}`;
    const id = `inv_${randomBytes(12).toString('base64url')}`;
    await this.requireLiveKolab(s.kolab, 'takes no invites');
    await this.db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
      const mine = await accessIn(tx, s.actor_id, s.kolab);
      if (mine.level !== 'admin') throw new AccessError(`inviting people to kolab ${s.kolab} needs Admin there; you hold ${describeAccess(mine)}`);
      const c = (await tx.query<{ open: number; recent: number }>(
        `select (select count(*)::int from kolab_invite where kolab_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()) as open,
                (select count(*)::int from kolab_invite where created_by = $2 and created_at > now() - interval '1 hour') as recent`,
        [s.kolab, s.actor_id])).rows[0];
      if (c.open >= this.invites.openPerKolab) throw new TenancyError(`kolab ${s.kolab} has ${c.open} open invites, the most it may hold (${this.invites.openPerKolab}); revoke some first`);
      if (c.recent >= this.invites.perPersonPerHour) throw new TenancyError(`you made ${c.recent} invites in the last hour; wait a while before making another`);
      await tx.query(
        `insert into kolab_invite(id, key, kolab_id, level, functional, technical, created_by, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 second')`,
        [id, sessionKey(token), s.kolab, input.level, layers.includes('functional'), layers.includes('technical'), s.actor_id, this.invites.ttlS]);
    });
    const invite = (await this.inviteRows(s.kolab, id))[0];
    return { token, invite };
  }

  /** The session's kolab's invites, newest first, open and settled, for a person with Admin there (W3.4). */
  async listInvites(sessionId: string): Promise<InviteView[]> {
    const s = await this.requireInviter(sessionId);
    return this.inviteRows(s.kolab);
  }

  /** Revokes an open invite of the session's kolab, by its id, for a person with Admin there (W3.4). */
  async revokeInvite(sessionId: string, id: string): Promise<void> {
    const s = await this.requireInviter(sessionId);
    const r = await this.db.query(
      `update kolab_invite set revoked_at = now()
        where id = $1 and kolab_id = $2 and accepted_at is null and revoked_at is null and expires_at > now() returning id`, [id, s.kolab]);
    if (!r.rows.length) throw new TenancyError(`no open invite ${id} in kolab ${s.kolab}`);
  }

  /**
   * What an invite's link shows whoever holds it (W3.4): its kolab, the access it grants and who made
   * it, while it is still good: not accepted, revoked or expired, its kolab live, and its maker still
   * holding Admin there. Otherwise undefined, saying nothing of which it was.
   */
  async previewInvite(token: string): Promise<InvitePreview | undefined> {
    if (!INVITE_TOKEN.test(token)) return undefined;
    return this.previewInviteByKey(sessionKey(token));
  }

  private async previewInviteByKey(key: string): Promise<InvitePreview | undefined> {
    const r = (await this.db.query<{ kolab_id: string; title: string; owner_id: string; level: InviteLevel; functional: boolean; technical: boolean; created_by: string; expires_at: Date }>(
      `select i.kolab_id, k.title, k.owner_id, i.level, i.functional, i.technical, i.created_by, i.expires_at
         from kolab_invite i join kolab k on k.id = i.kolab_id
        where i.key = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
          and not kj_kolab_archived(i.kolab_id)
          and (select a.rank from kj_access(i.created_by, i.kolab_id) a) = 5`, [key])).rows[0];
    return r && {
      kolab: r.kolab_id, title: r.title, owner: r.owner_id, level: r.level, layers: LAYERS.filter((l) => (l === 'functional' ? r.functional : r.technical)),
      invited_by: r.created_by, expires_at: new Date(r.expires_at).toISOString(),
    };
  }

  /**
   * A person accepts an invite (W3.4): they are granted its access in its kolab, once. It is refused,
   * saying nothing of why, if it is unknown, accepted, revoked or expired, if its kolab is archived,
   * or if whoever made it no longer holds Admin there. It always writes the person's own grant there:
   * their direct grant, if any, raised to cover the invite (the higher level; for Write, the layers
   * of either), so it never lowers a grant, and never leans on access that reaches them only through
   * the kolab being public, a team or a base permission. In an organization's kolab, a person who
   * isn't a member becomes an outside collaborator (TEN10). Only a person accepts one: an agent gets
   * access from its owner (D30, D56). Runs under the access lock, as any change of access does.
   * Returns the kolab, to open a session in.
   */
  async acceptInvite(token: string, person: string): Promise<{ kolab: string; access: Access }> {
    if (!INVITE_TOKEN.test(token)) throw new TenancyError(INVITE_GONE);
    return this.acceptInviteByKey(sessionKey(token), person);
  }

  /** As acceptInvite, by the invite's key; `then` runs in the same transaction, after the grant (the consent's code). */
  private async acceptInviteByKey(key: string, person: string, then?: (tx: Q, kolab: string) => Promise<void>): Promise<{ kolab: string; access: Access }> {
    const p = await this.findActor(person);
    if (!p || p.kind !== 'person') throw new AccessError(`${person} isn't a person: only a person accepts an invite; an agent gets its access from its owner`);
    if (await this.archivedActor(person)) throw new ActorError(`${person} is archived, so it accepts no invite`);
    let kolab: string | undefined;
    await this.changeAccess({ users: [person] }, async (tx) => {
      const inv = (await tx.query<{ id: string; kolab_id: string; level: InviteLevel; functional: boolean; technical: boolean; created_by: string; good: boolean }>(
        `select id, kolab_id, level, functional, technical, created_by,
                (accepted_at is null and revoked_at is null and expires_at > now() and not kj_kolab_archived(kolab_id)) as good
           from kolab_invite where key = $1 for update`, [key])).rows[0];
      if (!inv?.good) throw new TenancyError(INVITE_GONE);
      // Its maker must still hold Admin there, now, in this transaction.
      if ((await accessIn(tx, inv.created_by, inv.kolab_id)).level !== 'admin') throw new TenancyError(INVITE_GONE);
      const want: Access = { level: inv.level, layers: LAYERS.filter((l) => (l === 'functional' ? inv.functional : inv.technical)) };
      // Against the person's own grant there, never what reaches them through the kolab being
      // public, a team or a base permission: the invite's access is theirs to keep, and their
      // agents may borrow it (kj_agent_cap, D56). Raised to cover both, so no grant is lowered.
      const g = (await tx.query<{ level: AccessLevel; functional: boolean; technical: boolean }>(
        `select level, functional, technical from kolab_grant where kolab_id = $1 and user_id = $2`, [inv.kolab_id, person])).rows[0];
      const merged = g ? mergeAccess({ level: g.level, layers: LAYERS.filter((l) => (l === 'functional' ? g.functional : g.technical)) }, want) : { level: inv.level, layers: want.layers };
      await tx.query(`delete from kolab_grant where kolab_id = $1 and user_id = $2`, [inv.kolab_id, person]);
      await tx.query(`insert into kolab_grant(kolab_id, user_id, level, functional, technical) values ($1, $2, $3, $4, $5)`,
        [inv.kolab_id, person, merged.level, merged.layers.includes('functional'), merged.layers.includes('technical')]);
      await tx.query(`update kolab_invite set accepted_by = $2, accepted_at = now() where id = $1`, [inv.id, person]);
      kolab = inv.kolab_id;
      if (then) await then(tx, inv.kolab_id);
    });
    return { kolab: kolab!, access: await accessIn(this.db, person, kolab!) };
  }

  /** A session of a person with Admin in its kolab: who may list and revoke its invites. */
  private async requireInviter(sessionId: string) {
    const s = await this.session(sessionId);
    if (s.kind !== 'person') throw new AccessError(`${s.actor_id} is an agent: only a person manages invites`);
    if (s.access.level !== 'admin') throw new AccessError(`a kolab's invites are for those with Admin there; you hold ${describeAccess(s.access)} in ${s.kolab}`);
    return s;
  }

  private async inviteRows(kolab: string, id?: string): Promise<InviteView[]> {
    const rows = (await this.db.query<{ id: string; kolab_id: string; level: InviteLevel; functional: boolean; technical: boolean; created_by: string; created_at: Date; expires_at: Date; accepted_by: string | null; accepted_at: Date | null; revoked_at: Date | null; expired: boolean }>(
      `select id, kolab_id, level, functional, technical, created_by, created_at, expires_at, accepted_by, accepted_at, revoked_at, expires_at <= now() as expired
         from kolab_invite where kolab_id = $1 and ($2::text is null or id = $2) order by created_at desc, id limit 100`, [kolab, id ?? null])).rows;
    const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString());
    return rows.map((r) => ({
      id: r.id, kolab: r.kolab_id, level: r.level, layers: LAYERS.filter((l) => (l === 'functional' ? r.functional : r.technical)),
      invited_by: r.created_by, created_at: iso(r.created_at)!, expires_at: iso(r.expires_at)!,
      state: r.accepted_at ? 'accepted' as const : r.revoked_at ? 'revoked' as const : r.expired ? 'expired' as const : 'open' as const,
      accepted_by: r.accepted_by, accepted_at: iso(r.accepted_at),
    }));
  }

  // ---- who holds access: a kolab's admins see it and change direct grants (W3.6, API8) ----

  /**
   * Who holds access to the session's kolab, for a person with Admin there (W3.6): each person and
   * agent, with what they hold now (kj_access) and every source of it (owning the kolab, owning
   * its organization, the base permission, an internal kolab's members' Read, a direct grant, a
   * team's grant), and each agent's cap, what its owner lends it (D30, D56). Someone whose direct
   * grant gives nothing now (an agent whose owner lost access) is listed too, so it can be removed.
   * A public kolab's readers are everyone, and are not listed. Teams' grants are listed apart.
   */
  async listAccess(sessionId: string): Promise<KolabAccessView> {
    const s = await this.requireAccessAdmin(sessionId);
    const k = (await this.db.query<{ owner_id: string; owner_kind: 'user' | 'organization'; visibility: Visibility; base_permission: AccessLevel | null }>(
      `select k.owner_id, o.kind as owner_kind, k.visibility, k.base_permission from kolab k join account o on o.id = k.owner_id where k.id = $1`, [s.kolab])).rows[0];
    const holders = await holderRows(this.db, s.kolab);
    const org = k.owner_kind === 'organization' ? k.owner_id : null;
    const members = new Map((await this.db.query<{ user_id: string; role: OrgRole }>(
      `select user_id, role from org_member where org_id = $1`, [org])).rows.map((m) => [m.user_id, m.role]));
    const grants = (await this.db.query<{ user_id: string | null; agent_id: string | null; team_id: string | null; level: AccessLevel; functional: boolean; technical: boolean }>(
      `select user_id, agent_id, team_id, level, functional, technical from kolab_grant where kolab_id = $1`, [s.kolab])).rows;
    const layersOfRow = (g: { functional: boolean; technical: boolean }) => LAYERS.filter((l) => (l === 'functional' ? g.functional : g.technical));
    // Each team granted access here, of the organization that owns the kolab (kj_person_access
    // counts no other), with everyone it reaches: its members and those of every team under it.
    const teamGrants = grants.filter((g) => g.team_id);
    const reach = new Map<string, string[]>();
    for (const g of teamGrants) {
      reach.set(g.team_id!, (await this.db.query<{ user_id: string }>(
        `with recursive sub(id) as (
           select id from team where id = $1 and org_id = $2
           union select t.id from team t join sub on t.parent_id = sub.id
         ) select distinct user_id from team_member where team_id in (select id from sub) order by user_id`, [g.team_id, k.owner_id])).rows.map((r) => r.user_id));
    }
    const out: AccessHolder[] = [];
    for (const h of holders) {
      const sources: AccessSource[] = [];
      const role = h.kind === 'person' ? members.get(h.id) : undefined;
      if (h.kind === 'person') {
        if (k.owner_id === h.id) sources.push({ kind: 'owner', level: 'admin', layers: [...LAYERS] });
        if (org && role === 'owner') sources.push({ kind: 'org_owner', level: 'admin', layers: [...LAYERS], org });
        if (org && role && k.base_permission) sources.push({ kind: 'base', level: k.base_permission, layers: layersOf(k.base_permission), org });
        if (org && role && k.visibility === 'internal') sources.push({ kind: 'internal', level: 'read', layers: [], org });
        for (const g of teamGrants) {
          if (reach.get(g.team_id!)!.includes(h.id)) sources.push({ kind: 'team', level: g.level, layers: layersOfRow(g), team: g.team_id! });
        }
      }
      const own = grants.find((g) => (h.kind === 'person' ? g.user_id : g.agent_id) === h.id);
      const grant: Access | null = own ? { level: own.level, layers: layersOfRow(own) } : null;
      if (own) sources.push({ kind: 'grant', level: own.level, layers: grant!.layers });
      const access = toAccess(h);
      const holder: AccessHolder = { actor: h.id, kind: h.kind, owner: h.owner_id, access, sources, grant, outside: !!(org && h.kind === 'person' && !role && own) };
      if (h.kind === 'agent') {
        holder.cap = await ownerAccess(this.db, h.owner_id!, s.kolab);
        holder.capped = !!grant && (rankOf(access.level) < rankOf(grant.level) || grant.layers.some((l) => !access.layers.includes(l)));
      }
      out.push(holder);
    }
    // Highest access first, then people before agents, then by name.
    out.sort((a, b) => rankOf(b.access.level) - rankOf(a.access.level) || (a.kind === b.kind ? 0 : a.kind === 'person' ? -1 : 1) || a.actor.localeCompare(b.actor));
    return {
      kolab: { id: s.kolab, owner: k.owner_id, owner_kind: k.owner_kind, visibility: k.visibility, base_permission: k.base_permission },
      holders: out,
      teams: teamGrants.map((g) => ({ team: g.team_id!, level: g.level, layers: layersOfRow(g), members: reach.get(g.team_id!)!.length }))
        .sort((a, b) => a.team.localeCompare(b.team)),
    };
  }

  /**
   * Changes a person's or agent's direct grant on the session's kolab (W3.6), for a person with
   * Admin there: to `level`, and at Write, `layers` (both by default, TEN8). Only an existing
   * direct grant: access from owning the kolab, its organization, the base permission or a team
   * is changed where those are kept, and new people come in by invite (ENF7). Admin is given only
   * by the kolab's owners: its owner, or an owner of the organization that owns it. An agent is
   * never granted more than its owner lends it (D30, D56).
   *
   * It runs as every change of access does (changeAccess): under the access lock, exclusively, with
   * the caller's Admin, the kolab being live, and the last-Admin rule checked in that transaction;
   * then, in it, links and forks across kolabs held by the grantee or their agents are marked
   * access_lost where Read went (D53), and sessions, agents' included, that can no longer reach
   * the kolab end, their streams told (D41). Returns how many sessions ended.
   */
  async changeGrant(sessionId: string, actor: string, level: AccessLevel, opts: { layers?: Layer[] } = {}): Promise<{ ended: number }> {
    if (!ACCESS_LEVELS.includes(level)) throw new TenancyError(`a level is one of ${ACCESS_LEVELS.join(', ')}`);
    const layers = layersOf(level, opts.layers);
    return this.changeOwnGrant(sessionId, actor, 'changes no access', async (tx, s, grantee) => {
      if (level === 'admin' && !(await ownsKolab(tx, s.actor_id, s.kolab))) {
        throw new AccessError(`Admin in kolab ${s.kolab} is given by its owners; you hold Admin there, but don't own it: grant up to Maintain`);
      }
      if (grantee.column === 'agent_id') await requireWithinCap(tx, grantee, s.kolab, { level, layers });
      await tx.query(`update kolab_grant set level = $3, functional = $4, technical = $5 where kolab_id = $1 and ${grantee.column} = $2`,
        [s.kolab, grantee.id, level, layers.includes('functional'), layers.includes('technical')]);
    });
  }

  /**
   * Removes a person's or agent's direct grant on the session's kolab (W3.6), for a person with
   * Admin there, as changeGrant runs. Removing a person's grant caps their agents with it: an
   * agent's access is cut, on every use, to what its owner holds (D30, D56), so an agent that
   * borrowed it loses it, and its sessions end if nothing is left. Access the person holds by
   * other routes (a team, the base permission) stays. Returns how many sessions ended.
   */
  async removeGrant(sessionId: string, actor: string): Promise<{ ended: number }> {
    return this.changeOwnGrant(sessionId, actor, 'changes no access', (tx, s, grantee) =>
      tx.query(`delete from kolab_grant where kolab_id = $1 and ${grantee.column} = $2`, [s.kolab, grantee.id]));
  }

  /** A person with Admin in the session's kolab: who may see and change who holds access there (W3.6). */
  private async requireAccessAdmin(sessionId: string) {
    const s = await this.session(sessionId);
    if (s.kind !== 'person') throw new AccessError(`${s.actor_id} is an agent: only a person manages who holds access to a kolab`);
    if (s.access.level !== 'admin') throw new AccessError(`who holds access to kolab ${s.kolab} is for those with Admin there; you hold ${describeAccess(s.access)}`);
    return s;
  }

  /**
   * Changes `actor`'s direct grant on the session's kolab with `write`, under the access lock, with
   * every check in the same transaction: the kolab is live (D52), the caller still holds Admin
   * there, `actor` is a person or agent with a direct grant there, and afterwards some person still
   * holds Admin there.
   */
  private async changeOwnGrant(sessionId: string, actor: string, what: string,
    write: (tx: Db, s: Session, grantee: { column: 'user_id' | 'agent_id'; id: string; owner?: string }) => Promise<unknown>): Promise<{ ended: number }> {
    const s = await this.requireAccessAdmin(sessionId);
    if (typeof actor !== 'string' || actor.includes('/')) {
      throw new TenancyError(`a team's access is its grant to the team, kept with the organization's teams, not changed here`);
    }
    const a = await this.findActor(actor);
    if (!a) throw new TenancyError(`no person or agent ${actor} holds a grant in kolab ${s.kolab}`);
    const grantee = a.kind === 'person' ? { column: 'user_id' as const, id: actor } : { column: 'agent_id' as const, id: actor, owner: a.owner! };
    await this.requireLiveKolab(s.kolab, what);
    return this.changeAccess({ users: [actor] }, async (tx) => {
      // Again, now, under the lock: an archive or another admin's change may have come first.
      if ((await tx.query<{ archived: boolean }>(`select kj_kolab_archived($1) as archived`, [s.kolab])).rows[0].archived) {
        throw new TenancyError(`kolab ${s.kolab} is archived, so it ${what}`);
      }
      const mine = await accessIn(tx, s.actor_id, s.kolab);
      if (mine.level !== 'admin') throw new AccessError(`changing who holds access to kolab ${s.kolab} needs Admin there; you hold ${describeAccess(mine)}`);
      if (!(await tx.query(`select 1 from kolab_grant where kolab_id = $1 and ${grantee.column} = $2`, [s.kolab, actor])).rows.length) {
        throw new TenancyError(`${actor} holds no direct grant in kolab ${s.kolab}; access from owning it, its organization, the base permission or a team is changed where those are kept`);
      }
      await write(tx, s, grantee);
      if (!(await holderRows(tx, s.kolab)).some((h) => h.kind === 'person' && h.rank === 5)) {
        throw new AccessError(`that would leave kolab ${s.kolab} with nobody holding Admin: give someone else Admin first`);
      }
    });
  }

  // ---- accounts, kolabs, teams and grants (TEN1–TEN11) -----------------------

  private async findAccount(id: string) {
    return (await this.db.query<{ id: string; kind: 'user' | 'organization'; archived: boolean }>(
      `select id, kind, archived_at is not null as archived from account where id = $1`, [id])).rows[0];
  }

  /**
   * Refuses a new person, agent or organization a name that any account or actor holds, live or
   * archived, in any case: people, agents and organizations share one namespace, and an archived
   * name stays reserved (D52). The refusal reads the same either way (NameTakenError).
   */
  private async requireFreeName(id: string, errorName: 'TenancyError' | 'ActorError' = 'TenancyError') {
    const h = (await this.db.query<{ id: string; what: 'actor' | 'account'; kind: string; archived: boolean }>(
      `select a.id, 'actor' as what, a.kind, kj_actor_archived(a.id) as archived from actor a where lower(a.id) = lower($1)
       union all
       select o.id, 'account', o.kind, o.archived_at is not null from account o
        where lower(o.id) = lower($1) and not exists (select 1 from actor a where a.id = o.id)`, [id])).rows[0];
    if (!h) return;
    const archived = h.archived ? { kind: (h.kind === 'organization' ? 'organization' : 'actor') as Archivable, id: h.id } : undefined;
    if (h.id !== id) throw new NameTakenError(`the name ${id} is taken: ${h.id} holds it, and names must differ in more than case`, archived, errorName);
    // An organization is refused by the account a person holds; a person or agent by the actor.
    const account = h.what === 'account' || (errorName === 'TenancyError' && h.kind === 'person');
    throw new NameTakenError(account ? `account ${id} already exists` : `actor ${id} already exists`, archived, errorName);
  }

  /** Registers an organization: an account that owns kolabs and agents, with members and teams. */
  async addOrganization(id: string, opts: { name?: string } = {}) {
    if (!ACTOR_ID.test(id) || id === SYSTEM_ACTOR) throw new TenancyError(`"${id}" isn't a valid account id: use letters, digits, '.', '_', '-' and '@', starting with a letter or digit`);
    await this.requireFreeName(id);
    try {
      await this.db.query(`insert into account(id, kind, name) values ($1, 'organization', $2)`, [id, opts.name ?? id]);
    } catch (e) {
      if (/account_pkey|account_id_lower/.test(String(e))) throw new NameTakenError(`account ${id} already exists`);
      throw e;
    }
  }

  private async requireAccount(id: string, kind?: 'user' | 'organization') {
    const a = await this.findAccount(id);
    if (!a) throw new TenancyError(`no account ${id}`);
    if (kind && a.kind !== kind) throw new TenancyError(`${id} is ${a.kind === 'user' ? 'a user' : 'an organization'}, not ${kind === 'user' ? 'a user' : 'an organization'}`);
    return a;
  }

  /** An account that isn't archived, for something that would use it: `what` says what an archived one can't do. */
  private async requireLiveAccount(id: string, kind: 'user' | 'organization' | undefined, what: string) {
    const a = await this.requireAccount(id, kind);
    if (a.archived) throw new TenancyError(`${a.kind === 'organization' ? 'organization ' : ''}${id} is archived, so it ${what}; unarchive it first`);
    return a;
  }

  private async requireKolab(name: string): Promise<KolabRow & { archived: boolean }> {
    const k = (await this.db.query<KolabRow & { archived: boolean }>(
      `select id, owner_id as owner, title, visibility, base_permission, kj_kolab_archived(id) as archived from kolab where id = $1`, [name])).rows[0];
    if (!k) throw new TenancyError(`no kolab ${name}`);
    return k;
  }

  /**
   * A kolab that isn't archived, for something that would use or change it: `what` says what an
   * archived one doesn't do (D52). Says whether the kolab or its owner is the one archived.
   */
  private async requireLiveKolab(name: string, what: string): Promise<KolabRow & { archived: boolean }> {
    const k = await this.requireKolab(name);
    if (k.archived) {
      const own = (await this.db.query(`select 1 from kolab where id = $1 and archived_at is not null`, [name])).rows.length > 0;
      throw new TenancyError(own
        ? `kolab ${name} is archived, so it ${what}; its data is kept, and an admin can unarchive it`
        : `kolab ${name} is archived with its owner ${k.owner}, so it ${what}; unarchive ${k.owner} to restore it`);
    }
    return k;
  }

  // ---- archiving (D52) -------------------------------------------------------

  /**
   * Archives a kolab, an organization or an actor (D52). An archived one is left out of listings
   * and can't be used, its data is kept for audit, and its name stays reserved: nothing is
   * deleted. Archiving an organization archives its kolabs and its agents with it, and every
   * grant and membership stops counting in those kolabs. Archiving a person archives their agents;
   * the kolabs they own stay live for the others who work there (D52). Each archive and unarchive
   * is logged, with `by` and its time, in archive_event, which is only ever added to. In the same
   * transaction, every open session that can no longer reach its kolab ends, and its streams are
   * told (D41): the kolab's sessions, the actor's, and a person's or organization's agents'. The
   * database refuses every write to an archived kolab's data, and every session for it or for an
   * archived actor, whatever role writes (0014).
   */
  async archive(target: ArchiveTarget, opts: { by?: string } = {}): Promise<{ archived: ArchiveTarget; kolabs: string[]; agents: string[]; ended: number }> {
    return this.setArchived(target, true, opts.by ?? 'admin');
  }

  /**
   * Unarchives what `archive` archived, restoring it as it was: its grants and memberships count
   * again, and what it owns that wasn't archived on its own comes back with it. Sessions that
   * ended stay ended; open new ones. A kolab or an agent archived with its owner comes back with
   * the owner, so unarchiving it alone is refused, naming the owner.
   */
  async unarchive(target: ArchiveTarget, opts: { by?: string } = {}): Promise<{ unarchived: ArchiveTarget; kolabs: string[]; agents: string[] }> {
    const r = await this.setArchived(target, false, opts.by ?? 'admin');
    // Outbox jobs of the kolabs it restores waited, unclaimed (claimJob): they are due again.
    this.wake();
    return { unarchived: r.archived, kolabs: r.kolabs, agents: r.agents };
  }

  private async setArchived(target: ArchiveTarget, archive: boolean, by: string): Promise<{ archived: ArchiveTarget; kolabs: string[]; agents: string[]; ended: number }> {
    const [kind, name] = Object.entries(target)[0] as [Archivable, string];
    const already = (what: string) => new TenancyError(archive ? `${what} is already archived` : `${what} isn't archived`);
    const stamp = archive ? 'now()' : 'null';
    const which = archive ? 'archived_at is null' : 'archived_at is not null';
    // Checked, changed and logged in one transaction under the access lock, so two admins at once
    // can't both pass a check, and the second never overwrites the first's archived_at.
    const r = await this.inTransaction(async (tx, signal) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
      const orgArchived = async (id: string) => (await tx.query(
        `select 1 from account where id = $1 and kind = 'organization' and archived_at is not null`, [id])).rows.length > 0;
      let changed: { rows: unknown[] };
      let owner: string | undefined;   // an account whose agents (and, for an organization, kolabs) go or come back with it
      let org = false;
      if (kind === 'kolab') {
        const k = (await tx.query<{ owner: string }>(`select owner_id as owner from kolab where id = $1`, [name])).rows[0];
        if (!k) throw new TenancyError(`no kolab ${name}`);
        changed = await tx.query(`update kolab set archived_at = ${stamp} where id = $1 and ${which} returning id`, [name]);
        if (!changed.rows.length) throw already(`kolab ${name}`);
        // Rolled back with the transaction: it comes back with its owner.
        if (!archive && await orgArchived(k.owner)) throw new TenancyError(`the owner of kolab ${name}, ${k.owner}, is archived too; unarchive ${k.owner}, then kolab ${name}`);
      } else if (kind === 'organization') {
        const a = (await tx.query<{ kind: string }>(`select kind from account where id = $1`, [name])).rows[0];
        if (!a) throw new TenancyError(`no account ${name}`);
        if (a.kind !== 'organization') throw new TenancyError(`${name} is a user, not an organization: name it as actor=${name}`);
        changed = await tx.query(`update account set archived_at = ${stamp} where id = $1 and ${which} returning id`, [name]);
        if (!changed.rows.length) throw already(`organization ${name}`);
        owner = name; org = true;
      } else {
        const a = (await tx.query<{ kind: ActorKind; owner: string | null }>(`select kind, owner_id as owner from actor where id = $1`, [name])).rows[0];
        if (!a) {
          if ((await tx.query(`select 1 from account where id = $1 and kind = 'organization'`, [name])).rows.length) {
            throw new TenancyError(`${name} is an organization: name it as organization=${name}`);
          }
          throw new ActorError(`no actor ${name}`);
        }
        if (a.kind === 'person') {
          changed = await tx.query(`update account set archived_at = ${stamp} where id = $1 and ${which} returning id`, [name]);
          owner = name;
        } else {
          changed = await tx.query(`update actor set archived_at = ${stamp} where id = $1 and ${which} returning id`, [name]);
          if (!changed.rows.length) throw already(name);
          if (!archive && (await tx.query(`select 1 from account where id = $1 and archived_at is not null`, [a.owner])).rows.length) {
            throw new TenancyError(`${name}'s owner ${a.owner} is archived too; unarchive ${a.owner}, then ${name}`);
          }
        }
        if (!changed.rows.length) throw already(name);
      }
      // What goes, or comes back, with an account: its agents, and an organization's kolabs, not archived on their own.
      const kolabs = !org ? [] : (await tx.query<{ id: string }>(
        `select id from kolab where owner_id = $1 and archived_at is null order by id`, [owner])).rows.map((x) => x.id);
      const agents = owner === undefined ? [] : (await tx.query<{ id: string }>(
        `select id from actor where owner_id = $1 and archived_at is null order by id`, [owner])).rows.map((x) => x.id);
      await tx.query(`insert into archive_event(target_kind, target_id, archived, done_by) values ($1, $2, $3, $4)`, [kind, name, archive, by]);
      // Links and forks across kolabs whose holders' access this changes, or whose own kolab or
      // other kolab it archives or brings back, are marked or settled now (LNK8, D52, D53).
      const holders = await archiveHoldersOf(tx, kind, name, kind === 'kolab' ? [name] : kolabs);
      const catchUps = await this.reconcileAccessIn(tx, signal, holders);
      if (!archive || catchUps.length) await this.notifyWork(tx);   // every process's worker: the jobs it restores are due again
      return { kolabs, agents, ended: await endUnreachableIn(tx, signal), catchUps };
    });
    if (r.catchUps.length) this.wake();
    console.error(`kolab: ${kind} ${name} ${archive ? 'archived' : 'unarchived'} by ${by}`
      + (r.kolabs.length ? `, with kolabs ${r.kolabs.join(', ')}` : '') + (r.agents.length ? `, with agents ${r.agents.join(', ')}` : '')
      + (r.ended ? `; ${r.ended} session${r.ended === 1 ? '' : 's'} ended` : ''));
    const { catchUps: _c, ...out } = r;
    return { archived: target, ...out };
  }

  /**
   * How many kolabs a person may own (`max`), and how many they may make in a window (`burst` per
   * `windowMs`, counted in the database) when they make one themselves (createOwnKolab, D54).
   * The admin's createKolab has no such limits.
   */
  readonly ownKolabs = { max: 10, burst: 3, windowMs: 10 * 60_000 };

  /**
   * A person makes a private kolab of their own (D54; TEN2, TEN3), from a session that holds at
   * least Write in its kolab, so a reader invited to look can't. Its name follows the kolab
   * grammar, at most 40 characters, is unique across Konjir (TEN4) and is none of the reserved
   * names (`kolab`, and anything starting `konjir`, such as D15's konjir-site and konjir-brand).
   * Its title is at most 100 characters. A person owns at most `ownKolabs.max` kolabs and makes at
   * most `ownKolabs.burst` in a window. The count and the insert run under the access lock, so two
   * calls at once can't both pass the cap.
   */
  async createOwnKolab(sessionId: string, name: string, opts: { title: string }): Promise<void> {
    const s = await this.session(sessionId);
    if (s.kind !== 'person') throw new AccessError(`${s.actor_id} is an agent: only a person makes a kolab of their own`);
    if (!s.access.level || ACCESS_LEVELS.indexOf(s.access.level) < ACCESS_LEVELS.indexOf('write')) {
      throw new AccessError(`making a kolab needs Write where you work; you hold ${describeAccess(s.access)} in ${s.kolab}`);
    }
    await this.makeOwnKolab(s.actor_id, name, opts.title);
  }

  /**
   * A private kolab owned by `person`, with createOwnKolab's limits but the session's: the name
   * grammar and reserved names, the title, the cap per person and the rate. A person signing in
   * makes one this way (D54, D55): someone new has no kolab to hold Write in yet.
   */
  async makeOwnKolab(person: string, name: string, titleGiven: string): Promise<void> {
    const p = await this.actor(person);
    if (p.kind !== 'person') throw new AccessError(`${person} is an agent: only a person makes a kolab of their own`);
    if (await this.archivedActor(person)) throw new AccessError(`${person} is archived, so it owns no new kolab`);
    const s = { actor_id: person };
    if (!isKolabName(name) || name.length > 40) throw new TenancyError(`"${name}" isn't a valid kolab name: up to 40 lowercase letters, digits and '-', starting with a letter or digit`);
    if (isReservedKolabName(name)) throw new TenancyError(`the kolab name ${name} is reserved for Konjir's own kolabs; choose another`);
    const title = titleGiven.trim();
    if (!title || title.length > 100) throw new TenancyError('a kolab\'s title is 1 to 100 characters');
    try {
      // The cap, the rate and the insert run under the access lock, counted in the database, so
      // calls at once, in this process or any other, can't pass either.
      await this.db.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
        const c = (await tx.query<{ owned: number; recent: number }>(
          `select count(*)::int as owned, count(*) filter (where created_at > now() - $2 * interval '1 millisecond')::int as recent
             from kolab where owner_id = $1`, [s.actor_id, this.ownKolabs.windowMs])).rows[0];
        if (c.recent >= this.ownKolabs.burst) {
          throw new TenancyError(`you made ${c.recent} kolabs in the last ${Math.round(this.ownKolabs.windowMs / 60_000)} minutes; wait a while before making another`);
        }
        const owned = c.owned;
        if (owned >= this.ownKolabs.max) throw new TenancyError(`you own ${owned} kolabs, the most a person may own here (${this.ownKolabs.max})`);
        if ((await tx.query(`select 1 from kolab where id = $1`, [name])).rows.length) throw new TenancyError(`the kolab name ${name} is taken: kolab names are unique across all of Konjir`);
        await tx.query(`insert into kolab(id, owner_id, title, visibility) values ($1, $2, $3, 'private')`, [name, s.actor_id, title]);
      });
    } catch (e) {
      if (String(e).includes('kolab_pkey')) throw new TenancyError(`the kolab name ${name} is taken: kolab names are unique across all of Konjir`);
      throw e;
    }
  }

  /**
   * Moves a session's actor to another kolab or role (the web interface's kolab picker and role
   * switch): in one transaction under the access lock, the session ends, a new one opens and its
   * access is checked, so either both happen or neither does, and the old session's end is
   * signalled only once that commits (D41). Returns the new session's token.
   */
  async switchSession(sessionId: string, to: { kolab: string; role: Role }): Promise<string> {
    if (!ROLES.includes(to.role)) throw new RoleError(`a role is one of ${ROLES.join(', ')}`);
    await this.requireKolab(to.kolab);
    const token = newSessionToken();
    await this.inTransaction(async (tx, signal) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
      const old = (await tx.query<{ id: string; actor_id: string; grant_id: string | null }>(
        `update session s set ended_at = now() where ${LIVE_SESSION} returning s.id, s.actor_id, s.grant_id`, [sessionKey(sessionId)])).rows[0];
      if (!old) throw new RoleError('this session has ended');
      // Access first, so an archived kolab is refused as any other it can't reach, saying nothing of the archive (D52).
      if (!(await accessIn(tx, old.actor_id, to.kolab)).level) throw new AccessError(`no kolab ${to.kolab} you can reach`);
      // A grant's session moves with its grant (D55): the new one carries it, with a fresh access token, so the refresh token keeps working.
      await insertSession(tx, token, { actor: old.actor_id, role: to.role, kolab: to.kolab, grant: old.grant_id, ttlS: this.oauth.accessTtlS });
      await signal({ session: 'ended', id: old.id });
    });
    return token;
  }

  /**
   * Creates a kolab owned by an account. Its name is unique across all of Konjir (TEN4), so
   * one taken by any other account, or by an archived kolab, is refused (NameTakenError).
   */
  async createKolab(name: string, opts: { owner: string; title?: string; visibility?: Visibility; base?: AccessLevel }) {
    if (!isKolabName(name)) throw new TenancyError(`"${name}" isn't a valid kolab name: use lowercase letters, digits and '-', starting with a letter or digit`);
    if (opts.visibility !== undefined && !VISIBILITIES.includes(opts.visibility)) throw new TenancyError(`visibility is one of ${VISIBILITIES.join(', ')}`);
    if (opts.base !== undefined && !ACCESS_LEVELS.includes(opts.base)) throw new TenancyError(`a base permission is one of ${ACCESS_LEVELS.join(', ')}`);
    const owner = await this.requireLiveAccount(opts.owner, undefined, 'owns no new kolab');
    if (opts.base !== undefined && owner.kind !== 'organization') throw new TenancyError('only an organization\'s kolab has a base permission');
    const taken = (archived?: boolean) => new NameTakenError(`the kolab name ${name} is taken: kolab names are unique across all of Konjir`,
      archived ? { kind: 'kolab', id: name } : undefined);
    const existing = (await this.db.query<{ archived: boolean }>(`select kj_kolab_archived(id) as archived from kolab where id = $1`, [name])).rows[0];
    if (existing) throw taken(existing.archived);
    try {
      await this.db.query(`insert into kolab(id, owner_id, title, visibility, base_permission) values ($1, $2, $3, $4, $5)`,
        [name, opts.owner, opts.title ?? name, opts.visibility ?? 'private', opts.base ?? null]);
    } catch (e) {
      if (String(e).includes('kolab_pkey')) throw taken();   // made by another call since the check
      throw e;
    }
  }

  /**
   * Every kolab, or with `owner` that account's. Archived kolabs, and those of an archived account,
   * are left out (D52); with `archived`, they are listed too, and every kolab says whether it is
   * archived.
   */
  /** One kolab, by its name, unless it is archived (D52). Kolab's own read: the caller checks who may see it. */
  async kolabRow(id: string): Promise<KolabRow | undefined> {
    return (await this.db.query<KolabRow>(
      `select id, owner_id as owner, title, visibility, base_permission from kolab where id = $1 and not kj_kolab_archived(id)`, [id])).rows[0];
  }

  async listKolabs(opts: { owner?: string; archived?: boolean } = {}): Promise<KolabRow[]> {
    const rows = (await this.db.query<KolabRow & { archived: boolean }>(
      `select id, owner_id as owner, title, visibility, base_permission, kj_kolab_archived(id) as archived from kolab
        where $1::text is null or owner_id = $1 order by id`, [opts.owner ?? null])).rows;
    return opts.archived ? rows : rows.filter((k) => !k.archived).map(({ archived: _, ...k }) => k);
  }

  /** Adds a user to an organization, or changes their role in it. Owners administer every kolab it owns. */
  async addMember(org: string, user: string, role: OrgRole = 'member') {
    if (!ORG_ROLES.includes(role)) throw new TenancyError(`a member's role is one of ${ORG_ROLES.join(', ')}`);
    await this.requireLiveAccount(org, 'organization', 'takes no members');
    await this.requireLiveAccount(user, 'user', 'joins no organization');
    return this.changeAccess({ users: [user] }, (tx) => tx.query(
      `insert into org_member(org_id, user_id, role) values ($1, $2, $3)
       on conflict (org_id, user_id) do update set role = excluded.role`, [org, user, role]));
  }

  /** Removes a user from an organization and its teams. Their sessions narrow, or end if nothing is left. */
  async removeMember(org: string, user: string) {
    await this.requireAccount(org, 'organization');
    return this.changeAccess({ users: [user] }, async (tx) => {
      await tx.query(`delete from team_member where user_id = $2 and team_id in (select id from team where org_id = $1)`, [org, user]);
      await tx.query(`delete from org_member where org_id = $1 and user_id = $2`, [org, user]);
    });
  }

  /** Creates a team in an organization, under `parent` (a team of the same organization) if given. Returns its id, `<org>/<name>`. */
  async addTeam(org: string, name: string, opts: { parent?: string } = {}): Promise<string> {
    if (!TEAM_NAME.test(name)) throw new TenancyError(`"${name}" isn't a valid team name: use lowercase letters, digits and '-', starting with a letter or digit`);
    await this.requireLiveAccount(org, 'organization', 'gets no new team');
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
    await this.requireLiveAccount(t.org_id, 'organization', 'adds no team members');
    await this.requireLiveAccount(user, 'user', 'joins no team');
    if (!(await this.db.query(`select 1 from org_member where org_id = $1 and user_id = $2`, [t.org_id, user])).rows.length) {
      throw new TenancyError(`${user} isn't a member of ${t.org_id}; add them to it first`);
    }
    return this.changeAccess({ users: [user] }, (tx) => tx.query(`insert into team_member(team_id, user_id) values ($1, $2) on conflict do nothing`, [team, user]));
  }

  /** Removes a user from a team. Their sessions narrow, or end if nothing is left. */
  async removeTeamMember(team: string, user: string) {
    if (!(await this.db.query(`select 1 from team where id = $1`, [team])).rows.length) throw new TenancyError(`no team ${team}`);
    return this.changeAccess({ users: [user] }, (tx) => tx.query(`delete from team_member where team_id = $1 and user_id = $2`, [team, user]));
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
    const k = await this.requireLiveKolab(kolab, 'grants no access');
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
    if (grantee.column !== 'team_id' && await this.archivedActor(to)) throw new TenancyError(`${to} is archived, so it is granted nothing; unarchive it first`);
    return this.changeAccess(granted(grantee), async (tx) => {
      // Against what its owner holds now, in this transaction.
      if (grantee.column === 'agent_id') await requireWithinCap(tx, grantee, kolab, { level, layers });
      await tx.query(`delete from kolab_grant where kolab_id = $1 and ${grantee.column} = $2`, [kolab, grantee.id]);
      await tx.query(`insert into kolab_grant(kolab_id, ${grantee.column}, level, functional, technical) values ($1, $2, $3, $4, $5)`,
        [kolab, grantee.id, level, layers.includes('functional'), layers.includes('technical')]);
    });
  }

  /** Removes a grantee's grant on a kolab. Sessions narrow, and any that can no longer reach it end. */
  async revoke(kolab: string, to: string) {
    const grantee = await this.grantee(to, await this.requireKolab(kolab));
    return this.changeAccess(granted(grantee), (tx) => tx.query(`delete from kolab_grant where kolab_id = $1 and ${grantee.column} = $2`, [kolab, grantee.id]));
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
  private async changeAccess(who: Affected, fn: (tx: Db) => Promise<unknown>): Promise<{ ended: number }> {
    const r = await this.inTransaction(async (tx, signal) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
      // Who the change can affect, found before it, while the team it may remove is still there.
      const holders = await holdersOf(tx, who);
      await fn(tx);
      // Links and forks across kolabs that they hold are marked, or settle, as access changes (LNK8).
      const catchUps = await this.reconcileAccessIn(tx, signal, holders);
      if (catchUps.length) await this.notifyWork(tx);
      return { ended: await endUnreachableIn(tx, signal), catchUps };
    });
    if (r.catchUps.length) this.wake();
    return { ended: r.ended };
  }

  /**
   * Ends every open session that can no longer reach its kolab, and tells listeners (D41); and
   * marks the links and forks across kolabs held by `actors`, found with no access, after a change
   * made outside Kolab's verbs (LNK8).
   */
  private async endUnreachable(actors: string[]): Promise<number> {
    const r = await this.inTransaction(async (tx, signal) => {
      await tx.query(`select pg_advisory_xact_lock($1)`, [ACCESS_LOCK]);
      const holders = await holdersOf(tx, { users: actors });
      const catchUps = await this.reconcileAccessIn(tx, signal, holders);
      if (catchUps.length) await this.notifyWork(tx);
      return { ended: await endUnreachableIn(tx, signal), catchUps };
    });
    if (r.catchUps.length) this.wake();
    return r.ended;
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
    input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string; unlink?: LinkRef[] }): Promise<string> {
    await this.requireNodeIn(sessionId, nodeId);   // another kolab's node reads as no node at all
    const node = await this.node(nodeId);
    const s = await this.requireLayer(sessionId, node.layer, node.kolab_id);
    return this.writeDraft(nodeId, node.layer, s, input, (fn, access) => this.asAgent(sessionId, fn, nodeId, { access }));
  }

  /**
   * Applies a ruling of Lee's to a node (D47): a new version, written as `actor` in the role that
   * writes the node's layer, that commits after structural checks only, with no review request,
   * as Kolab's own rebases do (VER12): the ruling is already the approval. Only the admin token
   * reaches it (konjir_admin_apply_ruling); an agent session never does. It goes through the same
   * per-node commit step as any other commit, so a stale one is rejected (CAS7), and its note
   * records the ruling and who applied it.
   */
  async applyRuling(nodeId: string, input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string; unlink?: LinkRef[] },
    ruling: { id: string; actor: string }): Promise<GateResult> {
    if (!/^D\d+$/.test(ruling.id)) throw new GateError(`a ruling is named by its Decisions Log ID, such as D47, not "${ruling.id}"`);
    const node = await this.node(nodeId);
    await this.actor(ruling.actor);
    await this.requireLiveKolab(node.kolab_id, 'takes no ruling');
    if (await this.archivedActor(ruling.actor)) throw new ActorError(`${ruling.actor} is archived, so nothing is written as it; apply the ruling as another actor`);
    // The actor it is written as must be able to write that layer there: refused before anything is written.
    const access = await accessIn(this.db, ruling.actor, node.kolab_id);
    if (!access.layers.includes(node.layer)) {
      throw new AccessError(`${ruling.actor} may not write the ${node.layer} layer of kolab ${node.kolab_id}: it holds ${describeAccess(access)}; apply the ruling as an actor that does`);
    }
    const author = { actor_id: ruling.actor, active_role: ROLE_OF_LAYER[node.layer], kolab: node.kolab_id };
    const id = await this.writeDraft(nodeId, node.layer, author, input, (fn, access) => this.asSystem(fn, nodeId, { access }));
    return this.judge(id, undefined, ruling.id);
  }

  /**
   * A draft's version, with its elements and deltas, and the links it drops (`unlink`, which name
   * links of the version it is built on), written by `as` (an agent's session, or Kolab).
   */
  private async writeDraft(nodeId: string, layer: Layer, s: { actor_id: string; active_role: string; kolab: string },
    input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string; unlink?: LinkRef[] },
    as: (fn: (tx: Q, signal: Signal) => Promise<void>, access: boolean) => Promise<void>): Promise<string> {

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
    let heldBy: string | null = null;
    if (parentId) {
      const p = await this.version(parentId);
      // A variant of another kolab's committed version is a fork (KON9), which rests on its
      // holder's Read there (LNK8): the author's, if they hold it now; otherwise the holder of the
      // node's version already on this parent, carried, since this drafts nothing of the other
      // kolab's that the node doesn't hold already. Anything else reads as a version that isn't there.
      if (p.kolab_id !== s.kolab) {
        const carried = (await this.db.query<{ parent_held_by: string }>(
          `select parent_held_by from version where node_id = $1 and state = 'committed' and parent_version_id = $2
            order by seq desc limit 1`, [nodeId, parentId])).rows[0]?.parent_held_by;
        if (p.state === 'committed' && (await this.holds(s.actor_id, p.kolab_id!))) heldBy = s.actor_id;
        else if (carried) heldBy = carried;
        else throw new Error(`no version ${parentId}`);
      }
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
    const removals = input.unlink?.length ? await this.linkIdentities(nodeId, latest?.id ?? null, null, input.unlink) : [];
    const id = ulid();
    // Built on the live version read above: if the node moves on before this commits, review sees it.
    // A fork is written under a shared hold on the access lock, so the Read it rests on can't be
    // revoked between the check (row-level security's, as it inserts) and its commit (LNK8).
    await as(async (tx) => {
      await writeVersion(tx, {
        id, node_id: nodeId, seq: await nextSeq(tx, nodeId), parent_version_id: parentId, base_version_id: latest?.id ?? null,
        layer, actor_id: s.actor_id, active_role: s.active_role, parent_held_by: heldBy,
      }, els, deltaRows);
      await applyRemovals(tx, id, removals);
    }, heldBy !== null);
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
    if (newer) return this.settle(v, newer, approvedBy, ruling);
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
        if (late) return this.settle(v, late);
        return { ok: false, note: inReview, version: versionId, in_review: true, reviewers };
      }
      unreviewed = true;
      note = `${note ?? ''} ${NO_REVIEWER(v.layer)}`.trim();
    }
    // The node may have moved on while the checks ran.
    const late = await this.commitStep(v, note, {
      ...(approvedBy ? { record: (tx: Q, signal: Signal, overtaken: boolean) => this.foldRecord(tx, signal, v, overtaken) } : {}),
      ...(this.settlesDurably(v) ? { settle: { ruling } } : {}),
    });
    if (isRefused(late)) return { ok: false, note: late.refused, version: versionId };
    if (!isCommitted(late)) return this.settle(v, late as Overtaker[], approvedBy, ruling);
    const after = await this.afterCommitNow(v, late);
    return { ok: true, note: note ?? undefined, version: versionId, ...(unreviewed ? { unreviewed } : {}), ...after };
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
        await signal({ inbox: 'layer', kolab: v.kolab_id, layer: v.layer });
        await signal({ inbox: 'actor', kolab: v.kolab_id, actor: v.actor_id });
      }, v.node_id);
      return { ok: false, note: `Still in review: waiting for one approval from ${reviewers.join(', ')}.`, version: v.id, in_review: true, reviewers };
    }
    const verdict = await this.checks(await this.checkContext(v));
    if (!verdict.ok) return { ...verdict, version: v.id, in_review: true };
    const note = `${verdict.note ?? ''} Everyone who could review it has gone: ${NO_REVIEWER(v.layer)}`.trim();
    const late = await this.commitStep(v, note, { from: 'in_review' });
    if (isRefused(late)) return { ok: false, note: late.refused, version: v.id };
    if (!isCommitted(late)) return this.settle(v, late as Overtaker[]);
    const after = await this.afterCommitNow(v, late);
    return { ok: true, note, version: v.id, unreviewed: true, ...after };
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
    const o = (await tx.query<{ state: VersionState; review_note: string | null; node_id: string; seq: number; layer: Layer; actor_id: string; kolab_id: string }>(
      `select state, review_note, node_id, seq, layer, actor_id, kolab_id from version where id = $1`, [v.folded_from])).rows[0];
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
    await signal({ inbox: 'layer', kolab: o.kolab_id, layer: o.layer });
    await signal({ inbox: 'actor', kolab: o.kolab_id, actor: o.actor_id });
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
      await signal({ inbox: 'layer', kolab: v.kolab_id, layer: v.layer });
      await signal({ inbox: 'actor', kolab: v.kolab_id, actor: v.actor_id });
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
        await signal({ inbox: 'layer', kolab: v.kolab_id, layer: v.layer });
        await signal({ inbox: 'actor', kolab: v.kolab_id, actor: v.actor_id });
      }, v.node_id);
      return { ok: false, note: `Changes requested by ${s.actor_id}${said}`, version: v.id, findings };
    }

    const note = `Approved by ${s.actor_id}${said}`;
    const late = await this.commitStep(v, note, {
      from: 'in_review',
      settle: { approvedBy: s.actor_id },
      record: async (tx, signal) => {
        await record(tx, 'approved');
        const approvals = await tx.query<{ n: number }>(
          `select count(*)::int as n from review_request where version_id = $1 and state = 'approved'`, [v.id]);
        await signal({ inbox: 'layer', kolab: v.kolab_id, layer: v.layer });
        await signal({ inbox: 'actor', kolab: v.kolab_id, actor: v.actor_id });
        return approvals.rows[0].n >= REQUIRED_APPROVALS;
      },
    });
    if (late === 'waiting') return { ok: false, note: `${note} More approvals are needed.`, version: v.id, in_review: true };
    if (isRefused(late)) return { ok: false, note: late.refused, version: v.id };
    // Overtaken while it waited: the approval stands, and its settle job folds or rejects it.
    if (!isCommitted(late)) return this.settle(v, late, s.actor_id);
    const after = await this.afterCommitNow(v, late);
    return { ok: true, note, version: v.id, findings, ...after };
  }

  /**
   * Whether a version overtaken while it waited is settled through a settle job (W1.8), so that a
   * stop part way loses nothing: a person's version, approved or not, and a ruling's (D47). Kolab's
   * own rebases have nothing to lose and are dropped at once; a fold being judged is settled under
   * the job of the version it folds.
   */
  private settlesDurably(v: VersionRow): boolean {
    return v.active_role !== 'system' && !(v.state === 'drafted' && v.folded_from);
  }

  /**
   * Settles a version that `newer` overtook while it waited (settleOvertaken): through its settle
   * job, which the commit step wrote with the verdict, or which is written now, unless
   * settlesDurably says it needn't be. If another process is settling it already, says so.
   */
  private async settle(v: VersionRow, newer: Overtaker[], approvedBy?: string, ruling?: string): Promise<GateResult> {
    if (!this.settlesDurably(v)) return this.settleOvertaken(v, newer, approvedBy, ruling);
    const payload = { ...(approvedBy ? { approvedBy } : {}), ...(ruling ? { ruling } : {}) };
    if (!this.written.has(`settle:${v.id}`)) await this.asSystem((tx) => this.enqueue(tx, 'settle', v.id, payload));
    const r = await this.runClaimed('settle', v.id, (claim) => this.settleJob(v.id, payload, claim));
    if (r.ran) return r.result;
    return { ok: false, note: `${await this.nameOf(v.node_id)}@${v.seq} was overtaken while it waited, and Kolab is settling it already: folding it onto its node's newer version, or rejecting it as stale.`, version: v.id };
  }

  /**
   * The work a settle job owes: a version overtaken while it waited, in review (`approvedBy`) or
   * drafted (a submission, or `ruling`'s version), is folded onto Kolab's rebase, or rejected as
   * stale if anyone else committed (settleOvertaken), unless it has been settled since. A fold that
   * a stopped process wrote and never committed is rejected first, so the version is folded once.
   */
  private async settleJob(versionId: string, payload: { approvedBy?: string; ruling?: string }, claim: Claim): Promise<GateResult> {
    const v = await this.version(versionId);
    const waiting: VersionState = payload.approvedBy ? 'in_review' : 'drafted';
    if (v.state !== waiting) return { ok: v.state === 'committed', note: (await this.reviewNote(v.id)) ?? undefined, version: v.id };
    const here = `${await this.nameOf(v.node_id)}@${v.seq}`;
    // A fold of it that a stopped or failed run already made, in review or committed, is the
    // result: the version is settled as folded into it, and folded no second time.
    const fold = (await this.db.query<{ id: string; state: VersionState }>(
      `select id, state from version where folded_from = $1 and node_id = $2 and seq > $3 and state in ('in_review', 'committed')
        order by seq desc limit 1`, [v.folded_from ?? v.id, v.node_id, v.seq])).rows[0];
    if (fold) {
      await this.reject(v.id, `folded into ${fold.id}`);
      return { ok: fold.state === 'committed', version: fold.id, ...(fold.state === 'in_review' ? { in_review: true } : {}) };
    }
    const newer = await overtakenBy(this.db, v);
    if (!newer) throw new Error(`${here} is ${v.state} and no longer overtaken; nothing to settle`);
    await this.asSystem((tx) => tx.query(
      `update version set state = 'rejected', review_note = $2 where folded_from = $1 and state = 'drafted'`,
      [v.folded_from ?? v.id, `not committed: Kolab stopped while folding ${here}, and folded it again`]));
    claim.check();
    return this.settleOvertaken(v, newer, payload.approvedBy, payload.ruling);
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
   * A committed version's after_commit job (W1.8). A node's cascades run in the order its versions
   * committed, each carrying the one before it forward: any earlier one the node still owes, which
   * a stopped process left, is run first if it is free and due. If one is held by another live
   * process, is waiting out a backoff, or is dead, this one waits for it (Deferred), and runs once
   * it is done.
   */
  private async cascade(v: VersionRow, claim: Claim): Promise<number> {
    for (;;) {
      const earlier = (await this.db.query<{ id: string }>(
        `select j.id from outbox j join version jv on jv.id = j.version_id
          where j.kind = 'after_commit' and jv.node_id = $1 and jv.seq < $2 order by jv.seq limit 1`, [v.node_id, v.seq])).rows[0];
      if (!earlier) break;
      const job = await this.claimJob(`select $1::text`, [earlier.id]);
      if (!job || (await this.runJob(job)) !== 'done') throw new Deferred(`${v.id} waits for an earlier cascade of its node`);
    }
    return this.afterCommit(v, [], claim);
  }

  /**
   * Runs a version's after_commit job now, in the caller's call, once its commit step committed
   * it: its cascade, unless it waits behind an earlier one of its node (`cascade: 'queued'`). Its
   * variants' rebases are not part of it: they are queued (D43, P6), and `rebases` counts them,
   * those its commit step wrote and any its cascade found besides.
   */
  private async afterCommitNow(v: VersionRow, committed: Committed): Promise<Pick<GateResult, 'cascade' | 'rebases'>> {
    const r = await this.runClaimed('after_commit', v.id, (claim) => this.cascade(v, claim));
    const rebases = committed.rebases + (r.ran ? r.result : 0);
    return { ...(r.ran ? {} : { cascade: 'queued' as const }), ...(rebases ? { rebases } : {}) };
  }

  /**
   * The cascade a commit runs, and what the version's review found: layer leaks become marks and
   * questions. (A resolution of an override it carries recorded its ruling in the commit step.)
   * Idempotent, so that a job run again after a stop part way does each thing once.
   */
  private async afterCommit(v: VersionRow, findings: Finding[], claim: Claim): Promise<number> {
    try {
      const rebases = await this.onCommit(v.id, claim);
      claim.check();
      await this.raiseLayerLeaks(v, await this.findingsOf(v.id, findings));
      return rebases;
    } catch (e) {
      // A variant's cascade, further down, names itself; a lost claim stops the job, not the commit.
      if (e instanceof CascadeError || e instanceof ClaimLost) throw e;
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
    const author = await accessIn(tx, v.actor_id, v.kolab_id);
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
   *
   * What the change still owes is written to the outbox in the same transaction (W1.8), for the
   * caller to run at once with runClaimed, and for any process to run if this one stops first: a
   * version that commits owes its cascade and its reviewers' layer leaks (after_commit); a verdict
   * on a version that was overtaken (`settle`: an approval, or a ruling) owes its fold or its
   * rejection as stale (settle).
   */
  private async commitStep(v: VersionRow, note: string | null, opts: {
    from?: 'drafted' | 'in_review'; record?: (tx: Q, signal: Signal, overtaken: boolean) => Promise<boolean>;
    settle?: { approvedBy?: string; ruling?: string };
  } = {}): Promise<Overtaker[] | 'waiting' | { refused: string } | Committed> {
    const from = opts.from ?? 'drafted';
    const late = await this.asSystem(async (tx, signal): Promise<Overtaker[] | 'waiting' | { refused: string } | Committed> => {
      const newer = await overtakenBy(tx, v);
      if (opts.record && !(await opts.record(tx, signal, !!newer))) return 'waiting' as const;
      if (newer) {
        if (opts.settle) await this.enqueue(tx, 'settle', v.id, opts.settle);
        return newer;
      }
      const refused = await this.authorRefusal(tx, signal, v);
      if (refused) return { refused };
      const r = await tx.query(`update version set state = 'committed', review_note = $2 where id = $1 and state = $3 returning id`,
        [v.id, note, from]);
      if (!r.rows.length) throw new GateError(`${v.id} is no longer ${from === 'drafted' ? 'drafted' : 'in review'}: another review settled it first`);
      await tx.query(`update review_request set state = 'withdrawn', decided_at = now() where version_id = $1 and state = 'open'`, [v.id]);
      // An override resolution records its ruling as it commits, before its cascade (W2.5, OVR9).
      const ruling = (await tx.query<{ resolves: Ruling | null }>(`select resolves from version where id = $1`, [v.id])).rows[0]?.resolves;
      if (ruling) await this.recordRuling(tx, signal, ruling);
      await this.enqueue(tx, 'after_commit', v.id);
      // Its variants' rebases are owed from the moment it commits (D43, P6): one job each,
      // unclaimed, for the worker, and the commit returns without waiting for them.
      // A rebase job for an older version of this node is moot: this version's after_commit owes
      // the node's catch-up (onCommit, step 5). One a worker is running now finishes as a no-op.
      await tx.query(
        `delete from outbox o using version ov where o.kind = 'rebase' and ov.id = o.version_id and ov.node_id = $1
            and o.version_id <> $2 and o.claim is null`, [v.node_id, v.id]);
      const rebases = await this.enqueueRebases(tx, v);
      if (rebases) await this.notifyWork(tx);
      return { committed: true, rebases };
    }, v.node_id);
    if (isCommitted(late) && late.rebases) this.wake();
    return late;
  }

  /**
   * Writes a rebase job (D43, P6) for each variant whose live version sits on an older version of
   * `v`'s node, unclaimed, and returns how many it wrote or revived. The worker rebases whatever is
   * live when the job runs, so the list taken here only says which variants owe a rebase, never
   * what to rebase. A variant owes one job at a time:
   * - one already waiting for a worker (pending and not claimed) covers it, and nothing is added;
   * - one claimed may be running now, even if its lease lapsed (a stalled worker still finishes),
   *   and may have read the parent before `v` committed, so it is told to run again once it is done
   *   (`payload.again`, see finishRebase), rather than lose `v`;
   * - a dead one stops nothing: the job for the variant's live version is revived, or a new one
   *   written, so each parent commit tries again, as CAS7 says.
   *
   * Listing again after the commit (onCommit) also sets `again` on a job a worker holds: it may
   * have been claimed between the commit step's list, which saw it waiting, and the commit, and so
   * read the older parent. At worst the job runs once more for nothing.
   *
   * `skipFailedSince`: leave out a variant whose rebase onto `v`, or a later version of its node,
   * has already failed and marked it rebase_failed (D44), so that listing again after the commit
   * (onCommit) never retries a failure the commit's own job just recorded.
   */
  private async enqueueRebases(q: Q, v: VersionRow, skipFailedSince = false): Promise<number> {
    // One statement: list and insert. Ids share a fresh ULID and add the variant's place in the
    // list, so a batch sorts together, in order, after every job written before it.
    // Any claim may be a run still going: a lapsed lease nobody has taken yet may belong to a
    // worker that stalled, and will finish (finishRebase). Only an unclaimed job is waiting.
    const live = `(o.claim is not null)`;
    const r = await q.query(
      `insert into outbox(id, kind, version_id, payload)
       select $3::text || '.' || lpad((row_number() over (order by c.id))::text, 12, '0'), 'rebase', c.id,
              jsonb_build_object('onto', $4::text, 'node', c.node_id)
         from version c join version p on p.id = c.parent_version_id
        where p.node_id = $1 and c.node_id <> $1 and p.seq < $2::int and c.state = 'committed'
          and ${LIVE('c')}
          and not exists (select 1 from outbox o join version ov on ov.id = o.version_id
                           where o.kind = 'rebase' and o.state = 'pending' and ov.node_id = c.node_id and not ${live})
          and not ($5::boolean and exists (
                select 1 from invalidation i join version iv on iv.id = i.version_id join version t on t.id = i.triggered_by
                 where iv.node_id = c.node_id and i.reason = 'rebase_failed' and i.state = 'open'
                   and t.node_id = $1 and t.seq >= $2::int))
       on conflict (kind, version_id) do update set
              state = 'pending',
              attempts = case when outbox.state = 'dead' then 0 else outbox.attempts end,
              run_after = case when outbox.state = 'dead' then clock_timestamp() else outbox.run_after end,
              payload = outbox.payload || jsonb_build_object('onto', $4::text)
                        || case when ${live.replaceAll('o.', 'outbox.')} then '{"again": true}'::jsonb else '{}'::jsonb end
        where outbox.state = 'dead' or ${live.replaceAll('o.', 'outbox.')}
       returning id`,
      [v.node_id, v.seq, outboxId(), v.id, skipFailedSince]);
    return r.rows.length;
  }

  /** Marks the variant of a dead rebase job rebase_failed, against its parent's latest version (D44). */
  private async rebaseDied(versionId: string, error: unknown) {
    const nodeId = (await this.version(versionId)).node_id;
    const live = await this.latestCommitted(nodeId);
    if (!live?.parent_version_id) return;
    const parentNode = (await this.version(live.parent_version_id)).node_id;
    if (parentNode === nodeId) return;
    const latest = (await this.latestCommitted(parentNode))!;
    if (latest.id === live.parent_version_id) return;
    // The same check as every rebase: a variant that may not be rebased is not marked against its parent either.
    if (!(await this.mayRebase(live, latest))) return;
    // A fork's error may tell of its parent's kolab, which not everyone here reads (D53).
    const why = latest.kolab_id !== live.kolab_id ? 'the parent is in another kolab, so its error stays there' : maskTokens(error).slice(0, 300);
    await this.rebaseFailed(nodeId, latest.id, `Rebasing onto the new parent kept failing, and Kolab has stopped trying: ${why}. Commit a new version to rebase it, or wait for the parent's next commit.`);
  }

  /**
   * A rebase job's work (D43, P6): the variant it names is caught up with its parent node's latest
   * version, built on the variant's live version now, whatever the job listed (catchUp). Its rebase
   * commits after structural checks only (VER12), consults precedent (OVR9), marks the variant
   * rebase_failed if it fails for the variant's own reasons (D44), and as it commits writes its own
   * variants' jobs: the next level. Run again after a stop part way, it finds the variant on its
   * parent's latest version and does nothing more.
   */
  private async rebaseJob(versionId: string, node: string | undefined, claim: Claim) {
    const n = node ?? (await this.version(versionId)).node_id;
    // A dependent in another kolab's job also checks its links into other kolabs (LNK8).
    await this.checkLinksAcross(n, claim);
    await this.catchUp(n, claim);
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
    // A fork whose holder no longer reads its parent's kolab can't be folded onto that kolab's
    // newer work, which it may no longer see (LNK8): it is redrafted on the fork as it stands.
    const unreadable = parent && parent.kolab_id !== v.kolab_id && !!(await this.unvouched(v.parent_held_by, parent.kolab_id!, v.kolab_id!, v.layer));
    if (human || !parent || parent.node_id === v.node_id || unreadable) {
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
      const mark: MarkInput = { version_id: v.id, element_id: element, triggered_by: v.id, reason: 'role_boundary', note: f.explanation };
      const here = formatAddress({ node: node.name, version: v.seq, element: element ?? undefined });
      if (node.layer === 'functional') {
        await this.raiseOnce(v, mark,
          `The review gate thinks ${here} specifies implementation, not behavior: ${f.explanation} Rewrite it as behavior, or answer to keep it as is.`);
        continue;
      }
      const link = (await this.db.query<{ target_version_id: string; target_element_id: string | null; tnode: string; tkolab: string; tseq: number }>(
        `select e.target_version_id, e.target_element_id, tn.name as tnode, tn.kolab_id as tkolab, t.seq as tseq
           from edge e join version t on t.id = e.target_version_id join node tn on tn.id = t.node_id
          where e.source_version_id = $1 and e.source_element_id is not distinct from $2 and t.layer = 'functional'
          order by (e.target_kolab_id = e.kolab_id) desc, e.id limit 1`, [v.id, element])).rows[0];
      const spec = link ? formatAddress({ kolab: link.tkolab, node: link.tnode, version: link.tseq, element: link.target_element_id ?? undefined }, { from: node.kolab_id }) : 'the spec';
      // A spec in another kolab can't be asked from here (questions stay in their kolab): the
      // question goes to the binding's own layer instead, to take up with that kolab.
      const ask = link && link.tkolab === node.kolab_id;
      await this.raiseOnce(v, mark,
        ask || !link
          ? `The review gate thinks binding ${here} changes behavior beyond ${spec}: ${f.explanation} If this behavior is intended, amend the spec and answer; if not, answer "no" and the binding must change.`
          : `The review gate thinks binding ${here} changes behavior beyond ${spec}, which is in another kolab: ${f.explanation} If that kolab intends this behavior, answer once its spec says so; if not, answer "no" and the binding must change.`,
        { version_id: ask ? link.target_version_id : v.id, element_id: ask ? link.target_element_id : element });
    }
  }

  /**
   * A layer leak's mark and question, raised once (W1.8): a cascade run again after a stop, or two
   * runs that overlap, find it, wherever the mark has moved since. The check and the raise are one
   * transaction under the node's lock.
   */
  private async raiseOnce(v: VersionRow, mark: MarkInput, question: string, ask?: { version_id: string; element_id: string | null }) {
    await this.asSystem(async (tx, signal) => {
      const raised = await tx.query(
        `select 1 from invalidation where triggered_by = $1 and reason = 'role_boundary' and element_id is not distinct from $2 and note = $3`,
        [v.id, mark.element_id, mark.note]);
      if (!raised.rows.length) await this.markAndAskIn(tx, signal, mark, question, ask ?? mark);
    }, v.node_id);
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
    const r = await tx.query<{ layer: Layer; actor_id: string; kolab_id: string }>(
      `update version set state = 'rejected', review_note = $2 where id = $1 and state in ('drafted', 'in_review') returning layer, actor_id, kolab_id`,
      [versionId, note]);
    const withdrawn = await tx.query(`update review_request set state = 'withdrawn', decided_at = now() where version_id = $1 and state = 'open' returning id`, [versionId]);
    if (r.rows[0] && withdrawn.rows.length) {
      await signal({ inbox: 'layer', kolab: r.rows[0].kolab_id, layer: r.rows[0].layer });
      await signal({ inbox: 'actor', kolab: r.rows[0].kolab_id, actor: r.rows[0].actor_id });
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
    input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string; unlink?: LinkRef[] }): Promise<string> {
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
    // A link into another kolab needs Read on it now (LNK8, D3), and only its committed versions
    // can be named (D49): anything else reads as a version that isn't there. The link rests on
    // this actor's Read, and is marked access_lost if that goes.
    const across = tgt.kolab_id !== s.kolab;
    if (across && (tgt.state !== 'committed' || !(await this.holds(s.actor_id, tgt.kolab_id!)))) throw new Error(`no version ${e.target}`);
    if (tgt.state !== 'committed') {
      throw new GateError(`nothing may derive from ${e.target}: it has not cleared review`);
    }
    // A link is pinned to what its target says now: its node's live version, never an older one.
    const live = (await this.latestCommitted(tgt.node_id))!;
    if (live.id !== tgt.id) {
      throw new GateError(`link to ${await this.nameOf(tgt.node_id)}@${live.seq}, its live version: version ${tgt.seq} is no longer what it says`);
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
    if (dup.rows[0]) {
      // Declared again across kolabs by someone who reads the target: they hold it now.
      if (across) await this.holdLink(dup.rows[0].id, s.actor_id);
      return dup.rows[0].id;
    }
    const repoint = src.state === 'drafted' && src.actor_id === s.actor_id
      ? await this.repointed(src, e.kind, e.sourceElement ?? null, tgt.node_id, e.targetElement ?? null, e.selector ?? null) : undefined;
    const id = ulid();
    await this.asAgent(sessionId, async (tx) => {
      // Across kolabs, Read is checked again here, under the shared access lock this transaction
      // took first, so no revoke can land between the check and the link's commit (LNK8); row-level
      // security (edge_target) checks it once more as the edge is inserted.
      if (across && !(await tx.query<{ ok: boolean }>(`select kj_session_reads_version($1) as ok`, [e.target])).rows[0].ok) {
        throw new Error(`no version ${e.target}`);
      }
      // Re-pointing drops the marked link in the same transaction that adds its replacement.
      if (repoint) await applyRemovals(tx, src.id, repoint);
      // Linking in a draft what the draft drops keeps the link after all: the later word wins.
      if (src.state === 'drafted') {
        await tx.query(
          `delete from link_removal where version_id = $1 and kind = $2 and source_element_id is not distinct from $3
              and target_node_id = $4 and target_element_id is not distinct from $5 and target_selector is not distinct from $6::jsonb`,
          [e.source, e.kind, e.sourceElement ?? null, tgt.node_id, e.targetElement ?? null, e.selector ? JSON.stringify(e.selector) : null]);
      }
      await tx.query(
        `insert into edge(id, kind, source_version_id, source_element_id, target_version_id,
                          target_element_id, target_selector, target_fingerprint, held_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, e.kind, e.source, e.sourceElement ?? null, e.target, e.targetElement ?? null,
          e.selector ? JSON.stringify(e.selector) : null, r.fingerprint, s.actor_id]);
    }, src.node_id, { access: across });
    return id;
  }

  /**
   * Re-pointing (D48), in a draft of the session's own: the link of the version the draft is built
   * on that a new link replaces, which the draft then drops, so its mark settles when the draft
   * commits, reviewed with it (VER1). Only a link whose quote changed or went (an open orphaned or
   * fuzzy_reanchor mark) is replaced, from the same element, of the same kind, to the same target
   * element, and quote for quote or whole for whole: a `changed` mark is settled by its owner, and
   * a second, narrower link stands beside the first. Of two such quote links, the one whose prefix
   * and suffix the new quote keeps is the one replaced; if that doesn't pick one, the owner names
   * it with konjir_unlink.
   */
  private async repointed(src: VersionRow, kind: string, sourceElement: string | null, targetNode: string,
    targetElement: string | null, selector: QuoteSelector | null): Promise<LinkIdentity[] | undefined> {
    if (!src.base_version_id) return undefined;
    let found = (await this.db.query<EdgeRow & { target_node_id: string }>(
      `select e.*, t.node_id as target_node_id from edge e join version t on t.id = e.target_version_id
        where e.source_version_id = $1 and e.kind = $2 and e.source_element_id is not distinct from $3
          and t.node_id = $4 and e.target_element_id is not distinct from $5 and (e.target_selector is null) = $6
          and exists (select 1 from invalidation i where i.edge_id = e.id and i.state = 'open' and i.reason in ('orphaned', 'fuzzy_reanchor'))
        order by e.id`, [src.base_version_id, kind, sourceElement, targetNode, targetElement, selector === null])).rows;
    if (found.length > 1 && selector) {
      const same = (a?: string, b?: string) => normalize(a ?? '') === normalize(b ?? '');
      found = found.filter((x) => same(x.target_selector?.prefix, selector.prefix) && same(x.target_selector?.suffix, selector.suffix));
      if (found.length !== 1) {
        throw new GateError(`more than one marked link from ${sourceElement ?? 'the whole version'} quotes that element; `
          + `name the one this replaces: konjir_unlink link=<id> in this draft, then link again`);
      }
    }
    if (!found.length) return undefined;
    const x = found[0];
    return [{ kind: x.kind, source_element_id: x.source_element_id, target_node_id: x.target_node_id,
      target_element_id: x.target_element_id, target_selector: x.target_selector, carried: true }];
  }

  /**
   * Removes links in a draft of the session's own (LNK6, D48): its commit doesn't carry them forward
   * from the version it was built on (CAS3), and their open marks settle then, with what those
   * marks alone caused. A link the draft declared itself goes at once. The removal is part of the
   * version: it is reviewed with it, and nothing changes until the version commits; a draft that is
   * abandoned, rejected or sent back changes nothing. Returns the links removed, as addresses.
   */
  async unlink(sessionId: string, versionId: string, refs: LinkRef[]): Promise<{ kind: string; source: string; target: string }[]> {
    if (!refs.length) throw new Error('name at least one link to remove');
    const v = await this.version(versionId);
    await this.requireNodeIn(sessionId, v.node_id);
    const s = await this.requireLayer(sessionId, v.layer, v.kolab_id);
    const here = `${await this.nameOf(v.node_id)}@${v.seq}`;
    if (v.actor_id !== s.actor_id) throw new RoleError(`${here} is ${v.actor_id}'s draft: only its author changes it`);
    if (v.state !== 'drafted') {
      throw new GateError(`${here} is ${v.state}: links are removed in a draft, before it is submitted; draft a new version to remove them`);
    }
    const ids = await this.linkIdentities(v.node_id, v.base_version_id, v.id, refs);
    await this.asAgent(sessionId, (tx) => applyRemovals(tx, v.id, ids), v.node_id);
    return Promise.all(ids.map((x) => this.describeIdentity(v, x)));
  }

  /**
   * The links `refs` name, among those of `base` (the version a draft is built on) and of `draft`
   * itself. Each must name at least one; a ref without a kind names links of every kind.
   */
  private async linkIdentities(nodeId: string, base: string | null, draft: string | null, refs: LinkRef[]): Promise<LinkIdentity[]> {
    const node = await this.node(nodeId);
    const at = base ? `${node.name}@${(await this.version(base)).seq}` : node.name;
    const cols = `e.id, e.kind, e.source_element_id, t.node_id as target_node_id, e.target_element_id, e.target_selector, e.source_version_id`;
    const out = new Map<string, LinkIdentity>();
    for (const ref of refs) {
      let rows: (Omit<LinkIdentity, 'carried'> & { id: string; source_version_id: string })[];
      let what: string;
      if ('link' in ref) {
        what = `link ${ref.link}`;
        // A link of any version of the node names the same link in the base or the draft.
        const e = (await this.db.query<Omit<LinkIdentity, 'carried'>>(
          `select ${cols} from edge e join version t on t.id = e.target_version_id join version s on s.id = e.source_version_id
            where e.id = $1 and s.node_id = $2`, [ref.link, nodeId])).rows[0];
        if (!e) throw new Error(`${node.name} has no ${what}: konjir_lineage direction=upstream lists its links`);
        rows = await this.matchingLinks(cols, [base, draft], e);
      } else {
        const a = parseAddress(ref.target);
        what = `link from ${ref.sourceElement ?? 'the whole version'} to ${ref.target}`;
        // A link into another kolab is removed as any other (LNK8): found among the node's own links,
        // so a removal names nothing of that kolab that the link didn't already.
        const t = await this.findNode(this.db, a.kolab ?? node.kolab_id, a.node);
        rows = t ? await this.matchingLinks(cols, [base, draft], {
          kind: ref.kind ?? null, source_element_id: ref.sourceElement ?? null, target_node_id: t.id,
          target_element_id: a.element ?? null, target_selector: a.selector ?? null,
        }) : [];
      }
      if (!rows.length) throw new Error(`${at} has no ${what}${draft ? ', and neither has this draft' : ''}: konjir_lineage direction=upstream lists its links`);
      for (const r of rows) {
        const key = JSON.stringify([r.kind, r.source_element_id, r.target_node_id, r.target_element_id, r.target_selector]);
        const x = out.get(key) ?? { kind: r.kind, source_element_id: r.source_element_id, target_node_id: r.target_node_id,
          target_element_id: r.target_element_id, target_selector: r.target_selector, carried: false };
        if (r.source_version_id === base) x.carried = true;
        out.set(key, x);
      }
    }
    return [...out.values()];
  }

  /** The links of `versions` with the identity `x` (any kind, when `x.kind` is null). */
  private async matchingLinks(cols: string, versions: (string | null)[], x: Omit<LinkIdentity, 'carried'> | { kind: string | null } & Omit<LinkIdentity, 'carried' | 'kind'>) {
    return (await this.db.query<Omit<LinkIdentity, 'carried'> & { id: string; source_version_id: string }>(
      `select ${cols} from edge e join version t on t.id = e.target_version_id
        where e.source_version_id = any($1) and ($2::text is null or e.kind = $2) and e.source_element_id is not distinct from $3
          and t.node_id = $4 and e.target_element_id is not distinct from $5 and e.target_selector is not distinct from $6::jsonb`,
      [versions.filter((v): v is string => !!v), x.kind, x.source_element_id, x.target_node_id, x.target_element_id,
        x.target_selector ? JSON.stringify(x.target_selector) : null])).rows;
  }

  /** A link's identity as addresses, read from version `v` of its source node. */
  private async describeIdentity(v: VersionRow, x: Pick<LinkIdentity, 'kind' | 'source_element_id' | 'target_node_id' | 'target_element_id' | 'target_selector'>) {
    return {
      kind: x.kind,
      source: formatAddress({ node: await this.nameOf(v.node_id), version: v.seq, element: x.source_element_id ?? undefined }),
      target: formatAddress({ node: await this.nameOf(x.target_node_id), element: x.target_element_id ?? undefined, selector: x.target_selector ?? undefined }),
    };
  }

  /** The links version `v` removes (0012), as addresses: what its commit doesn't carry forward. */
  async removedLinks(where: Where, v: VersionRow) {
    const rows = await this.read(where, (q) => q.query<LinkIdentity>(
      `select kind, source_element_id, target_node_id, target_element_id, target_selector from link_removal
        where version_id = $1 order by source_element_id nulls first, target_node_id, target_element_id, kind`, [v.id]));
    return Promise.all(rows.rows.map((x) => this.describeIdentity(v, x)));
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

  /**
   * A committed version's cascade. Returns how many rebases of its variants it queued besides
   * those its commit step wrote.
   */
  private async onCommit(versionId: string, claim: Claim): Promise<number> {
    claim.check();
    const v = await this.version(versionId);
    await this.withdrawStale(v);
    await this.supersedePrevious(v);
    await this.markStaleOverrides(v);
    await this.clearAddressed(v);

    // 1. Direct: every live edge pinned to an older version of this node.
    const inbound = await this.db.query<EdgeRow>(
      `select e.* from edge e
         join version t on t.id = e.target_version_id
         join version s on s.id = e.source_version_id
        where t.node_id = $1 and t.seq < $2::int
          and ${LIVE('s')}
          and not exists (select 1 from invalidation i where i.edge_id = e.id and i.state = 'open')`,
      [v.node_id, v.seq]);
    // Only edges pinned to versions older than this one: a cascade run late (W1.8) never touches an
    // edge a newer version's commit, or its dependent's catch-up, has re-pinned already.
    // A link from another kolab is that kolab's work: its own rebase job, below.
    const elsewhere = new Set<string>();
    for (const e of inbound.rows) {
      if (e.kolab_id !== v.kolab_id) elsewhere.add(e.source_version_id);
      else await this.checkEdge(e, v.id);
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
      await this.checkEdge(e, e.latest);
    }

    // 3. Transitive marks: each direct mark's walk ran in the transaction that raised it.

    // 4. Children (variants) of an older version of this node rebase onto it, asynchronously
    //    (D43, P6): the commit step queued a rebase job for each, and the worker runs them. They
    //    are listed again now that the commit is visible to everyone, since a variant committing
    //    at the same moment may have been invisible to the commit step's list while the commit
    //    was invisible to its own catch-up. A variant listed already, or whose rebase onto this
    //    version has already failed and marked it, gets no second job.
    claim.check();
    // One statement, as Kolab's own login, outside any transaction; other workers are told only
    // when it queued something, which is rare.
    const rebases = await this.enqueueRebases(this.db, v, true);
    if (rebases) {
      await this.inTransaction((tx) => this.notifyWork(tx));
      this.wake();
    }

    // 5. Catch-up for this version itself: drafted against a parent that has since moved on.
    claim.check();
    await this.catchUp(v.node_id, claim);

    // 6. What this commit owes other kolabs' links into it (LNK8): a rebase job for each
    //    dependent version there, which brings it up to date with this kolab (rebaseJob), as the
    //    commit step's rebase jobs do for forks there. Each runs, fails, backs off and retries on
    //    its own, so another kolab's trouble never holds this cascade up, and the committer hears
    //    nothing of it (D49, D53).
    if (elsewhere.size) {
      claim.check();
      const queued = await this.asSystem(async (tx) => {
        let n = 0;
        for (const id of elsewhere) n += await this.enqueueRebase(tx, id);
        if (n) await this.notifyWork(tx);
        return n;
      });
      if (queued) this.wake();
    }
    return rebases;
  }

  /**
   * If a variant's live version sits on an older version of its parent node, rebase it onto the
   * parent's latest. Every path that leaves a variant behind ends here: the parent's storm, the
   * variant's own commit, and a rebase dropped because something overtook it.
   */
  private async catchUp(nodeId: string, claim?: Claim) {
    claim?.check();   // a job whose claim was lost stops here, rather than rebase beside another run
    const live = await this.latestCommitted(nodeId);
    if (!live?.parent_version_id) return;
    const p = await this.version(live.parent_version_id);
    if (p.node_id === nodeId) return;
    // A fork's holder is checked whether or not it is behind, so its access_lost mark is raised
    // or settled as soon as it applies; mayRebase checks again before any rebase.
    if (p.kolab_id !== live.kolab_id && await this.forkLost(live, p.kolab_id!)) return;
    const latestParent = (await this.latestCommitted(p.node_id))!;
    if (latestParent.id === p.id) return this.settleRebaseFailed(live);
    if (!(await this.mayRebase(live, latestParent))) return;
    await this.rebaseOrMark(live, latestParent);
  }

  /**
   * Whether a variant may be rebased onto its parent's latest version now: the one place a check
   * that belongs to the variant's relation with its parent goes, before anything is written, for
   * every path that rebases (a rebase job, a variant's own catch-up, a dropped rebase's) and for
   * a dead rebase job's mark. A fork, whose parent is in another kolab, is rebased only while its
   * holder vouches for it (LNK8, D53); otherwise it is marked access_lost instead (forkLost).
   */
  private async mayRebase(live: VersionRow, parent: VersionRow): Promise<boolean> {
    if (parent.kolab_id === live.kolab_id) return true;
    return !(await this.forkLost(live, parent.kolab_id!));
  }

  /**
   * Whether a fork's holder no longer vouches for it (LNK8, D53): Read on the parent's kolab, and
   * Write on the fork's layer in its own. If so it is marked access_lost, once; if not, an open
   * access_lost mark settles. Under a shared hold on the access lock, then the fork's lock, so a
   * change of access can't land between the check and the mark.
   */
  private async forkLost(live: VersionRow, parentKolab: string): Promise<boolean> {
    return this.asSystem(async (tx, signal) => {
      const now = (await tx.query<VersionRow>(`select * from version where id = $1`, [live.id])).rows[0];
      const why = await this.unvouched(now.parent_held_by, parentKolab, now.kolab_id!, now.layer, tx);
      if (!why) {
        const open = await tx.query<{ id: string }>(
          `select i.id from invalidation i join version x on x.id = i.version_id
            where x.node_id = $1 and i.reason = 'access_lost' and i.edge_id is null and i.state = 'open'`, [live.node_id]);
        for (const m of open.rows) await this.closeMarkIn(tx, signal, m.id, `${now.parent_held_by} holds it again`);
        return false;
      }
      await this.forkAccessLostIn(tx, signal, now, why);
      return true;
    }, live.node_id, { access: true });
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

  /**
   * Re-resolve an edge against a newer target version: re-pin if unchanged, else mark. A mark and
   * its transitive marks (propagateIn) are raised in one transaction, so a cascade run again after
   * a stop finds the edge marked and its walk done, or neither (W1.8).
   */
  private async checkEdge(e: EdgeRow, against: string): Promise<void> {
    const source = (await this.db.query<{ node_id: string }>(`select node_id from version where id = $1`, [e.source_version_id])).rows[0].node_id;
    // Checked, and marked, under the dependent's lock: two runs of one cascade that overlap (a
    // lost claim, W1.8) mark the edge once.
    await this.asSystem((tx, signal) => this.checkEdgeIn(tx, signal, e, against), source, { access: e.target_kolab_id !== e.kolab_id });
  }

  /**
   * checkEdge, in `tx`. An edge with an open mark is left as it is: it is re-checked once that
   * mark settles. A link into another kolab is checked only while its holder vouches for it
   * (LNK8): otherwise it is marked access_lost, and nothing of the newer version reaches it. Every
   * caller holds the access lock (shared, or exclusively for a change of access), taken before
   * any node's lock, so a change of access can't land between the check and the mark.
   */
  private async checkEdgeIn(tx: Q, signal: Signal, e: EdgeRow, against: string): Promise<void> {
    if ((await tx.query(`select 1 from invalidation where edge_id = $1 and state = 'open'`, [e.id])).rows.length) return;
    if (e.target_kolab_id !== e.kolab_id) {
      const why = await this.unvouchedLink(e, tx);
      if (why) {
        await this.linkAccessLostIn(tx, signal, e, why);
        return;
      }
    }
    const r = resolveInElements(await this.elements(against, tx), e.target_element_id, e.target_selector);
    if (r.status === 'ok' && r.fingerprint === e.target_fingerprint) {
      // Content-identical: a cheap pointer bump, not a regeneration.
      await tx.query(`update edge set target_version_id = $2 where id = $1`, [e.id, against]);
      return;
    }
    const reason = r.status === 'orphan' ? 'orphaned' : r.status === 'fuzzy' ? 'fuzzy_reanchor' : 'changed';
    const m = {
      version_id: e.source_version_id, element_id: e.source_element_id, edge_id: e.id, triggered_by: against, reason,
    };
    const id = await this.markIn(tx, signal, m);
    await this.propagateIn(tx, signal, { id, ...m });
  }

  // ---- links and forks across kolabs (LNK8, KON9) ----------------------------

  /** Whether `actor` holds at least Read on `kolab` now (kj_access). */
  private async holds(actor: string | null | undefined, kolab: string, q: Q = this.db): Promise<boolean> {
    return !!actor && !!(await accessIn(q, actor, kolab)).level;
  }

  /**
   * Why `holder` no longer vouches for a link or fork from kolab `own` (its dependent's, on
   * `layer`) into kolab `target`, or undefined if they do (LNK8, D53): a holder must still read
   * the other kolab and still write the dependent's layer in its own, so someone who has left the
   * dependent's kolab is no channel into it.
   */
  private async unvouched(holder: string | null | undefined, target: string, own: string, layer: Layer, q: Q = this.db): Promise<string | undefined> {
    if (!holder) return 'it has no holder';
    if (!(await accessIn(q, holder, target)).level) return `${holder}, whose access it rests on, can no longer read kolab ${target}`;
    if (!(await accessIn(q, holder, own)).layers.includes(layer)) return `${holder}, whose access it rests on, can no longer write the ${layer} layer of kolab ${own}`;
    return undefined;
  }

  /** unvouched, for a link: its holder, its target's kolab, and its source's kolab and layer. */
  private async unvouchedLink(e: EdgeRow, q: Q = this.db): Promise<string | undefined> {
    const layer = (await q.query<{ layer: Layer }>(`select layer from version where id = $1`, [e.source_version_id])).rows[0].layer;
    return this.unvouched(e.held_by, e.target_kolab_id, e.kolab_id, layer, q);
  }

  /**
   * A link into another kolab whose holder no longer vouches for it (LNK8): its dependent element
   * is marked access_lost, once, on the version the link is pinned to, and the mark spreads in the
   * dependent's own kolab as any direct mark does. In `tx`.
   */
  private async linkAccessLostIn(tx: Q, signal: Signal, e: EdgeRow, why: string) {
    if ((await tx.query(`select 1 from invalidation where edge_id = $1 and reason = 'access_lost' and state = 'open'`, [e.id])).rows.length) return;
    const m = {
      version_id: e.source_version_id, element_id: e.source_element_id, edge_id: e.id, triggered_by: e.target_version_id,
      reason: 'access_lost', note: why,
    };
    const id = await this.markIn(tx, signal, m);
    await this.propagateIn(tx, signal, { id, ...m });
  }

  /**
   * A fork whose holder no longer reads its parent's kolab (LNK8, KON9): its live version is
   * marked access_lost, once, and Kolab stops rebasing it onto that kolab's commits. In `tx`.
   */
  private async forkAccessLostIn(tx: Q, signal: Signal, v: Pick<VersionRow, 'id' | 'node_id' | 'parent_version_id' | 'parent_held_by'>, why: string) {
    const open = await tx.query(
      `select 1 from invalidation i join version x on x.id = i.version_id
        where x.node_id = $1 and i.reason = 'access_lost' and i.edge_id is null and i.state = 'open'`, [v.node_id]);
    if (open.rows.length) return;
    await this.markIn(tx, signal, {
      version_id: v.id, element_id: null, triggered_by: v.parent_version_id!, reason: 'access_lost', note: why,
    });
  }

  /**
   * Someone who reads a link's target kolab holds it now (LNK8): they declared it again, cleared
   * its mark, or revised the element that relies on it. An open access_lost mark settles, and the
   * link is checked against its target's latest version, which it may not have followed. Under the
   * access lock (shared) and then the dependent's lock, before any row is written. Returns
   * whether a mark settled.
   */
  private async holdLink(edgeId: string, actor: string): Promise<boolean> {
    const e0 = (await this.db.query<EdgeRow & { node_id: string }>(
      `select e.*, s.node_id from edge e join version s on s.id = e.source_version_id where e.id = $1`, [edgeId])).rows[0];
    return this.asSystem((tx, signal) => this.holdLinkIn(tx, signal, edgeId, actor), e0.node_id, { access: true });
  }

  private async holdLinkIn(tx: Q, signal: Signal, edgeId: string, actor: string): Promise<boolean> {
    const was = (await tx.query<EdgeRow>(`select * from edge where id = $1`, [edgeId])).rows[0];
    // Only someone who vouches for it holds it (checked again here, under the lock). One who no
    // longer does changes nothing, but if the holder it has doesn't either, it is marked now.
    if (await this.unvouchedLink({ ...was, held_by: actor }, tx)) {
      const why = await this.unvouchedLink(was, tx);
      if (why) await this.linkAccessLostIn(tx, signal, was, why);
      return false;
    }
    const e = (await tx.query<EdgeRow>(`update edge set held_by = $2 where id = $1 returning *`, [edgeId, actor])).rows[0];
    return this.restoreLinkIn(tx, signal, e, `held by ${actor}, who reads kolab ${e.target_kolab_id}`);
  }

  /** Settles a link's open access_lost mark, if it has one, and checks the link against its target's latest version. In `tx`. */
  private async restoreLinkIn(tx: Q, signal: Signal, e: EdgeRow, by: string): Promise<boolean> {
    const open = (await tx.query<{ id: string }>(
      `select id from invalidation where edge_id = $1 and reason = 'access_lost' and state = 'open'`, [e.id])).rows;
    if (!open.length) return false;
    for (const m of open) await this.closeMarkIn(tx, signal, m.id, by);
    const latest = (await tx.query<{ id: string }>(
      `select l.id from version l join version t on t.node_id = l.node_id
        where t.id = $1 and l.state = 'committed' order by l.seq desc limit 1`, [e.target_version_id])).rows[0].id;
    if (latest !== e.target_version_id) await this.checkEdgeIn(tx, signal, e, latest);
    return true;
  }

  /**
   * Brings marks into line with who holds what, in `tx`, the transaction that changed access or
   * found it changed (LNK8): every live link into another kolab whose holder no longer reads it,
   * and every live fork whose holder no longer reads its parent's kolab, is marked access_lost;
   * every such mark whose holder reads again settles. A link settles here and is checked against
   * its target's latest version at once; a fork's catch-up onto its parent's latest version is a
   * rebase job in the outbox (D43, P6), written here (W1.8), whose fork live versions this returns
   * so the caller can wake the worker once the transaction commits.
   *
   * A dependent in an archived kolab (D52) is left as it is: nothing may be written there, and
   * nothing reaches it either, since its jobs wait. Unarchiving it reconciles it (setArchived).
   *
   * Only links and forks held by `holders` are looked at: the actors whose access the change could
   * alter, and the agents they own (holdersOf), found through edge_cross_kolab and version_forks.
   */
  private async reconcileAccessIn(tx: Q, signal: Signal, holders: string[]): Promise<string[]> {
    if (!holders.length) return [];
    const crossing = await tx.query<EdgeRow & { source_layer: Layer }>(
      `select e.*, s.layer as source_layer from edge e join version s on s.id = e.source_version_id
        where e.target_kolab_id <> e.kolab_id and e.held_by = any($1) and ${LIVE('s')}
          and not ${archivedKolabSql('e.kolab_id')}`, [holders]);
    const forks = await tx.query<VersionRow & { parent_kolab: string }>(
      `select v.*, p.kolab_id as parent_kolab from version v join version p on p.id = v.parent_version_id
        where v.parent_held_by = any($1) and v.state = 'committed' and ${LIVE('v')}
          and not ${archivedKolabSql('v.kolab_id')}`, [holders]);
    const verdicts = new Map<string, string | undefined>();
    const why = async (holder: string, target: string, own: string, layer: Layer) => {
      const key = JSON.stringify([holder, target, own, layer]);
      if (!verdicts.has(key)) verdicts.set(key, await this.unvouched(holder, target, own, layer, tx));
      return verdicts.get(key);
    };
    for (const e of crossing.rows) {
      const lost = await why(e.held_by!, e.target_kolab_id, e.kolab_id, e.source_layer);
      if (!lost) await this.restoreLinkIn(tx, signal, e, `access restored: ${e.held_by} holds it again`);
      else await this.linkAccessLostIn(tx, signal, e, lost);
    }
    const catchUp: string[] = [];
    for (const v of forks.rows) {
      const lost = await why(v.parent_held_by!, v.parent_kolab, v.kolab_id!, v.layer);
      if (lost) {
        await this.forkAccessLostIn(tx, signal, v, lost);
        continue;
      }
      const open = (await tx.query<{ id: string }>(
        `select i.id from invalidation i join version x on x.id = i.version_id
          where x.node_id = $1 and i.reason = 'access_lost' and i.edge_id is null and i.state = 'open'`, [v.node_id])).rows;
      if (!open.length) continue;
      for (const m of open) await this.closeMarkIn(tx, signal, m.id, `access restored: ${v.parent_held_by} holds it again`);
      if (await this.enqueueRebase(tx, v.id)) catchUp.push(v.id);
    }
    return catchUp;
  }

  /**
   * Writes a rebase job (D43, P6), in `tx`, for `versionId`'s node, which depends on another kolab
   * (LNK8, KON9): a link of its into that kolab to check, or a fork whose holder holds it again.
   * Unclaimed, for the worker; none if one is queued already. Returns how many it wrote.
   */
  private async enqueueRebase(tx: Q, versionId: string): Promise<number> {
    const r = await tx.query(
      `insert into outbox(id, kind, version_id, payload)
       select $1, 'rebase', v.id, jsonb_build_object('node', v.node_id) from version v where v.id = $2
          and not exists (select 1 from outbox o join version ov on ov.id = o.version_id where o.kind = 'rebase' and ov.node_id = v.node_id)
       on conflict (kind, version_id) do nothing returning id`, [outboxId(), versionId]);
    return r.rows.length;
  }

  /**
   * Links of `node`'s live version into other kolabs, checked against their targets' latest
   * versions: what a commit in another kolab owes them, in its own job (rebaseJob). Idempotent.
   */
  private async checkLinksAcross(node: string, claim?: Claim) {
    const outbound = await this.db.query<EdgeRow & { latest: string }>(
      `select e.*, (select l.id from version l where l.node_id = t.node_id and l.state = 'committed'
                     order by l.seq desc limit 1) as latest
         from edge e join version t on t.id = e.target_version_id
        where e.source_version_id = (select id from version where node_id = $1 and state = 'committed' order by seq desc limit 1)
          and e.target_kolab_id <> e.kolab_id
          and not exists (select 1 from invalidation i where i.edge_id = e.id and i.state = 'open')`, [node]);
    for (const e of outbound.rows) {
      claim?.check();
      if (e.latest !== e.target_version_id) await this.checkEdge(e, e.latest);
    }
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
   * Edges into a version are found by edge_target_version (0012).
   *
   * A mark spreads only within its own kolab: the walk follows links of that kolab alone. A link
   * from another kolab relies on this one's committed text, and hears of a change when one
   * commits; this kolab's marks, which say what is in doubt here, stay private (D49, LNK8).
   *
   * Archived kolabs (D52): since a mark spreads only within its own kolab, a live kolab's cascade
   * never marks anything in an archived one here. A dependent in an archived kolab is skipped
   * where Kolab would otherwise write to it from another kolab (reconcileAccessIn); its rebase
   * jobs wait until it is unarchived.
   */
  private async propagateIn(tx: Q, signal: Signal,
    m: { id: string; version_id: string; element_id: string | null; edge_id: string; triggered_by: string }) {
    const markId = m.id;
    const r = { rows: await this.walk(tx, m) };
    for (const row of r.rows) {
      const existing = await tx.query<{ id: string }>(
        `select id from invalidation where version_id = $1 and element_id is not distinct from $2
            and triggered_by = $3 and reason = 'upstream_dirty' and state = 'open'`,
        [row.version_id, row.element_id, m.triggered_by]);
      const target = existing.rows[0]?.id
        ?? await this.markIn(tx, signal, { ...row, triggered_by: m.triggered_by, reason: 'upstream_dirty' });
      await tx.query(`insert into invalidation_cause(mark_id, cause_id) values ($1, $2) on conflict do nothing`, [target, markId]);
    }
  }

  /**
   * Everything downstream of mark `m`'s (version, element), as propagateIn walks it: each live link
   * into any version of a node it reaches, element by element, never re-entering the change itself
   * (the element of `m.triggered_by` that `m.edge_id` addressed), and without the start.
   */
  private async walk(tx: Q, m: { version_id: string; element_id: string | null; edge_id: string | null; triggered_by: string }) {
    const changed = m.edge_id ? (await tx.query<{ target_element_id: string | null }>(
      `select target_element_id from edge where id = $1`, [m.edge_id])).rows[0]?.target_element_id ?? null : null;
    return (await tx.query<{ version_id: string; element_id: string | null }>(
      `with recursive walk(version_id, element_id) as (
         select $1::text, $2::text
         union
         select e.source_version_id, e.source_element_id
           from walk w
           join version wv on wv.id = w.version_id
           join version t on t.node_id = wv.node_id
           join edge e on e.target_version_id = t.id and e.kolab_id = wv.kolab_id
           join version s on s.id = e.source_version_id
          where (w.element_id is null or e.target_element_id is null or e.target_element_id = w.element_id)
            and not (e.source_version_id = $3 and ($4::text is null or e.source_element_id is not distinct from $4::text))
            and ${LIVE('s')}
       )
       select version_id, element_id from walk
        where not (version_id = $1 and element_id is not distinct from $2)`,
      [m.version_id, m.element_id, m.triggered_by, changed])).rows;
  }

  /**
   * After links of `v` were removed (LNK5): an upstream_dirty mark at or below their source
   * elements keeps a cause only while the cause's walk still reaches it, and clears with its last.
   */
  private async settleUnreached(tx: Q, signal: Signal, v: VersionRow, sources: (string | null)[], by: string) {
    const below = new Map<string, { version_id: string; element_id: string | null }>();
    for (const el of new Set(sources)) {
      for (const x of [{ version_id: v.id, element_id: el }, ...await this.walk(tx, { version_id: v.id, element_id: el, edge_id: null, triggered_by: '' })]) {
        below.set(JSON.stringify([x.version_id, x.element_id]), x);
      }
    }
    for (const at of below.values()) {
      const marks = (await tx.query<{ id: string }>(
        `select id from invalidation where version_id = $1 and element_id is not distinct from $2 and reason = 'upstream_dirty' and state = 'open'`,
        [at.version_id, at.element_id])).rows;
      for (const mark of marks) {
        const causes = (await tx.query<{ id: string; version_id: string; element_id: string | null; edge_id: string | null; triggered_by: string }>(
          `select c.id, c.version_id, c.element_id, c.edge_id, c.triggered_by from invalidation_cause k join invalidation c on c.id = k.cause_id
            where k.mark_id = $1`, [mark.id])).rows;
        let left = causes.length;
        for (const c of causes) {
          const reached = (await this.walk(tx, c)).some((x) => x.version_id === at.version_id && x.element_id === at.element_id);
          if (reached) continue;
          await tx.query(`delete from invalidation_cause where mark_id = $1 and cause_id = $2`, [mark.id, c.id]);
          left--;
        }
        if (causes.length && !left) {
          await tx.query(`update invalidation set state = 'cleared', cleared_by = $2 where id = $1`, [mark.id, by]);
          await this.signalLayerOf(tx, signal, at.version_id);
        }
      }
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
    // Read and written in one transaction under the variant's lock, so two runs of one cascade
    // that overlap (W1.8) can't both find no mark and raise two.
    await this.asSystem(async (tx, signal) => {
      const live = (await tx.query<{ id: string }>(
        `select id from version where node_id = $1 and state = 'committed' order by seq desc limit 1`, [nodeId])).rows[0].id;
      const open = (await tx.query<{ id: string }>(
        `select i.id from invalidation i
           join version v on v.id = i.version_id
           join version t on t.id = i.triggered_by
          where v.node_id = $1 and i.reason = 'rebase_failed' and i.state = 'open'
          order by t.seq desc, i.created_at desc, i.id desc limit 1`, [nodeId])).rows[0];
      if (!open) {
        await this.markAndAskIn(tx, signal, { version_id: live, element_id: null, triggered_by: newParent, reason: 'rebase_failed' }, question);
        return;
      }
      await tx.query(`update invalidation set triggered_by = $2, version_id = $3 where id = $1`, [open.id, newParent, live]);
      await tx.query(`update query set question = $2 where invalidation_id = $1 and state = 'open'`, [open.id, question]);
      await this.signalLayerOf(tx, signal, live);
    }, nodeId);
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
        // A fork's rebase rests on the Read its version did (catchUp checked it just now).
        parent_held_by: newParent.kolab_id !== child.kolab_id ? child.parent_held_by ?? null : null,
      }, els, kept);
      if (opts.edgesFrom) {
        await copyEdges(tx, opts.edgesFrom, id, new Set(els.map((e) => e.element_id)));
        // A fold drops what the version it folds drops.
        const removals = (await tx.query<LinkIdentity>(
          `select kind, source_element_id, target_node_id, target_element_id, target_selector from link_removal where version_id = $1`,
          [opts.edgesFrom])).rows;
        await applyRemovals(tx, id, removals.map((r) => ({ ...r, carried: true })));
      }
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
    const now = await this.elements(v.id);
    const revised = now
      .filter((e) => was.get(e.element_id)?.fingerprint !== e.fingerprint || was.get(e.element_id)?.parent_element_id !== e.parent_element_id)
      .map((e) => e.element_id);
    const removed = [...was.keys()].some((id) => !now.some((e) => e.element_id === id));
    if (!revised.length && !removed) return;
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
      // Across kolabs, only an author who reads the target's kolab can have addressed it, and they
      // hold the link from then on (LNK8).
      const across = e.target_kolab_id !== e.kolab_id;
      if (across && !(await this.holds(v.actor_id, e.target_kolab_id))) continue;
      const latest = (await this.latestCommitted(m.target_node))!;
      const r = await this.resolveIn(latest.id, e.target_element_id, e.target_selector);
      if (r.status === 'orphan') continue;
      await this.asSystem((tx) => tx.query(
        `update edge set target_version_id = $2, target_fingerprint = $3, held_by = $4 where id = $1`,
        [e.id, latest.id, r.fingerprint, across ? v.actor_id : e.held_by]));
      await this.closeMark(m.id, addressedBy);
      if (across) await this.holdLink(e.id, v.actor_id);
    }
    const answered = await this.db.query<{ id: string }>(
      `select i.id from invalidation i
         join version me on me.id = $1
        where i.version_id = me.id and i.state = 'open' and i.element_id = any($2)
          and i.reason in ('query_answered', 'upstream_dirty')
          and i.created_at < me.created_at`, [v.id, revised]);
    for (const m of answered.rows) await this.closeMark(m.id, addressedBy);
    // A ruling that changed the intent (D51): settled by a version that revises the element, or
    // removes it, or for a ruling on the whole node, by any revision; its question is answered.
    const live = new Set(now.map((e) => e.element_id));
    const ruled = await this.db.query<{ id: string; element_id: string | null }>(
      `select i.id, i.element_id from invalidation i join version me on me.id = $1
        where i.version_id = me.id and i.state = 'open' and i.reason = 'ruled' and i.created_at < me.created_at`, [v.id]);
    for (const m of ruled.rows) {
      if (m.element_id && live.has(m.element_id) && !revised.includes(m.element_id)) continue;
      await this.closeMark(m.id, addressedBy, `settled: version ${v.seq} of ${await this.nameOf(v.node_id)} ${m.element_id && !live.has(m.element_id) ? 'removes' : 'amends'} it`);
    }
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
            await signal({ inbox: 'layer', kolab: v.kolab_id, layer: v.layer });
          });
        }
        continue;
      }
      await this.markAndAsk({
        version_id: v.id, element_id: d.element_id, delta_id: d.id, triggered_by: v.parent_version_id!, reason,
      }, question);
    }
  }

  /** Resolve a stale or orphaned override. Records precedent for the triple. */
  async resolveOverride(sessionId: string, markId: string, resolution: OverrideResolution, amendedText?: string) {
    // Who may resolve comes first, so whether a mark is an open override mark is told only to the
    // layer that owns it, as answerQuery does. Another kolab's mark reads as one that isn't there.
    const m = (await this.db.query<MarkRow>(`select * from invalidation where id = $1`, [markId])).rows[0];
    const v = m ? await this.version(m.version_id) : undefined;
    if (!m || !v || v.kolab_id !== await this.sessionKolab(sessionId)) throw new Error(`no mark ${markId}`);
    const s = await this.requireLayer(sessionId, v.layer, v.kolab_id);
    if (!m.delta_id || m.state !== 'open') throw new Error(`${markId} is not an open override mark`);
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
    const ruling: Ruling = {
      markId, actor: s.actor_id, resolution, amendedText: amendedText ?? null,
      triple: pe ? [d.base_fingerprint, pe.fingerprint, d.kind === 'remove' ? 'REMOVED' : fingerprint(d.text!)] : undefined,
    };
    // The version and the ruling waiting on it are written together (W1.8): the agent writes the
    // version, then Kolab, as kj_system, the ruling, which no agent may write.
    await this.asAgent(sessionId, async (tx) => {
      await writeVersion(tx, {
        id, node_id: v.node_id, seq: await nextSeq(tx, v.node_id), parent_version_id: v.parent_version_id,
        base_version_id: v.id, layer: v.layer, actor_id: s.actor_id, active_role: s.active_role,
        // A fork's resolution stays on the parent its version is on, held as that version is.
        parent_held_by: v.parent_held_by ?? null,
      }, materialize(parentEls, next), next);
      await tx.exec('set local role none; set local role kj_system');
      await tx.query(`update version set resolves = $2 where id = $1`, [id, JSON.stringify(ruling)]);
    }, v.node_id, { access: !!v.parent_held_by });

    // The resolution is itself a new version: it must clear the gate, and its review if it has
    // reviewers, before the mark closes, the query is answered, or precedent is set. The ruling waits
    // on the version (version.resolves), and commitStep records all three as it commits, before the
    // cascade, whenever that is.
    const verdict = await this.review(id);
    return { version: id, verdict };
  }

  // ---- clearing ------------------------------------------------------------

  /**
   * "I checked; my dependent still holds." Re-pins the edge and clears what it caused. Across
   * kolabs only someone who reads the target's kolab can check, and they hold the link from then
   * on (LNK8). An access_lost mark is cleared by someone who reads what its holder no longer does:
   * they hold the link or fork, the mark settles, and the link is checked, or the fork caught up,
   * against the other kolab's latest version.
   */
  async clear(sessionId: string, markId: string) {
    const m = await this.markRow(markId);
    const v = await this.version(m.version_id);
    const s = await this.requireLayer(sessionId, v.layer, v.kolab_id);
    if (m.delta_id) throw new Error('use resolveOverride for override marks');
    if (m.reason === 'ruled') throw new GateError('a ruling changed this element\'s intent: amend it and commit; that version settles the mark (D51)');
    if (m.reason === 'access_lost') return this.takeOver(s.actor_id, m, v);
    if (m.edge_id) {
      const e = (await this.db.query<EdgeRow>(`select * from edge where id = $1`, [m.edge_id])).rows[0];
      const across = e.target_kolab_id !== e.kolab_id;
      if (across && !(await this.holds(s.actor_id, e.target_kolab_id))) {
        throw new AccessError(`${s.actor_id} can't read kolab ${e.target_kolab_id}, so can't check this link into it; someone who reads it clears it`);
      }
      const tNode = (await this.version(e.target_version_id)).node_id;
      const source = (await this.version(e.source_version_id)).node_id;
      // The re-pin, the new holder and the clear are one transaction: across kolabs, under a shared
      // hold on the access lock and then the dependent's lock, with the holder checked again in it,
      // so a revoke can't land between the check and the link it allows (LNK8).
      await this.asSystem(async (tx, signal) => {
        if (across && await this.unvouchedLink({ ...e, held_by: s.actor_id }, tx)) {
          throw new AccessError(`${s.actor_id} can't read kolab ${e.target_kolab_id}, so can't check this link into it; someone who reads it clears it`);
        }
        const latest = (await tx.query<{ id: string }>(
          `select id from version where node_id = $1 and state = 'committed' order by seq desc limit 1`, [tNode])).rows[0].id;
        const r = resolveInElements(await this.elements(latest, tx), e.target_element_id, e.target_selector);
        if (r.status === 'orphan') throw new GateError('the target no longer exists; re-link instead of clearing');
        const now = (await tx.query<EdgeRow>(
          `update edge set target_version_id = $2, target_fingerprint = $3, held_by = $4 where id = $1 returning *`,
          [e.id, latest, r.fingerprint, s.actor_id])).rows[0];
        await this.closeMarkIn(tx, signal, markId, s.actor_id);
        // They hold the link now, so an access_lost mark its earlier holder left settles too.
        if (across) await this.restoreLinkIn(tx, signal, now, `held by ${s.actor_id}, who reads kolab ${e.target_kolab_id}`);
      }, source, { access: across });
      return;
    }
    await this.closeMark(markId, s.actor_id);
  }

  /** clear, for an access_lost mark: `actor`, who must read the other kolab, holds the link or fork now. */
  private async takeOver(actor: string, m: MarkRow, v: VersionRow) {
    if (m.state !== 'open') throw new GateError(`mark ${m.id} is already cleared`);
    if (m.edge_id) {
      const e = (await this.db.query<EdgeRow>(`select * from edge where id = $1`, [m.edge_id])).rows[0];
      if (!(await this.holds(actor, e.target_kolab_id))) {
        throw new AccessError(`${actor} can't read kolab ${e.target_kolab_id} either: only someone who reads it can hold this link`);
      }
      await this.holdLink(e.id, actor);
      return;
    }
    const parent = await this.version(v.parent_version_id!);
    if (!(await this.holds(actor, parent.kolab_id!))) {
      throw new AccessError(`${actor} can't read kolab ${parent.kolab_id} either: only someone who reads it can hold this fork`);
    }
    await this.asSystem(async (tx, signal) => {
      await tx.query(`update version set parent_held_by = $2 where id = $1`, [v.id, actor]);
      await this.closeMarkIn(tx, signal, m.id, `held by ${actor}, who reads kolab ${parent.kolab_id}`);
    }, v.node_id, { access: true });
    await this.catchUp(v.node_id);
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
    // Anyone with access may ask (Q1), about what is in the kolab they work in: questions stay in
    // their kolab, whose layers answer them (TEN12); a link or a fork may cross (LNK8, KON9).
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
    // Who may answer comes first, so the query's state, and whether a mark raised it, are told only
    // to the layer that owns the answer. Another kolab's query reads as one that isn't there.
    const v = q ? await this.version(q.version_id) : undefined;
    if (!q || !v || v.kolab_id !== await this.sessionKolab(sessionId)) throw new Error(`no query ${queryId}`);
    const s = await this.requireLayer(sessionId, v.layer, v.kolab_id);
    if (q.state !== 'open') throw new GateError(`query ${queryId} is already answered`);
    const mark = q.invalidation_id ? await this.markRow(q.invalidation_id) : undefined;
    if (mark?.reason === 'ruled') {
      throw new GateError(`query ${queryId} asks for the element a ruling changed to be amended: commit a version that amends it, and that settles the question (D51)`);
    }
    if (mark && mark.reason !== 'role_boundary') {
      throw new GateError(`query ${queryId} is about a dirty mark; resolve it with konjir_resolve_override or konjir_clear_mark`);
    }
    // Everything an answer causes happens in the transaction that answers, so nothing of it waits
    // in memory (W1.8): the owner's queue shrinks, the asker's answers grow, a boundary question's
    // mark is settled with it, and the element that asked is marked.
    await this.asSystem(async (tx, signal) => {
      const r = await tx.query(`update query set state = 'answered', answer = $2, answered_by = $3 where id = $1 and state = 'open' returning id`,
        [queryId, answer, s.actor_id]);
      if (!r.rows.length) throw new GateError(`query ${queryId} is already answered`);
      await signal({ inbox: 'layer', kolab: v.kolab_id, layer: v.layer });
      if (q.raised_by) await signal({ inbox: 'actor', kolab: v.kolab_id, actor: q.raised_by });
      // A boundary question is settled by the layer that owns the answer; its mark goes with it.
      const open = mark && (await tx.query(`select 1 from invalidation where id = $1 and state = 'open'`, [mark.id])).rows.length;
      if (open) await this.closeMarkIn(tx, signal, mark.id, `answered by ${s.actor_id}: ${answer}`);
      if (q.kind === 'question' && q.from_version_id) await this.markAsker(tx, signal, q, v, answer);
    });
  }

  /**
   * The element that asked now has its answer: mark it on its node's live
   * version (the draft it was asked from may have committed, or been
   * superseded since). If the element is gone, the asker still sees the
   * answer through list_queries mine=true. In the answer's transaction.
   */
  private async markAsker(tx: Q, signal: Signal,
    q: { element_id: string | null; question: string; from_version_id: string | null; from_element_id: string | null },
    asked: VersionRow, answer: string) {
    const latest = async (node: string) => (await tx.query<{ id: string }>(
      `select id from version where node_id = $1 and state = 'committed' order by seq desc limit 1`, [node])).rows[0]?.id;
    const fromNode = (await tx.query<{ node_id: string }>(`select node_id from version where id = $1`, [q.from_version_id])).rows[0].node_id;
    const live = await latest(fromNode) ?? q.from_version_id!;
    if (q.from_element_id && !(await tx.query(`select 1 from element where version_id = $1 and element_id = $2`, [live, q.from_element_id])).rows.length) return;
    const askedName = (await tx.query<{ name: string }>(`select name from node where id = $1`, [asked.node_id])).rows[0].name;
    const on = formatAddress({ node: askedName, element: q.element_id ?? undefined });
    await this.markIn(tx, signal, {
      version_id: live, element_id: q.from_element_id, reason: 'query_answered',
      triggered_by: await latest(asked.node_id) ?? asked.id,
      note: `${on}: you asked "${q.question}"; answered: "${answer}"`,
    });
  }

  // ---- case files, positions and rulings (CASE1–CASE7, D16, D49, D51) --------

  /**
   * Opens a case file (CASE1, CASE5): a disagreement the session's actor couldn't settle, about an
   * element of a committed version in its kolab, with the opener's position: its claim, its
   * evidence, and the side it takes (`seeks`: keep the intent as written, or change it). Only one
   * who belongs to the kolab's work may, holding Write on a layer of it (D49). It waits in the inbox
   * of the element's layer for the other side's position and then a person's ruling, and blocks
   * nothing (CASE7). Returns the case file's id.
   */
  async openCase(sessionId: string, address: Address | string,
    input: { question: string; claim: string; evidence: string[]; seeks: RulingEffect }): Promise<string> {
    const s = await this.session(sessionId);
    belonging(s, 'open a case file');
    const a = typeof address === 'string' ? parseAddress(address) : address;
    const question = requireText(input.question, 'the question in dispute');
    if (!RULING_EFFECTS.includes(input.seeks)) throw new GateError(`say which side your position takes: seeks=${RULING_EFFECTS.join(' or ')}`);
    const position = await this.positionInput(sessionId, input);
    if (!a.element) throw new GateError('a case file is about one element: name it, as kj:<node>#<element>');
    if (a.selector) throw new GateError('a case file is about a whole element; quote the words you mean in your claim instead');
    const v = await this.versionIn(sessionId, a, { what: 'opening a case file' });
    if ((await this.resolveIn(v.id, a.element, null)).status === 'orphan') {
      throw new Error(`${formatAddress({ node: await this.nameOf(v.node_id), version: v.seq, element: a.element })} doesn't exist`);
    }
    const id = ulid();
    await this.asSystem(async (tx, signal) => {
      await tx.query(`insert into case_file(id, version_id, element_id, question, opened_by) values ($1, $2, $3, $4, $5)`,
        [id, v.id, a.element, question, s.actor_id]);
      await tx.query(`insert into position(id, case_file_id, actor_id, claim, evidence, seeks) values ($1, $2, $3, $4, $5, $6)`,
        [ulid(), id, s.actor_id, position.claim, JSON.stringify(position.evidence), input.seeks]);
      await signal({ inbox: 'layer', kolab: s.kolab, layer: v.layer });
      await signal({ inbox: 'actor', kolab: s.kolab, actor: s.actor_id });
    });
    return id;
  }

  /**
   * Takes the other side of an open case file (CASE1): the opposite of the opener's, so a case file
   * holds one position for each side. Only one who can be the other side may: who belongs to the
   * kolab's work (Write on a layer of it, D49), and isn't the opener's own person or one of their
   * agents, since one person and their agents are one side. Returns the position's id.
   */
  async addPosition(sessionId: string, caseId: string, input: { claim: string; evidence: string[] }): Promise<string> {
    const s = await this.session(sessionId);
    belonging(s, 'argue a case file');
    const position = await this.positionInput(sessionId, input);
    const c = await this.caseIn(sessionId, caseId);
    const id = ulid();
    await this.asSystem(async (tx, signal) => {
      // Under the case file's row lock, so two positions can't both be the second, and none lands after the ruling.
      const locked = (await tx.query<{ state: string }>(`select state from case_file where id = $1 for update`, [c.id])).rows[0];
      if (locked.state !== 'open') throw new GateError(`case file ${c.id} is already ${locked.state === 'ruled' ? 'ruled on' : 'superseded by a ruling'}; its ruling is precedent (konjir_read_case case=${c.id})`);
      const taken = await partiesIn(tx, c.id);
      if (taken.some((p) => p.actor === s.actor_id)) throw new GateError(`${s.actor_id} already holds a position on case file ${c.id}`);
      if (taken.length >= CASE_POSITIONS) throw new GateError(`case file ${c.id} already holds both sides; it waits for a ruling`);
      const mine = principalOf(s.actor_id, s);
      const same = taken.find((p) => p.principal === mine);
      if (same) {
        throw new AccessError(`${s.actor_id} can't take the other side of case file ${c.id}: ${same.actor} holds its first side, and one person and their agents are one side`);
      }
      const first = taken[0];
      if (!first?.seeks) throw new GateError(`case file ${c.id} was opened before positions took sides; open a new one`);
      await tx.query(`insert into position(id, case_file_id, actor_id, claim, evidence, seeks) values ($1, $2, $3, $4, $5, $6)`,
        [id, c.id, s.actor_id, position.claim, JSON.stringify(position.evidence), opposite(first.seeks)]);
      await signal({ inbox: 'layer', kolab: c.kolab_id, layer: c.layer });
      for (const actor of new Set([c.opened_by, ...taken.map((p) => p.actor), s.actor_id])) {
        if (actor) await signal({ inbox: 'actor', kolab: c.kolab_id, actor });
      }
    });
    return id;
  }

  /**
   * A person's ruling (CASE2–CASE6). With `case`, it rules on that case file, once it holds both
   * sides: exactly one position is sustained and the other overruled (`verdicts`, by position id),
   * and its effect is the side the sustained position seeks (`effect`, if given, must say the same).
   * With `address`, it is given directly, on an element or a node of a committed version, with no
   * case file behind it (CASE3, D16), and `effect` says what it does; any case file still open on
   * that element is superseded by it. Either way it records its author and date, and is precedent
   * in its kolab from then on (CASE4, TEN13). It never changes once given; a later ruling says what
   * it overrules (`replaces`). One that changes the intent marks the element it rules on, with a
   * question to its layer, until a later version of the element settles it (D51).
   *
   * Who rules (D51): a person, never an agent (CASE2), from a session in the role that writes the
   * element's layer, holding Write on that layer in the kolab. On a case file, never a party: not
   * one who holds a position on it, nor the person whose agent does. Returns the ruling's id.
   */
  async rule(sessionId: string, input: {
    case?: string; address?: Address | string; text: string; effect?: RulingEffect;
    verdicts?: Record<string, PositionVerdict>; replaces?: string;
  }): Promise<string> {
    const text = requireText(input.text, 'the ruling');
    if (input.effect !== undefined && !RULING_EFFECTS.includes(input.effect)) throw new GateError(`a ruling's effect is ${RULING_EFFECTS.join(' or ')} (CASE6)`);
    const replaces = input.replaces === undefined ? null : requireText(input.replaces, 'what the ruling replaces');
    if ((input.case === undefined) === (input.address === undefined)) throw new GateError('rule on a case file (case) or directly on an element (address), not both or neither');
    const s = await this.session(sessionId);
    const ruler = async (layer: Layer, kolab: string) => {
      if (s.kind !== 'person') {
        throw new AccessError(`only a person rules (CASE2): ${s.actor_id} is an agent${s.owner ? ` of ${s.owner}, who can rule from a session of their own` : ''}`);
      }
      await this.requireLayer(sessionId, layer, kolab);
    };
    const id = ulid();
    if (input.case !== undefined) {
      const c = await this.caseIn(sessionId, input.case);
      await ruler(c.layer, c.kolab_id);
      const verdicts = input.verdicts ?? {};
      for (const [p, verdict] of Object.entries(verdicts)) {
        if (!POSITION_VERDICTS.includes(verdict)) throw new GateError(`position ${p}'s verdict is ${POSITION_VERDICTS.join(' or ')}`);
      }
      await this.asSystem(async (tx, signal) => {
        const locked = (await tx.query<{ state: string }>(`select state from case_file where id = $1 for update`, [c.id])).rows[0];
        if (locked.state !== 'open') throw new GateError(`case file ${c.id} is already ${locked.state === 'ruled' ? 'ruled on' : 'superseded by a ruling'}`);
        const positions = await partiesIn(tx, c.id);
        const party = positions.find((p) => p.actor === s.actor_id || p.principal === s.actor_id);
        if (party) {
          throw new AccessError(`${s.actor_id} is a party to case file ${c.id}${party.actor === s.actor_id ? '' : `: its agent ${party.actor} holds a position on it`}, so can't rule on it`);
        }
        if (positions.length < CASE_POSITIONS) {
          throw new GateError(`case file ${c.id} holds ${positions.length} position; it is ruled on once it holds both sides. Rule directly on ${c.on} instead (address) if it can't wait`);
        }
        const ids = new Set(positions.map((p) => p.id));
        const given = Object.keys(verdicts);
        if (given.length !== ids.size || given.some((p) => !ids.has(p))) {
          throw new GateError(`give each position of case file ${c.id} a verdict, sustained or overruled: verdicts={${positions.map((p) => `"${p.id}":…`).join(',')}}`);
        }
        const sustained = positions.filter((p) => verdicts[p.id] === 'sustained');
        if (sustained.length !== 1) {
          throw new GateError(`a ruling on a case file sustains exactly one of its two positions and overrules the other; these verdicts sustain ${sustained.length}`);
        }
        const effect = sustained[0].seeks;
        if (!effect) throw new GateError(`case file ${c.id} was opened before positions took sides; rule directly on ${c.on} instead (address)`);
        if (input.effect !== undefined && input.effect !== effect) {
          throw new GateError(`the sustained position seeks to ${effect === 'keep_intent' ? 'keep' : 'change'} the intent, so the ruling's effect is ${effect}, not ${input.effect}`);
        }
        await tx.query(`insert into ruling(id, case_file_id, actor_id, text, replaces, effect) values ($1, $2, $3, $4, $5, $6)`,
          [id, c.id, s.actor_id, text, replaces, effect]);
        for (const p of positions) await tx.query(`update position set verdict = $2 where id = $1`, [p.id, verdicts[p.id]]);
        await tx.query(`update case_file set state = 'ruled' where id = $1`, [c.id]);
        if (effect === 'change_intent') await this.markRuled(tx, signal, { versionId: c.version_id, element: c.element_id, ruling: id, text, on: c.on });
        await signal({ inbox: 'layer', kolab: c.kolab_id, layer: c.layer });
        for (const actor of new Set([c.opened_by, ...positions.map((p) => p.actor)])) {
          if (actor) await signal({ inbox: 'actor', kolab: c.kolab_id, actor });
        }
      });
      return id;
    }
    if (input.verdicts !== undefined) throw new GateError('verdicts are for the positions of a case file; a direct ruling has none');
    if (input.effect === undefined) throw new GateError(`say what a direct ruling does: effect=${RULING_EFFECTS.join(' or ')} (CASE6)`);
    const effect = input.effect;
    const a = typeof input.address === 'string' ? parseAddress(input.address) : input.address!;
    if (a.selector) throw new GateError('a ruling is on a node or a whole element; quote the words you mean in its text');
    const v = await this.versionIn(sessionId, a, { what: 'ruling' });
    const on = formatAddress({ node: await this.nameOf(v.node_id), version: v.seq, element: a.element });
    if (a.element && (await this.resolveIn(v.id, a.element, null)).status === 'orphan') throw new Error(`${on} doesn't exist`);
    await ruler(v.layer, v.kolab_id!);
    await this.asSystem(async (tx, signal) => {
      await tx.query(`insert into ruling(id, version_id, element_id, actor_id, text, replaces, effect) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, v.id, a.element ?? null, s.actor_id, text, replaces, effect]);
      // The question is settled: any case file still open on the element is superseded by this ruling.
      const superseded = a.element ? (await tx.query<{ id: string; opened_by: string | null }>(
        `update case_file c set state = 'superseded', superseded_by = $1
          where c.state = 'open' and c.element_id = $2 and c.kolab_id = $3
            and c.version_id in (select id from version where node_id = $4)
         returning c.id, c.opened_by`, [id, a.element, v.kolab_id, v.node_id])).rows : [];
      const parties = superseded.length ? (await tx.query<{ actor_id: string }>(
        `select distinct actor_id from position where case_file_id = any($1)`, [superseded.map((c) => c.id)])).rows.map((r) => r.actor_id) : [];
      if (effect === 'change_intent') await this.markRuled(tx, signal, { versionId: v.id, element: a.element ?? null, ruling: id, text, on });
      // New precedent in the kolab, and the superseded case files leave the inbox and reach their parties.
      await signal({ inbox: 'layer', kolab: v.kolab_id!, layer: v.layer });
      for (const actor of new Set([...superseded.map((c) => c.opened_by), ...parties])) {
        if (actor) await signal({ inbox: 'actor', kolab: v.kolab_id!, actor });
      }
    });
    return id;
  }

  /**
   * A ruling that changes the intent (D51): marks the element it rules on, on its node's live
   * version, with a question to its layer, in the ruling's transaction. A later version that revises
   * or removes the element settles both. Nothing is marked when the live version no longer has it.
   */
  private async markRuled(tx: Q, signal: Signal, r: { versionId: string; element: string | null; ruling: string; text: string; on: string }) {
    const live = (await tx.query<{ id: string }>(
      `select l.id from version l join version v on v.node_id = l.node_id
        where v.id = $1 and l.state = 'committed' order by l.seq desc limit 1`, [r.versionId])).rows[0]?.id ?? r.versionId;
    if (r.element && !(await tx.query(`select 1 from element where version_id = $1 and element_id = $2`, [live, r.element])).rows.length) return;
    const what = r.on.replace(/@\d+/, '');
    await this.markAndAskIn(tx, signal, {
      version_id: live, element_id: r.element, reason: 'ruled', triggered_by: r.versionId,
      note: `ruling ${r.ruling} changes the intent of ${what}: "${r.text}"`,
    }, `Ruling ${r.ruling} changes the intent of ${what}: "${r.text}". Amend ${what} to say what the ruling says, and commit it; that version settles this.`);
  }

  /** A position's claim and evidence, checked: each kj: address in the evidence must resolve for the session. */
  private async positionInput(sessionId: string, input: { claim: string; evidence: string[] }) {
    const claim = requireText(input.claim, 'your position\'s claim');
    if (!Array.isArray(input.evidence) || !input.evidence.length) {
      throw new GateError('a position needs its evidence (CASE1): the requirement, code, commit or test run that backs the claim');
    }
    if (input.evidence.length > MAX_EVIDENCE) throw new GateError(`a position cites at most ${MAX_EVIDENCE} pieces of evidence`);
    const evidence = input.evidence.map((e) => requireText(e, 'each piece of evidence'));
    for (const e of evidence) {
      if (!e.startsWith('kj:')) continue;
      const r = await this.resolve(e, { session: sessionId });
      if (r.status === 'orphan') throw new Error(`evidence ${e} does not resolve`);
    }
    return { claim, evidence };
  }

  /**
   * A case file in the session's kolab, with its subject. Read as kj_agent, so another kolab's, or
   * any at all for a session that holds only Read (D49), reads as none (TEN12).
   */
  private async caseIn(sessionId: string, caseId: string) {
    const kolab = await this.sessionKolab(sessionId);
    const c = await this.read({ session: sessionId }, async (q) => (await q.query<{
      id: string; kolab_id: string; layer: Layer; opened_by: string | null; node: string; seq: number; element_id: string | null; version_id: string;
    }>(`select c.id, c.kolab_id, v.layer, c.opened_by, n.name as node, v.seq, c.element_id, c.version_id
          from case_file c join version v on v.id = c.version_id join node n on n.id = v.node_id
         where c.id = $1 and c.kolab_id = $2`, [caseId, kolab])).rows[0]);
    if (!c) throw new Error(`no case file ${caseId} in kolab ${kolab}`);
    return { ...c, on: formatAddress({ node: c.node, version: c.seq, element: c.element_id ?? undefined }) };
  }

  /**
   * Case files in a kolab, most recently changed first (opened, argued, ruled or superseded): with
   * `layer`, those about that layer's elements; with `state`, only those in it; with `actor`, those it
   * opened or holds a position on; with `node` (a node's id), those about it; with `id`, that one.
   * Run on `q`: a session's reads run as kj_agent, so row-level security bounds them too.
   */
  async listCases(filter: { kolab: string; layer?: Layer; state?: CaseFileState; actor?: string; node?: string; id?: string; limit?: number },
    q: Q = this.db): Promise<CaseFileView[]> {
    const rows = (await q.query<{
      id: string; node: string; seq: number; element_id: string | null; layer: Layer; question: string | null;
      state: CaseFileState; opened_by: string | null; opened_at: Date | string | null; superseded_by: string | null;
    }>(
      `select c.id, n.name as node, v.seq, c.element_id, v.layer, c.question, c.state, c.opened_by, c.opened_at, c.superseded_by
         from case_file c join version v on v.id = c.version_id join node n on n.id = v.node_id
        where c.kolab_id = $1 and ($2::text is null or v.layer = $2) and ($3::text is null or c.state = $3)
          and ($4::text is null or c.opened_by = $4 or exists (select 1 from position p where p.case_file_id = c.id and p.actor_id = $4))
          and ($5::text is null or v.node_id = $5) and ($6::text is null or c.id = $6)
        order by greatest(c.opened_at, (select max(p.created_at) from position p where p.case_file_id = c.id),
                          (select max(r.ruled_at) from ruling r where r.case_file_id = c.id or r.id = c.superseded_by)) desc nulls last,
                 c.id desc limit $7`,
      [filter.kolab, filter.layer ?? null, filter.state ?? null, filter.actor ?? null, filter.node ?? null, filter.id ?? null, filter.limit ?? 50])).rows;
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const positions = (await q.query<{ id: string; case_file_id: string; actor_id: string; claim: string; evidence: unknown; seeks: RulingEffect | null; verdict: PositionVerdict | null; created_at: Date | string | null }>(
      `select id, case_file_id, actor_id, claim, evidence, seeks, verdict, created_at from position where case_file_id = any($1) order by created_at nulls first, id`, [ids])).rows;
    const rulings = await this.listRulings({ kolab: filter.kolab, cases: ids, ids: rows.flatMap((r) => (r.superseded_by ? [r.superseded_by] : [])) }, q);
    return rows.map((r) => {
      const on = formatAddress({ node: r.node, version: r.seq, element: r.element_id ?? undefined });
      const ps = positions.filter((p) => p.case_file_id === r.id).map((p) => ({
        position: p.id, actor: p.actor_id, claim: p.claim, evidence: evidenceOf(p.evidence), seeks: p.seeks, verdict: p.verdict, taken_at: iso(p.created_at),
      }));
      const ruling = rulings.find((x) => (r.superseded_by ? x.ruling === r.superseded_by : x.case === r.id)) ?? null;
      return {
        case: r.id, on, layer: r.layer, question: r.question, state: r.state, opened_by: r.opened_by, opened_at: iso(r.opened_at),
        positions: ps, ruling, superseded_by: r.superseded_by,
        next: r.state !== 'open'
          ? `${r.state === 'superseded' ? `Superseded by ruling ${r.superseded_by}, given directly on ${ruling?.on ?? on}` : 'Ruled'}${ruling ? ` by ${ruling.ruled_by}: it ${ruling.effect === 'change_intent' ? 'changes the intent, so the element is marked until it is amended' : ruling.effect === 'keep_intent' ? 'keeps the intent: find another way to meet it as written' : 'stands'}` : ''}. It is precedent in this kolab: don't argue it again.`
          : ps.length < CASE_POSITIONS
            ? `Waiting for the other side: konjir_add_position case=${r.id} claim=… evidence=[…], from someone with Write in this kolab who isn't ${ps[0]?.actor ?? 'the opener'} or of the same person, to ${ps[0]?.seeks === 'change_intent' ? 'keep' : 'change'} the intent. Work continues meanwhile (CASE7).`
            : `Waiting for a ruling from a person with Write on the ${r.layer} layer who isn't a party: konjir_rule case=${r.id} text=… verdicts={${ps.map((p) => `"${p.position}":"sustained|overruled"`).join(',')}}, sustaining exactly one. Work continues meanwhile (CASE7).`,
      };
    });
  }

  /**
   * Rulings in a kolab, newest first: precedent (CASE4). With `node` (a node's id), those on it,
   * directly or through a case file; with `cases` and `ids`, those on these case files or with these
   * ids. Run on `q`, as listCases.
   */
  async listRulings(filter: { kolab: string; node?: string; cases?: string[]; ids?: string[]; limit?: number }, q: Q = this.db): Promise<RulingView[]> {
    const pick = filter.cases !== undefined || filter.ids !== undefined;
    const rows = (await q.query<{
      id: string; case_file_id: string | null; node: string; seq: number; element_id: string | null; text: string;
      effect: RulingEffect | null; replaces: string | null; actor_id: string; ruled_at: Date | string | null;
    }>(
      `select r.id, r.case_file_id, n.name as node, v.seq, coalesce(r.element_id, c.element_id) as element_id, r.text,
              r.effect, r.replaces, r.actor_id, r.ruled_at
         from ruling r left join case_file c on c.id = r.case_file_id
         join version v on v.id = coalesce(r.version_id, c.version_id) join node n on n.id = v.node_id
        where r.kolab_id = $1 and ($2::text is null or v.node_id = $2)
          and (not $3 or r.case_file_id = any($4::text[]) or r.id = any($5::text[]))
        order by r.ruled_at desc nulls last, r.id desc limit $6`,
      [filter.kolab, filter.node ?? null, pick, filter.cases ?? [], filter.ids ?? [], filter.limit ?? 50])).rows;
    return rows.map((r) => ({
      ruling: r.id, on: formatAddress({ node: r.node, version: r.seq, element: r.element_id ?? undefined }), case: r.case_file_id,
      text: r.text, effect: r.effect, replaces: r.replaces, ruled_by: r.actor_id, ruled_at: iso(r.ruled_at),
    }));
  }

  /** A session's case files, read as kj_agent: listCases in its own kolab (none for a session that holds only Read, D49). */
  async casesFor(sessionId: string, filter: Omit<Parameters<Kolab['listCases']>[0], 'kolab'>): Promise<CaseFileView[]> {
    const kolab = await this.sessionKolab(sessionId);
    return this.read({ session: sessionId }, (q) => this.listCases({ ...filter, kolab }, q));
  }

  /** A session's precedent, read as kj_agent: listRulings in its own kolab (none for a session that holds only Read, D49). */
  async rulingsFor(sessionId: string, filter: Omit<Parameters<Kolab['listRulings']>[0], 'kolab'>): Promise<RulingView[]> {
    const kolab = await this.sessionKolab(sessionId);
    return this.read({ session: sessionId }, (q) => this.listRulings({ ...filter, kolab }, q));
  }

  /**
   * A session's questions and notes, read as kj_agent: listQueries in its own kolab. Row-level
   * security leaves out, for a session that holds only Read, the questions marks raised there
   * (0022; D49, D51): its marks and rulings stay private to those who belong to its work.
   */
  async queriesFor(sessionId: string, filter: Omit<Parameters<Kolab['listQueries']>[0], 'kolab' | 'from'>): Promise<Query[]> {
    const kolab = await this.sessionKolab(sessionId);
    return this.read({ session: sessionId }, (q) => this.listQueries({ ...filter, kolab }, q));
  }

  /**
   * A session's open marks, described: describeMarks in its own kolab, over the marks the session
   * reads as kj_agent. Row-level security gives a session that holds only Read none (0022; D49):
   * a mark's note can quote a ruling or the review gate's finding, private to those who belong to
   * the kolab's work. The marks are picked as the session, filtered there by layer and node, and
   * described as Kolab. What triggered a mark is named only if the session reads it too: a version
   * in another kolab it no longer holds Read on (access_lost) goes unnamed, as on the web page.
   */
  async marksFor(sessionId: string, filter: { layer?: Layer; node?: string } = {}) {
    const kolab = await this.sessionKolab(sessionId);
    const picked = await this.read({ session: sessionId }, async (q) => (await q.query<{ id: string; named: boolean }>(
      `select i.id, tn.id is not null as named
         from invalidation i join version v on v.id = i.version_id
         left join version tv on tv.id = i.triggered_by left join node tn on tn.id = tv.node_id
        where i.state = 'open' and i.kolab_id = $1
          and ($2::text is null or v.layer = $2) and ($3::text is null or v.node_id = $3)`,
      [kolab, filter.layer ?? null, filter.node ?? null])).rows);
    return picked.length ? this.describeMarks({
      ...filter, kolab, ids: picked.map((r) => r.id), unnamed: picked.filter((r) => !r.named).map((r) => r.id),
    }) : [];
  }

  /** Whether a session belongs to its kolab's work (D49): its actor holds Write on a layer of it, not Read alone. */
  async sessionBelongs(sessionId: string): Promise<boolean> {
    return (await this.session(sessionId)).access.layers.length > 0;
  }

  // ---- inspection ----------------------------------------------------------

  async sessionInfo(sessionId: string) {
    const s = await this.session(sessionId);
    return {
      session: s.id, actor: s.actor_id, kind: s.kind, owner: s.owner,
      role: s.active_role, layer: LAYER_OF_ROLE[s.active_role], kolab: s.kolab, access: s.access,
    };
  }

  /** Nodes, of one kind if given, in one kolab if given, with the names addresses give them. */
  async listNodes(kind?: Kind, kolab?: string) {
    return (await this.db.query<{ id: string; name: string; kolab: string; kind: Kind; layer: Layer; title: string; latest: number | null; drafts: number; in_review: number; rebase_pending: boolean; rebase_dead: boolean }>(
      `select n.id, n.name, n.kolab_id as kolab, n.kind, n.layer, n.title,
              (select max(seq) from version v where v.node_id = n.id and v.state = 'committed') as latest,
              (select count(*)::int from version v where v.node_id = n.id and v.state = 'drafted') as drafts,
              (select count(*)::int from version v where v.node_id = n.id and v.state = 'in_review') as in_review,
              exists (select 1 from outbox o join version v on v.id = o.version_id
                       where o.kind = 'rebase' and o.state = 'pending' and v.node_id = n.id and ${BEHIND('n.id')}) as rebase_pending,
              exists (select 1 from outbox o join version v on v.id = o.version_id
                       where o.kind = 'rebase' and o.state = 'dead' and v.node_id = n.id and ${BEHIND('n.id')}) as rebase_dead
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
    // Links are their own kolab's: downstream, only links from this version's kolab show (D49).
    const sql = direction === 'upstream'
      ? `select ${cols} where e.source_version_id = $1 and $2::text is not null`
      : `select ${cols} where tv.node_id = (select node_id from version where id = $1) and e.kolab_id = $2 and ${LIVE('sv')}`;
    const from = (await this.version(versionId)).kolab_id!;
    const rows = (await this.db.query<{
      id: string; kind: string; source_element_id: string | null; source_node: string; source_kolab: string; source_seq: number;
      target_element_id: string | null; target_selector: QuoteSelector | null; target_node: string; target_kolab: string; target_seq: number;
    }>(sql, [versionId, from])).rows;
    return rows.map((r) => ({
      edge: r.id,
      kind: r.kind,
      source: formatAddress({ kolab: r.source_kolab, node: r.source_node, version: r.source_seq, element: r.source_element_id ?? undefined }, { from }),
      target: formatAddress({ kolab: r.target_kolab, node: r.target_node, version: r.target_seq, element: r.target_element_id ?? undefined, selector: r.target_selector ?? undefined }, { from }),
    }));
  }

  /**
   * Open marks with the addresses involved, so an agent can act without more lookups. `node` is a
   * node's id. Addresses are in the short form of the mark's own kolab. The marks in `unnamed` don't
   * name what triggered them: their reader can't read it (marksFor).
   */
  async describeMarks(filter: { layer?: Layer; node?: string; kolab?: string; ids?: string[]; unnamed?: string[] } = {}) {
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
          and ($4::text[] is null or i.id = any($4))
        order by i.created_at, i.id`, [filter.layer ?? null, filter.node ?? null, filter.kolab ?? null, filter.ids ?? null])).rows;
    const unnamed = new Set(filter.unnamed ?? []);
    return rows.map((r) => {
      const from = r.kolab_id;
      const trig = (a: Omit<Address, 'node' | 'kolab'>) => formatAddress({ kolab: r.trig_kolab, node: r.trig_node, ...a }, { from });
      return {
        mark: r.id,
        reason: r.reason,
        ...(r.edge_id ? { link: r.edge_id } : {}),
        dirty: formatAddress({ node: r.node, version: r.seq, element: r.element_id ?? undefined }),
        layer: r.layer,
        because: markBecause(r, (linked) => unnamed.has(r.id) ? undefined
          : trig(linked ? { element: r.t_element ?? undefined, selector: r.t_selector ?? undefined } : {})),
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
    /** Only the newest this many, by id (ULIDs sort by time), still listed oldest first. */
    newest?: number;
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
        order by q.id desc limit $7`,
      [filter.layer ?? null, filter.state ?? null, filter.raisedBy ?? null, filter.node ?? null, filter.kind ?? null, filter.kolab ?? null,
        filter.newest ?? null])).rows.reverse();
    // A reader outside a query's kolab (D49) sees only the questions and notes people raised: never
    // one a mark raised (a boundary, a ruling that changes the intent, D51), since that kolab's marks
    // and rulings stay private, and never which element of its asked. Row-level security holds
    // kj_agent to the first too (0016).
    const outside = (r: { kolab_id: string }) => filter.from !== undefined && r.kolab_id !== filter.from;
    return rows.filter((r) => !(outside(r) && r.mark)).map((r) => ({
      id: r.id, kind: r.kind,
      address: formatAddress({ kolab: r.kolab_id, node: r.node, version: r.seq, element: r.element_id ?? undefined, selector: r.selector ?? undefined }, { from: filter.from ?? r.kolab_id }),
      question: r.question, state: r.state, answer: r.answer, answered_by: r.answered_by, raised_by: r.raised_by,
      from: r.from_node && !outside(r) ? formatAddress({ kolab: r.from_kolab!, node: r.from_node, version: r.from_seq!, element: r.from_element_id ?? undefined }, { from: filter.from ?? r.kolab_id }) : null,
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

  /** Raises a mark, in `tx`, and signals its layer. */
  private async markIn(tx: Q, signal: Signal, m: MarkInput): Promise<string> {
    const id = ulid();
    await tx.query(
      `insert into invalidation(id, version_id, element_id, edge_id, delta_id, triggered_by, reason, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, m.version_id, m.element_id, m.edge_id ?? null, m.delta_id ?? null, m.triggered_by, m.reason, m.note ?? null]);
    await this.signalLayerOf(tx, signal, m.version_id);
    return id;
  }

  /**
   * Raises a mark and the question it asks, in one transaction, so a cascade run again after a
   * stop never finds the mark without its question (W1.8). The question goes to `ask`'s version
   * and element: by default the mark's own.
   */
  private async markAndAsk(m: MarkInput, question: string, ask: { version_id: string; element_id: string | null } = m): Promise<string> {
    return this.asSystem((tx, signal) => this.markAndAskIn(tx, signal, m, question, ask));
  }

  /** markAndAsk, inside a transaction of the caller's. */
  private async markAndAskIn(tx: Q, signal: Signal, m: MarkInput, question: string,
    ask: { version_id: string; element_id: string | null } = m): Promise<string> {
    const markId = await this.markIn(tx, signal, m);
    await tx.query(
      `insert into query(id, version_id, element_id, invalidation_id, question) values ($1,$2,$3,$4,$5)`,
      [ulid(), ask.version_id, ask.element_id, markId, question]);
    await this.signalLayerOf(tx, signal, ask.version_id);
    return markId;
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
      // The links this version removes (LNK6, D48) aren't carried forward, and their open marks
      // settle, with what those marks alone caused. A run again after a stop finds them settled.
      const removed = (await tx.query<{ id: string }>(
        `select e.id from edge e join version t on t.id = e.target_version_id
          where e.source_version_id = $1
            and exists (select 1 from link_removal r where r.version_id = $2 and ${REMOVES('r', 'e', 't')})`, [p.id, v.id])).rows.map((r) => r.id);
      if (removed.length) {
        const marks = await tx.query<{ id: string }>(`select id from invalidation where edge_id = any($1) and state = 'open'`, [removed]);
        for (const m of marks.rows) await this.closeMarkIn(tx, signal, m.id, `its link was removed by ${at}`);
      }
      // A mark never moves onto an element that no longer exists: removing the element settles
      // its marks, its links' marks among them, since its links go with it (copyEdges).
      const gone = await tx.query<{ id: string }>(
        `select id from invalidation where version_id = $1 and state = 'open' and delta_id is null
            and element_id is not null and not (element_id = any($2))`, [p.id, [...live]]);
      for (const m of gone.rows) await this.closeMarkIn(tx, signal, m.id, `its element was removed by ${at}`);
      await copyEdges(tx, p.id, v.id, live, new Set(removed));
      if (removed.length) {
        const sources = (await tx.query<{ source_element_id: string | null }>(
          `select source_element_id from edge where id = any($1)`, [removed])).rows.map((x) => x.source_element_id);
        // Moved onto v first, so the walk finds them where they now sit.
        await tx.query(`update invalidation set version_id = $2 where version_id = $1 and state = 'open' and delta_id is null`, [p.id, v.id]);
        await this.settleUnreached(tx, signal, v, sources, `its link was removed by ${at}`);
      }
      // A fork's access_lost mark settles once the node is no longer a fork (LNK8).
      if (!v.parent_held_by) {
        const unforked = await tx.query<{ id: string }>(
          `select id from invalidation where version_id = $1 and state = 'open' and reason = 'access_lost' and edge_id is null`, [p.id]);
        for (const m of unforked.rows) await this.closeMarkIn(tx, signal, m.id, `settled: ${at} is no longer a fork`);
      }
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
        await signal({ inbox: 'layer', kolab: v.kolab_id, layer: v.layer });
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

/**
 * Why a mark is open, in words: konjir_list_stale, the inbox and the web page all say it so.
 * `trigger` gives the address of what triggered it, the linked element (`linked`) or the parent
 * node (not), or undefined when the reader can't read it (a version in another kolab it no longer
 * holds Read on, access_lost). The trigger is named only to a reader who can read it (D53).
 */
export function markBecause(r: {
  reason: string; note: string | null; edge_id: string | null; trig_seq: number | null; cause_count: number;
}, trigger: (linked: boolean) => string | undefined): string {
  const lost = r.note ?? 'its holder can no longer read it';
  const linked = trigger(true);
  const parent = trigger(false)?.replace(/^kj:/, '');
  return r.reason === 'query_answered' ? r.note ?? 'your question was answered'
    : r.reason === 'ruled' ? r.note ?? 'a ruling changed its intent'
    : r.reason === 'access_lost' ? (r.edge_id
      ? (linked ? `${linked} is in another kolab: ${lost}` : `it links to a version in another kolab: ${lost}`)
      : (parent ? `parent ${parent} is in another kolab: ${lost}` : `its parent is a version in another kolab: ${lost}`))
    : r.note ? `review gate: ${r.note}`
    : r.edge_id ? `${linked ?? 'a version in another kolab'} changed in version ${r.trig_seq}`
    : r.reason === 'upstream_dirty' ? `${r.cause_count} upstream mark(s) are open`
    : parent ? `parent ${parent} version ${r.trig_seq}` : `its parent, a version in another kolab, changed`;
}

export const NEXT_STEP: Record<string, string> = {
  changed: 'Check whether this still holds against the new upstream text. If yes, konjir_clear_mark; if not, draft a new version that addresses it, or that removes the link (konjir_unlink) if the element no longer relies on it.',
  fuzzy_reanchor: 'The quoted span changed: its words were edited, or they now appear only without the prefix and suffix you quoted (a copy elsewhere). Re-read the target, then, in a draft of yours, konjir_link your element to the current words with their current context (that replaces this link, and the mark settles when the draft commits), or remove the link with konjir_unlink; or konjir_clear_mark if it still holds.',
  orphaned: 'The target no longer exists. In a draft of yours, konjir_link your element to the same target element\'s current words (that replaces this link), or remove the link: konjir_unlink link=<this mark\'s link>, or konjir_draft\'s unlink. The mark settles when that version commits. Removing your element settles it too.',
  upstream_dirty: 'Something this depends on is dirty. Wait for that mark to clear, or check it yourself and clear the upstream mark.',
  override_stale: 'The parent changed text you override. konjir_resolve_override with reaffirm, adopt_parent, or amend.',
  override_orphaned: 'The parent deleted text you override. konjir_resolve_override with reaffirm (keep as your own) or adopt_parent (drop it).',
  review_failed: 'The review gate rejected this version. Draft a version that resolves what the query names.',
  rebase_failed: 'Rebasing onto the new parent failed, for the reason the query gives. Commit a version that resolves it: on your current parent, and Kolab rebases it onto the new one; or with parent set to the parent\'s latest version. Or wait for the parent\'s next commit. The mark and its question settle once this variant sits on its parent\'s latest version.',
  role_boundary: 'The review gate thinks this crosses the layer boundary. A question went to the layer that owns the answer; the mark clears when it is answered. Meanwhile, work continues at risk.',
  query_answered: 'A question this element was waiting on has been answered. Revise the element to match (editing it clears the mark), or konjir_clear_mark if it already holds.',
  ruled: 'A ruling changed the intent of this element (D51). Amend it to say what the ruling says, and commit it: that version settles the mark and its question. It can\'t be cleared by hand.',
  access_lost: 'This relies on another kolab that the actor it rests on can no longer read, so its changes no longer reach you. Someone here who reads that kolab can konjir_clear_mark to hold it (it is then checked against that kolab\'s latest version); otherwise remove the dependency in a new draft. The mark settles by itself if the access comes back.',
};

/**
 * A version is live if no later committed version of its node exists. A
 * pending draft does not supersede it: the cascade must keep reaching the
 * committed version until the draft actually commits (then catch-up runs).
 */
/**
 * A variant (the node `node`, in SQL) is behind: its live version sits on a version of another node
 * that has committed a newer version since (D43, P6).
 */
function BEHIND(node: string) {
  return `exists (select 1 from version lv join version pv on pv.id = lv.parent_version_id
                   where lv.node_id = ${node} and lv.state = 'committed' and ${LIVE('lv')} and pv.node_id <> lv.node_id
                     and exists (select 1 from version nv where nv.node_id = pv.node_id and nv.state = 'committed' and nv.seq > pv.seq))`;
}

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
async function copyEdges(tx: Q, from: string, to: string, liveElements: Set<string>, removed = new Set<string>()) {
  const out = await tx.query<EdgeRow>(`select * from edge where source_version_id = $1`, [from]);
  for (const e of out.rows) {
    if (removed.has(e.id)) continue;
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
                          target_element_id, target_selector, target_fingerprint, held_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [nid, e.kind, to, e.source_element_id, e.target_version_id, e.target_element_id, selector, e.target_fingerprint, e.held_by]);
    }
    await tx.query(`update invalidation set edge_id = $2 where edge_id = $1 and state = 'open'`, [e.id, nid]);
  }
}

/**
 * Records, on draft `version`, the links it drops: each one the version it was built on has
 * (`carried`) gets a link_removal row, so its commit doesn't carry it forward; any the draft
 * declared itself go now. Written by the draft's writer, so row-level security checks an agent's.
 */
async function applyRemovals(tx: Q, version: string, ids: LinkIdentity[]) {
  for (const x of ids) {
    const params = [version, x.kind, x.source_element_id, x.target_node_id, x.target_element_id, x.target_selector ? JSON.stringify(x.target_selector) : null];
    await tx.query(
      `delete from edge e using version t
        where t.id = e.target_version_id and e.source_version_id = $1 and e.kind = $2
          and e.source_element_id is not distinct from $3 and t.node_id = $4
          and e.target_element_id is not distinct from $5 and e.target_selector is not distinct from $6::jsonb`, params);
    if (!x.carried) continue;
    await tx.query(
      `insert into link_removal(id, version_id, kind, source_element_id, target_node_id, target_element_id, target_selector)
       values ($7, $1, $2, $3, $4, $5, $6::jsonb) on conflict do nothing`, [...params, ulid()]);
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

/** A mark to raise. */
interface MarkInput {
  version_id: string; element_id: string | null; triggered_by: string; reason: string;
  edge_id?: string; delta_id?: string; note?: string;
}

/** An open session: its actor, role and kolab, and the actor's access there now. */
/** A new bearer token for a session: random, not a sortable ULID. An OAuth access token is one too (D55). */
const newSessionToken = () => `kjs_${randomBytes(24).toString('base64url')}`;

/**
 * Inserts an open session for `token`. A hand-issued session's id is its token's key (P1). A
 * grant's (D55) gets an id of its own, random and never a token's key, with its access token's key
 * and expiry beside it, so the token can rotate while the session, and its id, stay.
 */
async function insertSession(tx: Q, token: string, s: { actor: string; role: Role; kolab: string; grant?: string | null; ttlS?: number }) {
  if (!s.grant) {
    await tx.query(`insert into session(id, actor_id, active_role, kolab_id) values ($1, $2, $3, $4)`, [sessionKey(token), s.actor, s.role, s.kolab]);
    return sessionKey(token);
  }
  const id = randomBytes(32).toString('base64url');
  await tx.query(
    `insert into session(id, actor_id, active_role, kolab_id, grant_id, token_key, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 second')`, [id, s.actor, s.role, s.kolab, s.grant, sessionKey(token), s.ttlS ?? 900]);
  return id;
}

interface Session {
  /** The session's id: its key, which whoami and events name it by. */
  id: string;
  actor_id: string; active_role: Role; kolab: string; kind: ActorKind; owner: string | null; access: Access;
}

/** Whose access a change of access can alter: actors (people or agents), or the members of a team and of the teams under it. */
type Affected = { users?: string[]; team?: string };

/** Who a grant names, as Affected. */
const granted = (g: { column: 'user_id' | 'team_id' | 'agent_id'; id: string }): Affected =>
  g.column === 'team_id' ? { team: g.id } : { users: [g.id] };

/**
 * The actors a change of access can affect (LNK8 holders): those named, a team's members and
 * those of every team under it, and every agent any of them owns, whose access is cut down to
 * its owner's (D30). Organizations' own agents hold only their organization's kolabs, which no
 * membership changes.
 */
async function holdersOf(q: Q, who: Affected): Promise<string[]> {
  const r = await q.query<{ id: string }>(
    `with recursive sub(id) as (
       select id from team where id = $2
       union select t.id from team t join sub on t.parent_id = sub.id
     ), named(id) as (
       select unnest($1::text[])
       union select tm.user_id from team_member tm where tm.team_id in (select id from sub)
     )
     select id from named union select a.id from actor a where a.owner_id in (select id from named)`,
    [who.users ?? [], who.team ?? null]);
  return r.rows.map((x) => x.id);
}

/**
 * The holders of links and forks across kolabs that archiving or unarchiving `kind` `name`
 * affects (D52, LNK8): an actor and the agents it owns; an organization's members, its own agents
 * and theirs; and anyone holding a link or fork whose own kolab, or other kolab, is one of `kolabs`.
 */
async function archiveHoldersOf(q: Q, kind: Archivable, name: string, kolabs: string[]): Promise<string[]> {
  const users = kind === 'actor' ? [name]
    : kind === 'organization' ? (await q.query<{ id: string }>(
      `select user_id as id from org_member where org_id = $1 union select id from actor where owner_id = $1`, [name])).rows.map((r) => r.id)
    : [];
  const byKolab = kolabs.length ? (await q.query<{ id: string }>(
    `select held_by as id from edge where target_kolab_id <> kolab_id and (kolab_id = any($1) or target_kolab_id = any($1))
     union select v.parent_held_by from version v join version p on p.id = v.parent_version_id
      where v.parent_held_by is not null and (v.kolab_id = any($1) or p.kolab_id = any($1))`, [kolabs])).rows.map((r) => r.id) : [];
  return [...new Set([...(await holdersOf(q, { users })), ...byKolab])];
}

/**
 * Everyone who may hold access to `kolab`, with what they hold now (kj_access): its owner, the
 * owning organization's members (its owners, and everyone under a base permission or an internal
 * kolab), people and agents with a direct grant, and the members of every team granted access and
 * of the teams under it. Those with a direct grant are kept even when it gives nothing now.
 */
async function holderRows(q: Q, kolab: string) {
  return (await q.query<{ id: string; kind: ActorKind; owner_id: string | null; rank: number; functional: boolean; technical: boolean; granted: boolean }>(
    `with recursive k as (
       select id, owner_id, visibility, base_permission from kolab where id = $1
     ), sub(id) as (
       select t.id from kolab_grant g join team t on t.id = g.team_id join k on t.org_id = k.owner_id where g.kolab_id = $1
       union select t.id from team t join sub on t.parent_id = sub.id
     ), cand(id) as (
       select owner_id from k
       union select m.user_id from org_member m join k on m.org_id = k.owner_id
              where m.role = 'owner' or k.base_permission is not null or k.visibility = 'internal'
       union select coalesce(g.user_id, g.agent_id) from kolab_grant g where g.kolab_id = $1 and g.team_id is null
       union select tm.user_id from team_member tm where tm.team_id in (select id from sub)
     )
     select a.id, a.kind, a.owner_id, x.rank, x.functional, x.technical,
            exists (select 1 from kolab_grant g where g.kolab_id = $1 and (g.user_id = a.id or g.agent_id = a.id)) as granted
       from cand c join actor a on a.id = c.id cross join lateral kj_access(a.id, $1) x
      order by a.id`, [kolab])).rows.filter((h) => h.rank > 0 || h.granted);
}

/** Whether `actor` owns `kolab`: is its owner, or an owner of the organization that owns it. */
async function ownsKolab(q: Q, actor: string, kolab: string): Promise<boolean> {
  return (await q.query(
    `select 1 from kolab k left join org_member m on m.org_id = k.owner_id and m.user_id = $1
      where k.id = $2 and (k.owner_id = $1 or m.role = 'owner')`, [actor, kolab])).rows.length > 0;
}

/** Refuses an agent a grant above what its owner lends it in `kolab` now, in `q`'s transaction (D30, D56). */
async function requireWithinCap(q: Q, agent: { id: string; owner?: string }, kolab: string, want: { level: AccessLevel; layers: Layer[] }) {
  const owner = await ownerAccess(q, agent.owner!, kolab);
  if (rankOf(want.level) > rankOf(owner.level) || want.layers.some((l) => !owner.layers.includes(l))) {
    throw new AccessError(`${agent.id}'s owner ${agent.owner} holds ${describeAccess(owner)} in kolab ${kolab}, so ${agent.id} can't be granted ${describeAccess(want)}: an agent never holds more access than its owner`);
  }
}

/** Ends, in `tx`, every open session that can no longer reach its kolab. Returns how many. */
async function endUnreachableIn(tx: Q, signal: Signal): Promise<number> {
  const r = await tx.query<{ id: string }>(
    `update session s set ended_at = now()
      where s.ended_at is null and (select a.rank from kj_access(s.actor_id, s.kolab_id) a) = 0
     returning s.id`);
  for (const { id } of r.rows) await signal({ session: 'ended', id });   // the id is the sessionKey
  return r.rows.length;
}

/** The one refusal for an invite that can't be used, whatever the reason, so its holder learns nothing more (W3.4). */
const INVITE_GONE = 'this invite is unknown, already used, revoked or expired, or whoever made it can no longer invite; ask for a new one';

/** The layers a grant or invite at `level` covers (TEN8): Write names one or both (both by default), Maintain and Admin both, Read and Triage none. */
function layersOf(level: AccessLevel, given?: Layer[]): Layer[] {
  if (level === 'write') {
    const layers = [...new Set(given ?? LAYERS)];
    if (!layers.length || layers.some((l) => !LAYERS.includes(l))) throw new TenancyError(`a Write grant names the layers it covers: ${LAYERS.join(', ')}, or both`);
    return layers;
  }
  const layers: Layer[] = level === 'read' || level === 'triage' ? [] : [...LAYERS];
  if (given && (given.length !== layers.length || given.some((l) => !layers.includes(l)))) {
    throw new TenancyError(`only a Write grant names its layers: ${level} covers ${layers.length ? 'both' : 'none'}`);
  }
  return layers;
}

const rankOf = (level: AccessLevel | null) => (level ? ACCESS_LEVELS.indexOf(level) + 1 : 0);

/** One grant that gives what both do: the higher level, and at Write, the layers of either. */
function mergeAccess(a: Access, b: Access): { level: AccessLevel; layers: Layer[] } {
  const level = (rankOf(a.level) >= rankOf(b.level) ? a.level : b.level)!;
  if (level !== 'write') return { level, layers: layersOf(level) };
  const layers = LAYERS.filter((l) => (a.level === 'write' && a.layers.includes(l)) || (b.level === 'write' && b.layers.includes(l)));
  return { level, layers };
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
 * The most an agent of `owner` may hold in a kolab, as kj_access caps it (kj_agent_cap, 0018): a
 * user's own access there, without what public visibility alone gives (D56); an organization holds
 * all of its own kolabs and nothing of anyone else's.
 */
async function ownerAccess(q: Q, owner: string, kolab: string): Promise<Access> {
  return toAccess((await q.query<{ rank: number; functional: boolean; technical: boolean }>(
    `select rank, functional, technical from kj_agent_cap($1, $2)`, [owner, kolab])).rows[0]);
}

/**
 * SQL that is true when the kolab `col` names is archived, by itself or with the organization that
 * owns it: kj_kolab_archived inlined, as Kolab's own login reads it, so a poll over many outbox
 * rows makes no function call per row.
 */
function archivedKolabSql(col: string): string {
  return `exists (select 1 from kolab ak join account ao on ao.id = ak.owner_id where ak.id = ${col}
                   and (ak.archived_at is not null or (ao.kind = 'organization' and ao.archived_at is not null)))`;
}

/** "Write on the functional layer", "Read", "no access". */
/** A word with its indefinite article, by its first letter: "a product", "an engineer". */
function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

function describeAccess(a: Access): string {
  if (!a.level) return 'no access';
  const level = a.level[0].toUpperCase() + a.level.slice(1);
  if (a.level !== 'write') return level;
  return a.layers.length === 2 ? `${level} on both layers` : a.layers.length ? `${level} on the ${a.layers[0]} layer` : `${level} on no layer`;
}

/** How many positions a case file holds: two, one per side (CASE1). */
const CASE_POSITIONS = 2;

/** The other side. */
const opposite = (e: RulingEffect): RulingEffect => (e === 'keep_intent' ? 'change_intent' : 'keep_intent');

/** Who an actor answers for: a person themselves, an agent its owner. One person and their agents are one side of a case file. */
const principalOf = (id: string, a: { kind: ActorKind | null; owner: string | null }) => (a.kind === 'agent' && a.owner ? a.owner : id);

/** Refuses a session that holds only Read in its kolab: it doesn't belong to the kolab's work (D49). */
function belonging(s: { actor_id: string; kolab: string; access: Access }, what: string) {
  if (!s.access.layers.length) {
    throw new AccessError(`${s.actor_id} holds ${describeAccess(s.access)} in kolab ${s.kolab}; only those with Write on a layer of a kolab ${what} there (D49)`);
  }
}

/** A case file's positions, in the order they were taken, each with the person its actor answers for. */
async function partiesIn(tx: Q, caseId: string) {
  return (await tx.query<{ id: string; actor: string; seeks: RulingEffect | null; kind: ActorKind | null; owner: string | null }>(
    `select p.id, p.actor_id as actor, p.seeks, a.kind, a.owner_id as owner
       from position p left join actor a on a.id = p.actor_id
      where p.case_file_id = $1 order by p.created_at nulls first, p.id`, [caseId])).rows
    .map((p) => ({ ...p, principal: principalOf(p.actor, p) }));
}
/** The most pieces of evidence one position cites. */
const MAX_EVIDENCE = 20;

/** Text someone must give, trimmed; refused when empty. */
function requireText(text: unknown, what: string): string {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) throw new GateError(`give ${what}`);
  return t;
}

/** A timestamp as ISO 8601, or null for a row written before it was recorded. */
const iso = (t: Date | string | null) => (t === null ? null : new Date(t).toISOString());

/** A position's evidence, as stored: a list of strings (rows written by hand before 0013 may hold anything). */
const evidenceOf = (e: unknown): string[] => (Array.isArray(e) ? e.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [JSON.stringify(e)]);

/** Whether a commit step refused the version, because its author can no longer write its layer. */
const isRefused = (x: unknown): x is { refused: string } => typeof x === 'object' && x !== null && 'refused' in x;

/** A commit step that committed its version, with the rebase jobs it wrote for the version's variants (D43, P6). */
type Committed = { committed: true; rebases: number };
const isCommitted = (x: unknown): x is Committed => typeof x === 'object' && x !== null && 'committed' in x;

/** Outbox ids: ULIDs that keep increasing within this process, so jobs written in one millisecond still run in the order written. */
const outboxId = monotonicFactory();

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

async function writeVersion(tx: Q, v: Omit<VersionRow, 'state' | 'kolab_id'>, els: ElementRow[],
  deltas: Omit<DeltaRow, 'id' | 'version_id'>[]) {
  await tx.query(
    `insert into version(id, node_id, seq, parent_version_id, base_version_id, layer, state, actor_id, active_role, parent_held_by)
     values ($1,$2,$3,$4,$5,$6,'drafted',$7,$8,$9)`,
    [v.id, v.node_id, v.seq, v.parent_version_id, v.base_version_id, v.layer, v.actor_id, v.active_role, v.parent_held_by ?? null]);
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
