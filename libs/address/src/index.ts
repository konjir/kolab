import { createHash } from 'node:crypto';
import {
  type DiffMatchPathOptions, diffCleanupSemantic, diffCommonPrefix, diffCommonSuffix, diffLevenshtein,
  diffMain, diffXIndex, matchMain,
} from 'diff-match-patch-es';

/** A content selector for a span inside one element (W3C TextQuoteSelector shape). */
export interface QuoteSelector {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/**
 * An address. Granularity is carried by the address itself:
 *   node version only          -> whole version
 *   + element                  -> one requirement (and its sub-elements)
 *   + selector                 -> a span inside that requirement
 */
export interface Address {
  node: string;
  version?: number;          // absent = floating (resolve to latest committed)
  element?: string;
  selector?: QuoteSelector;
}

export type Scope = 'version' | 'element' | 'span';

export function scopeOf(a: Address): Scope {
  return a.selector ? 'span' : a.element ? 'element' : 'version';
}

/** kj:<node>[@<version>][#<element>][~q(<json selector>)] */
export function formatAddress(a: Address): string {
  let s = `kj:${a.node}`;
  if (a.version !== undefined) s += `@${a.version}`;
  if (a.element) s += `#${a.element}`;
  if (a.selector) s += `~q(${JSON.stringify(a.selector)})`;
  return s;
}

const ADDRESS_RE = /^kj:([^@#~]+)(?:@(\d+))?(?:#([^~]+))?(?:~q\((.*)\))?$/;

export function parseAddress(s: string): Address {
  const m = ADDRESS_RE.exec(s);
  if (!m) throw new Error(`not a Konjir address: ${s}`);
  const [, node, version, element, sel] = m;
  if (sel && !element) throw new Error(`a selector needs an element: ${s}`);
  return {
    node,
    version: version === undefined ? undefined : Number(version),
    element: element || undefined,
    selector: sel ? (JSON.parse(sel) as QuoteSelector) : undefined,
  };
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function fingerprint(text: string): string {
  return createHash('sha256').update(normalize(text)).digest('base64url').slice(0, 22);
}

// ---------------------------------------------------------------------------
// Span resolution (DAT6, ADR8). Re-anchoring is never silent:
//   exact  - the quoted words appear verbatim, wherever they now sit: clean
//   fuzzy  - a near match (similarity >= FUZZY_THRESHOLD): counts as a change
//   orphan - nothing close enough
//
// Matching follows Hypothesis's text-quote anchoring on diff-match-patch:
//   1. Every verbatim occurrence of the quote is a candidate; the recorded
//      prefix and suffix pick between them. Any verbatim occurrence is exact.
//   2. Otherwise the prefix (or failing that, the suffix) is located with
//      match_main to give an expected position, and the quote is matched
//      near it with match_main (bitap), in slices of at most MATCH_MAX_BITS
//      characters, since bitap's pattern is one machine word.
//   3. The slices' hits bound a region; a diff of the quote against that
//      region fixes the span's start and end, then the word boundaries near
//      each end are tried, for quotes whose first or last words were edited.
//   4. The span is verified against the whole quote by edit distance. If a
//      context-guided search fails verification, it is retried without the
//      context, so a misleading prefix can't orphan a quote that is present.
// All offsets are into normalize(haystack).
// ---------------------------------------------------------------------------

export type SpanResolution =
  | { status: 'exact'; content: string; start: number; end: number }
  | { status: 'fuzzy'; content: string; similarity: number; start: number; end: number }
  | { status: 'orphan' };

/** The least similarity (1 - edit distance / longer length) a near match needs. */
export const FUZZY_THRESHOLD = 0.75;

/** bitap's pattern limit: diff-match-patch's default word size. */
export const MATCH_MAX_BITS = 32;

/** At most this many slices of a long quote are matched; the diff and the verification see all of it. */
const MAX_SLICES = 16;

/**
 * bitap's own cut-off (0 = perfect, 1 = anything), looser than FUZZY_THRESHOLD
 * so it proposes candidates; the verification decides.
 */
const MATCH_THRESHOLD = 0.5;

export function resolveSpan(haystack: string, sel: QuoteSelector): SpanResolution {
  const text = normalize(haystack);
  const exact = normalize(sel.exact);
  if (!exact || !text) return { status: 'orphan' };
  const prefix = normalize(sel.prefix ?? '');
  const suffix = normalize(sel.suffix ?? '');

  const verbatim = bestVerbatim(text, exact, prefix, suffix);
  if (verbatim >= 0) return { status: 'exact', content: exact, start: verbatim, end: verbatim + exact.length };

  const hint = contextHint(text, exact, prefix, suffix);
  let found = hint === undefined ? undefined : nearMatch(text, exact, hint);
  if (!found || found.similarity < FUZZY_THRESHOLD) {
    const loose = nearMatch(text, exact, Math.floor(text.length / 2));
    if (loose && (!found || loose.similarity > found.similarity)) found = loose;
  }
  if (!found || found.similarity < FUZZY_THRESHOLD) return { status: 'orphan' };
  return { status: 'fuzzy', ...found };
}

/** 1 - (edit distance / longer length), with the distance from diff-match-patch's diff. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = Math.max(a.length, b.length);
  if (!longer) return 1;
  return 1 - diffLevenshtein(diffMain(a, b, { diffTimeout: 0 })) / longer;
}

/** The verbatim occurrence whose surroundings best agree with the recorded context, or -1. */
function bestVerbatim(text: string, exact: string, prefix: string, suffix: string): number {
  let best = -1;
  let bestScore = -1;
  for (let at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) {
    const score = contextScore(text, at, at + exact.length, prefix, suffix);
    if (score > bestScore) { best = at; bestScore = score; }
    if (!prefix && !suffix) break;
  }
  return best;
}

/** How many characters of the recorded prefix and suffix still surround [start, end). */
function contextScore(text: string, start: number, end: number, prefix: string, suffix: string): number {
  const before = text.slice(Math.max(0, start - prefix.length - 1), start).trimEnd();
  const after = text.slice(end, end + suffix.length + 1).trimStart();
  return (prefix ? diffCommonSuffix(before, prefix) : 0) + (suffix ? diffCommonPrefix(after, suffix) : 0);
}

/** Where the quote should start, judged from its recorded context; undefined if neither is found. */
function contextHint(text: string, exact: string, prefix: string, suffix: string): number | undefined {
  const opts = options(text);
  if (prefix) {
    const tail = prefix.slice(-MATCH_MAX_BITS);
    const at = matchMain(text, tail, Math.floor(text.length / 2), opts);
    if (at >= 0) return Math.min(text.length, at + tail.length + 1);
  }
  if (suffix) {
    const head = suffix.slice(0, MATCH_MAX_BITS);
    const at = matchMain(text, head, Math.floor(text.length / 2), opts);
    if (at >= 0) return Math.max(0, at - exact.length - 1);
  }
  return undefined;
}

/**
 * Hypothesis's setting: a match the whole text away costs 0.5, so the
 * expected position steers ties without excluding distant matches.
 */
function options(text: string): DiffMatchPathOptions {
  return { matchThreshold: MATCH_THRESHOLD, matchDistance: Math.max(1000, text.length * 2), matchMaxBits: MATCH_MAX_BITS };
}

/** The quote's slices, at their offsets in it: at most MAX_SLICES, spread evenly, ending with its tail. */
function slices(exact: string): { offset: number; text: string }[] {
  if (exact.length <= MATCH_MAX_BITS) return [{ offset: 0, text: exact }];
  const offsets: number[] = [];
  for (let o = 0; o + MATCH_MAX_BITS < exact.length; o += MATCH_MAX_BITS) offsets.push(o);
  offsets.push(exact.length - MATCH_MAX_BITS);
  const picked = offsets.length <= MAX_SLICES ? offsets
    : Array.from({ length: MAX_SLICES }, (_, i) => offsets[Math.round((i * (offsets.length - 1)) / (MAX_SLICES - 1))]);
  return picked.map((offset) => ({ offset, text: exact.slice(offset, offset + MATCH_MAX_BITS) }));
}

/** The best near match of the quote around loc, with its similarity; undefined if no slice is found. */
function nearMatch(text: string, exact: string, loc: number):
  { content: string; similarity: number; start: number; end: number } | undefined {
  const opts = options(text);
  let start = Infinity;
  let end = -Infinity;
  let expected = loc;
  for (const slice of slices(exact)) {
    const at = matchMain(text, slice.text, Math.max(0, Math.min(text.length, expected + slice.offset)), opts);
    if (at < 0) continue;
    // Later slices should follow this one closely.
    expected = at - slice.offset;
    start = Math.min(start, at - slice.offset);
    end = Math.max(end, at + (exact.length - slice.offset));
  }
  if (start === Infinity) return undefined;

  // Fix the boundaries: diff the quote against the region the hits bound, padded for edits.
  const pad = Math.ceil(exact.length * (1 - FUZZY_THRESHOLD)) + 1;
  const from = Math.max(0, start - pad);
  const region = text.slice(from, Math.min(text.length, end + pad));
  const diffs = diffMain(exact, region, { diffTimeout: 0 });
  diffCleanupSemantic(diffs);
  let s = from + diffXIndex(diffs, 0);
  // diffXIndex maps a position in the quote to one in the region; map the last character, so a
  // trailing insertion (the padding) is left out.
  let e = from + diffXIndex(diffs, exact.length - 1) + 1;
  while (s < e && text[s] === ' ') s++;
  while (e > s && text[e - 1] === ' ') e--;
  if (e <= s) return undefined;

  // Where the quote's own first or last words were edited, the diff can't tell them from the
  // padding. Try the word boundaries near each end, the start then the end, and keep the most
  // similar span; the diff's own boundaries stay candidates, so this never does worse.
  let best = similarity(exact, text.slice(s, e));
  for (let c = Math.max(0, s - MATCH_MAX_BITS); c <= Math.min(e - 1, s + MATCH_MAX_BITS); c++) {
    if (c !== 0 && text[c - 1] !== ' ') continue;
    const score = similarity(exact, text.slice(c, e));
    if (score > best) { best = score; s = c; }
  }
  for (let c = Math.max(s + 1, e - MATCH_MAX_BITS); c <= Math.min(text.length, e + MATCH_MAX_BITS); c++) {
    if (c !== text.length && text[c] !== ' ') continue;
    const score = similarity(exact, text.slice(s, c));
    if (score > best) { best = score; e = c; }
  }
  return { content: text.slice(s, e), similarity: best, start: s, end: e };
}
