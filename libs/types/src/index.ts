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
/**
 * One of a person's own open sessions (D103: one on each machine they sign in through), as they
 * see it: its id (whoami's `session`), whether it is the one asking (`current`), how it signed in
 * (`web`: Kolab's web page; `app`: an app or harness, such as the konjir CLI, through its OAuth
 * client; `token`: a token an admin opened), where (Kolab's own words; for an app, `app "<name>"`,
 * quoting the name the app gave itself), the app's name as it registered it (`app`, null but for
 * an app: its own claim, never checked), its kolab and role, when it opened, when it was last used
 * (when it last renewed its sign-in, else when it opened), and for a token, when it expires.
 */
export interface OwnSession {
  session: string; current: boolean; via: 'web' | 'app' | 'token'; where: string; app: string | null;
  kolab: string; role: Role; started_at: string; last_used: string; expires_at: string | null;
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
 * a Konjir admin, and each admin verb the break-glass token runs; a kolab's lease length for work set (PLN15, W5.1b); a
 * repository registered or archived by a person (KON7, D98, W5.2a); and a kolab's autonomy policy
 * changed by one of its Admins (POL2, W6.2).
 */
export const AUDIT_ACTIONS = [
  'grant.set', 'grant.removed', 'member.set', 'member.removed', 'team_member.added', 'team_member.removed', 'outbox.retried',
  // admin.elevated and admin.lowered: nothing writes them now (D111, 0043); the audit log's past rows keep them, so they stay readable.
  'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
  'work_lease.set', 'repository.registered', 'repository.archived', 'policy.set', 'ruling.backdated',
] as const;
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
/**
 * A node's kind, fixed when it is made and checked by the database (D77, D95; migration 0027's
 * node_kind_check): a kolab's one spec (KON1), its prototypes (KON2, D79) and its bindings (KON4),
 * which hold their own work: a work package is a binding element with a work field (KON5, D104).
 * Implementation is a repository, not a node (KON7). `plan` is retired (D104, migration 0033): plans
 * made before it are kept, read-only, as history, and no new one is made.
 */
export const KINDS = ['spec', 'prototype', 'binding', 'plan'] as const;
export type Kind = typeof KINDS[number];
/** The kinds no node is made of any more, though older nodes keep them (D104). */
export const RETIRED_KINDS: readonly Kind[] = ['plan'];
/** Why a plan isn't made, or written, any more (D104), in the words a refusal uses. */
export const PLAN_RETIRED = 'the plan kind is retired (D104): work is planned in the binding, where a work package is a binding element with a work field (work: { done_when, depends_on, size, milestone, target_date, repo }), and every other element is a decision';
/**
 * The kind of node each kind names as its parent, set when it is made and never changed (D78): a
 * binding names its kolab's spec, and a plan, made before D104, its binding. A spec and a prototype name none.
 */
export const PARENT_KIND: Partial<Record<Kind, Kind>> = { binding: 'spec', plan: 'binding' };
/**
 * Whether a node of kind `child` may be a variant of a version of a node of kind `parent` (D95): a
 * variant is of its parent's kind, but a prototype may be derived from the spec (KON3). So a plan
 * or a binding never inherits a spec's elements (KON6). Migration 0027's version_parent_kind holds
 * to the same for every role.
 */
export const variantKindAllowed = (child: Kind, parent: Kind) => child === parent || (child === 'prototype' && parent === 'spec');
/**
 * Why a kind Kolab once took is refused now, pointing to what replaces it (D77, D95), for clients
 * and scripts written before W4.1; undefined for anything else.
 */
export function retiredKind(kind: unknown): string | undefined {
  if (kind === 'wbs') return `wbs became plan (D77), and ${PLAN_RETIRED}`;
  if (kind === 'functional_spec') return 'functional_spec is now spec (D95): create it with kind spec';
  if (kind === 'technical_binding') return 'technical_binding is now binding (D95): create it with kind binding';
  if (kind === 'work_package') return 'a work package is an element of a binding with a work field, not a node (KON5, D104): add it to the binding';
  if (kind === 'implementation') return 'implementation is a repository, not a node (KON7, D77): a work package names the repository it is done in';
  return undefined;
}
/** Why `kind` isn't one, in the words a refusal uses. */
export const notAKind = (kind: unknown) => retiredKind(kind) ?? `a node's kind is one of ${KINDS.filter((k) => !RETIRED_KINDS.includes(k)).join(', ')} (D77, D95, D104), not ${String(kind)}`;
/** What each kind is called in prose. */
export const KIND_WORDS: Record<Kind, string> = { spec: 'spec', prototype: 'prototype', binding: 'binding', plan: 'plan' };
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
  spec: 'functional',
  prototype: 'functional',
  binding: 'technical',
  plan: 'technical',
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

/** A work package's size (PLN1): it feeds the forecast, and nobody is asked for hours. */
export const WORK_SIZES = ['S', 'M', 'L'] as const;
export type WorkSize = typeof WORK_SIZES[number];
/** The fields a work package may carry, in the order Kolab stores and shows them (migration 0047's kj_work_valid). */
export const WORK_FIELDS = ['done_when', 'depends_on', 'size', 'milestone', 'target_date', 'repo', 'release'] as const;
/**
 * A work package's fields (PLN1, PLN3, D98, D104), on an element of a binding and nowhere else
 * (migrations 0029, 0033): its definition of done, the work packages of the same binding version it
 * depends on (by element id), its size, whether it is a milestone (no work of its own: its members
 * are what it depends on), a milestone's target date (YYYY-MM-DD; only a milestone carries one,
 * PLN2), the repository it is done in, when not its binding's own (KON7), and whether it must be
 * released (`release: true`; PLN16, W7.7): an approval then leaves it In review, approved, until
 * evidence of its release is recorded, which makes it Done. An element with a work
 * field is a work package, `{}` for one whose fields are still to be given; one without is a decision.
 * What it serves and relies on are not fields: they are dependency links, into the spec or its own
 * binding (PLN1).
 */
export interface WorkFields {
  done_when?: string; depends_on?: string[]; size?: WorkSize; milestone?: boolean; target_date?: string; repo?: string; release?: boolean;
}
/**
 * A work package's state (PLN12), as on an agile board: To do, In progress, In review or Done.
 * Blocked is a flag Kolab computes, not a state. Migration 0030's work_package_state_check.
 */
export const WORK_STATES = ['todo', 'in_progress', 'in_review', 'done'] as const;
export type WorkState = typeof WORK_STATES[number];
/**
 * Progress (WRK8): a read, never a row. A work package's is its state, In review counting as in
 * progress; a decision's, a spec element's and a ruling's are computed from the work under them. No
 * work: nothing counted has work. Not served: a spec element no element of that binding serves (PLN7).
 */
export const PROGRESS_VALUES = ['done', 'in_progress', 'todo', 'no_work', 'not_served'] as const;
export type ProgressValue = typeof PROGRESS_VALUES[number];
/**
 * An element's or a ruling's progress (WRK8), with whether a work package counted is at risk (WRK6).
 * `at_risk` is told only to those who belong to the kolab's work, who read marks (D58).
 */
export interface Progress { progress: ProgressValue; at_risk?: boolean }
/** Progress in one binding of the kolab's spec (DAT18): a spec element's, or a ruling's, per binding. */
export interface BindingProgress extends Progress { binding: string }
/**
 * What a forecast date rests on (WRK9): the median of `durations` finished durations of Done
 * packages of `size`, from the package's own binding or, with none there, the kolab. `via` names the
 * package whose finish it waits on: a dependency's, or a milestone's member's.
 */
export type ForecastBasis = { size: WorkSize; durations: number; from: 'binding' | 'kolab'; via?: string } | { via: string };
/**
 * A work package's start or finish (WRK9): a read, never a row. Actual, from its events; a forecast,
 * with its basis; or no forecast, with the reason (no size, no finished duration of its size, or a
 * date it waits on that has none).
 */
export type WorkDate =
  | { at: string; kind: 'actual' }
  | { at: string; kind: 'forecast'; basis: ForecastBasis }
  | { at: null; kind: 'no_forecast'; reason: string };
/** A work package's start and finish (WRK9). */
export interface WorkDates { start: WorkDate; finish: WorkDate }
/**
 * What a work package's event records (PLN4, PLN5): its binding adding, removing or restoring it; a
 * pull, a release, a reassignment and a lease that lapsed (PLN14, PLN15); evidence, submission,
 * review and reopening (PLN16, PLN10, W5.1c and W5.2); a milestone Kolab finds Done, or no
 * longer Done (PLN3); a mark that puts work at risk, told to its last assignee (PLN10, W5.2b); and
 * evidence of its release recorded (PLN16, W7.7), which makes a package approved and waiting for its
 * release Done. Migration 0047's work_event_kind_check.
 */
export const WORK_EVENT_KINDS = [
  'added', 'removed', 'restored', 'pulled', 'released', 'reassigned', 'lapsed',
  'evidence', 'submitted', 'approved', 'changes_requested', 'done_unreviewed', 'reopened', 'confirmed',
  'milestone_done', 'milestone_reopened', 'at_risk', 'release_recorded',
] as const;
export type WorkEventKind = typeof WORK_EVENT_KINDS[number];
/**
 * What a work package's evidence is (PLN16, D98): a commit, a pull request or a test run; and a
 * release (W7.7), naming the deploy run by its link and the commit it released by its sha, recorded
 * after the deploy with konjir_record_release. Each is an attributed claim, which its reviewer checks
 * outside Kolab (D36). Migration 0047's evidence_kind_check.
 */
export const EVIDENCE_KINDS = ['commit', 'pull_request', 'test_run', 'release'] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
/**
 * One item of evidence as a client gives it (konjir_add_evidence, konjir_submit_work): a commit by
 * its sha (with its subject, the files it touched, and a link to it), a pull request by its https
 * link (and its number and title), or a test run by its link or a summary.
 */
export interface EvidenceInput {
  kind: EvidenceKind; sha?: string; pr?: number; url?: string; title?: string; files?: string[];
  /**
   * A commit's or pull request's repository (W5.2a, D98): the URL of one registered in the kolab. It may
   * be left out when the package has its repository (its `repo` field, or its binding's implementation).
   */
  repo?: string;
  /**
   * A test run's acceptance checks (REV9): each spec element it checked, by its address, and whether
   * the check passed. Each must resolve to a committed element of a spec.
   */
  checks?: AcceptanceCheckInput[];
}
/** What an acceptance check's result is (REV9). */
export const ACCEPTANCE_RESULTS = ['passed', 'failed'] as const;
export type AcceptanceResult = typeof ACCEPTANCE_RESULTS[number];
/** One acceptance check a test run ran, as a client gives it (REV9): a spec element's address, and its result. */
export interface AcceptanceCheckInput { address: string; result: AcceptanceResult }
/** One acceptance check as Kolab keeps it: the element's full address, the committed version it resolved to when recorded, and its result. */
export interface AcceptanceCheckView { address: string; version: number; result: AcceptanceResult }
/**
 * What Kolab itself finds on a work package's review (REV9, VER15): a failed acceptance check among
 * its evidence, naming the spec element, the evidence item and who recorded it. No verdict removes
 * one, and none is refused because of one: it is read from the evidence, which is never edited (PLN5).
 */
export interface AcceptanceFinding {
  kind: 'acceptance_failed'; element: string; version: number; evidence: string; recorded_by: string; at: string; explanation: string;
}
/** One item of a work package's evidence, as readers see it. */
export interface EvidenceView {
  id: string; kind: EvidenceKind; sha?: string; pr?: number; url?: string; title?: string; files?: string[];
  /** A test run's acceptance checks (REV9). */
  checks?: AcceptanceCheckView[];
  recorded_by: string; at: string;
  /** The event that recorded it: evidence while the work was under way, or a submission. */
  event: string;
  /**
   * A commit's or pull request's repository, by its URL (W5.2a), and whether that repository is
   * confirmed (D98 ruling 1). Evidence recorded before repositories existed names none, and is
   * unconfirmed (`before_repositories`). A test run has neither.
   */
  repository?: string | null; confirmed?: boolean; before_repositories?: true;
}
/**
 * A repository registered in a kolab (KON7, D98 ruling 1; W5.2a): its canonical https URL, its root
 * commit (the parentless commit a checkout of it must have), the binding it implements if any, who
 * registered it, and whether, when and by which work package's approval it was confirmed.
 */
export interface RepositoryView {
  id: string; url: string; root_sha: string; binding: string | null;
  registered_by: string; registered_at: string;
  confirmed: boolean; confirmed_by: string | null; confirmed_at: string | null; confirmed_by_work: string | null;
  archived_at: string | null;
}
/** A kolab's lease on In progress work (PLN15), in minutes: 30 by default, from 1 to 1,440 (a day). */
export const WORK_LEASE_MINUTES = { default: 30, min: 1, max: 1440 } as const;
/**
 * What a job does (JOB1, JOB6; D103, D108): build a work package; answer a review request (a work
 * package In review, or a technical version in review); answer an open question or note on a
 * technical node; settle an open mark on a technical node; or serve a spec element that no binding
 * element serves (PLN7). Migrations 0034 and 0039's job_kind_check.
 */
export const JOB_KINDS = ['build', 'review', 'answer', 'mark', 'serve'] as const;
export type JobKind = typeof JOB_KINDS[number];
/**
 * How a job ended (JOB1, JOB6): its package, or a version it drafted, submitted; its review given;
 * its question answered or note replied to; its mark cleared; its item released back to the queue
 * (for a question, a mark or a spec element, handed to a person, its note saying what they must
 * decide); its lease lapsed; or its runner stopped it with the item untouched. Migrations 0034 and
 * 0039's job_outcome_check.
 */
export const JOB_OUTCOMES = ['submitted', 'reviewed', 'answered', 'cleared', 'released', 'lapsed', 'stopped'] as const;
export type JobOutcome = typeof JOB_OUTCOMES[number];
/** What a runner says as it ends a job (konjir_end_job): its agent finished, it stopped it, or the agent failed. Migration 0034's job_said_check. */
export const JOB_ENDS = ['done', 'stopped', 'failed'] as const;
export type JobEnd = typeof JOB_ENDS[number];
/**
 * How many jobs may be live at once (JOB3; AUT7's defaults): the server's own limits, per person,
 * across every kolab, and per kolab. A kolab's policy may lower its caps, never raise them (POL1). A job lasts at most `maxHours`, however
 * often its lease is renewed (JOB1), and a runner's machine label is 1 to `machine` characters.
 */
export const JOB_LIMITS = { perPerson: 4, perKolab: 8, maxHours: 4, machine: 64 } as const;
/**
 * Live jobs against their cap (JOB3, AUT7): the person's in this kolab and the kolab's, against its
 * policy's caps (POL1); and `everywhere`, the person's in every kolab, against the server's own
 * limit, which no kolab's policy raises.
 */
export interface JobCaps {
  person: { live: number; max: number }; kolab: { live: number; max: number };
  everywhere: { live: number; max: number };
}

// ---- a kolab's autonomy policy (W6.2; AUT1–AUT5, AUT7, VER13; POL1–POL4, D103, D109) ----

/**
 * Who may approve a version of a layer (AUT2): any reviewer, agents included (`agent`); only a
 * person (`person`); or only a person other than the one whose intent the version carries, its
 * author or the owner of the agent that wrote it (`other_person`). Migration 0041's checks.
 */
export const VERSION_APPROVERS = ['agent', 'person', 'other_person'] as const;
export type VersionApprover = typeof VERSION_APPROVERS[number];
/** Who may approve a work package (AUT3, PLN16): any reviewer, agents included, or only a person. */
export const WORK_APPROVERS = ['agent', 'person'] as const;
export type WorkApprover = typeof WORK_APPROVERS[number];
/**
 * Who answers a question on the functional layer (AUT4): an agent too, citing the committed
 * elements or rulings its answer rests on (`agent_cited`), or only a person (`person`).
 */
export const FUNCTIONAL_ANSWERERS = ['agent_cited', 'person'] as const;
export type FunctionalAnswerer = typeof FUNCTIONAL_ANSWERERS[number];

/** A kolab's autonomy policy (POL1): one setting each, every one with a default. */
export interface KolabPolicy {
  /** Who approves functional versions (AUT2): a person, by default. */
  approve_functional: VersionApprover;
  /** Who approves technical versions (AUT2): an agent may, by default. */
  approve_technical: VersionApprover;
  /** Who approves work packages (AUT3): an agent may, by default. */
  approve_work: WorkApprover;
  /** Whether a binding version also needs a product approval (VER13): no, by default. */
  product_review_of_bindings: boolean;
  /** Who answers a question on the functional layer (AUT4): an agent citing its source, by default. */
  answer_functional: FunctionalAnswerer;
  /** How many jobs a person runs at once in the kolab (AUT7): 4, by default, never above JOB_LIMITS.perPerson. */
  jobs_per_person: number;
  /** How many jobs the kolab runs at once (AUT7): 8, by default, never above JOB_LIMITS.perKolab. */
  jobs_per_kolab: number;
}
/** D103's defaults (AUT2–AUT4, AUT7, VER13): what a kolab without a policy row has (POL1). */
export const DEFAULT_POLICY: Readonly<KolabPolicy> = Object.freeze({
  approve_functional: 'person', approve_technical: 'agent', approve_work: 'agent',
  product_review_of_bindings: false, answer_functional: 'agent_cited',
  jobs_per_person: JOB_LIMITS.perPerson, jobs_per_kolab: JOB_LIMITS.perKolab,
});
/** The settings, in the order konjir_read_policy and the web page show them. */
export const POLICY_SETTINGS = Object.keys(DEFAULT_POLICY) as (keyof KolabPolicy)[];
/** A kolab's policy as konjir_read_policy and konjir_set_policy give it (POL2). */
export interface PolicyView {
  kolab: string;
  policy: KolabPolicy;
  /** Which settings differ from D103's defaults. */
  changed_from_default: (keyof KolabPolicy)[];
  /** The server's own job limits, which a kolab's caps never exceed (AUT7). */
  limits: { jobs_per_person: number; jobs_per_kolab: number };
  /** Who last changed it, and when; null for a kolab that never has. */
  updated_by: string | null; updated_at: string | null;
}
/** What konjir_set_policy changed (POL2): each setting's value before and after, and the review requests it re-signalled (REV6). */
export interface PolicySet extends PolicyView {
  changes: { setting: keyof KolabPolicy; was: unknown; now: unknown }[];
  requests: { added: number; withdrawn: number };
}
/** One job as konjir_list_jobs shows it (JOB1). */
export interface JobView {
  job: string; person: string; machine: string; agent: string; kind: JobKind;
  /**
   * Its item: a work package, kj:<binding>#<id>; a version in review, kj:<node>@<seq>; a question's
   * or note's id (answer); a mark's id (mark); or a spec element, kj:<spec>#<id> (serve).
   */
  item: string;
  started_at: string; lease_until: string;
  ended_at?: string; outcome?: JobOutcome;
  /** How it ended, in its runner's words or Kolab's: for a hand-off, what the person must decide (JOB6). */
  note?: string;
}
/**
 * Why a work package is blocked (PLN19, as D98 and D104 amend it): a work package it depends on
 * isn't Done, or an open question or case file sits on it or on an element it serves or relies on. A session that
 * holds only Read is told neither an open case file nor a question a mark raised (0013, 0022; D58).
 */
export type WorkBlock =
  | { reason: 'depends_on'; work: string; state: WorkState }
  | { reason: 'question'; on: string; query: string }
  | { reason: 'case_file'; on: string; case: string };
/** One work package on the board (konjir_list_work): what it is, where it stands, and whether it can be pulled. */
export interface WorkItemView {
  /** Its address: kj:<binding>#<id> in the reader's kolab. */
  work: string; binding: string; id: string; text: string;
  state: WorkState;
  /** Who holds it, or held it last (null for To do, and for a milestone). */
  assignee: string | null;
  /** While In progress: when its lease lapses unless its assignee calls Kolab (PLN15). */
  lease_until: string | null;
  milestone: boolean; size: WorkSize | null;
  /** Blocked (PLN19): why, empty when it isn't. Work already In progress continues. */
  blocked: WorkBlock[];
  /** To do, not blocked and not a milestone, and the reader may write the technical layer (PLN13). */
  ready: boolean;
  /**
   * A milestone not Done: why, its members that aren't Done, in the shape of a blocked reason (PLN3,
   * W5.7). A milestone is never pulled; it is Done, by itself, when every member is.
   */
  waiting?: Extract<WorkBlock, { reason: 'depends_on' }>[];
  /** Removed from its binding (PLN4), or made a decision: the version that removed it (a plan's, before D104). Never ready. */
  removed_in?: string;
  /** Done on submission with no reviewer (PLN16). */
  unreviewed?: boolean;
  /** It must be released (its `release` field; PLN16, W7.7): Done only once evidence of its release is recorded. */
  release?: true;
  /**
   * In review, approved, and waiting for its release (PLN16, W7.7): its reviewer approved it, and it
   * is Done once someone with Write on the technical layer records the deploy that released it
   * (konjir_record_release). It takes no other verdict meanwhile.
   */
  approved?: true;
  /** In progress again after a request for changes (PLN16, PLN18): it doesn't count against its assignee's one pull. */
  returned?: boolean;
  /**
   * At risk (PLN10, W5.2b): it has work (In progress, In review or Done) and an open mark says
   * something it serves or relies on changed since. Done stays Done. Told only to those who belong
   * to the kolab's work, who read marks (D58).
   */
  at_risk?: true;
  /** While at risk: the work to look at again, from its evidence since it was last To do (PLN10, WRK6). */
  revisit?: WorkRevisit;
  /** When it started and finishes (WRK9), on the board and a package read: each actual, a forecast, or no forecast and why. */
  start?: WorkDate; finish?: WorkDate;
}
/**
 * What to revisit on an at-risk work package (PLN10, WRK6): the work its evidence names since it was
 * last To do. Kolab reads no repository (D36): these are the claims its assignee recorded.
 */
export interface WorkRevisit {
  /** The repository the work is in: the one its commits and pull requests name, else the package's own; null with neither. */
  repository: string | null;
  /** Its commits' SHAs, in the order they were recorded. */
  commits: string[];
  /** The paths its commits touched, sorted; at most REVISIT_FILES, with `files_more` counting the rest. */
  files: string[];
  files_more?: number;
  /** Its pull requests' links, in the order they were recorded. */
  pull_requests: string[];
}
/** At most this many files in a revisit (WorkRevisit). */
export const REVISIT_FILES = 200;
/** One event of a work package (PLN5), oldest first. */
export interface WorkEventView {
  id: string; kind: WorkEventKind; from: WorkState | null; to: WorkState | null; actor: string; at: string;
  /** The version it stood in: its binding's (a plan's, for an event before D104, migration 0033). */
  version: string;
  /** The elements it serves and relies on, at the versions the event concerned. */
  concerned: { address: string; version_id: string | null; fingerprint: string | null }[];
  note: string | null;
}
/** An element as a draft gives it: `work` only on a binding's elements, its work packages (D98, D104). */
/**
 * An element as a draft gives it. `parent` left out keeps where the element sits; `null`, which only
 * Kolab's own callers send (an import), puts it at the top level.
 */
export interface ElementInput { id?: string; text: string; parent?: string | null; work?: WorkFields | null }
/**
 * A change to one element. On an add or an override, `work` replaces the element's work fields
 * whole (null clears them); left out, the element keeps the ones it has.
 */
export interface DeltaInput { kind: DeltaKind; element: string; text?: string; parent?: string | null; work?: WorkFields | null }
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
  /**
   * The hash of its normalized text, and of its work fields when it has any (D98): so an element
   * with none keeps the fingerprint it always had, and a change to a done-when is a change.
   */
  fingerprint: string;
  /** A work package's fields (D98, D104): present on a binding's work packages (`{}` for one with none yet), absent on every other element. */
  work?: WorkFields;
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
  /** A binding version's product reviewers (VER13), told beside `reviewers` when its kolab requires a product approval. */
  product_reviewers?: string[];
  /**
   * Why nobody can approve it yet, when its kolab's policy keeps the approval for a person no one
   * here is (AUT1, AUT2, POL3): it waits in review until one may, or an Admin changes the policy.
   */
  nobody?: string;
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

/**
 * A review request as a reviewer's inbox shows it (VER17): its subject is a version (kj:<node>@<seq>)
 * or a work package (kj:<binding>#<id>), and `subject_kind` says which. A work package's author is its
 * assignee.
 */
export interface ReviewRequestView {
  request: string; subject: string; subject_kind: 'version' | 'work'; author: string; reviewer: string;
  requested_at: string; next: string;
  /** A work package's: how many open marks make it at risk (PLN10, D102), which its reviewer sees before approving. */
  open_marks?: number;
  /** A work package's: the failed acceptance checks among its evidence this round (REV9), which its reviewer sees with the request. */
  findings?: AcceptanceFinding[];
  /**
   * A binding version's product review (VER13): its kolab requires a product approval of bindings,
   * so a reviewer from a product session checks that it doesn't change behavior.
   */
  product_review?: true;
}
/** A version an author submitted, with the review it has had, as the author's answers show it. */
export interface SubmissionView {
  subject: string; state: VersionState; note: string | null;
  /** For a version Kolab folded into a fresh rebase: the fold that carries its edit. */
  folded_into?: string;
  verdicts: { reviewer: string; state: ReviewRequestState; note: string | null; findings: Finding[]; product_review?: true }[];
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
   * What its answer cites (AUT4, POL3): committed element addresses, each pinned to its version, and
   * ruling ids. An agent's answer to a question on the functional layer always cites; any other may.
   */
  cites?: string[];
  /**
   * The version it was asked of, when the question has moved since: it was asked of a version in
   * review that was then abandoned or returned to its author (D65). Only in the question's own kolab.
   */
  asked_of?: string;
  /** It moved, and its element's text in the version it is on now differs from the version it was asked of. */
  element_changed?: true;
  /**
   * An answer job handed it to a person, at handed_off_at (JOB6): it waits on people, no job takes
   * it again, and only a person answers it. Only while it is open, and only in its own kolab.
   */
  waiting_on?: 'person';
  handed_off_at?: string;
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
  ruling: string;
  /** Its own name in its kolab, such as D109 (W6.3), or null for one given without. */
  ref: string | null;
  on: string; case: string | null; text: string; effect: RulingEffect | null;
  replaces: string | null; ruled_by: string;
  /** When it was given: for a ruling recorded later, the date it was given (W6.3). */
  ruled_at: string | null;
  /** When Kolab recorded it; null for a ruling from before migration 0042. */
  recorded_at: string | null;
  /**
   * Its progress in each binding of the kolab's spec (WRK8), from the elements whose Source line
   * names its ref. Absent for a ruling with no ref, or that no element names.
   */
  progress?: BindingProgress[];
}
/** A ruling's ref (W6.3): a letter, then up to 39 letters, digits, '.', '_' or '-', such as D109. Migration 0042's ruling_ref_form. */
export const RULING_REF = /^[A-Za-z][A-Za-z0-9._-]{0,39}$/;
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
export { REFRESH_HEADER } from './web.js';
export * from './limits.js';
