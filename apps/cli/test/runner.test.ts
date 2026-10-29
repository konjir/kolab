// konjir work and konjir status (W5.4b; JOB4, JOB5, D103), against real git checkouts, a stand-in
// harness and a fake of W5.4a's job tools: a person's machine, in a checkout of the registered
// repository, runs two jobs at once, each in its own worktree at the default branch's head outside
// the checkout, with the job's token in the harness's environment and nowhere in its arguments;
// it heartbeats each, ends each as its harness exits (done or failed, the output's tail its note),
// keeps a worktree with commits not pushed and removes the rest; it waits with backoff while
// nothing is ready; a renewal refused stops that job's harness; and a stop (Ctrl-C) stops every
// harness and ends its job as stopped. An agent's session, and a checkout that isn't the
// repository, are refused before anything is taken.
import { afterEach, expect, jest, test } from '@jest/globals';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_TOOLS, DENIED_TOOLS, formatStatus, gitIn, harnessCommand, heartbeatAfter, runWork, workStatus, type JobReport, type TakenJob } from '../src/cli.js';
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

/**
 * A bare repository standing in for github.com/acme/orders, and a clone of it whose origin is that
 * URL; the runner's git reaches the bare one through url.<bare>.insteadOf, so nothing leaves this
 * machine. Returns the clone, the root commit, main's head and the runner's git.
 */
function repository() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'konjir-runner-')));
  const bare = join(top, 'orders.git');
  git(top, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(top, 'seed');
  git(top, 'clone', '-q', bare, seed);
  writeFileSync(join(seed, 'README.md'), '# Orders\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'Start');
  const root = git(seed, 'rev-parse', 'HEAD');
  writeFileSync(join(seed, 'orders.ts'), 'export const orders = 1;\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'Orders');
  git(seed, 'push', '-q', 'origin', 'main');
  const head = git(seed, 'rev-parse', 'HEAD');
  const dir = join(top, 'checkout');
  git(top, 'clone', '-q', bare, dir);
  git(dir, 'remote', 'set-url', 'origin', `${URL_}.git`);
  // main moves on after the clone: a job starts at the head fetched, not the checkout's.
  writeFileSync(join(seed, 'more.ts'), 'export const more = 1;\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'More');
  git(seed, 'push', '-q', 'origin', 'main');
  const fetched = git(seed, 'rev-parse', 'HEAD');
  const shell = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => {
    execFile('git', ['-c', `url.${bare}.insteadOf=${URL_}.git`, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } },
      (e, out, err) => (e ? reject(new Error(`git ${args.join(' ')}: ${err}`)) : resolve(out)));
  });
  return { top, dir, root, head, fetched, shell, jobsDir: join(top, 'jobs') };
}

/**
 * The stand-in harness: it records what it was given (its directory, arguments, token, URL and
 * prompt) in $STANDIN_DIR/<job>.json, then does what $STANDIN_<job> says: `wait` (until
 * $STANDIN_DIR/<job>.go appears, or SIGTERM, when it writes <job>.stopped and exits 143), `commit`
 * (commits a file in its worktree and exits 0) or `fail` (prints boom and exits 3).
 */
function standIn(top: string) {
  const dir = join(top, 'standin');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'harness.mjs');
  writeFileSync(path, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const job = process.env.KONJIR_JOB;
const out = (name) => process.env.STANDIN_DIR + '/' + job + name;
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  writeFileSync(out('.json'), JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), token: process.env.KONJIR_TOKEN, url: process.env.KONJIR_URL, prompt }));
  const mode = process.env['STANDIN_' + job] || 'wait';
  console.log('working on ' + process.env.KONJIR_ITEM);
  if (mode === 'fail') { console.error('boom'); process.exit(3); }
  if (mode === 'commit') {
    writeFileSync('cancel.ts', 'export const cancel = 1;\\n');
    execFileSync('git', ['add', '-A']);
    execFileSync('git', ['commit', '-q', '-m', 'Cancel']);
    process.exit(0);
  }
  process.on('SIGTERM', () => { writeFileSync(out('.stopped'), 'yes'); process.exit(143); });
  const t = setInterval(() => { if (existsSync(out('.go'))) { clearInterval(t); process.exit(0); } }, 20);
});
`);
  chmodSync(path, 0o755);
  process.env.STANDIN_DIR = dir;
  return { path, dir, go: (job: string) => writeFileSync(join(dir, `${job}.go`), ''), seen: (job: string) => JSON.parse(readFileSync(join(dir, `${job}.json`), 'utf8')) as { cwd: string; argv: string[]; token: string; url: string; prompt: string } };
}

/** A fake of W5.4a's job tools and the reads konjir work makes, for a person `lee` in kolab `test`, recording every call. */
function fakeKolab(root: string, opts: { items?: { kind: 'build' | 'review'; item: string }[]; kind?: string; cap?: number } = {}) {
  const items = [...(opts.items ?? [])];
  const calls: [string, Record<string, unknown>][] = [];
  const jobs = new Map<string, TakenJob & { ended?: { outcome: string; note?: string }; machine: string }>();
  const lost = new Set<string>();
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
        if (liveCount() >= cap) return { taken: false, why: 'you have 4 live jobs, your most', counts: {}, caps: caps() };
        const it = items.shift();
        if (!it) return { taken: false, why: 'nothing is ready', counts: { review: 0, build: 0 }, caps: caps() };
        const job = `J${++n}`;
        const j = { job, ...it, agent: `lee-engineer-${n}`, token: `kjs_job_token_${n}`, lease_until: new Date(Date.now() + 30 * 60_000).toISOString(),
          instructions: `Do ${it.item}.`, trailer: `Konjir-Work: ${it.item}`, machine: String(args.machine) };
        jobs.set(job, j);
        return { taken: true, ...j };
      }
      case 'renew_job': {
        const j = jobs.get(String(args.job));
        if (!j || j.ended || lost.has(j.job)) throw new Error(`job ${args.job} is over`);
        return { job: j.job, lease_until: new Date(Date.now() + 30 * 60_000).toISOString() };
      }
      case 'end_job': {
        const j = jobs.get(String(args.job));
        if (!j || j.ended || lost.has(j.job)) throw new Error(`job ${args.job} is over`);
        j.ended = { outcome: String(args.outcome), ...(args.note ? { note: String(args.note) } : {}) };
        return { job: j.job, ended: true, ...(args.outcome !== 'done' ? { released: true } : {}) };
      }
      default: throw new Error(`the fake has no ${verb}`);
    }
  };
  return { call, calls, jobs, items, lose: (job: string) => lost.add(job) };
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

test('done-when: two jobs at once, each in its own worktree at the default branch\'s head outside the checkout, the token only in its environment; each ended as it exits; a worktree with commits not pushed kept, the other removed (JOB4)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root, { items: [{ kind: 'build', item: 'kj:test/orders-plan#W1' }, { kind: 'review', item: 'kj:test/orders-plan#W2' }] });
  process.env.STANDIN_J2 = 'wait';
  const out = quiet();
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, heartbeatMs: 50, signal: stopper().signal },
    { once: true, jobs: 4, machine: 'lee-laptop', harness: h.path, url: 'http://127.0.0.1:7420/mcp' });
  // Both running at once: each has started, and neither has been let go.
  await until(() => existsSync(join(h.dir, 'J1.json')) && existsSync(join(h.dir, 'J2.json')));
  const j1 = h.seen('J1');
  const j2 = h.seen('J2');
  expect(j1.cwd).not.toBe(j2.cwd);
  for (const [s, job] of [[j1, 'J1'], [j2, 'J2']] as const) {
    expect(s.cwd.startsWith(r.jobsDir)).toBe(true);
    expect(s.cwd.startsWith(r.dir)).toBe(false);
    expect(git(s.cwd, 'rev-parse', 'HEAD')).toBe(r.fetched);
    expect(s.token).toBe(`kjs_job_token_${job.slice(1)}`);
    expect(s.url).toBe('http://127.0.0.1:7420/mcp');
    // The token is in no argument: the MCP config names ${KONJIR_TOKEN}, which Claude Code expands.
    expect(s.argv.join(' ')).not.toContain('kjs_job_token');
    const mcp = JSON.parse(s.argv[s.argv.indexOf('--mcp-config') + 1]);
    expect(mcp).toEqual({ mcpServers: { konjir: { type: 'http', url: 'http://127.0.0.1:7420/mcp', headers: { Authorization: 'Bearer ${KONJIR_TOKEN}' } } } });
    expect(s.argv).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--permission-mode', 'acceptEdits']));
  }
  expect(j1.prompt).toContain('Do kj:test/orders-plan#W1.');
  expect(j1.prompt).toContain('Konjir-Work: kj:test/orders-plan#W1');
  expect(kolab.calls.filter(([v]) => v === 'take_job').map(([, a]) => a)).toEqual([{ machine: 'lee-laptop' }, { machine: 'lee-laptop' }, { machine: 'lee-laptop' }]);
  // Heartbeats while they run.
  await until(() => kolab.calls.filter(([v, a]) => v === 'renew_job' && a.job === 'J1').length >= 2 && kolab.calls.filter(([v, a]) => v === 'renew_job' && a.job === 'J2').length >= 2);
  expect(kolab.jobs.get('J1')!.ended).toBeUndefined();
  // J1 commits in its worktree and exits; J2 is let go and exits with nothing to keep.
  writeFileSync(join(j1.cwd, 'cancel.ts'), 'export const cancel = 1;\n');
  git(j1.cwd, 'add', '-A');
  git(j1.cwd, 'commit', '-q', '-m', 'Cancel');
  h.go('J1');
  await until(() => !!kolab.jobs.get('J1')!.ended);
  expect(kolab.jobs.get('J2')!.ended).toBeUndefined();
  h.go('J2');
  const reports = await running;
  expect(reports.sort((a, b) => a.job.localeCompare(b.job))).toEqual([
    expect.objectContaining({ job: 'J1', outcome: 'done', exit: 0, kept: '1 commit(s) not pushed', worktree: j1.cwd }),
    expect.objectContaining({ job: 'J2', outcome: 'done', exit: 0, worktree: j2.cwd }),
  ]);
  expect(reports[1].kept).toBeUndefined();
  expect(kolab.jobs.get('J1')!.ended).toEqual({ outcome: 'done', note: 'working on kj:test/orders-plan#W1' });
  expect(kolab.jobs.get('J2')!.ended).toMatchObject({ outcome: 'done' });
  expect(existsSync(j1.cwd)).toBe(true);
  expect(existsSync(j2.cwd)).toBe(false);
  expect(git(r.dir, 'worktree', 'list')).not.toContain(j2.cwd);
  // The token reached no file the runner wrote.
  expect(readFileSync(join(r.jobsDir, 'J1.log'), 'utf8')).not.toContain('kjs_job_token');
  expect(out.lines.join('\n')).not.toContain('kjs_job_token');
}, 60_000);

test('done-when: on Ctrl-C every harness is stopped and its job ended as stopped, giving back what it held; a renewal refused stops that job\'s harness (JOB4)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root, { items: [{ kind: 'build', item: 'kj:test/orders-plan#W1' }, { kind: 'build', item: 'kj:test/orders-plan#W2' }, { kind: 'build', item: 'kj:test/orders-plan#W3' }] });
  const stop = stopper();
  const out = quiet();
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stop.signal, heartbeatMs: 50, pollFirstMs: 50, pollLongestMs: 200 },
    { jobs: 3, machine: 'lee-laptop', harness: h.path, url: 'http://127.0.0.1:7420/mcp' });
  await until(() => ['J1', 'J2', 'J3'].every((j) => existsSync(join(h.dir, `${j}.json`))));
  // Kolab ends J3 (its lease lapsed, say): its next heartbeat is refused, and its harness is stopped.
  kolab.lose('J3');
  await until(() => existsSync(join(h.dir, 'J3.stopped')));
  stop.abort();
  const reports = await running;
  expect(existsSync(join(h.dir, 'J1.stopped')) && existsSync(join(h.dir, 'J2.stopped'))).toBe(true);
  expect(Object.fromEntries(reports.map((x: JobReport) => [x.job, x.outcome]))).toEqual({ J1: 'stopped', J2: 'stopped', J3: 'lost' });
  expect(kolab.jobs.get('J1')!.ended).toMatchObject({ outcome: 'stopped' });
  expect(kolab.jobs.get('J2')!.ended).toMatchObject({ outcome: 'stopped' });
  expect(kolab.jobs.get('J3')!.ended).toBeUndefined();
  expect(kolab.calls.filter(([v, a]) => v === 'end_job' && a.job === 'J3')).toEqual([]);
  // Nothing was committed, so no worktree is kept.
  for (const x of reports) expect(existsSync(x.worktree!)).toBe(false);
  expect(out.lines.some((l) => /J3: Kolab ended it/.test(l))).toBe(true);
}, 60_000);

test('a harness that fails ends its job as failed with its output\'s tail; with nothing ready it waits, longer each time, and takes what comes; --jobs bounds it (JOB4)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV, STANDIN_J1: 'fail', STANDIN_J2: 'commit' };
  const h = standIn(r.top);
  const kolab = fakeKolab(r.root);
  const stop = stopper();
  const out = quiet();
  const running = runWork({ call: kolab.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log, signal: stop.signal, pollFirstMs: 30, pollLongestMs: 120 },
    { jobs: 1, harness: h.path, url: 'http://127.0.0.1:7420/mcp' });
  await until(() => out.lines.filter((l) => l.startsWith('waiting')).length >= 4);
  expect(out.lines.filter((l) => l.startsWith('waiting')).slice(0, 4)).toEqual(['0.03', '0.06', '0.12', '0.12'].map((x) => `waiting ${x} s: nothing is ready (your jobs 0/4, the kolab's 0/8)`));
  kolab.items.push({ kind: 'build', item: 'kj:test/orders-plan#W1' }, { kind: 'build', item: 'kj:test/orders-plan#W2' });
  await until(() => !!kolab.jobs.get('J2')?.ended);
  stop.abort();
  const reports = await running;
  expect(reports.map((x) => [x.job, x.outcome, x.exit])).toEqual([['J1', 'failed', 3], ['J2', 'done', 0]]);
  expect(kolab.jobs.get('J1')!.ended!.note).toMatch(/working on kj:test\/orders-plan#W1[\s\S]*boom/);
  expect(reports[1].kept).toBe('1 commit(s) not pushed');
  // --jobs 1: the second was taken only once the first had ended.
  const order = kolab.calls.filter(([v]) => v === 'take_job' || v === 'end_job').map(([v, a]) => `${v} ${a.job ?? ''}`.trim());
  expect(order.indexOf('end_job J1')).toBeLessThan(order.lastIndexOf('take_job'));
  expect(kolab.jobs.get('J1')!.machine).toBe(hostname());
}, 60_000);

test('konjir work refuses an agent\'s session and a checkout that isn\'t the registered repository, taking nothing (JOB4)', async () => {
  const r = repository();
  process.env = { ...process.env, ...GIT_ENV };
  const agent = fakeKolab(r.root, { kind: 'agent', items: [{ kind: 'build', item: 'kj:test/p#W1' }] });
  expect(await rejection(runWork({ call: agent.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: () => undefined }, { url: 'http://x/mcp', once: true })))
    .toMatch(/lee-bot, an agent: konjir work runs as a person/);
  const other = fakeKolab('a'.repeat(40), { items: [{ kind: 'build', item: 'kj:test/p#W1' }] });
  expect(await rejection(runWork({ call: other.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: () => undefined }, { url: 'http://x/mcp', once: true })))
    .toMatch(/is no repository registered in this kolab/);
  expect(await rejection(runWork({ call: other.call, git: gitIn(r.dir), log: () => undefined }, { url: 'http://x/mcp', jobs: 0 }))).toMatch(/--jobs is a whole number/);
  for (const k of [agent, other]) expect(k.calls.filter(([v]) => v === 'take_job')).toEqual([]);
  // --once with nothing ready says why and returns.
  const empty = fakeKolab(r.root);
  const out = quiet();
  expect(await runWork({ call: empty.call, git: gitIn(r.dir), shell: r.shell, jobsDir: r.jobsDir, log: out.log }, { url: 'http://x/mcp', once: true })).toEqual([]);
  expect(out.lines).toContain('nothing taken: nothing is ready (your jobs 0/4, the kolab\'s 0/8)');
}, 60_000);

test('the harness\'s command: Claude Code headless, Kolab its only MCP server, edits and git, npm, npx, gh and konjir only, or --allow-all; never merging or deploying (JOB4)', () => {
  const job: TakenJob = { job: 'J9', kind: 'build', item: 'kj:k/p#W1', agent: 'lee-engineer-1', token: 'kjs_secret', lease_until: '', instructions: 'Build it.' };
  const c = harnessCommand(job, { url: 'https://kolab.example.com/mcp', worktree: '/w', env: { PATH: '/bin', KONJIR_AGENT: 'lee-product' } });
  expect(c.command).toBe('claude');
  expect(c.args.slice(0, 4)).toEqual(['-p', '--output-format', 'text', '--strict-mcp-config']);
  expect(c.args.join(' ')).not.toContain('kjs_secret');
  expect(c.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS, '--disallowedTools', ...DENIED_TOOLS]));
  expect(ALLOWED_TOOLS).toEqual(expect.arrayContaining(['Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(gh *)', 'Bash(konjir *)', 'mcp__konjir']));
  expect(c.args).not.toContain('--dangerously-skip-permissions');
  expect(c.env).toEqual({ PATH: '/bin', KONJIR_URL: 'https://kolab.example.com/mcp', KONJIR_TOKEN: 'kjs_secret', KONJIR_JOB: 'J9', KONJIR_ITEM: 'kj:k/p#W1', KONJIR_JOB_KIND: 'build' });
  expect(c.prompt).toMatch(/^Konjir job J9: build kj:k\/p#W1, as lee-engineer-1, in the worktree \/w\.\n\nBuild it\.$/);
  const all = harnessCommand(job, { url: 'https://kolab.example.com/mcp', worktree: '/w', allowAll: true, harness: 'my-claude --model opus' });
  expect(all.command).toBe('my-claude');
  expect(all.args.slice(0, 3)).toEqual(['--model', 'opus', '-p']);
  expect(all.args).toContain('--dangerously-skip-permissions');
  expect(all.args).not.toContain('--permission-mode');
  expect(all.args).toEqual(expect.arrayContaining(['--disallowedTools', 'Bash(gh pr merge *)']));
  // The heartbeat: a third of the lease left, from 5 s to 5 minutes.
  const now = Date.parse('2026-10-28T12:00:00Z');
  expect(heartbeatAfter('2026-10-28T12:30:00Z', now)).toBe(300_000);
  expect(heartbeatAfter('2026-10-28T12:01:00Z', now)).toBe(20_000);
  expect(heartbeatAfter('2026-10-28T12:00:03Z', now)).toBe(5_000);
});

test('konjir status: the queue by kind, every live job across pages, and the caller\'s room under the caps (JOB5)', async () => {
  const pages: Record<string, unknown>[] = [];
  const job = (n: number, since: string) => ({ job: `J${n}`, person: 'lee', machine: 'lee-laptop', agent: `lee-engineer-${n}`, kind: 'build', item: `kj:test/p#W${n}`, started_at: since, lease_until: since });
  const call = async (verb: string, args: Record<string, unknown>) => {
    pages.push({ verb, ...args });
    return args.cursor ? { jobs: [job(2, '2026-10-28T09:00:00Z')], queue: { review: 9, build: 9 }, caps: {}, next: null }
      : { jobs: [job(1, '2026-10-28T11:58:00Z')], queue: { review: 1, build: 3 }, caps: { person: { live: 2, max: 4 }, kolab: { live: 5, max: 8 } }, next: 'c2' };
  };
  const s = await workStatus(call);
  expect(pages).toEqual([{ verb: 'list_jobs', live: true, limit: 200 }, { verb: 'list_jobs', live: true, limit: 200, cursor: 'c2' }]);
  expect(s.jobs.map((j) => j.job)).toEqual(['J1', 'J2']);
  expect(formatStatus(s, Date.parse('2026-10-28T12:00:00Z'))).toBe([
    'Queue:  1 to review, 3 to build',
    'Room:   yours 2 of 4 live, room for 2; the kolab\'s 5 of 8 live, room for 3',
    'Jobs:',
    '  PERSON  MACHINE     AGENT           KIND   ITEM          SINCE',
    '  lee     lee-laptop  lee-engineer-1  build  kj:test/p#W1  2m',
    '  lee     lee-laptop  lee-engineer-2  build  kj:test/p#W2  3h',
  ].join('\n'));
  expect(formatStatus({ ...s, jobs: [] })).toMatch(/Jobs:   none live$/);
});
