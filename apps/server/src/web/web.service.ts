import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccessError, ActorError, ChecksError, GateError, Kolab, RoleError, TenancyError, activity, liveLinks, markDetails, maskTokens,
  queryDetails, versionHistory, type LinkRow, type MarkDetailRow, type QueryDetailRow, type VersionHistoryRow,
} from '@konjir/engine';
import { formatAddress, isNodeName, parseAddress } from '@konjir/address';
import {
  FINDING_KINDS, KINDS, OVERRIDE_RESOLUTIONS, QUERY_KINDS, REVIEW_VERDICTS,
  type ElementInput, type GateResult, type Layer, type Role,
  type WebActivityView, type WebAsk, type WebCreateNode, type WebElement, type WebKolab, type WebLineageView, type WebLink, type WebMark,
  type WebMe, type WebNodeSummary, type WebNodeView, type WebOutcome, type WebOverview, type WebQuery, type WebResolve, type WebReviewsView,
  type WebSubmit, type WebVerdict, type WebVersion,
} from '@konjir/types';
import { KOLAB } from '../tokens.js';

/**
 * The web interface's API over the engine (W3.1, API8): each write is one of the agents' verbs,
 * with the same rules, which Kolab enforces, not this layer; reads gather what a page shows.
 * Everything is in the session's own kolab (TEN12): a node is named by name in it, and
 * another kolab's node is refused as if it weren't there.
 */
@Injectable()
export class WebService {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  // ---- reads -----------------------------------------------------------------

  async me(s: string): Promise<WebMe> {
    const i = await this.kolab.sessionInfo(s);
    const a = await this.kolab.actor(i.actor);
    return { actor: i.actor, name: a.name, kind: i.kind, owner: i.owner, role: i.role as Role, layer: i.layer, kolab: i.kolab, access: i.access };
  }

  async overview(s: string): Promise<WebOverview> {
    const k = this.kolab;
    const me = await this.me(s);
    const reach = new Set([...(await k.reachable(me.actor)), me.kolab]);
    const kolabs: WebKolab[] = (await k.listKolabs()).filter((x) => reach.has(x.id))
      .map((x) => ({ id: x.id, title: x.title, owner: x.owner, visibility: x.visibility, current: x.id === me.kolab }));
    const open = await k.listQueries({ state: 'open', kolab: me.kolab });
    return {
      me,
      kolab: kolabs.find((x) => x.current)!,
      kolabs,
      nodes: await this.nodes(me.kolab),
      counts: {
        stale: (await k.describeMarks({ layer: me.layer, kolab: me.kolab })).length,
        waiting: (await k.listQueries({ layer: me.layer, state: 'open', kolab: me.kolab })).length,
        reviews: (await k.reviewRequests({ reviewer: me.actor, layer: me.layer, kolab: me.kolab })).length,
        open: open.length,
      },
    };
  }

  private async nodes(kolab: string): Promise<WebNodeSummary[]> {
    return (await this.kolab.listNodes(undefined, kolab)).map(({ name, kind, layer, title, latest, drafts, in_review }) =>
      ({ name, kind, layer, title, latest: latest === null ? null : Number(latest), drafts: Number(drafts), in_review: Number(in_review) }));
  }

  async node(s: string, name: string, seq?: number): Promise<WebNodeView> {
    const k = this.kolab;
    const me = await this.me(s);
    const n = await k.nodeIn(s, name, 'reading');
    const summary = (await this.nodes(me.kolab)).find((x) => x.name === n.name)!;
    const history = await versionHistory(k, s, n.id);
    const shown = history.filter((v) => v.state === 'committed' || v.state === 'in_review' || (v.state === 'drafted' && v.actor === me.actor));
    const latest = summary.latest;
    const readSeq = seq ?? latest;
    const row = readSeq === null ? undefined : shown.find((v) => v.seq === readSeq);
    if (readSeq !== null && !row) throw new NotFoundException({ error: 'not_found', message: `${n.name} has no version ${readSeq} you can read` });

    const live = row !== undefined && row.seq === latest;
    const [links, marks, queries] = await Promise.all([liveLinks(k, s), this.marks(s), queryDetails(k, s, n.id)]);
    const ownMarks = marks.filter((m) => m.node === n.name);
    const toLink = (l: LinkRow) => link(l);
    let elements: WebElement[] = [];
    let compared: WebNodeView['compared_with'] = null;
    if (row) {
      const read = await k.readNode(s, n.name, row.seq);
      elements = read.elements.map((e) => ({
        id: e.element_id, parent: e.parent_element_id, text: e.text,
        address: formatAddress({ node: n.name, version: row.seq, element: e.element_id }),
        queries: queries.filter((q) => q.element === e.element_id).map(query),
        relies_on: live ? links.filter((l) => l.source_node === n.name && l.source_element === e.element_id).map(toLink) : [],
        relied_on_by: live ? links.filter((l) => l.target_node === n.name && l.target_element === e.element_id).map(toLink) : [],
        marks: live ? ownMarks.filter((m) => m.element === e.element_id) : [],
      }));
      const base = row.state === 'committed'
        ? [...shown].reverse().find((v) => v.state === 'committed' && v.seq < row.seq)?.seq
        : row.base_seq ?? undefined;
      if (base !== undefined) {
        compared = { seq: base, elements: (await k.readNode(s, n.name, base)).elements.map((e) => ({ id: e.element_id, text: e.text })) };
      }
    }
    const requests = await k.reviewRequests({ kolab: me.kolab });
    const inReview = shown.filter((v) => v.state === 'in_review').map((v) => {
      const subject = `kj:${n.name}@${v.seq}`;
      const reviewers = requests.filter((r) => r.subject === subject).map((r) => r.reviewer);
      return { seq: v.seq, author: v.actor, at: v.at, reviewers, for_me: reviewers.includes(me.actor) && me.layer === n.layer };
    });
    return {
      node: summary,
      reading: row ? version(row, me.actor) : null,
      versions: shown.map((v) => version(v, me.actor)),
      elements,
      queries: queries.filter((q) => q.element === null).map(query),
      compared_with: compared,
      in_review: inReview,
      drafts: shown.filter((v) => v.state === 'drafted').map((v) => version(v, me.actor)),
      can_write: me.layer === n.layer && me.access.layers.includes(n.layer),
    };
  }

  async queries(s: string): Promise<WebQuery[]> {
    return (await queryDetails(this.kolab, s)).map(query);
  }

  async marks(s: string): Promise<WebMark[]> {
    const kolab = await this.kolab.sessionKolab(s);
    const words = new Map((await this.kolab.describeMarks({ kolab })).map((m) => [m.mark, m]));
    return (await markDetails(this.kolab, s)).map((m) => mark(m, words.get(m.id)));
  }

  async reviews(s: string): Promise<WebReviewsView> {
    const me = await this.me(s);
    const at = (subject: string) => { const a = parseAddress(subject); return { node: a.node, seq: a.version ?? 0 }; };
    return {
      for_me: (await this.kolab.reviewRequests({ reviewer: me.actor, layer: me.layer, kolab: me.kolab }))
        .map((r) => ({ subject: r.subject, ...at(r.subject), author: r.author, at: r.requested_at })),
      mine: (await this.kolab.submissions(me.actor, { kolab: me.kolab })).map((x) => ({
        subject: x.subject, ...at(x.subject), state: x.state, note: x.note,
        verdicts: x.verdicts.map((v) => ({ reviewer: v.reviewer, state: v.state, note: v.note })),
      })),
    };
  }

  async lineage(s: string): Promise<WebLineageView> {
    const me = await this.me(s);
    const nodes: WebLineageView['nodes'] = [];
    for (const n of await this.nodes(me.kolab)) {
      if (n.latest === null) continue;
      const read = await this.kolab.readNode(s, n.name, n.latest);
      nodes.push({ name: n.name, title: n.title, kind: n.kind, layer: n.layer, seq: n.latest, elements: read.elements.map((e) => ({ id: e.element_id, text: e.text })) });
    }
    return { nodes, links: (await liveLinks(this.kolab, s)).map(link) };
  }

  async activity(s: string): Promise<WebActivityView> {
    const at = (node: string, seq: number, element?: string | null) => formatAddress({ node, version: seq, element: element ?? undefined });
    return {
      items: (await activity(this.kolab, s)).map((r) => {
        switch (r.kind) {
          case 'version': return {
            at: r.at, actor: r.actor,
            text: r.state === 'committed' ? `committed ${at(r.node, r.seq)}${r.note ? ` · ${r.note}` : ''}`
              : r.state === 'in_review' ? `submitted ${at(r.node, r.seq)} for review`
              : `${at(r.node, r.seq)} was rejected${r.note ? `: ${r.note}` : ''}`,
          };
          case 'verdict': return { at: r.at, actor: r.actor, text: `${r.state === 'approved' ? 'approved' : 'requested changes on'} ${at(r.node, r.seq)}` };
          case 'query': return { at: r.at, actor: r.actor ?? 'kolab', text: `${r.query_kind === 'note' ? 'left a note on' : 'asked about'} ${at(r.node, r.seq, r.element)}` };
          default: return { at: r.at, actor: 'kolab', text: `marked ${at(r.node, r.seq, r.element)} ${r.reason.replace(/_/g, ' ')}` };
        }
      }),
    };
  }

  // ---- writes: each is one verb ------------------------------------------------

  async createNode(s: string, b: WebCreateNode) {
    if (!KINDS.includes(b?.kind)) throw bad(`kind is one of ${KINDS.join(', ')}`);
    if (!b.title?.trim()) throw bad('give the node a title');
    if (!isNodeName(b.name ?? '')) throw bad('a node\'s name has no spaces and no "/", "@", "#" or "~"');
    const id = await this.kolab.createNode(s, b.kind, b.title.trim(), b.name);
    return { node: (await this.kolab.node(id)).name };
  }

  /**
   * Drafts the node's latest committed version with the changes and submits it (konjir_draft, then
   * konjir_submit_for_review). The draft is sent whole, so Kolab diffs it against the parent, a
   * variant's included. A draft that fails Kolab's structural checks is abandoned at once, and the
   * page keeps the edits to fix; `replaces`, the session's own earlier draft, is abandoned once the
   * new one is in review or committed.
   */
  async submit(s: string, name: string, b: WebSubmit): Promise<WebOutcome> {
    const k = this.kolab;
    if (!Array.isArray(b?.changes) || !b.changes.length) throw bad('nothing changed, so there is nothing to submit');
    const n = await k.nodeIn(s, name, 'drafting');
    const live = await k.latestCommitted(n.id);
    const elements: ElementInput[] = live ? (await k.readNode(s, n.name, live.seq)).elements.map((e) => ({ id: e.element_id, text: e.text, parent: e.parent_element_id ?? undefined })) : [];
    for (const c of b.changes) {
      if (!c || typeof c.element !== 'string' || !c.element) throw bad('each change names its element');
      const i = elements.findIndex((e) => e.id === c.element);
      if (c.kind === 'add') {
        if (i >= 0) throw bad(`${c.element} already exists`);
        elements.push({ id: c.element, text: c.text ?? '', parent: c.parent });
      } else if (c.kind === 'override') {
        if (i < 0) throw bad(`there is no ${c.element} to edit`);
        elements[i] = { ...elements[i], text: c.text ?? '' };
      } else if (c.kind === 'remove') {
        if (i < 0) throw bad(`there is no ${c.element} to remove`);
        if (elements.some((e) => e.parent === c.element)) throw bad(`${c.element} has elements under it; remove those first`);
        elements.splice(i, 1);
      } else throw bad('a change is add, override or remove');
    }
    const replaced = b.replaces === undefined ? undefined : await this.ownDraft(s, n.name, b.replaces);
    const id = await k.draft(s, n.id, { elements });
    const r = await k.submit(s, id);
    const out = await this.outcome(r);
    if (!out.ok && !out.in_review && !out.stale && (await k.version(id)).state === 'drafted') {
      await k.abandon(s, id);
      out.abandoned = true;
    }
    if (replaced && (out.committed || out.in_review)) await k.abandon(s, replaced).catch(() => undefined);
    return out;
  }

  private async ownDraft(s: string, name: string, seq: number): Promise<string> {
    const v = await this.kolab.versionIn(s, { node: name, version: seq }, { allowDraft: true, what: 'replacing a draft' });
    const me = await this.kolab.sessionInfo(s);
    if (v.actor_id !== me.actor || v.state !== 'drafted') throw bad(`${name}@${seq} isn't a draft of yours`);
    return v.id;
  }

  /** Submits a draft again, unchanged: one that came back with changes requested (konjir_submit_for_review). */
  async resubmit(s: string, name: string, seq: number): Promise<WebOutcome> {
    const v = await this.kolab.versionIn(s, { node: name, version: seq }, { allowDraft: true, what: 'submitting' });
    return this.outcome(await this.kolab.submit(s, v.id));
  }

  async abandon(s: string, name: string, seq: number) {
    const v = await this.kolab.versionIn(s, { node: name, version: seq }, { allowDraft: true, what: 'abandoning' });
    return { state: await this.kolab.abandon(s, v.id) };
  }

  /** konjir_review: approve, or request changes with a note. */
  async review(s: string, name: string, seq: number, b: WebVerdict): Promise<WebOutcome> {
    if (!REVIEW_VERDICTS.includes(b?.verdict)) throw bad('the verdict is approve or request_changes');
    if (b.verdict === 'request_changes' && !b.note?.trim()) throw bad('say what must change: requesting changes needs a note');
    for (const f of b.findings ?? []) if (!FINDING_KINDS.includes(f.kind)) throw bad('a finding is a contradiction or a layer_leak');
    const v = await this.kolab.versionIn(s, { node: name, version: seq }, { allowDraft: true, what: 'reviewing' });
    const r = await this.kolab.recordReview(s, v.id, { verdict: b.verdict, note: b.note?.trim() || undefined, findings: b.findings });
    if (b.verdict === 'request_changes') return { ...(await this.outcome({ ...r, ok: false, in_review: false })), note: r.note ?? null };
    return this.outcome(r);
  }

  /** konjir_clear_mark: the work still holds against what changed. */
  async clear(s: string, mark: string) {
    await this.kolab.clear(s, mark);
    return { cleared: mark };
  }

  /** konjir_resolve_override: a ruling on a variant's override, which becomes precedent (OVR8, OVR9). */
  async resolve(s: string, mark: string, b: WebResolve) {
    if (!OVERRIDE_RESOLUTIONS.includes(b?.resolution)) throw bad(`the resolution is one of ${OVERRIDE_RESOLUTIONS.join(', ')}`);
    if (b.resolution === 'amend' && !b.text?.trim()) throw bad('amending needs the new text');
    const r = await this.kolab.resolveOverride(s, mark, b.resolution, b.text);
    return this.outcome({ ...r.verdict, version: r.version });
  }

  /** konjir_ask or konjir_annotate, about an element (or the node) of the session's kolab. */
  async ask(s: string, b: WebAsk) {
    if (!QUERY_KINDS.includes(b?.kind)) throw bad('a question or a note');
    if (!b.text?.trim()) throw bad('write the question or the note');
    if (typeof b.node !== 'string' || !isNodeName(b.node)) throw bad('name the node it is about');
    const address = formatAddress({ node: b.node, version: b.seq, element: b.element || undefined });
    return { query: await this.kolab.raiseQuery(s, address, b.text.trim(), { kind: b.kind }) };
  }

  /** konjir_answer_query: only the layer that owns the answer may give it. */
  async answer(s: string, query: string, answer: string) {
    if (!answer?.trim()) throw bad('write the answer');
    await this.kolab.answerQuery(s, query, answer.trim());
    return { answered: query };
  }

  private async outcome(r: GateResult): Promise<WebOutcome> {
    const v = await this.kolab.version(r.version);
    return {
      ok: r.ok, seq: v.seq, committed: r.ok, in_review: !!r.in_review, stale: !!r.stale, unreviewed: !!r.unreviewed,
      reviewers: r.reviewers ?? [], note: r.note ?? null, cascade_queued: r.cascade === 'queued', abandoned: false,
    };
  }
}

const bad = (message: string) => new BadRequestException({ error: 'bad_request', message });

/** An engine error as the API returns it: its status, and its message with any token masked. */
export function httpError(e: unknown): HttpException {
  if (e instanceof HttpException) return e;
  const message = maskTokens(e);
  if (e instanceof RoleError || e instanceof AccessError) return new ForbiddenException({ error: 'forbidden', message });
  if (e instanceof GateError || e instanceof ChecksError) return new ConflictException({ error: 'conflict', message });
  if (e instanceof ActorError || e instanceof TenancyError) return new BadRequestException({ error: 'bad_request', message });
  if (/^(no |.* has no |cannot )/.test(message)) return new NotFoundException({ error: 'not_found', message });
  return new HttpException({ error: 'error', message }, 500);
}

const version = (v: VersionHistoryRow, me: string): WebVersion =>
  ({ seq: v.seq, state: v.state, author: v.actor, role: v.role, at: v.at, note: v.note, mine: v.actor === me });

const link = (l: LinkRow): WebLink => ({
  edge: l.edge, kind: l.kind,
  source: { node: l.source_node, seq: l.source_seq, element: l.source_element, layer: l.source_layer as Layer },
  target: { node: l.target_node, seq: l.target_seq, element: l.target_element, quote: l.target_selector?.exact ?? null, latest: l.target_latest },
  mark: l.mark_id ? { id: l.mark_id, reason: l.mark_reason! } : null,
});

const query = (q: QueryDetailRow): WebQuery => ({
  id: q.id, kind: q.kind, state: q.state,
  address: formatAddress({ node: q.node, version: q.seq, element: q.element ?? undefined, selector: q.selector ?? undefined }),
  node: q.node, seq: q.seq, element: q.element, quote: q.selector?.exact ?? null, layer: q.layer,
  question: q.question, raised_by: q.raised_by, at: q.at, answer: q.answer, answered_by: q.answered_by,
  from: q.from_node ? formatAddress({ node: q.from_node, version: q.from_seq ?? undefined, element: q.from_element ?? undefined }) : null,
  mark: q.mark, mark_reason: q.mark_reason,
});

const mark = (m: MarkDetailRow, words?: { because: string; next: string }): WebMark => ({
  id: m.id, reason: m.reason, node: m.node, seq: m.seq, element: m.element, layer: m.layer,
  because: words?.because ?? '', next: words?.next ?? '', at: m.at,
  target: m.target_node ? {
    node: m.target_node, element: m.target_element, pinned: m.target_pinned!, now: m.target_now ?? m.target_pinned!,
    before: m.target_before, after: m.target_after,
  } : null,
  override: m.override_element ? { element: m.override_element, mine: m.override_text, parent_before: m.parent_before, parent_now: m.parent_now } : null,
  question: m.question,
});
