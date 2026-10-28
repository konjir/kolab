// konjir repo register and konjir work deliver, against real git checkouts (W5.2a; KON7, PLN16, D98
// rulings 1 and 2): the CLI registers a checkout's repository as a person, pinned by its root
// commit, with any credential in its remote dropped; it delivers the commits whose Konjir-Work trailer
// names the package, with their subjects and files; it refuses a checkout with another root commit,
// a fork with another remote and a shallow clone; it records nothing twice; and the first independent
// approval confirms the repository. Kolab itself reads no git (D36): every git call here is the CLI's.
import { afterEach, expect, jest, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@konjir/server';
import { call, canonicalRemote, connect, deliverWork, gitIn, main, registerRepository } from '../src/cli.js';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';
const env = { ...process.env };
afterEach(() => { jest.restoreAllMocks(); process.env = { ...env }; });

/** Git that reads no one's own settings, with a fixed author. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Eng', GIT_AUTHOR_EMAIL: 'eng@example.com',
  GIT_COMMITTER_NAME: 'Eng', GIT_COMMITTER_EMAIL: 'eng@example.com',
  // A directory made in the temporary directory is never taken for part of a checkout around it.
  GIT_CEILING_DIRECTORIES: tmpdir(),
};
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

/** Commits `files` (path → content) in `dir` with `message`, and returns its sha. */
function commit(dir: string, message: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const T1 = 'Konjir-Work: kj:test/orders-plan#W1';
const T2 = 'Konjir-Work: kj:test/orders-plan#W2';

/** A checkout of acme/orders: a root commit, then commits for W1 (two), W2 (one), none, and one that only mentions W1. */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-deliver-'));
  git(dir, 'init', '-q', '-b', 'main');
  const root = commit(dir, 'Start', { 'README.md': '# Orders\n' });
  // A token in the remote, as CI checkouts carry: it must never leave this machine.
  git(dir, 'remote', 'add', 'origin', 'https://x-access-token:ghp_SECRET@github.com/acme/orders.git');
  const c1 = commit(dir, `Cancel orders\n\nAdds the endpoint.\n\n${T1}`, { 'src/cancel.ts': 'export const cancel = 1;\n' });
  commit(dir, 'Unrelated tidy-up', { 'docs/a.md': 'a\n' });
  commit(dir, 'Mentions it\n\nNot a trailer: Konjir-Work: kj:test/orders-plan#W1 is the work.\n\nMore text.', { 'docs/b.md': 'b\n' });
  const c4 = commit(dir, `Queue\n\n${T2}`, { 'src/queue.ts': 'export const queue = 1;\n' });
  const c5 = commit(dir, `Refund on cancel\n\nCo-authored-by: Ann <ann@example.com>\n${T1}`, { 'src/cancel.ts': 'export const cancel = 2;\n', 'test/cancel.test.ts': 'test\n' });
  return { dir, root, c1, c4, c5 };
}

/** A kolab with a spec, a binding and a plan of W1 and W2; eng and eng2 engineers, lee a person with Maintain, pm product, and lee-bot, an agent of lee's. */
async function planned() {
  process.env = { ...process.env, ...GIT_ENV };
  const kolab = await openKolab();
  const server = await startServer({ adminToken: ADMIN, kolab });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const actor = async (id: string, role: 'product' | 'engineer', level = 'write', owner?: string) => {
    await call(admin, 'admin_add_actor', { id, ...(owner ? { owner } : {}) });
    await call(admin, 'admin_grant', { kolab: 'test', to: id, level, ...(level === 'write' ? { layers: [role === 'product' ? 'functional' : 'technical'] } : {}) });
    const { token } = (await call(admin, 'admin_open_session', { actor: id, role })) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return { c, token, call: (verb: string, args: Record<string, unknown>) => call(c, verb, args) };
  };
  const pm = await actor('pm', 'product');
  const eng = await actor('eng', 'engineer');
  await pm.call('create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await pm.call('draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }, { id: 'R2', text: 'Orders ship in a day.' }] });
  await pm.call('submit_for_review', { node: 'orders', version: 1 });
  await eng.call('create_node', { kind: 'binding', title: 'On Postgres', id: 'orders-pg' });
  await eng.call('draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' }, { id: 'b2', text: 'A queue.' }],
    links: [{ source_element: 'b1', target: 'kj:orders@1#R1' }, { source_element: 'b2', target: 'kj:orders@1#R2' }] });
  await eng.call('submit_for_review', { node: 'orders-pg', version: 1 });
  await eng.call('create_node', { kind: 'plan', title: 'Plan', id: 'orders-plan' });
  await eng.call('draft', { node: 'orders-plan', elements: [{ id: 'W1', text: 'Build the endpoint.' }, { id: 'W2', text: 'Build the queue.' }],
    links: [{ source_element: 'W1', target: 'kj:orders-pg@1#b1' }, { source_element: 'W2', target: 'kj:orders-pg@1#b2' }] });
  await eng.call('submit_for_review', { node: 'orders-plan', version: 1 });
  const eng2 = await actor('eng2', 'engineer');
  const lee = await actor('lee', 'engineer', 'maintain');
  const bot = await actor('lee-bot', 'engineer', 'write', 'lee');
  return { kolab, server, pm, eng, eng2, lee, bot };
}

test('a remote\'s URL as a repository\'s identity: SSH and https alike, without .git, a trailing slash, a user or a token; a local path is none', () => {
  expect(canonicalRemote('git@github.com:acme/orders.git')).toBe('https://github.com/acme/orders');
  expect(canonicalRemote('ssh://git@GitHub.com:22/acme/orders.git/')).toBe('https://github.com/acme/orders');
  expect(canonicalRemote('https://x-access-token:ghp_SECRET@github.com/acme/orders.git')).toBe('https://github.com/acme/orders');
  expect(canonicalRemote('https://gitlab.example.com:8443/group/sub/orders')).toBe('https://gitlab.example.com:8443/group/sub/orders');
  expect(canonicalRemote('http://github.com/acme/orders')).toBe('https://github.com/acme/orders');
  expect(canonicalRemote('/srv/git/orders.git')).toBeUndefined();
  expect(canonicalRemote('file:///srv/git/orders.git')).toBeUndefined();
  expect(canonicalRemote('../orders')).toBeUndefined();
  expect(canonicalRemote('C:\\repos\\orders')).toBeUndefined();
});

test('konjir repo register: a person with Maintain registers the checkout, its URL from origin without the token, pinned by its root commit; an agent is refused (D98 ruling 1)', async () => {
  const { lee, bot } = await planned();
  const { dir, root } = checkout();
  expect(await rejection(registerRepository(bot.call, gitIn(dir), { binding: 'orders-pg' }))).toMatch(/lee-bot is an agent, and an agent registers no repository/);
  const r = await registerRepository(lee.call, gitIn(dir), { binding: 'orders-pg' }) as { repository: Record<string, unknown> };
  expect(r.repository).toMatchObject({ url: 'https://github.com/acme/orders', root_sha: root, binding: 'orders-pg', registered_by: 'lee', confirmed: false });
  expect(JSON.stringify(await lee.call('list_repositories', {}))).not.toMatch(/SECRET|x-access-token/);
  // A root commit that isn't the checkout's is refused before anything is sent; outside a checkout, both are needed.
  expect(await rejection(registerRepository(lee.call, gitIn(dir), { url: 'https://github.com/acme/other', root: 'a'.repeat(40) }))).toMatch(/isn't a root commit of this checkout/);
  const plain = mkdtempSync(join(tmpdir(), 'konjir-plain-'));
  expect(await rejection(registerRepository(lee.call, gitIn(plain), {}))).toMatch(/this isn't a git checkout/);
  expect(await registerRepository(lee.call, gitIn(plain), { url: 'https://github.com/acme/other', root: 'a'.repeat(40) })).toMatchObject({ repository: { url: 'https://github.com/acme/other' } });
}, 60_000);

test('konjir work deliver: the commits carrying the package\'s trailer, with subjects and files; again, already counted; another checkout, a fork and a shallow clone refused; then submitted and confirmed (D98 rulings 1 and 2)', async () => {
  const { eng, eng2, lee } = await planned();
  const { dir, root, c1, c5 } = checkout();
  // Nothing registered: refused, nothing sent.
  await eng.call('pull_work', {});
  expect(await rejection(deliverWork(eng.call, gitIn(dir)))).toMatch(/this checkout \(https:\/\/github\.com\/acme\/orders\) is no repository registered in this kolab/);
  await registerRepository(lee.call, gitIn(dir), { binding: 'orders-pg' });

  // The package it holds, found by itself: c1 and c5, oldest first, not the commit that only mentions it, nor W2's.
  const first = await deliverWork(eng.call, gitIn(dir)) as Record<string, unknown>;
  expect(first).toMatchObject({
    work: 'kj:orders-plan#W1', repository: 'https://github.com/acme/orders', root_sha: root, trailer: T1, sent: true, recorded: 2, already: 0, state: 'in_progress',
    commits: [{ sha: c1, subject: 'Cancel orders', files: 1 }, { sha: c5, subject: 'Refund on cancel', files: 2 }],
  });
  const read = await eng.call('read_work', { work: 'kj:orders-plan#W1' }) as { evidence: Record<string, unknown>[] };
  // Recorded in one call, so in no fixed order among themselves.
  const shown = read.evidence.map((e) => [e.sha, e.title, e.files, e.repository, e.confirmed]);
  expect(shown).toHaveLength(2);
  expect(shown).toStrictEqual(expect.arrayContaining([
    [c1, 'Cancel orders', ['src/cancel.ts'], 'https://github.com/acme/orders', false],
    [c5, 'Refund on cancel', ['src/cancel.ts', 'test/cancel.test.ts'], 'https://github.com/acme/orders', false],
  ]));
  // Delivered again: nothing new, both already counted.
  expect(await deliverWork(eng.call, gitIn(dir), { work: 'kj:orders-plan#W1' })).toMatchObject({ recorded: 0, already: 2 });

  // Another repository's checkout at the same URL: its root commit differs. Refused, nothing sent.
  const other = mkdtempSync(join(tmpdir(), 'konjir-other-'));
  git(other, 'init', '-q', '-b', 'main');
  commit(other, `Imposter\n\n${T1}`, { 'x.ts': 'x\n' });
  git(other, 'remote', 'add', 'origin', 'git@github.com:acme/orders.git');
  expect(await rejection(deliverWork(eng.call, gitIn(other)))).toMatch(/this checkout isn't https:\/\/github\.com\/acme\/orders: its root commit is [0-9a-f]{40}, and https:\/\/github\.com\/acme\/orders was registered with root commit [0-9a-f]{40}\. Deliver from a checkout of the registered repository; nothing was sent/);
  // A fork: the same root, another remote. Refused, unless the repository is named by hand.
  const fork = mkdtempSync(join(tmpdir(), 'konjir-fork-'));
  git(fork, 'clone', '-q', dir, '.');
  git(fork, 'remote', 'set-url', 'origin', 'https://github.com/evil/orders.git');
  expect(await rejection(deliverWork(eng.call, gitIn(fork)))).toMatch(/is no repository registered in this kolab|no remote of this checkout is/);
  expect(await rejection(deliverWork(eng.call, gitIn(fork), { work: 'kj:orders-plan#W1', repo: 'https://github.com/evil/orders' }))).toMatch(/https:\/\/github\.com\/evil\/orders isn't a repository registered in this kolab/);
  expect(await deliverWork(eng.call, gitIn(fork), { repo: 'https://github.com/acme/orders' })).toMatchObject({ recorded: 0, already: 2 });
  // A shallow clone: its oldest commit stands in for the root.
  const shallow = mkdtempSync(join(tmpdir(), 'konjir-shallow-'));
  git(shallow, 'clone', '-q', '--depth', '2', `file://${dir}`, '.');
  git(shallow, 'remote', 'set-url', 'origin', 'https://github.com/acme/orders');
  expect(await rejection(deliverWork(eng.call, gitIn(shallow)))).toMatch(/It is a shallow clone, whose oldest commit stands in for its root: fetch its whole history \(git fetch --unshallow\)/);
  expect((await eng.call('read_work', { work: 'kj:orders-plan#W1' }) as { evidence: unknown[] }).evidence).toHaveLength(2);

  // Submitted, with a pull request outside the repository: refused whole. Then inside it, with a test run.
  expect(await rejection(deliverWork(eng.call, gitIn(dir), { submit: true, pr: 'https://github.com/evil/orders/pull/3' }))).toMatch(/isn't inside its repository, https:\/\/github\.com\/acme\/orders/);
  const submitted = await deliverWork(eng.call, gitIn(dir), { submit: true, pr: 'https://github.com/acme/orders/pull/3', tests: ['npm test: 3 passed'], note: 'Cancels, refunds.' });
  expect(submitted).toMatchObject({ recorded: 2, already: 2, state: 'in_review', in_review: true });
  const evidence = (await eng2.call('read_work', { work: 'kj:orders-plan#W1' }) as { evidence: Record<string, unknown>[] }).evidence;
  // Items recorded in one call share their time, so their order among themselves isn't fixed.
  expect(evidence.map((e) => e.kind).sort()).toStrictEqual(['commit', 'commit', 'pull_request', 'test_run']);
  expect(evidence.find((e) => e.kind === 'pull_request')).toMatchObject({ url: 'https://github.com/acme/orders/pull/3', pr: 3, repository: 'https://github.com/acme/orders' });
  // eng2 approves: neither its registrar nor its assignee, so the repository is confirmed.
  expect(await eng2.call('review', { work: 'kj:orders-plan#W1', verdict: 'approve' })).toMatchObject({ state: 'done', confirmed_repositories: ['https://github.com/acme/orders'] });
  expect(await eng.call('list_repositories', {})).toMatchObject({ repositories: [{ confirmed: true, confirmed_by: 'eng2', confirmed_by_work: 'kj:orders-plan#W1' }] });
}, 120_000);

test('in a shell: konjir repo register and konjir work deliver, with -C, --dry-run and --since; a package with no tagged commit is refused (D98)', async () => {
  const { server, eng, lee } = await planned();
  const { dir, c4 } = checkout();
  const out: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = lee.token;
  await main(['repo', 'register', '--binding', 'orders-pg', '-C', dir]);
  expect(JSON.parse(out.pop()!)).toMatchObject({ repository: { url: 'https://github.com/acme/orders', binding: 'orders-pg' } });
  process.env.KONJIR_TOKEN = eng.token;
  await eng.call('pull_work', {});
  await eng.call('release_work', { work: 'kj:orders-plan#W1' });
  await main(['pull_work']);
  out.pop();
  // W1 was released, so W1 is pulled again; deliver W2 by name is refused (not held), but a dry run sends nothing.
  await main(['work', 'deliver', 'kj:orders-plan#W2', '--dry-run', '-C', dir]);
  const dry = JSON.parse(out.pop()!);
  expect(dry).toMatchObject({ work: 'kj:orders-plan#W2', sent: false, commits: [{ sha: c4, subject: 'Queue' }], evidence: [{ kind: 'commit', sha: c4, repo: 'https://github.com/acme/orders', files: ['src/queue.ts'] }] });
  await expect(main(['work', 'deliver', 'kj:orders-plan#W2', '-C', dir])).rejects.toThrow(/only its assignee records its evidence/);
  await expect(main(['work', 'deliver', '--since', 'HEAD', '-C', dir])).rejects.toThrow(/no commit reachable from HEAD since HEAD carries the trailer "Konjir-Work: kj:test\/orders-plan#W1"/);
  await main(['work', 'deliver', '--test', 'https://ci.example.com/run/1', '-C', dir]);
  expect(JSON.parse(out.pop()!)).toMatchObject({ work: 'kj:orders-plan#W1', recorded: 3, already: 0 });
  await expect(main(['work', 'deliver', '--test', 'https://ci.example.com/run/1?token=abc', '-C', dir])).rejects.toThrow(/may be a credential/);
  await expect(main(['work', 'deliver', '--bogus', '-C', dir])).rejects.toThrow(/unknown --bogus/);
}, 120_000);
