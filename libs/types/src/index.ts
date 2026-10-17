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
export const DELTA_KINDS = ['add', 'override', 'remove'] as const;
export type DeltaKind = typeof DELTA_KINDS[number];
export const EDGE_KINDS = ['dependency', 'derivation', 'equivalence'] as const;
export type EdgeKind = typeof EDGE_KINDS[number];
export const QUERY_KINDS = ['question', 'note'] as const;
export type QueryKind = typeof QUERY_KINDS[number];
export const QUERY_STATES = ['open', 'answered'] as const;
export type QueryState = typeof QUERY_STATES[number];
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
  layer: Layer; state: 'drafted' | 'committed' | 'rejected'; actor_id: string; active_role: string;
  /** The kolab the version's node is in. */
  kolab_id?: string;
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
  kind: 'contradiction' | 'layer_leak';
  elements: string[];
  explanation: string;
}
export type ReviewVerdict = { ok: boolean; note?: string; findings?: Finding[] };
/**
 * `stale` is set when the version was overtaken before it could commit: the node's live version
 * was no longer its base. A draft is then rejected, to be redrafted; a rebase of Kolab's own is
 * superseded by the version that overtook it.
 */
export type GateResult = ReviewVerdict & { version: string; retryable?: boolean; stale?: boolean };
export interface ReviewContext {
  version: VersionRow;
  elements: ElementRow[];
  node: { id: string; kind: Kind; layer: Layer; title: string };
  /** For each link out of this version: which element relies on what, and that target's text. */
  upstream: { element: string | null; target: string; text: string | null }[];
}
export type Reviewer = (ctx: ReviewContext) => ReviewVerdict | Promise<ReviewVerdict>;

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
