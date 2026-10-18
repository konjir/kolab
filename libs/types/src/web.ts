/**
 * The web interface's API (W3.1, API8): what the server's /api controllers return and accept,
 * shared by the server and the web app, which imports nothing else of Kolab's (IMP2). Every
 * address is in the short form of the session's kolab, `kj:<node>@<seq>#<element>`.
 */
import type {
  Access, ActorKind, FindingKind, Kind, Layer, MarkReason, OverrideResolution, QueryKind, ReviewVerdictKind, Role,
  Visibility, VersionState,
} from './index.js';

/** Who is signed in: the session's actor and role, its kolab and its access there. */
export interface WebMe {
  actor: string; name: string; kind: ActorKind; owner: string | null;
  role: Role; layer: Layer; kolab: string; access: Access;
}

/** A kolab the actor can reach. Only the session's own is open for work. */
export interface WebKolab { id: string; title: string; owner: string; visibility: Visibility; current: boolean }

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
  id: string; kind: QueryKind; state: 'open' | 'answered';
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
}

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
  changes: { kind: 'add' | 'override' | 'remove'; element: string; text?: string; parent?: string }[];
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
