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
export interface Actor { id: string; name: string; kind: ActorKind; owner: string | null; archived?: boolean }
/** An account owns kolabs and agents (TEN2). A person is a user, by the same id. */
export const ACCOUNT_KINDS = ['user', 'organization'] as const;
export type AccountKind = typeof ACCOUNT_KINDS[number];
/** A member of an organization, or one of its owners, who administer all of its kolabs (TEN10). */
export const ORG_ROLES = ['member', 'owner'] as const;
export type OrgRole = typeof ORG_ROLES[number];
/** The levels of access to a kolab, lowest first (TEN7). A Write grant names its layers (TEN8). */
export const ACCESS_LEVELS = ['read', 'triage', 'write', 'maintain', 'admin'] as const;
export type AccessLevel = typeof ACCESS_LEVELS[number];
/** The levels an invite may grant (W3.4): every level but Admin, which a kolab's owners give. */
export const INVITE_LEVELS = ['read', 'triage', 'write', 'maintain'] as const;
export type InviteLevel = typeof INVITE_LEVELS[number];
/** Who can read a kolab without a grant: everyone, nobody, or the owning organization's members (TEN6). */
export const VISIBILITIES = ['public', 'private', 'internal'] as const;
export type Visibility = typeof VISIBILITIES[number];
/**
 * An actor's access to a kolab: its level (null for none) and the layers it may write. An
 * agent's is its own grant, cut down to its owner's (D30).
 */
export interface Access { level: AccessLevel | null; layers: Layer[] }
/**
 * An invite to a kolab (W3.4), as its admins see it: the access it grants, who made it, and what
 * became of it. Its link is shown once, when it is made, and never again.
 */
export interface InviteView {
  id: string; kolab: string; level: InviteLevel; layers: Layer[];
  invited_by: string; created_at: string; expires_at: string;
  state: 'open' | 'accepted' | 'revoked' | 'expired';
  accepted_by: string | null; accepted_at: string | null;
}
/** What an invite's link shows whoever holds it, before they accept: the kolab, the access, and who invites them. */
export interface InvitePreview {
  kolab: string; title: string; owner: string; level: InviteLevel; layers: Layer[];
  invited_by: string; expires_at: string;
}
/**
 * Where some of an actor's access to a kolab comes from (W3.6): owning it, being an owner of the
 * organization that owns it, that organization's base permission, an internal kolab's members'
 * Read, a direct grant (to a person, an outside collaborator among them, or an agent), or a
 * team's grant. Only a direct grant is changed in the kolab's People page; the rest are kept
 * where the organization, its teams and its members are.
 */
export const ACCESS_SOURCES = ['owner', 'org_owner', 'base', 'internal', 'grant', 'team'] as const;
export type AccessSourceKind = typeof ACCESS_SOURCES[number];
export interface AccessSource {
  kind: AccessSourceKind; level: AccessLevel; layers: Layer[];
  /** The team whose grant it is, for `team`; the organization, for `org_owner`, `base` and `internal`. */
  team?: string; org?: string;
}
/**
 * Someone who holds access to a kolab, or holds a grant there that gives nothing now (W3.6), as
 * the kolab's Admins see them: what they hold (kj_access), and where it comes from. An agent's
 * access is its own grant cut down to what its owner lends it (`cap`, D30, D56); `capped` says the
 * cut takes something away.
 */
export interface AccessHolder {
  /** `owner` is an agent's owner, or null for a person, and for an agent whose owner holds nothing here. */
  actor: string; kind: ActorKind; owner: string | null;
  access: Access; sources: AccessSource[];
  /** Their direct grant, the one access the People page changes or removes; null without one. */
  grant: Access | null;
  /** A person granted access to an organization's kolab who isn't a member of it (TEN10). */
  outside: boolean;
  /** An agent's: what its owner lends it there, at most (kj_agent_cap). */
  cap?: Access; capped?: boolean;
}
/** A team's grant on a kolab (TEN9), with how many people it reaches, its sub-teams' members included. */
export interface AccessTeamGrant { team: string; level: AccessLevel; layers: Layer[]; members: number }
/** Who holds access to a kolab (W3.6): its people and agents, and its teams' grants. */
export interface KolabAccessView {
  kolab: { id: string; owner: string; owner_kind: AccountKind; visibility: Visibility; base_permission: AccessLevel | null };
  holders: AccessHolder[]; teams: AccessTeamGrant[];
  /** Read a page at a time (W2.21): the cursor to the next page of holders, or null on the last. Teams come whole, on every page. */
  next?: string | null;
}
/** `archived` is given only by a listing that includes archived kolabs (D52). */
export interface KolabRow { id: string; owner: string; title: string; visibility: Visibility; base_permission: AccessLevel | null; archived?: boolean }
/**
 * What an admin can archive (D52): a kolab, an organization or an actor (a person or an agent).
 * An archived one is hidden from listings and can't be used; its data is kept and its name stays
 * reserved. Archiving an account archives its kolabs and its agents with it.
 */
export const ARCHIVABLE = ['kolab', 'organization', 'actor'] as const;
export type Archivable = typeof ARCHIVABLE[number];
export type ArchiveTarget = { [K in Archivable]: { [P in K]: string } }[Archivable];
/**
 * Who made a write (W2.20, D70), as Kolab records it: an actor's id; `kolab`, for Kolab's own
 * work; or ADMIN_DOER, for the break-glass admin token. Admins are people who sign in (W2.22,
 * D69): an admin verb run from an admin's own sign-in records that person's id, and ADMIN_DOER
 * stays only on what the break-glass token does.
 */
export type Doer = string;
/** The break-glass admin token, as a write records it (W2.20, W2.22). No actor may take the name (migration 0024). */
export const ADMIN_DOER = 'admin';
/**
 * The changes Kolab records in its audit log because they leave no row of their own (W2.20): a
 * grant made, replaced or removed, a person added to or removed from an organization or a team,
 * and an outbox job retried; and, since admins are people (W2.22, D69), a person made or no longer
 * a Konjir admin, an admin raising their session to run admin verbs and lowering it, and each admin
 * verb the break-glass token runs.
 */
export const AUDIT_ACTIONS = [
  'grant.set', 'grant.removed', 'member.set', 'member.removed', 'team_member.added', 'team_member.removed', 'outbox.retried',
  'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
] as const;
/**
 * How long an admin's session may run admin verbs once they raise it (konjir_admin_elevate, W2.22),
 * in seconds: 15 minutes, which raising it again renews.
 */
export const ADMIN_ELEVATION_S = 15 * 60;
export type AuditAction = typeof AUDIT_ACTIONS[number];
/** One row of the audit log: what was done, in which kolab if any, to whom, by whom and when. */
export interface AuditEvent { id: number; action: AuditAction; kolab: string | null; subject: string; detail: Record<string, unknown> | null; by: Doer; at: string }
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
/**
 * A question waits (open) until the layer that owns it answers it. One asked of a version in review
 * is withdrawn when that version is abandoned or returned to its author and the element it asked
 * about isn't in its node's latest committed version (D65); its answer then says why.
 */
export const QUERY_STATES = ['open', 'answered', 'withdrawn'] as const;
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
 * The work a transactional outbox job owes (REV3, W1.8): a committed version's cascade, a version
 * overtaken while it waited, to fold or reject, and a variant to rebase onto its parent's latest
 * version (D43, P6), or a dependent in another kolab up to date with it: its links there
 * checked, a fork rebased once its holder holds it again (LNK8, KON9).
 */
export const OUTBOX_KINDS = ['after_commit', 'settle', 'rebase'] as const;
export type OutboxKind = typeof OUTBOX_KINDS[number];
/** An outbox job is pending until done, or dead after too many failed attempts, until an admin retries it. */
export const OUTBOX_STATES = ['pending', 'dead'] as const;
export type OutboxState = typeof OUTBOX_STATES[number];
/** The two kinds of finding a reviewer reports (VER8). */
export const FINDING_KINDS = ['contradiction', 'layer_leak'] as const;
export type FindingKind = typeof FINDING_KINDS[number];
/** A case file is open until a person rules on it (CASE2), or a direct ruling on its element supersedes it (CASE3). */
export const CASE_FILE_STATES = ['open', 'ruled', 'superseded'] as const;
export type CaseFileState = typeof CASE_FILE_STATES[number];
/** What a ruling on a case file says of each position (CASE2). */
export const POSITION_VERDICTS = ['sustained', 'overruled'] as const;
export type PositionVerdict = typeof POSITION_VERDICTS[number];
/**
 * A ruling changes the intent, or keeps it and asks for another way (CASE6). A position seeks one
 * of the two: the two positions of a case file take opposite sides.
 */
export const RULING_EFFECTS = ['change_intent', 'keep_intent'] as const;
export type RulingEffect = typeof RULING_EFFECTS[number];
export const OVERRIDE_RESOLUTIONS = ['reaffirm', 'adopt_parent', 'amend'] as const;
export type OverrideResolution = typeof OVERRIDE_RESOLUTIONS[number];
/** Why a mark (an invalidation) was raised. */
export const MARK_REASONS = [
  'changed', 'fuzzy_reanchor', 'orphaned', 'override_stale', 'override_orphaned',
  'upstream_dirty', 'review_failed', 'rebase_failed', 'role_boundary', 'query_answered', 'ruled', 'access_lost',
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
/** The role that writes a layer. */
export const ROLE_OF_LAYER: Record<Layer, Role> = { functional: 'product', technical: 'engineer' };

/**
 * What a submitter is told when a version waits in review and nobody else can review it yet (D65).
 * Another agent of the author's own person may review (VER16, D25: separation of duty is per
 * actor), so connecting one with the role that writes the layer is a way to get a reviewer.
 * Everyone else who holds Write on its layer is an agent signed in with the other role. The
 * version waits; it doesn't commit unreviewed (D66: VER11 counts who holds Write, not who is signed in).
 */
export const nobodyCanReview = (layer: Layer) =>
  `Nobody else can review the ${layer} layer yet. Invite a ${ROLE_OF_LAYER[layer]} teammate, or connect an agent of yours with the ${ROLE_OF_LAYER[layer]} role. It waits in review until one of them approves it.`;

export interface ElementInput { id?: string; text: string; parent?: string }
export interface DeltaInput { kind: DeltaKind; element: string; text?: string; parent?: string }
/**
 * A link a draft drops, so its next version doesn't carry it forward (CAS3, LNK6, D48): by its id,
 * as konjir_lineage and konjir_list_stale give it, or by what it links: the source element (none
 * for a link from the whole version) and the target's address, whose version is ignored. Without
 * `kind`, links of every kind between the two go.
 */
export type LinkRef = { link: string } | { sourceElement?: string; target: string; kind?: EdgeKind };

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
  kolab_id: string;
  /** For a fold: the person's version Kolab rebased it from (CAS7). */
  folded_from?: string | null;
  /**
   * For a fork, whose parent is in another kolab (KON9): the actor whose Read on that kolab it
   * rests on (LNK8). Null for every other version.
   */
  parent_held_by?: string | null;
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
  /**
   * How many of its variants' rebases the commit queued (D43, P6): the commit returns once the
   * version is committed, and Kolab's outbox worker rebases them, level by level. Absent if none.
   */
  rebases?: number;
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
 * Something an agent should look at, in one kolab: a layer's work queue there (open questions,
 * notes and marks it owns) or an actor's answers there (replies to what they raised). Each names
 * its kolab, so only that kolab's subscribers are told (D50, TEN12).
 */
export type InboxEvent = { inbox: 'layer'; kolab: string; layer: Layer } | { inbox: 'actor'; kolab: string; actor: string };

/**
 * A session ended, so its token is revoked: every listen stream it holds closes (D41).
 * `id` is the session's key: the sha256 of its bearer token, base64url (the engine's
 * sessionKey), which is also its id in the database (P1, 0011). Never the token itself.
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
  /**
   * The version it was asked of, when the question has moved since: it was asked of a version in
   * review that was then abandoned or returned to its author (D65). Only in the question's own kolab.
   */
  asked_of?: string;
  /** It moved, and its element's text in the version it is on now differs from the version it was asked of. */
  element_changed?: true;
}

/** One side of a case file: a claim and its evidence (CASE1), and, once ruled on, its verdict (CASE2). */
export interface PositionView {
  position: string; actor: string; claim: string;
  /** kj: addresses, and anything else that backs the claim: a commit, a file and line, a test run. */
  evidence: string[];
  /** The side it takes: keep the intent as written, or change it. Null for a position written before 0013. */
  seeks: RulingEffect | null;
  verdict: PositionVerdict | null; taken_at: string | null;
}
/**
 * A ruling (CASE2–CASE6): on a case file, or given directly on an element (D16). `on` is the
 * address it rules on, in the short form of its kolab. Served back to agents as precedent (CASE4).
 */
export interface RulingView {
  ruling: string; on: string; case: string | null; text: string; effect: RulingEffect | null;
  replaces: string | null; ruled_by: string; ruled_at: string | null;
}
/** A case file (CASE1): what is disputed, about which element, its positions, and its ruling once given. */
export interface CaseFileView {
  case: string; on: string; layer: Layer; question: string | null; state: CaseFileState;
  opened_by: string | null; opened_at: string | null;
  positions: PositionView[]; ruling: RulingView | null;
  /** For a superseded case file: the direct ruling on its element that settled it. */
  superseded_by: string | null;
  next: string;
}
/** The web interface's API (W3.1). */
export type * from './web.js';
export * from './limits.js';
