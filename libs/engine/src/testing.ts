import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { MIGRATIONS } from '@konjir/db';
import { ADMIN_DOER, type AccessLevel, type ArchiveTarget, type KolabPolicy, type DeltaInput, type Doer, type ElementInput, type GateResult, type Layer, type LinkRef, type Checks, type OrgRole, type Role, type Visibility } from '@konjir/types';
import { APP_REDIRECT_URI, Kolab } from './kolab.js';

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
  override endSessions(which: string | { key: string } | { actor: string }, opts: { by?: Doer } | { signingOut: true } = {}) {
    return super.endSessions(which, 'by' in opts && opts.by !== undefined ? { by: opts.by } : { signingOut: true });
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
 * Opens a Kolab for a test. `closeOpened` closes the ones a test opened after it, and every one
 * after the file.
 *
 * A commit queues its variants' rebases, and Kolab's outbox worker runs them later (D43, P6).
 * So that a scenario can read the outcome of a commit and its rebases straight after the call,
 * each write that can commit (commit, review, submit, recordReview, resolveOverride,
 * applyRuling, importKolab), and each change of access, here waits for the rebases it queued
 * (COMMITTING): it drains the outbox before it returns. A write that fails still drains, but
 * throws its own error, never the drain's.
 * With `queued: true` it doesn't, for tests of the asynchrony itself, which drain the outbox
 * (drainOutbox) or start the worker as they need.
 */
export async function openKolab(options: Parameters<typeof Kolab.open>[0] & { queued?: boolean; appDevSchemes?: boolean } = {}): Promise<TestKolab> {
  const { queued, appDevSchemes, ...rest } = options;
  const store = rest.dataDir || rest.databaseUrl ? {} : await testStore();
  const kolab = await TestKolab.open({ ...rest, ...store });
  // konnect's development builds' schemes are redirect URIs in tests, as in local-kolab (KONJIR_APP_DEV_SCHEMES=on); never in production.
  kolab.appRedirects.devSchemes = appDevSchemes ?? true;
  opened.push(kolab);
  if (!queued) drainAfterWrites(kolab);
  return kolab;
}

/**
 * The writes that can commit a version, and so queue rebases; and the changes of access, which
 * queue a fork's rebase when its holder holds it again (LNK8).
 */
const COMMITTING = ['commit', 'review', 'submit', 'recordReview', 'resolveOverride', 'applyRuling', 'importKolab',
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
 * Closes `things` when the test that registered them ends (or the file, if registered outside a
 * test; markOpened), before the Kolabs and databases: servers, clients,
 * child processes, anything that holds a Kolab or a connection to a database. Everything
 * registered closes in the reverse of the order it was registered, so a client registered after
 * its server closes first. A test may close something itself as well; its `close` must then
 * do nothing the second time.
 */
export function closeAtEnd(...things: { close(): Promise<unknown> }[]) {
  for (const it of things) closers.push(() => it.close());
}

/** How much a file had opened at some moment (markOpened), so closeOpened can close only what came after. */
export interface OpenedMark { closers: number; opened: number; dirs: number; adhoc: number }
const NOTHING_OPENED: OpenedMark = { closers: 0, opened: 0, dirs: 0, adhoc: 0 };

/**
 * What the file has opened so far. jest.setup.js marks it before each test and, after the test,
 * closes only what the test opened (closeOpened(mark)): each test's Kolabs (PGlite instances,
 * hundreds of megabytes each), servers and clients go when it ends, not when the file does, so a
 * file holds one test's at a time. What a file opens outside a test (at its top level, or in a
 * beforeAll) stays until the file ends.
 */
export function markOpened(): OpenedMark {
  return { closers: closers.length, opened: opened.length, dirs: dirs.length, adhoc: adhoc.length };
}

/**
 * Tears down what a test file opened (with `since`, only what it opened after that mark), in order: what it registered with `closeAtEnd` (its servers
 * and clients), then the Kolabs `openKolab` opened, then their databases (PGlite data directories,
 * and Postgres databases made without a run name). jest.setup.js runs it after each test, from the
 * mark it took before it, and after each file, as the file's only teardown, so no server is left
 * holding a Kolab or a connection to a database that is going away. Each step runs even if an earlier one fails, and then the failures are thrown,
 * so a teardown error fails the file instead of hiding.
 *
 * The run's Postgres databases stay until jest.global-teardown.js drops them.
 */
export async function closeOpened(since: OpenedMark = NOTHING_OPENED) {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { errors.push(e); } };
  for (const close of closers.splice(since.closers).reverse()) await attempt(close);
  for (const kolab of opened.splice(since.opened)) await attempt(() => kolab.close());
  for (const dir of dirs.splice(since.dirs)) await attempt(async () => rmSync(dir, { recursive: true, force: true }));
  for (const name of adhoc.splice(since.adhoc)) await attempt(() => onServer(`drop database if exists ${name} with (force)`));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `${errors.length} teardown steps failed`);
}

/**
 * Signs `person` in through konnect's own app, straight through the engine, as its phone does over
 * HTTP: a client whose one redirect URI is the app's production one, APP_REDIRECT_URI (a new one each time, as each install
 * registers its own, unless `client` names one), a `choose:kolab` sign-in, the person identified,
 * consent to `kolab`, and the code exchanged. Its grant is the app's, which the app-only verbs
 * (switchTeam, registerPushDevice and the like) take.
 */
export async function appSignIn(kolab: Kolab, person: string, k: string, opts: { client?: string } = {}) {
  const redirectUri = APP_REDIRECT_URI;
  const client = opts.client ?? (await kolab.registerClient({ name: 'konnect', redirectUris: [redirectUri] })).id;
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), scope: 'konjir choose:kolab' });
  const { csrf } = await kolab.identifyAuthorization(binding, state, person);
  const { code } = await kolab.consentPerson(binding, csrf, { kolab: k });
  const t = await kolab.exchangeCode({ code, clientId: client, redirectUri, codeVerifier: verifier });
  return { access: t.accessToken, refresh: t.refreshToken, client, session: t.session };
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

/**
 * Sets settings of `kolab`'s autonomy policy (W6.2, POL1) as a fixture, through konjir_set_policy:
 * as a person with Admin there, `policy-admin` (made the first time), whose grant is then removed, so
 * it holds no place in the test and reviews nothing, as registeredRepository's keeper. For a test of
 * something else that needs agents to approve functional versions, say. The rest of the settings
 * keep their values (D103's defaults for a kolab with no row).
 */
export async function testPolicy(kolab: Kolab, settings: Partial<KolabPolicy>, k = TEST_KOLAB) {
  const admin = 'policy-admin';
  if (!(await kolab.listActors()).some((a) => a.id === admin)) await kolab.addActor(admin, { by: ADMIN_DOER });
  await kolab.grant(k, admin, 'admin', { by: ADMIN_DOER });
  try {
    await kolab.setPolicy(await kolab.openSession(admin, 'product', { kolab: k, by: ADMIN_DOER }), settings as Record<string, unknown>);
  } finally {
    await kolab.revoke(k, admin, { by: ADMIN_DOER });
  }
}

/** Lets agents approve every layer and answer functional questions uncited in `kolab`: the policy before W6.2, for tests of something else. */
export const agentsMay = (kolab: Kolab, k = TEST_KOLAB) => testPolicy(kolab, { approve_functional: 'agent', approve_technical: 'agent', approve_work: 'agent' }, k);

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
  input: Parameters<Kolab['draft']>[2]): Promise<string> {
  const r = await approved(kolab, reviewer, await kolab.submit(author, await kolab.draft(author, nodeId, input)));
  if (!r.ok) throw new Error(`expected ${nodeId} to commit: ${r.note ?? ''}`);
  return r.version;
}

/**
 * A trigger function as the newest migration before `before` made it, from that migration's own
 * text, as create or replace: so an undo puts back exactly what was there.
 */
export function definitionBefore(name: string, before: number): string {
  const pattern = new RegExp(`create (?:or replace )?function ${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`, 'g');
  const m = MIGRATIONS.filter((x) => x.version < before).reverse().map((x) => [...x.sql.matchAll(pattern)].at(-1)?.[0]).find(Boolean);
  if (!m) throw new Error(`no migration before ${before} makes ${name}`);
  return m.replace(/^create (?:or replace )?function/, 'create or replace function');
}

/** The functions 0060 makes again, to let a re-key through: each put back as it was. */
const REKEYED_FUNCTIONS = ['kj_message_fixed', 'kj_channel_fixed', 'kj_audit_event_fixed', 'kj_archive_event_fixed', 'kj_work_event_fixed',
  'kj_evidence_fixed', 'kj_repository_fixed', 'kj_job_fixed', 'kj_case_fixed', 'kj_actor_frozen', 'kj_kolab_writable', 'kj_admin_audited'];

/**
 * Undoes migration 0060 on a database at 0060, to 0059's schema exactly (migrations.test.ts checks
 * it): for a test of 0060 itself, and for one that rewinds a database to an older release and
 * migrates it again (apps/cli's questions.test.ts).
 */
export const UNDO_0060 = String.raw`do $$
  declare t text;
  begin
    for t in select distinct x.tbl from kj_actor_columns() x loop execute format('drop trigger actor_named on %I', t); end loop;
    for t in select distinct c.relname::text from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname = 'kolab_rekeyed' loop
      execute format('drop trigger kolab_rekeyed on %I', t);
    end loop;
  end
  $$;
  drop function kj_actor_named();
  drop function kj_kolab_rekeyed();
  drop trigger account_deleted_kept on account;
  drop function kj_account_deleted_kept();
  drop trigger actor_deleted_kept on actor;
  drop function kj_actor_deleted_kept();
  drop trigger account_name_free on account;
  drop trigger actor_name_free on actor;
  drop function kj_name_free();
  drop function kj_name_retired(text);
  drop function kj_name_digest(text);
  drop table retired_name;
  drop function kj_retired_name_fixed();
create or replace function kj_identity_of_person() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not exists (select 1 from public.actor a where a.id = new.actor_id and a.kind = 'person') then
    raise exception 'only a person has an identity; % is not one', new.actor_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
` + REKEYED_FUNCTIONS.map((f) => definitionBefore(f, 60)).join('\n') + String.raw`
  drop function kj_rekey_scrubs(text, jsonb, jsonb);
  drop function kj_rekey_only(text, jsonb, jsonb);
  drop function kj_rekeyed_to(jsonb, jsonb, jsonb);
  drop function kj_rekey_columns(text);
  drop function kj_names_actor(text, text, jsonb);
  drop function kj_audit_subject_is_actor(text);
  drop function kj_actor_columns();
  drop function kj_rekeying();
  drop function kj_actor_deleted(text);
  do $$
  declare c record;
  begin
    for c in select f.conrelid::regclass::text as tbl, f.conname, pg_get_constraintdef(f.oid) as def from pg_constraint f
              where f.contype = 'f' and f.confupdtype = 'c' and f.confrelid in ('public.actor'::regclass, 'public.account'::regclass) loop
      execute format('alter table %s drop constraint %I, add constraint %I %s', c.tbl, c.conname, c.conname, replace(c.def, ' ON UPDATE CASCADE', ''));
    end loop;
  end
  $$;
  alter table actor alter constraint actor_person_is_user not deferrable;
  alter table account drop constraint account_deleted_check;
  alter table account drop column deleted_at;
  alter table audit_event drop constraint audit_event_action_check;
  alter table audit_event add constraint audit_event_action_check check (action in
    ('grant.set', 'grant.removed', 'member.set', 'member.removed',
     'team_member.added', 'team_member.removed', 'outbox.retried',
     'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
     'work_lease.set', 'repository.registered', 'repository.archived', 'policy.set', 'ruling.backdated',
     'host.ended', 'kolab.erased', 'push_device.unregistered'));
  delete from kj_migration where version = 60;`;

/** If `r` left a version in review, approve it as `reviewer`; the outcome either way. */
export async function approved(kolab: Kolab, reviewer: string, r: GateResult): Promise<GateResult> {
  return r.in_review ? kolab.recordReview(reviewer, r.version, { verdict: 'approve' }) : r;
}
