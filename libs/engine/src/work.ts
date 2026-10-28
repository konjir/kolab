/**
 * A work package's fields (W5.1a; PLN1, PLN2, PLN3, D98): how a draft's are checked and stored, how
 * they enter an element's fingerprint, and the checks a plan version passes before it commits.
 * Pure: the engine reads the rows and the links, and these decide.
 */
import { createHash } from 'node:crypto';
import { fingerprint, normalize } from '@konjir/address';
import { MAX_DEPENDS_ON, MAX_DONE_WHEN, MAX_WORK_REPO, WORK_FIELDS, WORK_SIZES, textLength, type WorkFields } from '@konjir/types';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `s` is a date that exists, written YYYY-MM-DD. */
function isDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/**
 * An element's work fields as Kolab stores them, or why they can't be: keys in WORK_FIELDS order
 * and a done-when trimmed. Nothing given is dropped quietly: an empty done-when, an empty Depends on
 * and `milestone: false` are refused, saying to leave the field out, and so is `{}` (null clears).
 * `problems` names each refusal, in words a refusal can quote; `limit` is set when one of them is a
 * size limit rather than a malformed field.
 */
export function checkWork(element: string, w: unknown): { work: WorkFields | null; problems: string[]; limit: boolean } {
  const problems: string[] = [];
  let limit = false;
  if (w === undefined || w === null) return { work: null, problems, limit };
  if (typeof w !== 'object' || Array.isArray(w)) return { work: null, problems: [`${element}'s work is an object of ${WORK_FIELDS.join(', ')}`], limit };
  const o = w as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(WORK_FIELDS as readonly string[]).includes(k));
  if (unknown.length) problems.push(`${element}'s work has ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is no field' : 'are no fields'} of a work package: they are ${WORK_FIELDS.join(', ')}`);
  const out: WorkFields = {};
  if (o.done_when !== undefined && o.done_when !== null) {
    if (typeof o.done_when !== 'string') problems.push(`${element}'s done_when is text`);
    else {
      const t = o.done_when.trim();
      if (textLength(t) > MAX_DONE_WHEN) { limit = true; problems.push(`${element}'s done_when is ${textLength(t).toLocaleString('en')} characters; the limit is ${MAX_DONE_WHEN.toLocaleString('en')}`); }
      else if (!t) problems.push(`${element}'s done_when is empty: say when it is done, or leave done_when out`);
      else out.done_when = t;
    }
  }
  if (o.depends_on !== undefined && o.depends_on !== null) {
    if (!Array.isArray(o.depends_on) || o.depends_on.some((x) => typeof x !== 'string' || !x.trim())) problems.push(`${element}'s depends_on lists work packages by their element ids: ["W1.1", "W1.2"]`);
    else {
      const ids = (o.depends_on as string[]).map((x) => x.trim());
      const twice = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
      if (twice.length) problems.push(`${element}'s depends_on names ${twice.join(', ')} more than once`);
      if (ids.length > MAX_DEPENDS_ON) { limit = true; problems.push(`${element} depends on ${ids.length} work packages; the limit is ${MAX_DEPENDS_ON}. Group them under milestones`); }
      if (!ids.length) problems.push(`${element}'s depends_on is empty: name the work packages it depends on, or leave depends_on out`);
      else out.depends_on = ids;
    }
  }
  if (o.size !== undefined && o.size !== null) {
    if (!(WORK_SIZES as readonly unknown[]).includes(o.size)) problems.push(`${element}'s size is one of ${WORK_SIZES.join(', ')}, not ${JSON.stringify(o.size)}`);
    else out.size = o.size as WorkFields['size'];
  }
  if (o.milestone !== undefined && o.milestone !== null) {
    if (o.milestone !== true) problems.push(`${element}'s milestone is ${JSON.stringify(o.milestone)}: a milestone says milestone: true, and a work package that isn't one leaves milestone out`);
    else out.milestone = true;
  }
  if (o.target_date !== undefined && o.target_date !== null) {
    if (typeof o.target_date !== 'string' || !isDate(o.target_date)) problems.push(`${element}'s target_date is a date, YYYY-MM-DD, not ${JSON.stringify(o.target_date)}`);
    else if (!out.milestone) problems.push(`${element} carries a target date, and only a milestone carries one (PLN2): make it a milestone (milestone: true), or leave the date out`);
    else out.target_date = o.target_date;
  }
  if (o.repo !== undefined && o.repo !== null) {
    if (typeof o.repo !== 'string' || !o.repo.trim()) problems.push(`${element}'s repo names a repository`);
    else if (textLength(o.repo.trim()) > MAX_WORK_REPO) { limit = true; problems.push(`${element}'s repo is ${textLength(o.repo.trim())} characters; the limit is ${MAX_WORK_REPO}`); }
    else out.repo = o.repo.trim();
  }
  // In WORK_FIELDS order, so the same fields are always stored alike.
  const ordered = Object.fromEntries(WORK_FIELDS.filter((k) => out[k] !== undefined).map((k) => [k, out[k]])) as WorkFields;
  if (!problems.length && !Object.keys(ordered).length) problems.push(`${element}'s work is empty: give its fields, or null to clear them`);
  return { work: problems.length ? null : ordered, problems, limit };
}

/**
 * An element's fingerprint (D98): with no work fields, the hash of its normalized text, as it
 * always was, so every element written before work fields existed keeps its fingerprint and every
 * link to it holds; with them, the hash of that text and the work fields' canonical JSON (keys
 * sorted, Depends on sorted, a done-when normalized as text is), so changing a done-when, a
 * dependency, a size or a date is a change, as an edit of the text is.
 */
export function elementFingerprint(text: string, work: WorkFields | null | undefined): string {
  if (!work || !Object.keys(work).length) return fingerprint(text);
  return createHash('sha256').update(`${normalize(text)}\n${canonicalWork(work)}`).digest('base64url').slice(0, 22);
}

/**
 * Work fields as one string that two equal sets always give alike (D98): keys sorted, Depends on
 * sorted, a done-when normalized as text is. What the fingerprint hashes, and what an element-scope
 * link resolves to beside the element's text.
 */
export function canonicalWork(work: WorkFields): string {
  const canonical: Record<string, unknown> = {};
  for (const k of [...WORK_FIELDS].sort()) {
    const v = work[k];
    if (v === undefined) continue;
    canonical[k] = k === 'depends_on' ? [...(v as string[])].sort() : k === 'done_when' ? normalize(v as string) : v;
  }
  return JSON.stringify(canonical);
}

/** A link from a plan version, as the plan checks see it: carried forward from its base, or its own. */
export interface PlanLink {
  kind: string; source_element_id: string | null; target_element_id: string | null; selector: boolean;
  /** Whether it targets the plan's binding, the plan itself, or something else. */
  into: 'binding' | 'plan' | 'other'; target_committed: boolean; target: string;
}

/**
 * PLN2's checks on a plan version, beyond the structural ones every version passes (no empty or
 * duplicate element): every Depends on names a work package of the same version, and not itself;
 * no cycle in Depends on; a milestone depends on its members and delivers nothing (PLN3); only a
 * milestone carries a target date; every Delivers is a dependency link from a work package to an
 * element of a committed version of the plan's binding, at element scope (PLN1, LNK3). Each problem
 * is named in words a refusal can quote; none means the version may commit.
 */
export function planProblems(elements: { element_id: string; work?: WorkFields | null }[], links: PlanLink[]): string[] {
  const problems: string[] = [];
  const work = new Map(elements.map((e) => [e.element_id, e.work ?? undefined]));
  for (const e of elements) {
    const w = e.work;
    if (!w) continue;
    for (const d of w.depends_on ?? []) {
      if (d === e.element_id) problems.push(`${e.element_id} depends on itself`);
      else if (!work.has(d)) problems.push(`${e.element_id} depends on ${d}, which isn't a work package of this version`);
    }
    if (w.target_date && !w.milestone) problems.push(`${e.element_id} carries a target date, and only a milestone does`);
    if (w.milestone && !w.depends_on?.length) problems.push(`${e.element_id} is a milestone, and depends on no members: a milestone depends on the work packages it gathers (PLN3)`);
  }
  // No cycle in Depends on: a walk that comes back to a work package on its own path.
  const state = new Map<string, 'walking' | 'done'>();
  const reported = new Set<string>();
  const walk = (id: string, path: string[]) => {
    state.set(id, 'walking');
    for (const d of work.get(id)?.depends_on ?? []) {
      if (d === id || !work.has(d)) continue;
      if (state.get(d) === 'walking') {
        const cycle = [...path.slice(path.indexOf(d)), d];
        const key = [...new Set(cycle)].sort().join(' ');
        if (!reported.has(key)) { reported.add(key); problems.push(`Depends on has a cycle: ${cycle.join(' → ')}`); }
      } else if (!state.has(d)) walk(d, [...path, d]);
    }
    state.set(id, 'done');
  };
  for (const e of elements) if (!state.has(e.element_id)) walk(e.element_id, [e.element_id]);
  // Delivers.
  const said = new Set<string>();
  const once = (p: string) => { if (!said.has(p)) { said.add(p); problems.push(p); } };
  for (const l of links) {
    if (l.into === 'plan') continue;
    const from = l.source_element_id ?? '(the whole version)';
    if (l.into === 'other') { once(`${from} links ${l.target}, and a plan's work packages deliver elements of its own binding only (KON6, D78)`); continue; }
    if (l.kind !== 'dependency') once(`${from} delivers ${l.target} through a ${l.kind} link, and a Delivers is a dependency link (PLN1)`);
    if (!l.source_element_id) once(`a link from the whole version to ${l.target} delivers nothing: a Delivers is from a work package, an element (PLN1)`);
    if (!l.target_element_id || l.selector) once(`${from} delivers ${l.target}, and a Delivers names one binding element, at element scope, not ${l.selector ? 'a quote inside one' : 'the whole binding'} (PLN1, LNK3)`);
    if (!l.target_committed) once(`${from} delivers ${l.target}, which isn't committed`);
    if (l.source_element_id && work.get(l.source_element_id)?.milestone) once(`${l.source_element_id} is a milestone, and delivers ${l.target}: a milestone delivers nothing (PLN2, PLN3); a work package it depends on delivers it`);
  }
  return problems;
}

/**
 * Natural order of work package ids (PLN17): digits compare as numbers, the rest as text, so W1.2
 * comes before W1.10 and W2 before W10. Ids that compare equal so (W01 and W1) fall back to plain
 * text order, so the same plan always gives the same order.
 */
export function naturalCompare(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? [];
  const pb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const [x, y] = [pa[i], pb[i]];
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const [sx, sy] = [x.replace(/^0+(?=\d)/, ''), y.replace(/^0+(?=\d)/, '')];
      if (sx.length !== sy.length) return sx.length - sy.length;
      if (sx !== sy) return sx < sy ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (pa.length !== pb.length) return pa.length - pb.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Each milestone's state as its members make it (PLN3): Done when every work package it depends
 * on is Done, a member milestone included, and To do otherwise. `states` holds every package's
 * state now. Milestones settle from their members up, so a milestone of milestones follows them.
 * Returns the milestones whose state this changes, with their new state.
 */
export function milestoneStates(milestones: { id: string; members: string[] }[], states: Map<string, string>): Map<string, 'todo' | 'done'> {
  const now = new Map(states);
  // Depends on has no cycle (PLN2), so one pass per milestone settles them all.
  for (let pass = 0; pass <= milestones.length; pass++) {
    let moved = false;
    for (const m of milestones) {
      const want = m.members.length > 0 && m.members.every((id) => now.get(id) === 'done') ? 'done' : 'todo';
      if (now.get(m.id) !== want) { now.set(m.id, want); moved = true; }
    }
    if (!moved) break;
  }
  const changed = new Map<string, 'todo' | 'done'>();
  for (const m of milestones) {
    const want = now.get(m.id) as 'todo' | 'done';
    if (states.get(m.id) !== want) changed.set(m.id, want);
  }
  return changed;
}
