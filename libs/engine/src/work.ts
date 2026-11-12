/**
 * A work package's fields (W5.1a, W5.1d; PLN1, PLN2, PLN3, D98, D104): how a draft's are checked and
 * stored, how they enter an element's fingerprint, and the checks a binding version's work packages
 * pass at submit. Pure: the engine reads the rows and the links, and these decide.
 */
import { createHash } from 'node:crypto';
import { fingerprint, normalize } from '@konjir/address';
import {
  ACCEPTANCE_RESULTS, EVIDENCE_KINDS, MAX_DEPENDS_ON, MAX_DONE_WHEN, MAX_EVIDENCE_CHECKS, MAX_EVIDENCE_FILES, MAX_EVIDENCE_PATH, MAX_EVIDENCE_PER_CALL, MAX_EVIDENCE_URL, MAX_REPOSITORY_URL, MAX_TEXT, MAX_WORK_REPO,
  RULING_REF, WORK_FIELDS, WORK_SIZES, textLength, type AcceptanceFinding, type EvidenceKind, type ForecastBasis, type Progress, type ProgressValue, type WorkDate, type WorkDates, type WorkFields, type WorkSize, type WorkState,
} from '@konjir/types';

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
 * and `milestone: false` are refused, saying to leave the field out. `{}` makes the element a work
 * package whose fields are still to be given (D104); null clears them, making it a decision.
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
  // A milestone has no work of its own (PLN2, PLN3), so nothing to size: its members carry the sizes (W5.7).
  if (out.milestone && out.size) problems.push(`${element} is a milestone, which has no work of its own to size (PLN2, PLN3): size its members, and leave size out`);
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
  if (o.release !== undefined && o.release !== null) {
    if (o.release !== true) problems.push(`${element}'s release is ${JSON.stringify(o.release)}: a work package that must be released says release: true, and one that needn't be leaves release out`);
    // A milestone has no work of its own to release (PLN3): its members are released, and it is Done when they are.
    else if (out.milestone) problems.push(`${element} is a milestone, which has no work of its own to release (PLN3): set release on its members, and leave it out here`);
    else out.release = true;
  }
  // In WORK_FIELDS order, so the same fields are always stored alike.
  const ordered = Object.fromEntries(WORK_FIELDS.filter((k) => out[k] !== undefined).map((k) => [k, out[k]])) as WorkFields;
  return { work: problems.length ? null : ordered, problems, limit };
}

/**
 * An element's fingerprint (D98): with no work field, the hash of its normalized text, as it always
 * was, so every element written before work fields existed keeps its fingerprint and every link to
 * it holds; with one, the hash of that text and the work fields' canonical JSON (keys sorted, Depends
 * on sorted, a done-when normalized as text is), so changing a done-when, a dependency, a size or a
 * date is a change, as an edit of the text is, and so is making a decision a work package (`{}`,
 * D104). Migration 0033 computes it alike for the packages it moves onto bindings.
 */
export function elementFingerprint(text: string, work: WorkFields | null | undefined): string {
  if (!work) return fingerprint(text);
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

/**
 * A link from a binding version, as its work checks see it: carried forward from its base, or its own;
 * `into_self` when it targets an element of the binding itself, `into_spec` when it targets its
 * binding's spec; `kind` its edge kind (a dependency when not given).
 */
export interface WorkLink { source_element_id: string | null; target: string; target_element_id?: string | null; into_self?: boolean; into_spec?: boolean; kind?: string }

/**
 * The packages WRK11's check applies to (W8.3), scoped as W5.7's checks are, so a package committed
 * with nothing behind it never stops an unrelated version: each package whose work this version adds
 * or changes against `before` (the work of the version it was written on, element by element), each
 * it drops a link from (`dropped`), and each that relies, by a link it holds, on a decision `before`
 * held that this version removes or makes a work package (a milestone too): what was behind it.
 */
export function behindScope(elements: { element_id: string; work?: WorkFields | null }[], links: WorkLink[],
  before: ReadonlyMap<string, WorkFields | null | undefined>, dropped: Iterable<string> = []): Set<string> {
  const work = new Map(elements.filter((e) => e.work).map((e) => [e.element_id, e.work!]));
  const ids = new Set(elements.map((e) => e.element_id));
  const scope = new Set(dropped);
  for (const [id, w] of work) {
    const was = before.get(id);
    if (!was || canonicalWork(was) !== canonicalWork(w)) scope.add(id);
  }
  for (const l of links) {
    const t = l.target_element_id;
    if (!l.source_element_id || !t || !l.into_self || (l.kind ?? 'dependency') !== 'dependency') continue;
    if (before.has(t) && !before.get(t) && (!ids.has(t) || work.has(t))) scope.add(l.source_element_id);
  }
  return scope;
}

/**
 * PLN2's checks on a binding version's work packages (D98, D104), beyond the structural ones every
 * version passes (no empty or duplicate element), run at submit: every Depends on names a work
 * package of the same version (an element with a work field, not a decision), and not itself; no
 * cycle in Depends on; a milestone depends on its members and has no work of its own, so links
 * nothing and carries no size (PLN3); only a milestone carries a target date; and no work package links another of
 * the version's, however the link came (D99): a decision it linked may have become a work package;
 * and every work package that isn't a milestone has something behind it (WRK11, PLN11): a dependency
 * link at element scope into its binding's spec, or to a decision of its own binding.
 * Each problem is named in words a refusal can quote; none means the version goes on to review.
 */
export function workProblems(elements: { element_id: string; work?: WorkFields | null }[], links: WorkLink[],
  /** The packages whose work this version adds or changes; checks that are new since a binding committed apply only to these (W5.7). All, when undefined. */
  changed?: ReadonlySet<string>,
  /** The packages WRK11's check applies to, as behindScope finds them (W8.3). All, when undefined. */
  linked?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const work = new Map(elements.filter((e) => e.work).map((e) => [e.element_id, e.work!]));
  const ids = new Set(elements.map((e) => e.element_id));
  for (const e of elements) {
    const w = e.work;
    if (!w) continue;
    for (const d of w.depends_on ?? []) {
      if (d === e.element_id) problems.push(`${e.element_id} depends on itself`);
      else if (!work.has(d)) {
        problems.push(ids.has(d)
          ? `${e.element_id} depends on ${d}, which is a decision, not a work package: a work package depends on work packages, and relies on a decision through a dependency link`
          : `${e.element_id} depends on ${d}, which isn't a work package of this version`);
      }
    }
    if (w.target_date && !w.milestone) problems.push(`${e.element_id} carries a target date, and only a milestone does`);
    // New in W5.7, so only on a milestone this version adds or changes: one carried forward unchanged,
    // from a binding committed before, never stops its next version committing.
    if (w.milestone && w.size && (!changed || changed.has(e.element_id))) problems.push(`${e.element_id} is a milestone, and carries a size: a milestone has no work of its own to size (PLN2, PLN3); its members do`);
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
  for (const id of work.keys()) if (!state.has(id)) walk(id, [id]);
  // A milestone has no work of its own (PLN2, PLN3): it serves and relies on nothing; its members do.
  const said = new Set<string>();
  for (const l of links) {
    if (!l.source_element_id || !work.get(l.source_element_id)?.milestone) continue;
    const p = `${l.source_element_id} is a milestone, and links ${l.target}: a milestone has no work of its own (PLN2, PLN3); a work package it depends on serves or relies on it`;
    if (!said.has(p)) { said.add(p); problems.push(p); }
  }
  // A work package never links another of its binding's (D99): what one needs of another is its depends_on.
  for (const l of links) {
    const from = l.source_element_id;
    if (!l.into_self || !from || !l.target_element_id || from === l.target_element_id) continue;
    if (!work.has(from) || work.get(from)!.milestone || !work.has(l.target_element_id)) continue;
    const p = `${from} links ${l.target}, which is a work package of this version: work packages don't link to each other (D99); name it in ${from}'s depends_on, and remove the link`;
    if (!said.has(p)) { said.add(p); problems.push(p); }
  }
  // Work has something behind it (WRK11, PLN11): what it serves in the spec, or a decision it relies on.
  // New in W8.3, so, as W5.7's checks, only on a package this version adds, changes the work of or drops a link from.
  const behind = new Set(links.filter((l) => l.source_element_id && l.target_element_id && (l.kind ?? 'dependency') === 'dependency'
    && (l.into_spec || (l.into_self && ids.has(l.target_element_id) && !work.has(l.target_element_id)))).map((l) => l.source_element_id!));
  const bare = [...work].filter(([id, w]) => !w.milestone && !behind.has(id) && (!linked || linked.has(id))).map(([id]) => id);
  if (bare.length) {
    const one = bare.length === 1;
    problems.push(`${bare.join(', ')} ${one ? 'has' : 'have'} nothing behind ${one ? 'it' : 'them'} (WRK11, PLN11): link ${one ? 'it' : 'each'} to the spec element it serves or the decision of its binding it relies on (konjir_link, a dependency link), or, if there is none, withdraw it and konjir_ask the binding instead: work with nothing behind it is a question to the binding layer`);
  }
  return problems;
}

/**
 * Natural order of work package ids (PLN17): digits compare as numbers, the rest as text, so W1.2
 * comes before W1.10 and W2 before W10. Ids that compare equal so (W01 and W1) fall back to plain
 * text order, so the same binding always gives the same order.
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

/** A work package's progress (WRK8): its own state. In review, approved or not, is in progress. */
export function packageProgress(state: WorkState): ProgressValue {
  return state === 'done' ? 'done' : state === 'todo' ? 'todo' : 'in_progress';
}

/**
 * Progress over what is counted (WRK8): done when every one is done, to do when every one is to do,
 * otherwise in progress. What has no work (no work, not served) is left out, unless all is: then no
 * work, as with nothing counted. At risk when any one counted is (WRK6).
 */
export function progressOver(counted: Progress[]): Progress {
  const work = counted.filter((p) => p.progress !== 'no_work' && p.progress !== 'not_served');
  const at_risk = work.some((p) => p.at_risk);
  if (!work.length) return { progress: 'no_work', at_risk };
  const all = (v: ProgressValue) => work.every((p) => p.progress === v);
  return { progress: all('done') ? 'done' : all('todo') ? 'todo' : 'in_progress', at_risk };
}

/**
 * The ruling refs an element's Source line names (WRK8, migration 0042): "Source: D12, D47." gives
 * D12 and D47. Every line's, from "Source:" to its end, split at commas, semicolons and spaces.
 */
export function sourceRefs(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bSource:([^\n]*)/g)) {
    for (const t of m[1].split(/[\s,;]+/)) {
      const ref = t.replace(/[.)\]]+$/, '').replace(/^[([]+/, '');
      if (RULING_REF.test(ref)) out.add(ref);
    }
  }
  return out;
}

/** The events that make a package Done (WRK9): an approval, a submission with no reviewer, a release recorded. */
const FINISHED_BY = new Set(['approved', 'done_unreviewed', 'release_recorded']);

/**
 * A work package's actual dates (WRK9), from its events, oldest first: those of its current run, since
 * it was last added, restored or reopened. Its start is the run's first pull; its finish, while it is
 * Done, the event that made it Done (milestone_done for a milestone).
 */
export function actualDates(events: { kind: string; at: Date }[], o: { milestone: boolean; done: boolean }): { start?: Date; finish?: Date } {
  let from = 0;
  events.forEach((e, i) => { if (e.kind === 'added' || e.kind === 'restored' || e.kind === 'reopened') from = i + 1; });
  const run = events.slice(from);
  const finish = o.done ? run.filter((e) => (o.milestone ? e.kind === 'milestone_done' : FINISHED_BY.has(e.kind))).at(-1)?.at : undefined;
  return { start: run.find((e) => e.kind === 'pulled')?.at, finish };
}

/** The median of `xs`, which isn't empty: the middle one, or the mean of the middle two. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A work package as its dates are forecast (WRK9): its state, its fields, and its actual dates. */
export interface DatedPackage {
  id: string; address: string; state: WorkState; milestone: boolean; size: WorkSize | null; depends_on: string[]; start?: Date; finish?: Date;
}

/**
 * Each package's start and finish (WRK9), actual or forecast, in dependency order. A package's
 * expected duration is the median of the finished durations of its size in its binding (`durations.binding`),
 * else in the kolab; with no size, or none of its size in the kolab, it has no forecast, and nor does
 * any date that waits on it. A To do package starts at the latest of now and the finishes it depends
 * on, and finishes its expected duration later; one In progress or In review keeps its actual start and
 * finishes at the later of now and that start plus its expected duration; a milestone starts at its
 * earliest member's start and finishes at their latest finish. No capacity model: packages that don't
 * depend on each other run at once.
 */
export function workDates(packages: DatedPackage[], durations: { binding: Map<WorkSize, number[]>; kolab: Map<WorkSize, number[]> }, now: Date): Map<string, WorkDates> {
  const byId = new Map(packages.map((p) => [p.id, p]));
  const out = new Map<string, WorkDates>();
  const actual = (d: Date): WorkDate => ({ at: d.toISOString(), kind: 'actual' });
  const forecast = (d: Date, basis: ForecastBasis): WorkDate => ({ at: d.toISOString(), kind: 'forecast', basis });
  const none = (reason: string): WorkDate => ({ at: null, kind: 'no_forecast', reason });
  const both = (reason: string): WorkDates => ({ start: none(reason), finish: none(reason) });
  const expected = (p: DatedPackage): { ms: number; basis: ForecastBasis } | { reason: string } => {
    if (!p.size) return { reason: `${p.address} has no size` };
    for (const from of ['binding', 'kolab'] as const) {
      const xs = durations[from].get(p.size);
      if (xs?.length) return { ms: median(xs), basis: { size: p.size, durations: xs.length, from } };
    }
    return { reason: `no ${p.size} package in the kolab has a finished duration` };
  };
  const waits = (p: DatedPackage) => `it waits on ${p.address}, which has no forecast`;
  const visiting = new Set<string>();
  const of = (id: string): WorkDates | undefined => {
    if (out.has(id)) return out.get(id);
    const p = byId.get(id);
    if (!p) return undefined;
    if (visiting.has(id)) return both(`${p.address} depends on itself`);
    visiting.add(id);
    const deps = p.depends_on.flatMap((d) => { const x = of(d); return x ? [{ p: byId.get(d)!, ...x }] : []; });
    let r: WorkDates;
    if (p.milestone) {
      // Its members' dates: the earliest start and, until it is Done, the latest finish.
      const pick = (side: 'start' | 'finish', later: boolean): WorkDate => {
        const blank = deps.find((d) => d[side].kind === 'no_forecast');
        const dated = deps.filter((d) => d[side].at !== null);
        if (!deps.length) return none(`${p.address} has no members`);
        // An actual start is before any forecast one, which is never before now.
        const actuals = side === 'start' ? dated.filter((d) => d.start.kind === 'actual') : [];
        if (blank && !actuals.length) return none(waits(blank.p));
        const from = actuals.length ? actuals : dated;
        const m = from.reduce((a, b) => ((Date.parse(b[side].at!) > Date.parse(a[side].at!)) === later ? b : a));
        const d = m[side];
        return d.kind === 'forecast' ? forecast(new Date(d.at), { ...d.basis, via: m.p.address }) : d.kind === 'actual' && side === 'start' ? d : forecast(new Date(d.at!), { via: m.p.address });
      };
      r = { start: pick('start', false), finish: p.state === 'done' ? (p.finish ? actual(p.finish) : none(`${p.address} is Done with no milestone_done event in its run`)) : pick('finish', true) };
    } else if (p.state === 'done') {
      r = { start: p.start ? actual(p.start) : none(`${p.address} was Done with no pull in its run`), finish: p.finish ? actual(p.finish) : none(`${p.address} is Done with no event that made it Done in its run`) };
    } else if (p.state === 'todo') {
      const e = expected(p);
      const blank = deps.find((d) => d.finish.kind === 'no_forecast');
      if ('reason' in e) r = both(e.reason);
      else if (blank) r = both(waits(blank.p));
      else {
        const last = deps.reduce<{ at: number; via?: string }>((a, d) => (Date.parse(d.finish.at!) > a.at ? { at: Date.parse(d.finish.at!), via: d.p.address } : a), { at: now.getTime() });
        r = { start: forecast(new Date(last.at), { ...e.basis, ...(last.via ? { via: last.via } : {}) }), finish: forecast(new Date(last.at + e.ms), e.basis) };
      }
    } else {
      const e = expected(p);
      r = !p.start ? both(`${p.address} is ${p.state === 'in_review' ? 'In review' : 'In progress'} with no pull in its run`)
        : { start: actual(p.start), finish: 'reason' in e ? none(e.reason) : forecast(new Date(Math.max(now.getTime(), p.start.getTime() + e.ms)), e.basis) };
    }
    visiting.delete(id);
    out.set(id, r);
    return r;
  };
  for (const p of packages) of(p.id);
  return out;
}

/** One item of evidence as Kolab stores it (migrations 0031 and 0032's evidence): checked, normalized, ready to write. */
export interface CheckedEvidence {
  kind: EvidenceKind;
  /** A commit's sha, lowercase; a pull request's number, as text. */
  ref: string | null;
  url: string | null; title: string | null; files: string[] | null;
  /** A commit's or pull request's repository as given (repositoryUrl's canonical form), or null to use the package's own (W5.2a). */
  repo: string | null;
  /** A test run's acceptance checks as given (REV9), each address still to resolve; absent or null for none. */
  checks?: { address: string; passed: boolean }[] | null;
}

/** An acceptance check as Kolab stores it (migration 0048's evidence.checks): the element's full address, the committed version it resolved to, and whether it passed. */
export interface StoredCheck { address: string; version: number; passed: boolean }

/**
 * The acceptance_failed finding Kolab itself reports for failed check `c` of test run `e` (REV9,
 * VER15): the spec element, the evidence item and who recorded it. Read from the evidence, which is
 * never edited or removed (PLN5), so no verdict removes one.
 */
export function acceptanceFinding(e: { id: string; url: string | null; title: string | null; recorded_by: string; at: Date | string }, c: StoredCheck): AcceptanceFinding {
  return {
    kind: 'acceptance_failed', element: c.address, version: c.version, evidence: e.id, recorded_by: e.recorded_by, at: new Date(e.at).toISOString(),
    explanation: `${e.recorded_by}'s test run ${e.url ?? (e.title ? `"${e.title}"` : e.id)} records the acceptance check of ${c.address} (version ${c.version}) as failed`,
  };
}

const EVIDENCE_KEYS = ['kind', 'sha', 'pr', 'url', 'title', 'summary', 'files', 'repo', 'checks'] as const;
const CHECK_KEYS = ['address', 'result'] as const;
/** The kinds of evidence a package's own work records (konjir_add_evidence, konjir_submit_work): all but a release, which konjir_record_release records (W7.7). */
const SUBMITTED_KINDS = EVIDENCE_KINDS.filter((k) => k !== 'release');
const RELEASE_KEYS = ['run', 'sha', 'repo', 'title'] as const;

/**
 * A release as a client gives it (konjir_record_release; PLN16, W7.7), checked: the deploy run that
 * released the work, by its https link (`run`), and the commit it released, by its full sha (`sha`),
 * in a repository registered in the kolab (`repo`, or the package's own), with an optional summary
 * (`title`). Nothing given is dropped quietly. `problems` names each refusal; `limit` is set when one
 * of them is a size limit.
 */
export function checkReleaseInput(input: unknown): { item: CheckedEvidence | null; problems: string[]; limit: boolean } {
  const problems: string[] = [];
  let limit = false;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { item: null, problems: ['a release names its deploy run and the commit it released: { run: "https://…", sha: "…" }'], limit };
  }
  const o = input as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(RELEASE_KEYS as readonly string[]).includes(k) && o[k] !== undefined);
  if (unknown.length) problems.push(`a release has ${unknown.join(', ')}, which it doesn't take: it takes ${RELEASE_KEYS.join(', ')}`);
  const out: CheckedEvidence = { kind: 'release', ref: null, url: null, title: null, files: null, repo: null };
  if (o.run === undefined || o.run === null) problems.push('a release names the deploy run that released it, by its https link, as run');
  else {
    const u = evidenceUrl('the release', o.run);
    if (u.problem) { problems.push(u.problem.replace("the release's url", "the release's run")); if (u.limit) limit = true; } else out.url = u.url!;
  }
  if (typeof o.sha !== 'string' || !RELEASE_SHA.test(o.sha.trim().toLowerCase())) problems.push(`a release names the commit it released by its full sha: 40 hexadecimal characters, not ${JSON.stringify(o.sha ?? null)}`);
  else out.ref = o.sha.trim().toLowerCase();
  if (o.repo !== undefined && o.repo !== null) {
    const r = repositoryUrl(o.repo);
    if (r.problem) problems.push(`the release's repo: ${r.problem}`); else out.repo = r.url!;
  }
  if (o.title !== undefined && o.title !== null) {
    if (typeof o.title !== 'string' || !o.title.trim()) problems.push("the release's title is text");
    else if (textLength(o.title.trim()) > MAX_TEXT) { limit = true; problems.push(`the release's title is ${textLength(o.title.trim()).toLocaleString('en')} characters; the limit is ${MAX_TEXT.toLocaleString('en')}`); }
    else out.title = o.title.trim();
  }
  return { item: problems.length ? null : out, problems, limit };
}

/**
 * A repository's URL in the one form Kolab stores and compares (W5.2a; migration 0032's repository_url):
 * https://host[:port]/path, the host in lower case, with no trailing slash and no `.git`. Refused, not
 * stripped, with why: another scheme, a user or password (a token in a remote URL is a credential,
 * D98), a query or a fragment, a host with no path, and anything over MAX_REPOSITORY_URL characters.
 * `konjir work deliver` reads a checkout's remotes and canonicalizes them alike, after dropping any
 * credential locally, so it never sends one.
 */
export function repositoryUrl(given: unknown): { url?: string; problem?: string } {
  if (typeof given !== 'string' || !given.trim()) return { problem: 'a repository is named by its https URL, such as https://github.com/acme/orders' };
  const t = given.trim();
  if (t.length > MAX_EVIDENCE_URL) return { problem: `that repository URL is ${t.length.toLocaleString('en')} characters; the limit is ${MAX_REPOSITORY_URL}` };
  let u: URL;
  try { u = new URL(t); } catch { return { problem: `${JSON.stringify(t.slice(0, 200))} isn't a URL: name a repository by its https URL, such as https://github.com/acme/orders` }; }
  if (u.protocol !== 'https:') return { problem: `a repository is named by its https URL, not ${u.protocol.replace(/:$/, '')}: such as https://${u.host || 'github.com'}${u.pathname === '/' ? '/acme/orders' : u.pathname}` };
  if (u.username || u.password) return { problem: 'that repository URL carries a user or password, which may be a credential: give the URL without it, such as https://github.com/acme/orders' };
  if (u.search || u.hash || /[?#]/.test(t)) return { problem: "a repository URL has no query or fragment: give the repository's own URL, such as https://github.com/acme/orders" };
  let path = u.pathname.replace(/\/+$/, '');
  if (/\.git$/i.test(path)) path = path.slice(0, -4).replace(/\/+$/, '');
  if (/\.git$/i.test(path)) return { problem: `${JSON.stringify(t.slice(0, 200))} ends in .git twice: give the repository's own URL, such as https://github.com/acme/orders` };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(host) || !host || host.endsWith('.')) return { problem: `${JSON.stringify(u.hostname)} isn't a host name a repository URL takes` };
  const segments = path.split('/').slice(1);
  if (!path || segments.some((seg) => !seg) || /[@\s%]/.test(path)) {
    return { problem: `${JSON.stringify(t.slice(0, 200))} names no repository: give its path too, such as https://github.com/acme/orders` };
  }
  // At least /owner/name, so a registration never covers a whole organization's pull requests; and
  // on the forges whose repositories are exactly that, no deeper (…/orders/tree/main is no repository).
  if (segments.length < 2) return { problem: `${JSON.stringify(t.slice(0, 200))} names an owner, not a repository: give /owner/name, such as https://${host}/acme/orders` };
  if (OWNER_NAME_HOSTS.has(host) && segments.length !== 2) {
    return { problem: `on ${host} a repository's URL is https://${host}/<owner>/<name>, not ${JSON.stringify(t.slice(0, 200))}` };
  }
  const url = `https://${host}${u.port ? `:${u.port}` : ''}${path}`;
  if (url.length > MAX_REPOSITORY_URL) return { problem: `that repository URL is ${url.length} characters; the limit is ${MAX_REPOSITORY_URL}` };
  return { url };
}

/**
 * How independent a repository's confirmer must be (D98 ruling 1, D102; #83's Q1, pending Lee):
 * `actor`, as work review's separation of duty is, so another agent of the registrar's own person
 * counts as someone else; or `person`, comparing principals (an agent's owner, or the person).
 */
export type Independence = 'actor' | 'person';

/** One party to a confirmation: an actor, and its principal (its owner, for an agent; itself otherwise). */
export interface Party { id: string; principal: string }

/**
 * Whether `reviewer` is independent enough of each of `others` (the repository's registrar and the
 * package's assignee) to confirm the repository, under `mode`. The one place the rule lives.
 */
export function independentOf(mode: Independence, reviewer: Party, others: Party[]): boolean {
  return others.every((o) => (mode === 'actor' ? o.id !== reviewer.id : o.principal !== reviewer.principal && o.id !== reviewer.id));
}

/** The forges whose repository URLs are exactly /owner/name (W5.2a): a deeper path there is a page of a repository, not one. */
export const OWNER_NAME_HOSTS = new Set(['github.com', 'bitbucket.org', 'codeberg.org']);

/** Whether `link` (a pull request's or a commit's) sits inside the repository at `repo` (a canonical URL): under its path, whatever the case. */
export function insideRepository(link: string, repo: string): boolean {
  return sameLink(link).toLowerCase().startsWith(`${repo.toLowerCase()}/`);
}

/**
 * Whether `link` is a GitHub Actions run of the repository at `repo` (a canonical URL): exactly
 * `<repo>/actions/runs/<id>`, or one attempt of it, on github.com, with no query (W7.7: a release
 * names the deploy run that released it). Whether the run exists, or deployed anything, Kolab
 * can't tell: it doesn't reach GitHub.
 */
export function isActionsRun(link: string, repo: string): boolean {
  let u: URL, r: URL;
  try { u = new URL(link); r = new URL(repo); } catch { return false; }
  if (u.protocol !== 'https:' || r.host.toLowerCase() !== 'github.com' || u.host.toLowerCase() !== 'github.com' || u.search || u.username || u.password) return false;
  const base = r.pathname.replace(/\/+$/, '').toLowerCase();
  const path = u.pathname.replace(/\/+$/, '').toLowerCase();
  return path.startsWith(`${base}/actions/runs/`) && /^[1-9][0-9]{0,19}(\/attempts\/[1-9][0-9]{0,5})?$/.test(path.slice(`${base}/actions/runs/`.length));
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A release names its commit by a full SHA-1 sha (W7.7): 40 hexadecimal characters. */
const RELEASE_SHA = /^[0-9a-f]{40}$/;

/**
 * An https link with no user or password in it, at most MAX_EVIDENCE_URL characters, as the
 * database's evidence_url holds it; or why not, and whether that is a size limit.
 */
function evidenceUrl(what: string, u: unknown): { url?: string; problem?: string; limit?: boolean } {
  if (typeof u !== 'string' || !u.trim()) return { problem: `${what}'s url is an https link` };
  const t = u.trim();
  if (t.length > MAX_EVIDENCE_URL) return { problem: `${what}'s url is ${t.length.toLocaleString('en')} characters; the limit is ${MAX_EVIDENCE_URL.toLocaleString('en')}`, limit: true };
  let parsed: URL;
  try { parsed = new URL(t); } catch { return { problem: `${what}'s url isn't a link: give an https link` }; }
  if (parsed.username || parsed.password) return { problem: `${what}'s url carries a user or password: give the link without it` };
  if (parsed.protocol !== 'https:' || !/^https:\/\/[^/@\s]+(\/\S*)?$/.test(t)) return { problem: `${what}'s url is an https link, with no spaces in it` };
  // Evidence is readable by every session of the kolab, and kept: a link that carries a credential
  // (a pre-signed or token-bearing link to a CI run, a CI artifact or a log) is refused, not stored.
  // In the query, and in the fragment, where OAuth's implicit flow and many CI and log viewers carry
  // tokens: its key=value pairs, and a query after it (#?…, #/…?…).
  const frag = parsed.hash.replace(/^#/, '');
  const pairs = [parsed.searchParams, new URLSearchParams(frag), new URLSearchParams(frag.includes('?') ? frag.slice(frag.indexOf('?') + 1) : '')];
  const secret = [...new Set(pairs.flatMap((p) => [...p.keys()]).filter((k) => CREDENTIAL_PARAM.test(k)))];
  if (secret.length) {
    return { problem: `${what}'s url carries ${secret.map((k) => `"${k}"`).join(', ')}, which may be a credential, and evidence is kept and read by everyone in the kolab: give the link without its query string or fragment, or a summary as title` };
  }
  return { url: t };
}

/** Query or fragment parameters that carry credentials in pre-signed and token-bearing links (S3, GCS, Azure SAS, GitLab, OAuth, CI artifact links). A deny-list. */
const CREDENTIAL_PARAM = /^(token|access_token|id_token|refresh_token|private_token|auth|sig|signature|key|api[-_]?key|code|password|secret|client_secret|jwt|bearer|session|x-amz-.*|x-goog-.*)$/i;

/** A link as two items of evidence compare it: host in lower case, no trailing slash, no fragment. */
export function sameLink(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Evidence as a client gives it (PLN16, D98), checked: a list of at most MAX_EVIDENCE_PER_CALL
 * items, each a commit by its full sha (with its subject as `title`, the `files` it touched and a
 * `url`), a pull request by its https `url` (with its number as `pr`, and its `title`), or a test
 * run by its `url` or a summary as `summary` or `title`. Nothing given is dropped quietly: a field the kind
 * doesn't take, or an unknown one, is refused. `problems` names each refusal; `limit` is set when
 * one of them is a size limit.
 */
export function checkEvidenceInput(input: unknown): { items: CheckedEvidence[]; problems: string[]; limit: boolean } {
  const problems: string[] = [];
  let limit = false;
  if (!Array.isArray(input)) return { items: [], problems: ['evidence is a list: [{ kind: "commit", sha: "…" }, { kind: "pull_request", url: "https://…" }, { kind: "test_run", title: "…" }]'], limit };
  if (input.length > MAX_EVIDENCE_PER_CALL) {
    return { items: [], problems: [`that is ${input.length} items of evidence; the limit is ${MAX_EVIDENCE_PER_CALL} a call: give the rest in another call`], limit: true };
  }
  const items: CheckedEvidence[] = [];
  input.forEach((x, i) => {
    const what = `evidence ${i + 1}`;
    if (typeof x !== 'object' || x === null || Array.isArray(x)) { problems.push(`${what} is an object, with a kind: ${SUBMITTED_KINDS.join(', ')}`); return; }
    const o = x as Record<string, unknown>;
    const unknown = Object.keys(o).filter((k) => !(EVIDENCE_KEYS as readonly string[]).includes(k));
    if (unknown.length) problems.push(`${what} has ${unknown.join(', ')}, which evidence doesn't take: it takes ${EVIDENCE_KEYS.join(', ')}`);
    if (o.kind === 'release') { problems.push(`${what} is a release, which is recorded after the deploy with konjir_record_release (or konjir work deliver --release), not as the work's own evidence`); return; }
    if (!(SUBMITTED_KINDS as readonly unknown[]).includes(o.kind)) { problems.push(`${what}'s kind is one of ${SUBMITTED_KINDS.join(', ')}, not ${JSON.stringify(o.kind ?? null)}`); return; }
    const kind = o.kind as EvidenceKind;
    const given = (k: string) => o[k] !== undefined && o[k] !== null;
    const refuse = (keys: string[]) => {
      const there = keys.filter(given);
      if (there.length) problems.push(`${what} is a ${kind.replace('_', ' ')}, which takes no ${there.join(' or ')}`);
    };
    const out: CheckedEvidence = { kind, ref: null, url: null, title: null, files: null, repo: null };
    if (given('repo')) {
      const r = repositoryUrl(o.repo);
      if (r.problem) problems.push(`${what}'s repo: ${r.problem}`); else out.repo = r.url!;
    }
    if (given('url')) {
      const u = evidenceUrl(what, o.url);
      if (u.problem) { problems.push(u.problem); if (u.limit) limit = true; } else out.url = u.url!;
    }
    // A test run's summary may be given as summary, as its title is kept (W5.7): one or the other.
    const titled = kind === 'test_run' && given('summary') ? 'summary' : 'title';
    if (titled === 'summary' && given('title')) problems.push(`${what} is a test run: give its summary as title or as summary, not both`);
    else if (given(titled)) {
      const t = o[titled];
      if (typeof t !== 'string' || !t.trim()) problems.push(`${what}'s ${titled} is text`);
      else if (textLength(t.trim()) > MAX_TEXT) { limit = true; problems.push(`${what}'s ${titled} is ${textLength(t.trim()).toLocaleString('en')} characters; the limit is ${MAX_TEXT.toLocaleString('en')}`); }
      else out.title = t.trim();
    }
    if (kind === 'commit') {
      refuse(['pr', 'summary']);
      if (typeof o.sha !== 'string' || !SHA.test(o.sha.trim().toLowerCase())) problems.push(`${what} is a commit, named by its full sha: 40 hexadecimal characters (64 for SHA-256), not ${JSON.stringify(o.sha ?? null)}`);
      else out.ref = o.sha.trim().toLowerCase();
      if (given('files')) {
        const f = o.files;
        if (!Array.isArray(f) || !f.length || f.some((p) => typeof p !== 'string' || !p.trim())) problems.push(`${what}'s files lists the paths the commit touched: ["src/a.ts", "test/a.test.ts"]`);
        else if (f.length > MAX_EVIDENCE_FILES) { limit = true; problems.push(`${what} names ${f.length} files; the limit is ${MAX_EVIDENCE_FILES} a commit`); }
        else if (f.some((p) => textLength((p as string).trim()) > MAX_EVIDENCE_PATH)) { limit = true; problems.push(`${what} names a path of more than ${MAX_EVIDENCE_PATH.toLocaleString('en')} characters`); }
        else out.files = (f as string[]).map((p) => p.trim());
      }
    } else if (kind === 'pull_request') {
      refuse(['sha', 'files', 'summary']);
      if (!given('url')) problems.push(`${what} is a pull request, named by its https url`);
      if (given('pr')) {
        if (!Number.isInteger(o.pr) || (o.pr as number) < 1 || (o.pr as number) > 9_999_999_999) problems.push(`${what}'s pr is the pull request's number, a whole number from 1`);
        else out.ref = String(o.pr);
      }
    } else {
      refuse(['sha', 'pr', 'files', 'repo']);
      if (!given('url') && !given('title') && !given('summary')) problems.push(`${what} is a test run: give its url, or its summary ("npm test: 120 passed") as summary or title`);
      if (given('checks')) {
        const c = checkAcceptanceInput(what, o.checks);
        problems.push(...c.problems);
        if (c.limit) limit = true;
        out.checks = c.checks;
      }
    }
    if (kind !== 'test_run' && given('checks')) problems.push(`${what} is a ${kind.replace('_', ' ')}: only a test run lists acceptance checks`);
    items.push(out);
  });
  return { items: problems.length ? [] : items, problems, limit };
}

/**
 * A test run's acceptance checks as a client gives them (REV9): a list of at most MAX_EVIDENCE_CHECKS,
 * each `{ address: "kj:<kolab>/<node>#<id>", result: "passed" | "failed" }`, each element once. Only
 * their shape is checked here; the engine resolves each address to a committed spec element.
 */
function checkAcceptanceInput(what: string, input: unknown): { checks: { address: string; passed: boolean }[]; problems: string[]; limit: boolean } {
  const shape = `${what}'s checks lists the acceptance checks it ran: [{ address: "kj:<kolab>/<spec>#<id>", result: "passed" }, { address: "…", result: "failed" }]`;
  if (!Array.isArray(input) || !input.length) return { checks: [], problems: [shape], limit: false };
  if (input.length > MAX_EVIDENCE_CHECKS) return { checks: [], problems: [`${what} lists ${input.length} acceptance checks; the limit is ${MAX_EVIDENCE_CHECKS} a test run: give the rest as another test run`], limit: true };
  const problems: string[] = [];
  const checks: { address: string; passed: boolean }[] = [];
  input.forEach((x, i) => {
    const which = `${what}'s check ${i + 1}`;
    if (typeof x !== 'object' || x === null || Array.isArray(x)) { problems.push(`${which} is an object: { address: "kj:<kolab>/<spec>#<id>", result: "passed" }`); return; }
    const o = x as Record<string, unknown>;
    const unknown = Object.keys(o).filter((k) => !(CHECK_KEYS as readonly string[]).includes(k));
    if (unknown.length) problems.push(`${which} has ${unknown.join(', ')}, which a check doesn't take: it takes ${CHECK_KEYS.join(', ')}`);
    if (typeof o.address !== 'string' || !o.address.trim()) problems.push(`${which}'s address is the spec element it checks: kj:<kolab>/<spec>#<id>`);
    else if (textLength(o.address.trim()) > MAX_CHECK_ADDRESS) problems.push(`${which}'s address is longer than ${MAX_CHECK_ADDRESS} characters`);
    if (!(ACCEPTANCE_RESULTS as readonly unknown[]).includes(o.result)) problems.push(`${which}'s result is ${ACCEPTANCE_RESULTS.join(' or ')}, not ${JSON.stringify(o.result ?? null)}`);
    if (typeof o.address === 'string' && o.address.trim()) checks.push({ address: o.address.trim(), passed: o.result === 'passed' });
  });
  return { checks, problems, limit: false };
}

/** The longest address a check takes (migration 0048's kj_evidence_checks_valid). */
const MAX_CHECK_ADDRESS = 1000;

/**
 * What makes two items of a package's evidence the same: a commit's sha in its repository (`repository`,
 * its id; none for one recorded before repositories, W5.2a), a pull request's link (sameLink), a test
 * run's link or else its summary, with its acceptance checks (REV9), so a run given again with other
 * checks is recorded, not dropped as one already there.
 */
export function evidenceKey(kind: string, ref: string | null, url: string | null, title: string | null, repository: string | null = null,
  checks: { address: string; passed: boolean }[] | null = null): string {
  const checked = checks?.length ? `:checks:${checks.map((c) => `${c.address}=${c.passed ? 'passed' : 'failed'}`).sort().join(',')}` : '';
  return kind === 'commit' ? `commit:${repository ?? ''}:${ref}` : kind === 'pull_request' ? `pr:${sameLink(url ?? '').toLowerCase()}`
    : kind === 'release' ? `release:${repository ?? ''}:${ref}:${sameLink(url ?? '')}`
    : url ? `test:${sameLink(url)}${checked}` : `test-summary:${title ?? ''}${checked}`;
}

/** A line naming evidence, for an event's note: each commit's short sha, each pull request's link, each test run, with how many of its acceptance checks failed. */
export function evidenceSummary(items: CheckedEvidence[]): string {
  return items.map((e) => (e.kind === 'commit' ? `commit ${e.ref!.slice(0, 12)}` : e.kind === 'pull_request' ? `pull request ${e.url}`
    : e.kind === 'release' ? `release of commit ${e.ref!.slice(0, 12)} by ${e.url}`
    : `test run ${e.url ?? e.title}${e.checks?.length ? ` (${e.checks.length} acceptance check${e.checks.length === 1 ? '' : 's'}, ${e.checks.filter((c) => !c.passed).length} failed)` : ''}`))
    .join(', ').slice(0, 1000);
}
