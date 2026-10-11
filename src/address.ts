import { createHash } from 'node:crypto';

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
// Span resolution: exact match (context breaks ties) -> clean;
// near match -> fuzzy (counts as a change); nothing -> orphan.
// ---------------------------------------------------------------------------

export type SpanResolution =
  | { status: 'exact'; content: string }
  | { status: 'fuzzy'; content: string; similarity: number }
  | { status: 'orphan' };

export const FUZZY_THRESHOLD = 0.75;

export function resolveSpan(haystack: string, sel: QuoteSelector): SpanResolution {
  const text = normalize(haystack);
  const exact = normalize(sel.exact);
  if (!exact) return { status: 'orphan' };

  if (text.includes(exact)) return { status: 'exact', content: exact };

  // Fuzzy: best window of similar length, scored by edit-distance ratio,
  // nudged by whether the recorded context still surrounds it.
  let best = { score: 0, content: '' };
  const minLen = Math.max(1, Math.floor(exact.length * 0.7));
  const maxLen = Math.ceil(exact.length * 1.3);
  for (let start = 0; start < text.length; start++) {
    for (let len = minLen; len <= maxLen && start + len <= text.length; len += Math.max(1, Math.floor(exact.length / 10))) {
      const cand = text.slice(start, start + len);
      let score = similarity(exact, cand);
      if (sel.prefix && text.slice(Math.max(0, start - 32), start).endsWith(normalize(sel.prefix).slice(-8))) score += 0.05;
      if (sel.suffix && text.slice(start + len, start + len + 32).startsWith(normalize(sel.suffix).slice(0, 8))) score += 0.05;
      if (score > best.score) best = { score, content: cand };
    }
  }
  if (best.score >= FUZZY_THRESHOLD) return { status: 'fuzzy', content: best.content, similarity: Math.min(1, best.score) };
  return { status: 'orphan' };
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}
