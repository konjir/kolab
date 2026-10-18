import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AccessError, ActorError, ChecksError, GateError, Kolab, RoleError, TenancyError, activity, kolabNodes, liveLinks, markDetails, maskTokens,
  openReviewRequests, queryDetails, submissionsOf, versionHistory, type LinkRow, type MarkDetailRow, type QueryDetailRow, type VersionHistoryRow,
} from '@konjir/engine';
import { formatAddress, isKolabName, isNodeName } from '@konjir/address';
import {
  FINDING_KINDS, KINDS, OVERRIDE_RESOLUTIONS, QUERY_KINDS, REVIEW_VERDICTS, ROLES, type WebCreateKolab, type WebSwitch,
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

  /**
   * The kolab at a glance. The kolabs the person can reach come from Kolab's own access check
   * (kj_access, which no session may run), as tenancy metadata; everything else is read as the
   * session reads, under row-level security (views.ts).
   */
  async overview(s: string): Promise<WebOverview> {
    const k = this.kolab;
    const me = await this.me(s);
    const reach = new Set([...(await k.reachable(me.actor)), me.kolab]);
    const kolabs: WebKolab[] = [];
    for (const x of (await k.listKolabs()).filter((x) => reach.has(x.id))) {
      kolabs.push({ id: x.id, title: x.title, owner: x.owner, visibility: x.visibility, current: x.id === me.kolab, access: await k.access(me.actor, x.id) });
    }
    const [queries, marks, requests] = await Promise.all([queryDetails(k, s), markDetails(k, s), openReviewRequests(k, s)]);
    const open = queries.filter((q) => q.state === 'open');
    return {
      me,
      kolab: kolabs.find((x) => x.current)!,
      kolabs,
      nodes: await this.nodes(s),
      counts: {
        stale: marks.filter((m) => m.layer === me.layer).length,
        waiting: open.filter((q) => q.layer === me.layer).length,
        reviews: requests.filter((r) => r.reviewer === me.actor && r.layer === me.layer).length,
        open: open.length,
      },
    };
  }

  private async nodes(s: string): Promise<WebNodeSummary[]> {
    return (await kolabNodes(this.kolab, s)).map(({ name, kind, layer, title, latest, drafts, in_review }) =>
      ({ name, kind, layer, title, latest: latest === null ? null : Number(latest), drafts: Number(drafts), in_review: Number(in_review) }));
  }

  async node(s: string, name: string, seq?: number): Promise<WebNodeView> {
    const k = this.kolab;
    const me = await this.me(s);
    const n = await k.nodeIn(s, name, 'reading');
    const summary = (await this.nodes(s)).find((x) => x.name === n.name)!;
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
    const requests = await openReviewRequests(k, s);
    const inReview = shown.filter((v) => v.state === 'in_review').map((v) => {
      const reviewers = requests.filter((r) => r.node === n.name && r.seq === v.seq).map((r) => r.reviewer);
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
    return (await markDetails(this.kolab, s)).map(mark);
  }

  async reviews(s: string): Promise<WebReviewsView> {
    const me = await this.me(s);
    return {
      for_me: (await openReviewRequests(this.kolab, s)).filter((r) => r.reviewer === me.actor && r.layer === me.layer)
        .map((r) => ({ subject: formatAddress({ node: r.node, version: r.seq }), node: r.node, seq: r.seq, author: r.author, at: r.at })),
      mine: (await submissionsOf(this.kolab, s, me.actor)).map((x) => ({
        subject: formatAddress({ node: x.node, version: x.seq }), node: x.node, seq: x.seq, state: x.state, note: x.note, verdicts: x.verdicts,
      })),
    };
  }

  async lineage(s: string): Promise<WebLineageView> {
    const nodes: WebLineageView['nodes'] = [];
    for (const n of await this.nodes(s)) {
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
    if (b.base !== null && !Number.isInteger(b.base)) throw bad('say which version the edits were made on (base)');
    const n = await k.nodeIn(s, name, 'drafting');
    const live = await k.latestCommitted(n.id);
    // The edits apply to the version they were made on, never silently to a newer one (CAS7).
    if ((live?.seq ?? null) !== b.base) throw stale(n.name, b.base, live?.seq ?? null);
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
    // A commit between the check above and the draft: the draft was built on a newer version than
    // the edits were, so it is abandoned, and the page keeps them.
    const drafted = await k.version(id);
    if ((drafted.base_version_id ?? null) !== (live?.id ?? null)) {
      await k.abandon(s, id);
      throw stale(n.name, b.base, (await k.latestCommitted(n.id))?.seq ?? null);
    }
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

  /**
   * Moves the person to another kolab or role (the prototype's kolab picker and "Working as"):
   * the current session ends and a new one opens, in the same transaction's terms as an admin's
   * admin_end_session and admin_open_session, for the person alone (ENF4: one open session per
   * actor). The new token goes only into the cookie. Access is checked before anything ends, so
   * a kolab the person can't reach leaves the session as it was.
   */
  async switchTo(s: string, b: WebSwitch): Promise<string> {
    if (!ROLES.includes(b?.role)) throw bad(`the role is one of ${ROLES.join(', ')}`);
    if (typeof b.kolab !== 'string' || !isKolabName(b.kolab)) throw bad('name the kolab');
    const me = await this.me(s);
    if (!(await this.kolab.access(me.actor, b.kolab)).level) throw new NotFoundException({ error: 'not_found', message: `you can't reach a kolab ${b.kolab}` });
    await this.kolab.endSession(s);
    return this.kolab.openSession(me.actor, b.role, { kolab: b.kolab });
  }

  /**
   * A kolab of the person's own (TEN2, TEN3: a user can own kolabs directly), named uniquely
   * across Konjir (TEN4) and private (TEN6's default), which the person then works in, in the
   * same role. Returns the new session's token, for the cookie.
   */
  async createKolab(s: string, b: WebCreateKolab): Promise<string> {
    if (typeof b?.name !== 'string' || !isKolabName(b.name) || b.name.length > 40) throw bad('a kolab\'s name is lowercase letters, digits and "-", starting with a letter or digit');
    if (!b.title?.trim()) throw bad('give the kolab a name people read');
    const me = await this.me(s);
    if (me.kind !== 'person') throw new ForbiddenException({ error: 'forbidden', message: 'only a person owns kolabs here' });
    if ((await this.kolab.listKolabs()).some((x) => x.id === b.name)) {
      throw new ConflictException({ error: 'conflict', message: `the kolab name ${b.name} is taken: names are unique across all of Konjir, so a kolab can always move to another owner. Choose another` });
    }
    await this.kolab.createKolab(b.name, { owner: me.actor, title: b.title.trim() });
    return this.switchTo(s, { kolab: b.name, role: me.role });
  }

  /** Signing out ends the session: its token is revoked everywhere (D41), not only forgotten here. */
  async signOut(s: string) {
    await this.kolab.endSession(s);
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
const stale = (node: string, base: number | null, now: number | null) => new ConflictException({
  error: 'stale', message: `${node} moved on: your edits were made on ${base === null ? 'no version' : `version ${base}`}, and it is at version ${now ?? 'none'} now. They are still here; read the new version, then apply them again`,
});
const logger = new Logger('WebApi');

/**
 * An engine error as the API returns it: its status and its message, with any token masked.
 * Anything Kolab doesn't name (a database error, a bug) is logged here and answered with a plain
 * 500, so no schema or row-level security detail reaches a page.
 */
export function httpError(e: unknown): HttpException {
  if (e instanceof HttpException) return e;
  const message = maskTokens(e);
  if (e instanceof RoleError || e instanceof AccessError) return new ForbiddenException({ error: 'forbidden', message });
  if (e instanceof GateError || e instanceof ChecksError) return new ConflictException({ error: 'conflict', message });
  if (e instanceof ActorError || e instanceof TenancyError) return new BadRequestException({ error: 'bad_request', message });
  // Kolab's own "not there" refusals: no node, no version, no query, no mark.
  if (/^(no (node|version|query|mark|actor) |[^ ]+ has no (committed )?version|cannot ask about )/.test(message)) return new NotFoundException({ error: 'not_found', message });
  logger.error(`the web API failed: ${message}`);
  return new HttpException({ error: 'error', message: 'Kolab could not do that. It has been logged; try again, or tell whoever runs Kolab.' }, 500);
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

const mark = (m: MarkDetailRow): WebMark => ({
  id: m.id, reason: m.reason, node: m.node, seq: m.seq, element: m.element, layer: m.layer,
  because: m.because, next: m.next, at: m.at,
  target: m.target_node ? {
    node: m.target_node, element: m.target_element, pinned: m.target_pinned!, now: m.target_now ?? m.target_pinned!,
    before: m.target_before, after: m.target_after,
  } : null,
  override: m.override_element ? { element: m.override_element, mine: m.override_text, parent_before: m.parent_before, parent_now: m.parent_now } : null,
  question: m.question,
});
