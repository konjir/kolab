import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { AccessLevel, DeltaInput, ElementInput, GateResult, Layer, Checks } from '@konjir/types';
import { Kolab } from './kolab.js';

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

/** Opens a Kolab for a test. `closeOpened` closes every one, after each test file. */
export async function openKolab(options: Parameters<typeof Kolab.open>[0] = {}) {
  const store = options.dataDir || options.databaseUrl ? {} : await testStore();
  const kolab = await Kolab.open({ ...options, ...store });
  opened.push(kolab);
  return kolab;
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
    await kolab.addOrganization('test-org');
    await kolab.createKolab(TEST_KOLAB, { owner: 'test-org' });
  }
  for (const id of [ids].flat()) {
    await kolab.addActor(id, { owner: opts.owner });
    await kolab.grant(TEST_KOLAB, id, opts.level ?? 'write', opts.layers ? { layers: opts.layers } : {});
  }
}

/**
 * `submissionChecks` check people's versions as they are submitted; `checks`, everything else,
 * Kolab's own rebases included (Kolab.open). Both default to the structural checks. Alice writes
 * the functional layer and Bob the technical one, so each is alone on a layer and commits on the
 * checks alone (VER11); a test that wants review adds another writer. Carol only reads, and
 * holds either role, one at a time.
 */
export async function setup(submissionChecks?: Checks, checks?: Checks) {
  const kolab = await openKolab({ submissionChecks, checks });
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  await people(kolab, 'carol', { level: 'read' });
  const product = await kolab.openSession('alice', 'product');
  const engineer = await kolab.openSession('bob', 'engineer');
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
  const r = await approved(kolab, reviewer, await kolab.review(await kolab.draft(author, nodeId, input)));
  if (!r.ok) throw new Error(`expected ${nodeId} to commit: ${r.note ?? ''}`);
  return r.version;
}

/** If `r` left a version in review, approve it as `reviewer`; the outcome either way. */
export async function approved(kolab: Kolab, reviewer: string, r: GateResult): Promise<GateResult> {
  return r.in_review ? kolab.recordReview(reviewer, r.version, { verdict: 'approve' }) : r;
}
