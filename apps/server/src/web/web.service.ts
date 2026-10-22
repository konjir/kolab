import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AccessError, ActorError, ChecksError, GateError, Kolab, RoleError, TenancyError, activity, committedVersions, kolabNodes, liveLinks, markDetails,
  maskTokens, openCaseCount, openReviewRequests, ownSide, queryDetails, readableNodes, submissionsOf, versionHistory,
  type LinkRow, type MarkDetailRow, type QueryDetailRow, type VersionHistoryRow,
} from '@konjir/engine';
import { formatAddress, isKolabName, isNodeName, parseAddress, type QuoteSelector } from '@konjir/address';
import {
  ACCESS_LEVELS, CASE_FILE_STATES, FINDING_KINDS, INVITE_LEVELS, KINDS, LAYERS, OVERRIDE_RESOLUTIONS, POSITION_VERDICTS, QUERY_KINDS, REVIEW_VERDICTS, ROLES, RULING_EFFECTS,
  type WebCreateKolab, type WebCreateInvite, type WebInviteMade, type WebInvitesView, type WebSwitch, type KolabAccessView, type WebAccessChanged, type WebChangeGrant, type CaseFileState, type CaseFileView, type RulingView,
  type WebCase, type WebCasesView, type WebForeignKolab, type WebOpenCase, type WebPosition, type WebRuleCase, type WebRuleDirect, type WebRuling,
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
    const [queries, marks, requests, cases] = await Promise.all([
      queryDetails(k, s), markDetails(k, s), openReviewRequests(k, s), openCaseCount(k, s, me.layer),
    ]);
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
        cases,
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
    let nodeRulings: WebRuling[] = [];
    if (row) {
      const read = await k.readNode(s, n.name, row.seq);
      // Precedent and open case files beside the element they concern, from any version (CASE4):
      // read as kj_agent, so a session that holds only Read gets none (D49).
      const rulings = read.rulings.map(ruling);
      const cases = await this.decorate(me, read.cases);
      nodeRulings = rulings.filter((r) => r.element === null);
      elements = read.elements.map((e) => ({
        rulings: rulings.filter((r) => r.element === e.element_id),
        cases: cases.filter((c) => c.element === e.element_id),
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
      folded: await this.folds(history.filter((v) => v.actor === me.actor)),
      can_write: me.layer === n.layer && me.access.layers.includes(n.layer),
      rulings: nodeRulings,
      kolab: me.kolab,
      foreign: false,
    };
  }

  /** Which of these versions were folded onto a newer one, and into which: Kolab notes "folded into <version id>". */
  private async folds(rows: VersionHistoryRow[]): Promise<{ seq: number; into: number }[]> {
    const out: { seq: number; into: number }[] = [];
    for (const r of rows) {
      const id = r.state === 'rejected' ? /^folded into (\S+)$/.exec(r.note ?? '')?.[1] : undefined;
      if (id) out.push({ seq: r.seq, into: (await this.kolab.version(id)).seq });
    }
    return out;
  }

  /**
   * A node of another kolab, read in place (D49): only with Read there, as kj_access computes it,
   * and only its committed versions, with their elements and questions. A kolab the session can't
   * read, a node that isn't there and a version that isn't committed are refused alike, saying
   * nothing of which it was. In the session's own kolab, it is the node as `node` reads it.
   */
  async foreignNode(s: string, kolab: string, name: string, seq?: number): Promise<WebNodeView> {
    const k = this.kolab;
    if (!isKolabName(kolab) || !isNodeName(name)) throw notThere(kolab, name);
    const me = await this.me(s);
    if (kolab === me.kolab) return this.node(s, name, seq);
    // Kolab checks Read first (the same refusal as a node that isn't there), then reads as kj_agent.
    const n = await k.locateNode({ session: s }, { kolab, node: name });
    const versions = await committedVersions(k, s, n.id);
    // A node with nothing committed reads exactly as one that isn't there (D49).
    if (!versions.length) throw notThere(kolab, name);
    const latest = versions.at(-1)?.seq ?? null;
    const readSeq = seq ?? latest;
    const row = readSeq === null ? undefined : versions.find((v) => v.seq === readSeq);
    if (readSeq !== null && !row) throw new NotFoundException({ error: 'not_found', message: `${kolab}/${name} has no version ${readSeq} you can read` });
    const ref = `${kolab}/${n.name}`;
    const queries = (await queryDetails(k, s, n.id, kolab)).map((q) => foreignQuery(query(q), kolab));
    let elements: WebElement[] = [];
    let compared: WebNodeView['compared_with'] = null;
    if (row) {
      elements = (await k.readNode(s, ref, row.seq)).elements.map((e) => ({
        id: e.element_id, parent: e.parent_element_id, text: e.text,
        address: formatAddress({ kolab, node: n.name, version: row.seq, element: e.element_id }),
        queries: queries.filter((q) => q.element === e.element_id),
        relies_on: [], relied_on_by: [], marks: [], rulings: [], cases: [],
      }));
      const before = [...versions].reverse().find((v) => v.seq < row.seq)?.seq;
      if (before !== undefined) compared = { seq: before, elements: (await k.readNode(s, ref, before)).elements.map((e) => ({ id: e.element_id, text: e.text })) };
    }
    return {
      node: { name: n.name, kind: n.kind, layer: n.layer, title: n.title, latest, drafts: 0, in_review: 0 },
      reading: row ? version(row, me.actor) : null,
      versions: versions.map((v) => version(v, me.actor)),
      elements,
      queries: queries.filter((q) => q.element === null),
      compared_with: compared,
      in_review: [], drafts: [], can_write: false, rulings: [],
      kolab, foreign: true,
    };
  }

  /**
   * Another kolab's nodes, read in place (D49): only with Read there. A kolab that isn't there and
   * one the session can't read are refused alike. Its access comes from Kolab's own check
   * (kj_access), as the picker's does; the nodes are read as kj_agent, under row-level security.
   */
  async foreignKolab(s: string, kolab: string): Promise<WebForeignKolab> {
    const me = await this.me(s);
    const refuse = () => new NotFoundException({ error: 'not_found', message: `no kolab ${kolab} you can read` });
    if (!isKolabName(kolab)) throw refuse();
    if (kolab === me.kolab) {
      const x = (await this.kolab.kolabRow(kolab))!;
      return { kolab: { id: x.id, title: x.title, owner: x.owner, visibility: x.visibility, access: me.access }, nodes: (await this.nodes(s)).filter((n) => n.latest !== null) };
    }
    // The kolab's own row first (Kolab's login, by id), then Read for that kolab alone, checked in the
    // same read-only transaction as the read of its nodes (kj_agent): if Read is gone by then, nothing.
    const x = await this.kolab.kolabRow(kolab);
    if (!x) throw refuse();
    const nodes = await readableNodes(this.kolab, s, kolab);
    if (!nodes) throw refuse();
    const access = await this.kolab.access(me.actor, kolab);
    if (!access.level) throw refuse();
    return {
      kolab: { id: x.id, title: x.title, owner: x.owner, visibility: x.visibility, access },
      nodes: nodes.map((r) => ({ name: r.name, kind: r.kind, layer: r.layer, title: r.title, latest: Number(r.latest), drafts: 0, in_review: 0 })),
    };
  }

  // ---- case files and rulings (CASE1–CASE7, D49, D51) -------------------------

  /**
   * konjir_list_cases: the kolab's case files, most recently changed first, on every layer, in one
   * state or all, or with `mine` those the person opened or argued. A session that holds only Read
   * there gets none: row-level security gives it no case files (D49).
   */
  async cases(s: string, opts: { state?: string; mine?: boolean; node?: string } = {}): Promise<WebCasesView> {
    const me = await this.me(s);
    if (opts.node !== undefined && !isNodeName(opts.node)) throw bad('name a node of this kolab');
    if (opts.state !== undefined && opts.state !== 'all' && !CASE_FILE_STATES.includes(opts.state as CaseFileState)) {
      throw bad(`the state is one of ${CASE_FILE_STATES.join(', ')}, or all`);
    }
    const state = opts.state === undefined || opts.state === 'all' ? undefined : opts.state as CaseFileState;
    const node = opts.node === undefined ? undefined : (await this.kolab.nodeIn(s, opts.node, 'listing case files')).id;
    const rows = await this.kolab.casesFor(s, { state, node, actor: opts.mine ? me.actor : undefined, limit: 200 });
    return { cases: await this.decorate(me, rows), belongs: me.access.layers.length > 0 };
  }

  /** konjir_read_case: one case file of the session's kolab, with its positions and ruling. */
  async readCase(s: string, id: string): Promise<WebCase> {
    const me = await this.me(s);
    const [c] = await this.kolab.casesFor(s, { id });
    if (!c) throw new NotFoundException({ error: 'not_found', message: `no case file ${id} in kolab ${me.kolab}` });
    return (await this.decorate(me, [c]))[0];
  }

  /** konjir_open_case: on one element of a committed version of the session's kolab, with the opener's position. */
  async openCase(s: string, b: WebOpenCase): Promise<WebCase> {
    if (typeof b?.node !== 'string' || !isNodeName(b.node)) throw bad('name the node it is about');
    if (!isElementId(b.element)) throw bad('a case file is about one element: name it, without "/", "@", "#", "~" or spaces');
    if (typeof b.question !== 'string' || typeof b.claim !== 'string') throw bad('give the question in dispute and your claim, as text');
    if (b.seq !== undefined && !Number.isInteger(b.seq)) throw bad('the version is a number');
    if (!RULING_EFFECTS.includes(b.seeks)) throw bad('say which side your position takes: keep the intent, or change it');
    const evidence = evidenceOf(b.evidence);
    const address = formatAddress({ node: b.node, version: b.seq, element: b.element });
    const id = await this.kolab.openCase(s, address, { question: b.question, claim: b.claim, evidence, seeks: b.seeks });
    return this.readCase(s, id);
  }

  /** konjir_add_position: the other side of an open case file. */
  async addPosition(s: string, id: string, b: WebPosition): Promise<WebCase> {
    if (typeof b?.claim !== 'string') throw bad('give your claim, as text');
    await this.kolab.addPosition(s, id, { claim: b?.claim, evidence: evidenceOf(b?.evidence) });
    return this.readCase(s, id);
  }

  /** konjir_rule on a case file: sustains exactly one of its two positions (D51); Kolab checks who may. */
  async ruleCase(s: string, id: string, b: WebRuleCase): Promise<WebRuling> {
    const verdicts = b?.verdicts;
    if (!verdicts || typeof verdicts !== 'object' || Array.isArray(verdicts)
      || Object.values(verdicts).some((v) => !POSITION_VERDICTS.includes(v))) {
      throw bad('give each position a verdict, sustained or overruled');
    }
    const replaces = replacesOf(b);
    const ruling = await this.kolab.rule(s, { case: id, text: textOf(b.text), verdicts, replaces });
    return this.ruling(s, ruling, { cases: [id] });
  }

  /** konjir_rule directly, on an element or a whole node of the session's kolab, with no case file behind it (CASE3, D16). */
  async ruleDirect(s: string, b: WebRuleDirect): Promise<WebRuling> {
    if (typeof b?.node !== 'string' || !isNodeName(b.node)) throw bad('name the node it rules on');
    if (b.seq !== undefined && !Number.isInteger(b.seq)) throw bad('the version is a number');
    if (!RULING_EFFECTS.includes(b.effect)) throw bad('say what the ruling does: change the intent, or keep it');
    if (b.element !== undefined && b.element !== '' && !isElementId(b.element)) throw bad('name the element without "/", "@", "#", "~" or spaces, or leave it out to rule on the node');
    const replaces = replacesOf(b);
    const address = formatAddress({ node: b.node, version: b.seq, element: b.element || undefined });
    const ruling = await this.kolab.rule(s, { address, text: textOf(b.text), effect: b.effect, replaces });
    return this.ruling(s, ruling, { ids: [ruling] });
  }

  /** konjir_list_rulings: the kolab's rulings, newest first, on one node if named: precedent (CASE4). */
  async rulings(s: string, node?: string): Promise<WebRuling[]> {
    if (node !== undefined && !isNodeName(node)) throw bad('name a node of this kolab');
    const id = node === undefined ? undefined : (await this.kolab.nodeIn(s, node, 'listing rulings')).id;
    return (await this.kolab.rulingsFor(s, { node: id, limit: 200 })).map(ruling);
  }

  private async ruling(s: string, id: string, filter: { cases?: string[]; ids?: string[] }): Promise<WebRuling> {
    const r = (await this.kolab.rulingsFor(s, filter)).find((x) => x.ruling === id);
    if (!r) throw new NotFoundException({ error: 'not_found', message: `no ruling ${id}` });
    return ruling(r);
  }

  /**
   * A case file as the page shows it, with which actions to offer the person (WebCase.you). Kolab
   * decides each when it is taken; this only spares a button that would be refused. Who answers for
   * a position's actor (an agent's owner) is Kolab's own lookup, since kj_agent reads no actors.
   */
  private async decorate(me: WebMe, rows: CaseFileView[]): Promise<WebCase[]> {
    // One lookup for every position's actor: which are the person's own side (them, or their agents).
    const mine = await ownSide(this.kolab, me.actor, [...new Set(rows.flatMap((c) => c.positions.map((p) => p.actor)))]);
    const belongs = me.access.layers.length > 0;
    return rows.map((c) => {
      const party = c.positions.some((p) => mine.has(p.actor));
      const open = c.state === 'open';
      return {
        ...c, ...subject(c.on), ruling: c.ruling ? ruling(c.ruling) : null,
        you: {
          party,
          can_argue: open && belongs && c.positions.length === 1 && !party && !!c.positions[0].seeks,
          can_rule: open && c.positions.length === 2 && !party && me.kind === 'person' && me.layer === c.layer && me.access.layers.includes(c.layer),
        },
      };
    });
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
          case 'case': return { at: r.at, actor: r.actor ?? 'kolab', text: `opened a case file on ${at(r.node, r.seq, r.element)}` };
          case 'position': return { at: r.at, actor: r.actor, text: `took the other side of the case file on ${at(r.node, r.seq, r.element)}` };
          case 'ruling': return { at: r.at, actor: r.actor, text: `ruled on ${at(r.node, r.seq, r.element)}: ${r.effect === 'change_intent' ? 'the intent changes' : r.effect === 'keep_intent' ? 'the intent stands' : 'precedent'}` };
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
   * new one is in review or committed. That is how a draft that came back with changes requested is
   * edited: the page sends its changes again, edited, and the new draft carries the rest of it, the
   * links it drops and the links it declared (each pinned to its target's live version, as a fresh
   * link is), so nothing of it is lost. A version's elements never change once written, so the edit
   * is a new version, as konjir_draft and konjir_abandon make it.
   *
   * One version of an author's in review per node, on this path: a replacement is refused while
   * another of theirs waits in review, and the abandon of the draft it replaces is its claim. Kolab
   * makes that abandon under the node's lock, so of two replacements of one draft (a double click,
   * two tabs) only one can make it; the other withdraws its own version and is refused.
   */
  async submit(s: string, name: string, b: WebSubmit): Promise<WebOutcome> {
    const k = this.kolab;
    const unlink = b?.unlink ?? [];
    if (!Array.isArray(unlink) || unlink.some((x) => typeof x !== 'string')) throw bad('unlink lists links by their edge');
    if (!Array.isArray(b?.changes) || (!b.changes.length && !unlink.length)) throw bad('nothing changed, so there is nothing to submit');
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
    if (replaced) {
      const author = (await k.version(replaced)).actor_id;
      const mine = (await versionHistory(k, s, n.id)).find((v) => v.state === 'in_review' && v.actor === author);
      if (mine) throw conflict(`${n.name}@${mine.seq} of yours is in review already: abandon it, or wait until it is decided, before resubmitting ${n.name}@${b.replaces}`);
    }
    const carried = replaced ? await this.carriedFrom(s, n.name, replaced, live?.id ?? null) : undefined;
    const kept = new Set(elements.map((e) => e.id));
    // Its own links, from elements still there, each pinned to its target's live version (refused if the target element is gone).
    const links = carried ? await this.repinned(n.name, b.replaces!, carried.links.filter((l) => l.source_element_id === null || kept.has(l.source_element_id))) : [];
    const drops = [...new Set([...unlink, ...(carried?.unlink ?? [])])];
    const id = await k.draft(s, n.id, { elements, ...(drops.length ? { unlink: drops.map((link) => ({ link })) } : {}) });
    try {
      for (const l of links) {
        await k.link(s, { kind: l.kind, source: id, sourceElement: l.source_element_id ?? undefined, target: l.target_version_id,
          targetElement: l.target_element_id ?? undefined, selector: l.target_selector ?? undefined });
      }
    } catch (e) {
      await k.abandon(s, id);
      throw bad(`a link ${n.name}@${b.replaces} declared can't be carried over: ${(e as Error).message}. Resubmit it as it is, or abandon it.`);
    }
    // A commit between the check above and the draft: the draft was built on a newer version than
    // the edits were, so it is abandoned, and the page keeps them.
    const drafted = await k.version(id);
    if ((drafted.base_version_id ?? null) !== (live?.id ?? null)) {
      await k.abandon(s, id);
      throw stale(n.name, b.base, (await k.latestCommitted(n.id))?.seq ?? null);
    }
    const r = await k.submit(s, id);
    const out = await this.outcome(r);
    // Overtaken between the draft and the submission: the same as before the draft, abandoned and refused.
    if (out.stale) {
      if ((await k.version(id)).state === 'drafted') await k.abandon(s, id);
      throw stale(n.name, b.base, (await k.latestCommitted(n.id))?.seq ?? null);
    }
    if (!out.ok && !out.in_review && (await k.version(id)).state === 'drafted') {
      await k.abandon(s, id);
      out.abandoned = true;
    }
    if (replaced && (out.committed || out.in_review)) {
      try {
        await k.abandon(s, replaced);
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
        // Settled meanwhile: another replacement of it, or it resubmitted as it is, got there first.
        // In review, this one withdraws, so two of the author's versions never wait at once; one
        // that committed stands, and the draft it replaced is settled already.
        if (out.in_review) {
          await k.abandon(s, id);
          throw conflict(`${n.name}@${b.replaces} was resubmitted or replaced meanwhile, so this submission is withdrawn: read the node again`);
        }
      }
    }
    return out;
  }

  /**
   * A replaced draft's own links, each pinned to its target's live version, as a fresh link is:
   * where the target committed since, to the same element in its new version. Refused, naming it,
   * when that element is gone, since the link would no longer say what it relied on.
   */
  private async repinned<L extends { target_version_id: string; target_element_id: string | null }>(name: string, seq: number, links: L[]): Promise<L[]> {
    const out: L[] = [];
    for (const l of links) {
      const pinned = await this.kolab.version(l.target_version_id);
      const live = await this.kolab.latestCommitted(pinned.node_id);
      if (!live || live.id === pinned.id) { out.push(l); continue; }
      if (l.target_element_id !== null && !(await this.kolab.elements(live.id)).some((e) => e.element_id === l.target_element_id)) {
        throw bad(`${name}@${seq} links to ${formatAddress({ node: (await this.kolab.node(pinned.node_id)).name, version: pinned.seq, element: l.target_element_id })}, `
          + `which version ${live.seq} no longer has, so the link can't be carried over. Resubmit ${name}@${seq} as it is, or abandon it and draft afresh.`);
      }
      out.push({ ...l, target_version_id: live.id });
    }
    return out;
  }

  /**
   * What a draft being replaced carries into its replacement besides its elements: the links of the
   * version it was built on that it drops (by edge, to drop again), and the links it declared itself.
   * Only a draft built on the live version can be edited: one built on an older one would undo what
   * committed since, so it is resubmitted as it is, and Kolab rebases it.
   */
  private async carriedFrom(s: string, name: string, draft: string, live: string | null) {
    const v = await this.kolab.version(draft);
    if ((v.base_version_id ?? null) !== live) {
      throw stale(name, v.base_version_id ? (await this.kolab.version(v.base_version_id)).seq : null, live ? (await this.kolab.version(live)).seq : null);
    }
    return this.kolab.readAs(s, async (q) => ({
      unlink: live ? (await q.query<{ id: string }>(
        `select e.id from edge e join version t on t.id = e.target_version_id
          where e.source_version_id = $1 and exists (select 1 from link_removal r where r.version_id = $2 and r.kind = e.kind
            and r.source_element_id is not distinct from e.source_element_id and r.target_node_id = t.node_id
            and r.target_element_id is not distinct from e.target_element_id and r.target_selector is not distinct from e.target_selector)`,
        [live, draft])).rows.map((r) => r.id) : [],
      links: (await q.query<{ kind: 'derivation' | 'dependency' | 'equivalence'; source_element_id: string | null; target_version_id: string; target_element_id: string | null; target_selector: QuoteSelector | null }>(
        `select kind, source_element_id, target_version_id, target_element_id, target_selector from edge where source_version_id = $1 order by id`,
        [draft])).rows,
    }));
  }

  private async ownDraft(s: string, name: string, seq: number): Promise<string> {
    const v = await this.kolab.versionIn(s, { node: name, version: seq }, { allowDraft: true, what: 'replacing a draft' });
    const me = await this.kolab.sessionInfo(s);
    if (v.actor_id !== me.actor) throw bad(`${name}@${seq} isn't a draft of yours`);
    // Settled already: resubmitted or replaced in another tab, or by a click a moment ago.
    if (v.state !== 'drafted') throw conflict(`${name}@${seq} was resubmitted or replaced meanwhile, so it can't be replaced: read the node again`);
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
   * Kolab ends the session and opens one in the chosen kolab and role in one transaction, so a
   * kolab the person can't reach, or any failure, leaves the session as it was (ENF4: one open
   * session per actor). The new token goes only into the cookie.
   */
  async switchTo(s: string, b: WebSwitch): Promise<string> {
    if (!ROLES.includes(b?.role)) throw bad(`the role is one of ${ROLES.join(', ')}`);
    if (typeof b.kolab !== 'string' || !isKolabName(b.kolab)) throw bad('name the kolab');
    return this.kolab.switchSession(s, { kolab: b.kolab, role: b.role });
  }

  /**
   * A private kolab of the person's own (D54), with the limits Kolab enforces (createOwnKolab:
   * Write where they work, the name grammar and reserved names, a title of at most 100
   * characters, a cap per person and a rate), which the person then works in, in the same role.
   * Returns the new session's token, for the cookie.
   */
  async createKolab(s: string, b: WebCreateKolab): Promise<string> {
    if (typeof b?.name !== 'string' || typeof b.title !== 'string') throw bad('give the kolab a short name and a name people read');
    const me = await this.me(s);
    await this.kolab.createOwnKolab(s, b.name, { title: b.title });
    return this.switchTo(s, { kolab: b.name, role: me.role });
  }

  // ---- invites (W3.4): Kolab decides who may make, list, revoke and accept one ----

  async invites(s: string): Promise<WebInvitesView> {
    return { invites: await this.kolab.listInvites(s) };
  }

  /** A new invite to the session's kolab: its secret, shown this once, for the page to make a link of. */
  async createInvite(s: string, b: WebCreateInvite): Promise<WebInviteMade> {
    if (!INVITE_LEVELS.includes(b?.level)) throw bad(`an invite grants one of ${INVITE_LEVELS.join(', ')}`);
    if (b.layers !== undefined && (!Array.isArray(b.layers) || b.layers.some((l) => !LAYERS.includes(l)))) throw bad(`an invite's layers are ${LAYERS.join(' and ')}`);
    return this.kolab.createInvite(s, { level: b.level, layers: b.layers });
  }

  async revokeInvite(s: string, id: string): Promise<void> {
    await this.kolab.revokeInvite(s, id);
  }

  // ---- who holds access (W3.6): Kolab decides who may see and change it ----

  async access(s: string): Promise<KolabAccessView> {
    return this.kolab.listAccess(s);
  }

  /** A person's or agent's direct grant on the session's kolab, to another level. */
  async changeGrant(s: string, actor: string, b: WebChangeGrant): Promise<WebAccessChanged> {
    if (!ACCESS_LEVELS.includes(b?.level)) throw bad(`a level is one of ${ACCESS_LEVELS.join(', ')}`);
    if (b.layers !== undefined && (!Array.isArray(b.layers) || b.layers.some((l) => !LAYERS.includes(l)))) throw bad(`a grant's layers are ${LAYERS.join(' and ')}`);
    return this.kolab.changeGrant(s, actor, b.level, { layers: b.layers });
  }

  /** A person's or agent's direct grant on the session's kolab, removed. */
  async removeGrant(s: string, actor: string): Promise<WebAccessChanged> {
    return this.kolab.removeGrant(s, actor);
  }

  /**
   * The signed-in person accepts an invite: they are granted its access, and the session moves to
   * its kolab in the same role. Returns the new session's token, for the cookie.
   */
  async acceptInvite(s: string, token: unknown): Promise<string> {
    if (typeof token !== 'string' || !token.trim()) throw bad('give the invite');
    const me = await this.me(s);
    const { kolab } = await this.kolab.acceptInvite(token.trim(), me.actor);
    return this.kolab.switchSession(s, { kolab, role: me.role });
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
const conflict = (message: string) => new ConflictException({ error: 'conflict', message });
/** The same refusal for a kolab the session can't read and a node that isn't there (TEN12, D49). */
const notThere = (kolab: string, name: string) => new NotFoundException({ error: 'not_found', message: `no node ${name} in kolab ${kolab}` });
/** An element's id as an address carries it: no "/", "@", "#", "~" or whitespace, which the grammar uses. */
const isElementId = (e: unknown): e is string => typeof e === 'string' && /^[^/@#~\s]+$/.test(e);
/** A ruling's text: Kolab checks it isn't empty. */
function textOf(t: unknown): string {
  if (typeof t !== 'string') throw bad('write the ruling, as text');
  return t;
}
/** What a ruling replaces, if anything, as text. */
function replacesOf(b: { replaces?: unknown }): string | undefined {
  if (b.replaces === undefined || b.replaces === null) return undefined;
  if (typeof b.replaces !== 'string') throw bad('say what it replaces, as text');
  return b.replaces.trim() || undefined;
}
/** A position's evidence, as a list of strings: Kolab checks each kj: address resolves. */
function evidenceOf(e: unknown): string[] {
  if (!Array.isArray(e) || e.some((x) => typeof x !== 'string')) throw bad('evidence is a list: kj: addresses, and anything else as text');
  return e.map((x: string) => x.trim()).filter(Boolean);
}
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
  if (/^(no (node|version|query|mark|actor|case file|ruling) |[^ ]+ has no (committed )?version|cannot ask about )|^kj:\S+ doesn't exist$/.test(message)) return new NotFoundException({ error: 'not_found', message });
  // A malformed address (a quote selector that isn't JSON included), or evidence that doesn't resolve: the request is wrong, not Kolab.
  if (e instanceof SyntaxError) return new BadRequestException({ error: 'bad_request', message: `not a Konjir address: ${message}` });
  if (/^(not a Konjir address|a selector needs an element|evidence \S+ does not resolve)/.test(message)) return new BadRequestException({ error: 'bad_request', message });
  logger.error(`the web API failed: ${message}`);
  return new HttpException({ error: 'error', message: 'Kolab could not do that. It has been logged; try again, or tell whoever runs Kolab.' }, 500);
}

const version = (v: VersionHistoryRow, me: string): WebVersion =>
  ({ seq: v.seq, state: v.state, author: v.actor, role: v.role, at: v.at, note: v.note, mine: v.actor === me, base: v.base_seq });

const link = (l: LinkRow): WebLink => ({
  edge: l.edge, kind: l.kind,
  source: { node: l.source_node, seq: l.source_seq, element: l.source_element, layer: l.source_layer as Layer },
  target: { node: l.target_node, seq: l.target_seq, element: l.target_element, quote: l.target_selector?.exact ?? null, latest: l.target_latest },
  mark: l.mark_id ? { id: l.mark_id, reason: l.mark_reason! } : null,
});

/** What an address names, taken apart: a ruling's or case file's subject. */
function subject(on: string) {
  const a = parseAddress(on);
  return { node: a.node, seq: a.version ?? 0, element: a.element ?? null };
}

const ruling = (r: RulingView): WebRuling => ({ ...r, ...subject(r.on) });

/** A question on another kolab's node, as its reader sees it: its address in the full form, and no mark (D49). */
const foreignQuery = (q: WebQuery, kolab: string): WebQuery => ({
  ...q, address: formatAddress({ kolab, node: q.node, version: q.seq, element: q.element ?? undefined }),
  from: null, mark: null, mark_reason: null,
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
