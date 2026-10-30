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
 * checks it), first checks it can work at all (it fetches the repository's remote, finds its default
 * branch and finds the harness on PATH), then takes jobs with konjir_take_job up to --jobs at once.
 * Each job gets a git worktree at the default branch's head, fetched once a round, outside the
 * checkout, and the harness (Claude Code, `claude -p`) run there with the item's instructions on its
 * stdin and Kolab as its one MCP server. The job's token reaches the harness in its environment
 * alone: the MCP config names `${KONJIR_TOKEN}`, which Claude Code expands in a header, so it is
 * never in an argument or a file, and it is redacted from the job's log and note. The environment is
 * an allowlist, and points konjir's credentials at a file that doesn't exist, so nothing in a job
 * reaches the person's own sign-in (the CLI refuses one anyway when KONJIR_JOB is set).
 *
 * The runner renews each job's lease (konjir_renew_job) from the moment it is taken, well within it:
 * Kolab refusing a renewal means the job is over, and its harness, if it hasn't exited already, is
 * stopped (lost, with how Kolab ended it); Kolab out of reach is tried again, briefly, until the
 * lease is nearly gone. It ends the job when its harness exits
 * (konjir_end_job: done on exit code 0, failed otherwise, the output's tail as the note), keeps a
 * worktree with work not yet pushed and removes the rest, and, while nothing is ready or Kolab can't
 * be reached, waits: polling with backoff, and woken early by a job ending or the person's inbox
 * changing. A job that can't start backs it off too, and three in a row stop it taking any more.
 * Stopping (SIGINT, SIGTERM, SIGHUP, or the runner failing) stops every harness and ends its job as
 * stopped, which gives back what it held. A job never merges or deploys; main's branch protection
 * (D89) is what guarantees it, and the denials here only keep a job from trying.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { canonicalRemote, checkoutRepository, type Call, type Git } from './deliver.js';
import { credentialsPath } from './login.js';

/** The most jobs at once the runner takes by default (JOB4): the per-person cap (JOB3). */
export const DEFAULT_JOBS = 4;
/** Waiting with nothing ready: the first wait, doubling to the longest. */
export const POLL_FIRST_MS = 30_000;
export const POLL_LONGEST_MS = 5 * 60_000;
/** How much of a harness's output a job's note carries, from its end. */
const NOTE_TAIL = 2000;
/** How long a stopped harness has to exit before it is killed. */
const KILL_AFTER_MS = 10_000;
/** Jobs in a row that couldn't start before the runner stops taking any. */
export const SETUP_FAILURES = 3;
/** A renewal Kolab couldn't be reached for is tried again until this little of the lease is left. */
const LEASE_FLOOR_MS = 5_000;
/** A job's id, used as its worktree's name: a letter or digit, then letters, digits, `.`, `_` and `-`. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Kolab refused a call (the tool's own error, MCP's isError), as against a call that never reached it
 * or whose answer was lost. Only a refusal of konjir_renew_job means a job is over.
 */
export class ToolRefusal extends Error {}

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

/** A job konjir_take_job started (JOB2, JOB3): its item, the pool agent doing it, its token (given once) and its lease, with Kolab's clock if it gives it. */
export interface TakenJob {
  job: string; kind: 'build' | 'review'; item: string; agent: string; token: string; lease_until: string; instructions: string; trailer?: string; now?: string;
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
  /** The harness command, split on spaces (no quoting); by default `claude` (KONJIR_HARNESS). */
  harness?: string;
  /** The registered repository this checkout is, when it doesn't track its URL. */
  repo?: string;
  /** Kolab's MCP URL, which each job's harness and its konjir connect to. */
  url: string;
}

/** What the runner needs from outside: Kolab, git and the clock; tests replace them. */
export interface WorkDeps {
  /** Calls Kolab as the person (konjir_<verb>); a refusal is a ToolRefusal. */
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
  /** Calls `wake` each time the person's inbox changes, to look for work at once. */
  pushed?: (wake: () => void) => void;
  /** Each live harness's process group, for a caller that must kill them at once (a second Ctrl-C). */
  processes?: Set<number>;
  /** Overrides for tests: the heartbeat, and the first and longest wait. */
  heartbeatMs?: number; pollFirstMs?: number; pollLongestMs?: number;
  /** The environment a harness's is drawn from (through HARNESS_ENV), and where KONJIR_HARNESS is read. */
  env?: NodeJS.ProcessEnv;
}

/** How one job ended, as `konjir work` reports it. */
export interface JobReport {
  job: string; kind: string; item: string; agent: string;
  /** How the harness ended, as the runner saw it: lost when the runner stopped it because Kolab had ended its job. */
  outcome: 'done' | 'failed' | 'stopped' | 'lost';
  /** How Kolab's ledger has it, when it said: submitted, reviewed, released, stopped… */
  ledger?: string;
  exit?: number | null; worktree?: string; kept?: string;
}

/** Tools Claude Code may use without asking, beyond edits in its worktree (acceptEdits): git, npm, npx, gh and konjir, and Kolab's own tools (JOB4). */
export const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'TodoWrite',
  'Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(gh *)', 'Bash(konjir *)', 'mcp__konjir'];

/**
 * What a job is kept from trying, even with --allow-all: merging, `gh api` (which can merge, or
 * change the repository's settings), pushing to the default branch, forcing or deleting a push, a
 * mirror or --all push (a `:<branch>` delete refspec isn't a pattern Claude Code can write: its
 * trailing `:*` reads as the old prefix syntax), git pointed elsewhere or reconfigured (`-c`, `-C`, `--git-dir`), terraform,
 * and reading or writing the person's konjir credentials. Claude Code's patterns are prefix globs, so
 * this is a fence, not a wall: main's branch protection, which requires CI and binds admins (D89), is
 * what keeps a job from merging or deploying.
 */
export function deniedTools(branch: string, credentialsDir: string): string[] {
  const b = branch;
  const dir = `/${credentialsDir.replace(/\/+$/, '')}/**`;
  return [
    'Bash(gh pr merge*)', 'Bash(gh * merge*)', 'Bash(gh api*)', 'Bash(terraform*)',
    'Bash(git -c*)', 'Bash(git -C*)', 'Bash(git --git-dir*)', 'Bash(git --work-tree*)', 'Bash(git --exec-path*)', 'Bash(git config*)',
    'Bash(git push --force*)', 'Bash(git push -f*)', 'Bash(git push * --force*)', 'Bash(git push * -f*)',
    'Bash(git push +*)', 'Bash(git push * +*)', 'Bash(git push --mirror*)', 'Bash(git push * --mirror*)', 'Bash(git push --all*)', 'Bash(git push * --all*)',
    'Bash(git push --delete*)', 'Bash(git push * --delete*)', 'Bash(git push -d*)', 'Bash(git push * -d *)',
    `Bash(git push *:${b})`, `Bash(git push *:${b} *)`, `Bash(git push *:refs/heads/${b}*)`, `Bash(git push * ${b})`, `Bash(git push * ${b} *)`,
    // Edit(path) covers every tool that edits a file; Write(path) and MultiEdit(path) match nothing.
    `Read(${dir})`, `Edit(${dir})`,
  ];
}

/**
 * What of the runner's environment reaches a harness: what the work needs (the shell's basics, git's
 * and ssh's, gh's token for a pull request, Claude Code's own), and nothing else. Cloud credentials,
 * Kolab's admin token or database URL, the person's KONJIR_* and XDG_CONFIG_HOME stay behind.
 */
const HARNESS_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM', 'TZ', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']);
const HARNESS_ENV_PREFIXES = ['LC_', 'GIT_', 'ANTHROPIC_', 'CLAUDE_'];
export function harnessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (HARNESS_ENV.has(k) || HARNESS_ENV_PREFIXES.some((p) => k.startsWith(p)))) out[k] = v;
  }
  return out;
}

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
 * tools, or with `allowAll` --dangerously-skip-permissions; deniedTools either way. The environment
 * is HARNESS_ENV's, with KONJIR_URL and KONJIR_TOKEN, so `konjir work deliver` inside the job works
 * as the job's agent, and KONJIR_CREDENTIALS naming `credentials`, a file that doesn't exist.
 */
export function harnessCommand(job: TakenJob, opts: { url: string; allowAll?: boolean; harness?: string; worktree: string; branch: string; credentials: string; personCredentials?: string; env?: NodeJS.ProcessEnv }) {
  const [command, ...pre] = (opts.harness?.trim() || 'claude').split(/\s+/);
  const mcp = { mcpServers: { konjir: { type: 'http', url: opts.url, headers: { Authorization: 'Bearer ${KONJIR_TOKEN}' } } } };
  const personDir = dirname(opts.personCredentials ?? credentialsPath(opts.env ?? process.env));
  const args = [...pre, '-p', '--output-format', 'text', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--append-system-prompt', JOB_RULES,
    ...(opts.allowAll ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS]),
    '--disallowedTools', ...deniedTools(opts.branch, personDir)];
  const env = { ...harnessEnv(opts.env ?? process.env), KONJIR_URL: opts.url, KONJIR_TOKEN: job.token, KONJIR_CREDENTIALS: opts.credentials,
    KONJIR_JOB: job.job, KONJIR_ITEM: job.item, KONJIR_JOB_KIND: job.kind };
  const prompt = [
    `Konjir job ${job.job}: ${job.kind === 'review' ? 'review' : 'build'} ${job.item}, as ${job.agent}, in the worktree ${opts.worktree}.`,
    ...(job.trailer ? [`Every commit for it carries the trailer "${job.trailer}" (git commit --trailer "${job.trailer}"); konjir work deliver records them.`] : []),
    '', job.instructions,
  ].join('\n');
  return { command, args, env, prompt };
}

/** How long a lease runs from now: `until` less Kolab's own `now` when it gives one, else less this machine's clock. */
export function leaseLeft(until: string, serverNow?: string, localNow = Date.now()) {
  const end = Date.parse(until);
  const now = serverNow !== undefined && Number.isFinite(Date.parse(serverNow)) ? Date.parse(serverNow) : localNow;
  return Number.isFinite(end) ? end - now : NaN;
}

/** How long to wait between heartbeats for a lease with `left` ms to run: a third of it, from 5 s to 5 minutes. */
export function heartbeatEvery(left: number) {
  return Number.isFinite(left) ? Math.max(5_000, Math.min(POLL_LONGEST_MS, Math.floor(left / 3))) : 60_000;
}

/** A server's string fit to print: control characters (a terminal's escapes among them) dropped. */
const clean = (s: unknown) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

/**
 * A stream's text with `secret` replaced, however the stream cuts it: what might be the start of the
 * secret is held back until the next piece, or the end, shows it isn't.
 */
export class Redactor {
  private held = '';
  private readonly decoder = new StringDecoder('utf8');
  constructor(private readonly secret: string, private readonly mask = '[job token]') {}
  private redact(s: string) { return this.secret ? s.split(this.secret).join(this.mask) : s; }
  push(b: Buffer | string): string {
    const s = this.redact(this.held + (typeof b === 'string' ? b : this.decoder.write(b)));
    const keep = this.secret ? Math.min(s.length, this.secret.length - 1) : 0;
    this.held = s.slice(s.length - keep);
    return s.slice(0, s.length - keep);
  }
  end(): string { const s = this.redact(this.held + this.decoder.end()); this.held = ''; return s; }
}

/** `text` with every `secret` in it masked. */
const redacted = (text: string, secret: string) => (secret ? text.split(secret).join('[job token]') : text);

/** Whether `command` names a program this machine can run: a path to an executable file, or one on PATH. */
function runnable(command: string, path: string | undefined) {
  const ok = (p: string) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
  if (command.includes('/')) return ok(command);
  return (path ?? '').split(delimiter).filter(Boolean).some((d) => ok(join(d, command)));
}

/**
 * The remote a job's worktree comes from: the one the checkout tracks, which is the registered URL;
 * or, with --repo, the remote whose URL is the registered one, never a fork's origin. Throws when
 * none is.
 */
function remoteOf(git: Git, tracked: { remote: string; tracked: string | undefined }, url: string): string {
  if (tracked.tracked === url.toLowerCase()) return tracked.remote;
  const names = git(['remote']).split('\n').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(x));
  for (const name of names) {
    let u: string | undefined;
    try { u = canonicalRemote(git(['remote', 'get-url', name]).trim())?.toLowerCase(); } catch { /* none */ }
    if (u === url.toLowerCase()) return name;
  }
  throw new Error(`no remote of this checkout is ${url}, so konjir work has nowhere to start a job from but a fork: add it (git remote add upstream ${url}) and run it again`);
}

/** A job the runner is running. */
interface Live {
  taken: TakenJob; child?: ChildProcess; stopping: boolean; lost?: 'refused' | 'unreachable'; finished: boolean;
  /** How Kolab ended the job, as its refusal of a renewal said (released, stopped, lapsed…). */
  endedAs?: string;
  tail: string; beat?: NodeJS.Timeout; kill?: NodeJS.Timeout; done: Promise<JobReport>;
}

/**
 * `konjir work`: checks the session is a person's, the checkout is the kolab's registered repository
 * and a job could run here, then takes and runs jobs until stopped (or, with `once`, one round).
 * Returns how each job ended.
 */
export async function runWork(deps: WorkDeps, opts: WorkOptions): Promise<JobReport[]> {
  if (process.platform === 'win32') throw new Error('konjir work doesn\'t run on Windows yet: run it on macOS or Linux (or WSL)');
  const log = deps.log ?? ((l: string) => console.error(l));
  const shell = deps.shell ?? gitShell;
  const env = deps.env ?? process.env;
  const max = opts.jobs ?? DEFAULT_JOBS;
  if (!Number.isInteger(max) || max < 1 || max > 32) throw new Error('--jobs is a whole number from 1 to 32 (Kolab caps a person\'s live jobs, 4 by default)');
  const machine = (opts.machine ?? hostname()).trim();
  if (!machine) throw new Error('--machine names this machine');
  const harness = opts.harness ?? env.KONJIR_HARNESS;

  const me = await deps.call('whoami', {}) as { kind: string; actor: string; kolab: string };
  if (me.kind !== 'person') {
    throw new Error(`this session is ${clean(me.actor)}, an agent: konjir work runs as a person, who sets their machine to work and whose pool agents do the jobs (D103). `
      + 'Sign in as yourself, konjir login (on Kolab\'s page choose Yourself), with no KONJIR_TOKEN set.');
  }
  const { checkout, repo } = await checkoutRepository(deps.call, deps.git, opts.repo);
  const remote = remoteOf(deps.git, checkout, repo.url);
  const jobsDir = deps.jobsDir ?? join(homedir(), '.konjir', 'jobs');
  mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  // Git that changes the checkout (fetch, worktree add and remove) runs one call at a time.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(f: () => Promise<T>): Promise<T> => {
    const p = turn.then(f);
    turn = p.catch(() => undefined);
    return p;
  };
  /** Fetches the remote and finds its default branch's head: its recorded HEAD, or, where it isn't recorded, as the remote says it. */
  const fetchBase = () => inTurn(async () => {
    await shell(checkout.top, ['fetch', '--quiet', remote]);
    let base = (await shell(checkout.top, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => '')).trim();
    if (!base) {
      const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(await shell(checkout.top, ['ls-remote', '--symref', remote, 'HEAD']));
      if (!m) throw new Error(`${remote} names no default branch`);
      base = `${remote}/${m[1]}`;
    }
    if (!base.startsWith(`${remote}/`)) throw new Error(`${remote}'s HEAD is ${base}, not one of its branches`);
    return { base, branch: base.slice(remote.length + 1) };
  });

  // Preflight: a job could start here, or nothing is taken.
  const [harnessCmd] = (harness?.trim() || 'claude').split(/\s+/);
  if (!runnable(harnessCmd, env.PATH)) throw new Error(`the harness ${harnessCmd} isn't on PATH (or isn't executable): install Claude Code, or name another with --harness`);
  let round: Promise<{ base: string; branch: string }> = fetchBase().catch((e: Error) => { throw new Error(`konjir work couldn't fetch ${remote} (${repo.url}): ${e.message}`); });
  await round;
  log(`konjir work: ${clean(me.actor)} in kolab ${clean(me.kolab)}, on ${machine}, in ${checkout.top} (${repo.url}, from ${remote}); up to ${max} job${max === 1 ? '' : 's'} at once${opts.allowAll ? ', with every permission (--allow-all)' : ''}.`);

  const live = new Map<string, Live>();
  const reports: JobReport[] = [];
  let stopped = deps.signal?.aborted ?? false;
  let setupFailures = 0;
  let lastSetupFailure = '';
  let heldOff = false;
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

  /**
   * Stops a job's harness: SIGTERM to its process group, then SIGKILL if it hasn't exited (a timer
   * that holds the runner open until it has). A harness that has exited already, though its output
   * may not have closed yet, ended by itself: its exit, not this stop, says how its job ended.
   */
  const stop = (l: Live, why: 'stopped' | 'refused' | 'unreachable') => {
    const child = l.child;
    if (l.finished || (child && (child.exitCode !== null || child.signalCode !== null))) return;
    if (why === 'stopped') l.stopping = true; else l.lost ??= why;
    if (!child) return;
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    kill('SIGTERM');
    l.kill ??= setTimeout(() => { if (!l.finished) kill('SIGKILL'); }, KILL_AFTER_MS);
  };
  const stopAll = () => {
    stopped = true;
    for (const l of live.values()) stop(l, 'stopped');
    wake();
  };
  deps.signal?.addEventListener('abort', stopAll, { once: true });
  deps.pushed?.(() => wake());

  /**
   * Ends a job in Kolab, saying how, and returns how the ledger has it (submitted, reviewed,
   * released, stopped…). One Kolab already ended (its agent released its package, say, or Kolab
   * refused to renew it) is only reported.
   */
  const end = async (l: Live, outcome: 'done' | 'failed' | 'stopped', note: string): Promise<string | undefined> => {
    if (l.lost === 'refused') return l.endedAs;
    try {
      const r = await deps.call('end_job', { job: l.taken.job, outcome, ...(note ? { note: redacted(note, l.taken.token).slice(-NOTE_TAIL) } : {}) }) as { outcome?: string };
      return typeof r?.outcome === 'string' ? clean(r.outcome) : undefined;
    } catch (e) {
      const msg = clean((e as Error).message);
      const already = /\bended \(([a-z_]+)\)/.exec(msg);
      if (e instanceof ToolRefusal && already) { log(`job ${clean(l.taken.job)}: Kolab had ended it already (${already[1]})`); return already[1]; }
      log(`job ${clean(l.taken.job)}: konjir_end_job failed (${msg}); its lease lapses by itself.`);
      return undefined;
    }
  };

  /** The heartbeat, from the moment a job is taken: a refusal stops its harness; Kolab out of reach is tried again until the lease is nearly gone. */
  const heartbeat = (l: Live) => {
    const job = l.taken.job;
    let deadline = Date.now() + leaseLeft(l.taken.lease_until, l.taken.now);
    let retries = 0;
    const arm = (ms: number) => {
      if (l.finished || l.lost) return;
      l.beat = setTimeout(beat, ms);
      l.beat.unref();
    };
    const beat = async () => {
      if (l.finished || l.lost) return;
      try {
        const r = await deps.call('renew_job', { job }) as { lease_until: string; now?: string };
        if (l.finished) return;
        const left = leaseLeft(r.lease_until, r.now);
        deadline = Date.now() + left;
        retries = 0;
        arm(deps.heartbeatMs ?? heartbeatEvery(left));
      } catch (e) {
        if (l.finished) return;
        const msg = clean((e as Error).message);
        if (e instanceof ToolRefusal) {
          l.endedAs = /\bended \(([a-z_]+)\)/.exec(msg)?.[1] ?? (/\blease lapsed\b/.test(msg) ? 'lapsed' : undefined);
          log(`job ${clean(job)}: Kolab ended it (${msg}); stopping its harness.`);
          stop(l, 'refused');
          return;
        }
        const left = deadline - Date.now();
        if (!(left > LEASE_FLOOR_MS)) {
          log(`job ${clean(job)}: Kolab couldn't be reached to renew it (${msg}), and its lease is all but gone; stopping its harness.`);
          stop(l, 'unreachable');
          return;
        }
        retries++;
        arm(Math.max(100, Math.min(left / 4, deps.heartbeatMs ?? 2000 * 2 ** (retries - 1), 30_000)));
      }
    };
    arm(deps.heartbeatMs ?? heartbeatEvery(deadline - Date.now()));
  };

  /**
   * Keeps a worktree with commits that no remote branch has, among every commit its HEAD has been at
   * (its own reflog, which a branch it made and left still shows; not --all, which would count the
   * person's own branches in the checkout), or with changes not committed; removes the rest.
   */
  const tidy = async (worktree: string): Promise<string | undefined> => {
    if (!existsSync(worktree)) return undefined;
    try {
      const been = [...new Set((await shell(worktree, ['log', '-g', '--format=%H', 'HEAD', '--'])).split('\n').map((x) => x.trim()).filter((x) => /^[0-9a-f]{40,64}$/.test(x)))].slice(0, 1000);
      const unpushed = been.length ? (await shell(worktree, ['rev-list', '--count', ...been, '--not', '--remotes', '--'])).trim() : '0';
      const dirty = (await shell(worktree, ['status', '--porcelain'])).trim();
      if (unpushed !== '0' || dirty) return unpushed !== '0' ? `${unpushed} commit(s) not pushed` : 'changes not committed';
      await inTurn(() => shell(checkout.top, ['worktree', 'remove', '--force', worktree]));
      return undefined;
    } catch (e) {
      return `couldn't check or remove it (${clean((e as Error).message)})`;
    }
  };

  /** A job that couldn't start: counted, and the runner backs off before taking again. */
  const setupFailed = (why: string) => {
    setupFailures++;
    lastSetupFailure = why;
    heldOff = true;
  };

  /** Runs one taken job: its heartbeat at once, then its worktree, its harness, its end and its tidying. */
  const run = (taken: TakenJob) => {
    const l: Live = { taken, stopping: stopped, finished: false, tail: '', done: Promise.resolve(undefined as never) };
    live.set(taken.job, l);
    heartbeat(l);
    l.done = (async (): Promise<JobReport> => {
      const report: JobReport = { job: taken.job, kind: taken.kind, item: taken.item, agent: taken.agent, outcome: 'failed' };
      let started = false;
      try {
        if (!JOB_ID.test(taken.job)) throw new Error(`Kolab gave the job id ${JSON.stringify(clean(taken.job).slice(0, 140))}, which konjir work won't make a directory of`);
        const worktree = join(jobsDir, taken.job);
        const { base, branch } = await round;
        if (l.stopping || l.lost) { report.outcome = 'stopped'; report.ledger = await end(l, 'stopped', 'stopped before it started'); return report; }
        await inTurn(() => shell(checkout.top, ['worktree', 'add', '--detach', '--quiet', worktree, base]));
        report.worktree = worktree;
        const h = harnessCommand(taken, { url: opts.url, allowAll: opts.allowAll, harness, worktree, branch, env,
          credentials: join(jobsDir, '.no-credentials', taken.job, 'credentials.json') });
        log(`job ${taken.job}: ${clean(taken.kind)} ${clean(taken.item)} as ${clean(taken.agent)}, in ${worktree}`);
        const out = createWriteStream(join(jobsDir, `${taken.job}.log`), { flags: 'a', mode: 0o600 });
        let outFailed = false;
        out.on('error', (e) => { if (!outFailed) log(`job ${taken.job}: its log can't be written (${clean(e.message)}); its output is still kept for its note`); outFailed = true; });
        const redactor = new Redactor(taken.token);
        const keep = (text: string) => { if (!outFailed) out.write(text); l.tail = (l.tail + text).slice(-NOTE_TAIL * 2); };
        const child = spawn(h.command, h.args, { cwd: worktree, env: h.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        l.child = child;
        child.once('spawn', () => { started = true; setupFailures = 0; if (child.pid) deps.processes?.add(child.pid); });
        child.stdout!.on('data', (b: Buffer) => keep(redactor.push(b)));
        child.stderr!.on('data', (b: Buffer) => keep(redactor.push(b)));
        child.stdin!.on('error', () => undefined);
        child.stdin!.end(h.prompt);
        if (l.stopping) stop(l, 'stopped');
        const exit = await new Promise<number | null>((resolve) => {
          child.on('error', (e) => { keep(`\n${h.command}: ${e.message}`); resolve(null); });
          child.on('close', (code) => resolve(code));
        });
        // How it ended is fixed here: a renewal answered late changes nothing.
        l.finished = true;
        clearTimeout(l.beat);
        clearTimeout(l.kill);
        if (child.pid) deps.processes?.delete(child.pid);
        keep(redactor.end());
        await new Promise<void>((r) => out.end(r));
        report.exit = exit;
        report.outcome = l.lost ? 'lost' : l.stopping ? 'stopped' : exit === 0 ? 'done' : 'failed';
        if (!started) setupFailed(`${h.command} didn't start`);
        report.ledger = await end(l, report.outcome === 'lost' ? 'failed' : report.outcome, l.lost ? `konjir work stopped it: Kolab ${l.lost === 'refused' ? 'ended it' : 'couldn\'t be reached to renew it'}\n${l.tail.trim()}` : l.tail.trim());
      } catch (e) {
        l.finished = true;
        clearTimeout(l.beat);
        const msg = clean((e as Error).message);
        report.outcome = l.stopping ? 'stopped' : 'failed';
        if (!l.stopping) setupFailed(msg);
        report.ledger = await end(l, report.outcome, `konjir work couldn't start it: ${msg}`);
        log(`job ${clean(taken.job)}: couldn't start it: ${msg}`);
      }
      const kept = report.worktree ? await tidy(report.worktree) : undefined;
      if (kept) report.kept = kept;
      if (report.ledger === undefined) delete report.ledger;
      log(`job ${clean(taken.job)}: ${report.outcome}${report.ledger ? ` (Kolab: ${report.ledger})` : ''}${report.exit !== undefined && report.exit !== null ? ` (exit ${report.exit})` : ''}${kept ? `; kept ${report.worktree}: ${kept}` : ''}`);
      return report;
    })().finally(() => { live.delete(taken.job); wake(); });
    l.done.then((r) => reports.push(r));
  };

  let wait = deps.pollFirstMs ?? POLL_FIRST_MS;
  const longest = deps.pollLongestMs ?? POLL_LONGEST_MS;
  let first = true;
  let failure: Error | undefined;
  try {
    for (;;) {
      if (stopped) break;
      if (setupFailures >= SETUP_FAILURES) {
        failure = new Error(`konjir work stopped taking jobs: ${setupFailures} in a row couldn't start (the last: ${lastSetupFailure})`);
        log(failure.message);
        break;
      }
      // A round: take until this machine is full or Kolab has nothing for it; its jobs start from one
      // fetch, made when the first is taken (the preflight's, for the first round).
      poked = false;
      let took = 0;
      let why: string | undefined;
      let unreachable = false;
      let fetched = first;
      first = false;
      while (!stopped && !heldOff && live.size < max) {
        let r: Take;
        try {
          r = await deps.call('take_job', { machine }) as Take;
        } catch (e) {
          // Kolab out of reach (or refusing) is waited out, never the end of the jobs already running.
          why = `couldn't take a job (${clean((e as Error).message)})`;
          unreachable = true;
          break;
        }
        if (!r.taken) {
          const caps = r.caps ? ` (your jobs ${r.caps.person.live}/${r.caps.person.max}, the kolab's ${r.caps.kolab.live}/${r.caps.kolab.max})` : '';
          why = `${clean(r.why)}${caps}`;
          break;
        }
        if (!fetched) { round = fetchBase(); round.catch(() => undefined); fetched = true; }
        took++;
        run(r);
      }
      if (opts.once) {
        if (!took && why) log(`nothing taken: ${why}`);
        if (!took && unreachable) failure = new Error(`konjir work ${why}`);
        break;
      }
      // Full: wait for a job to end. Otherwise wait, from the first wait again if this round took
      // anything, doubling while rounds take nothing; a job ending or the inbox changing wakes it sooner.
      if (live.size >= max && !heldOff) { await woken(); continue; }
      if (took && !heldOff) wait = deps.pollFirstMs ?? POLL_FIRST_MS;
      else log(`waiting ${wait / 1000} s: ${heldOff ? `a job couldn't start (${lastSetupFailure})` : why ?? 'nothing ready'}`);
      const backingOff = !took || heldOff;
      await woken(wait);
      poked = false;
      heldOff = false;
      if (backingOff) wait = Math.min(longest, wait * 2);
    }
    await Promise.all([...live.values()].map((l) => l.done));
  } finally {
    // However the runner leaves, no harness outlives it with its job still live.
    if (live.size) {
      stopAll();
      await Promise.allSettled([...live.values()].map((l) => l.done));
    }
    deps.signal?.removeEventListener('abort', stopAll);
  }
  // Let each report's push run before returning.
  await Promise.resolve();
  if (failure) throw Object.assign(failure, { reports });
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
  if (!Number.isFinite(s)) return clean(since);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

/** `konjir status` for a person to read, every string from Kolab cleaned of control characters. */
export function formatStatus(s: Awaited<ReturnType<typeof workStatus>>, now = Date.now()): string {
  const room = (c: { live: number; max: number }) => `${Number(c.live)} of ${Number(c.max)} live, room for ${Math.max(0, c.max - c.live)}`;
  const lines = [
    `Queue:  ${Object.entries(s.queue).map(([k, n]) => `${Number(n)} to ${clean(k)}`).join(', ') || 'empty'}`,
    `Room:   yours ${room(s.caps.person)}; the kolab's ${room(s.caps.kolab)}`,
  ];
  if (!s.jobs.length) return [...lines, 'Jobs:   none live'].join('\n');
  const rows = [['PERSON', 'MACHINE', 'AGENT', 'KIND', 'ITEM', 'SINCE'],
    ...s.jobs.map((j) => [...[j.person, j.machine, j.agent, j.kind, j.item].map(clean), ago(j.started_at, now)])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return [...lines, 'Jobs:', ...rows.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')}`)].join('\n');
}
