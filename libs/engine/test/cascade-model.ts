// A reference model of the cascade and rebases (W2.5, binding element TST2), for the property
// tests in properties.test.ts. It follows one small spec family through the operations the
// generators produce, and says what Kolab should hold after each: every element's text, every
// variant's overrides and their states, where every link is pinned, and which marks are open.
//
// The family:
//
//   P   functional spec   E1, E2 (with child E2a), E3
//   V1  variant of P      overrides some of E1, E2, E3; adds X1
//   V2  variant of V1     overrides some of E1, E2, E3, X1
//   B   binding           b1 -> P.E1, b2 -> P.E2 (its subtree), b3 -> V1.E1, b4 -> V2.E3, b5 -> P (whole)
//   W   wbs               w1 -> B.b1, w2 -> B.b3, w3 -> B.b4
//
// What it encodes, from the binding and the spec:
// - CAS1, LNK4: a commit re-checks each link into the node that carries no open mark. Content
//   that still fingerprints the same re-pins it; changed content marks it "changed"; a missing
//   target marks it "orphaned".
// - CAS2, LNK5: a direct mark on a binding element spreads to the wbs elements that rely on it, as
//   upstream_dirty marks caused by it, which clear when the cause clears.
// - CAS3: open marks follow their element to the node's next version.
// - CAS4, LNK6: editing an element whose link carries a "changed" mark settles the mark and
//   re-pins the link, while the target still exists; anything the mark caused clears with it.
// - CAS5, OVR3-OVR7: each commit of a parent rebases its variants with the three-way rule, and
//   each override comes out clean, retired, dirty or orphaned; each dirty or orphaned override
//   holds one open mark and one open question, and no other override does.
// - CAS6, OVR8-OVR9: resolving an override writes the variant's next version and records
//   precedent for (base, parent, child), which later rebases follow.
import { fingerprint, normalize } from '@konjir/address';

export const fp = fingerprint;

export type NodeKey = 'P' | 'V1' | 'V2' | 'B' | 'W';
export type VariantKey = 'V1' | 'V2';
export type Resolution = 'reaffirm' | 'adopt_parent' | 'amend';

export interface El { id: string; text: string; parent: string | null }
export interface Delta {
  kind: 'override' | 'add'; text: string; baseFp: string | null;
  state: 'clean' | 'dirty' | 'orphaned'; parent: string | null;
}
export interface Edge {
  /** The source scope, `B.b1`: one link per source element. */
  key: string;
  src: 'B' | 'W'; srcEl: string;
  tgt: NodeKey; tgtEl: string | null;
  /** The fingerprint the link is pinned to. */
  pinned: string;
  mark?: 'changed' | 'orphaned';
}

/** The order P's elements always take, so its whole-version content is predictable. */
export const P_ORDER = ['E1', 'E2', 'E2a', 'E3'] as const;
export const P_PARENTS: Record<string, string | null> = { E1: null, E2: null, E2a: 'E2', E3: null };
export const B_ELS = ['b1', 'b2', 'b3', 'b4', 'b5'] as const;
export const W_ELS = ['w1', 'w2', 'w3'] as const;
export const LINKS: { src: 'B' | 'W'; srcEl: string; tgt: NodeKey; tgtEl: string | null }[] = [
  { src: 'B', srcEl: 'b1', tgt: 'P', tgtEl: 'E1' },
  { src: 'B', srcEl: 'b2', tgt: 'P', tgtEl: 'E2' },
  { src: 'B', srcEl: 'b3', tgt: 'V1', tgtEl: 'E1' },
  { src: 'B', srcEl: 'b4', tgt: 'V2', tgtEl: 'E3' },
  { src: 'B', srcEl: 'b5', tgt: 'P', tgtEl: null },
  { src: 'W', srcEl: 'w1', tgt: 'B', tgtEl: 'b1' },
  { src: 'W', srcEl: 'w2', tgt: 'B', tgtEl: 'b3' },
  { src: 'W', srcEl: 'w3', tgt: 'B', tgtEl: 'b4' },
];

/**
 * Four texts per element. 0 and 1 differ only in whitespace, so they fingerprint the same: an
 * edit between them is no edit. Each text names its run and element, so no two elements of one
 * version ever repeat each other (the structural review), and precedent from one run never
 * matches another's.
 */
export const textFor = (run: string, el: string, i: number) =>
  [`${run} ${el} alpha.`, `${run}  ${el} alpha. `, `${run} ${el} beta.`, `${run} ${el} gamma.`][i];

export class Model {
  P: El[] = [];
  V: Record<VariantKey, Map<string, Delta>> = { V1: new Map(), V2: new Map() };
  B = new Map<string, string>();
  W = new Map<string, string>();
  edges: Edge[] = [];
  /** Open upstream_dirty marks, as `${wbs element}|${the edge whose mark caused it}`. */
  up = new Set<string>();
  /** Open override marks, by `${variant}.${element}`, with their reason. */
  ovr = new Map<string, 'override_stale' | 'override_orphaned'>();
  /** Precedent, by `${base}|${parent}|${child}` fingerprints. The first ruling stands. */
  precedent = new Map<string, { how: Resolution; amended: string | null }>();

  parentOf(v: VariantKey): NodeKey { return v === 'V1' ? 'P' : 'V1'; }

  /** A node's elements, in order, as Kolab materializes them. */
  mat(key: NodeKey): El[] {
    if (key === 'P') return this.P;
    if (key === 'B') return [...this.B].map(([id, text]) => ({ id, text, parent: null }));
    if (key === 'W') return [...this.W].map(([id, text]) => ({ id, text, parent: null }));
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

  /** `key` committed a new version: each unmarked link into it re-pins or is marked (CAS1). */
  private inbound(key: NodeKey) {
    for (const e of this.edges.filter((x) => x.tgt === key && !x.mark)) {
      const c = this.content(key, e.tgtEl);
      if (c === undefined) e.mark = 'orphaned';
      else if (fp(c) !== e.pinned) e.mark = 'changed';
      else continue; // content-identical: a pointer bump
      this.spread(e);
    }
  }

  /** A direct mark on a binding element reaches the wbs elements that rely on it (CAS2, LNK5). */
  private spread(e: Edge) {
    if (e.src !== 'B') return;
    for (const f of this.edges.filter((x) => x.src === 'W' && x.tgtEl === e.srcEl)) this.up.add(`${f.srcEl}|${e.key}`);
  }

  /** A direct mark settles: its link re-pins to the target as it is now, and what it caused clears. */
  private settle(e: Edge) {
    e.pinned = fp(this.content(e.tgt, e.tgtEl)!);
    e.mark = undefined;
    for (const u of [...this.up]) if (u.endsWith(`|${e.key}`)) this.up.delete(u);
  }

  /** A variant committed (rebased, edited or resolved): its links, then its own variants (OVR3). */
  private variantCommitted(v: VariantKey) {
    this.syncOverrideMarks(v);
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

  /** Each dirty or orphaned override holds one open mark; a clean or retired one holds none. */
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

  // ---- operations -------------------------------------------------------------

  /** The product owner commits P with these elements. Returns false if review must reject it. */
  commitParent(next: El[]): boolean {
    if (!next.length) return false; // the version has no elements
    // Kolab diffs full elements against the previous version: an element whose fingerprint and
    // place are unchanged gets no delta, so it keeps its old text, whitespace and all.
    const was = this.P;
    this.P = next.map((e, i) => (was[i]?.id === e.id && fp(was[i].text) === fp(e.text) ? { ...e, text: was[i].text } : e));
    this.inbound('P');
    this.rebase('V1');
    return true;
  }

  /** The product owner overrides `el` in a variant. Returns false if Kolab must refuse it. */
  override(v: VariantKey, el: string, text: string): boolean {
    const pe = this.mat(this.parentOf(v)).find((e) => e.id === el);
    if (!pe) return false; // cannot override an element the parent doesn't have
    this.V[v].delete(el);
    this.V[v].set(el, { kind: 'override', text, baseFp: fp(pe.text), state: 'clean', parent: pe.parent });
    this.variantCommitted(v);
    return true;
  }

  /** The product owner resolves the override mark on `v.el` (CAS6, OVR8). */
  resolve(v: VariantKey, el: string, how: Resolution, amended: string) {
    const d = this.V[v].get(el)!;
    const pe = this.mat(this.parentOf(v)).find((e) => e.id === el);
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
    this.variantCommitted(v);
  }

  /**
   * The engineer commits B or W with `el` rewritten. Text that fingerprints the same is no edit:
   * Kolab keeps the old text. A real edit settles the element's "changed" marks (CAS4).
   */
  edit(key: 'B' | 'W', el: string, text: string) {
    const els = key === 'B' ? this.B : this.W;
    if (fp(els.get(el)!) !== fp(text)) {
      els.set(el, text);
      for (const e of this.edges.filter((x) => x.src === key && x.srcEl === el)) {
        if (e.mark === 'changed' && this.content(e.tgt, e.tgtEl) !== undefined) this.settle(e);
      }
    }
    if (key === 'B') this.inbound('B');
  }

  /** The engineer clears a link's mark ("still holds"). Returns false if Kolab must refuse: the target is gone. */
  clearEdge(key: string): boolean {
    const e = this.edges.find((x) => x.key === key)!;
    if (this.content(e.tgt, e.tgtEl) === undefined) return false;
    this.settle(e);
    return true;
  }

  clearUp(u: string) { this.up.delete(u); }

  // ---- what should be open ------------------------------------------------------

  /** Every open mark, as a key that names what it is about, independent of version and row ids. */
  openMarks(): string[] {
    return [
      ...this.edges.filter((e) => e.mark).map((e) => `edge ${e.key} ${e.mark}`),
      ...[...this.up].map((u) => { const [w, cause] = u.split('|'); return `upstream_dirty W.${w} <- ${cause}`; }),
      ...[...this.ovr].map(([k, reason]) => `${reason} ${k}`),
    ].sort();
  }
}
