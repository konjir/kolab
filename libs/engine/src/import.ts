/**
 * The file `konjir import` reads (W6.3; D15, D104, D109): a kolab's spec, its binding with its
 * decisions and work packages, its rulings and its repository, as one JSON document, checked whole
 * here before Kolab writes anything (Kolab.importKolab). Its shape is documented in README.md
 * ("Importing a kolab") and `IMPORT_FORMAT` names it, so a file written for another shape is refused.
 *
 * Only the shape is checked here, every problem named at once; what needs the database (who may
 * write, what is there already) and the engine's own checks of a version (its size, its ids, its
 * work fields, PLN2) run in importKolab, still before anything is written.
 */
import { isElementId, isKolabName, isNodeName, parseAddress, UNSAFE_NAME_CHAR } from '@konjir/address';
import { MAX_ELEMENT_TEXT, MAX_ELEMENTS, MAX_TEXT, MAX_TITLE, RULING_EFFECTS, RULING_REF, textLength, type RulingEffect, type WorkFields } from '@konjir/types';
import { GateError } from './kolab.js';

/** The format a file names: the only one this release reads. */
export const IMPORT_FORMAT = 'konjir-import/1';

/**
 * What an import did, or with a dry run would do, step by step: `created` (written: a node made, a
 * version committed, a ruling given, a repository registered), `unchanged` (there already, equal),
 * `differs` (there already, and not as the file says: left alone), `in_review` (submitted, and
 * waiting for its reviewers under the kolab's policy), `waiting` (on something not committed yet;
 * a later run completes it), `other_pass` (what the other role's sign-in writes: a pass writes only
 * what its role may), `sent_back` (a reviewer asked for changes: its author resubmits or abandons it),
 * `failed`; and, for a dry run, `would_create` and `would_update`.
 */
export type ImportOutcome = 'created' | 'unchanged' | 'differs' | 'in_review' | 'waiting' | 'other_pass' | 'sent_back' | 'failed' | 'would_create' | 'would_update';

export interface ImportStep {
  /** What the step is about: `node kj:<kolab>/<node>`, `version …`, `links … (relies_on)`, `repository <url>`, `ruling <ref>`. */
  what: string;
  outcome: ImportOutcome;
  /** The node's version the step wrote, submitted or compared. */
  version?: number;
  /** Who may approve a version in review now. */
  reviewers?: string[];
  /** A ruling that changes the intent: `set`, it marked what it rules on; `carried`, that last changed after its date, so no mark. */
  mark?: 'set' | 'carried';
  /** The case files a ruling superseded. */
  superseded?: string[];
  detail?: string;
}

export interface ImportReport {
  kolab: string;
  /** The person it ran as, and the role of this pass. */
  by: string;
  role: string;
  dry_run: boolean;
  steps: ImportStep[];
  created: string[]; unchanged: string[]; differs: string[];
  /** In review or waiting: what a later run, or a reviewer, completes. */
  waiting: string[];
  /** Versions a reviewer sent back: their author's to resubmit or abandon. */
  sent_back: string[];
  /** What the other role's pass writes; `next` says how to run it. */
  other_pass: string[];
  next?: string;
  failed: string[];
  /** A dry run's writes. */
  would?: string[];
  /** Every step created or unchanged: the kolab holds the whole file. Never for a dry run. */
  complete: boolean;
}

/** The most problems a refusal names; it says how many more there are. */
const PROBLEMS_SHOWN = 50;

/** An element of the spec as the file gives it: its id, its text, and the element it sits under. */
export interface ImportElement { id: string; text: string; parent?: string }

/**
 * An element of the binding: a decision, or with `work` a work package (D104). `serves` names the
 * spec elements it serves and `relies_on` the binding's decisions it relies on: each a dependency
 * link (PLN1).
 */
export interface ImportBindingElement extends ImportElement { work?: WorkFields; serves: string[]; relies_on: string[] }

/** A ruling (D16): its ref (the Decisions Log's ID), when it was given, and what it rules on. */
export interface ImportRuling {
  id: string; date: string; text: string; replaces?: string; effect: RulingEffect;
  /** The node it rules on, the file's spec or binding, and the element, if one. */
  on: { node: string; element?: string };
}

export interface ImportFile {
  format: typeof IMPORT_FORMAT;
  kolab: string;
  spec?: { name: string; title: string; elements: ImportElement[] };
  binding?: { name: string; title: string; elements: ImportBindingElement[] };
  rulings: ImportRuling[];
  repository?: { url: string; root_sha: string; implements_binding: boolean };
}

const KEYS = {
  file: ['format', 'kolab', 'spec', 'binding', 'rulings', 'repository'],
  node: ['name', 'title', 'elements'],
  element: ['id', 'text', 'parent'],
  bindingElement: ['id', 'title', 'text', 'parent', 'work', 'serves', 'relies_on'],
  ruling: ['id', 'date', 'text', 'replaces', 'effect', 'on'],
  repository: ['url', 'root_sha', 'implements_binding'],
} as const;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Reads an import file, refusing it, every problem named, unless its whole shape is right: the
 * format, the kolab, each node's name, title and elements (ids unique and addressable, each parent
 * one of the node's own elements, no cycle), the binding's links (serves names spec elements;
 * relies_on names the binding's decisions, never a work package, D99; a milestone links nothing),
 * each ruling (a ref unique in the file, a date, its text, an effect, what it rules on) and the
 * repository. A key it doesn't know is refused, never dropped.
 */
export function parseImportFile(input: unknown): ImportFile {
  const problems: string[] = [];
  const say = (p: string) => problems.push(p);
  const unknownKeys = (x: Record<string, unknown>, keys: readonly string[], where: string) => {
    for (const k of Object.keys(x)) if (!keys.includes(k)) say(`${where} has ${JSON.stringify(k)}, which an import file doesn't take: it takes ${keys.join(', ')}`);
  };
  const text = (x: unknown, where: string, max: number, required = true): string | undefined => {
    if (x === undefined && !required) return undefined;
    if (typeof x !== 'string' || !x.trim()) { say(`${where} is text, and not empty`); return undefined; }
    if (textLength(x.trim()) > max) { say(`${where} is ${textLength(x.trim()).toLocaleString('en')} characters; the limit is ${max.toLocaleString('en')}`); return undefined; }
    return x.trim();
  };
  const ids = (x: unknown, where: string): string[] => {
    if (x === undefined) return [];
    if (!Array.isArray(x) || x.some((i) => typeof i !== 'string')) { say(`${where} is a list of element ids`); return []; }
    if (new Set(x).size !== x.length) say(`${where} names an element twice`);
    return x as string[];
  };

  if (!isObject(input)) throw new GateError('an import file is one JSON object: {"format": "konjir-import/1", "kolab": …, "spec": …, "binding": …, "rulings": […], "repository": …}');
  unknownKeys(input, KEYS.file, 'the file');
  if (input.format !== IMPORT_FORMAT) say(`the file's format is ${JSON.stringify(IMPORT_FORMAT)}, not ${JSON.stringify(input.format ?? null)}`);
  const kolab = typeof input.kolab === 'string' && isKolabName(input.kolab) ? input.kolab : (say(`kolab names the kolab to import into: lowercase letters, digits and '-', not ${JSON.stringify(input.kolab ?? null)}`), '');

  const nodeOf = <E extends ImportElement>(x: unknown, what: 'spec' | 'binding', element: (e: Record<string, unknown>, where: string) => E | undefined) => {
    if (x === undefined) return undefined;
    if (!isObject(x)) { say(`${what} is an object: {"name": …, "title": …, "elements": […]}`); return undefined; }
    unknownKeys(x, KEYS.node, what);
    const name = typeof x.name === 'string' && isNodeName(x.name) && !UNSAFE_NAME_CHAR.test(x.name) ? x.name
      : (say(`${what}.name is the node's name in its kolab, such as ${what === 'spec' ? 'kolab' : 'kolab-binding'}: no '/', '@', '#', '~', whitespace or control character`), '');
    const title = text(x.title, `${what}.title`, MAX_TITLE) ?? '';
    if (!Array.isArray(x.elements) || !x.elements.length) { say(`${what}.elements is a list of at least one element`); return undefined; }
    if (x.elements.length > MAX_ELEMENTS) say(`${what} has ${x.elements.length.toLocaleString('en')} elements; a version holds at most ${MAX_ELEMENTS.toLocaleString('en')}`);
    const out: E[] = [];
    const seen = new Set<string>();
    x.elements.forEach((e, i) => {
      const where = `${what}.elements[${i}]${isObject(e) && typeof e.id === 'string' ? ` (${e.id})` : ''}`;
      if (!isObject(e)) { say(`${where} is an object`); return; }
      if (typeof e.id !== 'string' || !isElementId(e.id)) { say(`${where}.id is the element's id, as addresses name it (such as ENF4): no whitespace, control character or '~'`); return; }
      if (seen.has(e.id)) { say(`${what} has two elements ${e.id}: an id names one element`); return; }
      seen.add(e.id);
      if (e.parent !== undefined && (typeof e.parent !== 'string' || !e.parent)) say(`${where}.parent is the id of the element it sits under`);
      const made = element(e, where);
      if (made) out.push(made);
    });
    // Each parent is one of the node's own elements, and no element sits under itself, however far down.
    const parent = new Map(out.map((e) => [e.id, e.parent]));
    for (const e of out) {
      if (e.parent === undefined) continue;
      if (!parent.has(e.parent)) { say(`${what} element ${e.id} sits under ${e.parent}, which isn't one of its elements`); continue; }
      const path = new Set([e.id]);
      for (let p: string | undefined = e.parent; p !== undefined; p = parent.get(p)) {
        if (path.has(p)) { say(`${what} element ${e.id} sits under itself, through ${[...path].join(' → ')}`); break; }
        path.add(p);
      }
    }
    return { name, title, elements: out };
  };

  const spec = nodeOf<ImportElement>(input.spec, 'spec', (e, where) => {
    unknownKeys(e, KEYS.element, where);
    const t = text(e.text, `${where}.text`, MAX_ELEMENT_TEXT);
    return t === undefined ? undefined : { id: e.id as string, text: t, ...(typeof e.parent === 'string' ? { parent: e.parent } : {}) };
  });
  const binding = nodeOf<ImportBindingElement>(input.binding, 'binding', (e, where) => {
    unknownKeys(e, KEYS.bindingElement, where);
    // A work package's title and its description, as one text: the title, then the description below it.
    const title = text(e.title, `${where}.title`, MAX_TITLE, false);
    const body = text(e.text, `${where}.text`, MAX_ELEMENT_TEXT, title === undefined);
    const t = title !== undefined && body !== undefined ? `${title}\n\n${body}` : title ?? body;
    if (t !== undefined && textLength(t) > MAX_ELEMENT_TEXT) say(`${where}'s title and text are ${textLength(t).toLocaleString('en')} characters together; an element holds at most ${MAX_ELEMENT_TEXT.toLocaleString('en')}`);
    if (e.work !== undefined && !isObject(e.work)) say(`${where}.work is an object of work fields: {"done_when": …, "depends_on": […], "size": "S"|"M"|"L", "milestone": true, "target_date": "YYYY-MM-DD", "repo": …}`);
    const serves = ids(e.serves, `${where}.serves`);
    const relies = ids(e.relies_on, `${where}.relies_on`);
    if (t === undefined) return undefined;
    return { id: e.id as string, text: t, ...(typeof e.parent === 'string' ? { parent: e.parent } : {}),
      ...(isObject(e.work) ? { work: e.work as WorkFields } : {}), serves, relies_on: relies };
  });

  if (binding && !spec) say('a binding binds the kolab\'s spec (D78): give the spec in the same file');
  if (spec && binding && spec.name === binding.name) say(`the spec and the binding are two nodes, so two names; both are ${spec.name}`);
  if (spec && binding) {
    const specIds = new Set(spec.elements.map((e) => e.id));
    const byId = new Map(binding.elements.map((e) => [e.id, e]));
    for (const e of binding.elements) {
      for (const t of e.serves) if (!specIds.has(t)) say(`binding element ${e.id} serves ${t}, which isn't an element of the spec`);
      for (const t of e.relies_on) {
        const target = byId.get(t);
        if (!target) say(`binding element ${e.id} relies on ${t}, which isn't an element of the binding`);
        else if (t === e.id) say(`binding element ${e.id} relies on itself`);
        else if (target.work) say(`binding element ${e.id} relies on ${t}, which is a work package: what one work package needs of another is its depends_on (D99); a link relies on a decision`);
      }
      if (e.work && (e.work as { milestone?: unknown }).milestone === true && (e.serves.length || e.relies_on.length)) {
        say(`binding element ${e.id} is a milestone, and links nothing (PLN3): its members serve and rely on what it gathers`);
      }
    }
  }

  const rulings: ImportRuling[] = [];
  if (input.rulings !== undefined && !Array.isArray(input.rulings)) say('rulings is a list');
  const refs = new Set<string>();
  (Array.isArray(input.rulings) ? input.rulings : []).forEach((r, i) => {
    const where = `rulings[${i}]${isObject(r) && typeof r.id === 'string' ? ` (${r.id})` : ''}`;
    if (!isObject(r)) { say(`${where} is an object`); return; }
    unknownKeys(r, KEYS.ruling, where);
    const id = typeof r.id === 'string' && RULING_REF.test(r.id) ? r.id
      : (say(`${where}.id is the ruling's ID, such as D109: a letter, then up to 39 letters, digits, '.', '_' or '-'`), undefined);
    if (id && refs.has(id)) say(`rulings has two ${id}: an ID names one ruling`);
    if (id) refs.add(id);
    const date = typeof r.date === 'string' && (/^\d{4}-\d{2}-\d{2}$/.test(r.date) || /^\d{4}-\d{2}-\d{2}T/.test(r.date)) ? r.date
      : (say(`${where}.date is when it was given: YYYY-MM-DD, or an ISO 8601 time with its offset`), undefined);
    const t = text(r.text, `${where}.text`, MAX_TEXT);
    const replaces = text(r.replaces, `${where}.replaces`, MAX_TEXT, false);
    const effect = r.effect === undefined ? 'keep_intent' : RULING_EFFECTS.includes(r.effect as RulingEffect) ? r.effect as RulingEffect
      : (say(`${where}.effect is ${RULING_EFFECTS.join(' or ')}`), undefined);
    let on: ImportRuling['on'] | undefined;
    if (r.on === undefined) {
      if (spec) on = { node: spec.name };
      else say(`${where}.on names what it rules on; with no spec in the file, give it`);
    } else if (typeof r.on !== 'string') {
      say(`${where}.on is the node, or element, it rules on: kolab, or kolab#ENF4`);
    } else {
      try {
        const a = parseAddress(r.on.startsWith('kj:') ? r.on : `kj:${r.on}`);
        // A node not in the file must be in the kolab (importKolab checks): rulings can come in a file of their own.
        const node = [spec, binding].find((n) => n?.name === a.node);
        if (a.version !== undefined || a.selector) say(`${where}.on names a node or an element, with no version or quote: ${a.node}${a.element ? `#${a.element}` : ''}`);
        else if (a.kolab !== undefined && a.kolab !== kolab) say(`${where}.on is in kolab ${a.kolab}, and the file imports into ${kolab}`);
        else if (a.element !== undefined && node && !node.elements.some((e) => e.id === a.element)) say(`${where}.on names ${a.node}#${a.element}, and ${a.node} has no element ${a.element} in the file`);
        else on = { node: a.node, ...(a.element !== undefined ? { element: a.element } : {}) };
      } catch {
        say(`${where}.on is the node, or element, it rules on: kolab, or kolab#ENF4`);
      }
    }
    if (id && date && t && effect && on) rulings.push({ id, date, text: t, ...(replaces ? { replaces } : {}), effect, on });
  });

  let repository: ImportFile['repository'];
  if (input.repository !== undefined) {
    const r = input.repository;
    if (!isObject(r)) say('repository is an object: {"url": "https://github.com/…", "root_sha": "…"}');
    else {
      unknownKeys(r, KEYS.repository, 'repository');
      if (typeof r.url !== 'string') say('repository.url is the repository\'s https URL');
      if (typeof r.root_sha !== 'string') say('repository.root_sha is its root commit, as `git rev-list --max-parents=0 HEAD` prints it');
      if (r.implements_binding !== undefined && typeof r.implements_binding !== 'boolean') say('repository.implements_binding is true or false');
      const implementsBinding = r.implements_binding !== false;
      if (implementsBinding && !binding) say('repository implements the binding (implements_binding, true unless false): give the binding in the same file');
      if (typeof r.url === 'string' && typeof r.root_sha === 'string') repository = { url: r.url, root_sha: r.root_sha, implements_binding: implementsBinding };
    }
  }

  if (!spec && !binding && !rulings.length && !repository && !problems.length) say('the file imports nothing: give a spec, a binding, rulings or a repository');
  if (problems.length) {
    const shown = problems.slice(0, PROBLEMS_SHOWN);
    throw new GateError(`the import file is refused, and nothing was written: ${shown.join('; ')}${problems.length > shown.length ? `; and ${problems.length - shown.length} more` : ''}`);
  }
  return { format: IMPORT_FORMAT, kolab, ...(spec ? { spec } : {}), ...(binding ? { binding } : {}), rulings, ...(repository ? { repository } : {}) };
}
