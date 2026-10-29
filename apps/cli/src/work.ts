/**
 * konjir work and konjir status (W5.4b; JOB4, JOB5, D103, D104): a person's machine set to work.
 * Agents are jobs, not colleagues (D103): Kolab is the queue and the ledger, and this runner takes
 * items from it under a lease and runs one headless harness per item, which does that one item and
 * exits. A job runs on the model account of the person whose machine took it, and the machine keeps
 * nothing a job needs beyond the person's sign-in (DEL8).
 *
 *   konjir work [--jobs <n>] [--once] [--machine <label>] [--allow-all] [--harness <cmd>] [--repo <url>] [-C <dir>]
 *   konjir status [--json]
 *
 * `konjir work`, in a checkout of the kolab's registered repository (checked as `konjir work deliver`
 * checks it), takes jobs with konjir_take_job up to --jobs at once. Each job gets a git worktree at
 * the default branch's head, outside the checkout, and the harness (Claude Code, `claude -p`) run
 * there with the item's instructions on its stdin and Kolab as its one MCP server. The job's token
 * reaches the harness in its environment alone: the MCP config names `${KONJIR_TOKEN}`, which Claude
 * Code expands in a header, so it is never in an argument or a file. The runner renews each job's
 * lease (konjir_renew_job) well within it, ends the job when its harness exits (konjir_end_job: done
 * on exit code 0, failed otherwise, the output's tail as the note), keeps a worktree with work not
 * yet pushed and removes the rest, and, while nothing is ready, waits: polling with backoff, and
 * woken early by a job ending or the person's inbox changing. SIGINT or SIGTERM stops every harness
 * and ends its job as stopped, which gives back what it held. A job never merges or deploys.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { checkoutRepository, type Call, type Git } from './deliver.js';

/** The most jobs at once the runner takes by default (JOB4): the per-person cap (JOB3). */
export const DEFAULT_JOBS = 4;
/** Waiting with nothing ready: the first wait, doubling to the longest. */
export const POLL_FIRST_MS = 30_000;
export const POLL_LONGEST_MS = 5 * 60_000;
/** How much of a harness's output a job's note carries, from its end. */
const NOTE_TAIL = 2000;
/** How long a stopped harness has to exit before it is killed. */
const KILL_AFTER_MS = 10_000;

/** A runner's git, which may reach the remote (fetch) and change the checkout (worktrees): async, in `dir`. */
export type Shell = (dir: string, args: string[]) => Promise<string>;

/**
 * Git for the runner's own steps (fetch, worktree add and remove, and reading a worktree's state),
 * never through a shell, never prompting (`GIT_TERMINAL_PROMPT=0`). Unlike deliver's reads, these
 * reach the remote, with the person's own git settings and credentials, as their `git fetch` would.
 */
export const gitShell: Shell = (dir, args) => new Promise((resolve, reject) => {
  execFile('git', ['--no-pager', ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) => {
    if (!e) return resolve(out);
    const code = (e as { code?: unknown }).code;
    reject(new Error(code === 'ENOENT' ? 'git isn\'t installed, or isn\'t on PATH: konjir work runs each job in a git worktree' : `git ${args.join(' ')}: ${(err || e.message).trim()}`));
  });
});

/** A job konjir_take_job started (JOB2, JOB3): its item, the pool agent doing it, its token (given once) and its lease. */
export interface TakenJob {
  job: string; kind: 'build' | 'review'; item: string; agent: string; token: string; lease_until: string; instructions: string; trailer?: string;
}
/** The caps on live jobs (JOB3): the person's and the kolab's. */
export interface Caps { person: { live: number; max: number }; kolab: { live: number; max: number } }
type Take = ({ taken: true } & TakenJob) | { taken: false; why: string; counts?: unknown; caps?: Caps };

/** What the runner was told to do. */
export interface WorkOptions {
  /** Jobs at once, at most (within the server's caps). */
  jobs?: number;
  /** Takes at most one round of jobs, waits for them, and returns. */
  once?: boolean;
  /** This machine's label in Kolab's job table; by default the hostname. */
  machine?: string;
  /** The harness runs with every permission (Claude Code's --dangerously-skip-permissions). */
  allowAll?: boolean;
  /** The harness command, split on spaces; by default `claude` (KONJIR_HARNESS). */
  harness?: string;
  /** The registered repository this checkout is, when none of its remotes is its URL. */
  repo?: string;
  /** Kolab's MCP URL, which each job's harness and its konjir connect to. */
  url: string;
}

/** What the runner needs from outside: Kolab, git and the clock; tests replace them. */
export interface WorkDeps {
  /** Calls Kolab as the person (konjir_<verb>). */
  call: Call;
  /** Git's reads in the checkout, as deliver runs them. */
  git: Git;
  /** Git for fetch and worktrees. */
  shell?: Shell;
  /** Where job worktrees and logs go: ~/.konjir/jobs by default (KONJIR_JOBS_DIR). */
  jobsDir?: string;
  /** Lines for the person, on stderr by default. */
  log?: (line: string) => void;
  /** Aborted to stop: every harness is stopped and its job ended as stopped. */
  signal?: AbortSignal;
  /** Resolves each time the person's inbox changes, to look for work at once. */
  pushed?: (wake: () => void) => void;
  /** Overrides for tests: the heartbeat, and the first and longest wait. */
  heartbeatMs?: number; pollFirstMs?: number; pollLongestMs?: number;
  /** The environment a harness starts from. */
  env?: NodeJS.ProcessEnv;
}

/** How one job ended, as `konjir work` reports it. */
export interface JobReport { job: string; kind: string; item: string; agent: string; outcome: 'done' | 'failed' | 'stopped' | 'lost'; exit?: number | null; worktree?: string; kept?: string }

/** Tools Claude Code may use without asking, beyond edits in its worktree (acceptEdits): git, npm, npx, gh and konjir, and Kolab's own tools (JOB4). */
export const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'TodoWrite',
  'Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(gh *)', 'Bash(konjir *)', 'mcp__konjir'];
/** What a job never does, even with --allow-all: a job never merges or deploys (JOB4). */
export const DENIED_TOOLS = ['Bash(gh pr merge *)', 'Bash(git push --force *)', 'Bash(git push -f *)', 'Bash(terraform *)'];

/** What a job's harness is told beside the item's instructions. */
const JOB_RULES = 'You are a Konjir job: you do this one item and exit. Kolab is your MCP server (konjir), as the job\'s pool agent. '
  + 'Work only in this worktree. Push your branch and open a pull request if the item calls for one, but never merge a pull request '
  + 'and never deploy: that stays a person\'s. When the item is done (submitted, or your review recorded), exit.';

/**
 * The harness's command line, environment and stdin for a job (JOB4). For Claude Code: headless
 * (`-p`), the prompt on stdin (its --mcp-config and --allowedTools take every argument after them),
 * Kolab its only MCP server (`--strict-mcp-config`, so no server of the person's own config joins),
 * as HTTP with `Authorization: Bearer ${KONJIR_TOKEN}`, which Claude Code expands from its own
 * environment, so the token is in no argument and no file. Permissions: acceptEdits and the allowed
 * tools, or with `allowAll` --dangerously-skip-permissions; DENIED_TOOLS either way. KONJIR_URL and
 * KONJIR_TOKEN let `konjir work deliver` inside the job work as the job's agent.
 */
export function harnessCommand(job: TakenJob, opts: { url: string; allowAll?: boolean; harness?: string; worktree: string; env?: NodeJS.ProcessEnv }) {
  const [command, ...pre] = (opts.harness?.trim() || 'claude').split(/\s+/);
  const mcp = { mcpServers: { konjir: { type: 'http', url: opts.url, headers: { Authorization: 'Bearer ${KONJIR_TOKEN}' } } } };
  const args = [...pre, '-p', '--output-format', 'text', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--append-system-prompt', JOB_RULES,
    ...(opts.allowAll ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS]),
    '--disallowedTools', ...DENIED_TOOLS];
  const { KONJIR_AGENT: _agent, ...base } = opts.env ?? process.env;
  const env = { ...base, KONJIR_URL: opts.url, KONJIR_TOKEN: job.token, KONJIR_JOB: job.job, KONJIR_ITEM: job.item, KONJIR_JOB_KIND: job.kind };
  const prompt = [
    `Konjir job ${job.job}: ${job.kind === 'review' ? 'review' : 'build'} ${job.item}, as ${job.agent}, in the worktree ${opts.worktree}.`,
    ...(job.trailer ? [`Every commit for it carries the trailer "${job.trailer}" (git commit --trailer "${job.trailer}"); konjir work deliver records them.`] : []),
    '', job.instructions,
  ].join('\n');
  return { command, args, env, prompt };
}

/** A worktree's directory name for a job: its id, with anything but letters, digits, `.`, `_` and `-` made `_`. */
const slug = (job: string) => job.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'job';

/** How long to wait between heartbeats for a lease ending at `until`: a third of what is left, from 5 s to 5 minutes. */
export function heartbeatAfter(until: string, now = Date.now()) {
  const left = Date.parse(until) - now;
  return Number.isFinite(left) ? Math.max(5_000, Math.min(POLL_LONGEST_MS, Math.floor(left / 3))) : 60_000;
}

/** A job the runner is running. */
interface Live { taken: TakenJob; child?: ChildProcess; stopping: boolean; lost: boolean; tail: string; done: Promise<JobReport> }

/**
 * `konjir work`: checks the session is a person's and the checkout is the kolab's registered
 * repository, then takes and runs jobs until stopped (or, with `once`, one round). Returns how each
 * job ended.
 */
export async function runWork(deps: WorkDeps, opts: WorkOptions): Promise<JobReport[]> {
  const log = deps.log ?? ((l: string) => console.error(l));
  const shell = deps.shell ?? gitShell;
  const max = opts.jobs ?? DEFAULT_JOBS;
  if (!Number.isInteger(max) || max < 1 || max > 32) throw new Error('--jobs is a whole number from 1 to 32 (Kolab caps a person\'s live jobs, 4 by default)');
  const machine = (opts.machine ?? hostname()).trim();
  if (!machine) throw new Error('--machine names this machine');

  const me = await deps.call('whoami', {}) as { kind: string; actor: string; kolab: string };
  if (me.kind !== 'person') {
    throw new Error(`this session is ${me.actor}, an agent: konjir work runs as a person, who sets their machine to work and whose pool agents do the jobs (D103). `
      + 'Sign in as yourself, konjir login (on Kolab\'s page choose Yourself), with no KONJIR_TOKEN set.');
  }
  const { checkout, repo } = await checkoutRepository(deps.call, deps.git, opts.repo);
  const remote = checkout.remote;
  const jobsDir = deps.jobsDir ?? join(homedir(), '.konjir', 'jobs');
  mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  log(`konjir work: ${me.actor} in kolab ${me.kolab}, on ${machine}, in ${checkout.top} (${repo.url}); up to ${max} job${max === 1 ? '' : 's'} at once${opts.allowAll ? ', with every permission (--allow-all)' : ''}.`);

  const live = new Map<string, Live>();
  const reports: JobReport[] = [];
  let stopped = deps.signal?.aborted ?? false;
  // Whatever wakes the loop: a job ending, the inbox changing, a stop, or the wait running out. A
  // wake that comes while the loop is busy is kept (poked), so the next wait returns at once.
  let poked = false;
  let waiting: (() => void) | undefined;
  const wake = () => { poked = true; waiting?.(); };
  const woken = (ms?: number) => new Promise<void>((resolve) => {
    if (poked) { poked = false; resolve(); return; }
    const t = ms === undefined ? undefined : setTimeout(() => done(), ms);
    const done = () => { clearTimeout(t); waiting = undefined; poked = false; resolve(); };
    waiting = done;
  });
  const stopAll = () => {
    stopped = true;
    for (const l of live.values()) stop(l, 'stopped');
    wake();
  };
  deps.signal?.addEventListener('abort', stopAll, { once: true });
  deps.pushed?.(() => wake());

  /** Stops a job's harness: SIGTERM to its process group, then SIGKILL if it hasn't exited. */
  const stop = (l: Live, why: 'stopped' | 'lost') => {
    if (why === 'lost') l.lost = true; else l.stopping = true;
    const child = l.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) kill('SIGKILL'); }, KILL_AFTER_MS).unref();
  };

  /** Ends a job in Kolab, saying how; a job Kolab already ended (lost) is only reported. */
  const end = async (l: Live, outcome: 'done' | 'failed' | 'stopped', note: string) => {
    try {
      await deps.call('end_job', { job: l.taken.job, outcome, ...(note ? { note: note.slice(-NOTE_TAIL) } : {}) });
    } catch (e) {
      if (!l.lost) log(`job ${l.taken.job}: konjir_end_job failed (${(e as Error).message}); its lease lapses by itself.`);
    }
  };

  // Git that changes the checkout (fetch, worktree add and remove) runs one call at a time.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(f: () => Promise<T>): Promise<T> => {
    const p = turn.then(f);
    turn = p.catch(() => undefined);
    return p;
  };

  /** Keeps a worktree with commits not on any remote branch, or changes not committed; removes the rest. */
  const tidy = async (worktree: string): Promise<string | undefined> => {
    if (!existsSync(worktree)) return undefined;
    try {
      const unpushed = (await shell(worktree, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).trim();
      const dirty = (await shell(worktree, ['status', '--porcelain'])).trim();
      if (unpushed !== '0' || dirty) return unpushed !== '0' ? `${unpushed} commit(s) not pushed` : 'changes not committed';
      await inTurn(() => shell(checkout.top, ['worktree', 'remove', '--force', worktree]));
      return undefined;
    } catch (e) {
      return `couldn't check or remove it (${(e as Error).message})`;
    }
  };

  /** Runs one taken job: its worktree, its harness and heartbeat, its end and its tidying. */
  const run = (taken: TakenJob) => {
    const l: Live = { taken, stopping: stopped, lost: false, tail: '', done: Promise.resolve(undefined as never) };
    live.set(taken.job, l);
    l.done = (async (): Promise<JobReport> => {
      const report: JobReport = { job: taken.job, kind: taken.kind, item: taken.item, agent: taken.agent, outcome: 'failed' };
      const worktree = join(jobsDir, slug(taken.job));
      let beat: NodeJS.Timeout | undefined;
      try {
        // The default branch's head, fetched first: the remote's HEAD, or, where it isn't recorded, as
        // the remote says it. One job at a time, since git locks the checkout's refs and worktrees.
        const made = await inTurn(async () => {
          await shell(checkout.top, ['fetch', '--quiet', remote]);
          let base = (await shell(checkout.top, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => '')).trim();
          if (!base) {
            const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(await shell(checkout.top, ['ls-remote', '--symref', remote, 'HEAD']));
            if (!m) throw new Error(`${remote} names no default branch`);
            base = `${remote}/${m[1]}`;
          }
          if (l.stopping || l.lost) return false;
          await shell(checkout.top, ['worktree', 'add', '--detach', '--quiet', worktree, base]);
          return true;
        });
        if (!made) { await end(l, 'stopped', 'stopped before it started'); report.outcome = 'stopped'; return report; }
        report.worktree = worktree;
        const h = harnessCommand(taken, { url: opts.url, allowAll: opts.allowAll, harness: opts.harness ?? deps.env?.KONJIR_HARNESS ?? process.env.KONJIR_HARNESS, worktree, env: deps.env });
        log(`job ${taken.job}: ${taken.kind} ${taken.item} as ${taken.agent}, in ${worktree}`);
        const out = createWriteStream(join(jobsDir, `${slug(taken.job)}.log`), { flags: 'a', mode: 0o600 });
        const child = spawn(h.command, h.args, { cwd: worktree, env: h.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        l.child = child;
        if (l.stopping) stop(l, 'stopped');
        const keep = (b: Buffer) => { out.write(b); l.tail = (l.tail + b.toString('utf8')).slice(-NOTE_TAIL * 2); };
        child.stdout!.on('data', keep);
        child.stderr!.on('data', keep);
        child.stdin!.on('error', () => undefined);
        child.stdin!.end(h.prompt);
        // The heartbeat: a renewal well within the lease; an error means the job is over, so its harness stops.
        const renew = (until: string) => {
          beat = setTimeout(async () => {
            if (l.stopping || l.lost) return;
            try {
              const r = await deps.call('renew_job', { job: taken.job }) as { lease_until: string };
              renew(r.lease_until);
            } catch (e) {
              log(`job ${taken.job}: Kolab ended it (${(e as Error).message}); stopping its harness.`);
              stop(l, 'lost');
            }
          }, deps.heartbeatMs ?? heartbeatAfter(until));
        };
        renew(taken.lease_until);
        const exit = await new Promise<number | null>((resolve) => {
          child.on('error', (e) => { l.tail += `\n${h.command}: ${e.message}`; resolve(null); });
          child.on('close', (code) => resolve(code));
        });
        clearTimeout(beat);
        await new Promise<void>((r) => out.end(r));
        report.exit = exit;
        report.outcome = l.lost ? 'lost' : l.stopping ? 'stopped' : exit === 0 ? 'done' : 'failed';
        if (report.outcome !== 'lost') await end(l, report.outcome as 'done' | 'failed' | 'stopped', l.tail.trim());
      } catch (e) {
        clearTimeout(beat);
        report.outcome = l.stopping ? 'stopped' : 'failed';
        await end(l, report.outcome, `konjir work couldn't run it: ${(e as Error).message}`);
        log(`job ${taken.job}: ${(e as Error).message}`);
      }
      const kept = report.worktree ? await tidy(report.worktree) : undefined;
      if (kept) report.kept = kept;
      log(`job ${taken.job}: ${report.outcome}${report.exit !== undefined && report.exit !== null ? ` (exit ${report.exit})` : ''}${kept ? `; kept ${report.worktree}: ${kept}` : ''}`);
      return report;
    })().finally(() => { live.delete(taken.job); wake(); });
    l.done.then((r) => reports.push(r));
  };

  let wait = deps.pollFirstMs ?? POLL_FIRST_MS;
  const longest = deps.pollLongestMs ?? POLL_LONGEST_MS;
  try {
    for (;;) {
      if (stopped) break;
      // A round: take until this machine is full or Kolab has nothing for it.
      poked = false;
      let took = 0;
      let why: string | undefined;
      while (!stopped && live.size < max) {
        const r = await deps.call('take_job', { machine }) as Take;
        if (!r.taken) {
          const caps = r.caps ? ` (your jobs ${r.caps.person.live}/${r.caps.person.max}, the kolab's ${r.caps.kolab.live}/${r.caps.kolab.max})` : '';
          why = `${r.why}${caps}`;
          break;
        }
        took++;
        run(r);
      }
      if (opts.once) {
        if (!took && why) log(`nothing taken: ${why}`);
        break;
      }
      // Full: wait for a job to end. Otherwise wait, from the first wait again if this round took
      // anything, doubling while rounds take nothing; a job ending or the inbox changing wakes it sooner.
      if (live.size >= max) { await woken(); continue; }
      if (took) wait = deps.pollFirstMs ?? POLL_FIRST_MS;
      else log(`waiting ${wait / 1000} s: ${why ?? 'nothing ready'}`);
      await woken(wait);
      if (!took) wait = Math.min(longest, wait * 2);
    }
    await Promise.all([...live.values()].map((l) => l.done));
  } finally {
    deps.signal?.removeEventListener('abort', stopAll);
  }
  // Let each report's push run before returning.
  await Promise.resolve();
  return reports;
}

/** A job as konjir_list_jobs gives it (JOB5). */
interface ListedJob { job: string; person: string; machine: string; agent: string; kind: string; item: string; started_at: string; lease_until: string; ended_at?: string | null; outcome?: string | null }

/** `konjir status`: the kolab's queue by kind, its live jobs and the caller's room under the caps, from konjir_list_jobs (JOB5). */
export async function workStatus(call: Call) {
  const jobs: ListedJob[] = [];
  let first: { queue: Record<string, number>; caps: Caps } | undefined;
  let cursor: string | null | undefined;
  do {
    const page = await call('list_jobs', { live: true, limit: 200, ...(cursor ? { cursor } : {}) }) as { jobs: ListedJob[]; queue: Record<string, number>; caps: Caps; next: string | null };
    first ??= page;
    jobs.push(...page.jobs);
    cursor = page.next;
  } while (cursor);
  return { queue: first!.queue, jobs, caps: first!.caps };
}

/** How long ago `since` was, said briefly: 40s, 12m, 3h, 2d. */
function ago(since: string, now: number) {
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  if (!Number.isFinite(s)) return since;
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

/** `konjir status` for a person to read. */
export function formatStatus(s: Awaited<ReturnType<typeof workStatus>>, now = Date.now()): string {
  const room = (c: { live: number; max: number }) => `${c.live} of ${c.max} live, room for ${Math.max(0, c.max - c.live)}`;
  const lines = [
    `Queue:  ${Object.entries(s.queue).map(([k, n]) => `${n} to ${k}`).join(', ') || 'empty'}`,
    `Room:   yours ${room(s.caps.person)}; the kolab's ${room(s.caps.kolab)}`,
  ];
  if (!s.jobs.length) return [...lines, 'Jobs:   none live'].join('\n');
  const rows = [['PERSON', 'MACHINE', 'AGENT', 'KIND', 'ITEM', 'SINCE'],
    ...s.jobs.map((j) => [j.person, j.machine, j.agent, j.kind, j.item, ago(j.started_at, now)])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return [...lines, 'Jobs:', ...rows.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')}`)].join('\n');
}
