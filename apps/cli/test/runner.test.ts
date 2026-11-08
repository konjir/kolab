// konjir work and konjir status (W5.4b; JOB4, JOB5, D103), against real git checkouts, a stand-in
// harness and a fake of W5.4a's job tools: a person's machine, in a checkout of the registered
// repository, runs two jobs at once, each in its own worktree at the default branch's head (fetched
// once a round) outside the checkout, with the job's token in the harness's environment alone,
// which is an allowlist, and redacted from its log and note; it heartbeats each from the moment it
// is taken, ends each as its harness exits, keeps a worktree with commits not pushed (on a branch
// it left, too) and removes the rest; it waits with backoff while nothing is ready or Kolab can't be
// reached, and stops after three jobs in a row can't start; only Kolab refusing a renewal stops a
// job's harness; and a stop (Ctrl-C) stops every harness and ends its job as stopped. An agent's
// session, a checkout that isn't the repository, a fork with --repo and no remote at the registered
// URL, and a harness not on PATH are refused before anything is taken. Inside a job, konjir never
// falls back to a sign-in kept on the machine.
import { afterEach, expect, jest, test } from '@jest/globals';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_TOOLS, Redactor, workOptions, removeKonjirShim, guardSettings, TOKEN_KINDS, ToolRefusal, call, connect, deniedTools, feedOnce, formatStatus, gitIn, harnessCommand, harnessEnv, heartbeatEvery, jobNote, konjirCommand, leaseLeft, main, markerText, runWork, sweepJobs, thisMachine, workStatus, writeKonjirShim, type JobReport, type TakenJob } from '../src/cli.js';
import { startServer } from '@konjir/server';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';

const env = { ...process.env };
// Every runner a test starts is stopped at its end, passed or failed, so no stand-in outlives it.
const stops: AbortController[] = [];
const stopper = () => { const s = new AbortController(); stops.push(s); return s; };
afterEach(() => { for (const s of stops.splice(0)) s.abort(); jest.restoreAllMocks(); process.env = { ...env }; });

/** Git that reads no one's own settings, with a fixed author. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Eng', GIT_AUTHOR_EMAIL: 'eng@example.com',
  GIT_COMMITTER_NAME: 'Eng', GIT_COMMITTER_EMAIL: 'eng@example.com', GIT_CEILING_DIRECTORIES: tmpdir(),
};
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
const URL_ = 'https://github.com/acme/orders';
const MCP = 'http://127.0.0.1:7420/mcp';

/**
 * A bare repository standing in for github.com/acme/orders, and a clone of it whose origin is that
 * URL (or, with `fork`, a fork's, the registered URL its `upstream`); the runner's git reaches the
 * bare one through url.<bare>.insteadOf, so nothing leaves this machine. Returns the clone, the root
 * commit, main's head as fetched, the runner's git (counting its fetches) and a jobs directory.
 */
function repository(opts: { fork?: boolean; failWorktrees?: boolean } = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'konjir-runner-')));
  const bare = join(top, 'orders.git');
  git(top, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(top, 'seed');
  git(top, 'clone', '-q', bare, seed);
  writeFileSync(join(seed, 'README.md'), '# Orders\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'Start');
  const root = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', 'origin', 'main');
  const dir = join(top, 'checkout');
  git(top, 'clone', '-q', bare, dir);
  if (opts.fork) {
    git(dir, 'remote', 'set-url', 'origin', 'https://github.com/fork/orders.git');
    git(dir, 'remote', 'add', 'upstream', `${URL_}.git`);
  } else {
    git(dir, 'remote', 'set-url', 'origin', `${URL_}.git`);
  }
  // main moves on after the clone: a job starts at the head fetched, not the checkout's.
  writeFileSync(join(seed, 'more.ts'), 'export const more = 1;\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'More');
  git(seed, 'push', '-q', 'origin', 'main');
  const fetched = git(seed, 'rev-parse', 'HEAD');
  const fetches: string[] = [];
  const shell = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => {
    if (args[0] === 'fetch') fetches.push(args.join(' '));
    if (opts.failWorktrees && args[0] === 'worktree' && args[1] === 'add') return reject(new Error('git worktree add: no room'));
    execFile('git', ['-c', `url.${bare}.insteadOf=${URL_}.git`, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
      (e, out, err) => (e ? reject(new Error(`git ${args.join(' ')}: ${err}`)) : resolve(out)));
  });
  return { top, dir, root, fetched, shell, fetches, jobsDir: join(top, 'jobs') };
}

/**
 * The stand-in harness: it records what it was given (its directory, arguments, environment and
 * prompt) in <its dir>/<job>.json, then does what modes.json says for its job: `wait` (until
 * <job>.go appears, or SIGTERM, when it writes <job>.stopped and exits 143), `commit` (commits a
 * file and exits 0), `deliver` (commits with its trailer, runs konjir from PATH to deliver and submit
 * it and its guard hook on a delete, records what they said in <job>.konjir.json, and exits 0), `branch` (commits on a branch of its own, goes back to where it started and
 * exits 0), `leak` (prints its token, split across two writes, and exits 0) or `fail` (prints boom
 * and exits 3). It reads nothing from the environment but what a harness is given.
 */
function standIn(top: string, modes: Record<string, string> = {}) {
  const dir = join(top, 'standin');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'harness.mjs');
  writeFileSync(join(dir, 'modes.json'), JSON.stringify(modes));
  writeFileSync(path, `#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const job = process.env.KONJIR_JOB;
const out = (name) => here + '/' + job + name;
// As Claude Code starts: it reads its MCP config, once, from the path it is given.
const mcpPath = process.argv[process.argv.indexOf('--mcp-config') + 1];
const mcpWasFifo = statSync(mcpPath).isFIFO();
const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
const token = mcp.mcpServers.konjir.headers.Authorization.replace(/^Bearer /, '');
// As a command the agent runs (its tests, say) sees things: a child with the harness's environment,
// and every file under the jobs directory, once the config's FIFO is gone.
const childEnv = execFileSync('env', { encoding: 'utf8' });
for (let i = 0; i < 200 && existsSync(mcpPath); i++) await new Promise((r) => setTimeout(r, 10));
const mcpGone = !existsSync(mcpPath);
const filesWithToken = [];
const scan = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = lstatSync(p); if (s.isDirectory()) scan(p); else if (s.isFile() && readFileSync(p, 'latin1').includes(token)) filesWithToken.push(p); } };
scan(dirname(dirname(mcpPath)));
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  // All at once: a test takes the file's being there to mean it can be read.
  writeFileSync(out('.tmp'), JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), env: process.env, prompt, mcp, mcpWasFifo, mcpGone, tokenInChildEnv: childEnv.includes(token), filesWithToken }));
  renameSync(out('.tmp'), out('.json'));
  const modes = JSON.parse(readFileSync(here + '/modes.json', 'utf8'));
  const mode = modes[job] || modes['*'] || 'wait';
  console.log('working on ' + process.env.KONJIR_ITEM);
  const commit = (name) => { writeFileSync(name, name + '\\n'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-q', '-m', name]); };
  if (mode === 'fail') { console.error('boom'); process.exit(3); }
  if (mode === 'commit') { commit('cancel.ts'); process.exit(0); }
  if (mode === 'deliver') {
    // As a build job's agent delivers (W7.8): a commit with its trailer, then konjir, as found on
    // PATH, delivering and submitting it; and the guard hook, as its --settings run it.
    const trailer = /--trailer "([^"]+)"/.exec(prompt)[1];
    writeFileSync('cancel.ts', 'export const cancel = 1;\\n');
    execFileSync('git', ['add', '-A']);
    execFileSync('git', ['commit', '-q', '-m', 'Cancel', '--trailer', trailer]);
    const run = (args, input) => { const r = spawnSync('konjir', args, { input, encoding: 'utf8' }); return { status: r.status, out: r.stdout + r.stderr, error: r.error && r.error.message }; };
    const hook = JSON.parse(process.argv[process.argv.indexOf('--settings') + 1]).hooks.PreToolUse[0].hooks[0].command;
    const guarded = spawnSync('sh', ['-c', hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin :main' } }), encoding: 'utf8' });
    writeFileSync(out('.konjir.json'), JSON.stringify({ found: execFileSync('sh', ['-c', 'command -v konjir'], { encoding: 'utf8' }).trim(),
      deliver: run(['work', 'deliver', process.env.KONJIR_ITEM, '--submit', '--test', 'stand-in: 1 passed']), hook, guard: { status: guarded.status, out: guarded.stderr } }));
    process.exit(0);
  }
  if (mode === 'branch') {
    const start = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', '-q', '-c', 'side']);
    commit('side.ts');
    execFileSync('git', ['switch', '-q', '--detach', start]);
    process.exit(0);
  }
  if (mode === 'leak') {
    const t = token;
    process.stdout.write('token ' + t.slice(0, 5));
    await new Promise((r) => setTimeout(r, 50));
    process.stdout.write(t.slice(5) + ' and again ' + t + '\\n');
    process.exit(0);
  }
  process.on('SIGTERM', () => { writeFileSync(out('.stopped'), 'yes'); process.exit(143); });
  const t = setInterval(() => { if (existsSync(out('.go'))) { clearInterval(t); process.exit(0); } }, 20);
});
`);
  chmodSync(path, 0o755);
  return { path, dir, go: (job: string) => writeFileSync(join(dir, `${job}.go`), ''), started: (job: string) => existsSync(join(dir, `${job}.json`)),
    seen: (job: string) => JSON.parse(readFileSync(join(dir, `${job}.json`), 'utf8')) as { cwd: string; argv: string[]; env: Record<string, string>; prompt: string;
      mcp: unknown; mcpWasFifo: boolean; mcpGone: boolean; tokenInChildEnv: boolean; filesWithToken: string[] } };
}

/** A fake of W5.4a's job tools and the reads konjir work makes, for a person `lee` in kolab `test`, recording every call. */
function fakeKolab(root: string, opts: { items?: { kind: 'build' | 'review'; item: string; job?: string }[]; kind?: string; cap?: number; noKinds?: boolean } = {}) {
  const items = [...(opts.items ?? [])];
  const calls: [string, Record<string, unknown>][] = [];
  const jobs = new Map<string, TakenJob & { ended?: { outcome: string; note?: string }; machine: string }>();
  const lost = new Set<string>();
  const state = { takeThrows: false, renewThrows: 0, slowRefuse: new Set<string>() };
  // Jobs whose renewals Kolab answers only once their runner has ended them, each with what lets them go.
  const held = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  // As Kolab refuses to renew or end a job it ended already (its agent released its package, say).
  const endedAlready = (j: { job: string; ended?: { outcome: string } }) =>
    new ToolRefusal(`GateError: job ${j.job} ended (${j.ended!.outcome}) at 2026-10-29T12:00:00.000Z: take another (konjir_take_job)`);
  let n = 0;
  const cap = opts.cap ?? 4;
  const liveCount = () => [...jobs.values()].filter((j) => !j.ended && !lost.has(j.job)).length;
  const caps = () => ({ person: { live: liveCount(), max: cap }, kolab: { live: liveCount(), max: 8 } });
  const call = async (verb: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push([verb, args]);
    switch (verb) {
      case 'whoami': return { kind: opts.kind ?? 'person', actor: opts.kind === 'agent' ? 'lee-bot' : 'lee', kolab: 'test' };
      case 'list_repositories': return { repositories: [{ id: 'r1', url: URL_, root_sha: root, binding: null, confirmed: true }], next: null };
      case 'take_job': {
        // A transport failure, not a refusal: what an unreachable Kolab looks like.
        if (state.takeThrows) throw new Error('fetch failed');
        // A Kolab from before W5.11 refuses kinds, as its strict arguments refuse any it doesn't know.
        if (opts.noKinds && 'kinds' in args) throw new ToolRefusal('unknown argument kinds: it takes machine');
        if (liveCount() >= cap) return { taken: false, why: 'you have 4 live jobs, your most', counts: {}, caps: caps() };
        const it = items.shift();
        if (!it) return { taken: false, why: 'nothing is ready', counts: { review: 0, build: 0 }, caps: caps() };
        const job = it.job ?? `J${++n}`;
        const j = { job, kind: it.kind, item: it.item, agent: `lee-engineer-${n}`, token: `kjs_job_token_${job}`, lease_until: new Date(Date.now() + 30 * 60_000).toISOString(),
          instructions: `Do ${it.item}.`, trailer: `Konjir-Work: ${it.item}`, machine: String(args.machine) };
        jobs.set(job, j);
        return { taken: true, ...j };
      }
      case 'renew_job': {
        await gates.get(String(args.job));
        const j = jobs.get(String(args.job));
        if (state.renewThrows > 0) { state.renewThrows--; throw new Error('fetch failed'); }
        if (j && state.slowRefuse.has(j.job)) { await new Promise((r) => setTimeout(r, 300)); throw new ToolRefusal(`job ${args.job} is over`); }
        if (j?.ended) throw endedAlready(j);
        if (!j || lost.has(j.job)) throw new ToolRefusal(`job ${args.job} is over`);
        return { job: j.job, lease_until: new Date(Date.now() + 30 * 60_000).toISOString() };
      }
      case 'end_job': {
        held.get(String(args.job))?.();
        const j = jobs.get(String(args.job));
        if (j?.ended) throw endedAlready(j);
        if (!j || lost.has(j.job)) throw new ToolRefusal(`job ${args.job} is over`);
        j.ended = { outcome: String(args.outcome), ...(args.note ? { note: String(args.note) } : {}) };
        return { job: j.job, ended: true, outcome: args.outcome === 'done' ? 'submitted' : 'released' };
      }
      default: throw new Error(`the fake has no ${verb}`);
    }
  };
  return { call, calls, jobs, items, state, lose: (job: string) => lost.add(job),
    /** Kolab ends a job itself, as when its agent releases its package: the runner's end_job is then refused. */
    release: (job: string) => { jobs.get(job)!.ended = { outcome: 'released' }; },
    /** From now on, Kolab answers `job`'s renewals only once its runner has called end_job for it. */
    hold: (job: string) => { gates.set(job, new Promise<void>((r) => held.set(job, r))); } };
}

/** Waits until `ok()` holds, polling. */
async function until(ok: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const quiet = () => { const lines: string[] = []; return { lines, log: (l: string) => { lines.push(l); } }; };
const ended = (k: ReturnType<typeof fakeKolab>, job: string) => k.jobs.get(job)?.ended;

test('done-when: two jobs at once, each in its own worktree at the default branch\'s head outside the checkout, from one fetch; the token only in an allowlisted environment; each ended as it exits; a worktree with commits not pushed kept, the other removed (JOB4)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV, AWS_SECRET_ACCESS_KEY: 'aws-secret', KONJIR_ADMIN_TOKEN: 'admin-secret', KONJIR_DATABASE_URL: 'postgres://x', XDG_CONFIG_HOME: '/somewhere', GH_TOKEN: 'gh-token' };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root, { items: [{ kind: 'build', item: 'kj:test/orders-plan#W1' }, { kind: 'review', item: 'kj:test/orders-plan#W2' }] });
  const out = quiet();
  const stop = stopper();
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, heartbeatMs: 50, signal: stop.signal },
    { jobs: 4, machine: 'lee-laptop', harness: h.path, url: MCP });
  // Both running at once: each has started, and neither has been let go.
  await until(() => h.started('J1') && h.started('J2'));
  const j1 = h.seen('J1');
  const j2 = h.seen('J2');
  expect(j1.cwd).not.toBe(j2.cwd);
  for (const [s, job] of [[j1, 'J1'], [j2, 'J2']] as const) {
    expect(s.cwd).toBe(join(r.jobsDir, job));
    expect(s.cwd.startsWith(r.dir)).toBe(false);
    expect(git(s.cwd, 'rev-parse', 'HEAD')).toBe(r.fetched);
    expect(s.env).toMatchObject({ KONJIR_URL: MCP, KONJIR_JOB: job, GH_TOKEN: 'gh-token' });
    // The environment is an allowlist: no cloud credentials, no Kolab admin token or database, no XDG_CONFIG_HOME;
    // konjir's credentials point at a file that doesn't exist.
    for (const k of ['AWS_SECRET_ACCESS_KEY', 'KONJIR_ADMIN_TOKEN', 'KONJIR_DATABASE_URL', 'XDG_CONFIG_HOME']) expect(s.env[k]).toBeUndefined();
    expect(s.env.KONJIR_CREDENTIALS.startsWith(r.jobsDir)).toBe(true);
    expect(existsSync(s.env.KONJIR_CREDENTIALS)).toBe(false);
    // The token is in no argument and no file: the MCP config comes through a FIFO, read once and then removed (W6.4).
    expect(s.argv.join(' ')).not.toContain('kjs_job_token');
    expect(s.argv[s.argv.indexOf('--mcp-config') + 1]).toBe(join(r.jobsDir, '.mcp', `${job}.json`));
    expect(s.mcpWasFifo).toBe(true);
    expect(s.mcp).toEqual({ mcpServers: { konjir: { type: 'http', url: MCP, headers: { Authorization: `Bearer kjs_job_token_${job}` } } } });
    expect(s.mcpGone).toBe(true);
    expect(s.filesWithToken).toEqual([]);
    expect(s.argv).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--permission-mode', 'acceptEdits', 'Bash(git push *:main)', '--settings']));
  }
  // A build job's commands get its token, for konjir work deliver; a review job's, its tests among them, find none in their environment (W6.4).
  expect(j1.env.KONJIR_TOKEN).toBe('kjs_job_token_J1');
  expect(j1.tokenInChildEnv).toBe(true);
  expect(j2.env.KONJIR_TOKEN).toBeUndefined();
  expect(j2.tokenInChildEnv).toBe(false);
  expect(JSON.stringify(j2.env)).not.toContain('kjs_job_token');
  expect(readdirSync(join(r.jobsDir, '.mcp'))).toEqual([]);
  expect(j1.prompt).toContain('Do kj:test/orders-plan#W1.');
  expect(j1.prompt).toContain('Konjir-Work: kj:test/orders-plan#W1');
  expect(kolab.calls.filter(([v]) => v === 'take_job').map(([, a]) => a)).toEqual(Array(3).fill({ machine: 'lee-laptop', kinds: ['build', 'review', 'answer', 'mark', 'serve'] }));
  // One fetch, the preflight's, serves the first round's two jobs.
  expect(r.fetches).toEqual(['fetch --quiet origin']);
  // Heartbeats while they run.
  await until(() => kolab.calls.filter(([v, a]) => v === 'renew_job' && a.job === 'J1').length >= 2 && kolab.calls.filter(([v, a]) => v === 'renew_job' && a.job === 'J2').length >= 2);
  expect(ended(kolab, 'J1')).toBeUndefined();
  // J1 commits in its worktree and exits; J2 is let go and exits with nothing to keep.
  writeFileSync(join(j1.cwd, 'cancel.ts'), 'export const cancel = 1;\n');
  git(j1.cwd, 'add', '-A');
  git(j1.cwd, 'commit', '-q', '-m', 'Cancel');
  h.go('J1');
  await until(() => !!ended(kolab, 'J1'));
  expect(ended(kolab, 'J2')).toBeUndefined();
  // J2's agent gives its package back, which ends its job in Kolab, and then exits. Its exit, not a
  // renewal refused meanwhile, is what the runner sees first (the other order is the next test's).
  kolab.hold('J2');
  kolab.release('J2');
  h.go('J2');
  await until(() => ['J1', 'J2'].every((j) => out.lines.some((l) => l.startsWith(`job ${j}: done`))));
  stop.abort();
  const reports = await running;
  expect(reports.sort((a, b) => a.job.localeCompare(b.job))).toEqual([
    expect.objectContaining({ job: 'J1', outcome: 'done', ledger: 'submitted', exit: 0, kept: '1 commit(s) not pushed', worktree: j1.cwd }),
    expect.objectContaining({ job: 'J2', outcome: 'done', ledger: 'released', exit: 0, worktree: j2.cwd }),
  ]);
  expect(reports[1].kept).toBeUndefined();
  expect(ended(kolab, 'J1')).toEqual({ outcome: 'done', note: 'working on kj:test/orders-plan#W1' });
  expect(ended(kolab, 'J2')).toEqual({ outcome: 'released' });
  expect(out.lines).toContain('job J2: Kolab had ended it already (released)');
  expect(existsSync(j1.cwd)).toBe(true);
  expect(existsSync(j2.cwd)).toBe(false);
  expect(git(r.dir, 'worktree', 'list')).not.toContain(j2.cwd);
  expect(out.lines.join('\n')).not.toContain('kjs_job_token');
}, 60_000);

test('konjir work reads --once and --jobs from its command line, in either order, and leaves what it doesn\'t know (W7.5)', () => {
  expect(workOptions(['--once', '--jobs', '4'])).toMatchObject({ once: true, jobs: 4 });
  expect(workOptions(['--jobs', '4', '--once'])).toMatchObject({ once: true, jobs: 4 });
  expect(workOptions([])).toMatchObject({ once: false });
  const rest = ['--once', '--twice'];
  workOptions(rest);
  expect(rest).toStrictEqual(['--twice']);
});

test('--once takes one job whatever --jobs says, waits for it to end and returns, leaving the rest ready (W7.5)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root, { items: [1, 2, 3, 4, 5].map((n) => ({ kind: 'build' as const, item: `kj:test/p#W${n}` })) });
  const out = quiet();
  let returned = false;
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, heartbeatMs: 50, pollFirstMs: 20, pollLongestMs: 40, signal: stopper().signal },
    { once: true, jobs: 8, machine: 'lee-laptop', harness: h.path, url: MCP }).finally(() => { returned = true; });
  await until(() => h.started('J1'));
  // It runs alone, for as long as it takes: heartbeats go by, and nothing more is taken.
  await until(() => kolab.calls.filter(([v]) => v === 'renew_job').length >= 3);
  expect(returned).toBe(false);
  expect(kolab.calls.filter(([v]) => v === 'take_job')).toHaveLength(1);
  h.go('J1');
  expect(await running).toEqual([expect.objectContaining({ job: 'J1', outcome: 'done', ledger: 'submitted' })]);
  expect(kolab.calls.filter(([v]) => v === 'take_job')).toHaveLength(1);
  expect(kolab.items).toHaveLength(4);
  expect(out.lines[0]).toMatch(/; one job, then it exits \(--once\)\.$/);
  // A bad --jobs is refused all the same.
  expect(await rejection(runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stopper().signal }, { once: true, jobs: 0, harness: h.path, url: MCP }))).toMatch(/--jobs is a whole number/);
}, 60_000);

test('--once with a Kolab that can\'t be reached at the take fails, and takes nothing (W7.5)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root, { items: [{ kind: 'build', item: 'kj:test/p#W1' }] });
  kolab.state.takeThrows = true;
  const out = quiet();
  expect(await rejection(runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stopper().signal }, { once: true, harness: h.path, url: MCP }))).toMatch(/couldn't take a job \(fetch failed\)/);
  expect(kolab.items).toHaveLength(1);
}, 60_000);

test('done-when: konjir work --once against a real Kolab: with nothing to take it says why and exits; with four free slots and three items ready it starts one job, waits for it and exits (W7.5)', async () => {
  const r = repository();
  const h = standIn(r.top);
  const kolab = await openKolab();
  const server = await startServer({ adminToken: 'test-admin-token', kolab });
  const admin = await connect(server.url, 'test-admin-token');
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const person = async (id: string, role: 'product' | 'engineer', grant: Record<string, unknown>) => {
    await call(admin, 'admin_add_actor', { id });
    await call(admin, 'admin_grant', { kolab: 'test', to: id, ...grant });
    const { token } = await call(admin, 'admin_open_session', { actor: id, role }) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return { c, token };
  };
  const pm = await person('pm', 'product', { level: 'write', layers: ['functional'] });
  await call(pm.c, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await call(pm.c, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] });
  await call(pm.c, 'submit_for_review', { node: 'orders', version: 1 });
  // Added after the spec committed, so it needed no review.
  const lead = await person('lead', 'engineer', { level: 'maintain' });
  await call(lead.c, 'create_node', { kind: 'binding', title: 'On Postgres', id: 'orders-pg' });
  await call(lead.c, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' }], links: [{ source_element: 'b1', target: 'kj:orders@1#R1' }] });
  await call(lead.c, 'submit_for_review', { node: 'orders-pg', version: 1 });
  await call(lead.c, 'register_repository', { url: URL_, root_sha: r.root, binding: 'orders-pg' });

  process.env = { ...process.env, ...GIT_ENV };
  const out = quiet();
  const work = () => runWork({ call: (verb, args) => call(lead.c, verb, args), git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stopper().signal },
    { once: true, jobs: 4, machine: 'lead-laptop', harness: h.path, url: server.url });
  const live = async () => (await call(lead.c, 'list_jobs', { live: true }) as { jobs: { job: string; item: string; machine: string }[]; queue: { build: number } });

  expect(await work()).toEqual([]);
  expect(out.lines.some((l) => /^nothing taken: .*\(your jobs 0\/4, the kolab's 0\/8\)$/.test(l))).toBe(true);
  expect((await live()).jobs).toEqual([]);

  await call(lead.c, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' },
    ...[1, 2, 3].map((n) => ({ id: `W${n}`, text: `Build part ${n}.`, work: {} }))], links: [1, 2, 3].map((n) => ({ source_element: `W${n}`, target: 'kj:orders-pg@1#b1' })) });
  await call(lead.c, 'submit_for_review', { node: 'orders-pg', version: 2 });
  let returned = false;
  const running = work().finally(() => { returned = true; });
  await until(() => readdirSync(h.dir).some((f) => /^(?!modes).*\.json$/.test(f)));
  const job = readdirSync(h.dir).find((f) => /^(?!modes).*\.json$/.test(f))!.replace(/\.json$/, '');
  const now = await live();
  expect(now.jobs).toMatchObject([{ job, item: 'kj:orders-pg#W1', machine: 'lead-laptop' }]);
  expect(now.queue.build).toBe(2);
  expect(returned).toBe(false);
  h.go(job);
  expect(await running).toMatchObject([{ job, kind: 'build', item: 'kj:orders-pg#W1', outcome: 'done', exit: 0 }]);
  expect((await live()).jobs).toEqual([]);
}, 120_000);

test('done-when: a build job runs konjir from its PATH, the runner\'s own konjir, under Bash(konjir *): konjir work deliver --submit records its commit and submits its package; its guard hook runs it too and denies; the shim goes with the job (W7.8)', async () => {
  const r = repository();
  const h = standIn(r.top, { '*': 'deliver' });
  const kolab = await openKolab();
  const server = await startServer({ adminToken: 'test-admin-token', kolab });
  const admin = await connect(server.url, 'test-admin-token');
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const person = async (id: string, role: 'product' | 'engineer', grant: Record<string, unknown>) => {
    await call(admin, 'admin_add_actor', { id });
    await call(admin, 'admin_grant', { kolab: 'test', to: id, ...grant });
    const { token } = await call(admin, 'admin_open_session', { actor: id, role }) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return c;
  };
  const pm = await person('pm', 'product', { level: 'write', layers: ['functional'] });
  await call(pm, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 1 });
  const lead = await person('lead', 'engineer', { level: 'maintain' });
  await call(lead, 'create_node', { kind: 'binding', title: 'On Postgres', id: 'orders-pg' });
  await call(lead, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' }], links: [{ source_element: 'b1', target: 'kj:orders@1#R1' }] });
  await call(lead, 'submit_for_review', { node: 'orders-pg', version: 1 });
  await call(lead, 'register_repository', { url: URL_, root_sha: r.root, binding: 'orders-pg' });
  await call(lead, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' }, { id: 'W1', text: 'Build the cancel endpoint.', work: {} }],
    links: [{ source_element: 'W1', target: 'kj:orders-pg@1#b1' }] });
  await call(lead, 'submit_for_review', { node: 'orders-pg', version: 2 });

  process.env = { ...process.env, ...GIT_ENV };
  const out = quiet();
  // The job's konjir is the CLI as built, as an installed konjir work's would be.
  const built = [process.execPath, join(import.meta.dirname, '..', 'dist', 'main.js')];
  const reports = await runWork({ call: (verb, args) => call(lead, verb, args), git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stopper().signal, konjir: built },
    { once: true, machine: 'lead-laptop', harness: h.path, url: server.url });
  expect(reports).toMatchObject([{ kind: 'build', item: 'kj:orders-pg#W1', outcome: 'done', exit: 0 }]);
  const job = reports[0].job;
  const seen = JSON.parse(readFileSync(join(h.dir, `${job}.konjir.json`), 'utf8')) as { found: string; hook: string; deliver: { status: number; out: string }; guard: { status: number; out: string } };
  // konjir, first on the job's PATH, is a shim of its own, in the jobs directory, that runs the runner's konjir.
  const bin = join(r.jobsDir, '.bin', job);
  expect(seen.found).toBe(join(bin, 'konjir'));
  expect(h.seen(job).env.PATH.split(':')[0]).toBe(bin);
  // A command a build job's agent runs as written, which Bash(konjir *) lets it run without asking.
  expect(ALLOWED_TOOLS).toContain('Bash(konjir *)');
  expect(seen.deliver).toMatchObject({ status: 0 });
  const w = await call(lead, 'read_work', { work: 'kj:orders-pg#W1' }) as { state: string; evidence: { kind: string }[] };
  expect(w.state).toBe('in_review');
  expect(w.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(['commit']));
  // The guard hook runs the same konjir, and denies a delete.
  expect(seen.hook).toBe(`'${join(bin, 'konjir')}' 'work' 'guard' '--branch' 'main' || { echo 'Denied in a Konjir job: its guard could not check this command' >&2; exit 2; }`);
  expect(seen.guard).toMatchObject({ status: 2, out: expect.stringMatching(/^Denied in a Konjir job: the refspec :main deletes main/) });
  // The shim goes when its job ends; it never held the token.
  expect(existsSync(bin)).toBe(false);
  expect(h.seen(job).filesWithToken).toEqual([]);
}, 120_000);

test('sweepJobs removes the konjir, MCP FIFO and marker of each job no runner on this machine still runs, its modes restored first, and keeps a live runner\'s; the jobs directory then goes with rm -rf (W7.12)', async () => {
  const jobs = join(realpathSync(mkdtempSync(join(tmpdir(), 'konjir-sweep-'))), 'jobs');
  // Another runner, still running here: a process of its own.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    const leave = (job: string, pid?: number) => {
      writeKonjirShim(join(jobs, '.bin', job), ['/usr/bin/node', '/opt/konjir/main.js']);
      mkdirSync(join(jobs, '.mcp'), { recursive: true });
      execFileSync('mkfifo', ['-m', '600', join(jobs, '.mcp', `${job}.json`)]);
      if (pid !== undefined) { mkdirSync(join(jobs, '.live'), { recursive: true }); writeFileSync(join(jobs, '.live', job), markerText(pid)); }
    };
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    leave('JDEAD', Number(dead.stdout.trim()));
    leave('JNONE');
    leave('JSELF', process.pid);
    leave('JLIVE', other.pid!);
    // Only the FIFO is left of one, and only the marker of another; a name no job has is no job's.
    execFileSync('mkfifo', ['-m', '600', join(jobs, '.mcp', 'JFIFO.json')]);
    writeFileSync(join(jobs, '.live', 'JMARK'), 'not a pid\n');
    writeFileSync(join(jobs, '.live', '.hidden'), '1\n');
    // A person's rm -rf fails on a job's konjir, as it did after a killed runner (#116).
    expect(spawnSync('rm', ['-rf', join(jobs, '.bin', 'JDEAD')]).status).not.toBe(0);
    expect(existsSync(join(jobs, '.bin', 'JDEAD', 'konjir'))).toBe(true);

    // This runner's own pid is one an earlier runner had (a reboot, a container), though it is running.
    expect(sweepJobs(jobs, { alive: (pid) => pid === other.pid || pid === process.pid })).toEqual(['JDEAD', 'JFIFO', 'JMARK', 'JNONE', 'JSELF']);
    expect(readdirSync(join(jobs, '.bin'))).toEqual(['JLIVE']);
    expect(readdirSync(join(jobs, '.mcp'))).toEqual(['JLIVE.json']);
    expect(readdirSync(join(jobs, '.live')).sort()).toEqual(['.hidden', 'JLIVE']);
    // The live runner's are as it left them.
    expect(statSync(join(jobs, '.bin', 'JLIVE')).mode & 0o777).toBe(0o500);
    expect(statSync(join(jobs, '.mcp', 'JLIVE.json')).isFIFO()).toBe(true);
    // As the machine sees it: the other runner's process is running, so it keeps its job.
    expect(sweepJobs(jobs)).toEqual([]);
    // Once it has gone (and been reaped), its job is no runner's.
    await new Promise((resolve) => { other.once('exit', resolve); other.kill('SIGKILL'); });
    expect(sweepJobs(jobs)).toEqual(['JLIVE']);
    expect(spawnSync('rm', ['-rf', jobs]).status).toBe(0);
    expect(existsSync(jobs)).toBe(false);
    // Nothing there, nothing swept.
    expect(sweepJobs(jobs)).toEqual([]);
  } finally {
    other.kill('SIGKILL');
  }
});

// Everything outside a jobs directory a sweep might be pointed at through a link: its files and modes, to compare after.
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      out[p] = `${(st.mode & 0o7777).toString(8)} ${st.isDirectory() ? 'dir' : st.isFile() ? readFileSync(p, 'utf8') : 'other'}`;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
};

test('sweepJobs and removeKonjirShim never follow a link: .bin, .mcp or .live that is one, or an entry in them that is one, is left, and what it points to keeps its files and modes (W7.12)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'konjir-sweep-links-')));
  // Outside the jobs directory: what a job's agent might point a link at, as it might at a home directory.
  const outside = join(root, 'outside');
  const fill = (d: string, mode = 0o700) => {
    mkdirSync(join(d, 'JOUT'), { recursive: true });
    writeFileSync(join(d, 'JOUT', 'keep'), 'kept\n');
    writeFileSync(join(d, 'JOUT.json'), '{"kept":true}\n');
    writeFileSync(join(d, 'JFILE'), 'kept\n');
    chmodSync(join(d, 'JOUT'), 0o500);
    chmodSync(d, mode);
  };
  for (const d of ['bin', 'mcp', 'live', 'entry']) fill(join(outside, d));
  fill(join(outside, 'r500'), 0o500);
  writeFileSync(join(outside, 'file'), 'kept\n');
  const before = snapshot(outside);
  const logged: string[] = [];
  const log = (l: string) => { logged.push(l); };
  try {
    // .bin, .mcp and .live, each a link to a directory outside.
    const a = join(root, 'a', 'jobs');
    mkdirSync(a, { recursive: true });
    symlinkSync(join(outside, 'bin'), join(a, '.bin'));
    symlinkSync(join(outside, 'mcp'), join(a, '.mcp'));
    symlinkSync(join(outside, 'live'), join(a, '.live'));
    expect(sweepJobs(a, { log })).toEqual([]);
    expect(logged.filter((l) => l.includes('isn\'t a directory itself'))).toHaveLength(3);

    // .bin, .mcp and .live directories themselves, with entries that are links: to a directory of mode 500, a directory, a file.
    const b = join(root, 'b', 'jobs');
    for (const d of ['.bin', '.mcp', '.live']) mkdirSync(join(b, d), { recursive: true });
    symlinkSync(join(outside, 'r500'), join(b, '.bin', 'JLINK'));
    symlinkSync(join(outside, 'entry'), join(b, '.bin', 'JDIR'));
    symlinkSync(join(outside, 'file'), join(b, '.mcp', 'JLINK.json'));
    symlinkSync(join(outside, 'file'), join(b, '.live', 'JDIR'));
    // And a job of its own, which goes.
    writeKonjirShim(join(b, '.bin', 'JOWN'), ['/usr/bin/node']);
    expect(sweepJobs(b, { log })).toEqual(['JOWN']);
    expect(readdirSync(join(b, '.bin')).sort()).toEqual(['JDIR', 'JLINK']);
    expect(lstatSync(join(b, '.bin', 'JLINK')).isSymbolicLink()).toBe(true);
    expect(statSync(join(outside, 'r500')).mode & 0o777).toBe(0o500);

    // At a job's end: its konjir's directory a link, or the directory it is in a link.
    const c = join(root, 'c');
    mkdirSync(c);
    symlinkSync(join(outside, 'r500'), join(c, 'bin'));
    removeKonjirShim(join(c, 'bin'), log);
    expect(lstatSync(join(c, 'bin')).isSymbolicLink()).toBe(true);
    symlinkSync(join(outside, 'bin'), join(c, '.bin'));
    removeKonjirShim(join(c, '.bin', 'JOUT'), log);

    // Everything outside is as it was.
    expect(snapshot(outside)).toEqual(before);
  } finally {
    for (const d of ['bin', 'mcp', 'live', 'entry', 'r500']) { try { chmodSync(join(outside, d), 0o700); chmodSync(join(outside, d, 'JOUT'), 0o700); } catch { /* gone */ } }
  }
});

test('sweepJobs keeps a job whose marker names another machine, whose processes this one can\'t see, and sweeps one of an earlier boot of this one (W7.12)', () => {
  const jobs = join(realpathSync(mkdtempSync(join(tmpdir(), 'konjir-sweep-machine-'))), 'jobs');
  const here = { host: 'this-host', boot: 'boot-2' };
  mkdirSync(join(jobs, '.live'), { recursive: true });
  for (const job of ['JOTHER', 'JREBOOT', 'JHERE']) writeKonjirShim(join(jobs, '.bin', job), ['/usr/bin/node']);
  // A container beside this one, or another machine sharing this home: a pid this one has no running process of.
  writeFileSync(join(jobs, '.live', 'JOTHER'), markerText(4242, { host: 'other-host', boot: 'boot-2' }));
  // This machine, before it rebooted: its pid may be running again, as another process.
  writeFileSync(join(jobs, '.live', 'JREBOOT'), markerText(4242, { host: 'this-host', boot: 'boot-1' }));
  writeFileSync(join(jobs, '.live', 'JHERE'), markerText(4242, here));
  expect(sweepJobs(jobs, { machine: here, alive: () => true })).toEqual(['JREBOOT']);
  expect(sweepJobs(jobs, { machine: here, alive: () => false })).toEqual(['JHERE']);
  expect(readdirSync(join(jobs, '.bin'))).toEqual(['JOTHER']);
  // Each runner names its machine as the kernel does: its hostname and this boot's id.
  expect(thisMachine().host).toBe(hostname());
  expect(thisMachine().boot).toMatch(/^[0-9A-Fa-f-]{36}$/);
});

test('konjir work sweeps what a killed runner left before it reaches Kolab, so a Kolab out of reach leaves nothing behind (W7.12)', async () => {
  const jobs = join(realpathSync(mkdtempSync(join(tmpdir(), 'konjir-sweep-offline-'))), 'jobs');
  writeKonjirShim(join(jobs, '.bin', 'JDEAD'), ['/usr/bin/node']);
  const out = quiet();
  await expect(runWork({ call: async () => { throw new Error('Kolab is out of reach'); }, git: () => { throw new Error('no git'); }, jobsDir: jobs, log: out.log },
    { once: true, machine: 'here', harness: 'claude', url: 'http://127.0.0.1:9' })).rejects.toThrow('Kolab is out of reach');
  expect(readdirSync(join(jobs, '.bin'))).toEqual([]);
  expect(out.lines).toContain(`konjir work: swept what a job no runner here still runs left in ${jobs} (JDEAD)`);
});

test('done-when: a konjir work that was killed leaves its job\'s konjir behind; the next konjir work on the machine sweeps it, keeps what another runner there still runs, and the jobs directory then goes with rm -rf (W7.12)', async () => {
  const r = repository();
  const h = standIn(r.top);
  const kolab = await openKolab();
  const server = await startServer({ adminToken: 'test-admin-token', kolab });
  const admin = await connect(server.url, 'test-admin-token');
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const person = async (id: string, role: 'product' | 'engineer', grant: Record<string, unknown>) => {
    await call(admin, 'admin_add_actor', { id });
    await call(admin, 'admin_grant', { kolab: 'test', to: id, ...grant });
    const { token } = await call(admin, 'admin_open_session', { actor: id, role }) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return { c, token };
  };
  const pm = await person('pm', 'product', { level: 'write', layers: ['functional'] });
  await call(pm.c, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await call(pm.c, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] });
  await call(pm.c, 'submit_for_review', { node: 'orders', version: 1 });
  const lead = await person('lead', 'engineer', { level: 'maintain' });
  await call(lead.c, 'create_node', { kind: 'binding', title: 'On Postgres', id: 'orders-pg' });
  await call(lead.c, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' }], links: [{ source_element: 'b1', target: 'kj:orders@1#R1' }] });
  await call(lead.c, 'submit_for_review', { node: 'orders-pg', version: 1 });
  await call(lead.c, 'register_repository', { url: URL_, root_sha: r.root, binding: 'orders-pg' });
  await call(lead.c, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' },
    ...[1, 2].map((n) => ({ id: `W${n}`, text: `Build part ${n}.`, work: {} }))], links: [1, 2].map((n) => ({ source_element: `W${n}`, target: 'kj:orders-pg@1#b1' })) });
  await call(lead.c, 'submit_for_review', { node: 'orders-pg', version: 2 });

  // Two konjir works as the person runs them, each a process of its own, the CLI as built.
  // Their git reaches the bare repository as r.shell's does, but for reading the remote's URL, which stays the registered one.
  const bare = join(r.top, 'orders.git');
  const gitBin = join(r.top, 'git-bin');
  mkdirSync(gitBin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(gitBin, 'git'), `#!/bin/sh\ncase " $* " in *" remote "*) exec '${realGit}' "$@";; esac\nexec '${realGit}' -c 'url.${bare}.insteadOf=${URL_}.git' "$@"\n`, { mode: 0o755 });
  const childEnv: NodeJS.ProcessEnv = { PATH: `${gitBin}:${process.env.PATH}`, HOME: r.top, TMPDIR: tmpdir(), ...GIT_ENV,
    KONJIR_URL: server.url, KONJIR_TOKEN: lead.token, KONJIR_JOBS_DIR: r.jobsDir, KONJIR_CREDENTIALS: join(r.top, 'no-credentials.json') };
  const runners: ReturnType<typeof spawn>[] = [];
  // What the runners said, for a failure to show.
  const said: string[] = [];
  const runner = () => {
    const p = spawn(process.execPath, [join(import.meta.dirname, '..', 'dist', 'main.js'), 'work', '--once', '--machine', 'lead-laptop', '--harness', h.path], { cwd: r.dir, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr!.on('data', (b: Buffer) => { said.push(b.toString()); });
    runners.push(p);
    return { p, exited: new Promise<number | null>((resolve) => p.once('exit', (code) => resolve(code))) };
  };
  const started = () => readdirSync(h.dir).filter((f) => /^(?!modes)[^.]+\.json$/.test(f)).map((f) => f.replace(/\.json$/, ''));
  try {
    // One runner here takes a package and runs it; a second, started beside it, leaves its job alone.
    const still = runner();
    await until(() => started().length === 1, 60_000);
    const [live] = started();
    const killed = runner();
    await until(() => started().length === 2, 60_000);
    const gone = started().find((j) => j !== live)!;
    expect(existsSync(join(r.jobsDir, '.bin', live, 'konjir'))).toBe(true);
    expect(readFileSync(join(r.jobsDir, '.live', gone), 'utf8')).toBe(markerText(killed.p.pid!));
    // The second is killed outright: nothing of it runs to remove its job's konjir. Its harness, left running, finishes.
    killed.p.kill('SIGKILL');
    await killed.exited;
    h.go(gone);
    expect(existsSync(join(r.jobsDir, '.bin', gone, 'konjir'))).toBe(true);
    expect(spawnSync('rm', ['-rf', join(r.jobsDir, '.bin', gone)]).status).not.toBe(0);

    // The next konjir work on the machine sweeps the killed runner's job, and keeps the live one's.
    process.env = { ...process.env, ...GIT_ENV };
    const out = quiet();
    expect(await runWork({ call: (verb, args) => call(lead.c, verb, args), git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stopper().signal },
      { once: true, machine: 'lead-laptop', harness: h.path, url: server.url })).toEqual([]);
    expect(out.lines).toContain(`konjir work: swept what a job no runner here still runs left in ${r.jobsDir} (${gone})`);
    expect(existsSync(join(r.jobsDir, '.bin', gone))).toBe(false);
    expect(existsSync(join(r.jobsDir, '.live', gone))).toBe(false);
    expect(existsSync(join(r.jobsDir, '.bin', live, 'konjir'))).toBe(true);
    expect(readFileSync(join(r.jobsDir, '.live', live), 'utf8')).toBe(markerText(still.p.pid!));

    // The live job ends as ever, taking its own with it, and the jobs directory then goes.
    h.go(live);
    expect(await still.exited).toBe(0);
    expect(readdirSync(join(r.jobsDir, '.bin'))).toEqual([]);
    expect(readdirSync(join(r.jobsDir, '.live'))).toEqual([]);
    expect(readdirSync(join(r.jobsDir, '.mcp'))).toEqual([]);
    expect(spawnSync('rm', ['-rf', r.jobsDir]).status).toBe(0);
    expect(existsSync(r.jobsDir)).toBe(false);
  } catch (e) {
    throw new Error(`${(e as Error).message}; the runners said:\n${said.join('')}`);
  } finally {
    for (const p of runners) p.kill('SIGKILL');
  }
}, 180_000);

test('konjirCommand runs konjir as this process runs: node with its own options, which bin/konjir\'s tsx loads the source through, and its script; the shim it writes runs the source as bin/konjir does, guard and all (W7.8)', () => {
  const tsx = ['--require', '/n/tsx/dist/preflight.cjs', '--import', 'file:///n/tsx/dist/loader.mjs', '--conditions=@konjir/source'];
  const main = join(import.meta.dirname, '..', 'src', 'main.ts');
  expect(konjirCommand({ execPath: '/usr/bin/node', execArgv: tsx, argv: ['/usr/bin/node', main, 'work'] })).toEqual(['/usr/bin/node', ...tsx, main]);
  expect(konjirCommand({ execPath: '/usr/bin/node', execArgv: [], argv: ['/usr/bin/node', main] })).toEqual(['/usr/bin/node', main]);
  // A compiled konjir, whose script is inside it, runs alone.
  expect(konjirCommand({ execPath: '/usr/local/bin/konjir', execArgv: [], argv: ['/usr/local/bin/konjir', '/$bunfs/root/konjir'] })).toEqual(['/usr/local/bin/konjir']);

  const top = realpathSync(mkdtempSync(join(tmpdir(), 'konjir-shim-')));
  const shim = writeKonjirShim(join(top, "b'in"), ['/usr/bin/node', "/opt/kon'jir/main.js"], { TSX_TSCONFIG_PATH: '/k/tsconfig.json' });
  expect(readFileSync(shim, 'utf8')).toBe(`#!/bin/sh\n# konjir, as the konjir work that started this job runs it (W7.8).\nTSX_TSCONFIG_PATH='/k/tsconfig.json' exec '/usr/bin/node' '/opt/kon'\\''jir/main.js' "$@"\n`);
  // Read and run only, in a directory nothing can be added to, and edits to it are denied: the guard hook runs it.
  expect(statSync(shim).mode & 0o777).toBe(0o555);
  expect(statSync(join(top, "b'in")).mode & 0o777).toBe(0o500);
  expect(deniedTools('main', '/home/lee/.config/konjir', join(top, "b'in"))).toContain(`Edit(/${join(top, "b'in")}/**)`);
  expect(deniedTools('main', '/home/lee/.config/konjir')).not.toContainEqual(expect.stringContaining(top));
  // Written again over a job's earlier one, and removed, all the same.
  writeKonjirShim(join(top, "b'in"), ['/usr/bin/node', '/opt/konjir/main.js']);
  removeKonjirShim(join(top, "b'in"));
  expect(existsSync(join(top, "b'in"))).toBe(false);

  // A guard that can't run denies: Claude Code lets a command through on any exit but 2.
  const missing = JSON.parse(guardSettings([join(top, 'gone', 'konjir')], 'main')).hooks.PreToolUse[0].hooks[0].command;
  const failed = spawnSync('sh', ['-c', missing], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }) });
  expect({ status: failed.status, stderr: failed.stderr }).toEqual({ status: 2, stderr: expect.stringMatching(/Denied in a Konjir job: its guard could not check this command/) });

  // From the source, as bin/konjir runs it: a runner started under tsx writes a shim that runs the
  // same source, with no TSX_TSCONFIG_PATH in its environment (a job's has none), and its guard denies.
  const root = join(import.meta.dirname, '..', '..', '..');
  const script = join(top, 'runner.mts');
  writeFileSync(script, `import { writeKonjirShim } from ${JSON.stringify(join(root, 'apps/cli/src/work.ts'))};
if (process.argv[2] === 'write-shim') console.log(writeKonjirShim(process.argv[3]));
else await import(${JSON.stringify(main)});
`);
  const written = execFileSync(join(root, 'node_modules/.bin/tsx'), ['--conditions=@konjir/source', script, 'write-shim', join(top, 'bin')],
    { encoding: 'utf8', env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'tsconfig.json') } }).trim();
  const guard = spawnSync(written, ['work', 'guard', '--branch', 'main'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME },
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin :main' } }) });
  expect({ status: guard.status, stderr: guard.stderr }).toEqual({ status: 2, stderr: expect.stringMatching(/^Denied in a Konjir job: the refspec :main deletes main/) });
  // And one that fails before it checks anything (here, no --branch) denies too, with the exit Claude Code blocks on.
  expect(spawnSync(written, ['work', 'guard'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME }, input: '{}' }).status).toBe(2);
  expect(spawnSync(written, ['work', 'nonsense'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } }).status).toBe(1);
  removeKonjirShim(join(top, 'bin'));
}, 60_000);

test('a job Kolab ended while its harness still runs is stopped, and reported lost with how Kolab ended it, without ending it again (JOB4)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root, { items: [{ kind: 'build', item: 'kj:test/orders-plan#W1' }] });
  const out = quiet();
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, heartbeatMs: 50, signal: stopper().signal },
    { once: true, jobs: 1, machine: 'lee-laptop', harness: h.path, url: MCP });
  await until(() => h.started('J1'));
  // Another job took J1's package after its agent let it go: Kolab ended J1, and its harness runs on.
  kolab.release('J1');
  const [report] = await running;
  expect(existsSync(join(h.dir, 'J1.stopped'))).toBe(true);
  expect(report).toMatchObject({ job: 'J1', outcome: 'lost', ledger: 'released', exit: 143 });
  expect(kolab.calls.filter(([v]) => v === 'end_job')).toEqual([]);
  expect(out.lines.some((l) => /^job J1: Kolab ended it \(.*ended \(released\)/.test(l))).toBe(true);
}, 60_000);

test('done-when: on Ctrl-C every harness is stopped and its job ended as stopped, giving back what it held; only Kolab refusing a renewal stops a job\'s harness (JOB4)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root, { items: [{ kind: 'build', item: 'kj:test/orders-plan#W1' }, { kind: 'build', item: 'kj:test/orders-plan#W2' }, { kind: 'build', item: 'kj:test/orders-plan#W3' }] });
  const stop = stopper();
  const out = quiet();
  const processes = new Set<number>();
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stop.signal, heartbeatMs: 50, pollFirstMs: 50, pollLongestMs: 200, processes },
    { jobs: 3, machine: 'lee-laptop', harness: h.path, url: MCP });
  await until(() => ['J1', 'J2', 'J3'].every(h.started));
  expect(processes.size).toBe(3);
  // Kolab out of reach for a few renewals is tried again, and stops nothing.
  kolab.state.renewThrows = 4;
  await until(() => kolab.state.renewThrows === 0);
  await new Promise((res) => setTimeout(res, 200));
  expect(['J1', 'J2', 'J3'].some((j) => existsSync(join(h.dir, `${j}.stopped`)))).toBe(false);
  // Kolab ends J3 (its lease lapsed, say): its next renewal is refused, and its harness is stopped.
  kolab.lose('J3');
  await until(() => existsSync(join(h.dir, 'J3.stopped')));
  stop.abort();
  const reports = await running;
  expect(existsSync(join(h.dir, 'J1.stopped')) && existsSync(join(h.dir, 'J2.stopped'))).toBe(true);
  expect(Object.fromEntries(reports.map((x: JobReport) => [x.job, x.outcome]))).toEqual({ J1: 'stopped', J2: 'stopped', J3: 'lost' });
  expect(ended(kolab, 'J1')).toMatchObject({ outcome: 'stopped' });
  expect(ended(kolab, 'J2')).toMatchObject({ outcome: 'stopped' });
  expect(kolab.calls.filter(([v, a]) => v === 'end_job' && a.job === 'J3')).toEqual([]);
  expect(processes.size).toBe(0);
  // Nothing was committed, so no worktree is kept.
  for (const x of reports) expect(existsSync(x.worktree!)).toBe(false);
  expect(out.lines.some((l) => /J3: Kolab ended it/.test(l))).toBe(true);
}, 60_000);

test('Kolab out of reach while jobs run is waited out: the jobs go on and end as they exit; a renewal refused after its harness exited changes nothing (H2, M1, M2)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root, { items: [{ kind: 'build', item: 'kj:test/p#W1' }, { kind: 'build', item: 'kj:test/p#W2' }] });
  const stop = stopper();
  const out = quiet();
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stop.signal, heartbeatMs: 50, pollFirstMs: 30, pollLongestMs: 60 },
    { jobs: 3, harness: h.path, url: MCP });
  await until(() => h.started('J1') && h.started('J2'));
  kolab.state.takeThrows = true;
  await until(() => out.lines.filter((l) => /couldn't take a job \(fetch failed\)/.test(l)).length >= 2);
  // J1's renewals are slow and then refused; it exits meanwhile, and is still done, and ended.
  kolab.state.slowRefuse.add('J1');
  await new Promise((res) => setTimeout(res, 100));
  h.go('J1');
  await until(() => !!ended(kolab, 'J1'));
  await new Promise((res) => setTimeout(res, 400));
  expect(ended(kolab, 'J1')).toMatchObject({ outcome: 'done' });
  expect(ended(kolab, 'J2')).toBeUndefined();
  kolab.state.takeThrows = false;
  stop.abort();
  const reports = await running;
  expect(Object.fromEntries(reports.map((x) => [x.job, x.outcome]))).toEqual({ J1: 'done', J2: 'stopped' });
  expect(ended(kolab, 'J2')).toMatchObject({ outcome: 'stopped' });
}, 60_000);

test('a harness that fails ends its job as failed with its output\'s tail; with nothing ready it waits, longer each time, and takes what comes; --jobs bounds it (JOB4)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top, { J1: 'fail', J2: 'commit' });
  const kolab = fakeKolab(r.root);
  const stop = stopper();
  const out = quiet();
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stop.signal, pollFirstMs: 30, pollLongestMs: 120 },
    { jobs: 1, harness: h.path, url: MCP });
  await until(() => out.lines.filter((l) => l.startsWith('waiting')).length >= 4);
  expect(out.lines.filter((l) => l.startsWith('waiting')).slice(0, 4)).toEqual(['0.03', '0.06', '0.12', '0.12'].map((x) => `waiting ${x} s: nothing is ready (your jobs 0/4, the kolab's 0/8)`));
  kolab.items.push({ kind: 'build', item: 'kj:test/orders-plan#W1' }, { kind: 'build', item: 'kj:test/orders-plan#W2' });
  await until(() => !!ended(kolab, 'J2'));
  stop.abort();
  const reports = await running;
  expect(reports.map((x) => [x.job, x.outcome, x.exit])).toEqual([['J1', 'failed', 3], ['J2', 'done', 0]]);
  expect(ended(kolab, 'J1')!.note).toMatch(/working on kj:test\/orders-plan#W1[\s\S]*boom/);
  expect(reports[1].kept).toBe('1 commit(s) not pushed');
  // --jobs 1: the second was taken only once the first had ended.
  const order = kolab.calls.filter(([v]) => v === 'take_job' || v === 'end_job').map(([v, a]) => `${v} ${a.job ?? ''}`.trim());
  expect(order.indexOf('end_job J1')).toBeLessThan(order.lastIndexOf('take_job'));
  expect(kolab.jobs.get('J1')!.machine).toBe(hostname());
  // A later round fetches again, once.
  expect(r.fetches.length).toBeGreaterThanOrEqual(2);
}, 60_000);

test('the token is redacted from a job\'s log and note, however its output cuts it; a commit on a branch the job left keeps its worktree; a job id that isn\'t one makes no directory (M8, L2, L1)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top, { J1: 'leak', J2: 'branch' });
  const kolab = fakeKolab(r.root, { items: [{ kind: 'build', item: 'kj:test/p#W1' }, { kind: 'build', item: 'kj:test/p#W2' }, { kind: 'build', item: 'kj:test/p#W3', job: '../evil' }] });
  const reports: JobReport[] = [];
  for (let i = 0; i < 3; i++) {
    reports.push(...await runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: () => undefined, signal: stopper().signal },
      { once: true, harness: h.path, url: MCP }));
  }
  const by = Object.fromEntries(reports.map((x) => [x.job, x]));
  expect(by.J1).toMatchObject({ outcome: 'done' });
  const log = readFileSync(join(r.jobsDir, 'J1.log'), 'utf8');
  expect(log).toBe('working on kj:test/p#W1\ntoken [job token] and again [job token]\n');
  expect(ended(kolab, 'J1')!.note).not.toContain('kjs_job_token');
  expect(by.J2).toMatchObject({ outcome: 'done', kept: '1 commit(s) not pushed' });
  expect(by['../evil']).toMatchObject({ outcome: 'failed' });
  expect(ended(kolab, '../evil')!.note).toMatch(/konjir work couldn't start it: Kolab gave the job id "..\/evil"/);
  expect(readdirSync(r.top).sort()).toEqual(['checkout', 'jobs', 'orders.git', 'seed', 'standin']);
}, 60_000);

test('jobs that can\'t start back the runner off, and three in a row stop it taking any more (M4)', async () => {
  const r = repository({ failWorktrees: true });
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root, { items: [1, 2, 3, 4, 5].map((n) => ({ kind: 'build' as const, item: `kj:test/p#W${n}` })) });
  const out = quiet();
  const failure = await rejection(runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stopper().signal, pollFirstMs: 20, pollLongestMs: 40 },
    { jobs: 1, harness: h.path, url: MCP }));
  expect(failure).toMatch(/stopped taking jobs: 3 in a row couldn't start \(the last: git worktree add: no room\)/);
  expect(kolab.calls.filter(([v]) => v === 'take_job').length).toBe(3);
  expect(['J1', 'J2', 'J3'].map((j) => ended(kolab, j)?.outcome)).toEqual(['failed', 'failed', 'failed']);
  expect(out.lines.filter((l) => /waiting .* a job couldn't start/.test(l)).length).toBe(2);
}, 60_000);

test('konjir work refuses an agent\'s session, a checkout that isn\'t the registered repository, a fork with no remote at the registered URL and a harness not on PATH, taking nothing; with --repo it starts jobs from the registered URL\'s remote, never the fork\'s (JOB4, M7)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top);
  const base = { git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: () => undefined };
  const agent = fakeKolab(r.root, { kind: 'agent', items: [{ kind: 'build', item: 'kj:test/p#W1' }] });
  expect(await rejection(runWork({ ...base, call: agent.call }, { url: MCP, once: true, harness: h.path }))).toMatch(/lee-bot, an agent: konjir work runs as a person/);
  const other = fakeKolab('a'.repeat(40), { items: [{ kind: 'build', item: 'kj:test/p#W1' }] });
  expect(await rejection(runWork({ ...base, call: other.call }, { url: MCP, once: true, harness: h.path }))).toMatch(/is no repository registered in this kolab/);
  expect(await rejection(runWork({ ...base, call: other.call }, { url: MCP, jobs: 0 }))).toMatch(/--jobs is a whole number/);
  const ready = fakeKolab(r.root, { items: [{ kind: 'build', item: 'kj:test/p#W1' }] });
  expect(await rejection(runWork({ ...base, call: ready.call }, { url: MCP, once: true, harness: join(r.top, 'no-such-harness') }))).toMatch(/the harness .*no-such-harness isn't on PATH/);
  for (const k of [agent, other, ready]) expect(k.calls.filter(([v]) => v === 'take_job')).toEqual([]);

  // A fork: origin is the fork; with --repo, the job starts from upstream, the registered URL.
  const f = repository({ fork: true });
  const fh = standIn(f.top, { J1: 'commit' });
  const forked = fakeKolab(f.root, { items: [{ kind: 'build', item: 'kj:test/p#W1' }] });
  const fbase = { git: gitIn(f.dir), shell: f.shell, jobsDir: f.jobsDir, log: () => undefined };
  expect(await rejection(runWork({ ...fbase, call: forked.call }, { url: MCP, once: true, harness: fh.path }))).toMatch(/tracking origin, https:\/\/github.com\/fork\/orders\) is no repository registered/);
  const reports = await runWork({ ...fbase, call: forked.call, signal: stopper().signal }, { url: MCP, once: true, harness: fh.path, repo: URL_ });
  expect(reports).toEqual([expect.objectContaining({ job: 'J1', outcome: 'done' })]);
  expect(f.fetches).toEqual(['fetch --quiet upstream']);
  expect(git(fh.seen('J1').cwd, 'rev-parse', 'HEAD~1')).toBe(f.fetched);
  git(f.dir, 'remote', 'remove', 'upstream');
  const noRemote = fakeKolab(f.root, { items: [{ kind: 'build', item: 'kj:test/p#W2' }] });
  expect(await rejection(runWork({ ...fbase, call: noRemote.call }, { url: MCP, once: true, harness: fh.path, repo: URL_ }))).toMatch(/no remote of this checkout is https:\/\/github.com\/acme\/orders/);
  expect(noRemote.calls.filter(([v]) => v === 'take_job')).toEqual([]);

  // --once with nothing ready says why and returns.
  const empty = fakeKolab(r.root);
  const out = quiet();
  expect(await runWork({ ...base, call: empty.call, log: out.log }, { url: MCP, once: true, harness: h.path })).toEqual([]);
  expect(out.lines).toContain('nothing taken: nothing is ready (your jobs 0/4, the kolab\'s 0/8)');
}, 60_000);

test('inside a job, konjir never falls back to a sign-in kept on this machine: an empty --token, or none, is refused before anything is read (H1)', async () => {
  process.env = { ...process.env, KONJIR_JOB: 'J1', KONJIR_URL: 'http://127.0.0.1:9/mcp' };
  delete process.env.KONJIR_TOKEN;
  for (const argv of [['whoami', '--token', ''], ['whoami'], ['help', 'whoami'], ['work', 'deliver']]) {
    expect(await rejection(main(argv))).toMatch(/this is a Konjir job \(KONJIR_JOB is set\), which works as its agent with KONJIR_TOKEN, never with a sign-in kept on this machine/);
  }
  for (const cmd of ['login', 'logout', 'connect', 'work']) expect(await rejection(main([cmd]))).toMatch(new RegExp(`konjir ${cmd} doesn't run inside a Konjir job`));
});

test('the harness\'s command: Claude Code headless, Kolab its only MCP server, edits and git, npm, npx, gh and konjir only, or --allow-all; the denials and the environment (JOB4, M5, M6)', () => {
  const job: TakenJob = { job: 'J9', kind: 'build', item: 'kj:k/p#W1', agent: 'lee-engineer-1', token: 'kjs_secret', lease_until: '', instructions: 'Build it.' };
  const c = harnessCommand(job, { url: 'https://kolab.example.com/mcp', worktree: '/w', branch: 'main', credentials: '/jobs/.no-credentials/J9/credentials.json',
    mcpConfig: '/jobs/.mcp/J9.json', guard: ['/usr/bin/node', "/opt/kon'jir/main.js"], env:{ PATH: '/bin', HOME: '/home/lee', KONJIR_AGENT: 'lee-product', KONJIR_CREDENTIALS: '/home/lee/.config/konjir/credentials.json', AWS_PROFILE: 'p', LC_ALL: 'C', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c', GIT_SSH_COMMAND: 'ssh' } });
  expect(c.command).toBe('claude');
  expect(c.args.slice(0, 4)).toEqual(['-p', '--output-format', 'text', '--strict-mcp-config']);
  expect(c.args.join(' ')).not.toContain('kjs_secret');
  // Its MCP config, with the token, is read from the FIFO the runner feeds it through; the guard hook comes in --settings.
  expect(c.args[c.args.indexOf('--mcp-config') + 1]).toBe('/jobs/.mcp/J9.json');
  expect(JSON.parse(c.mcp)).toEqual({ mcpServers: { konjir: { type: 'http', url: 'https://kolab.example.com/mcp', headers: { Authorization: 'Bearer kjs_secret' } } } });
  expect(JSON.parse(c.args[c.args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: false, hooks: { PreToolUse: [{ matcher: 'Bash|Monitor', hooks: [{ type: 'command',
    command: `'/usr/bin/node' '/opt/kon'\\''jir/main.js' 'work' 'guard' '--branch' 'main' || { echo 'Denied in a Konjir job: its guard could not check this command' >&2; exit 2; }` }] }] } });
  expect(c.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS, '--disallowedTools', ...deniedTools('main', '/home/lee/.config/konjir')]));
  expect(ALLOWED_TOOLS).toEqual(expect.arrayContaining(['Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(gh *)', 'Bash(konjir *)', 'mcp__konjir']));
  expect(deniedTools('main', '/home/lee/.config/konjir')).toEqual(expect.arrayContaining(['Bash(gh api*)', 'Bash(gh pr merge*)', 'Bash(git -c*)', 'Bash(git push --force*)', 'Bash(git push * +*)',
    'Bash(git push *:main)', 'Bash(git push * main)', 'Read(//home/lee/.config/konjir/**)', 'Edit(//home/lee/.config/konjir/**)']));
  // Rules Claude Code warns of and ignores (found running it): a trailing :* is its old prefix syntax, and only Edit(path) covers editing tools.
  expect(deniedTools('main', '/x').filter((r) => /:\*\)$/.test(r) || /^(Write|MultiEdit)\(/.test(r))).toEqual([]);
  expect(c.args).not.toContain('--dangerously-skip-permissions');
  expect(c.env).toEqual({ PATH: '/bin', HOME: '/home/lee', LC_ALL: 'C', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c', GIT_SSH_COMMAND: 'ssh',
    KONJIR_URL: 'https://kolab.example.com/mcp', KONJIR_TOKEN: 'kjs_secret', KONJIR_CREDENTIALS: '/jobs/.no-credentials/J9/credentials.json', KONJIR_JOB: 'J9', KONJIR_ITEM: 'kj:k/p#W1', KONJIR_JOB_KIND: 'build' });
  expect(harnessEnv({ AWS_SECRET_ACCESS_KEY: 'x', KONJIR_ADMIN_TOKEN: 'y', KONJIR_DATABASE_URL: 'z', XDG_CONFIG_HOME: '/x', GITHUB_TOKEN: 'g', SSH_AUTH_SOCK: '/s' })).toEqual({ GITHUB_TOKEN: 'g', SSH_AUTH_SOCK: '/s' });
  expect(c.prompt).toMatch(/^Konjir job J9: build kj:k\/p#W1, as lee-engineer-1, in the worktree \/w\.\n\nBuild it\.$/);
  // Every other kind's environment has no token: its agent works with Kolab over MCP alone (W6.4).
  for (const kind of ['review', 'answer', 'mark', 'serve'] as const) {
    const other = harnessCommand({ ...job, kind }, { url: 'https://kolab.example.com/mcp', worktree: '/w', branch: 'main', credentials: '/n', mcpConfig: '/m', env: { PATH: '/bin', KONJIR_TOKEN: 'kjs_mine' } });
    expect(other.env).toEqual({ PATH: '/bin', KONJIR_URL: 'https://kolab.example.com/mcp', KONJIR_CREDENTIALS: '/n', KONJIR_JOB: 'J9', KONJIR_ITEM: 'kj:k/p#W1', KONJIR_JOB_KIND: kind });
  }
  expect([...TOKEN_KINDS]).toEqual(['build']);
  const all = harnessCommand(job, { url: 'https://kolab.example.com/mcp', worktree: '/w', branch: 'trunk', credentials: '/n', mcpConfig: '/m', allowAll: true, harness: 'my-claude --model opus', personCredentials: '/p/credentials.json' });
  expect(all.command).toBe('my-claude');
  expect(all.args.slice(0, 3)).toEqual(['--model', 'opus', '-p']);
  expect(all.args).toContain('--dangerously-skip-permissions');
  expect(all.args).not.toContain('--permission-mode');
  expect(all.args).toEqual(expect.arrayContaining(['--disallowedTools', 'Bash(gh pr merge*)', 'Bash(git push *:trunk)', 'Read(//p/**)']));
  // The lease: Kolab's clock when it gives one; the heartbeat a third of it, from 5 s to 5 minutes.
  expect(leaseLeft('2026-10-28T12:30:00Z', '2026-10-28T12:00:00Z', Date.parse('2026-10-28T12:10:00Z'))).toBe(30 * 60_000);
  expect(leaseLeft('2026-10-28T12:30:00Z', undefined, Date.parse('2026-10-28T12:10:00Z'))).toBe(20 * 60_000);
  expect(heartbeatEvery(30 * 60_000)).toBe(300_000);
  expect(heartbeatEvery(60_000)).toBe(20_000);
  expect(heartbeatEvery(3_000)).toBe(5_000);
  // Redaction holds back what may be the start of the token until it can tell.
  const red = new Redactor('kjs_secret');
  expect(red.push('a kjs_') + red.push('secr') + red.push('et b kjs') + red.end()).toBe('a [job token] b kjs');
});

test('konjir status: the queue by kind, every live job across pages, and the caller\'s room under the caps, cleaned of control characters (JOB5)', async () => {
  const pages: Record<string, unknown>[] = [];
  const job = (n: number, since: string) => ({ job: `J${n}`, person: 'lee', machine: 'lee-laptop', agent: `lee-engineer-${n}`, kind: 'build', item: `kj:test/p#W${n}`, started_at: since, lease_until: since });
  const call = async (verb: string, args: Record<string, unknown>) => {
    pages.push({ verb, ...args });
    return args.cursor ? { jobs: [{ ...job(2, '2026-10-28T09:00:00Z'), machine: 'lee-\x1b[31mlaptop' }], queue: { review: 9, build: 9 }, caps: {}, next: null }
      : { jobs: [job(1, '2026-10-28T11:58:00Z')], queue: { review: 1, build: 3 }, caps: { person: { live: 2, max: 4 }, kolab: { live: 5, max: 8 } }, next: 'c2' };
  };
  const s = await workStatus(call);
  expect(pages).toEqual([{ verb: 'list_jobs', live: true, limit: 200 }, { verb: 'list_jobs', live: true, limit: 200, cursor: 'c2' }]);
  expect(s.jobs.map((j) => j.job)).toEqual(['J1', 'J2']);
  expect(formatStatus(s, Date.parse('2026-10-28T12:00:00Z'))).toBe([
    'Queue:  1 to review, 3 to build',
    'Room:   yours 2 of 4 live, room for 2; the kolab\'s 5 of 8 live, room for 3',
    'Jobs:',
    '  PERSON  MACHINE         AGENT           KIND   ITEM          SINCE',
    '  lee     lee-laptop      lee-engineer-1  build  kj:test/p#W1  2m',
    '  lee     lee-[31mlaptop  lee-engineer-2  build  kj:test/p#W2  3h',
  ].join('\n'));
  expect(formatStatus({ ...s, jobs: [] })).toMatch(/Jobs:   none live$/);
});

test('the MCP config\'s FIFO: read once by the first reader and removed; never opened, removed unread at its deadline, or when its harness exits (W6.4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-fifo-'));
  const fifo = join(dir, 'J1.json');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  const fed = feedOnce(fifo, '{"secret":1}', () => false);
  const read = await new Promise<string>((resolve, reject) => execFile('cat', [fifo], (e, out) => (e ? reject(e) : resolve(out))));
  expect([read, await fed, existsSync(fifo)]).toEqual(['{"secret":1}', true, false]);

  execFileSync('mkfifo', ['-m', '600', fifo]);
  const t0 = Date.now();
  expect(await feedOnce(fifo, 'x', () => false, 2_500)).toBe(false);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(2_400);
  expect(existsSync(fifo)).toBe(false);
  // Stopped early when its harness exits.
  execFileSync('mkfifo', ['-m', '600', fifo]);
  let over = false;
  setTimeout(() => { over = true; }, 50);
  expect(await feedOnce(fifo, 'x', () => over)).toBe(false);
  expect(existsSync(fifo)).toBe(false);
}, 20_000);

test('a job\'s note is its agent\'s last "Handed to a person:" or "Cleared:" paragraph alone when it ends with one, and otherwise the output\'s tail (JOB6)', () => {
  const out = 'Reading kj:orders-pg@2#b1.\nSecrets: none here.\n\nHanded to a person: whether refunds are in scope.\nProduct decides.\n\nDone.';
  expect(jobNote(out)).toBe('Handed to a person: whether refunds are in scope.\nProduct decides.');
  expect(jobNote('Checked it.\n\nCleared: b1 still holds against R1.')).toBe('Cleared: b1 still holds against R1.');
  // The last one wins, and a mention inside a line isn't one.
  expect(jobNote('Handed to a person: first.\n\nHanded to a person: second.')).toBe('Handed to a person: second.');
  expect(jobNote('I was told "Handed to a person: x" earlier.')).toBe('I was told "Handed to a person: x" earlier.');
  expect(jobNote('No marker here.')).toBe('No marker here.');
  // Markdown around the marker is the same marker (W7.9).
  expect(jobNote('Read it.\n\n**Handed to a person:** whether refunds are in scope.')).toBe('Handed to a person: whether refunds are in scope.');
  expect(jobNote('### Cleared: b1 holds.')).toBe('Cleared: b1 holds.');
  expect(jobNote('> _Handed to a person:_ scope.')).toBe('Handed to a person: scope.');
  // A long hand-off keeps its start, where Kolab reads it, and is cut at its end; other output keeps its tail.
  const long = jobNote(`Handed to a person: ${'x'.repeat(5000)}`);
  expect(long.startsWith('Handed to a person: x')).toBe(true);
  expect(long).toHaveLength(2000);
  expect(jobNote(`${'a'.repeat(3000)}end`)).toBe(`${'a'.repeat(1997)}end`);
});

test('on a Kolab from before W5.11, which refuses kinds, the runner asks again without them, for builds and reviews, and doesn\'t send them again (JOB6)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root, { noKinds: true, items: [{ kind: 'build', item: 'kj:test/p#W1' }, { kind: 'review', item: 'kj:test/p#W2' }] });
  const out = quiet();
  const stop = stopper();
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, heartbeatMs: 50, signal: stop.signal },
    { jobs: 4, machine: 'lee-laptop', harness: h.path, url: MCP });
  await until(() => h.started('J1') && h.started('J2'));
  stop.abort();
  await running;
  expect(kolab.calls.filter(([v]) => v === 'take_job').map(([, a]) => a)).toEqual([
    { machine: 'lee-laptop', kinds: ['build', 'review', 'answer', 'mark', 'serve'] }, { machine: 'lee-laptop' }, { machine: 'lee-laptop' }, { machine: 'lee-laptop' },
  ]);
  expect(out.lines).toContain('Kolab takes no kinds yet (a release before W5.11): taking builds and reviews only');
});
