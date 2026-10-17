/**
 * Types and constants shared by Kolab's engine, server, CLI and web interface.
 */

// Each value list is a constant, and its type derives from it, so the server's
// input schemas and the database constraints use the same list.

export const ROLES = ['product', 'engineer'] as const;
export type Role = typeof ROLES[number];
/** A person, or an agent owned by an account: a user or an organization (D30). */
export const ACTOR_KINDS = ['person', 'agent'] as const;
export type ActorKind = typeof ACTOR_KINDS[number];
/** `owner` is the account that owns an agent: a user (a person, by the same id) or an organization. */
export interface Actor { id: string; name: string; kind: ActorKind; owner: string | null }
/** An account owns kolabs and agents (TEN2). A person is a user, by the same id. */
export const ACCOUNT_KINDS = ['user', 'organization'] as const;
export type AccountKind = typeof ACCOUNT_KINDS[number];
/** A member of an organization, or one of its owners, who administer all of its kolabs (TEN10). */
export const ORG_ROLES = ['member', 'owner'] as const;
export type OrgRole = typeof ORG_ROLES[number];
/** The levels of access to a kolab, lowest first (TEN7). A Write grant names its layers (TEN8). */
export const ACCESS_LEVELS = ['read', 'triage', 'write', 'maintain', 'admin'] as const;
export type AccessLevel = typeof ACCESS_LEVELS[number];
/** Who can read a kolab without a grant: everyone, nobody, or the owning organization's members (TEN6). */
export const VISIBILITIES = ['public', 'private', 'internal'] as const;
export type Visibility = typeof VISIBILITIES[number];
/**
 * An actor's access to a kolab: its level (null for none) and the layers it may write. An
 * agent's is its own grant, cut down to its owner's (D30).
 */
export interface Access { level: AccessLevel | null; layers: Layer[] }
export interface KolabRow { id: string; owner: string; title: string; visibility: Visibility; base_permission: AccessLevel | null }
/**
 * Who wrote a version: the actor, the account that owns it when it's an agent, and the role it
 * was acting in. Kolab's own rebases are written by the actor `kolab`, of kind `system`.
 */
export interface Author { actor: string; kind: ActorKind | 'system'; owner: string | null; role: string }
export const LAYERS = ['functional', 'technical'] as const;
export type Layer = typeof LAYERS[number];
export const KINDS = ['functional_spec', 'prototype', 'technical_binding', 'wbs', 'work_package', 'implementation'] as const;
export type Kind = typeof KINDS[number];
/** A binding's plan and its work packages: a version of one commits after structural checks, without review (VER3, PLN2, D26). */
export const PLAN_KINDS: readonly Kind[] = ['wbs', 'work_package'];
export const DELTA_KINDS = ['add', 'override', 'remove'] as const;
export type DeltaKind = typeof DELTA_KINDS[number];
export const EDGE_KINDS = ['dependency', 'derivation', 'equivalence'] as const;
export type EdgeKind = typeof EDGE_KINDS[number];
export const QUERY_KINDS = ['question', 'note'] as const;
export type QueryKind = typeof QUERY_KINDS[number];
export const QUERY_STATES = ['open', 'answered'] as const;
export type QueryState = typeof QUERY_STATES[number];
/**
 * A version moves from drafted, to in review, to committed (VER2). A request for changes, or a
 * failed check at submission, returns it to drafted. It is rejected only when its author abandons
 * it (D33), when someone else's commit overtakes it (stale, CAS7, D38), or when Kolab folds it into
 * a fresh rebase. Kolab's own rebases are rejected when they fail their checks.
 */
export const VERSION_STATES = ['drafted', 'in_review', 'committed', 'rejected'] as const;
export type VersionState = typeof VERSION_STATES[number];
/** What a reviewer records with konjir_review (REV2). */
export const REVIEW_VERDICTS = ['approve', 'request_changes'] as const;
export type ReviewVerdictKind = typeof REVIEW_VERDICTS[number];
/**
 * A review request, one per reviewer of a version in review: open in the reviewer's inbox until
 * they approve or request changes, or it is withdrawn because the version left review otherwise.
 */
export const REVIEW_REQUEST_STATES = ['open', 'approved', 'changes_requested', 'withdrawn'] as const;
export type ReviewRequestState = typeof REVIEW_REQUEST_STATES[number];
/**
 * The work a transactional outbox job owes (REV3, W1.8): a committed version's cascade, and a
 * version overtaken while it waited, to fold or reject. Durable asynchronous rebasing (D43) adds
 * its kinds here.
 */
export const OUTBOX_KINDS = ['after_commit', 'settle'] as const;
export type OutboxKind = typeof OUTBOX_KINDS[number];
/** An outbox job is pending until done, or dead after too many failed attempts, until an admin retries it. */
export const OUTBOX_STATES = ['pending', 'dead'] as const;
export type OutboxState = typeof OUTBOX_STATES[number];
/** The two kinds of finding a reviewer reports (VER8). */
export const FINDING_KINDS = ['contradiction', 'layer_leak'] as const;
export type FindingKind = typeof FINDING_KINDS[number];
export const OVERRIDE_RESOLUTIONS = ['reaffirm', 'adopt_parent', 'amend'] as const;
export type OverrideResolution = typeof OVERRIDE_RESOLUTIONS[number];
/** Why a mark (an invalidation) was raised. */
export const MARK_REASONS = [
  'changed', 'fuzzy_reanchor', 'orphaned', 'override_stale', 'override_orphaned',
  'upstream_dirty', 'review_failed', 'rebase_failed', 'role_boundary', 'query_answered',
] as const;
export type MarkReason = typeof MARK_REASONS[number];

export const LAYER_OF_KIND: Record<Kind, Layer> = {
  functional_spec: 'functional',
  prototype: 'functional',
  technical_binding: 'technical',
  wbs: 'technical',
  work_package: 'technical',
  implementation: 'technical',
};
export const LAYER_OF_ROLE: Record<Role, Layer> = { product: 'functional', engineer: 'technical' };

export interface ElementInput { id?: string; text: string; parent?: string }
export interface DeltaInput { kind: DeltaKind; element: string; text?: string; parent?: string }

export interface ElementRow {
  element_id: string;
  parent_element_id: string | null;
  ord: number;
  text: string;
  fingerprint: string;
}
export interface VersionRow {
  id: string; node_id: string; seq: number; parent_version_id: string | null;
  /** The node's live version when this one was drafted: what it was built on. Null for a node's first. */
  base_version_id: string | null;
  layer: Layer; state: VersionState; actor_id: string; active_role: string;
  /** The kolab the version's node is in. */
  kolab_id?: string;
  /** For a fold: the person's version Kolab rebased it from (CAS7). */
  folded_from?: string | null;
}

export interface MarkRow {
  id: string; version_id: string; element_id: string | null; edge_id: string | null;
  delta_id: string | null; triggered_by: string; note: string | null;
  reason: string; state: 'open' | 'cleared'; cleared_by: string | null;
}

/**
 * What a reviewer can report. A contradiction rejects the version. A layer
 * leak (implementation in a functional spec, or a binding that changes
 * behavior) does not: per decision 3 it commits and becomes a question to the
 * layer that owns the answer.
 */
export interface Finding {
  kind: FindingKind;
  elements: string[];
  explanation: string;
}
export type ReviewVerdict = { ok: boolean; note?: string; findings?: Finding[] };
/**
 * `stale` is set when the version was overtaken before it could commit: the node's live version
 * was no longer its base. A draft is then rejected, to be redrafted; a rebase of Kolab's own is
 * superseded by the version that overtook it.
 *
 * `in_review` is set when the version passed Kolab's checks and now waits in review: `reviewers`
 * each have a review request for it, and one approval commits it (D19, D25). `unreviewed` is set
 * when it committed on structural checks alone, because no one else holds Write on its layer.
 */
export type GateResult = ReviewVerdict & {
  version: string; stale?: boolean;
  in_review?: boolean; reviewers?: string[]; unreviewed?: boolean;
  /**
   * The version committed, but its cascade waits in the outbox behind an earlier cascade of its
   * node that is still running elsewhere, backing off or dead (W1.8): it runs once that one is done.
   */
  cascade?: 'queued';
};

/** A review request as a reviewer's inbox shows it. Its subject is a version; work packages come later (VER17). */
export interface ReviewRequestView {
  request: string; subject: string; subject_kind: 'version'; author: string; reviewer: string;
  requested_at: string; next: string;
}
/** A version an author submitted, with the review it has had, as the author's answers show it. */
export interface SubmissionView {
  subject: string; state: VersionState; note: string | null;
  /** For a version Kolab folded into a fresh rebase: the fold that carries its edit. */
  folded_into?: string;
  verdicts: { reviewer: string; state: ReviewRequestState; note: string | null; findings: Finding[] }[];
  next: string;
}
/** What Kolab's checks see of a version: its elements, and its node. */
export interface CheckContext {
  version: VersionRow;
  elements: ElementRow[];
  /** `name` is how addresses name the node, in `kolab_id`; `id` is Kolab's own key for it. */
  node: { id: string; name: string; kind: Kind; layer: Layer; title: string; kolab_id: string };
}
/** What Kolab's checks conclude: pass, or fail with the reason. They report no findings; reviewers do (REV5). */
export type CheckResult = { ok: boolean; note?: string };
/**
 * Kolab's own checks on a version (VER5, REV1): structural only (structuralChecks), and no model
 * call (REV5, VER7). Tests substitute their own to veto a version or to act at an exact point.
 */
export type Checks = (ctx: CheckContext) => CheckResult | Promise<CheckResult>;

export type Resolution =
  | { status: 'ok'; content: string; fingerprint: string }
  | { status: 'fuzzy'; content: string; fingerprint: string }
  | { status: 'orphan' };

/**
 * Something an agent should look at: a layer's work queue (open questions,
 * notes and marks it owns) or an actor's answers (replies to what they raised).
 */
export type InboxEvent = { inbox: 'layer'; layer: Layer } | { inbox: 'actor'; actor: string };

/**
 * A session ended, so its token is revoked: every listen stream it holds closes (D41).
 * `id` is the session's key: the sha256 of its id, base64url (the engine's sessionKey).
 * Never the id itself, which is the bearer token.
 */
export type SessionEndedEvent = { session: 'ended'; id: string };

/** What Kolab tells its listeners. Plain JSON, so it can be carried between processes as it is. */
export type KolabEvent = InboxEvent | SessionEndedEvent;

export const isInboxEvent = (e: KolabEvent): e is InboxEvent => 'inbox' in e;
export const isSessionEnded = (e: KolabEvent): e is SessionEndedEvent => 'session' in e && e.session === 'ended';

export interface Query {
  id: string; kind: QueryKind; address: string; question: string; state: string;
  answer: string | null; answered_by: string | null; raised_by: string | null;
  from: string | null; mark: string | null;
}
