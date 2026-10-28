/**
 * A work package's fields (W5.1a; PLN1, PLN2, PLN3, D98): how a draft's are checked and stored, how
 * they enter an element's fingerprint, and the checks a plan version passes before it commits.
 * Pure: the engine reads the rows and the links, and these decide.
 */
import { createHash } from 'node:crypto';
import { fingerprint, normalize } from '@konjir/address';
import {
  EVIDENCE_KINDS, MAX_DEPENDS_ON, MAX_DONE_WHEN, MAX_EVIDENCE_FILES, MAX_EVIDENCE_PATH, MAX_EVIDENCE_PER_CALL, MAX_EVIDENCE_URL, MAX_REPOSITORY_URL, MAX_TEXT, MAX_WORK_REPO,
  WORK_FIELDS, WORK_SIZES, textLength, type EvidenceKind, type WorkFields,
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

/** One item of evidence as Kolab stores it (migrations 0031 and 0032's evidence): checked, normalized, ready to write. */
export interface CheckedEvidence {
  kind: EvidenceKind;
  /** A commit's sha, lowercase; a pull request's number, as text. */
  ref: string | null;
  url: string | null; title: string | null; files: string[] | null;
  /** A commit's or pull request's repository as given (repositoryUrl's canonical form), or null to use the package's own (W5.2a). */
  repo: string | null;
}

const EVIDENCE_KEYS = ['kind', 'sha', 'pr', 'url', 'title', 'files', 'repo'] as const;

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

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

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
  // (a pre-signed or token-bearing link to a CI run, an artifact or a log) is refused, not stored.
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
 * run by its `url` or a summary as `title`. Nothing given is dropped quietly: a field the kind
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
    if (typeof x !== 'object' || x === null || Array.isArray(x)) { problems.push(`${what} is an object, with a kind: ${EVIDENCE_KINDS.join(', ')}`); return; }
    const o = x as Record<string, unknown>;
    const unknown = Object.keys(o).filter((k) => !(EVIDENCE_KEYS as readonly string[]).includes(k));
    if (unknown.length) problems.push(`${what} has ${unknown.join(', ')}, which evidence doesn't take: it takes ${EVIDENCE_KEYS.join(', ')}`);
    if (!(EVIDENCE_KINDS as readonly unknown[]).includes(o.kind)) { problems.push(`${what}'s kind is one of ${EVIDENCE_KINDS.join(', ')}, not ${JSON.stringify(o.kind ?? null)}`); return; }
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
    if (given('title')) {
      if (typeof o.title !== 'string' || !o.title.trim()) problems.push(`${what}'s title is text`);
      else if (textLength(o.title.trim()) > MAX_TEXT) { limit = true; problems.push(`${what}'s title is ${textLength(o.title.trim()).toLocaleString('en')} characters; the limit is ${MAX_TEXT.toLocaleString('en')}`); }
      else out.title = o.title.trim();
    }
    if (kind === 'commit') {
      refuse(['pr']);
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
      refuse(['sha', 'files']);
      if (!given('url')) problems.push(`${what} is a pull request, named by its https url`);
      if (given('pr')) {
        if (!Number.isInteger(o.pr) || (o.pr as number) < 1 || (o.pr as number) > 9_999_999_999) problems.push(`${what}'s pr is the pull request's number, a whole number from 1`);
        else out.ref = String(o.pr);
      }
    } else {
      refuse(['sha', 'pr', 'files', 'repo']);
      if (!given('url') && !given('title')) problems.push(`${what} is a test run: give its url, or a summary as title ("npm test: 120 passed")`);
    }
    items.push(out);
  });
  return { items: problems.length ? [] : items, problems, limit };
}

/**
 * What makes two items of a package's evidence the same: a commit's sha in its repository (`repository`,
 * its id; none for one recorded before repositories, W5.2a), a pull request's link (sameLink), a test
 * run's link or else its summary.
 */
export function evidenceKey(kind: string, ref: string | null, url: string | null, title: string | null, repository: string | null = null): string {
  return kind === 'commit' ? `commit:${repository ?? ''}:${ref}` : kind === 'pull_request' ? `pr:${sameLink(url ?? '').toLowerCase()}`
    : url ? `test:${sameLink(url)}` : `test-summary:${title ?? ''}`;
}

/** A line naming evidence, for an event's note: each commit's short sha, each pull request's link, each test run. */
export function evidenceSummary(items: CheckedEvidence[]): string {
  return items.map((e) => (e.kind === 'commit' ? `commit ${e.ref!.slice(0, 12)}` : e.kind === 'pull_request' ? `pull request ${e.url}` : `test run ${e.url ?? e.title}`))
    .join(', ').slice(0, 1000);
}
