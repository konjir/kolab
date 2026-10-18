/**
 * Read models for the web interface (W3.1): what a person reads in one place that the verbs give
 * piecemeal. Each runs as the session reads (Kolab.readAs: kj_agent, under row-level security),
 * and names the session's kolab explicitly too, so it reads nothing of another kolab (TEN12).
 * None of them writes.
 */
import type { QuoteSelector } from '@konjir/address';
import { formatAddress } from '@konjir/address';
import type { Kind, Layer, MarkReason, QueryKind, ReviewRequestState, VersionState } from '@konjir/types';
import { NEXT_STEP, type Kolab } from './kolab.js';

export interface VersionHistoryRow {
  seq: number; state: VersionState; actor: string; role: string; at: string; note: string | null; base_seq: number | null;
}

/**
 * The committed versions of a node of another kolab, oldest first, as a reader outside it sees
 * them (D49): its drafts, versions in review and rejected versions are left out, as row-level
 * security leaves them out too. The caller has checked the session may read that kolab.
 */
export async function committedVersions(kolab: Kolab, session: string, nodeId: string): Promise<VersionHistoryRow[]> {
  return kolab.readAs(session, async (q) => (await q.query<VersionHistoryRow & { at: Date | string }>(
    `select v.seq, v.state, v.actor_id as actor, v.active_role as role, v.created_at as at, null::text as note, null::int as base_seq
       from version v where v.node_id = $1 and v.state = 'committed' order by v.seq`, [nodeId])).rows.map((r) => ({ ...r, at: iso(r.at) })));
}

/** Every version of a node, oldest first, with who wrote it and when. */
export async function versionHistory(kolab: Kolab, session: string, nodeId: string): Promise<VersionHistoryRow[]> {
  const here = await kolab.sessionKolab(session);
  return kolab.readAs(session, async (q) => (await q.query<VersionHistoryRow & { at: Date | string }>(
    `select v.seq, v.state, v.actor_id as actor, v.active_role as role, v.created_at as at, v.review_note as note, b.seq as base_seq
       from version v left join version b on b.id = v.base_version_id
      where v.node_id = $1 and v.kolab_id = $2 order by v.seq`, [nodeId, here])).rows.map((r) => ({ ...r, at: iso(r.at) })));
}

export interface LinkRow {
  edge: string; kind: string;
  source_node: string; source_seq: number; source_element: string | null; source_layer: Layer;
  target_node: string; target_seq: number; target_element: string | null; target_selector: QuoteSelector | null; target_latest: number | null;
  mark_id: string | null; mark_reason: MarkReason | null;
}

/**
 * The live links of the session's kolab: those declared by each node's latest committed version,
 * with the version each pins and an open mark on it, if any.
 */
export async function liveLinks(kolab: Kolab, session: string): Promise<LinkRow[]> {
  const here = await kolab.sessionKolab(session);
  return kolab.readAs(session, async (q) => (await q.query<LinkRow>(
    `select e.id as edge, e.kind, sn.name as source_node, sv.seq as source_seq, e.source_element_id as source_element, sv.layer as source_layer,
            tn.name as target_node, tv.seq as target_seq, e.target_element_id as target_element, e.target_selector,
            (select max(l.seq) from version l where l.node_id = tn.id and l.state = 'committed') as target_latest,
            m.id as mark_id, m.reason as mark_reason
       from edge e
       join version sv on sv.id = e.source_version_id join node sn on sn.id = sv.node_id
       join version tv on tv.id = e.target_version_id join node tn on tn.id = tv.node_id
       left join lateral (select i.id, i.reason from invalidation i where i.edge_id = e.id and i.state = 'open'
                           order by i.created_at, i.id limit 1) m on true
      where e.kolab_id = $1 and sv.state = 'committed'
        and not exists (select 1 from version later where later.node_id = sv.node_id and later.seq > sv.seq and later.state = 'committed')
      order by sn.name, e.source_element_id nulls first, tn.name, e.target_element_id nulls first, e.id`, [here])).rows);
}

export interface MarkDetailRow {
  id: string; reason: MarkReason; node: string; seq: number; layer: Layer; element: string | null; at: string;
  /** For a mark on a link: what it relies on, pinned and now. */
  target_node: string | null; target_element: string | null; target_pinned: number | null; target_now: number | null;
  target_before: string | null; target_after: string | null;
  /** For a mark on a variant's override. */
  override_element: string | null; override_text: string | null; parent_before: string | null; parent_now: string | null;
  /** The open question the mark raised. */
  question: string | null;
  /** Why, in words, and what settles it, as konjir_list_stale says them. */
  because: string; next: string;
}

/** The open marks of the session's kolab, with the texts a person compares to settle each. */
export async function markDetails(kolab: Kolab, session: string): Promise<MarkDetailRow[]> {
  const here = await kolab.sessionKolab(session);
  return kolab.readAs(session, async (q) => (await q.query<Omit<MarkDetailRow, 'because' | 'next'> & { at: Date | string; note: string | null; edge_id: string | null;
    target_selector: QuoteSelector | null; trig_node: string; trig_seq: number; cause_count: number }>(
    `select i.id, i.reason, n.name as node, v.seq, v.layer, i.element_id as element, i.created_at as at,
            etn.name as target_node, e.target_element_id as target_element, etv.seq as target_pinned,
            (select max(l.seq) from version l where l.node_id = etv.node_id and l.state = 'committed') as target_now,
            (select x.text from element x where x.version_id = e.target_version_id and x.element_id = e.target_element_id) as target_before,
            (select x.text from element x where x.element_id = e.target_element_id and x.version_id =
               (select l.id from version l where l.node_id = etv.node_id and l.state = 'committed' order by l.seq desc limit 1)) as target_after,
            d.element_id as override_element, d.text as override_text,
            (select x.text from element x where x.version_id = d.base_version_id and x.element_id = d.element_id) as parent_before,
            (select x.text from element x where x.version_id = v.parent_version_id and x.element_id = d.element_id) as parent_now,
            (select qq.id from query qq where qq.invalidation_id = i.id and qq.state = 'open' order by qq.id limit 1) as question,
            i.note, i.edge_id, e.target_selector, tn.name as trig_node, tv.seq as trig_seq,
            (select count(*)::int from invalidation_cause c where c.mark_id = i.id) as cause_count
       from invalidation i
       join version tv on tv.id = i.triggered_by join node tn on tn.id = tv.node_id
       join version v on v.id = i.version_id join node n on n.id = v.node_id
       left join edge e on e.id = i.edge_id
       left join version etv on etv.id = e.target_version_id left join node etn on etn.id = etv.node_id
       left join delta d on d.id = i.delta_id
      where i.state = 'open' and i.kolab_id = $1
      order by i.created_at, i.id`, [here])).rows.map(({ note, edge_id, target_selector, trig_node, trig_seq, cause_count, ...r }) => ({
    ...r, at: iso(r.at),
    // The same words as describeMarks, read under row-level security.
    because: r.reason === 'query_answered' ? note ?? 'your question was answered'
      : note ? `review gate: ${note}`
      : edge_id ? `${formatAddress({ node: trig_node, element: r.target_element ?? undefined, selector: target_selector ?? undefined })} changed in version ${trig_seq}`
      : r.reason === 'upstream_dirty' ? `${cause_count} upstream mark(s) are open`
      : `parent ${trig_node} version ${trig_seq}`,
    next: NEXT_STEP[r.reason] ?? '',
  })));
}

export interface NodeRowView { name: string; kind: Kind; layer: Layer; title: string; latest: number | null; drafts: number; in_review: number }

/** The session's kolab's nodes, with their latest committed version and how many drafts and versions in review each has. */
export async function kolabNodes(kolab: Kolab, session: string): Promise<NodeRowView[]> {
  const here = await kolab.sessionKolab(session);
  return kolab.readAs(session, async (q) => (await q.query<NodeRowView>(
    `select n.name, n.kind, n.layer, n.title,
            (select max(seq) from version v where v.node_id = n.id and v.state = 'committed') as latest,
            (select count(*)::int from version v where v.node_id = n.id and v.state = 'drafted') as drafts,
            (select count(*)::int from version v where v.node_id = n.id and v.state = 'in_review') as in_review
       from node n where n.kolab_id = $1 order by n.kind, n.name`, [here])).rows);
}

/**
 * Another kolab's nodes that have a committed version, each at its latest, as a reader outside it
 * sees them (D49): a node with only drafts, versions in review or rejected versions is left out, as
 * a version that doesn't exist is. One read-only transaction as kj_agent, which checks Read for that
 * kolab alone first (kj_session_readable_kolabs): undefined if the session can't read it now,
 * whether or not it exists.
 */
export async function readableNodes(kolab: Kolab, session: string, inKolab: string): Promise<NodeRowView[] | undefined> {
  return kolab.readAs(session, async (q) => {
    const may = (await q.query<{ ok: boolean }>(`select $1 = any ((select kj_session_readable_kolabs())::text[]) as ok`, [inKolab])).rows[0]?.ok;
    if (!may) return undefined;
    return (await q.query<NodeRowView>(
      `select n.name, n.kind, n.layer, n.title, l.latest, 0 as drafts, 0 as in_review
         from node n cross join lateral (select max(v.seq) as latest from version v where v.node_id = n.id and v.state = 'committed') l
        where n.kolab_id = $1 and l.latest is not null order by n.kind, n.name`, [inKolab])).rows;
  });
}

/** How many case files are open on `layer` in the session's kolab: none for a session that holds only Read (D49). */
export async function openCaseCount(kolab: Kolab, session: string, layer: Layer): Promise<number> {
  const here = await kolab.sessionKolab(session);
  return kolab.readAs(session, async (q) => (await q.query<{ n: number }>(
    `select count(*)::int as n from case_file c join version v on v.id = c.version_id
      where c.kolab_id = $1 and c.state = 'open' and v.layer = $2`, [here, layer])).rows[0].n);
}

/**
 * Which of `actors` answer for `person` (D51): the person, and their agents. Kolab's own lookup,
 * since kj_agent reads no actors; it says only which ids are the person's, of those it is given.
 */
export async function ownSide(kolab: Kolab, person: string, actors: string[]): Promise<Set<string>> {
  if (!actors.length) return new Set();
  return new Set((await kolab.db.query<{ id: string }>(
    `select id from actor where id = any($1::text[]) and (id = $2 or (kind = 'agent' and owner_id = $2))`, [actors, person])).rows.map((r) => r.id));
}

export interface ReviewRequestRow { node: string; seq: number; layer: Layer; author: string; reviewer: string; at: string }

/** The open review requests in the session's kolab, on versions still in review, oldest first. */
export async function openReviewRequests(kolab: Kolab, session: string): Promise<ReviewRequestRow[]> {
  const here = await kolab.sessionKolab(session);
  return kolab.readAs(session, async (q) => (await q.query<ReviewRequestRow & { at: Date | string }>(
    `select n.name as node, v.seq, v.layer, v.actor_id as author, r.reviewer_id as reviewer, r.created_at as at
       from review_request r join version v on v.id = r.version_id join node n on n.id = v.node_id
      where r.state = 'open' and v.state = 'in_review' and r.kolab_id = $1
      order by r.created_at, r.reviewer_id, r.id`, [here])).rows.map((r) => ({ ...r, at: iso(r.at) })));
}

export interface SubmissionRow {
  node: string; seq: number; state: VersionState; note: string | null;
  verdicts: { reviewer: string; state: ReviewRequestState; note: string | null }[];
}

/** What `actor` submitted for review in the session's kolab, newest first, with the verdicts. */
export async function submissionsOf(kolab: Kolab, session: string, actor: string, limit = 20): Promise<SubmissionRow[]> {
  const here = await kolab.sessionKolab(session);
  return kolab.readAs(session, async (q) => {
    const versions = (await q.query<{ id: string; node: string; seq: number; state: VersionState; note: string | null }>(
      `select v.id, n.name as node, v.seq, v.state, v.review_note as note
         from version v join node n on n.id = v.node_id
        where v.actor_id = $1 and v.kolab_id = $2 and exists (select 1 from review_request r where r.version_id = v.id)
        order by v.created_at desc, v.id desc limit $3`, [actor, here, limit])).rows;
    const out: SubmissionRow[] = [];
    for (const { id, ...v } of versions) {
      out.push({ ...v, verdicts: (await q.query<{ reviewer: string; state: ReviewRequestState; note: string | null }>(
        `select reviewer_id as reviewer, state, note from review_request where version_id = $1 order by created_at, reviewer_id, id`, [id])).rows });
    }
    return out;
  });
}

export interface QueryDetailRow {
  id: string; kind: QueryKind; state: 'open' | 'answered'; node: string; seq: number; layer: Layer;
  element: string | null; selector: QuoteSelector | null; question: string; raised_by: string | null; at: string;
  answer: string | null; answered_by: string | null;
  from_node: string | null; from_seq: number | null; from_element: string | null;
  mark: string | null; mark_reason: MarkReason | null;
}

/**
 * Questions and notes in the session's kolab, newest first, on one node if `nodeId` is given. With
 * `inKolab`, another kolab's, which a reader outside it sees only on its committed versions (D49).
 * Questions a mark raised (a boundary, a ruling that changes the intent) are left out there, and
 * no question names a mark or an asking element: that kolab's marks and rulings stay private. The
 * caller has checked the session may read it.
 */
export async function queryDetails(kolab: Kolab, session: string, nodeId?: string, inKolab?: string): Promise<QueryDetailRow[]> {
  const own = await kolab.sessionKolab(session);
  const here = inKolab ?? own;
  const outside = here !== own;
  return kolab.readAs(session, async (q) => (await q.query<QueryDetailRow & { at: Date | string }>(
    `select q.id, q.kind, q.state, n.name as node, v.seq, v.layer, q.element_id as element, q.selector, q.question,
            q.raised_by, q.created_at as at, q.answer, q.answered_by,
            fn.name as from_node, fv.seq as from_seq, q.from_element_id as from_element,
            q.invalidation_id as mark, i.reason as mark_reason
       from query q
       join version v on v.id = q.version_id join node n on n.id = v.node_id
       left join version fv on fv.id = q.from_version_id left join node fn on fn.id = fv.node_id
       left join invalidation i on i.id = q.invalidation_id
      where q.kolab_id = $1 and ($2::text is null or v.node_id = $2) and (not $3 or (v.state = 'committed' and q.invalidation_id is null))
      order by q.created_at desc, q.id desc`, [here, nodeId ?? null, outside])).rows.map((r) => ({
    ...r, at: iso(r.at), ...(outside ? { mark: null, mark_reason: null, from_node: null, from_seq: null, from_element: null } : {}),
  })));
}

export type ActivityRow =
  | { at: string; actor: string; kind: 'version'; node: string; seq: number; state: VersionState; note: string | null }
  | { at: string; actor: string; kind: 'verdict'; node: string; seq: number; state: 'approved' | 'changes_requested' }
  | { at: string; actor: string | null; kind: 'query'; node: string; seq: number; element: string | null; query_kind: QueryKind }
  | { at: string; actor: null; kind: 'mark'; node: string; seq: number; element: string | null; reason: MarkReason }
  | { at: string; actor: string | null; kind: 'case'; node: string; seq: number; element: string | null; case: string }
  | { at: string; actor: string; kind: 'position'; node: string; seq: number; element: string | null; case: string }
  | { at: string; actor: string; kind: 'ruling'; node: string; seq: number; element: string | null; effect: string | null };

/**
 * What happened in the session's kolab, newest first, from what Kolab records: versions as they
 * were written (submitted, committed or rejected; Kolab doesn't record commit times yet, nor when
 * a question was answered), verdicts as they were given, questions and notes as they were raised,
 * and marks as they were raised. Drafts not submitted are left out.
 */
export async function activity(kolab: Kolab, session: string, limit = 80): Promise<ActivityRow[]> {
  const here = await kolab.sessionKolab(session);
  const rows = await kolab.readAs(session, async (q) => (await q.query<Record<string, unknown> & { at: Date | string }>(
    `select * from (
       select v.created_at as at, v.actor_id as actor, 'version' as kind, n.name as node, v.seq, v.state, v.review_note as note,
              null::text as element, null::text as extra
         from version v join node n on n.id = v.node_id
        where v.kolab_id = $1 and v.state in ('in_review', 'committed', 'rejected')
       union all
       select r.decided_at, r.reviewer_id, 'verdict', n.name, v.seq, r.state, null, null, null
         from review_request r join version v on v.id = r.version_id join node n on n.id = v.node_id
        where r.kolab_id = $1 and r.decided_at is not null and r.state in ('approved', 'changes_requested')
       union all
       select q.created_at, q.raised_by, 'query', n.name, v.seq, q.state, null, q.element_id, q.kind
         from query q join version v on v.id = q.version_id join node n on n.id = v.node_id
        where q.kolab_id = $1
       union all
       select i.created_at, null, 'mark', n.name, v.seq, i.state, null, i.element_id, i.reason
         from invalidation i join version v on v.id = i.version_id join node n on n.id = v.node_id
        where i.kolab_id = $1
       union all
       select c.opened_at, c.opened_by, 'case', n.name, v.seq, c.state, null, c.element_id, c.id
         from case_file c join version v on v.id = c.version_id join node n on n.id = v.node_id
        where c.kolab_id = $1 and c.opened_at is not null
       union all
       select p.created_at, p.actor_id, 'position', n.name, v.seq, null, null, c.element_id, c.id
         from position p join case_file c on c.id = p.case_file_id join version v on v.id = c.version_id join node n on n.id = v.node_id
        where p.kolab_id = $1 and p.created_at is not null and p.actor_id is distinct from c.opened_by
       union all
       select r.ruled_at, r.actor_id, 'ruling', n.name, v.seq, null, null, coalesce(r.element_id, c.element_id), r.effect
         from ruling r left join case_file c on c.id = r.case_file_id
         join version v on v.id = coalesce(r.version_id, c.version_id) join node n on n.id = v.node_id
        where r.kolab_id = $1 and r.ruled_at is not null
     ) a order by at desc, kind, node, seq desc limit $2`, [here, limit])).rows);
  return rows.map((r): ActivityRow => {
    const at = iso(r.at), node = r.node as string, seq = r.seq as number;
    switch (r.kind) {
      case 'version': return { at, actor: r.actor as string, kind: 'version', node, seq, state: r.state as VersionState, note: r.note as string | null };
      case 'verdict': return { at, actor: r.actor as string, kind: 'verdict', node, seq, state: r.state as 'approved' | 'changes_requested' };
      case 'query': return { at, actor: r.actor as string | null, kind: 'query', node, seq, element: r.element as string | null, query_kind: r.extra as QueryKind };
      case 'case': return { at, actor: r.actor as string | null, kind: 'case', node, seq, element: r.element as string | null, case: r.extra as string };
      case 'position': return { at, actor: r.actor as string, kind: 'position', node, seq, element: r.element as string | null, case: r.extra as string };
      case 'ruling': return { at, actor: r.actor as string, kind: 'ruling', node, seq, element: r.element as string | null, effect: r.extra as string | null };
      default: return { at, actor: null, kind: 'mark', node, seq, element: r.element as string | null, reason: r.extra as MarkReason };
    }
  });
}

/**
 * A fingerprint of the session's kolab's versions: it changes whenever a version is written or
 * changes state. Commits signal no inbox of their own, so the web interface's event stream checks
 * this to tell pages a node moved on.
 */
export async function versionsRevision(kolab: Kolab, session: string): Promise<string> {
  const here = await kolab.sessionKolab(session);
  const r = await kolab.readAs(session, async (q) => (await q.query<{ n: number; c: number; r: number; d: number; x: number; at: Date | string | null }>(
    `select count(*)::int as n, count(*) filter (where state = 'committed')::int as c, count(*) filter (where state = 'in_review')::int as r,
            count(*) filter (where state = 'drafted')::int as d, count(*) filter (where state = 'rejected')::int as x, max(created_at) as at
       from version where kolab_id = $1`, [here])).rows[0]);
  return `${r.n}:${r.c}:${r.r}:${r.d}:${r.x}:${r.at ? iso(r.at) : ''}`;
}

const iso = (t: Date | string) => new Date(t).toISOString();
