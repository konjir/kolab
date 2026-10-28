import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { ADMIN_DOER, type AccessLevel, type ArchiveTarget, type DeltaInput, type Doer, type ElementInput, type GateResult, type Layer, type LinkRef, type Checks, type OrgRole, type Role, type Visibility } from '@konjir/types';
import { Kolab } from './kolab.js';

/**
 * Kolab as tests drive it. Kolab itself makes every write name who made it, with no default
 * (W2.20, D70), so a caller that forgets is refused. A test is not such a caller: here, a write
 * that names no one is made as the admin token, ADMIN_DOER, as an admin's MCP verb makes it; a
 * version a test reviews is submitted by its author; and a session a test ends signs itself out.
 * Each says so explicitly below. A test of who is recorded passes `by` as the real caller would.
 */
export class TestKolab extends Kolab {
  static override async open(opts: Parameters<typeof Kolab.open>[0] = {}): Promise<TestKolab> {
    return asTestKolab(await Kolab.open(opts));
  }
  override retryOutboxJob(id: string, opts: { by?: Doer } = {}) { return super.retryOutboxJob(id, { by: opts.by ?? ADMIN_DOER }); }
  override addActor(id: string, opts: { name?: string; owner?: string; by?: Doer } = {}) { return super.addActor(id, { ...opts, by: opts.by ?? ADMIN_DOER }); }
  override openSession(actorId: string, role: Role, opts: { kolab?: string; by?: Doer } = {}) { return super.openSession(actorId, role, { ...opts, by: opts.by ?? ADMIN_DOER }); }
  override endSession(which: string | { key: string } | { actor: string }, opts: { by?: Doer } | { signingOut: true } = {}) {
    return super.endSession(which, 'by' in opts && opts.by !== undefined ? { by: opts.by } : { signingOut: true });
  }
  override linkIdentity(actorId: string, who: { provider: string; subject: string; login?: string }, opts: { by?: Doer } = {}) { return super.linkIdentity(actorId, who, { by: opts.by ?? ADMIN_DOER }); }
  override addOrganization(id: string, opts: { name?: string; by?: Doer } = {}) { return super.addOrganization(id, { ...opts, by: opts.by ?? ADMIN_DOER }); }
  override createKolab(name: string, opts: { owner: string; title?: string; visibility?: Visibility; base?: AccessLevel; by?: Doer }) { return super.createKolab(name, { ...opts, by: opts.by ?? ADMIN_DOER }); }
  override addMember(org: string, user: string, role: OrgRole = 'member', opts: { by?: Doer } = {}) { return super.addMember(org, user, role, { by: opts.by ?? ADMIN_DOER }); }
  override removeMember(org: string, user: string, opts: { by?: Doer } = {}) { return super.removeMember(org, user, { by: opts.by ?? ADMIN_DOER }); }
  override addTeam(org: string, name: string, opts: { parent?: string; by?: Doer } = {}) { return super.addTeam(org, name, { ...opts, by: opts.by ?? ADMIN_DOER }); }
  override addTeamMember(team: string, user: string, opts: { by?: Doer } = {}) { return super.addTeamMember(team, user, { by: opts.by ?? ADMIN_DOER }); }
  override removeTeamMember(team: string, user: string, opts: { by?: Doer } = {}) { return super.removeTeamMember(team, user, { by: opts.by ?? ADMIN_DOER }); }
  override grant(kolab: string, to: string, level: AccessLevel, opts: { layers?: Layer[]; by?: Doer } = {}) { return super.grant(kolab, to, level, { ...opts, by: opts.by ?? ADMIN_DOER }); }
  override revoke(kolab: string, to: string, opts: { by?: Doer } = {}) { return super.revoke(kolab, to, { by: opts.by ?? ADMIN_DOER }); }
  override archive(target: ArchiveTarget, opts: { by?: Doer; breakGlass?: boolean } = {}) { return super.archive(target, { ...opts, by: opts.by ?? ADMIN_DOER }); }
  override makeAdmin(actor: string, opts: { by?: Doer } = {}) { return super.makeAdmin(actor, { by: opts.by ?? ADMIN_DOER }); }
  override removeAdmin(actor: string, opts: { by?: Doer; breakGlass?: boolean } = {}) { return super.removeAdmin(actor, { by: opts.by ?? ADMIN_DOER, breakGlass: opts.breakGlass ?? true }); }
  override unarchive(target: ArchiveTarget, opts: { by?: Doer } = {}) { return super.unarchive(target, { by: opts.by ?? ADMIN_DOER }); }
  override applyRuling(nodeId: string, input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string; unlink?: LinkRef[] }, ruling: { id: string; actor: string; by?: Doer }) {
    return super.applyRuling(nodeId, input, { ...ruling, by: ruling.by ?? ADMIN_DOER });
  }
  override async review(versionId: string, opts: { by?: Doer } = {}) { return super.review(versionId, { by: opts.by ?? (await this.version(versionId)).actor_id }); }
}

/** `kolab`, made a TestKolab: what Kolab.open made, with TestKolab's defaults. */
export function asTestKolab(kolab: Kolab): TestKolab {
  return Object.setPrototypeOf(kolab, TestKolab.prototype) as TestKolab;
}

/**
 * Set by jest.global-setup.js when the suite runs on Postgres (KONJIR_TEST_POSTGRES=1), or
 * by hand to point at a server you run. Each test then gets a database of its own on it.
 */
const POSTGRES = process.env.KONJIR_TEST_DATABASE_URL;
/**
 * Set by jest.global-setup.js; jest.global-teardown.js drops this run's databases by it.
 * Without it (a test run some other way), closeOpened drops each file's databases itself.
 */
const RUN = process.env.KONJIR_TEST_RUN;

const closers: (() => Promise<unknown>)[] = [];
const opened: Kolab[] = [];
const dirs: string[] = [];
const adhoc: string[] = [];

export type Store = { dataDir?: string; databaseUrl?: string };

/** An empty store that lasts until the test file ends: in memory on PGlite, a fresh database on Postgres. */
export async function testStore(): Promise<Store> {
  return POSTGRES ? { databaseUrl: await freshDatabase() } : {};
}

/** An empty store that survives closing and reopening Kolab: a fresh directory on PGlite. */
export async function persistentStore(): Promise<Store> {
  if (POSTGRES) return { databaseUrl: await freshDatabase() };
  const dataDir = mkdtempSync(join(tmpdir(), 'konjir-'));
  dirs.push(dataDir);
  return { dataDir };
}

async function freshDatabase() {
  const name = `kj_test_${RUN ?? 'adhoc'}_${randomBytes(6).toString('hex')}`;
  await onServer(`create database ${name}`);
  if (!RUN) adhoc.push(name);
  const url = new URL(POSTGRES!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function onServer(sql: string) {
  const client = new pg.Client({ connectionString: POSTGRES });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

/**
 * Opens a Kolab for a test. `closeOpened` closes every one, after each test file.
 *
 * A commit queues its variants' rebases, and Kolab's outbox worker runs them later (D43, P6).
 * So that a scenario can read the outcome of a commit and its rebases straight after the call,
 * each write that can commit (commit, review, submit, recordReview, resolveOverride,
 * applyRuling), and each change of access, here waits for the rebases it queued: it drains the outbox before it returns. A
 * write that fails still drains, but throws its own error, never the drain's.
 * With `queued: true` it doesn't, for tests of the asynchrony itself, which drain the outbox
 * (drainOutbox) or start the worker as they need.
 */
export async function openKolab(options: Parameters<typeof Kolab.open>[0] & { queued?: boolean } = {}): Promise<TestKolab> {
  const { queued, ...rest } = options;
  const store = rest.dataDir || rest.databaseUrl ? {} : await testStore();
  const kolab = await TestKolab.open({ ...rest, ...store });
  opened.push(kolab);
  if (!queued) drainAfterWrites(kolab);
  return kolab;
}

/**
 * The writes that can commit a version, and so queue rebases; and the changes of access, which
 * queue a fork's rebase when its holder holds it again (LNK8).
 */
const COMMITTING = ['commit', 'review', 'submit', 'recordReview', 'resolveOverride', 'applyRuling',
  'grant', 'revoke', 'changeGrant', 'removeGrant', 'addMember', 'removeMember', 'addTeamMember', 'removeTeamMember'] as const;

/** Makes each committing write of `kolab` drain the outbox before it returns or throws (openKolab). */
export function drainAfterWrites(kolab: Kolab) {
  for (const name of COMMITTING) {
    const write = (kolab[name] as (...a: unknown[]) => Promise<unknown>).bind(kolab);
    Object.defineProperty(kolab, name, {
      configurable: true,
      value: async (...args: unknown[]) => {
        let result: unknown;
        try {
          result = await write(...args);
        } catch (e) {
          // What a failed write committed still owes its rebases, but the write's own error is the one reported.
          await kolab.drainOutbox().catch(() => undefined);
          throw e;
        }
        await kolab.drainOutbox();
        return result;
      },
    });
  }
}

/**
 * Closes `things` when the test file ends, before the Kolabs and databases: servers, clients,
 * child processes, anything that holds a Kolab or a connection to a database. Everything
 * registered closes in the reverse of the order it was registered, so a client registered after
 * its server closes first. A test may close something itself as well; its `close` must then
 * do nothing the second time.
 */
export function closeAtEnd(...things: { close(): Promise<unknown> }[]) {
  for (const it of things) closers.push(() => it.close());
}

/**
 * Tears down what a test file opened, in order: what it registered with `closeAtEnd` (its servers
 * and clients), then the Kolabs `openKolab` opened, then their databases (PGlite data directories,
 * and Postgres databases made without a run name). jest.setup.js runs it after each file, as the
 * file's only teardown, so no server is left holding a Kolab or a connection to a database that
 * is going away. Each step runs even if an earlier one fails, and then the failures are thrown,
 * so a teardown error fails the file instead of hiding.
 *
 * The run's Postgres databases stay until jest.global-teardown.js drops them.
 */
export async function closeOpened() {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { errors.push(e); } };
  for (const close of closers.splice(0).reverse()) await attempt(close);
  for (const kolab of opened.splice(0)) await attempt(() => kolab.close());
  for (const dir of dirs.splice(0)) await attempt(async () => rmSync(dir, { recursive: true, force: true }));
  for (const name of adhoc.splice(0)) await attempt(() => onServer(`drop database if exists ${name} with (force)`));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `${errors.length} teardown steps failed`);
}

/** The kolab tests work in, owned by the organization `test-org`. */
export const TEST_KOLAB = 'test';

/**
 * Adds each person, with Write on both layers of the test kolab, which is made (owned by the
 * organization `test-org`) the first time. With `owner`, each is an agent of that account
 * instead, granted Write on both layers too. With `layers`, Write covers only those; with
 * `level`, another level of access than Write.
 */
export async function people(kolab: Kolab, ids: string | string[], opts: { owner?: string; layers?: Layer[]; level?: AccessLevel } = {}) {
  if (!(await kolab.listKolabs()).some((k) => k.id === TEST_KOLAB)) {
    await kolab.addOrganization('test-org', { by: ADMIN_DOER });
    await kolab.createKolab(TEST_KOLAB, { owner: 'test-org', by: ADMIN_DOER });
  }
  for (const id of [ids].flat()) {
    await kolab.addActor(id, { owner: opts.owner, by: ADMIN_DOER });
    await kolab.grant(TEST_KOLAB, id, opts.level ?? 'write', { ...(opts.layers ? { layers: opts.layers } : {}), by: ADMIN_DOER });
  }
}

/** A root commit for a test repository (W5.2a): a full sha from one hex digit. */
export const testRoot = (c = 'f') => c.repeat(40);

/**
 * Registers a repository in `kolab` (the test kolab by default) as a person with Maintain there,
 * `keeper` (made the first time), whose grant is then removed unless `keep`, so the repository's
 * registrar holds no other place in the test: it reviews nothing and is no reviewer (W5.2a, D98).
 * With `binding`, the repository is that binding's implementation.
 */
export async function registeredRepository(kolab: Kolab, opts: { url?: string; root?: string; binding?: string; kolab?: string; keeper?: string; keep?: boolean } = {}) {
  const k = opts.kolab ?? TEST_KOLAB;
  const keeper = opts.keeper ?? 'repo-keeper';
  if (!(await kolab.listActors()).some((a) => a.id === keeper)) await kolab.addActor(keeper, { by: ADMIN_DOER });
  await kolab.grant(k, keeper, 'maintain', { by: ADMIN_DOER });
  const session = await kolab.openSession(keeper, 'engineer', { kolab: k, by: ADMIN_DOER });
  try {
    return await kolab.registerRepository(session, { url: opts.url ?? 'https://github.com/acme/orders', root_sha: opts.root ?? testRoot(), binding: opts.binding });
  } finally {
    if (!opts.keep) await kolab.revoke(k, keeper, { by: ADMIN_DOER });
  }
}

/**
 * `submissionChecks` check people's versions as they are submitted; `checks`, everything else,
 * Kolab's own rebases included (Kolab.open). Both default to the structural checks. Alice writes
 * the functional layer and Bob the technical one, so each is alone on a layer and commits on the
 * checks alone (VER11); a test that wants review adds another writer. Carol only reads, and
 * holds either role, one at a time.
 */
export async function setup(submissionChecks?: Checks, checks?: Checks, opts: { queued?: boolean } = {}) {
  const kolab = await openKolab({ submissionChecks, checks, ...opts });
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  await people(kolab, 'carol', { level: 'read' });
  const product = await kolab.openSession('alice', 'product', { by: ADMIN_DOER });
  const engineer = await kolab.openSession('bob', 'engineer', { by: ADMIN_DOER });
  return { kolab, product, engineer };
}

/**
 * What a promise rejected with, as `String(error)`: the error's name and message, which is
 * what a pattern matched against under node:assert. Jest's `toThrow(pattern)` sees only the
 * message, and some patterns name the error class.
 */
export async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/** What a function threw, as `String(error)`; see `rejection`. */
export function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return String(error);
  }
  throw new Error('expected the function to throw, but it returned');
}

export const els =(pairs: Record<string, string>, parents: Record<string, string> = {}) =>
  Object.entries(pairs).map(([id, text]) => ({ id, text, parent: parents[id] }));

/** Open marks on any version of one node. */
export async function marksOn(kolab: Kolab, nodeId: string) {
  const ids = new Set((await kolab.db.query<{ id: string }>(`select id from version where node_id = $1`, [nodeId])).rows.map((r) => r.id));
  return (await kolab.openMarks()).filter((m) => ids.has(m.version_id));
}

export async function textOf(kolab: Kolab, nodeId: string) {
  const v = (await kolab.latestCommitted(nodeId))!;
  return Object.fromEntries((await kolab.elements(v.id)).map((e) => [e.element_id, e.text]));
}

/**
 * Draft and submit a version by `author`, and if it waits in review, approve it as `reviewer`
 * (W1.6). Returns the version that committed; throws if it didn't commit.
 */
export async function commitReviewed(kolab: Kolab, author: string, reviewer: string, nodeId: string,
  input: { elements?: ElementInput[]; deltas?: DeltaInput[]; parent?: string }): Promise<string> {
  const r = await approved(kolab, reviewer, await kolab.submit(author, await kolab.draft(author, nodeId, input)));
  if (!r.ok) throw new Error(`expected ${nodeId} to commit: ${r.note ?? ''}`);
  return r.version;
}

/** If `r` left a version in review, approve it as `reviewer`; the outcome either way. */
export async function approved(kolab: Kolab, reviewer: string, r: GateResult): Promise<GateResult> {
  return r.in_review ? kolab.recordReview(reviewer, r.version, { verdict: 'approve' }) : r;
}
