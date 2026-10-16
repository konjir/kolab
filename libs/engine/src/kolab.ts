import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import {
  type Address, type QuoteSelector, fingerprint, formatAddress, MAX_QUOTE, normalize, parseAddress, resolveSpan,
} from '@konjir/address';
import { migrate, openDb, type Db } from '@konjir/db';
import {
  LAYER_OF_KIND, LAYER_OF_ROLE,
  type Actor, type ActorKind, type Author,
  type DeltaInput, type DeltaKind, type ElementInput, type ElementRow, type Finding, type GateResult, type Kind, type KolabEvent, type Layer,
  type MarkRow, type OverrideResolution, type Query, type QueryKind, type QueryState, type Resolution, type ReviewContext, type ReviewVerdict,
  type Reviewer, type Role, type VersionRow,
} from '@konjir/types';

// ---------------------------------------------------------------------------
// Row types used only inside the engine (shared types are in @konjir/types)
// ---------------------------------------------------------------------------

interface DeltaRow {
  id: string; version_id: string; element_id: string; kind: DeltaKind;
  text: string | null; parent_element_id: string | null; ord: number | null;
  base_version_id: string | null; base_fingerprint: string | null;
  state: 'clean' | 'dirty' | 'orphaned';
}
interface EdgeRow {
  id: string; kind: string; source_version_id: string; source_element_id: string | null;
  target_version_id: string; target_element_id: string | null;
  target_selector: QuoteSelector | null; target_fingerprint: string;
}

/** Thrown by a reviewer that could not run (model outage, throttling). The draft stays drafted and can be resubmitted. */
export class ReviewUnavailableError extends Error { name = 'ReviewUnavailableError'; }

export class RoleError extends Error { name = 'RoleError'; }
/**
 * About actors and their sessions: an actor that doesn't exist or already does, an invalid id,
 * an agent whose owner isn't a person, or an actor whose session is already open.
 */
export class ActorError extends Error { name = 'ActorError'; }

/** An actor id: letters, digits, '.', '_', '-' and '@', starting with a letter or digit (actor_id_check). */
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
/** The author of Kolab's own work, in the role 'system'. Never an actor. */
export const SYSTEM_ACTOR = 'kolab';
export class GateError extends Error { name = 'GateError'; }

type Q = Pick<Db, 'query' | 'exec'>;

// ---------------------------------------------------------------------------
// Kolab
// ---------------------------------------------------------------------------

export class Kolab {
  private constructor(readonly db: Db, private reviewer: Reviewer) {}

  private listeners = new Set<(e: KolabEvent) => void>();

  /**
   * Postgres at `databaseUrl`; otherwise PGlite, in memory by default or persisted to `dataDir`
   * across restarts. The database is first brought to the newest migration (DAT2).
   */
  static async open(opts: { reviewer?: Reviewer; dataDir?: string; databaseUrl?: string } = {}): Promise<Kolab> {
    const db = openDb(opts);
    try {
      await migrate(db);
    } catch (e) {
      await db.close().catch(() => undefined);
      throw e;
    }
    return new Kolab(db, opts.reviewer ?? structuralReviewer);
  }

  async close() { await this.db.close(); }

  /** Be told when an inbox gains or loses work. Returns an unsubscribe function. */
  onEvent(fn: (e: KolabEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(e: KolabEvent) {
    for (const fn of this.listeners) {
      try { fn(e); } catch { /* a listener's failure never fails a write */ }
    }
  }

  private async emitForVersion(versionId: string) {
    this.emit({ inbox: 'layer', layer: (await this.version(versionId)).layer });
  }

  // ---- write contexts ------------------------------------------------------

  /** Agent writes run as kj_agent; row-level security re-checks the layer. */
  private asAgent<T>(sessionId: string, fn: (tx: Q) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.exec('set local role kj_agent');
      await tx.query(`select set_config('kj.session', $1, true)`, [sessionId]);
      return fn(tx);
    });
  }

  /** Kolab's own work: rebases, review transitions, the cascade. */
  private asSystem<T>(fn: (tx: Q) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.exec('set local role kj_system');
      return fn(tx);
    });
  }

  // ---- actors and sessions (dynamic separation of duty) --------------------

  /**
   * Registers a person, or with `owner` an agent owned by that person (D30). An agent is an
   * actor of its own: it holds its own sessions and authors its own versions.
   */
  async addActor(id: string, opts: { name?: string; owner?: string } = {}) {
    const { name = id, owner } = opts;
    if (!ACTOR_ID.test(id)) throw new ActorError(`"${id}" isn't a valid actor id: use letters, digits, '.', '_', '-' and '@', starting with a letter or digit`);
    if (id === SYSTEM_ACTOR) throw new ActorError(`"${SYSTEM_ACTOR}" is reserved for Kolab's own work`);
    if (await this.findActor(id)) throw new ActorError(`actor ${id} already exists`);
    if (owner !== undefined) {
      const o = await this.findActor(owner);
      if (!o) throw new ActorError(`no actor ${owner} to own ${id}`);
      if (o.kind !== 'person') throw new ActorError(`${owner} is an agent; an agent's owner must be a person`);
    }
    try {
      await this.db.query(`insert into actor(id, name, kind, owner_id) values ($1, $2, $3, $4)`,
        [id, name, owner === undefined ? 'person' : 'agent', owner ?? null]);
    } catch (e) {
      // Another admin call added it between the check and the insert.
      if (String(e).includes('actor_pkey')) throw new ActorError(`actor ${id} already exists`);
      throw e;
    }
  }

  private async findActor(id: string): Promise<Actor | undefined> {
    return (await this.db.query<Actor>(
      `select id, name, kind, owner_id as owner from actor where id = $1`, [id])).rows[0];
  }

  /** An actor, with the person who owns it when it's an agent. */
  async actor(id: string): Promise<Actor> {
    const a = await this.findActor(id);
    if (!a) throw new ActorError(`no actor ${id}`);
    return a;
  }

  /** Every actor, or with `owner` that person's agents. */
  async listActors(opts: { owner?: string } = {}): Promise<Actor[]> {
    return (await this.db.query<Actor>(
      `select id, name, kind, owner_id as owner from actor
        where $1::text is null or owner_id = $1 order by id`, [opts.owner ?? null])).rows;
  }

  /**
   * Who wrote a version: its actor, that actor's owner, and the role it acted in (ROL4).
   * Two agents of one person are different authors with the same owner (D25, D33).
   */
  async author(versionId: string): Promise<Author> {
    const v = await this.version(versionId);
    if (v.active_role === 'system') return { actor: v.actor_id, kind: 'system', owner: null, role: v.active_role };
    const a = await this.findActor(v.actor_id);
    if (!a) throw new ActorError(`version ${versionId} names actor ${v.actor_id}, who doesn't exist`);
    return { actor: v.actor_id, kind: a.kind, owner: a.owner, role: v.active_role };
  }

  /**
   * The session id doubles as the agent's bearer token, so it is random, not a sortable ULID.
   * Each actor holds at most one open session (ENF4), so a person's agents each hold their own.
   *
   * An agent may never have more access than its owner grants it (D30). Until grants exist
   * (W1.3), any actor may activate either role, so there is nothing of the owner's to exceed.
   */
  async openSession(actorId: string, role: Role): Promise<string> {
    if (!(await this.findActor(actorId))) throw new ActorError(`no actor ${actorId}; add it first`);
    const id = `kjs_${randomBytes(24).toString('base64url')}`;
    try {
      await this.db.query(`insert into session(id, actor_id, active_role) values ($1, $2, $3)`, [id, actorId, role]);
    } catch (e) {
      if (String(e).includes('one_open_session_per_actor')) {
        throw new ActorError(`${actorId} already has an open session; end it before opening another`);
      }
      throw e;
    }
    return id;
  }

  async endSession(id: string) {
    await this.db.query(`update session set ended_at = now() where id = $1`, [id]);
  }

  private async session(id: string): Promise<{ actor_id: string; active_role: Role; kind: ActorKind; owner: string | null }> {
    const r = await this.db.query<{ actor_id: string; active_role: Role; kind: ActorKind; owner: string | null }>(
      `select s.actor_id, s.active_role, a.kind, a.owner_id as owner
         from session s join actor a on a.id = s.actor_id
        where s.id = $1 and s.ended_at is null`, [id]);
    if (!r.rows[0]) throw new RoleError(`no open session ${id}`);
    return r.rows[0];
  }

  private async requireLayer(sessionId: string, layer: Layer) {
    const s = await this.session(sessionId);
    if (LAYER_OF_ROLE[s.active_role] !== layer) {
      throw new RoleError(`a ${s.active_role} session may not write the ${layer} layer`);
    }
    return s;
  }

  // ---- nodes and versions --------------------------------------------------

  async createNode(sessionId: string, kind: Kind, title: string, id: string = ulid()): Promise<string> {
    await this.requireLayer(sessionId, LAYER_OF_KIND[kind]);
    await this.db.query(`insert into node(id, kind, layer, title) values ($1, $2, $3, $4)`,
      [id, kind, LAYER_OF_KIND[kind], title]);
    return id;
  }

  async version(id: string): Promise<VersionRow> {
    const r = await this.db.query<VersionRow>(`select * from version where id = $1`, [id]);
    if (!r.rows[0]) throw new Error(`no version ${id}`);
    return r.rows[0];
  }

  async latestCommitted(nodeId: string): Promise<VersionRow | undefined> {
    const r = await this.db.query<VersionRow>(
      `select * from version where node_id = $1 and state = 'committed' order by seq desc limit 1`, [nodeId]);
    return r.rows[0];
  }

  async elements(versionId: string): Promise<ElementRow[]> {
    const r = await this.db.query<ElementRow>(
      `select element_id, parent_element_id, ord, text, fingerprint from element where version_id = $1 order by ord`,
      [versionId]);
    return r.rows;
  }

  private async deltas(versionId: string): Promise<DeltaRow[]> {
    const r = await this.db.query<DeltaRow>(`select * from delta where version_id = $1`, [versionId]);
    return r.rows;
  }

  /**
   * Draft a new version. Give either full `elements` (Kolab diffs them into
   * a delta against the parent) or explicit `deltas` (a variant's exceptions).
   * `parent` defaults to this node's latest committed version.
   */
  async draft(sessionId: string, nodeId: string,
    input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string }): Promise<string> {
    const node = await this.node(nodeId);
    const s = await this.requireLayer(sessionId, node.layer);

    // A variant's new version keeps its foreign parent and carries its
    // existing exceptions forward; a plain node's parent is its own last version.
    const latest = await this.latestCommitted(nodeId);
    let parentId = input.parent ?? latest?.id ?? null;
    let carried: Omit<DeltaRow, 'id' | 'version_id'>[] = [];
    if (!input.parent && latest?.parent_version_id
        && (await this.version(latest.parent_version_id)).node_id !== nodeId) {
      parentId = latest.parent_version_id;
      if (!input.elements) {
        const touched = new Set((input.deltas ?? []).map((d) => d.element));
        carried = (await this.deltas(latest.id))
          .filter((d) => !touched.has(d.element_id))
          .map(({ id: _i, version_id: _v, ...rest }) => rest);
      }
    }
    let parentEls: ElementRow[] = [];
    if (parentId) {
      const p = await this.version(parentId);
      if (p.state !== 'committed') throw new GateError(`parent ${parentId} has not cleared review`);
      await this.refuseCycle(nodeId, parentId);
      parentEls = await this.elements(parentId);
    }

    let deltaRows: Omit<DeltaRow, 'id' | 'version_id'>[];
    if (input.elements) {
      deltaRows = diff(parentEls, input.elements.map((e) => ({ ...e, id: e.id ?? ulid() })), parentId);
    } else {
      const byId = new Map(parentEls.map((e) => [e.element_id, e]));
      deltaRows = [...carried, ...(input.deltas ?? []).map((d) => {
        const base = byId.get(d.element);
        if (d.kind !== 'add' && !base) throw new Error(`cannot ${d.kind} ${d.element}: not in parent`);
        return {
          element_id: d.element, kind: d.kind, text: d.text ?? null,
          parent_element_id: d.parent ?? base?.parent_element_id ?? null, ord: null,
          base_version_id: d.kind === 'add' ? null : parentId,
          base_fingerprint: base?.fingerprint ?? null, state: 'clean' as const,
        };
      })];
    }

    const els = materialize(parentEls, deltaRows);
    const id = ulid();
    const seq = await this.nextSeq(nodeId);
    await this.asAgent(sessionId, (tx) => writeVersion(tx, {
      id, node_id: nodeId, seq, parent_version_id: parentId, layer: node.layer,
      actor_id: s.actor_id, active_role: s.active_role,
    }, els, deltaRows));
    return id;
  }

  /**
   * The review gate: drafted -> committed | rejected. Commit runs the cascade.
   *
   * Optimistic concurrency: if the node committed newer versions while this
   * draft was open, the draft is stale. When those newer versions are only the
   * kolab's own rebases, nothing human is lost: the draft is folded into a fresh
   * rebase onto the current parent. Otherwise it is rejected for redrafting.
   * The result names the version that actually committed.
   */
  async review(versionId: string): Promise<GateResult> {
    const v = await this.version(versionId);
    if (v.state !== 'drafted') throw new GateError(`${versionId} is ${v.state}, not drafted`);
    const newer = await this.db.query<{ active_role: string }>(
      `select active_role from version where node_id = $1 and seq > $2 and state = 'committed'`, [v.node_id, v.seq]);
    if (newer.rows.length) {
      const human = newer.rows.some((r) => r.active_role !== 'system');
      const parent = v.parent_version_id ? await this.version(v.parent_version_id) : undefined;
      if (human || !parent || parent.node_id === v.node_id) {
        const note = 'stale draft: the node committed a newer version; redraft against it';
        await this.setState(versionId, 'rejected', note);
        return { ok: false, note, version: versionId };
      }
      const latestParent = (await this.latestCommitted(parent.node_id))!;
      // Folding keeps the draft's authorship (so a later stale draft still sees a
      // human commit and is rejected) and the dependencies the draft declared.
      const folded = await this.rebase(v, latestParent, { author: v, edgesFrom: v.id });
      await this.setState(versionId, 'rejected', `folded into ${folded.version}`);
      return folded;
    }
    let verdict: ReviewVerdict;
    try {
      verdict = await this.reviewer(await this.reviewContext(v));
    } catch (e) {
      if (e instanceof ReviewUnavailableError) {
        return { ok: false, note: `Review could not run: ${e.message}. The draft is unchanged; resubmit it later.`, version: versionId, retryable: true };
      }
      throw e;
    }
    await this.setState(versionId, verdict.ok ? 'committed' : 'rejected', verdict.note ?? null);
    if (verdict.ok) {
      await this.onCommit(versionId);
      await this.raiseLayerLeaks(v, verdict.findings ?? []);
    }
    return { ...verdict, version: versionId };
  }

  private async reviewContext(v: VersionRow): Promise<ReviewContext> {
    const edges = await this.db.query<EdgeRow & { tnode: string; tseq: number }>(
      `select e.*, t.node_id as tnode, t.seq as tseq from edge e join version t on t.id = e.target_version_id
        where e.source_version_id = $1 order by e.id`, [v.id]);
    const upstream = [];
    for (const e of edges.rows) {
      const r = await this.resolveIn(e.target_version_id, e.target_element_id, e.target_selector);
      upstream.push({
        element: e.source_element_id,
        target: formatAddress({ node: e.tnode, version: e.tseq, element: e.target_element_id ?? undefined, selector: e.target_selector ?? undefined }),
        text: r.status === 'orphan' || !e.target_element_id ? null : r.content,
      });
    }
    return { version: v, elements: await this.elements(v.id), node: await this.node(v.node_id), upstream };
  }

  /**
   * Layer leaks commit, then ask. A functional spec that names implementation
   * asks its own author to rewrite. A binding that changes behavior asks the
   * spec it links to, since only the functional layer can approve behavior.
   */
  private async raiseLayerLeaks(v: VersionRow, findings: Finding[]) {
    const node = await this.node(v.node_id);
    for (const f of findings.filter((x) => x.kind === 'layer_leak')) {
      const element = f.elements[0] ?? null;
      const markId = await this.mark({ version_id: v.id, element_id: element, triggered_by: v.id, reason: 'role_boundary', note: f.explanation });
      const here = formatAddress({ node: v.node_id, version: v.seq, element: element ?? undefined });
      if (node.layer === 'functional') {
        await this.ask(v.id, element, markId,
          `The review gate thinks ${here} specifies implementation, not behavior: ${f.explanation} Rewrite it as behavior, or answer to keep it as is.`);
        continue;
      }
      const link = (await this.db.query<{ target_version_id: string; target_element_id: string | null; tnode: string; tseq: number }>(
        `select e.target_version_id, e.target_element_id, t.node_id as tnode, t.seq as tseq
           from edge e join version t on t.id = e.target_version_id
          where e.source_version_id = $1 and e.source_element_id is not distinct from $2 and t.layer = 'functional'
          order by e.id limit 1`, [v.id, element])).rows[0];
      const spec = link ? formatAddress({ node: link.tnode, version: link.tseq, element: link.target_element_id ?? undefined }) : 'the spec';
      await this.ask(link?.target_version_id ?? v.id, link?.target_element_id ?? element, markId,
        `The review gate thinks binding ${here} changes behavior beyond ${spec}: ${f.explanation} If this behavior is intended, amend the spec and answer; if not, answer "no" and the binding must change.`);
    }
  }

  private async setState(versionId: string, state: 'committed' | 'rejected', note: string | null) {
    await this.asSystem((tx) => tx.query(`update version set state = $2, review_note = $3 where id = $1`,
      [versionId, state, note]));
  }

  /** draft + review, for callers that don't need the two steps apart. Returns the committed version. */
  async commit(sessionId: string, nodeId: string,
    input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string }): Promise<string> {
    const id = await this.draft(sessionId, nodeId, input);
    const result = await this.review(id);
    if (!result.ok) throw new GateError(`review rejected: ${result.note ?? ''}`);
    return result.version;
  }

  // ---- addressing ----------------------------------------------------------

  /** Resolve an address (string or object) to content + fingerprint. */
  async resolve(address: Address | string): Promise<Resolution & { versionId?: string }> {
    const a = typeof address === 'string' ? parseAddress(address) : address;
    let v: VersionRow | undefined;
    if (a.version !== undefined) {
      const r = await this.db.query<VersionRow>(`select * from version where node_id = $1 and seq = $2`, [a.node, a.version]);
      v = r.rows[0];
    } else {
      v = await this.latestCommitted(a.node);
    }
    if (!v) return { status: 'orphan' };
    return { ...(await this.resolveIn(v.id, a.element ?? null, a.selector ?? null)), versionId: v.id };
  }

  async resolveIn(versionId: string, elementId: string | null, selector: QuoteSelector | null): Promise<Resolution> {
    const els = await this.elements(versionId);
    if (!elementId) {
      const content = els.map((e) => `${e.element_id}:${e.parent_element_id ?? ''}:${e.fingerprint}`).join('\n');
      return { status: 'ok', content, fingerprint: fingerprint(content) };
    }
    const subtree = subtreeText(els, elementId);
    if (subtree === undefined) return { status: 'orphan' };
    if (!selector) return { status: 'ok', content: subtree, fingerprint: fingerprint(subtree) };
    const span = resolveSpan(subtree, selector);
    if (span.status === 'orphan') return { status: 'orphan' };
    return {
      status: span.status === 'exact' ? 'ok' : 'fuzzy',
      content: span.content,
      fingerprint: fingerprint(span.content),
    };
  }

  // ---- edges ---------------------------------------------------------------

  async link(sessionId: string, e: {
    kind: 'derivation' | 'dependency' | 'equivalence';
    source: string; sourceElement?: string;
    target: string; targetElement?: string; selector?: QuoteSelector;
  }): Promise<string> {
    const src = await this.version(e.source);
    await this.requireLayer(sessionId, src.layer);
    const tgt = await this.version(e.target);
    if (tgt.state !== 'committed') {
      throw new GateError(`nothing may derive from ${e.target}: it has not cleared review`);
    }
    if (e.selector && normalize(e.selector.exact).length > MAX_QUOTE) {
      throw new Error(`the quote is ${normalize(e.selector.exact).length} characters; quote at most ${MAX_QUOTE}: `
        + `the few words you rely on, with several words either side as prefix and suffix. `
        + `To rely on a whole requirement, link to its element instead, without a selector.`);
    }
    const r = await this.resolveIn(e.target, e.targetElement ?? null, e.selector ?? null);
    if (r.status !== 'ok') throw new Error(await this.linkRefusal(tgt, e.targetElement ?? null, e.selector ?? null, r.status));
    // One edge per (source scope, target scope): duplicates would multiply marks.
    const dup = await this.db.query<{ id: string }>(
      `select id from edge where kind = $1 and source_version_id = $2
          and source_element_id is not distinct from $3 and target_version_id = $4
          and target_element_id is not distinct from $5 and target_selector is not distinct from $6::jsonb`,
      [e.kind, e.source, e.sourceElement ?? null, e.target, e.targetElement ?? null,
        e.selector ? JSON.stringify(e.selector) : null]);
    if (dup.rows[0]) return dup.rows[0].id;
    const id = ulid();
    await this.asAgent(sessionId, (tx) => tx.query(
      `insert into edge(id, kind, source_version_id, source_element_id, target_version_id,
                        target_element_id, target_selector, target_fingerprint)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, e.kind, e.source, e.sourceElement ?? null, e.target, e.targetElement ?? null,
        e.selector ? JSON.stringify(e.selector) : null, r.fingerprint]));
    return id;
  }

  /**
   * Why a link target doesn't resolve exactly, and how to fix it. A quoted span must stand as
   * written with its prefix or suffix still around it (D42), so a selector that is fuzzy is a bad
   * selector: the refusal quotes the current words with their current context to link to instead.
   */
  private async linkRefusal(tgt: VersionRow, elementId: string | null, selector: QuoteSelector | null,
    status: 'fuzzy' | 'orphan'): Promise<string> {
    const at = (sel?: QuoteSelector) => formatAddress({ node: tgt.node_id, version: tgt.seq, element: elementId ?? undefined, selector: sel });
    const subtree = elementId ? subtreeText(await this.elements(tgt.id), elementId) : undefined;
    if (subtree === undefined) {
      return `target does not resolve exactly (orphan): ${at()} has no element ${elementId}. Read the target with konjir_read_node and link to an element it has.`;
    }
    const span = selector ? resolveSpan(subtree, selector) : undefined;
    if (span?.status === 'fuzzy') {
      const text = normalize(subtree);
      const suggestion = { exact: span.content, ...spanContext(text, span.start, span.end) };
      return `target does not resolve exactly (fuzzy): ${JSON.stringify(normalize(selector!.exact))} does not stand as quoted `
        + `with its prefix or suffix in ${at()}; the nearest match reads ${JSON.stringify(span.content)}. `
        + `A prefix or suffix of one word or of punctuation is too little to tell. `
        + `Quote the current words with several words of their current context either side, e.g. ${at(suggestion)}`;
    }
    return `target does not resolve exactly (${status}): the quoted words are not in ${at()}. `
      + `Read the element with konjir_read_node and quote words it has now, with the words just before and after them as prefix and suffix.`;
  }

  // ---- the cascade ---------------------------------------------------------

  private async onCommit(versionId: string) {
    const v = await this.version(versionId);
    await this.supersedePrevious(v);
    await this.markStaleOverrides(v);
    await this.clearAddressed(v);
    const direct: string[] = [];

    // 1. Direct: every live edge pinned to an older version of this node.
    const inbound = await this.db.query<EdgeRow>(
      `select e.* from edge e
         join version t on t.id = e.target_version_id
         join version s on s.id = e.source_version_id
        where t.node_id = $1 and e.target_version_id <> $2
          and ${LIVE('s')}
          and not exists (select 1 from invalidation i where i.edge_id = e.id and i.state = 'open')`,
      [v.node_id, v.id]);
    for (const e of inbound.rows) {
      const markId = await this.checkEdge(e, v.id);
      if (markId) direct.push(markId);
    }

    // 2. Catch-up: if this version was drafted while its upstream moved on, its
    //    outbound edges may be pinned to targets that are no longer current.
    const outbound = await this.db.query<EdgeRow & { latest: string }>(
      `select e.*, (select l.id from version l where l.node_id = t.node_id and l.state = 'committed'
                     order by l.seq desc limit 1) as latest
         from edge e join version t on t.id = e.target_version_id
        where e.source_version_id = $1
          and not exists (select 1 from invalidation i where i.edge_id = e.id and i.state = 'open')`,
      [v.id]);
    for (const e of outbound.rows) {
      if (e.latest === e.target_version_id) continue;
      const markId = await this.checkEdge(e, e.latest);
      if (markId) direct.push(markId);
    }

    // 3. Transitive marks, one walk per direct mark, deduplicated across walks.
    for (const markId of direct) await this.propagate(markId);

    // 4. Children (variants) of an older version of this node rebase onto it.
    const children = await this.db.query<VersionRow>(
      `select c.* from version c join version p on p.id = c.parent_version_id
        where p.node_id = $1 and c.node_id <> $1 and p.id <> $2 and c.state = 'committed'
          and ${LIVE('c')}`,
      [v.node_id, v.id]);
    for (const c of children.rows) await this.rebase(c, v);

    // 5. Catch-up for this version itself: drafted against a parent that has since moved on.
    if (v.parent_version_id) {
      const p = await this.version(v.parent_version_id);
      if (p.node_id !== v.node_id) {
        const latestParent = (await this.latestCommitted(p.node_id))!;
        const live = (await this.latestCommitted(v.node_id))!;
        if (latestParent.id !== p.id && live.id === v.id) await this.rebase(v, latestParent);
      }
    }
  }

  /** Re-resolve an edge against a newer target version: re-pin if unchanged, else mark. */
  private async checkEdge(e: EdgeRow, against: string): Promise<string | null> {
    const r = await this.resolveIn(against, e.target_element_id, e.target_selector);
    if (r.status === 'ok' && r.fingerprint === e.target_fingerprint) {
      // Content-identical: a cheap pointer bump, not a regeneration.
      await this.asSystem((tx) => tx.query(`update edge set target_version_id = $2 where id = $1`, [e.id, against]));
      return null;
    }
    const reason = r.status === 'orphan' ? 'orphaned' : r.status === 'fuzzy' ? 'fuzzy_reanchor' : 'changed';
    return this.mark({
      version_id: e.source_version_id, element_id: e.source_element_id, edge_id: e.id,
      triggered_by: against, reason,
    });
  }

  /**
   * Transitive marks: walk edges downstream of a dirty (version, element).
   * A (version, element) already marked by this commit gets another cause
   * rather than a second mark; it clears only when every cause has cleared.
   * The walk never re-enters the change itself: the element of the triggering
   * version that changed (its whole version, if the edge addressed all of it).
   * Other elements of the triggering version are reachable like any other.
   */
  private async propagate(markId: string) {
    const m = await this.markRow(markId);
    const changed = m.edge_id
      ? (await this.db.query<{ target_element_id: string | null }>(
          `select target_element_id from edge where id = $1`, [m.edge_id])).rows[0]?.target_element_id ?? null
      : null;
    const r = await this.db.query<{ version_id: string; element_id: string | null }>(
      `with recursive walk(version_id, element_id) as (
         select $1::text, $2::text
         union
         select e.source_version_id, e.source_element_id
           from edge e
           join walk w on e.target_version_id = w.version_id
           join version s on s.id = e.source_version_id
          where (w.element_id is null or e.target_element_id is null or e.target_element_id = w.element_id)
            and not (e.source_version_id = $3 and ($4::text is null or e.source_element_id is not distinct from $4::text))
            and ${LIVE('s')}
       )
       select version_id, element_id from walk
        where not (version_id = $1 and element_id is not distinct from $2)`,
      [m.version_id, m.element_id, m.triggered_by, changed]);
    for (const row of r.rows) {
      const existing = await this.db.query<{ id: string }>(
        `select id from invalidation where version_id = $1 and element_id is not distinct from $2
            and triggered_by = $3 and reason = 'upstream_dirty' and state = 'open'`,
        [row.version_id, row.element_id, m.triggered_by]);
      const target = existing.rows[0]?.id
        ?? await this.mark({ ...row, triggered_by: m.triggered_by, reason: 'upstream_dirty' });
      await this.asSystem((tx) => tx.query(
        `insert into invalidation_cause(mark_id, cause_id) values ($1, $2) on conflict do nothing`, [target, markId]));
    }
  }

  // ---- overrides: the three-way rule ---------------------------------------

  private async rebase(child: VersionRow, newParent: VersionRow,
    opts: { author?: Pick<VersionRow, 'actor_id' | 'active_role'>; edgesFrom?: string } = {}): Promise<GateResult> {
    const parentEls = await this.elements(newParent.id);
    const byId = new Map(parentEls.map((e) => [e.element_id, e]));
    const oldEls = new Map((await this.elements(child.id)).map((e) => [e.element_id, e]));
    const kept: Omit<DeltaRow, 'id' | 'version_id'>[] = [];

    for (const d of await this.deltas(child.id)) {
      const { id: _id, version_id: _v, ...rest } = d;
      if (d.kind === 'add') { kept.push(rest); continue; }
      const pe = byId.get(d.element_id);

      if (!pe) {
        if (d.kind === 'remove') continue; // parent removed it too: converged
        const old = oldEls.get(d.element_id)!;
        kept.push({ ...rest, parent_element_id: old.parent_element_id, ord: old.ord, state: 'orphaned' });
        continue;
      }
      if (pe.fingerprint === d.base_fingerprint) {
        // Parent's text is what the override was written against (or reverted to it).
        kept.push({ ...rest, base_version_id: newParent.id, state: 'clean' });
        continue;
      }
      if (d.kind === 'override' && fingerprint(d.text!) === pe.fingerprint) continue; // converged

      const childFp = d.kind === 'remove' ? 'REMOVED' : fingerprint(d.text!);
      const p = await this.db.query<{ resolution: OverrideResolution; amended_text: string | null }>(
        `select resolution, amended_text from precedent
          where base_fingerprint = $1 and parent_fingerprint = $2 and child_fingerprint = $3`,
        [d.base_fingerprint, pe.fingerprint, childFp]);
      const prec = p.rows[0];
      if (prec?.resolution === 'adopt_parent') continue;
      if (prec) {
        kept.push({
          ...rest, text: prec.resolution === 'amend' ? prec.amended_text : d.text,
          base_version_id: newParent.id, base_fingerprint: pe.fingerprint, state: 'clean',
        });
        continue;
      }
      kept.push({ ...rest, state: 'dirty' }); // the override still stands; base stays where it was
    }

    const id = ulid();
    const seq = await this.nextSeq(child.node_id);
    const els = materialize(parentEls, kept);
    await this.asSystem(async (tx) => {
      await writeVersion(tx, {
        id, node_id: child.node_id, seq, parent_version_id: newParent.id, layer: child.layer,
        actor_id: opts.author?.actor_id ?? SYSTEM_ACTOR, active_role: opts.author?.active_role ?? 'system',
      }, els, kept);
      if (opts.edgesFrom) await copyEdges(tx, opts.edgesFrom, id, new Set(els.map((e) => e.element_id)));
    });

    // The rebased child goes through the review gate like any other version.
    const verdict = await this.review(id);
    if (!verdict.ok) {
      // The node stays on whatever it last committed; the mark goes there.
      const live = (await this.latestCommitted(child.node_id))?.id ?? child.id;
      const markId = await this.mark({ version_id: live, element_id: null, triggered_by: newParent.id, reason: 'review_failed' });
      await this.ask(live, null, markId, `Rebasing onto the new parent failed review: ${verdict.note ?? ''}`);
      return verdict;
    }
    // A successful rebase settles any earlier failed one (its mark moved here on supersede).
    const failed = await this.db.query<{ id: string }>(
      `select id from invalidation where version_id = $1 and reason = 'review_failed' and state = 'open'`, [verdict.version]);
    for (const { id: mid } of failed.rows) {
      await this.closeMark(mid, `rebase ${verdict.version} passed review`);
      await this.db.query(`update query set state = 'answered', answer = 'resolved by a later rebase' where invalidation_id = $1`, [mid]);
    }
    return verdict;
  }

  /**
   * An author who edits a marked element in a version drafted after the mark
   * was raised has addressed it: rewriting the element in response to the
   * upstream change is the "check and fix" a clear would otherwise record.
   * The edge re-pins to the current target and anything the mark caused clears.
   * An element left untouched keeps its mark, so a fix has to be deliberate.
   */
  private async clearAddressed(v: VersionRow) {
    if (v.active_role === 'system') return; // Kolab's own rebases address nothing
    const marks = await this.db.query<MarkRow & { target_node: string }>(
      `select i.*, tv.node_id as target_node
         from invalidation i
         join edge e on e.id = i.edge_id
         join version tv on tv.id = e.target_version_id
         join version me on me.id = $1
         join delta d on d.version_id = me.id and d.element_id = i.element_id and d.kind = 'override'
        where i.version_id = me.id and i.state = 'open'
          and i.reason in ('changed', 'fuzzy_reanchor')
          and i.created_at < me.created_at`, [v.id]);
    for (const m of marks.rows) {
      const e = (await this.db.query<EdgeRow>(`select * from edge where id = $1`, [m.edge_id])).rows[0];
      const latest = (await this.latestCommitted(m.target_node))!;
      const r = await this.resolveIn(latest.id, e.target_element_id, e.target_selector);
      if (r.status === 'orphan') continue;
      await this.asSystem((tx) => tx.query(
        `update edge set target_version_id = $2, target_fingerprint = $3 where id = $1`, [e.id, latest.id, r.fingerprint]));
      await this.closeMark(m.id, `addressed by version ${v.seq} of ${v.node_id}`);
    }
    const answered = await this.db.query<{ id: string }>(
      `select i.id from invalidation i
         join version me on me.id = $1
         join delta d on d.version_id = me.id and d.element_id = i.element_id and d.kind = 'override'
        where i.version_id = me.id and i.state = 'open' and i.reason = 'query_answered'
          and i.created_at < me.created_at`, [v.id]);
    for (const m of answered.rows) await this.closeMark(m.id, `addressed by version ${v.seq} of ${v.node_id}`);
  }

  /** Every non-clean override on a live version has exactly one open mark and query. */
  private async markStaleOverrides(v: VersionRow) {
    for (const d of await this.deltas(v.id)) {
      if (d.state === 'clean') continue;
      const open = await this.db.query(`select 1 from invalidation where delta_id = $1 and state = 'open'`, [d.id]);
      if (open.rows.length) continue;
      const markId = await this.mark({
        version_id: v.id, element_id: d.element_id, delta_id: d.id, triggered_by: v.parent_version_id!,
        reason: d.state === 'dirty' ? 'override_stale' : 'override_orphaned',
      });
      await this.ask(v.id, d.element_id, markId, d.state === 'dirty'
        ? `The parent changed ${d.element_id}, which you override. Reaffirm, adopt the parent's text, or amend?`
        : `The parent deleted ${d.element_id}, which you override. Keep it as your own addition, or drop it?`);
    }
  }

  /** Resolve a stale or orphaned override. Records precedent for the triple. */
  async resolveOverride(sessionId: string, markId: string, resolution: OverrideResolution, amendedText?: string) {
    const m = await this.markRow(markId);
    if (!m.delta_id || m.state !== 'open') throw new Error(`${markId} is not an open override mark`);
    const v = await this.version(m.version_id);
    const s = await this.requireLayer(sessionId, v.layer);
    const deltas = await this.deltas(v.id);
    const d = deltas.find((x) => x.id === m.delta_id)!;
    const parentEls = await this.elements(v.parent_version_id!);
    const pe = parentEls.find((e) => e.element_id === d.element_id);

    const next = deltas.flatMap(({ id: _i, version_id: _v, ...rest }) => {
      if (rest.element_id !== d.element_id) return [rest];
      if (resolution === 'adopt_parent') return [];
      const text = resolution === 'amend' ? amendedText! : rest.text;
      if (!pe) return [{ ...rest, kind: 'add' as const, text, base_version_id: null, base_fingerprint: null, state: 'clean' as const }];
      return [{ ...rest, text, base_version_id: v.parent_version_id, base_fingerprint: pe.fingerprint, state: 'clean' as const }];
    });

    const id = ulid();
    const seq = await this.nextSeq(v.node_id);
    await this.asAgent(sessionId, (tx) => writeVersion(tx, {
      id, node_id: v.node_id, seq, parent_version_id: v.parent_version_id,
      layer: v.layer, actor_id: s.actor_id, active_role: s.active_role,
    }, materialize(parentEls, next), next));

    // The resolution is itself a new version: it must clear the gate before
    // the mark closes, the query is answered, or precedent is set.
    const verdict = await this.review(id);
    if (!verdict.ok) return { version: id, verdict };
    if (pe) {
      await this.asSystem((tx) => tx.query(
        `insert into precedent(id, base_fingerprint, parent_fingerprint, child_fingerprint, resolution, amended_text, ruled_by)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
        [ulid(), d.base_fingerprint, pe.fingerprint, d.kind === 'remove' ? 'REMOVED' : fingerprint(d.text!),
          resolution, amendedText ?? null, s.actor_id]));
    }
    await this.closeMark(markId, s.actor_id);
    await this.db.query(`update query set state = 'answered', answer = $2 where invalidation_id = $1`, [markId, resolution]);
    return { version: id, verdict };
  }

  // ---- clearing ------------------------------------------------------------

  /** "I checked; my dependent still holds." Re-pins the edge and clears what it caused. */
  async clear(sessionId: string, markId: string) {
    const m = await this.markRow(markId);
    const v = await this.version(m.version_id);
    const s = await this.requireLayer(sessionId, v.layer);
    if (m.delta_id) throw new Error('use resolveOverride for override marks');
    if (m.edge_id) {
      const e = (await this.db.query<EdgeRow>(`select * from edge where id = $1`, [m.edge_id])).rows[0];
      const tNode = (await this.version(e.target_version_id)).node_id;
      const latest = (await this.latestCommitted(tNode))!;
      const r = await this.resolveIn(latest.id, e.target_element_id, e.target_selector);
      if (r.status === 'orphan') throw new GateError('the target no longer exists; re-link instead of clearing');
      await this.asSystem((tx) => tx.query(
        `update edge set target_version_id = $2, target_fingerprint = $3 where id = $1`, [e.id, latest.id, r.fingerprint]));
    }
    await this.closeMark(markId, s.actor_id);
  }

  private async closeMark(markId: string, by: string) {
    await this.asSystem(async (tx) => {
      await tx.query(`update invalidation set state = 'cleared', cleared_by = $2 where id = $1`, [markId, by]);
      const caused = await tx.query<{ mark_id: string }>(
        `delete from invalidation_cause where cause_id = $1 returning mark_id`, [markId]);
      for (const { mark_id } of caused.rows) {
        await tx.query(
          `update invalidation set state = 'cleared', cleared_by = $2
            where id = $1 and state = 'open'
              and not exists (select 1 from invalidation_cause c where c.mark_id = $1)`,
          [mark_id, `cause ${markId} cleared`]);
      }
    });
    await this.emitForVersion((await this.markRow(markId)).version_id);
  }

  // ---- queries (the lightweight tier) ---------------------------------------

  /**
   * Ask a question, or leave a note, against an address. It lands on the layer
   * that owns the answer: the version the address resolves to. Anyone may ask.
   *
   * `from` names the asker's own element that waits on the answer (drafts
   * allowed). When a question is answered, that element gets a
   * `query_answered` mark, so the answer reaches the work that relied on it
   * even if the spec text never changes. A note doesn't block anything, so a
   * reply to it marks nothing.
   */
  async raiseQuery(sessionId: string, address: Address | string, question: string,
    opts: { kind?: QueryKind; from?: Address | string } = {}): Promise<string> {
    const s = await this.session(sessionId);
    const a = typeof address === 'string' ? parseAddress(address) : address;
    const r = await this.resolve(a);
    if (!r.versionId || r.status === 'orphan') throw new Error(`cannot ask about ${typeof address === 'string' ? address : JSON.stringify(address)}: it does not resolve`);
    let from: { version: string; element: string | null } | undefined;
    if (opts.from) {
      const f = typeof opts.from === 'string' ? parseAddress(opts.from) : opts.from;
      const fr = await this.resolve(f);
      if (!fr.versionId || fr.status === 'orphan') throw new Error(`from ${formatAddress(f)} does not resolve`);
      if ((await this.version(fr.versionId)).layer !== LAYER_OF_ROLE[s.active_role]) {
        throw new RoleError(`from must be an element of your own layer (${LAYER_OF_ROLE[s.active_role]})`);
      }
      from = { version: fr.versionId, element: f.element ?? null };
    }
    const id = ulid();
    await this.asSystem((tx) => tx.query(
      `insert into query(id, version_id, element_id, selector, kind, question, raised_by, from_version_id, from_element_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, r.versionId, a.element ?? null, a.selector ? JSON.stringify(a.selector) : null, opts.kind ?? 'question',
        question, s.actor_id, from?.version ?? null, from?.element ?? null]));
    await this.emitForVersion(r.versionId);
    return id;
  }

  /** Only the layer that owns the answer may answer. Override and edge questions resolve through their own verbs. */
  async answerQuery(sessionId: string, queryId: string, answer: string) {
    const q = (await this.db.query<{
      version_id: string; element_id: string | null; invalidation_id: string | null; state: string;
      kind: QueryKind; question: string; raised_by: string | null; from_version_id: string | null; from_element_id: string | null;
    }>(`select * from query where id = $1`, [queryId])).rows[0];
    if (!q) throw new Error(`no query ${queryId}`);
    if (q.state !== 'open') throw new GateError(`query ${queryId} is already answered`);
    const mark = q.invalidation_id ? await this.markRow(q.invalidation_id) : undefined;
    if (mark && mark.reason !== 'role_boundary') {
      throw new GateError(`query ${queryId} is about a dirty mark; resolve it with konjir_resolve_override or konjir_clear_mark`);
    }
    const v = await this.version(q.version_id);
    const s = await this.requireLayer(sessionId, v.layer);
    await this.db.query(`update query set state = 'answered', answer = $2, answered_by = $3 where id = $1`, [queryId, answer, s.actor_id]);
    // A boundary question is settled by the layer that owns the answer; its mark goes with it.
    if (mark && mark.state === 'open') await this.closeMark(mark.id, `answered by ${s.actor_id}: ${answer}`);
    if (q.kind === 'question' && q.from_version_id) await this.markAsker(q, v, answer);
    this.emit({ inbox: 'layer', layer: v.layer });
    if (q.raised_by) this.emit({ inbox: 'actor', actor: q.raised_by });
  }

  /**
   * The element that asked now has its answer: mark it on its node's live
   * version (the draft it was asked from may have committed, or been
   * superseded since). If the element is gone, the asker still sees the
   * answer through list_queries mine=true.
   */
  private async markAsker(q: { element_id: string | null; question: string; from_version_id: string | null; from_element_id: string | null },
    asked: VersionRow, answer: string) {
    const fromNode = (await this.version(q.from_version_id!)).node_id;
    const live = await this.latestCommitted(fromNode) ?? await this.version(q.from_version_id!);
    if (q.from_element_id && !(await this.elements(live.id)).some((e) => e.element_id === q.from_element_id)) return;
    const on = formatAddress({ node: asked.node_id, element: q.element_id ?? undefined });
    await this.mark({
      version_id: live.id, element_id: q.from_element_id, reason: 'query_answered',
      triggered_by: (await this.latestCommitted(asked.node_id))?.id ?? asked.id,
      note: `${on}: you asked "${q.question}"; answered: "${answer}"`,
    });
  }

  // ---- inspection ----------------------------------------------------------

  async sessionInfo(sessionId: string) {
    const s = await this.session(sessionId);
    return {
      session: sessionId, actor: s.actor_id, kind: s.kind, owner: s.owner,
      role: s.active_role, layer: LAYER_OF_ROLE[s.active_role],
    };
  }

  async listNodes(kind?: Kind) {
    return (await this.db.query<{ id: string; kind: Kind; layer: Layer; title: string; latest: number | null; drafts: number }>(
      `select n.id, n.kind, n.layer, n.title,
              (select max(seq) from version v where v.node_id = n.id and v.state = 'committed') as latest,
              (select count(*)::int from version v where v.node_id = n.id and v.state = 'drafted') as drafts
         from node n where $1::text is null or n.kind = $1 order by n.kind, n.id`, [kind ?? null])).rows;
  }

  /** Edges into (upstream) or out of (downstream) a version, with human-readable addresses. */
  async lineage(versionId: string, direction: 'upstream' | 'downstream') {
    const sql = direction === 'upstream'
      ? `select e.id, e.kind, e.source_element_id, sv.node_id as source_node, sv.seq as source_seq,
                e.target_element_id, e.target_selector, tv.node_id as target_node, tv.seq as target_seq
           from edge e join version sv on sv.id = e.source_version_id join version tv on tv.id = e.target_version_id
          where e.source_version_id = $1`
      : `select e.id, e.kind, e.source_element_id, sv.node_id as source_node, sv.seq as source_seq,
                e.target_element_id, e.target_selector, tv.node_id as target_node, tv.seq as target_seq
           from edge e join version sv on sv.id = e.source_version_id join version tv on tv.id = e.target_version_id
          where tv.node_id = (select node_id from version where id = $1)
            and ${LIVE('sv')}`;
    const rows = (await this.db.query<{
      id: string; kind: string; source_element_id: string | null; source_node: string; source_seq: number;
      target_element_id: string | null; target_selector: QuoteSelector | null; target_node: string; target_seq: number;
    }>(sql, [versionId])).rows;
    return rows.map((r) => ({
      edge: r.id,
      kind: r.kind,
      source: formatAddress({ node: r.source_node, version: r.source_seq, element: r.source_element_id ?? undefined }),
      target: formatAddress({ node: r.target_node, version: r.target_seq, element: r.target_element_id ?? undefined, selector: r.target_selector ?? undefined }),
    }));
  }

  /** Open marks with the addresses involved, so an agent can act without more lookups. */
  async describeMarks(filter: { layer?: Layer; node?: string } = {}) {
    const rows = (await this.db.query<MarkRow & {
      node_id: string; seq: number; layer: Layer; trig_node: string; trig_seq: number;
      t_element: string | null; t_selector: QuoteSelector | null; cause_count: number;
    }>(
      `select i.*, v.node_id, v.seq, v.layer, tv.node_id as trig_node, tv.seq as trig_seq,
              e.target_element_id as t_element, e.target_selector as t_selector,
              (select count(*)::int from invalidation_cause c where c.mark_id = i.id) as cause_count
         from invalidation i
         join version v on v.id = i.version_id
         join version tv on tv.id = i.triggered_by
         left join edge e on e.id = i.edge_id
        where i.state = 'open'
          and ($1::text is null or v.layer = $1)
          and ($2::text is null or v.node_id = $2)
        order by i.created_at, i.id`, [filter.layer ?? null, filter.node ?? null])).rows;
    return rows.map((r) => ({
      mark: r.id,
      reason: r.reason,
      dirty: formatAddress({ node: r.node_id, version: r.seq, element: r.element_id ?? undefined }),
      layer: r.layer,
      because: r.reason === 'query_answered' ? r.note ?? 'your question was answered'
        : r.note ? `review gate: ${r.note}`
        : r.edge_id
        ? `${formatAddress({ node: r.trig_node, element: r.t_element ?? undefined, selector: r.t_selector ?? undefined })} changed in version ${r.trig_seq}`
        : r.reason === 'upstream_dirty' ? `${r.cause_count} upstream mark(s) are open`
        : `parent ${r.trig_node} version ${r.trig_seq}`,
      next: NEXT_STEP[r.reason] ?? '',
    }));
  }

  async listQueries(filter: {
    layer?: Layer; state?: QueryState; raisedBy?: string; node?: string; kind?: QueryKind;
  } = {}): Promise<Query[]> {
    const rows = (await this.db.query<{
      id: string; kind: QueryKind; node_id: string; seq: number; element_id: string | null;
      selector: QuoteSelector | null; question: string; state: string; answer: string | null; answered_by: string | null;
      raised_by: string | null; mark: string | null; from_node: string | null; from_seq: number | null; from_element_id: string | null;
    }>(
      `select q.id, q.kind, v.node_id, v.seq, q.element_id, q.selector, q.question, q.state, q.answer, q.answered_by,
              q.raised_by, q.invalidation_id as mark, fv.node_id as from_node, fv.seq as from_seq, q.from_element_id
         from query q join version v on v.id = q.version_id
         left join version fv on fv.id = q.from_version_id
        where ($1::text is null or v.layer = $1) and ($2::text is null or q.state = $2)
          and ($3::text is null or q.raised_by = $3) and ($4::text is null or v.node_id = $4)
          and ($5::text is null or q.kind = $5)
        order by q.id`,
      [filter.layer ?? null, filter.state ?? null, filter.raisedBy ?? null, filter.node ?? null, filter.kind ?? null])).rows;
    return rows.map((r) => ({
      id: r.id, kind: r.kind,
      address: formatAddress({ node: r.node_id, version: r.seq, element: r.element_id ?? undefined, selector: r.selector ?? undefined }),
      question: r.question, state: r.state, answer: r.answer, answered_by: r.answered_by, raised_by: r.raised_by,
      from: r.from_node ? formatAddress({ node: r.from_node, version: r.from_seq!, element: r.from_element_id ?? undefined }) : null,
      mark: r.mark,
    }));
  }

  async openMarks(): Promise<MarkRow[]> {
    return (await this.db.query<MarkRow>(`select * from invalidation where state = 'open' order by created_at, id`)).rows;
  }

  async openQueries() {
    return (await this.db.query<{ id: string; version_id: string; element_id: string | null; question: string }>(
      `select id, version_id, element_id, question from query where state = 'open'`)).rows;
  }

  async node(id: string): Promise<{ id: string; kind: Kind; layer: Layer; title: string }> {
    const r = await this.db.query<{ id: string; kind: Kind; layer: Layer; title: string }>(`select * from node where id = $1`, [id]);
    if (!r.rows[0]) throw new Error(`no node ${id}`);
    return r.rows[0];
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Variants may not form a loop (A extends B extends A): each rebase would
   * trigger the other forever. Walk the parent chain, collapsing runs of the
   * same node (ordinary evolution), and refuse if this node reappears.
   */
  private async refuseCycle(nodeId: string, parentId: string) {
    const r = await this.db.query<{ node_id: string }>(
      `with recursive up(id, node_id, parent_version_id, depth) as (
         select id, node_id, parent_version_id, 0 from version where id = $1
         union all
         select v.id, v.node_id, v.parent_version_id, u.depth + 1
           from version v join up u on v.id = u.parent_version_id
       )
       select node_id from up order by depth`, [parentId]);
    const chain = r.rows.map((x) => x.node_id).filter((n, i, a) => i === 0 || a[i - 1] !== n);
    if (chain[0] === nodeId) chain.shift();
    if (chain.includes(nodeId)) {
      throw new GateError(`${nodeId} would inherit from itself through ${chain.join(' -> ')}`);
    }
  }

  private async nextSeq(nodeId: string): Promise<number> {
    const r = await this.db.query<{ n: number }>(`select coalesce(max(seq), 0) + 1 as n from version where node_id = $1`, [nodeId]);
    return r.rows[0].n;
  }

  private async markRow(id: string): Promise<MarkRow> {
    const r = await this.db.query<MarkRow>(`select * from invalidation where id = $1`, [id]);
    if (!r.rows[0]) throw new Error(`no mark ${id}`);
    return r.rows[0];
  }

  private async mark(m: {
    version_id: string; element_id: string | null; triggered_by: string; reason: string;
    edge_id?: string; delta_id?: string; note?: string;
  }): Promise<string> {
    const id = ulid();
    await this.asSystem((tx) => tx.query(
      `insert into invalidation(id, version_id, element_id, edge_id, delta_id, triggered_by, reason, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, m.version_id, m.element_id, m.edge_id ?? null, m.delta_id ?? null, m.triggered_by, m.reason, m.note ?? null]));
    await this.emitForVersion(m.version_id);
    return id;
  }

  private async ask(versionId: string, elementId: string | null, markId: string, question: string) {
    await this.asSystem((tx) => tx.query(
      `insert into query(id, version_id, element_id, invalidation_id, question) values ($1,$2,$3,$4,$5)`,
      [ulid(), versionId, elementId, markId, question]));
    await this.emitForVersion(versionId);
  }

  /**
   * A newly committed version supersedes its node's previous live version.
   * Outbound edges carry forward (for elements that still exist), and open
   * marks move with them: nothing is silently forgotten by re-versioning.
   */
  private async supersedePrevious(v: VersionRow) {
    const prev = await this.db.query<VersionRow>(
      `select * from version where node_id = $1 and seq < $2 and state = 'committed' order by seq desc limit 1`,
      [v.node_id, v.seq]);
    const p = prev.rows[0];
    if (!p) return;
    const live = new Set((await this.elements(v.id)).map((e) => e.element_id));
    await this.asSystem(async (tx) => {
      await copyEdges(tx, p.id, v.id, live);
      // Edge and transitive marks move to the new version.
      await tx.query(`update invalidation set version_id = $2 where version_id = $1 and state = 'open' and delta_id is null`, [p.id, v.id]);
      // An override mark follows its element if the new version's override is still not clean;
      // otherwise the new version resolved it and the mark clears.
      await tx.query(
        `update invalidation i set version_id = $2, delta_id = nd.id
           from delta od, delta nd
          where i.version_id = $1 and i.state = 'open' and i.delta_id = od.id
            and nd.version_id = $2 and nd.element_id = od.element_id and nd.state <> 'clean'`, [p.id, v.id]);
      await tx.query(`update invalidation set state = 'cleared', cleared_by = $2
                       where version_id = $1 and state = 'open' and delta_id is not null`, [p.id, `superseded by ${v.id}`]);
    });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The default review gate: structural checks only. A deployment plugs in a
 * semantic reviewer (an LLM pass that looks for contradictions and layer
 * leaks); until then the note says plainly what was and wasn't checked.
 */
export const structuralReviewer: Reviewer = ({ elements }) => {
  const problems: string[] = [];
  const ids = new Set(elements.map((e) => e.element_id));
  const seen = new Map<string, string>();
  for (const e of elements) {
    const t = normalize(e.text);
    if (!t) problems.push(`${e.element_id} is empty`);
    else if (seen.has(t)) problems.push(`${e.element_id} repeats ${seen.get(t)} word for word`);
    else seen.set(t, e.element_id);
    if (e.parent_element_id && !ids.has(e.parent_element_id)) problems.push(`${e.element_id} sits under ${e.parent_element_id}, which doesn't exist`);
  }
  if (!elements.length) problems.push('the version has no elements');
  return problems.length
    ? { ok: false, note: `Structural review failed: ${problems.join('; ')}.` }
    : { ok: true, note: 'Structural review passed (non-empty, no duplicates, well-formed tree). No semantic reviewer is configured, so contradictions and layer leaks were not checked.' };
};

const NEXT_STEP: Record<string, string> = {
  changed: 'Check whether this still holds against the new upstream text. If yes, konjir_clear_mark; if not, draft a new version that addresses it.',
  fuzzy_reanchor: 'The quoted span changed: its words were edited, or they now appear only without the prefix and suffix you quoted (a copy elsewhere). Re-read the target and either clear the mark or re-link, quoting the current words with their current context.',
  orphaned: 'The target no longer exists. Re-link to its replacement, or remove the dependency in a new draft.',
  upstream_dirty: 'Something this depends on is dirty. Wait for that mark to clear, or check it yourself and clear the upstream mark.',
  override_stale: 'The parent changed text you override. konjir_resolve_override with reaffirm, adopt_parent, or amend.',
  override_orphaned: 'The parent deleted text you override. konjir_resolve_override with reaffirm (keep as your own) or adopt_parent (drop it).',
  review_failed: 'Rebasing onto the new parent failed review. Draft a version that resolves the contradiction named in the query.',
  role_boundary: 'The review gate thinks this crosses the layer boundary. A question went to the layer that owns the answer; the mark clears when it is answered. Meanwhile, work continues at risk.',
  query_answered: 'A question this element was waiting on has been answered. Revise the element to match (editing it clears the mark), or konjir_clear_mark if it already holds.',
};

/**
 * A version is live if no later committed version of its node exists. A
 * pending draft does not supersede it: the cascade must keep reaching the
 * committed version until the draft actually commits (then catch-up runs).
 */
function LIVE(alias: string) {
  return `not exists (select 1 from version later where later.node_id = ${alias}.node_id
            and later.seq > ${alias}.seq and later.state = 'committed')`;
}

function diff(parent: ElementRow[], next: (ElementInput & { id: string })[],
  parentVersionId: string | null): Omit<DeltaRow, 'id' | 'version_id'>[] {
  const byId = new Map(parent.map((e) => [e.element_id, e]));
  const out: Omit<DeltaRow, 'id' | 'version_id'>[] = [];
  next.forEach((e, ord) => {
    const id = e.id!;
    const p = byId.get(id);
    const base = { element_id: id, text: e.text, parent_element_id: e.parent ?? null, ord, state: 'clean' as const };
    if (!p) out.push({ ...base, kind: 'add', base_version_id: null, base_fingerprint: null });
    else if (p.fingerprint !== fingerprint(e.text) || p.parent_element_id !== (e.parent ?? null) || p.ord !== ord) {
      out.push({ ...base, kind: 'override', base_version_id: parentVersionId, base_fingerprint: p.fingerprint });
    }
  });
  const nextIds = new Set(next.map((e) => e.id));
  for (const p of parent) {
    if (!nextIds.has(p.element_id)) {
      out.push({ element_id: p.element_id, kind: 'remove', text: null, parent_element_id: p.parent_element_id,
        ord: null, base_version_id: parentVersionId, base_fingerprint: p.fingerprint, state: 'clean' });
    }
  }
  return out;
}

/** Parent elements overlaid by deltas. Dirty and orphaned overrides still apply. */
function materialize(parent: ElementRow[], deltas: Omit<DeltaRow, 'id' | 'version_id'>[]): ElementRow[] {
  const map = new Map(parent.map((e) => [e.element_id, { ...e }]));
  let maxOrd = parent.reduce((m, e) => Math.max(m, e.ord), -1);
  const removed = new Set<string>();
  for (const d of deltas) {
    if (d.kind === 'remove') { removed.add(d.element_id); continue; }
    const existing = map.get(d.element_id);
    const text = d.text ?? existing?.text ?? '';
    map.set(d.element_id, {
      element_id: d.element_id,
      parent_element_id: d.parent_element_id ?? existing?.parent_element_id ?? null,
      ord: d.ord ?? existing?.ord ?? ++maxOrd,
      text,
      fingerprint: fingerprint(text),
    });
  }
  // Removing an element removes its subtree.
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of map.values()) {
      if (e.parent_element_id && removed.has(e.parent_element_id) && !removed.has(e.element_id)) {
        removed.add(e.element_id); grew = true;
      }
    }
  }
  return [...map.values()].filter((e) => !removed.has(e.element_id)).sort((a, b) => a.ord - b.ord);
}

/**
 * The context a quote selector should record: whole words either side of [start, end), at least
 * three with a letter or digit and 16 characters (D42 needs two to agree), or all there is up to
 * the element's edge. A run of a script written without spaces gives its 32 nearest characters.
 */
function spanContext(text: string, start: number, end: number): { prefix?: string; suffix?: string } {
  const take = (words: string[]): string[] => {
    const out: string[] = [];
    let meaningful = 0;
    for (const w of words) {
      if (meaningful >= 3 && out.join(' ').length >= 16) break;
      const cps = [...w];
      if (cps.length > 32 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(w)) {
        out.push(cps.slice(0, 32).join(''));
        break;
      }
      out.push(w);
      if (/[\p{L}\p{N}]/u.test(w)) meaningful++;
    }
    return out;
  };
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end).trimStart();
  // The prefix is read away from the quote: its words last to first, each spelled backwards.
  const backwards = (w: string) => [...w].reverse().join('');
  const prefixWords = take(before ? before.split(' ').reverse().map(backwards) : []).map(backwards).reverse();
  const suffixWords = take(after ? after.split(' ') : []);
  const prefix = prefixWords.join(' ');
  const suffix = suffixWords.join(' ');
  return { ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
}

/** An element plus its descendants, in order. The scope an element address covers. */
function subtreeText(els: ElementRow[], rootId: string): string | undefined {
  if (!els.some((e) => e.element_id === rootId)) return undefined;
  const kids = new Map<string, ElementRow[]>();
  for (const e of els) {
    if (!e.parent_element_id) continue;
    (kids.get(e.parent_element_id) ?? kids.set(e.parent_element_id, []).get(e.parent_element_id)!).push(e);
  }
  const out: string[] = [];
  const walk = (id: string) => {
    const e = els.find((x) => x.element_id === id)!;
    out.push(normalize(e.text));
    for (const k of kids.get(id) ?? []) walk(k.element_id);
  };
  walk(rootId);
  return out.join('\n');
}

/**
 * Carry outbound edges from one version of a node to another. An edge whose
 * source element no longer exists is dropped. An edge the destination already
 * has (same kind, source element, target node, target scope) is not
 * duplicated. Open marks follow their edge either way.
 */
async function copyEdges(tx: Q, from: string, to: string, liveElements: Set<string>) {
  const out = await tx.query<EdgeRow>(`select * from edge where source_version_id = $1`, [from]);
  for (const e of out.rows) {
    if (e.source_element_id && !liveElements.has(e.source_element_id)) continue;
    const selector = e.target_selector ? JSON.stringify(e.target_selector) : null;
    const existing = await tx.query<{ id: string }>(
      `select d.id from edge d
         join version dt on dt.id = d.target_version_id
         join version et on et.id = $6
        where d.source_version_id = $1 and d.kind = $2
          and d.source_element_id is not distinct from $3
          and dt.node_id = et.node_id
          and d.target_element_id is not distinct from $4
          and d.target_selector is not distinct from $5::jsonb`,
      [to, e.kind, e.source_element_id, e.target_element_id, selector, e.target_version_id]);
    let nid = existing.rows[0]?.id;
    if (!nid) {
      nid = ulid();
      await tx.query(
        `insert into edge(id, kind, source_version_id, source_element_id, target_version_id,
                          target_element_id, target_selector, target_fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [nid, e.kind, to, e.source_element_id, e.target_version_id, e.target_element_id, selector, e.target_fingerprint]);
    }
    await tx.query(`update invalidation set edge_id = $2 where edge_id = $1 and state = 'open'`, [e.id, nid]);
  }
}

async function writeVersion(tx: Q, v: Omit<VersionRow, 'state'>, els: ElementRow[],
  deltas: Omit<DeltaRow, 'id' | 'version_id'>[]) {
  await tx.query(
    `insert into version(id, node_id, seq, parent_version_id, layer, state, actor_id, active_role)
     values ($1,$2,$3,$4,$5,'drafted',$6,$7)`,
    [v.id, v.node_id, v.seq, v.parent_version_id, v.layer, v.actor_id, v.active_role]);
  for (const e of els) {
    await tx.query(
      `insert into element(version_id, element_id, parent_element_id, ord, text, fingerprint)
       values ($1,$2,$3,$4,$5,$6)`,
      [v.id, e.element_id, e.parent_element_id, e.ord, e.text, e.fingerprint]);
  }
  for (const d of deltas) {
    await tx.query(
      `insert into delta(id, version_id, element_id, kind, text, parent_element_id, ord,
                         base_version_id, base_fingerprint, state)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ulid(), v.id, d.element_id, d.kind, d.text, d.parent_element_id, d.ord,
        d.base_version_id, d.base_fingerprint, d.state]);
  }
}
