/**
 * Read models for the web interface (W3.1): what a person reads in one place that the verbs give
 * piecemeal. Each runs as the session reads (Kolab.readAs: kj_agent, under row-level security),
 * and names the session's kolab explicitly too, so it reads nothing of another kolab (TEN12).
 * None of them writes.
 */
import type { QuoteSelector } from '@konjir/address';
import { formatAddress } from '@konjir/address';
import type { AcceptanceFinding, EvidenceKind, Kind, Layer, MarkReason, QueryKind, QueryState, ReviewRequestState, VersionState } from '@konjir/types';
import { markBecause, NEXT_STEP, type Kolab } from './kolab.js';
import { cursorFor, keyOf, pageOf, pageSize, scoped, type PageOpts } from './page.js';
import { acceptanceFinding } from './work.js';

/** A page of a read model (W2.21): its rows, and the cursor to the next page, or null on the last. */
export interface RowsPage<T> { items: T[]; next: string | null }

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

/** Which of a node's versions a page shows (W2.21). */
export type VersionsShown =
  /** Committed and in review, and the session's own drafts: its own kolab's node. */
  | 'shown'
  /** Committed only: another kolab's node, as a reader outside it sees it (D49). */
  | 'committed'
  /** In review only. */
  | 'in_review'
  /** The session's own drafts. */
  | 'own_drafts'
  /** The session's own versions folded onto a newer one: rejected, noted "folded into …". */
  | 'own_folded';

const VERSIONS_SHOWN: Record<VersionsShown, string> = {
  shown: `(v.state in ('committed', 'in_review') or (v.state = 'drafted' and v.actor_id = $3))`,
  committed: `v.state = 'committed'`,
  in_review: `v.state = 'in_review'`,
  own_drafts: `v.state = 'drafted' and v.actor_id = $3`,
  own_folded: `v.state = 'rejected' and v.actor_id = $3 and v.review_note like 'folded into %'`,
};

/**
 * A node's versions, newest first, read as the session reads (W2.21): those `which` names, in
 * kolab `inKolab` (the session's own by default), as `actor` sees them. With `seq`, only that
 * version; with `before`, only those older than it; at most `limit`.
 */
export async function nodeVersions(kolab: Kolab, session: string, nodeId: string,
  o: { which: VersionsShown; actor: string; inKolab?: string; seq?: number; before?: number; limit?: number }): Promise<VersionHistoryRow[]> {
  const here = o.inKolab ?? await kolab.sessionKolab(session);
  return kolab.readAs(session, async (q) => (await q.query<VersionHistoryRow & { at: Date | string }>(
    `select v.seq, v.state, v.actor_id as actor, v.active_role as role, v.created_at as at,
            ${o.which === 'committed' && o.inKolab ? 'null::text' : 'v.review_note'} as note, b.seq as base_seq
       from version v left join version b on b.id = v.base_version_id
      where ($3::text is null or true) and v.node_id = $1 and v.kolab_id = $2 and ${VERSIONS_SHOWN[o.which]}
        and ($4::int is null or v.seq = $4) and ($5::int is null or v.seq < $5)
      order by v.seq desc limit $6`,
    [nodeId, here, o.actor, o.seq ?? null, o.before ?? null, o.limit ?? null])).rows.map((r) => ({ ...r, at: iso(r.at) })));
}

/** One page of a node's versions, newest first (W2.21): nodeVersions', by a cursor on seq. */
export async function nodeVersionsPage(kolab: Kolab, session: string, nodeId: string,
  o: { which: 'shown' | 'committed'; actor: string; inKolab?: string }, page: PageOpts = {}): Promise<RowsPage<VersionHistoryRow>> {
  const size = pageSize(page.limit);
  const list = scoped('web:versions', { nodeId, ...o });
  const [before] = (keyOf(list, page.cursor, ['int']) ?? [null]) as [number | null];
  const rows = await nodeVersions(kolab, session, nodeId, { ...o, before: before ?? undefined, limit: size + 1 });
  const { rows: items, next } = pageOf(rows, size, list, (r) => [r.seq]);
  return { items, next };
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
export async function liveLinks(kolab: Kolab, session: string, only: { node?: string; sources?: string[] } = {}): Promise<LinkRow[]> {
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
        and ($2::text is null or sn.name = $2 or (tn.name = $2 and tn.kolab_id = $1))
        and ($3::text[] is null or sn.name = any($3::text[]))
      order by sn.name, e.source_element_id nulls first, tn.name, e.target_element_id nulls first, e.id`, [here, only.node ?? null, only.sources ?? null])).rows);
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
export async function markDetails(kolab: Kolab, session: string, only: { node?: string } = {}): Promise<MarkDetailRow[]> {
  return (await markRows(kolab, session, only)).items;
}

/** One page of the open marks of the session's kolab, oldest first (W2.21). */
export async function markDetailsPage(kolab: Kolab, session: string, page: PageOpts = {}): Promise<RowsPage<MarkDetailRow>> {
  return markRows(kolab, session, {}, page);
}

async function markRows(kolab: Kolab, session: string, only: { node?: string }, page?: PageOpts): Promise<RowsPage<MarkDetailRow>> {
  const here = await kolab.sessionKolab(session);
  const size = page ? pageSize(page.limit) : undefined;
  const list = scoped('web:marks', { here, node: only.node });
  const after = page ? keyOf(list, page.cursor, ['ts', 'text']) as [string, string] | undefined : undefined;
  const rows = await kolab.readAs(session, async (q) => (await q.query<Omit<MarkDetailRow, 'because' | 'next'> & { at: Date | string; at_key: string; note: string | null; edge_id: string | null;
    target_selector: QuoteSelector | null; trig_node: string | null; trig_kolab: string | null; trig_seq: number | null; cause_count: number }>(
    `select i.id, i.reason, n.name as node, v.seq, v.layer, i.element_id as element, i.created_at as at,
            -- The link is this kolab's, but what it names in a kolab the session can't read is told only with its node (W7.4, LNK8).
            etn.name as target_node, case when etn.id is null then null else e.target_element_id end as target_element, etv.seq as target_pinned,
            (select max(l.seq) from version l where l.node_id = etv.node_id and l.state = 'committed') as target_now,
            (select x.text from element x where x.version_id = e.target_version_id and x.element_id = e.target_element_id) as target_before,
            (select x.text from element x where x.element_id = e.target_element_id and x.version_id =
               (select l.id from version l where l.node_id = etv.node_id and l.state = 'committed' order by l.seq desc limit 1)) as target_after,
            d.element_id as override_element, d.text as override_text,
            (select x.text from element x where x.version_id = d.base_version_id and x.element_id = d.element_id) as parent_before,
            (select x.text from element x where x.version_id = v.parent_version_id and x.element_id = d.element_id) as parent_now,
            (select qq.id from query qq where qq.invalidation_id = i.id and qq.state = 'open' order by qq.id limit 1) as question,
            i.note, i.edge_id, case when etn.id is null then null else e.target_selector end as target_selector, tn.name as trig_node, tn.kolab_id as trig_kolab, tv.seq as trig_seq,
            (select count(*)::int from invalidation_cause c where c.mark_id = i.id) as cause_count, i.created_at::text as at_key
       from invalidation i
       left join version tv on tv.id = i.triggered_by left join node tn on tn.id = tv.node_id
       join version v on v.id = i.version_id join node n on n.id = v.node_id
       left join edge e on e.id = i.edge_id
       left join version etv on etv.id = e.target_version_id left join node etn on etn.id = etv.node_id
       left join delta d on d.id = i.delta_id
      where i.state = 'open' and i.kolab_id = $1 and ($2::text is null or v.node_id = $2)
        and ($3::text is null or (i.created_at, i.id) > ($3::timestamptz, $4::text))
      order by i.created_at, i.id limit $5`, [here, only.node ?? null, after?.[0] ?? null, after?.[1] ?? null, size === undefined ? null : size + 1])).rows);
  const { rows: shown, next } = size === undefined ? { rows, next: null } : pageOf(rows, size, list, (r) => [r.at_key, r.id]);
  return { next, items: shown.map(({ note, edge_id, target_selector, trig_node, trig_kolab, trig_seq, cause_count, at_key: _, ...r }) => {
    // What triggered it, in the short form of this kolab, named only if the session reads it: a
    // version in another kolab it no longer holds Read on (access_lost) reads as no row here.
    const trig = (linked: boolean) => trig_node ? formatAddress({
      kolab: trig_kolab ?? undefined, node: trig_node,
      ...(linked ? { element: r.target_element ?? undefined, selector: target_selector ?? undefined } : {}),
    }, { from: here }) : undefined;
    return {
      ...r, at: iso(r.at),
      // The same words as konjir_list_stale and the inbox (describeMarks), read under row-level security.
      because: markBecause({ reason: r.reason, note, edge_id, trig_seq, cause_count }, trig),
      next: NEXT_STEP[r.reason] ?? '',
    };
  }) };
}

/** A node as a listing gives it; `parent` is the node it names as its parent (D78): a binding's spec, a plan's binding (a plan made before D104). */
export interface NodeRowView { name: string; kind: Kind; layer: Layer; title: string; parent: string | null; latest: number | null; drafts: number; in_review: number }

/** The session's kolab's nodes, with their latest committed version and how many drafts and versions in review each has. */
export async function kolabNodes(kolab: Kolab, session: string, only: { name?: string; committed?: boolean } = {}): Promise<NodeRowView[]> {
  return (await nodeRows(kolab, session, only)).items;
}

/** One page of the session's kolab's nodes, by kind then name (W2.21); with `committed`, only those with a committed version. */
export async function kolabNodesPage(kolab: Kolab, session: string, page: PageOpts = {}, only: { committed?: boolean } = {}): Promise<RowsPage<NodeRowView>> {
  return nodeRows(kolab, session, only, page);
}

async function nodeRows(kolab: Kolab, session: string, only: { name?: string; committed?: boolean }, page?: PageOpts): Promise<RowsPage<NodeRowView>> {
  const here = await kolab.sessionKolab(session);
  const size = page ? pageSize(page.limit) : undefined;
  const list = scoped('web:nodes', { here, ...only });
  const after = page ? keyOf(list, page.cursor, ['text', 'text']) as [string, string] | undefined : undefined;
  const rows = await kolab.readAs(session, async (q) => (await q.query<NodeRowView>(
    `select * from (
       select n.name, n.kind, n.layer, n.title, (select p.name from node p where p.id = n.parent_node_id) as parent,
              (select max(seq) from version v where v.node_id = n.id and v.state = 'committed') as latest,
              (select count(*)::int from version v where v.node_id = n.id and v.state = 'drafted') as drafts,
              (select count(*)::int from version v where v.node_id = n.id and v.state = 'in_review') as in_review
         from node n where n.kolab_id = $1 and ($2::text is null or n.name = $2)
          and ($3::text is null or (n.kind, n.name) > ($3, $4::text))
        order by n.kind, n.name) x
      where not $6 or x.latest is not null order by x.kind, x.name limit $5`,
    [here, only.name ?? null, after?.[0] ?? null, after?.[1] ?? null, size === undefined ? null : size + 1, !!only.committed])).rows);
  return size === undefined ? { items: rows, next: null } : (({ rows: items, next }) => ({ items, next }))(pageOf(rows, size, list, (r) => [r.kind, r.name]));
}

/**
 * How much waits in the session's kolab, counted in the database (W2.21): open marks on `layer`,
 * open questions and notes (all, and those `layer` owns), and review requests for `reviewer` on it.
 * Review requests count only those whose reviewer can review now (D65), as openReviewRequests.
 */
export async function waitingCounts(kolab: Kolab, session: string, layer: Layer, reviewer: string) {
  const here = await kolab.sessionKolab(session);
  const counts = await kolab.readAs(session, async (q) => (await q.query<{ stale: number; waiting: number; open: number }>(
    `select (select count(*)::int from invalidation i join version v on v.id = i.version_id
              where i.kolab_id = $1 and i.state = 'open' and v.layer = $2) as stale,
            (select count(*)::int from query q join version v on v.id = q.version_id
              where q.kolab_id = $1 and q.state = 'open' and v.layer = $2) as waiting,
            (select count(*)::int from query q where q.kolab_id = $1 and q.state = 'open') as open`, [here, layer])).rows[0]);
  // Versions in review on `layer`, and, on the technical layer, work packages In review (VER17, W5.8).
  const requests = await kolab.readAs(session, async (q) => (await q.query<{ reviewer: string; layer: Layer }>(
    `select r.reviewer_id as reviewer, ${REQUEST_LAYER} as layer from review_request r join version v on v.id = r.version_id
      where r.state = 'open' and v.state = 'in_review' and r.kolab_id = $1 and r.reviewer_id = $2 and ${REQUEST_LAYER} = $3
     union all
     select r.reviewer_id, 'technical' from review_request r join work_package w on w.binding_node_id = r.binding_node_id and w.element_id = r.element_id
      where r.state = 'open' and w.state = 'in_review' and r.kolab_id = $1 and r.reviewer_id = $2 and $3 = 'technical'`, [here, reviewer, layer])).rows);
  return { ...counts, reviews: (await kolab.shownRequests(here, requests)).length };
}

/**
 * Another kolab's nodes that have a committed version, each at its latest, as a reader outside it
 * sees them (D49): a node with only drafts, versions in review or rejected versions is left out, as
 * a version that doesn't exist is. One read-only transaction as kj_agent, which checks Read for that
 * kolab alone first (kj_session_readable_kolabs): undefined if the session can't read it now,
 * whether or not it exists.
 */
export async function readableNodes(kolab: Kolab, session: string, inKolab: string, page: PageOpts = {}): Promise<RowsPage<NodeRowView> | undefined> {
  const size = pageSize(page.limit);
  const list = scoped('web:foreign-nodes', { inKolab });
  const after = keyOf(list, page.cursor, ['text', 'text']) as [string, string] | undefined;
  return kolab.readAs(session, async (q) => {
    const may = (await q.query<{ ok: boolean }>(`select $1 = any ((select kj_session_readable_kolabs())::text[]) as ok`, [inKolab])).rows[0]?.ok;
    if (!may) return undefined;
    const rows = (await q.query<NodeRowView>(
      `select n.name, n.kind, n.layer, n.title, (select p.name from node p where p.id = n.parent_node_id) as parent, l.latest, 0 as drafts, 0 as in_review
         from node n cross join lateral (select max(v.seq) as latest from version v where v.node_id = n.id and v.state = 'committed') l
        where n.kolab_id = $1 and l.latest is not null and ($2::text is null or (n.kind, n.name) > ($2, $3::text))
        order by n.kind, n.name limit $4`, [inKolab, after?.[0] ?? null, after?.[1] ?? null, size + 1])).rows;
    const { rows: items, next } = pageOf(rows, size, list, (r) => [r.kind, r.name]);
    return { items, next };
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

/**
 * An open review request on a version in review: its node and version, the layer whose review it
 * asks for, and with `product`, a binding version's product review (VER13), the functional layer's.
 */
export interface ReviewRequestRow { kind: 'version'; node: string; seq: number; layer: Layer; author: string; reviewer: string; at: string; product?: true }

/** The layer a version's review request asks a review of: its own, or the functional layer's for a binding's product review (VER13). */
const REQUEST_LAYER = `(case when r.product then 'functional' else v.layer end)`;

/**
 * An open review request on a work package In review (VER17, PLN16): its binding and id, its
 * assignee as `author`, and its latest submission, when and with what note. Work is the technical
 * layer's.
 */
export interface WorkReviewRequestRow {
  kind: 'work'; binding: string; element: string; layer: 'technical'; author: string; reviewer: string; at: string;
  submitted_at: string | null; submitted_note: string | null;
}

/**
 * The open review requests in the session's kolab, on versions still in review, oldest first: only
 * those whose reviewer can review now, in the role it works in (D65, Kolab.shownRequests).
 */
export async function openReviewRequests(kolab: Kolab, session: string, only: { node?: string } = {}): Promise<ReviewRequestRow[]> {
  return (await requestRows(kolab, session, only)).items.filter((r): r is ReviewRequestRow => r.kind === 'version');
}

/**
 * One page of the open review requests for `reviewer` on `layer` in the session's kolab, oldest first
 * (W2.21): on versions and, on the technical layer, on work packages In review, in one list and one
 * order, as one inbox holds them (VER17, W5.8). A request whose reviewer can't review now is left
 * out after the read, so a page may hold fewer than its size; `next` still says whether more follow.
 */
export async function reviewRequestsPage(kolab: Kolab, session: string, only: { reviewer: string; layer: Layer }, page: PageOpts = {}): Promise<RowsPage<ReviewRequestRow | WorkReviewRequestRow>> {
  return requestRows(kolab, session, { ...only, work: true }, page);
}

async function requestRows(kolab: Kolab, session: string, only: { node?: string; reviewer?: string; layer?: Layer; work?: boolean }, page?: PageOpts): Promise<RowsPage<ReviewRequestRow | WorkReviewRequestRow>> {
  const here = await kolab.sessionKolab(session);
  const size = page ? pageSize(page.limit) : undefined;
  const { work, ...filter } = only;
  const list = scoped(work ? 'web:reviews-all' : 'web:reviews', { here, ...filter });
  const after = page ? keyOf(list, page.cursor, ['ts', 'text', 'text']) as [string, string, string] | undefined : undefined;
  const rows = await kolab.readAs(session, async (q) => (await q.query<{
    kind: 'version' | 'work'; node: string; seq: number | null; element: string | null; layer: Layer; author: string; reviewer: string;
    at: Date | string; at_key: string; id: string; submitted_at: Date | string | null; submitted_note: string | null; product: boolean;
  }>(
    // A work package's requests only with `work`, and never for one node's versions; its latest
    // submission is the newest event that put it In review.
    `select * from (
       select 'version' as kind, n.name as node, v.seq, null::text as element, ${REQUEST_LAYER} as layer, v.actor_id as author, r.reviewer_id as reviewer,
              r.created_at as at, r.created_at::text as at_key, r.id, null::timestamptz as submitted_at, null::text as submitted_note, r.product
         from review_request r join version v on v.id = r.version_id join node n on n.id = v.node_id
        where r.state = 'open' and v.state = 'in_review' and r.kolab_id = $1
          and ($2::text is null or n.name = $2) and ($3::text is null or r.reviewer_id = $3) and ($4::text is null or ${REQUEST_LAYER} = $4)
       union all
       select 'work', n.name, null::int, w.element_id, 'technical', w.assignee_id, r.reviewer_id,
              r.created_at, r.created_at::text, r.id, s.at, s.note, false
         from review_request r join work_package w on w.binding_node_id = r.binding_node_id and w.element_id = r.element_id
         join node n on n.id = w.binding_node_id
         left join lateral (select e.at, e.note from work_event e where e.binding_node_id = w.binding_node_id and e.element_id = w.element_id
                             and e.to_state = 'in_review' order by e.at desc, e.id desc limit 1) s on true
        where $9::boolean and r.state = 'open' and w.state = 'in_review' and r.kolab_id = $1
          and $2::text is null and ($3::text is null or r.reviewer_id = $3) and ($4::text is null or $4 = 'technical')
     ) x
      where ($5::text is null or (x.at, x.reviewer, x.id) > ($5::timestamptz, $6::text, $7::text))
      order by x.at, x.reviewer, x.id limit $8`,
    [here, filter.node ?? null, filter.reviewer ?? null, filter.layer ?? null, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null,
      size === undefined ? null : size + 1, !!work])).rows);
  const { rows: picked, next } = size === undefined ? { rows, next: null } : pageOf(rows, size, list, (r) => [r.at_key, r.reviewer, r.id]);
  const shown = await kolab.shownRequests(here, picked.map((r): ReviewRequestRow | WorkReviewRequestRow => (r.kind === 'work'
    ? { kind: 'work', binding: r.node, element: r.element!, layer: 'technical', author: r.author, reviewer: r.reviewer, at: iso(r.at),
      submitted_at: r.submitted_at === null ? null : iso(r.submitted_at), submitted_note: r.submitted_note }
    : { kind: 'version', node: r.node, seq: r.seq!, layer: r.layer, author: r.author, reviewer: r.reviewer, at: iso(r.at), ...(r.product ? { product: true as const } : {}) })));
  return { items: shown, next };
}

/** At most this many items of a package's evidence, of each round, show in the review list; the rest are counted. */
export const REVIEW_EVIDENCE_SHOWN = 20;

/** An item of a work package's evidence, as the review list shows it: no files (W5.8). */
export interface ReviewEvidenceRow {
  id: string; kind: EvidenceKind; sha?: string; pr?: number; url?: string; title?: string; recorded_by: string; at: string;
  /** A commit's or pull request's repository and whether it is confirmed; none for a test run, or for one recorded before repositories (W5.2a). */
  repository?: string | null; confirmed?: boolean; before_repositories?: true;
}

/**
 * What a reviewer of a work package checks, as the review list shows it (W5.8; PLN16): its text and
 * done-when in its binding's latest committed version; the repository it is done in, and whether it is
 * confirmed (D98); and its evidence, oldest first, split into the current round (recorded since it
 * last went In progress: what this submission brought) and earlier rounds, each capped at
 * REVIEW_EVIDENCE_SHOWN with the rest counted. No files.
 */
export interface WorkReviewDetailRow {
  binding: string; element: string; text: string | null; done_when: string | null;
  repository: { url: string; confirmed: boolean } | null;
  /** The open marks on it, which put it at risk (PLN10). */
  open_marks: number;
  evidence: ReviewEvidenceRow[]; evidence_more: number; earlier: ReviewEvidenceRow[]; earlier_count: number;
  /** The failed acceptance checks among its evidence since it was last To do (REV9), as konjir_list_reviews gives them. */
  findings: AcceptanceFinding[];
}

/**
 * The review details of `packages` (by binding name and element) in the session's kolab, read in
 * one transaction as the session reads (kj_agent, row-level security): two queries for them all,
 * whatever their number. Read only: it renews no lease. A package not found is left out.
 */
export async function workReviewDetails(kolab: Kolab, session: string, packages: { binding: string; element: string }[]): Promise<Map<string, WorkReviewDetailRow>> {
  const out = new Map<string, WorkReviewDetailRow>();
  if (!packages.length) return out;
  const here = await kolab.sessionKolab(session);
  const bindings = packages.map((p) => p.binding), elements = packages.map((p) => p.element);
  await kolab.readAs(session, async (q) => {
    // Each package, with its element in its binding's latest committed version, and its binding's
    // implementation, or the repository its repo field names, live.
    const rows = (await q.query<{ binding: string; element: string; text: string | null; done_when: string | null; repo_url: string | null; repo_confirmed: boolean | null; open_marks: number }>(
      `select n.name as binding, w.element_id as element, el.text, el.work->>'done_when' as done_when, rp.url as repo_url, rp.confirmed as repo_confirmed,
              (select count(*)::int from invalidation i join version x on x.id = i.version_id
                where x.node_id = n.id and x.state = 'committed' and i.element_id = w.element_id and i.state = 'open' and i.delta_id is null) as open_marks
         from unnest($2::text[], $3::text[]) as p(binding, element)
         join node n on n.kolab_id = $1 and n.name = p.binding
         join work_package w on w.binding_node_id = n.id and w.element_id = p.element
         left join lateral (select e.text, e.work from element e join version v on v.id = e.version_id
                             where v.node_id = n.id and v.state = 'committed' and e.element_id = w.element_id order by v.seq desc limit 1) el on true
         left join lateral (select r.url, r.confirmed_at is not null as confirmed from repository r
                             where r.kolab_id = $1 and r.archived_at is null
                               and case when el.work->>'repo' is not null then lower(r.url) = lower(regexp_replace(regexp_replace(el.work->>'repo', '/+$', ''), '\\.git$', ''))
                                        else r.binding_node_id = n.id end
                             order by r.registered_at limit 1) rp on true`, [here, bindings, elements])).rows;
    if (!rows.length) return;
    // Their evidence, the current round's and the earlier rounds' each numbered and counted, so at
    // most REVIEW_EVIDENCE_SHOWN of each come back. A round starts when the package last went In
    // progress from another state: pulled, or returned by a request for changes.
    const ev = (await q.query<{ binding: string; element: string; id: string; kind: EvidenceKind; ref: string | null; url: string | null; title: string | null;
      recorded_by: string; at: Date | string; repository_url: string | null; confirmed: boolean; before_repositories: boolean; current: boolean; n: number }>(
      `select * from (
         select n.name as binding, e.element_id as element, e.id, e.kind, e.ref, e.url, e.title, e.recorded_by, e.at,
                er.url as repository_url, er.confirmed_at is not null as confirmed, e.before_repositories,
                (rs.at is null or (ev.at, ev.id) > (rs.at, rs.id)) as current,
                count(*) over (partition by e.binding_node_id, e.element_id, (rs.at is null or (ev.at, ev.id) > (rs.at, rs.id)))::int as n,
                row_number() over (partition by e.binding_node_id, e.element_id, (rs.at is null or (ev.at, ev.id) > (rs.at, rs.id)) order by e.at, e.id) as i
           from unnest($2::text[], $3::text[]) as p(binding, element)
           join node n on n.kolab_id = $1 and n.name = p.binding
           join evidence e on e.binding_node_id = n.id and e.element_id = p.element
           join work_event ev on ev.id = e.event_id
           left join repository er on er.id = e.repository_id
           left join lateral (select t.at, t.id from work_event t where t.binding_node_id = e.binding_node_id and t.element_id = e.element_id
                               and t.to_state = 'in_progress' and t.from_state is distinct from 'in_progress' order by t.at desc, t.id desc limit 1) rs on true
       ) x where x.i <= $4 order by x.at, x.id`, [here, bindings, elements, REVIEW_EVIDENCE_SHOWN])).rows;
    // Kolab's own findings on each (REV9): every failed acceptance check it has recorded, in any round.
    const failed = (await q.query<{ binding: string; element: string; id: string; url: string | null; title: string | null; recorded_by: string; at: Date | string;
      checks: { address: string; version: number; passed: boolean }[] }>(
      `select n.name as binding, e.element_id as element, e.id, e.url, e.title, e.recorded_by, e.at, e.checks
         from unnest($2::text[], $3::text[]) as p(binding, element)
         join node n on n.kolab_id = $1 and n.name = p.binding
         join evidence e on e.binding_node_id = n.id and e.element_id = p.element
        where e.checks is not null and exists (select 1 from jsonb_array_elements(e.checks) c where c->'passed' = 'false'::jsonb)
        order by e.at, e.id`, [here, bindings, elements])).rows;
    for (const r of rows) {
      const mine = ev.filter((e) => e.binding === r.binding && e.element === r.element);
      const view = (e: typeof ev[number]): ReviewEvidenceRow => ({
        id: e.id, kind: e.kind,
        ...(e.kind === 'commit' && e.ref ? { sha: e.ref } : {}), ...(e.kind === 'pull_request' && e.ref ? { pr: Number(e.ref) } : {}),
        ...(e.url ? { url: e.url } : {}), ...(e.title ? { title: e.title } : {}), recorded_by: e.recorded_by, at: iso(e.at),
        ...(e.kind === 'test_run' ? {} : { repository: e.repository_url, confirmed: !!e.confirmed, ...(e.before_repositories ? { before_repositories: true as const } : {}) }),
      });
      const current = mine.filter((e) => e.current), earlier = mine.filter((e) => !e.current);
      // The repository this submission's evidence names, as the approval confirms it (D98), or else the package's own.
      const named = current.find((e) => e.kind !== 'test_run' && e.repository_url);
      out.set(`${r.binding}#${r.element}`, {
        binding: r.binding, element: r.element, text: r.text, done_when: r.done_when,
        repository: named ? { url: named.repository_url!, confirmed: named.confirmed } : r.repo_url ? { url: r.repo_url, confirmed: !!r.repo_confirmed } : null,
        open_marks: r.open_marks, evidence: current.map(view), evidence_more: Math.max(0, (current[0]?.n ?? 0) - current.length),
        earlier: earlier.map(view), earlier_count: earlier[0]?.n ?? 0,
        findings: failed.filter((e) => e.binding === r.binding && e.element === r.element).flatMap((e) => e.checks.filter((c) => !c.passed).map((c) => acceptanceFinding(e, c))),
      });
    }
  });
  return out;
}

export interface SubmissionRow {
  node: string; seq: number; state: VersionState; note: string | null;
  verdicts: { reviewer: string; state: ReviewRequestState; note: string | null; product?: true }[];
}

/**
 * What `actor` submitted for review in the session's kolab, newest first, with the verdicts. An
 * open request shows only while its reviewer can review now (D65), as openReviewRequests.
 */
export async function submissionsOf(kolab: Kolab, session: string, actor: string, page: PageOpts = {}): Promise<RowsPage<SubmissionRow>> {
  const here = await kolab.sessionKolab(session);
  const size = pageSize(page.limit);
  const list = scoped('web:submissions', { here, actor });
  const after = keyOf(list, page.cursor, ['ts', 'text']) as [string, string] | undefined;
  let next: string | null = null;
  const rows = await kolab.readAs(session, async (q) => {
    const read = (await q.query<{ id: string; node: string; seq: number; state: VersionState; note: string | null; layer: Layer; at_key: string }>(
      `select v.id, n.name as node, v.seq, v.state, v.review_note as note, v.layer, v.created_at::text as at_key
         from version v join node n on n.id = v.node_id
        where v.actor_id = $1 and v.kolab_id = $2 and exists (select 1 from review_request r where r.version_id = v.id)
          and ($4::text is null or (v.created_at, v.id) < ($4::timestamptz, $5::text))
        order by v.created_at desc, v.id desc limit $3`, [actor, here, size + 1, after?.[0] ?? null, after?.[1] ?? null])).rows;
    const { rows: versions, next: more } = pageOf(read, size, list, (r) => [r.at_key, r.id]);
    next = more;
    const out: (SubmissionRow & { layer: Layer })[] = [];
    for (const { id, at_key: _, ...v } of versions) {
      out.push({ ...v, verdicts: (await q.query<{ reviewer: string; state: ReviewRequestState; note: string | null; product: boolean }>(
        `select reviewer_id as reviewer, state, note, product from review_request where version_id = $1 order by created_at, reviewer_id, id`, [id])).rows
        .map(({ product, ...x }) => ({ ...x, ...(product ? { product: true as const } : {}) })) });
    }
    return out;
  });
  const out: SubmissionRow[] = [];
  for (const { layer, ...v } of rows) {
    // As Kolab.submissions (WITHDRAWN_SHOWN): an open request while its reviewer can review now
    // (D65); a withdrawn one only for a person, whom every request is shown to (W5.7).
    const open = v.verdicts.filter((x) => x.state === 'open').map((x) => ({ reviewer: x.reviewer, layer: x.product ? 'functional' as const : layer, product: !!x.product }));
    const shown = new Set((await kolab.shownRequests(here, open)).map((x) => `${x.reviewer}:${x.product}`));
    const persons = await kolab.personsAmong(v.verdicts.filter((x) => x.state === 'withdrawn').map((x) => x.reviewer));
    out.push({ ...v, verdicts: v.verdicts.filter((x) => (x.state === 'open' ? shown.has(`${x.reviewer}:${!!x.product}`) : x.state === 'withdrawn' ? persons.has(x.reviewer) : true)) });
  }
  return { items: out, next };
}

export interface AgentVerdictRow {
  node: string; seq: number; reviewer: string; state: 'approved' | 'changes_requested'; note: string | null; at: string; product?: true;
}

/**
 * The verdicts `person`'s agents gave on versions in the session's kolab, newest first: what was
 * reviewed on the person's behalf, which their own review list never shows.
 */
export async function agentVerdictsPage(kolab: Kolab, session: string, person: string, page: PageOpts = {}): Promise<RowsPage<AgentVerdictRow>> {
  const here = await kolab.sessionKolab(session);
  const size = pageSize(page.limit);
  const list = scoped('web:agent-verdicts', { here, person });
  const after = keyOf(list, page.cursor, ['ts', 'text']) as [string, string] | undefined;
  const agents = (await kolab.db.query<{ id: string }>(`select id from actor where kind = 'agent' and owner_id = $1`, [person])).rows.map((r) => r.id);
  if (!agents.length) return { items: [], next: null };
  const read = await kolab.readAs(session, async (q) => (await q.query<{ id: string; node: string; seq: number; reviewer: string; state: 'approved' | 'changes_requested'; note: string | null; at: Date | string; at_key: string; product: boolean }>(
    `select r.id, n.name as node, v.seq, r.reviewer_id as reviewer, r.state, r.note, r.decided_at as at, r.decided_at::text as at_key, r.product
       from review_request r join version v on v.id = r.version_id join node n on n.id = v.node_id
      where r.kolab_id = $1 and r.reviewer_id = any($2::text[]) and r.decided_at is not null and r.state in ('approved', 'changes_requested')
        and ($4::text is null or (r.decided_at, r.id) < ($4::timestamptz, $5::text))
      order by r.decided_at desc, r.id desc limit $3`, [here, agents, size + 1, after?.[0] ?? null, after?.[1] ?? null])).rows);
  const { rows, next } = pageOf(read, size, list, (r) => [r.at_key, r.id]);
  return {
    items: rows.map(({ id: _, at_key: __, product, at, ...r }) => ({ ...r, at: iso(at), ...(product ? { product: true as const } : {}) })),
    next,
  };
}

export interface QueryDetailRow {
  id: string; kind: QueryKind; state: QueryState; node: string; seq: number; layer: Layer;
  element: string | null; selector: QuoteSelector | null; question: string; raised_by: string | null; at: string;
  answer: string | null; answered_by: string | null;
  /** What the answer cites (AUT4), each address in the short form where it is in the reader's own kolab; null for none. */
  cites: string[] | null;
  from_node: string | null; from_seq: number | null; from_element: string | null;
  mark: string | null; mark_reason: MarkReason | null;
  /** When an answer job handed it to a person (JOB6, W7.9), while it is open; null otherwise, and outside its kolab. */
  handed_off_at: string | null;
}

/**
 * Questions and notes in the session's kolab, newest first, on one node if `nodeId` is given. With
 * `inKolab`, another kolab's, which a reader outside it sees only on its committed versions (D49).
 * Questions a mark raised (a boundary, a ruling that changes the intent) are left out there, and
 * no question names a mark or an asking element: that kolab's marks and rulings stay private. The
 * caller has checked the session may read it.
 */
export async function queryDetails(kolab: Kolab, session: string, nodeId?: string, inKolab?: string): Promise<QueryDetailRow[]> {
  return (await queryRows(kolab, session, { nodeId, inKolab })).items;
}

/**
 * One page of the questions and notes in the session's kolab, newest first (W2.21): with `open`,
 * only those still open; with `open: false`, only those settled (answered or withdrawn).
 */
export async function queryDetailsPage(kolab: Kolab, session: string, only: { open?: boolean }, page: PageOpts = {}): Promise<RowsPage<QueryDetailRow>> {
  return queryRows(kolab, session, only, page);
}

/**
 * A node's questions and notes as its page shows them (W2.21): the newest `per` on each element,
 * and on the node as a whole (key ''), read in SQL, each with `next`, the cursor to the older ones
 * (nodeQueriesPage), or null when that is all. With `inKolab`, another kolab's node, as
 * queryDetails reads it.
 */
export async function nodeThreads(kolab: Kolab, session: string, nodeId: string, per: number, inKolab?: string): Promise<Map<string, RowsPage<QueryDetailRow>>> {
  const out = new Map<string, RowsPage<QueryDetailRow>>();
  for (const r of (await queryRows(kolab, session, { nodeId, inKolab, per })).items as (QueryDetailRow & { cursor?: string })[]) {
    const key = r.element ?? '';
    const t = out.get(key) ?? out.set(key, { items: [], next: null }).get(key)!;
    const { cursor, ...row } = r;
    t.items.push(row);
    if (cursor) t.next = cursor;
  }
  return out;
}

/**
 * One page of the questions and notes on one element of a node (null: on the node as a whole),
 * newest first, after a cursor nodeThreads or this gave (W2.21).
 */
export async function nodeQueriesPage(kolab: Kolab, session: string, nodeId: string, element: string | null, page: PageOpts, inKolab?: string): Promise<RowsPage<QueryDetailRow>> {
  return queryRows(kolab, session, { nodeId, inKolab, element }, page);
}

async function queryRows(kolab: Kolab, session: string, only: { nodeId?: string; inKolab?: string; open?: boolean; element?: string | null; per?: number }, page?: PageOpts): Promise<RowsPage<QueryDetailRow>> {
  const { nodeId, inKolab } = only;
  const own = await kolab.sessionKolab(session);
  const here = inKolab ?? own;
  const outside = here !== own;
  const size = page ? pageSize(page.limit) : undefined;
  const list = scoped('web:queries', { here, nodeId, open: only.open, element: only.element === undefined ? undefined : only.element ?? '' });
  const after = page ? keyOf(list, page.cursor, ['ts', 'text']) as [string, string] | undefined : undefined;
  const rows = await kolab.readAs(session, async (q) => (await q.query<QueryDetailRow & { at: Date | string; at_key: string; rn: number; total: number }>(
    `select * from (
     select q.id, q.kind, q.state, n.name as node, v.seq, v.layer, q.element_id as element, q.selector, q.question,
            q.raised_by, q.created_at as at, q.answer, q.answered_by, q.answer_cites as cites,
            fn.name as from_node, fv.seq as from_seq, q.from_element_id as from_element,
            q.invalidation_id as mark, i.reason as mark_reason, q.created_at::text as at_key,
            case when q.state = 'open' then q.handed_off_at end as handed_off_at,
            ${only.per === undefined ? 'null::int as rn, null::int as total' : `row_number() over (partition by q.element_id order by q.created_at desc, q.id desc)::int as rn,
            count(*) over (partition by q.element_id)::int as total`}
       from query q
       join version v on v.id = q.version_id join node n on n.id = v.node_id
       left join version fv on fv.id = q.from_version_id left join node fn on fn.id = fv.node_id
       left join invalidation i on i.id = q.invalidation_id
      where q.kolab_id = $1 and ($2::text is null or v.node_id = $2) and (not $3 or (v.state = 'committed' and q.invalidation_id is null
                    and (q.asked_version_id is null or exists (select 1 from version a where a.id = q.asked_version_id and a.state = 'committed'))))
        and ($4::boolean is null or (q.state = 'open') = $4)
        and ($5::text is null or (q.created_at, q.id) < ($5::timestamptz, $6::text))
        and ($8::boolean is null or ($8 and q.element_id is null) or q.element_id = $9)
     ) t where ($10::int is null or t.rn <= $10)
      order by t.at desc, t.id desc limit $7`,
    [here, nodeId ?? null, outside, only.open ?? null, after?.[0] ?? null, after?.[1] ?? null, size === undefined ? null : size + 1,
      only.element === undefined ? null : only.element === null, only.element ?? null, only.per ?? null])).rows);
  const { rows: shown, next } = size === undefined ? { rows, next: null } : pageOf(rows, size, list, (r) => [r.at_key, r.id]);
  return { next, items: shown.map(({ at_key, rn, total, ...r }) => ({
    ...r, at: iso(r.at), handed_off_at: outside || !r.handed_off_at ? null : iso(r.handed_off_at),
    ...(outside ? { mark: null, mark_reason: null, from_node: null, from_seq: null, from_element: null } : {}),
    // Cites are stored in the full form (Kolab.answerQuery); in the reader's own kolab, the short one.
    cites: r.cites?.map((c) => (c.startsWith(`kj:${own}/`) ? `kj:${c.slice(own.length + 4)}` : c)) ?? null,
    // The last shown of an element's newest `per`, when it has more: the cursor to the rest.
    ...(only.per !== undefined && rn === only.per && total > rn ? { cursor: cursorFor(scoped('web:queries', { here, nodeId, element: r.element ?? '' }), [at_key, r.id]) } : {}),
  })) };
}

export type ActivityRow =
  | { at: string; actor: string; kind: 'node'; node: string; title: string }
  | { at: string; actor: string; kind: 'version'; node: string; seq: number; state: VersionState; note: string | null }
  | { at: string; actor: string; kind: 'verdict'; node: string; seq: number; state: 'approved' | 'changes_requested' }
  | { at: string; actor: string | null; kind: 'query'; node: string; seq: number; element: string | null; query_kind: QueryKind }
  | { at: string; actor: null; kind: 'mark'; node: string; seq: number; element: string | null; reason: MarkReason }
  | { at: string; actor: string | null; kind: 'case'; node: string; seq: number; element: string | null; case: string }
  | { at: string; actor: string; kind: 'position'; node: string; seq: number; element: string | null; case: string }
  | { at: string; actor: string; kind: 'ruling'; node: string; seq: number; element: string | null; effect: string | null };

/**
 * What happened in the session's kolab, newest first, from what Kolab records: nodes as they were
 * made, by whom, once one of their versions has been submitted (W2.20; nodes made before Kolab
 * recorded it are left out, and so is a node whose only versions are drafts never submitted, still
 * drafted or abandoned), versions as they were
 * written (submitted, committed or rejected; Kolab doesn't record commit times yet, nor when a
 * question was answered), verdicts as they were given, questions and notes as they were raised,
 * and marks as they were raised. Drafts not submitted are left out.
 */
export async function activity(kolab: Kolab, session: string, page: PageOpts = {}): Promise<RowsPage<ActivityRow>> {
  const here = await kolab.sessionKolab(session);
  const size = pageSize(page.limit);
  const list = scoped('web:activity', { here });
  const after = keyOf(list, page.cursor, ['ts', 'text', 'text']) as [string, string, string] | undefined;
  // Each row's key is when it happened, its kind and its own id, so a page starts after the last
  // one shown, whatever happened since. The bound is in every arm, where its index can serve it.
  const before = (at: string) => `($2::text is null or ${at} <= $2::timestamptz)`;
  const read = await kolab.readAs(session, async (q) => (await q.query<Record<string, unknown> & { at: Date | string; at_key: string; id: string }>(
    `select a.*, a.at::text as at_key from (
       select n.created_at as at, kj_node_creator(n.id) as actor, 'node' as kind, n.name as node, null::int as seq, null::text as state, n.title as note,
              null::text as element, null::text as extra, n.id
         -- At most a page of such nodes after the cursor, before kj_node_creator is asked about each.
         from (select n.id, n.name, n.title, n.created_at from node n
                where n.kolab_id = $1 and n.created_at is not null
                  and ($2::text is null or n.created_at < $2::timestamptz or (n.created_at = $2::timestamptz and ('node', n.id) > ($3::text, $4::text)))
                  and exists (select 1 from version v where v.node_id = n.id
                                and (v.state in ('in_review', 'committed') or v.submitted_by is not null))
                order by n.created_at desc, n.id limit $5) n
       union all
       select v.created_at, v.actor_id, 'version', n.name, v.seq, v.state, v.review_note,
              null::text, null::text, v.id
         from version v join node n on n.id = v.node_id
        where v.kolab_id = $1 and v.state in ('in_review', 'committed', 'rejected') and ${before('v.created_at')}
       union all
       select r.decided_at, r.reviewer_id, 'verdict', n.name, v.seq, r.state, null, null, null, r.id
         from review_request r join version v on v.id = r.version_id join node n on n.id = v.node_id
        where r.kolab_id = $1 and r.decided_at is not null and r.state in ('approved', 'changes_requested') and ${before('r.decided_at')}
       union all
       select q.created_at, q.raised_by, 'query', n.name, v.seq, q.state, null, q.element_id, q.kind, q.id
         from query q join version v on v.id = q.version_id join node n on n.id = v.node_id
        where q.kolab_id = $1 and ${before('q.created_at')}
       union all
       select i.created_at, null, 'mark', n.name, v.seq, i.state, null, i.element_id, i.reason, i.id
         from invalidation i join version v on v.id = i.version_id join node n on n.id = v.node_id
        where i.kolab_id = $1 and ${before('i.created_at')}
       union all
       select c.opened_at, c.opened_by, 'case', n.name, v.seq, c.state, null, c.element_id, c.id, c.id
         from case_file c join version v on v.id = c.version_id join node n on n.id = v.node_id
        where c.kolab_id = $1 and c.opened_at is not null and ${before('c.opened_at')}
       union all
       select p.created_at, p.actor_id, 'position', n.name, v.seq, null, null, c.element_id, c.id, p.id
         from position p join case_file c on c.id = p.case_file_id join version v on v.id = c.version_id join node n on n.id = v.node_id
        where p.kolab_id = $1 and p.created_at is not null and p.actor_id is distinct from c.opened_by and ${before('p.created_at')}
       union all
       -- When it was recorded: a ruling dated in the past (W6.3) shows as what just happened here.
       select coalesce(r.recorded_at, r.ruled_at), r.actor_id, 'ruling', n.name, v.seq, null, null, coalesce(r.element_id, c.element_id), r.effect, r.id
         from ruling r left join case_file c on c.id = r.case_file_id
         join version v on v.id = coalesce(r.version_id, c.version_id) join node n on n.id = v.node_id
        where r.kolab_id = $1 and r.ruled_at is not null and ${before('coalesce(r.recorded_at, r.ruled_at)')}
     ) a
     where $2::text is null or a.at < $2::timestamptz or (a.at = $2::timestamptz and (a.kind, a.id) > ($3::text, $4::text))
     order by a.at desc, a.kind, a.id limit $5`,
    [here, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, size + 1])).rows);
  const { rows, next } = pageOf(read, size, list, (r) => [r.at_key, r.kind as string, r.id]);
  return { next, items: rows.map((r): ActivityRow => {
    const at = iso(r.at), node = r.node as string, seq = r.seq as number;
    switch (r.kind) {
      case 'node': return { at, actor: r.actor as string, kind: 'node', node, title: r.note as string };
      case 'version': return { at, actor: r.actor as string, kind: 'version', node, seq, state: r.state as VersionState, note: r.note as string | null };
      case 'verdict': return { at, actor: r.actor as string, kind: 'verdict', node, seq, state: r.state as 'approved' | 'changes_requested' };
      case 'query': return { at, actor: r.actor as string | null, kind: 'query', node, seq, element: r.element as string | null, query_kind: r.extra as QueryKind };
      case 'case': return { at, actor: r.actor as string | null, kind: 'case', node, seq, element: r.element as string | null, case: r.extra as string };
      case 'position': return { at, actor: r.actor as string, kind: 'position', node, seq, element: r.element as string | null, case: r.extra as string };
      case 'ruling': return { at, actor: r.actor as string, kind: 'ruling', node, seq, element: r.element as string | null, effect: r.extra as string | null };
      default: return { at, actor: null, kind: 'mark', node, seq, element: r.element as string | null, reason: r.extra as MarkReason };
    }
  }) };
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
