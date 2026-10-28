/**
 * konjir work deliver and konjir repo register (W5.2a; KON7, PLN16, D98 rulings 1 and 2): the CLI's
 * side of tying commits to work packages. Kolab never reads or writes git (D36); the CLI runs where
 * git is, reads the local checkout, and sends Kolab what it finds through the same MCP tools any
 * agent calls (konjir_add_evidence, konjir_submit_work, konjir_register_repository).
 *
 *   konjir repo register [--binding <binding>] [--url <https URL>] [--root <sha>] [-C <dir>]
 *   konjir work deliver [<work>] [--submit] [--pr <url>] [--test <url or summary>]… [--note <text>]
 *                       [--since <rev>] [--repo <url>] [--dry-run] [-C <dir>]
 *
 * A commit belongs to a work package when its message carries the trailer
 * `Konjir-Work: kj:<kolab>/<plan>#<id>`, the one konjir_pull_work and konjir_read_work give. Before
 * sending anything, deliver checks that the checkout is the registered repository: its root commit
 * (the parentless commit, which every clone of the repository shares and no other repository has)
 * is the one registered, and one of its remotes is the registered URL. A remote's user, password or
 * token never leaves this machine: remotes are compared after dropping them.
 *
 * The published client bundles none of the engine, so the URL rules are written out again here, to
 * agree with the engine's repositoryUrl.
 */
import { execFileSync } from 'node:child_process';

/** Runs git with `args` in a checkout and returns what it prints. */
export type Git = (args: string[]) => string;

/** The most a call to Kolab takes (MAX_EVIDENCE_PER_CALL), the most files a commit names, and the longest path and subject. */
const PER_CALL = 50;
const FILES = 500;
const PATH = 1024;
const SUBJECT = 4000;

/**
 * Git in `dir`, never through a shell. `core.fsmonitor` is off, so a checkout's own config can't
 * have git run a program as it reads; git reads nothing it would ask a password for (`GIT_TERMINAL_PROMPT=0`).
 */
export function gitIn(dir: string, env: NodeJS.ProcessEnv = process.env): Git {
  return (args) => {
    try {
      return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (e) {
      const err = e as { code?: string; stderr?: string; message?: string };
      if (err.code === 'ENOENT') throw new Error('git isn\'t installed, or isn\'t on PATH: konjir work deliver and konjir repo register read your checkout with it');
      throw new Error(`git ${args.join(' ')}: ${(err.stderr || err.message || '').trim()}`);
    }
  };
}

/**
 * A remote's URL as a repository's identity, in the form Kolab stores (https://host[:port]/path, the
 * host in lower case, no trailing slash, no .git), or undefined for a remote that names no host (a
 * local path). An SSH remote (git@host:owner/name, ssh://git@host/owner/name) maps to the same https
 * URL, without its SSH port; a user, password or token in a remote is dropped here, never sent.
 */
export function canonicalRemote(remote: string): string | undefined {
  const t = remote.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(t);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    let u: URL;
    try { u = new URL(t); } catch { return undefined; }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(u.protocol)) return undefined;
    host = u.protocol === 'https:' || u.protocol === 'http:' ? u.host : u.hostname;
    path = u.pathname;
  } else if (scp && !/^[a-z]:$/i.test(`${scp[1]}:`)) {
    host = scp[1];
    path = `/${scp[2]}`;
  } else {
    return undefined;
  }
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !path || path === '/') return undefined;
  return `https://${host.toLowerCase()}${path}`;
}

/** What identifies a checkout: its top directory, its root commits, whether it is shallow, and its remotes as repository URLs. */
export interface Checkout { top: string; roots: string[]; shallow: boolean; remotes: string[] }

/** Reads a checkout's identity with `git`, or says it isn't one. */
export function readCheckout(git: Git): Checkout {
  let top: string;
  try { top = git(['rev-parse', '--show-toplevel']).trim(); } catch {
    throw new Error('this isn\'t a git checkout: run it in a checkout of the repository (or give -C <dir>)');
  }
  let roots: string[] = [];
  try { roots = git(['rev-list', '--max-parents=0', 'HEAD']).split('\n').map((x) => x.trim().toLowerCase()).filter(Boolean); } catch {
    throw new Error('this checkout has no commit yet');
  }
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  const remotes = [...new Set(git(['remote', '-v']).split('\n')
    .map((l) => /^\S+\s+(\S+)\s+\(fetch\)$/.exec(l.trim())?.[1]).filter((x): x is string => !!x)
    .map(canonicalRemote).filter((x): x is string => !!x).map((x) => x.toLowerCase()))];
  return { top, roots, shallow, remotes };
}

/** A commit that carries a work package's trailer: its sha, its subject and the paths it touched. */
export interface TaggedCommit { sha: string; subject: string; files: string[] }

/**
 * The commits reachable from HEAD (or, with `since`, in since..HEAD) whose message carries
 * `Konjir-Work: <address>` as a trailer, oldest first, each with its subject and the files it
 * touched. A message that merely mentions the address, outside its trailers, doesn't count.
 */
export function taggedCommits(git: Git, address: string, opts: { since?: string } = {}): TaggedCommit[] {
  const range = opts.since ? `${opts.since}..HEAD` : 'HEAD';
  const out = git(['log', '--reverse', '-F', `--grep=${address}`, '--format=%H%x1f%s%x1f%(trailers:key=Konjir-Work,valueonly)%x1e', range, '--']);
  const commits: TaggedCommit[] = [];
  for (const record of out.split('\x1e')) {
    const [sha, subject, trailers] = record.replace(/^\n+/, '').split('\x1f');
    if (!sha?.trim() || trailers === undefined) continue;
    if (!trailers.split('\n').map((x) => x.trim()).includes(address)) continue;
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-z', sha.trim()]).split('\0').filter(Boolean);
    commits.push({ sha: sha.trim().toLowerCase(), subject: subject ?? '', files });
  }
  return commits;
}

/** A repository as konjir_list_repositories gives it. */
interface Repository { id: string; url: string; root_sha: string; binding: string | null; confirmed: boolean }

/** A call to Kolab: konjir_<verb> with its arguments, returning its structured result. */
export type Call = (verb: string, args: Record<string, unknown>) => Promise<unknown>;

async function repositories(call: Call): Promise<Repository[]> {
  const all: Repository[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await call('list_repositories', { limit: 200, ...(cursor ? { cursor } : {}) }) as { repositories: Repository[]; next: string | null };
    all.push(...page.repositories);
    cursor = page.next;
  } while (cursor);
  return all;
}

/**
 * Whether `checkout` is a checkout of `repo`: it has the registered root commit, and, unless the
 * repository was named by hand (`named`), one of its remotes is the registered URL. Throws why not.
 */
function requireCheckoutOf(checkout: Checkout, repo: Repository, named: boolean) {
  if (!checkout.roots.includes(repo.root_sha)) {
    throw new Error(`this checkout isn't ${repo.url}: its root commit ${checkout.roots.length === 1 ? `is ${checkout.roots[0]}` : `s are ${checkout.roots.join(', ')}`}, and ${repo.url} was registered with root commit ${repo.root_sha}. `
      + (checkout.shallow ? 'It is a shallow clone, whose oldest commit stands in for its root: fetch its whole history (git fetch --unshallow) and run it again.'
        : 'Deliver from a checkout of the registered repository; nothing was sent.'));
  }
  if (!named && !checkout.remotes.includes(repo.url.toLowerCase())) {
    throw new Error(`no remote of this checkout is ${repo.url} (its remotes are ${checkout.remotes.join(', ') || 'none'}), though it has its root commit: it may be a fork. `
      + `Deliver from a clone of ${repo.url}, or, if this checkout is one under another URL, name it: --repo ${repo.url}. Nothing was sent.`);
  }
}

/** A pull request's number, from its link, when the link says it (GitHub's /pull/N, GitLab's /merge_requests/N, Bitbucket's /pull-requests/N). */
function prNumber(url: string): number | undefined {
  const m = /\/(?:pull|pulls|merge_requests|pull-requests)\/(\d{1,10})(?:[/?#]|$)/.exec(url);
  return m ? Number(m[1]) : undefined;
}

export interface DeliverOptions {
  /** The work package, kj:[<kolab>/]<plan>#<id>; by default the one the session holds In progress. */
  work?: string;
  submit?: boolean; pr?: string; tests?: string[]; note?: string;
  /** Only commits in <since>..HEAD; by default every commit reachable from HEAD. */
  since?: string;
  /** The registered repository this checkout is, when none of its remotes is its URL. */
  repo?: string;
  /** Says what it would send, and sends nothing. */
  dryRun?: boolean;
}

/**
 * `konjir work deliver`: finds the commits in the checkout that carry the work package's trailer,
 * checks the checkout is the package's registered repository (its root commit, and a remote), and
 * records them as the package's evidence, with a pull request and test runs if given, `PER_CALL` at
 * a time; with `submit`, the last call submits it. Kolab counts a commit it already has, in this
 * round of work, in `already`, so running it again records only what is new.
 */
export async function deliverWork(call: Call, git: Git, opts: DeliverOptions = {}) {
  let work = opts.work;
  if (!work) {
    const held = (await call('list_work', { mine: true, state: 'in_progress' }) as { work: { work: string }[] }).work;
    if (held.length !== 1) {
      throw new Error(held.length ? `you hold ${held.map((w) => w.work).join(', ')} In progress: name the one to deliver, konjir work deliver <work>`
        : 'you hold no work package In progress: name the one to deliver, konjir work deliver kj:<plan>#<id>');
    }
    work = held[0].work;
  }
  const pkg = await call('read_work', { work, limit: 1 }) as { work: string; trailer: string; state: string; repository: { url: string } | null };
  const address = pkg.trailer.replace(/^Konjir-Work:\s*/, '').trim();
  const checkout = readCheckout(git);
  const registered = await repositories(call);
  const find = (url: string) => registered.find((r) => r.url.toLowerCase() === url.toLowerCase());
  let repo: Repository | undefined;
  if (opts.repo) {
    const named = canonicalRemote(opts.repo) ?? opts.repo;
    repo = find(named);
    if (!repo) throw new Error(`${named} isn't a repository registered in this kolab (konjir list_repositories); a person with Maintain registers it, konjir repo register. Nothing was sent.`);
  } else if (pkg.repository) {
    repo = find(pkg.repository.url);
    if (!repo) throw new Error(`${pkg.work} is done in ${pkg.repository.url}, which this session can't find among the kolab's repositories. Nothing was sent.`);
  } else {
    const mine = registered.filter((r) => checkout.roots.includes(r.root_sha) && checkout.remotes.includes(r.url.toLowerCase()));
    if (!mine.length) {
      throw new Error(`this checkout (${checkout.remotes.join(', ') || 'no remote'}) is no repository registered in this kolab, and ${pkg.work} has none of its own: `
        + 'a person with Maintain or Admin registers it, konjir repo register, run in a checkout. Nothing was sent.');
    }
    if (mine.length > 1) throw new Error(`this checkout is ${mine.map((r) => r.url).join(' and ')}: name one with --repo <url>. Nothing was sent.`);
    repo = mine[0];
  }
  if (pkg.repository && pkg.repository.url.toLowerCase() !== repo.url.toLowerCase()) {
    throw new Error(`${pkg.work} is done in ${pkg.repository.url}, not ${repo.url}: deliver it from a checkout of ${pkg.repository.url}. Nothing was sent.`);
  }
  requireCheckoutOf(checkout, repo, !!opts.repo);

  const commits = taggedCommits(git, address, { since: opts.since });
  const warnings: string[] = [];
  const evidence: Record<string, unknown>[] = commits.map((c) => {
    const files = c.files.filter((f) => f.length <= PATH);
    if (files.length < c.files.length) warnings.push(`commit ${c.sha.slice(0, 12)}: ${c.files.length - files.length} path(s) over ${PATH} characters left out`);
    if (files.length > FILES) warnings.push(`commit ${c.sha.slice(0, 12)} touched ${files.length} files; the first ${FILES} are sent`);
    const subject = c.subject.trim().slice(0, SUBJECT);
    return { kind: 'commit', sha: c.sha, repo: repo!.url, ...(subject ? { title: subject } : {}), ...(files.length ? { files: files.slice(0, FILES) } : {}) };
  });
  if (opts.pr) {
    const n = prNumber(opts.pr);
    evidence.push({ kind: 'pull_request', url: opts.pr, repo: repo.url, ...(n ? { pr: n } : {}) });
  }
  for (const t of opts.tests ?? []) evidence.push(/^https:\/\//i.test(t.trim()) ? { kind: 'test_run', url: t.trim() } : { kind: 'test_run', title: t });
  if (!commits.length && !opts.pr) {
    throw new Error(`no commit reachable from HEAD${opts.since ? ` since ${opts.since}` : ''} carries the trailer "Konjir-Work: ${address}", and no pull request was given (--pr): `
      + `add the trailer to its commits (git commit --trailer "Konjir-Work: ${address}") and run it again. Nothing was sent.`);
  }
  const summary = {
    work: pkg.work, repository: repo.url, root_sha: repo.root_sha, trailer: `Konjir-Work: ${address}`,
    commits: commits.map((c) => ({ sha: c.sha, subject: c.subject, files: c.files.length })),
    ...(warnings.length ? { warnings } : {}),
  };
  if (opts.dryRun) return { ...summary, sent: false, evidence };

  let recorded = 0;
  let already = 0;
  const batches: Record<string, unknown>[][] = [];
  for (let i = 0; i < evidence.length; i += PER_CALL) batches.push(evidence.slice(i, i + PER_CALL));
  const last = opts.submit ? batches.pop() ?? [] : undefined;
  for (const batch of batches) {
    const r = await call('add_evidence', { work: pkg.work, evidence: batch }) as { recorded: number; already: number };
    recorded += r.recorded;
    already += r.already;
  }
  if (last === undefined) return { ...summary, sent: true, recorded, already, state: 'in_progress' };
  const r = await call('submit_work', { work: pkg.work, ...(last.length ? { evidence: last } : {}), ...(opts.note ? { note: opts.note } : {}) }) as
    { state: string; in_review: boolean; reviewers: string[]; unreviewed: boolean; recorded: number; already: number; next?: string };
  return { ...summary, sent: true, recorded: recorded + r.recorded, already: already + r.already, state: r.state, in_review: r.in_review, reviewers: r.reviewers,
    unreviewed: r.unreviewed, ...(r.next ? { next: r.next } : {}) };
}

/**
 * `konjir repo register`: registers the checkout's repository in the session's kolab, as its
 * person (Kolab refuses an agent, D98): its URL from the `origin` remote (or `url`), without any
 * credential the remote carries, and its root commit (or `root`, which must be one of the
 * checkout's). Outside a checkout, both must be given.
 */
export async function registerRepository(call: Call, git: Git, opts: { url?: string; root?: string; binding?: string } = {}) {
  let url = opts.url;
  let root = opts.root?.trim().toLowerCase();
  let checkout: Checkout | undefined;
  try { checkout = readCheckout(git); } catch (e) { if (!url || !root) throw e; }
  if (checkout) {
    if (!url) {
      let origin: string;
      try { origin = git(['remote', 'get-url', 'origin']).trim(); } catch {
        throw new Error('this checkout has no origin remote: give the repository\'s URL, --url https://host/owner/name');
      }
      url = canonicalRemote(origin);
      if (!url) throw new Error('origin isn\'t a hosted repository\'s URL (it is a local path): give the repository\'s URL, --url https://host/owner/name');
    }
    if (root && !checkout.roots.includes(root)) throw new Error(`${root} isn't a root commit of this checkout (they are ${checkout.roots.join(', ')})`);
    if (!root) {
      if (checkout.shallow) throw new Error('this is a shallow clone, whose oldest commit stands in for its root: fetch its whole history (git fetch --unshallow), or give --root <sha>');
      if (checkout.roots.length !== 1) throw new Error(`this checkout has ${checkout.roots.length} root commits (${checkout.roots.join(', ')}): name the repository's own with --root <sha>`);
      root = checkout.roots[0];
    }
  }
  return call('register_repository', { url, root_sha: root, ...(opts.binding ? { binding: opts.binding } : {}) });
}
