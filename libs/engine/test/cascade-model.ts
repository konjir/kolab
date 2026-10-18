// A reference model of the cascade and rebases (W2.5, binding element TST2), for the property
// tests in properties.test.ts. It follows one small spec family through the operations the
// generators produce, and says what Kolab should hold after each: every element's text, every
// variant's overrides and their states, where every link is pinned, and which marks are open.
// It is written from the spec and the binding, not from the engine's code.
//
// The family:
//
//   P   functional spec   E1, E2 (with child E2a), E3
//   V1  variant of P      overrides some of E1, E2, E3; adds X1
//   V2  variant of V1     overrides some of E1, E2, E3, X1
//                         X1 -> B.b1, X1 -> B.b6           (a variant that depends on the binding)
//   B   binding           b1 -> P.E1, b2 -> P.E2 (its subtree), b3 -> V1.E1, b4 -> V2.E3,
//                         b5 -> P (whole), b6 -> V2.X1     (b6 and V2.X1 form a cycle)
//   W   wbs               w1 -> B.b1, w2 -> B.b3, w3 -> B.b4, w4 -> B.b6
//   X   work package      x1 -> W.w1, x2 -> W.w3           (a third hop)
//
// What it encodes, from the spec (LNK, OVR) and the binding (CAS):
// - CAS1, LNK4: a commit resolves each link into the node. Content that still fingerprints the
//   same re-pins it; changed content marks it "changed"; a missing target marks it "orphaned".
// - CAS2, LNK5: a direct mark spreads, element by element, to everything downstream that relies
//   on the marked element, through any number of hops, as upstream_dirty marks it caused. The
//   walk never re-enters the change itself, and visits each element once, so a cycle ends.
//   Marks raised by one commit that reach the same element share one upstream_dirty mark. An
//   upstream_dirty mark clears when all its causes have cleared (LNK5).
// - CAS3: open marks follow their element to the node's next version.
// - CAS4, LNK6: a person's commit that revises an element (its text fingerprints differently)
//   settles that element's marks: a "changed" link re-pins to its target as it is now, and what
//   it caused clears; an upstream_dirty mark clears. Kolab's own rebases revise nothing.
// - CAS5, OVR3-OVR7: each commit of a parent rebases its variants with the three-way rule, and
//   each override comes out clean, retired, dirty or orphaned; each dirty or orphaned override
//   holds one open mark and one open question, worded for its state, and no other override does.
// - CAS6, OVR8-OVR9: resolving an override writes the variant's next version and records
//   precedent for (base, parent, child), which later rebases follow, including the rebases the
//   resolution's own commit causes. A rejected resolution changes nothing.
// - VER (the review gate): a draft the reviewer rejects changes nothing.
// - LNK6, D48, CAS3 (D50): a link's owner removes it in a draft of its node, so the version that
//   commits doesn't carry it forward: its open mark settles, and what that mark alone caused
//   clears, as a cleared mark's would, but nothing re-pins. A removal rejected with its version
//   changes nothing. A link removed can be linked again, pinned to its target as it is then.
//
// Readings of the spec this model makes deliberately, where it could be read another way:
// - A link that already carries an open mark isn't re-checked by later commits (CAS1's "each live
//   link" read as each link not already marked). Its owner settles the mark (LNK6), even if the
//   target goes back to the pinned text, or is deleted after it changed.
// - A link whose target is gone ("orphaned", or "changed" and since deleted) can't re-pin, so
//   revising its element doesn't settle the mark (CAS4: "clears that mark and re-pins its link"),
//   and clearing it is refused: the owner re-links instead.
// - When two rulings share a (base, parent, child) triple, the first one stands.
import { fingerprint, normalize } from '@konjir/address';

export const fp = fingerprint;

export type NodeKey = 'P' | 'V1' | 'V2' | 'B' | 'W' | 'X';
export type VariantKey = 'V1' | 'V2';
export type Resolution = 'reaffirm' | 'adopt_parent' | 'amend';

export const FUNCTIONAL: NodeKey[] = ['P', 'V1', 'V2'];
export const NODES: NodeKey[] = ['P', 'V1', 'V2', 'B', 'W', 'X'];

export interface El { id: string; text: string; parent: string | null }
export interface Delta {
  kind: 'override' | 'add'; text: string; baseFp: string | null;
  state: 'clean' | 'dirty' | 'orphaned'; parent: string | null;
}
export interface Link { src: NodeKey; srcEl: string; tgt: NodeKey; tgtEl: string | null }
export interface Edge extends Link {
  /** `B.b1>P.E1`: one link per source element and target scope. */
  key: string;
  /** The fingerprint the link is pinned to. */
  pinned: string;
  mark?: 'changed' | 'orphaned';
}

/** The order P's elements always take, so its whole-version content is predictable. */
export const P_ORDER = ['E1', 'E2', 'E2a', 'E3'] as const;
export const P_PARENTS: Record<string, string | null> = { E1: null, E2: null, E2a: 'E2', E3: null };
/** The elements of the nodes that are edited whole: never deleted, so their links never drop. */
export const PLAIN: Record<'B' | 'W' | 'X', readonly string[]> = {
  B: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
  W: ['w1', 'w2', 'w3', 'w4'],
  X: ['x1', 'x2'],
};
export const LINKS: Link[] = [
  { src: 'B', srcEl: 'b1', tgt: 'P', tgtEl: 'E1' },
  { src: 'B', srcEl: 'b2', tgt: 'P', tgtEl: 'E2' },
  { src: 'B', srcEl: 'b3', tgt: 'V1', tgtEl: 'E1' },
  { src: 'B', srcEl: 'b4', tgt: 'V2', tgtEl: 'E3' },
  { src: 'B', srcEl: 'b5', tgt: 'P', tgtEl: null },
  { src: 'B', srcEl: 'b6', tgt: 'V2', tgtEl: 'X1' },
  { src: 'V2', srcEl: 'X1', tgt: 'B', tgtEl: 'b1' },
  { src: 'V2', srcEl: 'X1', tgt: 'B', tgtEl: 'b6' },
  { src: 'W', srcEl: 'w1', tgt: 'B', tgtEl: 'b1' },
  { src: 'W', srcEl: 'w2', tgt: 'B', tgtEl: 'b3' },
  { src: 'W', srcEl: 'w3', tgt: 'B', tgtEl: 'b4' },
  { src: 'W', srcEl: 'w4', tgt: 'B', tgtEl: 'b6' },
  { src: 'X', srcEl: 'x1', tgt: 'W', tgtEl: 'w1' },
  { src: 'X', srcEl: 'x2', tgt: 'W', tgtEl: 'w3' },
];
export const linkKey = (l: Link) => `${l.src}.${l.srcEl}>${l.tgt}.${l.tgtEl ?? '*'}`;

/** The text the reviewer rejects: index VETO of textFor. */
export const VETO = 4;

/**
 * Five texts per element. 0 and 1 differ only in whitespace, so they fingerprint the same: an
 * edit between them is no edit. 4 is one the review gate rejects. Each text names its run and
 * element, so no two elements of one version ever repeat each other (the structural review), and
 * precedent from one run never matches another's.
 */
export const textFor = (run: string, el: string, i: number) =>
  [`${run} ${el} alpha.`, `${run}  ${el} alpha. `, `${run} ${el} beta.`, `${run} ${el} gamma.`, `${run} ${el} veto.`][i];

export const vetoed = (text: string) => / veto\.$/.test(text);

export class Model {
  P: El[] = [];
  V: Record<VariantKey, Map<string, Delta>> = { V1: new Map(), V2: new Map() };
  plain: Record<'B' | 'W' | 'X', Map<string, string>> = { B: new Map(), W: new Map(), X: new Map() };
  edges: Edge[] = [];
  /**
   * Open upstream_dirty marks: `${node}.${element}#${the commit that raised it}` to the keys of the
   * links whose marks cause it.
   */
  up = new Map<string, Set<string>>();
  /** Open override marks, by `${variant}.${element}`, with their reason. */
  ovr = new Map<string, 'override_stale' | 'override_orphaned'>();
  /** Precedent, by `${base}|${parent}|${child}` fingerprints. The first ruling stands. */
  precedent = new Map<string, { how: Resolution; amended: string | null }>();
  private commits = 0;

  parentOf(v: VariantKey): NodeKey { return v === 'V1' ? 'P' : 'V1'; }

  /** A node's elements, in order, as Kolab materializes them. */
  mat(key: NodeKey): El[] {
    if (key === 'P') return this.P;
    if (key === 'B' || key === 'W' || key === 'X') return [...this.plain[key]].map(([id, text]) => ({ id, text, parent: null }));
    const out = this.mat(this.parentOf(key)).map((e) => ({ ...e }));
    for (const [id, d] of this.V[key]) {
      const e = out.find((x) => x.id === id);
      if (e) e.text = d.text;
      else out.push({ id, text: d.text, parent: d.parent });
    }
    return out;
  }

  /** What a link to (node, element) resolves to: the element's subtree, or the whole version's shape. */
  content(key: NodeKey, el: string | null): string | undefined {
    const els = this.mat(key);
    if (el === null) return els.map((e) => `${e.id}:${e.parent ?? ''}:${fp(e.text)}`).join('\n');
    if (!els.some((e) => e.id === el)) return undefined;
    const out: string[] = [];
    const walk = (id: string) => {
      out.push(normalize(els.find((e) => e.id === id)!.text));
      for (const k of els.filter((e) => e.parent === id)) walk(k.id);
    };
    walk(el);
    return out.join('\n');
  }

  textOf(key: NodeKey): Record<string, string> {
    return Object.fromEntries(this.mat(key).map((e) => [e.id, e.text]));
  }

  // ---- the cascade ----------------------------------------------------------

  /** `key` committed a new version: each unmarked link into it re-pins or is marked (CAS1), and each mark spreads (CAS2). */
  private inbound(key: NodeKey) {
    const commit = ++this.commits;
    for (const e of this.edges.filter((x) => x.tgt === key && !x.mark)) {
      const c = this.content(key, e.tgtEl);
      if (c === undefined) e.mark = 'orphaned';
      else if (fp(c) !== e.pinned) e.mark = 'changed';
      else continue; // content-identical: a pointer bump
      this.spread(e, commit);
    }
  }

  /**
   * Everything downstream of the element `e` marked, hop by hop (CAS2, LNK5): each link into an
   * element reached marks its source element, once per element, except a link from the change
   * itself (the element of the committed version that `e` addressed).
   */
  private spread(e: Edge, commit: number) {
    const seen = new Set([`${e.src}.${e.srcEl}`]);
    const todo: [NodeKey, string][] = [[e.src, e.srcEl]];
    while (todo.length) {
      const [node, el] = todo.shift()!;
      for (const f of this.edges) {
        if (f.tgt !== node || (f.tgtEl !== null && f.tgtEl !== el)) continue;
        if (f.src === e.tgt && (e.tgtEl === null || f.srcEl === e.tgtEl)) continue; // the change itself
        const at = `${f.src}.${f.srcEl}`;
        if (seen.has(at)) continue;
        seen.add(at);
        todo.push([f.src, f.srcEl]);
        const k = `${at}#${commit}`;
        (this.up.get(k) ?? this.up.set(k, new Set()).get(k)!).add(e.key);
      }
    }
  }

  /** A link's mark settles: it re-pins to its target as it is now, and what the mark alone caused clears. */
  private settle(e: Edge) {
    e.pinned = fp(this.content(e.tgt, e.tgtEl)!);
    e.mark = undefined;
    for (const [k, causes] of this.up) {
      causes.delete(e.key);
      if (!causes.size) this.up.delete(k);
    }
  }

  /** A link's owner removed it (LNK6, D48): its mark settles, and what that mark alone caused clears; nothing re-pins. */
  private removeEdge(e: Edge) {
    this.edges = this.edges.filter((x) => x !== e);
    if (!e.mark) return;
    for (const [k, causes] of this.up) {
      causes.delete(e.key);
      if (!causes.size) this.up.delete(k);
    }
  }

  /** A person committed `key`, which read `before`: each element whose text changed settles its marks (CAS4, LNK6). */
  private revised(key: NodeKey, before: El[]) {
    const was = new Map(before.map((e) => [e.id, fp(e.text)]));
    for (const el of this.mat(key).filter((e) => was.get(e.id) !== fp(e.text)).map((e) => e.id)) {
      for (const e of this.edges.filter((x) => x.src === key && x.srcEl === el)) {
        if (e.mark === 'changed' && this.content(e.tgt, e.tgtEl) !== undefined) this.settle(e);
      }
      for (const k of [...this.up.keys()]) if (k.startsWith(`${key}.${el}#`)) this.up.delete(k);
    }
  }

  /** A variant committed (rebased, edited or resolved): its marks, its links, then its own variants (OVR3). */
  private variantCommitted(v: VariantKey, before?: El[]) {
    this.syncOverrideMarks(v);
    if (before) this.revised(v, before);
    this.inbound(v);
    if (v === 'V1') this.rebase('V2');
  }

  /** The three-way rule (CAS5, OVR4-OVR7), with precedent (CAS6, OVR9). */
  private rebase(v: VariantKey) {
    const parent = new Map(this.mat(this.parentOf(v)).map((e) => [e.id, e]));
    const next = new Map<string, Delta>();
    for (const [id, d] of this.V[v]) {
      if (d.kind === 'add') { next.set(id, d); continue; }
      const pe = parent.get(id);
      if (!pe) { next.set(id, { ...d, state: 'orphaned' }); continue; }
      const pfp = fp(pe.text);
      if (pfp === d.baseFp) { next.set(id, { ...d, state: 'clean' }); continue; }
      if (fp(d.text) === pfp) continue; // the parent converged on the override: retired
      const prec = this.precedent.get(`${d.baseFp}|${pfp}|${fp(d.text)}`);
      if (prec?.how === 'adopt_parent') continue;
      if (prec) {
        next.set(id, { ...d, text: prec.how === 'amend' ? prec.amended! : d.text, baseFp: pfp, state: 'clean' });
        continue;
      }
      next.set(id, { ...d, state: 'dirty' });
    }
    this.V[v] = next;
    this.variantCommitted(v);
  }

  /** Each dirty or orphaned override holds one open mark, worded for its state; a clean or retired one holds none. */
  private syncOverrideMarks(v: VariantKey) {
    for (const k of [...this.ovr.keys()]) {
      if (!k.startsWith(`${v}.`)) continue;
      const d = this.V[v].get(k.slice(v.length + 1));
      if (!d || d.state === 'clean') this.ovr.delete(k);
    }
    for (const [id, d] of this.V[v]) {
      if (d.state === 'clean') continue;
      this.ovr.set(`${v}.${id}`, d.state === 'dirty' ? 'override_stale' : 'override_orphaned');
    }
  }

  // ---- operations: each returns false when Kolab must refuse or reject it, changing nothing ----

  /** The product owner commits P with these elements. */
  commitParent(next: El[]): boolean {
    if (!next.length || next.some((e) => vetoed(e.text))) return false; // no elements; the reviewer's veto
    // Kolab diffs full elements against the previous version: an element whose fingerprint and
    // place are unchanged gets no delta, so it keeps its old text, whitespace and all.
    const was = this.P;
    this.P = next.map((e, i) => (was[i]?.id === e.id && fp(was[i].text) === fp(e.text) ? { ...e, text: was[i].text } : e));
    this.revised('P', was);
    this.inbound('P');
    this.rebase('V1');
    return true;
  }

  /** The product owner overrides `el` in a variant. Refused if the parent doesn't have it. */
  override(v: VariantKey, el: string, text: string): 'ok' | 'refused' | 'rejected' {
    const pe = this.mat(this.parentOf(v)).find((e) => e.id === el);
    if (!pe) return 'refused';
    if (vetoed(text)) return 'rejected';
    const before = this.mat(v);
    this.V[v].delete(el);
    this.V[v].set(el, { kind: 'override', text, baseFp: fp(pe.text), state: 'clean', parent: pe.parent });
    this.variantCommitted(v, before);
    return 'ok';
  }

  /** The product owner resolves the override mark on `v.el` (CAS6, OVR8). */
  resolve(v: VariantKey, el: string, how: Resolution, amended: string): boolean {
    if (how === 'amend' && vetoed(amended)) return false;
    const d = this.V[v].get(el)!;
    const pe = this.mat(this.parentOf(v)).find((e) => e.id === el);
    const before = this.mat(v);
    if (pe) {
      const key = `${d.baseFp}|${fp(pe.text)}|${fp(d.text)}`;
      if (!this.precedent.has(key)) this.precedent.set(key, { how, amended: how === 'amend' ? amended : null });
    }
    if (how === 'adopt_parent') this.V[v].delete(el);
    else {
      const text = how === 'amend' ? amended : d.text;
      this.V[v].set(el, pe
        ? { ...d, text, baseFp: fp(pe.text), state: 'clean' }
        : { kind: 'add', text, baseFp: null, state: 'clean', parent: d.parent });
    }
    this.ovr.delete(`${v}.${el}`);
    this.variantCommitted(v, before);
    return true;
  }

  /** The engineer commits B, W or X with `el` rewritten. Text that fingerprints the same is no edit: Kolab keeps the old text. */
  edit(key: 'B' | 'W' | 'X', el: string, text: string): boolean {
    // The plan (W, a wbs) and its work package (X) commit after structural checks only, so the
    // reviewer's veto reaches only the binding (VER3, PLN2, W1.6).
    if (vetoed(text) && key === 'B') return false;
    const before = this.mat(key);
    if (fp(this.plain[key].get(el)!) !== fp(text)) this.plain[key].set(el, text);
    this.revised(key, before);
    this.inbound(key);
    return true;
  }

  /**
   * The link's owner commits its source node with the link removed, and with its source element
   * rewritten to `text` if given (a binding's veto rejects the whole version, removal and all).
   */
  unlink(key: string, text?: string): 'ok' | 'rejected' {
    const e = this.edges.find((x) => x.key === key)!;
    if (text !== undefined && vetoed(text) && e.src !== 'W' && e.src !== 'X') return 'rejected';
    if (e.src === 'V2') {
      const before = this.mat('V2');
      this.removeEdge(e);
      if (text !== undefined) {
        const pe = this.mat('V1').find((x) => x.id === e.srcEl)!;
        this.V.V2.delete(e.srcEl);
        this.V.V2.set(e.srcEl, { kind: 'override', text, baseFp: fp(pe.text), state: 'clean', parent: pe.parent });
      }
      this.variantCommitted('V2', before);
      return 'ok';
    }
    const node = e.src as 'B' | 'W' | 'X';
    const before = this.mat(node);
    this.removeEdge(e);
    if (text !== undefined && fp(this.plain[node].get(e.srcEl)!) !== fp(text)) this.plain[node].set(e.srcEl, text);
    this.revised(node, before);
    this.inbound(node);
    return 'ok';
  }

  /** The owner links a removed link again, from its node's live version. Refused when the target is gone. */
  relink(l: Link): boolean {
    const c = this.content(l.tgt, l.tgtEl);
    if (c === undefined) return false;
    this.edges.push({ ...l, key: linkKey(l), pinned: fp(c) });
    return true;
  }

  /** Someone clears a link's mark ("still holds"). Refused when the target is gone. */
  clearEdge(key: string): boolean {
    const e = this.edges.find((x) => x.key === key)!;
    if (this.content(e.tgt, e.tgtEl) === undefined) return false;
    this.settle(e);
    return true;
  }

  /** Someone clears an upstream_dirty mark, named as openMarks names it. */
  clearUp(name: string) {
    for (const [k, causes] of this.up) if (upName(k, causes) === name) { this.up.delete(k); return; }
    throw new Error(`the model has no ${name}`);
  }

  // ---- what should be open ------------------------------------------------------

  /** Every open mark, as a key that names what it is about, independent of version and row ids. */
  openMarks(): string[] {
    return [
      ...this.edges.filter((e) => e.mark).map((e) => `edge ${e.key} ${e.mark}`),
      ...[...this.up].map(([k, causes]) => upName(k, causes)),
      ...[...this.ovr].map(([k, reason]) => `${reason} ${k}`),
    ].sort();
  }
}

export const upName = (k: string, causes: Iterable<string>) => `upstream_dirty ${k.split('#')[0]} <- ${[...causes].sort().join(', ')}`;
