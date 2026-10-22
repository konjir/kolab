/**
 * The web interface's API (W3.1, API8): what the server's /api controllers return and accept,
 * shared by the server and the web app, which imports nothing else of Kolab's (IMP2). Every
 * address is in the short form of the session's kolab, `kj:<node>@<seq>#<element>`.
 */
import type {
  Access, AccessLevel, ActorKind, CaseFileView, FindingKind, InviteLevel, InviteView, Kind, Layer, MarkReason, OverrideResolution, PositionVerdict, QueryKind,
  QueryState, ReviewVerdictKind, Role, RulingEffect, RulingView, Visibility, VersionState,
} from './index.js';

/** How a person may sign in to this Kolab (D55): with its identity provider, named for the button, and with a pasted token (development). */
export interface WebSignInMethods { provider: string | null; token: boolean }

/**
 * How this Kolab says to get the konjir CLI (W3.7): `npm` is the published package spec its
 * operator set (KONJIR_CLI_NPM_SPEC, pinned to an exact version), for `npx <npm> …`; null while the
 * package isn't published, when the page shows a checkout's `bin/konjir` instead, and says so.
 */
export interface WebCli { npm: string | null }

/** Who is signed in: the session's actor and role, its kolab and its access there. */
export interface WebMe {
  actor: string; name: string; kind: ActorKind; owner: string | null;
  role: Role; layer: Layer; kolab: string; access: Access;
}

/** A kolab the actor can reach. Only the session's own is open for work. */
export interface WebKolab {
  id: string; title: string; owner: string; visibility: Visibility; current: boolean;
  /** The signed-in person's access there, as kj_access computes it. */
  access: Access;
}

export interface WebNodeSummary {
  name: string; kind: Kind; layer: Layer; title: string;
  /** The latest committed version's number, or null before the first commit. */
  latest: number | null; drafts: number; in_review: number;
}

/** The kolab the session works in, at a glance. */
export interface WebOverview {
  me: WebMe;
  kolab: WebKolab;
  kolabs: WebKolab[];
  nodes: WebNodeSummary[];
  counts: {
    /** Open marks on the session's layer. */
    stale: number;
    /** Open questions and notes the session's layer owns the answer to. */
    waiting: number;
    /** Review requests waiting for the session's actor. */
    reviews: number;
    /** Open questions and notes in the kolab, whoever owns them. */
    open: number;
    /** Open case files on the session's layer (none for a session that holds only Read there, D49). */
    cases: number;
  };
}

export interface WebVersion {
  seq: number; state: VersionState; author: string; role: string;
  /** When the version was written (drafted), ISO 8601. Kolab doesn't record commit times yet. */
  at: string; note: string | null; mine: boolean;
}

export interface WebLink {
  edge: string; kind: string;
  source: { node: string; seq: number; element: string | null; layer: Layer };
  target: { node: string; seq: number; element: string | null; quote: string | null; latest: number | null };
  /** An open mark on the link: what it relied on changed since it was pinned. */
  mark: { id: string; reason: MarkReason } | null;
}

export interface WebQuery {
  id: string; kind: QueryKind; state: QueryState;
  address: string; node: string; seq: number; element: string | null; quote: string | null;
  /** The layer that owns the answer. */
  layer: Layer;
  question: string; raised_by: string | null; at: string;
  answer: string | null; answered_by: string | null;
  /** The asker's own element waiting on the answer, if any. */
  from: string | null;
  /** The mark it is about: such a question settles with the mark (resolve or clear), not with an answer, unless it is a role_boundary one. */
  mark: string | null; mark_reason: MarkReason | null;
}

export interface WebMark {
  id: string; reason: MarkReason; node: string; seq: number; element: string | null; layer: Layer;
  /** Why, in words, and what settles it. */
  because: string; next: string; at: string;
  /** For a mark on a link: what it relies on, the text it was pinned to and the text now. */
  target: { node: string; element: string | null; pinned: number; now: number; before: string | null; after: string | null } | null;
  /** For a mark on a variant's override: its own text, and the parent's text it was written against and now. */
  override: { element: string; mine: string | null; parent_before: string | null; parent_now: string | null } | null;
  /** The open question the mark raised, if any. */
  question: string | null;
}

export interface WebElement {
  id: string; parent: string | null; text: string; address: string;
  /** Questions and notes on this element, open and answered, from any version (Q5). */
  queries: WebQuery[];
  /** Links from this element to what it relies on. */
  relies_on: WebLink[];
  /** Links from other elements that rely on this one. */
  relied_on_by: WebLink[];
  /** Open marks on this element in the node's live version. */
  marks: WebMark[];
  /** Rulings on this element, from any version, newest first: precedent (CASE4). None for a reader outside the kolab's work (D49). */
  rulings: WebRuling[];
  /** Case files still open on this element, from any version. None for a reader outside the kolab's work (D49). */
  cases: WebCase[];
}

/** A ruling (CASE2–CASE6), with what it rules on taken apart: `on` is its address in its kolab's short form. */
export interface WebRuling extends RulingView { node: string; seq: number; element: string | null }

/** A case file (CASE1), with its subject taken apart, and what the signed-in person may do with it. */
export interface WebCase extends CaseFileView {
  node: string; seq: number; element: string | null;
  ruling: WebRuling | null;
  /**
   * Which actions the page offers the signed-in person. Kolab decides each one when it is taken
   * (D49, D51); these only spare a person a button that would be refused.
   */
  you: {
    /** The person, or one of their agents, holds a position on it: one side, so never its judge. */
    party: boolean;
    /** It holds one side, and the person may take the other. */
    can_argue: boolean;
    /** It holds both sides, and the person may rule: Write on its layer, from that role, and not a party. */
    can_rule: boolean;
  };
}

export interface WebReview {
  seq: number; author: string; at: string;
  /** Who has a review request for it. */
  reviewers: string[];
  /** Whether the session's actor is one of them, in the layer its role writes. */
  for_me: boolean;
}

/** One node, as the session reads it at one version. */
export interface WebNodeView {
  node: WebNodeSummary;
  /** The version read: the latest committed by default. Null for a node with nothing to read yet. */
  reading: WebVersion | null;
  versions: WebVersion[];
  elements: WebElement[];
  /** Questions and notes on the node as a whole. */
  queries: WebQuery[];
  /** The version the one read is compared with: the committed version before it, or for a version in review, the one it was built on. */
  compared_with: { seq: number; elements: { id: string; text: string }[] } | null;
  /** Versions of this node waiting in review. */
  in_review: WebReview[];
  /** The session's own drafts of this node, such as one returned with changes requested. */
  drafts: WebVersion[];
  /** Whether the session may write this node: its layer is the session's, and its access covers it. */
  can_write: boolean;
  /** Rulings on the node as a whole, newest first. */
  rulings: WebRuling[];
  /** The kolab the node is in. */
  kolab: string;
  /**
   * Read in place from another kolab than the session's (D49): committed versions only, with their
   * elements and questions, and nothing else of that kolab's (no links, marks, reviews, drafts, case
   * files or rulings). Nothing can be written or asked from here.
   */
  foreign: boolean;
}

/** Another kolab's nodes, as the session reads them in place (D49): committed work only. */
export interface WebForeignKolab {
  kolab: { id: string; title: string; owner: string; visibility: Visibility; access: Access };
  nodes: WebNodeSummary[];
}

export interface WebCasesView {
  cases: WebCase[];
  /** Whether the session belongs to its kolab's work (Write on a layer of it): only then does it see case files (D49). */
  belongs: boolean;
}
export interface WebRulingsView { rulings: WebRuling[] }

export interface WebQueriesView { queries: WebQuery[] }
export interface WebMarksView { marks: WebMark[] }

export interface WebReviewsView {
  for_me: { subject: string; node: string; seq: number; author: string; at: string }[];
  mine: { subject: string; node: string; seq: number; state: VersionState; note: string | null;
    verdicts: { reviewer: string; state: string; note: string | null }[] }[];
}

export interface WebLineageView {
  nodes: { name: string; title: string; kind: Kind; layer: Layer; seq: number; elements: { id: string; text: string }[] }[];
  links: WebLink[];
}

export interface WebActivityItem { at: string; actor: string; text: string }
export interface WebActivityView { items: WebActivityItem[] }

/** What a submission, a resubmission or a verdict came to. */
export interface WebOutcome {
  ok: boolean;
  /** The version it names: the one that committed, waits in review, or stayed drafted. */
  seq: number;
  committed: boolean; in_review: boolean; stale: boolean; unreviewed: boolean;
  reviewers: string[]; note: string | null;
  /** Committed, but its cascade waits behind an earlier one of its node (W1.8). */
  cascade_queued: boolean;
  /** A draft that failed Kolab's checks is abandoned, so the page keeps the edits (POST …/submit only). */
  abandoned: boolean;
}

// ---- requests ----------------------------------------------------------------

export interface WebSignIn { token: string }
export interface WebCreateNode { kind: Kind; title: string; name: string }
/** A change to one node: elements edited, added or removed, against its latest committed version. */
export interface WebSubmit {
  /**
   * The version the page's edits were made on: the node's latest committed version when the page
   * read it, or null for a node with none. If the node has moved on since, the submission is
   * refused as stale (409), and the page keeps the edits.
   */
  base: number | null;
  changes: { kind: 'add' | 'override' | 'remove'; element: string; text?: string; parent?: string }[];
  /** Links of the base version to drop (konjir_draft's unlink), by their edge: the commit settles their open marks. */
  unlink?: string[];
  /** A draft of the session's own that this one replaces, abandoned once the new one is written. */
  replaces?: number;
}
export interface WebVerdict {
  verdict: ReviewVerdictKind; note?: string;
  findings?: { kind: FindingKind; elements: string[]; explanation: string }[];
}
export interface WebResolve { resolution: OverrideResolution; text?: string }
export interface WebAsk { node: string; element?: string; seq?: number; kind: QueryKind; text: string }
export interface WebAnswer { answer: string }
/** konjir_open_case: a case file on one element of a committed version, with the opener's position. */
export interface WebOpenCase {
  node: string; seq?: number; element: string;
  question: string; claim: string;
  /** kj: addresses, each of which must resolve, and anything else as text. */
  evidence: string[];
  seeks: RulingEffect;
}
/** konjir_add_position: the other side of an open case file. */
export interface WebPosition { claim: string; evidence: string[] }
/** konjir_rule on a case file: sustains exactly one of its two positions (D51). */
export interface WebRuleCase { text: string; verdicts: Record<string, PositionVerdict>; replaces?: string }
/** konjir_rule directly, on an element or a whole node, with no case file behind it (CASE3, D16). */
export interface WebRuleDirect { node: string; seq?: number; element?: string; text: string; effect: RulingEffect; replaces?: string }
/** Switch the signed-in person's session to another kolab, or the other role: the old session ends, and a new one opens (ENF4). */
export interface WebSwitch { kolab: string; role: Role }
/** A kolab of the signed-in person's own (TEN2, TEN3): its name is unique across Konjir (TEN4). The session switches into it. */
export interface WebCreateKolab { name: string; title: string }

/** An invite to the session's kolab (W3.4): a level, and for Write its layers (both by default). Never Admin. */
export interface WebCreateInvite { level: InviteLevel; layers?: Layer[] }
/** A new invite: its secret, shown this once, from which the page makes the link `<origin>/#/invite/<token>`. */
export interface WebInviteMade { token: string; invite: InviteView }
export interface WebInvitesView { invites: InviteView[] }
/** An invite's secret, from its link. */
export interface WebInviteToken { token: string }

/**
 * A direct grant's new level on the session's kolab (W3.6), and for Write its layers (both by
 * default). Admin only from the kolab's owners; an agent never above its owner.
 */
export interface WebChangeGrant { level: AccessLevel; layers?: Layer[] }
/** What a change of access did: how many sessions it ended, which can't reach the kolab now. */
export interface WebAccessChanged { ended: number }

/** An error the API returns: an HTTP status with this body. */
export interface WebError { error: string; message: string }

/**
 * What the event stream (GET /api/events, server-sent events) sends. `changed` is only a signal:
 * the page re-reads what it shows. `ended` means the session ended and its token is revoked.
 */
export type WebEvent =
  | { type: 'ready' }
  | { type: 'changed'; what: 'layer'; layer: Layer }
  | { type: 'changed'; what: 'answers' }
  | { type: 'changed'; what: 'versions' }
  | { type: 'ended' };
