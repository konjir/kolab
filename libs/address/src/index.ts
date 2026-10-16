import { createHash } from 'node:crypto';
import {
  type Diff, type DiffMatchPathOptions, DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, diffCleanupSemantic, diffCommonPrefix,
  diffCommonSuffix, diffLevenshtein, diffMain, matchMain,
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
//   exact  - the quoted words appear verbatim, as whole words, wherever they
//            now sit, and their recorded prefix or suffix still agrees (D42):
//            clean
//   fuzzy  - a verbatim copy whose context doesn't agree, or a near match
//            (similarity >= FUZZY_THRESHOLD): counts as a change
//   orphan - nothing close enough
//
// Matching follows Hypothesis's text-quote anchoring on diff-match-patch:
//   1. Every verbatim occurrence of the quote that starts and ends on a word
//      boundary is a candidate; the recorded prefix and suffix pick between
//      them. It is exact where that context agrees (more than half of the
//      words of the prefix or of the suffix still adjoin it; see
//      contextAgrees), or where no context was recorded. One glued to a longer word ("30" in
//      "300") is no candidate: it falls through to near matching.
//   1a. A verbatim occurrence whose context doesn't agree is a change. The
//      near match right where the context points, if the context agrees
//      there, wins over it: that is the quoted statement, edited. Otherwise
//      the verbatim copy is the fuzzy match, with similarity 1.
//   2. Otherwise the prefix (or failing that, the suffix) is located with
//      match_main to give an expected position, and the quote is matched
//      near it with match_main (bitap), in slices of at most MATCH_MAX_BITS
//      characters, since bitap's pattern is one machine word.
//   3. The slices' hits that agree on where the quote starts bound a region;
//      a diff of the quote against that region fixes the span's ends. An
//      edit at either end of the quote takes in as much of the replacing
//      text as it replaced, without crossing a sentence's end. The ends are then widened to whole words and
//      whole characters (never half a surrogate pair or a bare combining mark).
//   4. The span is verified against the whole quote by edit distance. A span
//      whose length alone rules it out is never diffed, and no diff runs past
//      DIFF_TIMEOUT. A context-guided search looks only near where the
//      context points; if it fails, the search is retried over the whole
//      element without the context, so a misleading prefix can't orphan a
//      quote that is present.
//   5. A quote shorter than SHORT_QUOTE characters is only a near match where
//      its recorded context still agrees, by the same rule. Otherwise one
//      edit would re-anchor it to any similar word ("cart" to "card"). With
//      no context recorded, a short quote is exact or an orphan.
//
// Text, quote and context are compared in Unicode NFC, so a quote and an
// element that encode the same characters differently still match. The
// offsets returned are into normalize(haystack), not its NFC form, and a
// fuzzy span's content is sliced from normalize(haystack). normalize() itself
// is unchanged, so fingerprints are too.
//
// Scripts written without spaces (Han, kana, Thai, Lao, Khmer, Myanmar) have
// a word boundary between any two of their characters.
// ---------------------------------------------------------------------------

export type SpanResolution =
  | { status: 'exact'; content: string; start: number; end: number }
  | { status: 'fuzzy'; content: string; similarity: number; start: number; end: number }
  | { status: 'orphan' };

/** The least similarity (1 - edit distance / longer length) a near match needs. */
export const FUZZY_THRESHOLD = 0.75;

/** bitap's pattern limit: diff-match-patch's default word size. */
export const MATCH_MAX_BITS = 32;

/**
 * Below this many characters (code points), a near match needs its recorded context to agree.
 * At 4 characters one edit is exactly the threshold, so "cart" would otherwise re-anchor to
 * any "card"; by 10, it takes three edits elsewhere to pass for the quote.
 */
export const SHORT_QUOTE = 10;

/** At most this many slices of a long quote are matched; the diff and the verification see all of it. */
const MAX_SLICES = 16;

/**
 * bitap's own cut-off (0 = perfect, 1 = anything), looser than FUZZY_THRESHOLD
 * so it proposes candidates; the verification decides.
 */
const MATCH_THRESHOLD = 0.5;

/**
 * Seconds any one diff may take. Past it, diff-match-patch returns a coarser
 * diff, which can only overstate the edit distance: a match may come out an
 * orphan, never the reverse. Normal spans finish far inside it.
 */
const DIFF_TIMEOUT = 0.25;

/** A sentence's end, then the space before the next. */
const SENTENCE_END = /(?:[.!?;](?=\s|$)|[。！？])\s?/gu;
const TERMINATOR = /^[.!?;。！？]$/u;

/** The shortest equality at either end of the quote's diff that anchors that end. */
const MIN_ANCHOR = 3;


export function resolveSpan(haystack: string, sel: QuoteSelector): SpanResolution {
  const original = normalize(haystack);
  const quote = normalize(sel.exact);
  if (!quote || !original) return { status: 'orphan' };
  const folded = fold(original);
  const text = folded.text;
  const exact = quote.normalize('NFC');
  const prefix = normalize(sel.prefix ?? '').normalize('NFC');
  const suffix = normalize(sel.suffix ?? '').normalize('NFC');

  const hasContext = !!(prefix || suffix);
  const agrees = (at: number, to: number) => contextAgrees(text, at, to, prefix, suffix);
  const fuzzy = (at: number, to: number, sim: number): SpanResolution => {
    const start = folded.toOriginal(at);
    const end = folded.toOriginal(to);
    return { status: 'fuzzy', content: original.slice(start, end), similarity: sim, start, end };
  };

  // D42: a verbatim occurrence is exact only where its recorded prefix or suffix still agrees.
  // With no context recorded there is nothing to disagree with, so any verbatim occurrence is.
  const verbatim = bestVerbatim(text, exact, prefix, suffix);
  if (verbatim >= 0 && (!hasContext || agrees(verbatim, verbatim + exact.length))) {
    return { status: 'exact', content: quote, start: folded.toOriginal(verbatim), end: folded.toOriginal(verbatim + exact.length) };
  }

  // The context points somewhere: first, the near match right where it points, if the context
  // agrees there. That is the quoted statement, edited, and it beats a copy elsewhere.
  const hint = contextHint(text, exact, prefix, suffix);
  if (hint !== undefined) {
    const anchored = nearMatch(text, exact, hint, 'anchored');
    if (anchored && anchored.similarity >= FUZZY_THRESHOLD && agrees(anchored.start, anchored.end)) {
      return fuzzy(anchored.start, anchored.end, anchored.similarity);
    }
  }
  // A verbatim copy whose context doesn't agree: a change (D42), pinned to that copy.
  if (verbatim >= 0) return fuzzy(verbatim, verbatim + exact.length, 1);

  let found = hint === undefined ? undefined : nearMatch(text, exact, hint, 'local');
  if (!found || found.similarity < FUZZY_THRESHOLD) {
    const loose = nearMatch(text, exact, Math.floor(text.length / 2), 'whole');
    if (loose && (!found || loose.similarity > found.similarity)) found = loose;
  }
  if (!found || found.similarity < FUZZY_THRESHOLD) return { status: 'orphan' };
  if ([...exact].length < SHORT_QUOTE && !agrees(found.start, found.end)) return { status: 'orphan' };
  return fuzzy(found.start, found.end, found.similarity);
}

/** 1 - (edit distance / longer length), with the distance from diff-match-patch's diff. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = Math.max(a.length, b.length);
  if (!longer) return 1;
  return 1 - diffLevenshtein(diffMain(a, b, { diffTimeout: DIFF_TIMEOUT })) / longer;
}

/** The similarity, or 0 without diffing when the lengths alone keep it under the threshold. */
function bounded(exact: string, candidate: string): number {
  // 1 - d/longer <= shorter/longer, since d >= longer - shorter.
  const ratio = Math.min(exact.length, candidate.length) / Math.max(exact.length, candidate.length);
  return ratio < FUZZY_THRESHOLD ? 0 : similarity(exact, candidate);
}

// ---- Unicode: NFC for comparison, word and character boundaries -------------

/** text in NFC, with a map from its offsets (at character boundaries) back to the input's. */
function fold(input: string): { text: string; toOriginal: (at: number) => number } {
  if (input.normalize('NFC') === input) return { text: input, toOriginal: (at) => at };
  // NFC composes a base with the marks that follow it, so fold each base-plus-marks run on
  // its own and keep where each one starts on both sides.
  const from: number[] = [];
  const to: number[] = [];
  let text = '';
  for (const m of input.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    from.push(text.length);
    to.push(m.index);
    text += m[0].normalize('NFC');
  }
  return {
    text,
    toOriginal(at) {
      if (at >= text.length) return input.length;
      let lo = 0;
      let hi = from.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (from[mid] <= at) lo = mid; else hi = mid - 1;
      }
      return to[lo];
    },
  };
}

const WORDY = /^[\p{L}\p{N}\p{M}]$/u;
const SPACELESS = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]$/u;
/** Joins the characters either side of it into one: marks, joiners, variation selectors, skin tones. */
const JOINS_PREVIOUS = /^[\p{M}‍︀-️\u{1F3FB}-\u{1F3FF}]$/u;

/** The code point that ends just before at, and the one that starts at at. */
function before(text: string, at: number): string | undefined {
  if (at <= 0) return undefined;
  const low = text.charCodeAt(at - 1);
  return at >= 2 && low >= 0xdc00 && low <= 0xdfff ? text.slice(at - 2, at) : text[at - 1];
}
function after(text: string, at: number): string | undefined {
  if (at >= text.length) return undefined;
  return String.fromCodePoint(text.codePointAt(at)!);
}

/** True when at splits a character: a surrogate pair, a base from its marks, or a joined sequence. */
function splitsCharacter(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false;
  const c = text.charCodeAt(at);
  if (c >= 0xdc00 && c <= 0xdfff) return true;
  return JOINS_PREVIOUS.test(after(text, at)!) || before(text, at) === '‍';
}

/** True when the characters x and y, side by side, belong to one word. */
function glued(x: string | undefined, y: string | undefined): boolean {
  return x !== undefined && y !== undefined && WORDY.test(x) && WORDY.test(y) && !SPACELESS.test(x) && !SPACELESS.test(y);
}

/** True when at is a word boundary: not inside a character, and not between two letters of one word. */
function boundary(text: string, at: number): boolean {
  return !splitsCharacter(text, at) && !glued(before(text, at), after(text, at));
}

// ---- Verbatim matches and context -------------------------------------------

/** The whole-word verbatim occurrence whose surroundings best agree with the recorded context, or -1. */
function bestVerbatim(text: string, exact: string, prefix: string, suffix: string): number {
  let best = -1;
  let bestScore = -1;
  for (let at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) {
    if (!boundary(text, at) || !boundary(text, at + exact.length)) continue;
    // An occurrence whose context agrees outranks any that doesn't, however many characters match.
    const score = contextScore(text, at, at + exact.length, prefix, suffix)
      + (contextAgrees(text, at, at + exact.length, prefix, suffix) ? text.length + prefix.length + suffix.length : 0);
    if (score > bestScore) { best = at; bestScore = score; }
    if (!prefix && !suffix) break;
  }
  return best;
}

function contextAround(text: string, start: number, end: number, prefix: string, suffix: string) {
  const ahead = text.slice(Math.max(0, start - prefix.length - 1), start).trimEnd();
  const behind = text.slice(end, end + suffix.length + 1).trimStart();
  return { ahead, behind, prefix: prefix ? diffCommonSuffix(ahead, prefix) : 0, suffix: suffix ? diffCommonPrefix(behind, suffix) : 0 };
}

/** How many characters of the recorded prefix and suffix still surround [start, end). */
function contextScore(text: string, start: number, end: number, prefix: string, suffix: string): number {
  const c = contextAround(text, start, end, prefix, suffix);
  return c.prefix + c.suffix;
}

/**
 * True when the recorded prefix or suffix still agrees around the span: more than half of its
 * words adjoin it, compared without case. Words, not characters, so that a shared "said" or
 * "the" next to some other statement doesn't pass for its context. A word cut off where the
 * prefix was recorded counts, if the text still has that much of it. In a script written
 * without spaces, more than half of its characters must adjoin.
 */
function contextAgrees(text: string, start: number, end: number, prefix: string, suffix: string): boolean {
  const c = contextAround(text, start, end, prefix, suffix);
  const p = lower(prefix);
  const q = lower(suffix);
  const ahead = lower(c.ahead);
  const behind = lower(c.behind);
  return (!!p && sideAgrees(reverse(p), reverse(ahead), diffCommonSuffix(ahead, p)))
    || (!!q && sideAgrees(q, behind, diffCommonPrefix(behind, q)));
}

/** Lower case, where that keeps the length (so offsets still line up). */
function lower(s: string): string {
  const l = s.toLowerCase();
  return l.length === s.length ? l : s;
}

/** In UTF-16 code units, like the offsets it is compared at. */
function reverse(s: string): string {
  return s.split('').reverse().join('');
}

/**
 * Whether the first `matched` characters of recorded (read away from the span) agree as words.
 * For a prefix, both strings are reversed, so they too are read away from the span.
 */
function sideAgrees(recorded: string, seen: string, matched: number): boolean {
  if (!matched) return false;
  if (!recorded.includes(' ') && [...recorded].some((ch) => SPACELESS.test(ch))) return matched * 2 > recorded.length;
  const words = recorded.split(' ').filter(Boolean);
  if (matched >= recorded.length) return true;
  const part = recorded.slice(0, matched);
  let whole = part.split(' ').filter(Boolean).length;
  // The last word read is whole only if both the recorded context and the text end it there.
  const last = part[part.length - 1];
  if (last !== ' ' && (WORDY.test(recorded[matched] ?? '') || WORDY.test(seen[matched] ?? '')) && WORDY.test(last)) whole--;
  return whole * 2 > words.length;
}

/** Where the quote should start, judged from its recorded context; undefined if neither is found. */
function contextHint(text: string, exact: string, prefix: string, suffix: string): number | undefined {
  const opts = options(text, exact, 'whole');
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

// ---- Near matches -----------------------------------------------------------

type Reach = 'anchored' | 'local' | 'whole';

/**
 * How far from loc a match may be:
 *   whole    - Hypothesis's setting: a match the whole text away costs 0.5, so
 *              loc steers ties without excluding distant matches
 *   local    - about a quote's length either side of where the context points,
 *              and at least 500 characters
 *   anchored - right where the context points: a match a quote's length away
 *              costs a full 1.0, so a closer, more edited match wins over a
 *              verbatim one elsewhere
 */
function options(text: string, exact: string, reach: Reach): DiffMatchPathOptions {
  const matchDistance = reach === 'whole' ? Math.max(1000, text.length * 2)
    : reach === 'local' ? 1000 + 2 * exact.length
      : Math.max(MATCH_MAX_BITS, exact.length);
  return { matchThreshold: MATCH_THRESHOLD, matchDistance, matchMaxBits: MATCH_MAX_BITS };
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

/** The best near match of the quote around loc, with its similarity; undefined if there is none worth verifying. */
function nearMatch(text: string, exact: string, loc: number, reach: Reach):
  { similarity: number; start: number; end: number } | undefined {
  const opts = options(text, exact, reach);
  // Each hit says where the quote would start.
  const starts: number[] = [];
  let expected = loc;
  for (const slice of slices(exact)) {
    const at = matchMain(text, slice.text, Math.max(0, Math.min(text.length, expected + slice.offset)), opts);
    if (at < 0) continue;
    expected = at - slice.offset; // later slices should follow this one closely
    starts.push(at - slice.offset);
  }
  if (!starts.length) return undefined;

  // Keep the hits that agree with their median, so stray hits elsewhere can't widen the region.
  const sorted = [...starts].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const slack = Math.ceil(exact.length * (1 - FUZZY_THRESHOLD)) + 1;
  const agreeing = sorted.filter((x) => Math.abs(x - median) <= slack);
  const first = agreeing[0];
  const last = agreeing[agreeing.length - 1];

  // Fix the boundaries: diff the quote against the region the hits bound, padded for edits.
  const from = Math.max(0, first - slack);
  const region = text.slice(from, Math.min(text.length, last + exact.length + slack));
  const diffs = diffMain(exact, region, { diffTimeout: DIFF_TIMEOUT });
  diffCleanupSemantic(diffs);
  const span = ends(diffs, region.length);
  let s = from + span.start;
  let e = from + span.end;
  // Taking in replacing text never crosses into another sentence.
  const lead = text.slice(s, from + span.innerStart);
  const leadBreak = [...lead.matchAll(SENTENCE_END)].at(-1);
  if (leadBreak) s += leadBreak.index + leadBreak[0].length;
  const inner = from + span.innerEnd;
  const trailBreak = text.slice(inner, e).matchAll(SENTENCE_END).next().value;
  if (trailBreak) e = inner + trailBreak.index;

  // Whole words and whole characters, then no surrounding spaces.
  while (s > 0 && !boundary(text, s)) s--;
  while (e < text.length && !boundary(text, e)) e++;
  while (s < e && text[s] === ' ') s++;
  while (e > s && text[e - 1] === ' ') e--;
  if (e <= s) return undefined;
  // A quote that ended a sentence keeps the full stop, where the text still has one there.
  if (TERMINATOR.test(exact.at(-1)!) && text[e] === exact.at(-1)) e++;
  const sim = bounded(exact, text.slice(s, e));
  return { similarity: sim, start: s, end: e };
}

/**
 * Where the quote starts and ends in the region, from their diff. At each end,
 * the edits outside the outermost equality are the quote's own edited words
 * plus the region's padding; the span takes as much of the inserted text,
 * next to the equality, as the quote lost there.
 */
function ends(diffs: Diff[], regionLength: number): { start: number; end: number; innerStart: number; innerEnd: number } {
  let leadDeleted = 0;
  let leadInserted = 0;
  const anchors = diffs.filter(([op, chunk]) => op === DIFF_EQUAL && chunk.length >= MIN_ANCHOR).length;
  // A stray equality of a character or two at an edge (a full stop in the padding) is no anchor.
  const anchor = ([op, chunk]: Diff) => op === DIFF_EQUAL && (chunk.length >= MIN_ANCHOR || !anchors);
  for (const d of diffs) {
    if (anchor(d)) break;
    if (d[0] !== DIFF_INSERT) leadDeleted += d[1].length;
    if (d[0] !== DIFF_DELETE) leadInserted += d[1].length;
  }
  let trailDeleted = 0;
  let trailInserted = 0;
  for (let i = diffs.length - 1; i >= 0; i--) {
    if (anchor(diffs[i])) break;
    if (diffs[i][0] !== DIFF_INSERT) trailDeleted += diffs[i][1].length;
    if (diffs[i][0] !== DIFF_DELETE) trailInserted += diffs[i][1].length;
  }
  if (!diffs.some(([op]) => op === DIFF_EQUAL)) return { start: 0, end: 0, innerStart: 0, innerEnd: 0 };
  return {
    start: leadInserted - Math.min(leadInserted, leadDeleted),
    end: regionLength - trailInserted + Math.min(trailInserted, trailDeleted),
    innerStart: leadInserted,
    innerEnd: regionLength - trailInserted,
  };
}
