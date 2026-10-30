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
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_TOOLS, Redactor, ToolRefusal, deniedTools, formatStatus, gitIn, harnessCommand, harnessEnv, heartbeatEvery, leaseLeft, main, runWork, workStatus, type JobReport, type TakenJob } from '../src/cli.js';
import { rejection } from '@konjir/engine/testing';

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
 * file and exits 0), `branch` (commits on a branch of its own, goes back to where it started and
 * exits 0), `leak` (prints its token, split across two writes, and exits 0) or `fail` (prints boom
 * and exits 3). It reads nothing from the environment but what a harness is given.
 */
function standIn(top: string, modes: Record<string, string> = {}) {
  const dir = join(top, 'standin');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'harness.mjs');
  writeFileSync(join(dir, 'modes.json'), JSON.stringify(modes));
  writeFileSync(path, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const job = process.env.KONJIR_JOB;
const out = (name) => here + '/' + job + name;
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  writeFileSync(out('.json'), JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), env: process.env, prompt }));
  const mode = JSON.parse(readFileSync(here + '/modes.json', 'utf8'))[job] || 'wait';
  console.log('working on ' + process.env.KONJIR_ITEM);
  const commit = (name) => { writeFileSync(name, name + '\\n'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-q', '-m', name]); };
  if (mode === 'fail') { console.error('boom'); process.exit(3); }
  if (mode === 'commit') { commit('cancel.ts'); process.exit(0); }
  if (mode === 'branch') {
    const start = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', '-q', '-c', 'side']);
    commit('side.ts');
    execFileSync('git', ['switch', '-q', '--detach', start]);
    process.exit(0);
  }
  if (mode === 'leak') {
    const t = process.env.KONJIR_TOKEN;
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
    seen: (job: string) => JSON.parse(readFileSync(join(dir, `${job}.json`), 'utf8')) as { cwd: string; argv: string[]; env: Record<string, string>; prompt: string } };
}

/** A fake of W5.4a's job tools and the reads konjir work makes, for a person `lee` in kolab `test`, recording every call. */
function fakeKolab(root: string, opts: { items?: { kind: 'build' | 'review'; item: string; job?: string }[]; kind?: string; cap?: number } = {}) {
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
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, heartbeatMs: 50, signal: stopper().signal },
    { once: true, jobs: 4, machine: 'lee-laptop', harness: h.path, url: MCP });
  // Both running at once: each has started, and neither has been let go.
  await until(() => h.started('J1') && h.started('J2'));
  const j1 = h.seen('J1');
  const j2 = h.seen('J2');
  expect(j1.cwd).not.toBe(j2.cwd);
  for (const [s, job] of [[j1, 'J1'], [j2, 'J2']] as const) {
    expect(s.cwd).toBe(join(r.jobsDir, job));
    expect(s.cwd.startsWith(r.dir)).toBe(false);
    expect(git(s.cwd, 'rev-parse', 'HEAD')).toBe(r.fetched);
    expect(s.env).toMatchObject({ KONJIR_TOKEN: `kjs_job_token_${job}`, KONJIR_URL: MCP, KONJIR_JOB: job, GH_TOKEN: 'gh-token' });
    // The environment is an allowlist: no cloud credentials, no Kolab admin token or database, no XDG_CONFIG_HOME;
    // konjir's credentials point at a file that doesn't exist.
    for (const k of ['AWS_SECRET_ACCESS_KEY', 'KONJIR_ADMIN_TOKEN', 'KONJIR_DATABASE_URL', 'XDG_CONFIG_HOME']) expect(s.env[k]).toBeUndefined();
    expect(s.env.KONJIR_CREDENTIALS.startsWith(r.jobsDir)).toBe(true);
    expect(existsSync(s.env.KONJIR_CREDENTIALS)).toBe(false);
    // The token is in no argument: the MCP config names ${KONJIR_TOKEN}, which Claude Code expands.
    expect(s.argv.join(' ')).not.toContain('kjs_job_token');
    const mcp = JSON.parse(s.argv[s.argv.indexOf('--mcp-config') + 1]);
    expect(mcp).toEqual({ mcpServers: { konjir: { type: 'http', url: MCP, headers: { Authorization: 'Bearer ${KONJIR_TOKEN}' } } } });
    expect(s.argv).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--permission-mode', 'acceptEdits', 'Bash(git push *:main)']));
  }
  expect(j1.prompt).toContain('Do kj:test/orders-plan#W1.');
  expect(j1.prompt).toContain('Konjir-Work: kj:test/orders-plan#W1');
  expect(kolab.calls.filter(([v]) => v === 'take_job').map(([, a]) => a)).toEqual([{ machine: 'lee-laptop' }, { machine: 'lee-laptop' }, { machine: 'lee-laptop' }]);
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
  const reports = await runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: () => undefined, signal: stopper().signal },
    { once: true, harness: h.path, url: MCP });
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
    env: { PATH: '/bin', HOME: '/home/lee', KONJIR_AGENT: 'lee-product', KONJIR_CREDENTIALS: '/home/lee/.config/konjir/credentials.json', AWS_PROFILE: 'p', LC_ALL: 'C', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c', GIT_SSH_COMMAND: 'ssh' } });
  expect(c.command).toBe('claude');
  expect(c.args.slice(0, 4)).toEqual(['-p', '--output-format', 'text', '--strict-mcp-config']);
  expect(c.args.join(' ')).not.toContain('kjs_secret');
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
  const all = harnessCommand(job, { url: 'https://kolab.example.com/mcp', worktree: '/w', branch: 'trunk', credentials: '/n', allowAll: true, harness: 'my-claude --model opus', personCredentials: '/p/credentials.json' });
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
