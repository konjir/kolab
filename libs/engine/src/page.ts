/**
 * Cursor pagination and size limits (W2.21, P13, D71). A list is read in pages: each a stable sort
 * on a key that ends in a unique id, read with a keyset (the rows after the last one shown), so an
 * insert between two pages neither repeats nor skips a row that was already there. A cursor is
 * opaque to its reader: the list it belongs to and the last row's key, base64url-encoded JSON.
 */
import {
  MAX_ELEMENT_TEXT, MAX_ELEMENTS, MAX_EVIDENCE, MAX_EVIDENCE_TEXT, MAX_TEXT, MAX_VERSION_BYTES, PAGE_DEFAULT, PAGE_MAX, textLength,
} from '@konjir/types';

/** A request over one of Kolab's limits, or a cursor that isn't one Kolab gave for that list. Nothing was written. */
export class LimitError extends Error { name = 'LimitError'; }

/** What a list's caller asks for: where to start (a `next` it was given) and how many. */
export interface PageOpts { cursor?: string | null; limit?: number | null }

/** The page size asked for, checked: PAGE_DEFAULT by default, at most PAGE_MAX. */
export function pageSize(limit?: number | null): number {
  if (limit === undefined || limit === null) return PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1) throw new LimitError(`limit is a whole number from 1 to ${PAGE_MAX}`);
  return Math.min(limit, PAGE_MAX);
}

/** A cursor for `list`, after the row whose sort key is `key`. */
export function cursorFor(list: string, key: unknown[]): string {
  return Buffer.from(JSON.stringify([list, ...key])).toString('base64url');
}

/** The sort key a cursor for `list` carries, of `arity` parts; undefined for the first page. Anything else is refused. */
export function keyOf(list: string, cursor: string | null | undefined, arity: number): unknown[] | undefined {
  if (cursor === undefined || cursor === null || cursor === '') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { parsed = undefined; }
  if (!Array.isArray(parsed) || parsed[0] !== list || parsed.length !== arity + 1
      || parsed.slice(1).some((x) => x !== null && typeof x !== 'string' && typeof x !== 'number')) {
    throw new LimitError(`that cursor isn't one this list gave: pass the next it returned, unchanged, with the same filters, or leave cursor out to start again`);
  }
  return parsed.slice(1);
}

/**
 * One page of rows read with `limit + 1` (the extra one only says there is more): the first
 * `limit`, and the cursor after the last of them, or null on the last page.
 */
export function pageOf<T>(rows: T[], limit: number, list: string, key: (r: T) => unknown[]): { rows: T[]; next: string | null } {
  if (rows.length <= limit) return { rows, next: null };
  const shown = rows.slice(0, limit);
  return { rows: shown, next: cursorFor(list, key(shown[shown.length - 1])) };
}

/** Refuses a text over `max` characters, naming what it is. */
export function checkText(what: string, text: string | null | undefined, max = MAX_TEXT) {
  if (typeof text !== 'string') return;
  const n = textLength(text);
  if (n > max) throw new LimitError(`${what} is ${n.toLocaleString('en')} characters; the limit is ${max.toLocaleString('en')}. Shorten it${max === MAX_TEXT ? ', or link to the detail by address' : ''}`);
}

/** Refuses evidence over MAX_EVIDENCE items, or an item over MAX_EVIDENCE_TEXT characters. */
export function checkEvidence(evidence: string[]) {
  if (evidence.length > MAX_EVIDENCE) throw new LimitError(`that is ${evidence.length} items of evidence; the limit is ${MAX_EVIDENCE}. Cite the strongest`);
  evidence.forEach((e, i) => checkText(`evidence item ${i + 1}`, e, MAX_EVIDENCE_TEXT));
}

/**
 * Refuses a draft's input before any work is done on it: more elements or changes than a version
 * may hold, or an element's text over MAX_ELEMENT_TEXT.
 */
export function checkDraftInput(input: { elements?: { id?: string; text: string }[]; deltas?: { element: string; text?: string }[] }) {
  const n = input.elements?.length ?? input.deltas?.length ?? 0;
  if (n > MAX_ELEMENTS) {
    throw new LimitError(`that draft sends ${n.toLocaleString('en')} ${input.elements ? 'elements' : 'changes'}; a version holds at most ${MAX_ELEMENTS.toLocaleString('en')} elements. Split the node into several nodes`);
  }
  for (const e of input.elements ?? []) checkText(`element ${e.id ?? '(new)'}'s text`, e.text, MAX_ELEMENT_TEXT);
  for (const d of input.deltas ?? []) checkText(`element ${d.element}'s text`, d.text, MAX_ELEMENT_TEXT);
}

/** Refuses a version, as drafted, of more than MAX_ELEMENTS elements or MAX_VERSION_BYTES of text. */
export function checkVersion(els: { element_id: string; text: string; parent_element_id: string | null }[]) {
  if (els.length > MAX_ELEMENTS) {
    throw new LimitError(`that version would hold ${els.length.toLocaleString('en')} elements; the limit is ${MAX_ELEMENTS.toLocaleString('en')}. Split the node into several nodes`);
  }
  let bytes = 0;
  for (const e of els) {
    checkText(`element ${e.element_id}'s text`, e.text, MAX_ELEMENT_TEXT);
    bytes += Buffer.byteLength(e.element_id) + Buffer.byteLength(e.text) + (e.parent_element_id ? Buffer.byteLength(e.parent_element_id) : 0);
  }
  if (bytes > MAX_VERSION_BYTES) {
    throw new LimitError(`that version would hold ${Math.ceil(bytes / 1024).toLocaleString('en')} KiB of text; the limit is ${MAX_VERSION_BYTES / 1024} KiB. Split the node into several nodes`);
  }
}
