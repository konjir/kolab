// Versioned migrations (DAT2): a fresh database and one made before migrations began both reach
// the current schema through the files, each migration runs once and in order, and Kolab
// processes opening one database together don't trip over each other.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@jest/globals';
import {
  BASELINE, MIGRATIONS, checkMigrations, checksum, loadMigrations, migrate, openDb, statements, type Db, type Migration,
} from '@konjir/db';
import { Kolab, sessionKey } from '@konjir/engine';
import { fingerprint } from '@konjir/address';
import { commitReviewed, els, marksOn, people, persistentStore, rejection, setup, testStore, thrown, type Store, TestKolab } from '@konjir/engine/testing';
import { ARCHIVABLE, AUDIT_ACTIONS, KINDS,
  ACCESS_LEVELS, ACCOUNT_KINDS, ACTOR_KINDS, CASE_FILE_STATES, INVITE_LEVELS, MARK_REASONS, ORG_ROLES, OUTBOX_KINDS, OUTBOX_STATES, POSITION_VERDICTS, QUERY_KINDS, QUERY_STATES,
  REVIEW_REQUEST_STATES, RULING_EFFECTS, VERSION_STATES, VISIBILITIES,
} from '@konjir/types';

const versions = MIGRATIONS.map((m) => m.version);

/**
 * The SCHEMA string of main before migrations, frozen: what the test server's RDS database and
 * the PGlite data directories of 0.5 and later were made from.
 */
const BEFORE_MIGRATIONS = readFileSync(new URL('./fixtures/schema-before-migrations.sql', import.meta.url), 'utf8');

/** A raw database on a fresh store, closed when `fn` ends. */
async function withDb<T>(fn: (db: Db, store: Store) => Promise<T>, store?: Store): Promise<T> {
  const s = store ?? (await testStore());
  const db = openDb(s);
  try { return await fn(db, s); } finally { await db.close(); }
}

/** Everything about the schema that Kolab depends on, as sorted lines, to compare two databases. */
async function schemaOf(db: Db): Promise<string[]> {
  const r = await db.query<{ line: string }>(`
    select 'column ' || table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable
           || ' default=' || coalesce(column_default, '') as line
      from information_schema.columns where table_schema = 'public'
    union all
    select 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'public'::regnamespace
    union all
    select 'index ' || indexdef from pg_indexes where schemaname = 'public'
    union all
    select 'rls ' || relname || ' ' || relrowsecurity
      from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
    union all
    select 'policy ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',')
           || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '')
      from pg_policies where schemaname = 'public'
    union all
    select 'grant ' || grantee || ' ' || table_name || ' ' || privilege_type
      from information_schema.role_table_grants
     where table_schema = 'public' and grantee in ('kj_agent', 'kj_system')
    union all
    select 'function ' || pg_get_functiondef(oid) from pg_proc where pronamespace = 'public'::regnamespace`);
  return r.rows.map((x) => x.line).sort();
}

async function recorded(db: Db) {
  return (await db.query<{ version: number; name: string; checksum: string; baselined: boolean }>(
    `select version, name, checksum, baselined from kj_migration order by version`)).rows;
}

/** The schema a fresh database reaches through the files, to compare the other paths with. */
async function currentSchema() {
  return withDb(async (db) => { await migrate(db); return schemaOf(db); });
}

test('the migrations are numbered from 0001 with no gaps, and 0001 is the core schema', () => {
  expect(versions).toStrictEqual(versions.map((_, i) => i + 1));
  expect(MIGRATIONS[0].name).toBe('schema');
});

test('a fresh database reaches the current schema through the files, and Kolab works on it', async () => {
  const store = await persistentStore();
  await withDb(async (db) => {
    expect(await migrate(db)).toStrictEqual({ baselined: false, applied: versions });
    expect(await recorded(db)).toStrictEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name, checksum: checksum(m.sql), baselined: false })));
    // Nothing reaches the record but Kolab's own login.
    expect((await schemaOf(db)).filter((l) => l.startsWith('grant') && l.includes(' kj_migration '))).toStrictEqual([]);
  }, store);

  const kolab = await TestKolab.open(store);
  try {
    await people(kolab, 'alice');
    const product = await kolab.openSession('alice', 'product');
    await kolab.createNode(product, 'spec', 'Orders', 'orders');
    await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  } finally { await kolab.close(); }
});

test("the database's value lists are @konjir/types' MARK_REASONS, QUERY_KINDS, QUERY_STATES, ACTOR_KINDS, ACCOUNT_KINDS, ORG_ROLES, ACCESS_LEVELS, VISIBILITIES, VERSION_STATES, REVIEW_REQUEST_STATES, OUTBOX_KINDS, OUTBOX_STATES, CASE_FILE_STATES, POSITION_VERDICTS, RULING_EFFECTS, ARCHIVABLE, AUDIT_ACTIONS and KINDS", async () => {
  // A new value in either list needs a migration that redefines the check (README.md, "Changing the schema").
  await withDb(async (db) => {
    await migrate(db);
    const check = async (name: string) => {
      const r = await db.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [name]);
      return [...r.rows[0].def.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
    };
    expect(await check('invalidation_reason_check')).toStrictEqual([...MARK_REASONS].sort());
    expect(await check('query_kind_check')).toStrictEqual([...QUERY_KINDS].sort());
    expect(await check('query_state_check')).toStrictEqual([...QUERY_STATES].sort());
    expect(await check('actor_kind_check')).toStrictEqual([...ACTOR_KINDS].sort());
    expect(await check('account_kind_check')).toStrictEqual([...ACCOUNT_KINDS].sort());
    expect(await check('org_member_role_check')).toStrictEqual([...ORG_ROLES].sort());
    expect(await check('kolab_grant_level_check')).toStrictEqual([...ACCESS_LEVELS].sort());
    expect(await check('kolab_base_permission_check')).toStrictEqual([...ACCESS_LEVELS].sort());
    expect(await check('kolab_visibility_check')).toStrictEqual([...VISIBILITIES].sort());
    expect(await check('version_state_check')).toStrictEqual([...VERSION_STATES].sort());
    expect(await check('review_request_state_check')).toStrictEqual([...REVIEW_REQUEST_STATES].sort());
    expect(await check('outbox_kind_check')).toStrictEqual([...OUTBOX_KINDS].sort());
    expect(await check('outbox_state_check')).toStrictEqual([...OUTBOX_STATES].sort());
    expect(await check('case_file_state_check')).toStrictEqual([...CASE_FILE_STATES].sort());
    expect(await check('position_verdict_check')).toStrictEqual([...POSITION_VERDICTS].sort());
    expect(await check('archive_event_kind_check')).toStrictEqual([...ARCHIVABLE].sort());
    expect(await check('audit_event_action_check')).toStrictEqual([...AUDIT_ACTIONS].sort());
    expect(await check('ruling_verdict_check')).toStrictEqual([...POSITION_VERDICTS].sort());
    expect(await check('ruling_effect_check')).toStrictEqual([...RULING_EFFECTS].sort());
    expect(await check('position_seeks_check')).toStrictEqual([...RULING_EFFECTS].sort());
    expect(await check('kolab_invite_level_check')).toStrictEqual([...INVITE_LEVELS].sort());
    expect(await check('node_kind_check')).toStrictEqual([...KINDS].sort());
  });
});

test("a database made by today's SCHEMA, with no migration record, is baselined and reaches the current schema", async () => {
  const current = await currentSchema();
  await withDb(async (db) => {
    // What the test server's RDS database is: main's SCHEMA, with no migration record.
    await db.exec(BEFORE_MIGRATIONS);
    await db.query(`insert into actor(id, name) values ('alice', 'Alice')`);

    expect(await migrate(db)).toStrictEqual({ baselined: true, applied: versions.slice(1) });
    expect((await recorded(db))[0]).toStrictEqual({ version: 1, name: 'schema', checksum: checksum(MIGRATIONS[0].sql), baselined: true });
    expect(await schemaOf(db)).toStrictEqual(current);
    expect((await db.query(`select id from actor`)).rows).toStrictEqual([{ id: 'alice' }]);
    // And again: nothing left to do.
    expect(await migrate(db)).toStrictEqual({ baselined: false, applied: [] });
  });
});

test('a database from release 0.5, before the query columns, is baselined and reaches the current schema', async () => {
  const current = await currentSchema();
  await withDb(async (db) => {
    await db.exec(BEFORE_MIGRATIONS);
    await db.exec(`
      alter table query drop constraint query_kind_check;
      alter table query drop column selector, drop column kind, drop column from_version_id,
                        drop column from_element_id, drop column answered_by, drop column created_at;
      alter table invalidation drop constraint invalidation_reason_check;
      alter table invalidation add constraint invalidation_reason_check check (reason in
        ('changed','fuzzy_reanchor','orphaned','override_stale','override_orphaned',
         'upstream_dirty','review_failed','role_boundary'));`);

    expect((await migrate(db)).baselined).toBe(true);
    expect(await schemaOf(db)).toStrictEqual(current);
  });
});

test('a database at 0001 reaches 0002: its actors become persons, their sessions and authorship hold, and they can own agents', async () => {
  const store = await persistentStore();
  await withDb(async (db) => {
    // What the test server's RDS database is before this release: 0001, with people, a session and a version.
    expect(await migrate(db, { migrations: MIGRATIONS.slice(0, 1) })).toStrictEqual({ baselined: false, applied: [1] });
    await db.exec(`
      insert into actor(id, name) values ('lee', 'Lee'), ('eng-1', 'eng-1'), ('Pat Smith', 'Pat');   -- an id 0002 wouldn't accept now
      insert into session(id, actor_id, active_role) values ('kjs_old', 'lee', 'product');
      insert into node(id, kind, layer, title) values ('orders', 'functional_spec', 'functional', 'Orders');
      insert into version(id, node_id, seq, layer, state, actor_id, active_role)
        values ('v1', 'orders', 1, 'functional', 'committed', 'lee', 'product');
      insert into element(version_id, element_id, ord, text, fingerprint) values ('v1', 'R1', 0, 'Orders can be cancelled.', 'x');`);

    expect(await migrate(db)).toStrictEqual({ baselined: false, applied: versions.slice(1) });
    expect((await db.query(`select id, kind, owner_id from actor order by id collate "C"`)).rows).toStrictEqual([
      { id: 'Pat Smith', kind: 'person', owner_id: null },
      { id: 'eng-1', kind: 'person', owner_id: null },
      { id: 'lee', kind: 'person', owner_id: null },
    ]);
  }, store);
  expect(await withDb(schemaOf, store)).toStrictEqual(await currentSchema());

  const kolab = await TestKolab.open(store);
  try {
    expect(await kolab.sessionInfo('kjs_old')).toStrictEqual({
      session: sessionKey('kjs_old'), actor: 'lee', kind: 'person', owner: null, role: 'product', layer: 'functional',
      kolab: 'kolab', access: { level: 'write', layers: ['functional', 'technical'] },   // 0006
    });
    expect(await kolab.author('v1')).toStrictEqual({ actor: 'lee', kind: 'person', owner: null, role: 'product' });
    await kolab.addActor('lee-pm', { owner: 'lee' });
    await kolab.grant('kolab', 'lee-pm', 'write');
    const token = await kolab.openSession('lee-pm', 'product');   // beside Lee's own open session
    // Lee's own session, from before 0002, makes him a reviewer of his agent's versions (D33).
    const v2 = await commitReviewed(kolab, token, 'kjs_old', 'orders', { elements: els({ R1: 'Orders can be cancelled within an hour.' }) });
    expect(await kolab.author(v2)).toStrictEqual({ actor: 'lee-pm', kind: 'agent', owner: 'lee', role: 'product' });
  } finally { await kolab.close(); }
});

test('a database at 0002 reaches 0003: settled versions get the base the old check implied, and open drafts none, so they are redrafted', async () => {
  const store = await persistentStore();
  await withDb(async (db) => {
    expect(await migrate(db, { migrations: MIGRATIONS.slice(0, 2) })).toStrictEqual({ baselined: false, applied: [1, 2] });
    // Lee's draft d2 was opened on v1; Pat committed v3 since. A rejected r4 and an open draft d5 sit above it.
    await db.exec(`
      insert into actor(id, name) values ('lee', 'Lee'), ('pat', 'Pat');
      insert into session(id, actor_id, active_role) values ('kjs_lee', 'lee', 'product');
      insert into node(id, kind, layer, title) values ('orders', 'functional_spec', 'functional', 'Orders');
      insert into version(id, node_id, seq, layer, state, actor_id, active_role) values
        ('v1', 'orders', 1, 'functional', 'committed', 'lee', 'product'),
        ('d2', 'orders', 2, 'functional', 'drafted', 'lee', 'product'),
        ('v3', 'orders', 3, 'functional', 'committed', 'pat', 'product'),
        ('r4', 'orders', 4, 'functional', 'rejected', 'pat', 'product'),
        ('d5', 'orders', 5, 'functional', 'drafted', 'lee', 'product');
      insert into element(version_id, element_id, ord, text, fingerprint) values
        ('v1', 'R1', 0, 'Orders can be cancelled.', 'x'), ('d2', 'R1', 0, 'Orders can be cancelled by Lee.', 'x'),
        ('v3', 'R1', 0, 'Orders can be cancelled by Pat.', 'x'), ('r4', 'R1', 0, 'No.', 'x'),
        ('d5', 'R1', 0, 'Orders can be cancelled within an hour.', 'x');`);

    expect(await migrate(db)).toStrictEqual({ baselined: false, applied: versions.slice(2) });
    expect((await db.query(`select id, base_version_id from version order by seq`)).rows).toStrictEqual([
      { id: 'v1', base_version_id: null },
      { id: 'd2', base_version_id: null },   // open drafts: their true base is unknowable
      { id: 'v3', base_version_id: 'v1' },
      { id: 'r4', base_version_id: 'v3' },
      { id: 'd5', base_version_id: null },
    ]);
  }, store);
  expect(await withDb(schemaOf, store)).toStrictEqual(await currentSchema());

  const kolab = await TestKolab.open(store);
  try {
    // Each open draft is rejected as stale, to be redrafted, rather than risk committing over an
    // edit it never saw: d5 may have been drafted before v3 committed.
    expect(await kolab.review('d2')).toMatchObject({ ok: false, stale: true });
    expect(await kolab.review('d5')).toMatchObject({ ok: false, stale: true });
    expect((await kolab.latestCommitted('orders'))!.id).toBe('v3');
  } finally { await kolab.close(); }
});

test('a database at 0003 reaches 0004: marks from failed rebases become rebase_failed, one open per variant on its live version, each with a question', async () => {
  const store = await persistentStore();
  await withDb(async (db) => {
    expect(await migrate(db, { migrations: MIGRATIONS.slice(0, 3) })).toStrictEqual({ baselined: false, applied: [1, 2, 3] });
    // P is at p4. Variant V sits on p1. Before W1.17, rebases onto p2 and p3 failed, leaving mA
    // and mB; then W1.17 re-pointed the older, mA, at p4's failure and reworded its question.
    // V also has an older, settled failure (m0) and a changed mark (m4).
    // W's failure has no question: W1.17's first commit could swallow a failure to ask.
    // X's failure was marked on x1 just after x2 superseded it, with no lock to stop it.
    // Y's failure sits on y0, but Y has since committed y1 onto p4, P's latest.
    await db.exec(`
      insert into actor(id, name) values ('lee', 'Lee');
      insert into session(id, actor_id, active_role) values ('kjs_lee', 'lee', 'product');
      insert into node(id, kind, layer, title) values
        ('P', 'functional_spec', 'functional', 'P'), ('V', 'prototype', 'functional', 'V'),
        ('W', 'prototype', 'functional', 'W'), ('X', 'prototype', 'functional', 'X'),
        ('Y', 'prototype', 'functional', 'Y');   -- the variants are prototypes: a kolab holds one spec (0027)
      insert into version(id, node_id, seq, parent_version_id, base_version_id, layer, state, actor_id, active_role) values
        ('p1', 'P', 1, null, null, 'functional', 'committed', 'lee', 'product'),
        ('p2', 'P', 2, null, 'p1', 'functional', 'committed', 'lee', 'product'),
        ('p3', 'P', 3, null, 'p2', 'functional', 'committed', 'lee', 'product'),
        ('p4', 'P', 4, null, 'p3', 'functional', 'committed', 'lee', 'product'),
        ('v1', 'V', 1, 'p1', null, 'functional', 'committed', 'lee', 'product'),
        ('w1', 'W', 1, 'p1', null, 'functional', 'committed', 'lee', 'product'),
        ('x1', 'X', 1, 'p1', null, 'functional', 'committed', 'lee', 'product'),
        ('x2', 'X', 2, 'p1', 'x1', 'functional', 'committed', 'lee', 'product'),
        ('y0', 'Y', 1, 'p1', null, 'functional', 'committed', 'lee', 'product'),
        ('y1', 'Y', 2, 'p4', 'y0', 'functional', 'committed', 'lee', 'product');
      insert into element(version_id, element_id, ord, text, fingerprint) values
        ('p1', 'E1', 0, 'One.', 'x'), ('p2', 'E1', 0, 'Two.', 'x'), ('p3', 'E1', 0, 'Three.', 'x'),
        ('p4', 'E1', 0, 'Four.', 'x'), ('v1', 'E1', 0, 'One.', 'x'), ('w1', 'E1', 0, 'One.', 'x'),
        ('x1', 'E1', 0, 'One.', 'x'), ('x2', 'E1', 0, 'One.', 'x'), ('y0', 'E1', 0, 'One.', 'x'),
        ('y1', 'E1', 0, 'Four.', 'x');
      insert into invalidation(id, version_id, triggered_by, reason, state, cleared_by, created_at) values
        ('m0', 'v1', 'p1', 'review_failed', 'cleared', 'rebase v0 passed review', '2026-01-01'),
        ('mA', 'v1', 'p4', 'review_failed', 'open', null, '2026-01-02'),
        ('mB', 'v1', 'p3', 'review_failed', 'open', null, '2026-01-03'),
        ('m3', 'w1', 'p3', 'review_failed', 'open', null, '2026-01-03'),
        ('m4', 'v1', 'p2', 'changed', 'open', null, '2026-01-02'),
        ('mX', 'x1', 'p3', 'review_failed', 'open', null, '2026-01-03'),
        ('mY', 'y0', 'p3', 'review_failed', 'open', null, '2026-01-03');
      insert into query(id, version_id, invalidation_id, question) values
        ('qA', 'v1', 'mA', 'Rebasing onto the new parent failed review: p4 says no.'),
        ('qB', 'v1', 'mB', 'Rebasing onto the new parent failed review: p3 says no.'),
        ('qX', 'x1', 'mX', 'Rebasing onto the new parent failed review: no.'),
        ('qY', 'y0', 'mY', 'Rebasing onto the new parent failed review: no.');`);

    expect(await migrate(db)).toStrictEqual({ baselined: false, applied: versions.slice(3) });
    expect((await db.query(`select id, version_id, triggered_by, reason, state, cleared_by from invalidation order by id collate "C"`)).rows).toStrictEqual([
      { id: 'm0', version_id: 'v1', triggered_by: 'p1', reason: 'rebase_failed', state: 'cleared', cleared_by: 'rebase v0 passed review' },
      { id: 'm3', version_id: 'w1', triggered_by: 'p3', reason: 'rebase_failed', state: 'open', cleared_by: null },
      { id: 'm4', version_id: 'v1', triggered_by: 'p2', reason: 'changed', state: 'open', cleared_by: null },
      // The newest parent wins, not the newest mark.
      { id: 'mA', version_id: 'v1', triggered_by: 'p4', reason: 'rebase_failed', state: 'open', cleared_by: null },
      { id: 'mB', version_id: 'v1', triggered_by: 'p3', reason: 'rebase_failed', state: 'cleared', cleared_by: 'merged into mA by migration 0004' },
      // Moved to X's live version, where the engine finds it.
      { id: 'mX', version_id: 'x2', triggered_by: 'p3', reason: 'rebase_failed', state: 'open', cleared_by: null },
      { id: 'mY', version_id: 'y1', triggered_by: 'p3', reason: 'rebase_failed', state: 'cleared',
        cleared_by: "settled by migration 0004: y1 sits on the parent's latest version" },
    ]);
    expect((await db.query(`select id, invalidation_id, state, answer from query order by id collate "C"`)).rows).toStrictEqual([
      { id: 'q0004_m3', invalidation_id: 'm3', state: 'open', answer: null },
      { id: 'qA', invalidation_id: 'mA', state: 'open', answer: null },
      { id: 'qB', invalidation_id: 'mB', state: 'answered', answer: 'merged into mark mA, the one failed rebase this variant keeps open' },
      { id: 'qX', invalidation_id: 'mX', state: 'open', answer: null },
      { id: 'qY', invalidation_id: 'mY', state: 'answered', answer: "resolved: the variant sits on its parent's latest version" },
    ]);
  }, store);
  expect(await withDb(schemaOf, store)).toStrictEqual(await currentSchema());

  const kolab = await TestKolab.open(store);
  try {
    expect((await kolab.openQueries()).find((q) => q.id === 'q0004_m3')?.question).toMatch(/^Rebasing onto the new parent failed; the reason was not recorded\./);
    // P's next commit rebases the variants, and each rebase that passes settles its mark.
    await kolab.commit('kjs_lee', 'P', { elements: els({ E1: 'Five.' }) });
    await kolab.drainOutbox();
    expect((await kolab.openMarks()).map((m) => m.reason)).toStrictEqual(['changed']);
    expect((await kolab.openQueries())).toStrictEqual([]);
  } finally { await kolab.close(); }
});

test('a database at 0004 reaches 0005: a ruling can be stored with no case file, naming what it rules on, and positions carry their own verdicts', async () => {
  const store = await persistentStore();
  const at = MIGRATIONS.findIndex((x) => x.name === 'optional_case_file');
  expect(at).toBe(4);
  await withDb(async (db) => {
    expect(await migrate(db, { migrations: MIGRATIONS.slice(0, at) })).toStrictEqual({ baselined: false, applied: versions.slice(0, at) });
    await db.exec(`
      insert into actor(id, name) values ('lee', 'Lee');
      insert into node(id, kind, layer, title) values ('orders', 'functional_spec', 'functional', 'Orders');
      insert into version(id, node_id, seq, layer, state, actor_id, active_role) values
        ('v1', 'orders', 1, 'functional', 'committed', 'lee', 'product');
      insert into case_file(id, version_id, element_id, state) values ('c1', 'v1', 'R1', 'ruled');
      insert into position(id, case_file_id, actor_id, claim, evidence) values
        ('p1', 'c1', 'lee-pm', 'R1 stands.', '[]'), ('p2', 'c1', 'lee-eng', 'R1 cannot be met.', '[]');
      insert into ruling(id, case_file_id, actor_id, verdict, text) values ('r1', 'c1', 'lee', 'sustained', 'The spec stands.');`);
    // Before: a ruling needs a case file.
    expect(await rejection(db.query(`insert into ruling(id, actor_id, verdict, text) values ('r0', 'lee', 'sustained', 'No case.')`)))
      .toMatch(/case_file_id/);

    // Checked at 0005 itself, so each assertion below hits the constraint it names; 0006's kolab
    // keys would otherwise refuse some of these rows first.
    expect(await migrate(db, { migrations: MIGRATIONS.slice(0, at + 1) })).toStrictEqual({ baselined: false, applied: [versions[at]] });
    // A ruling given directly (CASE3, D16): its author, what it rules on, its body and what it
    // replaces. No case file, and no sustained/overruled outcome.
    await db.exec(`
      insert into ruling(id, actor_id, version_id, element_id, text, replaces) values
        ('d16', 'lee', 'v1', 'R1', 'A ruling can stand without a case file.', 'A ruling only resolves a case file.');
      insert into ruling(id, actor_id, version_id, text) values ('d17', 'lee', 'v1', 'Prior Art stays outside the model.');`);
    expect((await db.query(`select id, case_file_id, version_id, element_id, actor_id, verdict, text, replaces from ruling order by id collate "C"`)).rows).toStrictEqual([
      { id: 'd16', case_file_id: null, version_id: 'v1', element_id: 'R1', actor_id: 'lee', verdict: null,
        text: 'A ruling can stand without a case file.', replaces: 'A ruling only resolves a case file.' },
      { id: 'd17', case_file_id: null, version_id: 'v1', element_id: null, actor_id: 'lee', verdict: null,
        text: 'Prior Art stays outside the model.', replaces: null },
      { id: 'r1', case_file_id: 'c1', version_id: null, element_id: null, actor_id: 'lee', verdict: 'sustained', text: 'The spec stands.', replaces: null },
    ]);
    // Each position of a case file gets its own outcome (CASE2).
    await db.exec(`update position set verdict = case id when 'p1' then 'sustained' else 'overruled' end`);
    expect((await db.query(`select id, verdict from position order by id`)).rows)
      .toStrictEqual([{ id: 'p1', verdict: 'sustained' }, { id: 'p2', verdict: 'overruled' }]);
    expect(await rejection(db.query(`update position set verdict = 'maybe' where id = 'p1'`))).toMatch(/position_verdict_check/);

    // A ruling rules on a case file or on a version, never neither or both, and an element only
    // within a version.
    expect(await rejection(db.query(`insert into ruling(id, actor_id, text) values ('r2', 'lee', 'On nothing.')`)))
      .toMatch(/ruling_subject_check/);
    expect(await rejection(db.query(`insert into ruling(id, case_file_id, version_id, actor_id, text) values ('r3', 'c1', 'v1', 'lee', 'Both.')`)))
      .toMatch(/ruling_subject_check/);
    expect(await rejection(db.query(`insert into ruling(id, case_file_id, element_id, actor_id, text) values ('r4', 'c1', 'R1', 'lee', 'Stray element.')`)))
      .toMatch(/ruling_subject_check/);
    expect(await rejection(db.query(`insert into ruling(id, version_id, actor_id, text) values ('r5', 'nope', 'lee', 'No such version.')`)))
      .toMatch(/ruling_version_id_fkey/);
    expect(await rejection(db.query(`insert into ruling(id, case_file_id, actor_id, verdict, text) values ('r6', 'c1', 'lee', 'maybe', 'Neither.')`)))
      .toMatch(/ruling_verdict_check/);
    expect((await migrate(db)).applied).toStrictEqual(versions.slice(at + 1));
  }, store);
  expect(await withDb(schemaOf, store)).toStrictEqual(await currentSchema());
});

test('a database at 0005 reaches 0006: its data becomes the kolab `kolab` of the organization konjir, and everyone keeps working in it', async () => {
  const store = await persistentStore();
  const at = MIGRATIONS.findIndex((x) => x.name === 'accounts_kolabs');
  await withDb(async (db) => {
    expect(await migrate(db, { migrations: MIGRATIONS.slice(0, at) })).toStrictEqual({ baselined: false, applied: versions.slice(0, at) });
    // The test server before this release: the mirror's people and agents, an open session each,
    // a spec and a binding linked to it, a mark, a question, a precedent and a direct ruling.
    await db.exec(`
      insert into actor(id, name) values ('lee', 'Lee'), ('mirror-product', 'mirror-product'), ('pat', 'Pat');
      insert into actor(id, name, kind, owner_id) values ('lee-pm', 'lee-pm', 'agent', 'lee');
      insert into session(id, actor_id, active_role) values ('kjs_lee', 'lee', 'product'), ('kjs_pm', 'lee-pm', 'product');
      insert into node(id, kind, layer, title) values
        ('kolab', 'functional_spec', 'functional', 'Kolab'), ('kolab-binding', 'technical_binding', 'technical', 'Binding');
      insert into version(id, node_id, seq, layer, state, actor_id, active_role) values
        ('s1', 'kolab', 1, 'functional', 'committed', 'mirror-product', 'product'),
        ('b1', 'kolab-binding', 1, 'technical', 'committed', 'mirror-product', 'engineer');
      insert into element(version_id, element_id, ord, text, fingerprint) values
        ('s1', 'TEN1', 0, 'Konjir is one hosted service.', 'x'), ('b1', 'DEP1', 0, 'One Kolab service on AWS.', 'y');
      insert into delta(id, version_id, element_id, kind, text) values ('d1', 's1', 'TEN1', 'add', 'Konjir is one hosted service.');
      insert into edge(id, kind, source_version_id, source_element_id, target_version_id, target_element_id, target_fingerprint)
        values ('e1', 'dependency', 'b1', 'DEP1', 's1', 'TEN1', 'x');
      insert into invalidation(id, version_id, element_id, edge_id, triggered_by, reason) values ('m1', 'b1', 'DEP1', 'e1', 's1', 'changed');
      insert into query(id, version_id, element_id, question, raised_by) values ('q1', 's1', 'TEN1', 'One per region?', 'lee-pm');
      insert into precedent(id, base_fingerprint, parent_fingerprint, child_fingerprint, resolution, ruled_by)
        values ('p1', 'a', 'b', 'c', 'reaffirm', 'lee');
      insert into ruling(id, actor_id, version_id, text) values ('d12', 'lee', 's1', 'Konjir is one hosted service.');
      insert into invalidation(id, version_id, triggered_by, reason) values ('m2', 'b1', 's1', 'upstream_dirty');
      insert into invalidation_cause(mark_id, cause_id) values ('m2', 'm1');
      insert into case_file(id, version_id, element_id) values ('c1', 's1', 'TEN1');
      insert into position(id, case_file_id, actor_id, claim, evidence) values ('p1', 'c1', 'lee', 'One service.', '[]');
      insert into ruling(id, case_file_id, actor_id, text) values ('r1', 'c1', 'lee', 'It stands.');`);

    expect(await migrate(db)).toStrictEqual({ baselined: false, applied: versions.slice(at) });
    expect((await db.query(`select id, owner_id, title, visibility from kolab`)).rows).toStrictEqual([{ id: 'kolab', owner_id: 'konjir', title: 'Kolab', visibility: 'private' }]);
    expect((await db.query(`select id, kind from account order by id collate "C"`)).rows).toStrictEqual([
      { id: 'konjir', kind: 'organization' }, { id: 'lee', kind: 'user' }, { id: 'mirror-product', kind: 'user' }, { id: 'pat', kind: 'user' },
    ]);
    expect((await db.query(`select user_id, role from org_member where org_id = 'konjir' order by user_id collate "C"`)).rows).toStrictEqual([
      { user_id: 'lee', role: 'member' }, { user_id: 'mirror-product', role: 'member' }, { user_id: 'pat', role: 'member' },
    ]);
    expect((await db.query(`select coalesce(user_id, agent_id) as who, level, functional, technical from kolab_grant order by coalesce(user_id, agent_id) collate "C"`)).rows).toStrictEqual([
      { who: 'lee', level: 'write', functional: true, technical: true },
      { who: 'lee-pm', level: 'write', functional: true, technical: true },
      { who: 'mirror-product', level: 'write', functional: true, technical: true },
      { who: 'pat', level: 'write', functional: true, technical: true },
    ]);
    // Every row is keyed by it.
    for (const t of ['session', 'node', 'version', 'element', 'delta', 'edge', 'invalidation', 'invalidation_cause', 'query', 'case_file', 'position', 'precedent', 'ruling']) {
      expect(`${t}: ${JSON.stringify((await db.query(`select distinct kolab_id from ${t}`)).rows)}`).toBe(`${t}: [{"kolab_id":"kolab"}]`);
    }
  }, store);
  expect(await withDb(schemaOf, store)).toStrictEqual(await currentSchema());

  const kolab = await TestKolab.open(store);
  try {
    // Open sessions keep working, in kolab, with the access everyone had before.
    expect(await kolab.sessionInfo('kjs_pm')).toMatchObject({ actor: 'lee-pm', owner: 'lee', kolab: 'kolab', access: { level: 'write', layers: ['functional', 'technical'] } });
    // Everyone holds Write on both layers, so pat, say, reviews lee-pm's version (W1.6).
    const pat = await kolab.openSession('pat', 'product');
    const v2 = await commitReviewed(kolab, 'kjs_pm', pat, 'kolab', { elements: els({ TEN1: 'Konjir is one hosted service that every account shares.' }) });
    expect(await kolab.author(v2)).toStrictEqual({ actor: 'lee-pm', kind: 'agent', owner: 'lee', role: 'product' });
    expect((await kolab.listNodes(undefined, 'kolab')).map((n) => n.id)).toStrictEqual(['kolab-binding', 'kolab']);
    // An agent of the organization now, which a person's agent couldn't be before.
    await kolab.addActor('konjir-bot', { owner: 'konjir' });
    await kolab.grant('kolab', 'konjir-bot', 'read');
    expect(await kolab.access('konjir-bot', 'kolab')).toStrictEqual({ level: 'read', layers: [] });
    // Lee's grant can shrink like anyone's: her agent's open session narrows to it.
    await kolab.grant('kolab', 'lee', 'write', { layers: ['technical'] });
    expect((await kolab.sessionInfo('kjs_pm')).access).toStrictEqual({ level: 'write', layers: ['technical'] });
    const ended: string[] = [];
    kolab.onEvent((e) => { if ('session' in e) ended.push(e.id); });
    // With no grant, and no base permission for members, Lee reaches nothing: her session ends, and so does her agent's.
    expect(await kolab.revoke('kolab', 'lee')).toStrictEqual({ ended: 2 });
    expect(ended.sort()).toStrictEqual([sessionKey('kjs_lee'), sessionKey('kjs_pm')].sort());
  } finally { await kolab.close(); }
});

test("0006 refuses a database where an actor named konjir would take the organization's id", async () => {
  const at = MIGRATIONS.findIndex((x) => x.name === 'accounts_kolabs');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(`insert into actor(id, name) values ('konjir', 'Konjir the person')`);
    expect(await rejection(migrate(db))).toMatch(/0006_accounts_kolabs\.sql failed: .*an actor named konjir exists/);
    expect((await recorded(db)).map((r) => r.version)).toStrictEqual(versions.slice(0, at));
  });
  // An agent named konjir is refused too.
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(`insert into actor(id, name) values ('lee', 'Lee'); insert into actor(id, name, kind, owner_id) values ('konjir', 'konjir', 'agent', 'lee')`);
    expect(await rejection(migrate(db))).toMatch(/an actor named konjir exists/);
  });
});

test('0008 refuses a database with a node name no address can name, naming it', async () => {
  const at = MIGRATIONS.findIndex((x) => x.name === 'node_names');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(`
      insert into account(id, kind, name) values ('konjir', 'organization', 'Konjir');
      insert into kolab(id, owner_id, title) values ('kolab', 'konjir', 'Kolab');
      insert into node(id, kind, layer, title, kolab_id) values
        ('shop/x', 'functional_spec', 'functional', 'X', 'kolab'), ('fine', 'functional_spec', 'functional', 'Fine', 'kolab');`);
    expect(await rejection(migrate(db))).toMatch(/0008_node_names\.sql failed: .*these nodes have names no address can name.*: shop\/x \(kolab kolab\); rename them first/);
    expect((await recorded(db)).map((r) => r.version)).toStrictEqual(versions.slice(0, at));
  });
});

test('a database at 0007 reaches 0008: each node keeps its id, which becomes its name in its kolab, and another kolab may use the name', async () => {
  const store = await persistentStore();
  const at = MIGRATIONS.findIndex((x) => x.name === 'node_names');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    // The test server after 0006: Konjir's own kolab, with the spec, its binding and its plan.
    await db.exec(`
      insert into account(id, kind, name) values ('konjir', 'organization', 'Konjir'), ('lee', 'user', 'Lee');
      insert into actor(id, name) values ('lee', 'Lee');
      insert into kolab(id, owner_id, title) values ('kolab', 'konjir', 'Kolab');
      insert into node(id, kind, layer, title, kolab_id) values
        ('kolab', 'functional_spec', 'functional', 'Kolab', 'kolab'),
        ('kolab-binding', 'technical_binding', 'technical', 'Binding', 'kolab'),
        ('kolab-plan', 'wbs', 'technical', 'Plan', 'kolab');
      insert into version(id, node_id, seq, layer, state, actor_id, active_role) values
        ('s1', 'kolab', 1, 'functional', 'committed', 'lee', 'product');
      insert into element(version_id, element_id, ord, text, fingerprint) values ('s1', 'TEN1', 0, 'Konjir is one hosted service.', 'x');`);
    expect(await migrate(db)).toStrictEqual({ baselined: false, applied: versions.slice(at) });
    expect((await db.query(`select id, name, kolab_id from node order by id`)).rows).toStrictEqual([
      { id: 'kolab', name: 'kolab', kolab_id: 'kolab' },
      { id: 'kolab-binding', name: 'kolab-binding', kolab_id: 'kolab' },
      { id: 'kolab-plan', name: 'kolab-plan', kolab_id: 'kolab' },
    ]);
  }, store);
  expect(await withDb(schemaOf, store)).toStrictEqual(await currentSchema());

  const kolab = await TestKolab.open(store);
  try {
    // kj:kolab/kolab, the spec's own address (D15), resolves from anywhere.
    expect(await kolab.resolve('kj:kolab/kolab@1#TEN1', { system: 'shop' })).toMatchObject({ status: 'ok', content: 'Konjir is one hosted service.' });
    // 0027: the plan is a plan now, of its kolab's one binding, which binds its kolab's one spec (D77, D78).
    expect((await kolab.db.query(`select name, kind, parent_node_id from node order by name`)).rows).toStrictEqual([
      { name: 'kolab', kind: 'spec', parent_node_id: null },
      { name: 'kolab-binding', kind: 'binding', parent_node_id: 'kolab' },
      { name: 'kolab-plan', kind: 'plan', parent_node_id: 'kolab-binding' },
    ]);
    // Another kolab's binding may be called kolab-binding too, beside its own spec.
    await kolab.createKolab('shop', { owner: 'lee' });
    const pm = await kolab.openSession('lee', 'product', { kolab: 'shop' });
    await kolab.createNode(pm, 'spec', 'Shop', 'shop');
    await kolab.endSession(pm, { by: 'lee' });
    const s = await kolab.openSession('lee', 'engineer', { kolab: 'shop' });
    expect(await kolab.createNode(s, 'binding', 'Binding', 'kolab-binding')).toMatch(/^~[0-9A-Z]{26}$/);
    expect((await kolab.listNodes(undefined, 'kolab')).map((n) => n.name)).toStrictEqual(['kolab-binding', 'kolab-plan', 'kolab']);   // by kind, then name
  } finally { await kolab.close(); }
});

test('a database at 0010 reaches 0011: each session is stored by the hash of its token, and every token handed out keeps working', async () => {
  const store = await persistentStore();
  const at = MIGRATIONS.findIndex((x) => x.name === 'hashed_session_tokens');
  const lee = 'kjs_lee-token-from-before-hashing', pm = 'kjs_pm-token-from-before-hashing', old = 'kjs_ended-before-hashing';
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    // The test server before this release: Konjir's own kolab, Lee and her agent each with an open
    // session, whose ids are their bearer tokens, and an ended session.
    await db.exec(`
      insert into account(id, kind, name) values ('konjir', 'organization', 'Konjir'), ('lee', 'user', 'Lee');
      insert into actor(id, name) values ('lee', 'Lee');
      insert into actor(id, name, kind, owner_id) values ('lee-pm', 'lee-pm', 'agent', 'lee');
      insert into kolab(id, owner_id, title) values ('kolab', 'konjir', 'Kolab');
      insert into kolab_grant(kolab_id, user_id, level, functional, technical) values ('kolab', 'lee', 'write', true, true);
      insert into kolab_grant(kolab_id, agent_id, level, functional, technical) values ('kolab', 'lee-pm', 'write', true, false);
      insert into session(id, actor_id, active_role, kolab_id) values
        ('${lee}', 'lee', 'engineer', 'kolab'), ('${pm}', 'lee-pm', 'product', 'kolab');
      insert into session(id, actor_id, active_role, kolab_id, ended_at) values ('${old}', 'lee', 'product', 'kolab', now());`);
    expect(await migrate(db)).toStrictEqual({ baselined: false, applied: versions.slice(at) });
    // Only the hashes are left, each the session's sessionKey: no token is stored.
    expect((await db.query<{ id: string }>(`select id from session order by started_at, id`)).rows.map((r) => r.id).sort())
      .toStrictEqual([sessionKey(lee), sessionKey(pm), sessionKey(old)].sort());
    expect((await db.query(`select 1 from session where id like 'kjs_%'`)).rows).toStrictEqual([]);
    // And none can be stored again.
    expect(await rejection(db.query(`insert into session(id, actor_id, active_role, kolab_id, expires_at) values ('kjs_plain', 'lee', 'product', 'kolab', now() + interval '1 day')`)))
      .toMatch(/session_id_is_key/);
  }, store);
  expect(await withDb(schemaOf, store)).toStrictEqual(await currentSchema());

  const kolab = await TestKolab.open(store);
  try {
    // Both open tokens still work, the agent's included; whoami names each by its key, never its token.
    expect(await kolab.sessionOpen(lee)).toBe(true);
    expect(await kolab.sessionInfo(pm)).toMatchObject({ session: sessionKey(pm), actor: 'lee-pm', owner: 'lee', kolab: 'kolab' });
    expect(JSON.stringify(await kolab.sessionInfo(pm))).not.toContain(pm);
    expect(await kolab.sessionOpen(old)).toBe(false);
    // The hash itself is no token.
    expect(await kolab.sessionOpen(sessionKey(pm))).toBe(false);
    expect(await kolab.sessionInfo(lee)).toMatchObject({ session: sessionKey(lee), actor: 'lee', role: 'engineer' });
    // Lee's session ends by her actor, since an admin who didn't keep a token can't name it by one.
    expect(await kolab.endSession({ actor: 'lee' })).toBe(sessionKey(lee));
    expect(await kolab.sessionOpen(lee)).toBe(false);
    // The agent writes with its old token, and Lee, in a new session, reviews it.
    const reviewer = await kolab.openSession('lee', 'product');
    const spec = await kolab.createNode(pm, 'spec', 'Kolab', 'kolab');
    await commitReviewed(kolab, pm, reviewer, spec, { elements: els({ TEN1: 'Konjir is one hosted service.' }) });
    // Ending a migrated session by its token tells listeners by the same key.
    const ended: string[] = [];
    kolab.onEvent((e) => { if ('session' in e) ended.push(e.id); });
    expect(await kolab.endSession(pm)).toBe(sessionKey(pm));
    expect(ended).toStrictEqual([sessionKey(pm)]);
    expect(await kolab.sessionOpen(pm)).toBe(false);
  } finally { await kolab.close(); }
});

test('a database reaches the rulings migration: rows made before it keep their unknown dates, and every new ruling is dated, says what it does and is a person\'s', async () => {
  const store = await persistentStore();
  const at = MIGRATIONS.findIndex((x) => x.name === 'rulings_and_case_files');
  expect(at).toBeGreaterThan(MIGRATIONS.findIndex((x) => x.name === 'durable_waits'));
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    // No verb wrote these tables before, so what is there was written by hand, with no dates.
    await db.exec(`
      insert into account(id, kind, name) values ('konjir', 'organization', 'Konjir'), ('lee', 'user', 'Lee');
      insert into actor(id, name) values ('lee', 'Lee');
      insert into actor(id, name, kind, owner_id) values ('lee-pm', 'Lee PM', 'agent', 'lee');
      insert into kolab(id, owner_id, title) values ('kolab', 'konjir', 'Kolab');
      insert into node(id, name, kind, layer, title, kolab_id) values ('kolab', 'kolab', 'functional_spec', 'functional', 'Kolab', 'kolab');
      insert into version(id, node_id, seq, layer, state, actor_id, active_role) values ('s1', 'kolab', 1, 'functional', 'committed', 'lee', 'product');
      insert into case_file(id, version_id, element_id, state) values ('c1', 's1', 'CASE4', 'ruled');
      insert into position(id, case_file_id, actor_id, claim, evidence) values ('p1', 'c1', 'lee-pm', 'Dates matter.', '{"by": "hand"}');
      insert into ruling(id, case_file_id, actor_id, verdict, text) values ('r1', 'c1', 'lee-pm', 'sustained', 'Record the date.');
      insert into ruling(id, version_id, element_id, actor_id, text) values ('d16', 's1', 'CASE3', 'lee', 'A ruling can stand without a case file.');`);
    expect(await migrate(db, { migrations: MIGRATIONS.slice(0, at + 1) })).toStrictEqual({ baselined: false, applied: [versions[at]] });
    // Nothing is guessed: their dates and effects stay unknown, and the agent's old ruling stays.
    expect((await db.query(`select id, ruled_at, effect from ruling order by id`)).rows).toStrictEqual([
      { id: 'd16', ruled_at: null, effect: null }, { id: 'r1', ruled_at: null, effect: null },
    ]);
    expect((await db.query(`select id, opened_at, opened_by from case_file`)).rows).toStrictEqual([{ id: 'c1', opened_at: null, opened_by: null }]);
    // Every new one is dated by the database, says what it does (CASE6), and is a person's (CASE2).
    await db.query(`insert into ruling(id, version_id, actor_id, text, effect) values ('d50', 's1', 'lee', 'Complete it all.', 'change_intent')`);
    expect((await db.query<{ ruled_at: Date | string }>(`select ruled_at from ruling where id = 'd50'`)).rows[0].ruled_at).not.toBeNull();
    expect(await rejection(db.query(`insert into ruling(id, version_id, actor_id, text) values ('x1', 's1', 'lee', 'No effect.')`))).toMatch(/ruling_has_effect/);
    expect(await rejection(db.query(`insert into ruling(id, version_id, actor_id, text, effect) values ('x2', 's1', 'lee-pm', 'An agent.', 'keep_intent')`)))
      .toMatch(/lee-pm is not a person/);
    expect(await rejection(db.query(`insert into ruling(id, version_id, actor_id, text, effect) values ('x3', 's1', 'lee', 'Bad.', 'perhaps')`)))
      .toMatch(/ruling_effect_check/);
    // A case file is ruled on once, and a new one says who opened it on what question.
    expect(await rejection(db.query(`insert into ruling(id, case_file_id, actor_id, text, effect) values ('x4', 'c1', 'lee', 'Again.', 'keep_intent')`)))
      .toMatch(/one_ruling_per_case_file/);
    expect(await rejection(db.query(`insert into case_file(id, version_id, element_id) values ('c2', 's1', 'CASE1')`))).toMatch(/case_file_opened/);
    expect(await rejection(db.query(`update ruling set text = 'Rewritten.' where id = 'd16'`))).toMatch(/a ruling never changes once given/);
    expect((await migrate(db)).applied).toStrictEqual(versions.slice(at + 1));
  }, store);
  expect(await withDb(schemaOf, store)).toStrictEqual(await currentSchema());
});

test('a database reaches the archiving migration: nothing is archived, open sessions keep working, and an archive then ends them', async () => {
  const store = await persistentStore();
  const at = MIGRATIONS.findIndex((x) => x.name === 'archive_accounts');
  const lee = 'kjs_lee-token-before-archiving';
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(`
      insert into account(id, kind, name) values ('konjir', 'organization', 'Konjir'), ('lee', 'user', 'Lee');
      insert into actor(id, name) values ('lee', 'Lee');
      insert into kolab(id, owner_id, title) values ('kolab', 'konjir', 'Kolab');
      insert into kolab_grant(kolab_id, user_id, level, functional, technical) values ('kolab', 'lee', 'write', true, true);
      insert into session(id, actor_id, active_role, kolab_id) values ('${sessionKey(lee)}', 'lee', 'product', 'kolab');`);
    expect(await migrate(db)).toStrictEqual({ baselined: false, applied: versions.slice(at) });
    expect((await db.query(`select 1 from kolab where archived_at is not null union all select 1 from account where archived_at is not null`)).rows).toStrictEqual([]);
  }, store);
  expect(await withDb(schemaOf, store)).toStrictEqual(await currentSchema());

  const kolab = await TestKolab.open(store);
  try {
    expect(await kolab.sessionInfo(lee)).toMatchObject({ actor: 'lee', kolab: 'kolab', access: { level: 'write' } });
    expect((await kolab.listKolabs()).map((k) => k.id)).toStrictEqual(['kolab']);
    expect(await kolab.archive({ organization: 'konjir' })).toMatchObject({ kolabs: ['kolab'], ended: 1 });
    expect(await kolab.sessionOpen(lee)).toBe(false);
  } finally { await kolab.close(); }
});

test('a database reaches the write-actors migration: rows made before it keep no actor, nothing is guessed, and every write after names one', async () => {
  const store = await persistentStore();
  const at = MIGRATIONS.findIndex((x) => x.name === 'write_actors');
  expect(at).toBe(MIGRATIONS.findIndex((x) => x.name === 'questions_in_review') + 1);
  const lee = 'kjs_lee-token-before-write-actors';
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(`
      insert into account(id, kind, name) values ('konjir', 'organization', 'Konjir'), ('lee', 'user', 'Lee');
      insert into actor(id, name) values ('lee', 'Lee');
      insert into kolab(id, owner_id, title) values ('kolab', 'konjir', 'Kolab');
      insert into kolab_grant(kolab_id, user_id, level, functional, technical) values ('kolab', 'lee', 'write', true, true);
      insert into node(id, name, kind, layer, title, kolab_id) values ('kolab', 'kolab', 'functional_spec', 'functional', 'Kolab', 'kolab');
      insert into session(id, actor_id, active_role, kolab_id) values ('${sessionKey(lee)}', 'lee', 'product', 'kolab');`);
    expect(await migrate(db, { migrations: MIGRATIONS.slice(0, at + 1) })).toStrictEqual({ baselined: false, applied: [versions[at]] });
    expect((await db.query(`select n.created_by as node, n.created_at, k.created_by as kolab, a.created_by as actor, o.created_by as account, s.opened_by
                              from node n, kolab k, actor a, account o, session s where o.id = 'lee'`)).rows)
      .toStrictEqual([{ node: null, created_at: null, kolab: null, actor: null, account: null, opened_by: null }]);
    expect((await db.query(`select count(*)::int as n from audit_event`)).rows).toStrictEqual([{ n: 0 }]);
    expect((await migrate(db)).applied).toStrictEqual(versions.slice(at + 1));
  }, store);
  expect(await withDb(schemaOf, store)).toStrictEqual(await currentSchema());

  const kolab = await TestKolab.open(store);
  try {
    // A session opened before it still works, and ending it records who did.
    expect(await kolab.sessionInfo(lee)).toMatchObject({ actor: 'lee', kolab: 'kolab' });
    await kolab.endSession(lee);
    expect((await kolab.db.query(`select opened_by, ended_by from session where id = $1`, [sessionKey(lee)])).rows).toStrictEqual([{ opened_by: null, ended_by: 'lee' }]);
    // Archiving an old actor or kolab still works: nothing about it is checked again.
    await kolab.archive({ kolab: 'kolab' });
    await kolab.unarchive({ kolab: 'kolab' });
  } finally { await kolab.close(); }
});

test("0024 refuses a database where an actor or account is named admin or kolab in any case, naming it", async () => {
  const at = MIGRATIONS.findIndex((x) => x.name === 'write_actors');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(`insert into account(id, kind, name) values ('Admin', 'user', 'A'), ('KOLAB', 'organization', 'K');
                   insert into actor(id, name) values ('Admin', 'A');`);
    expect(await rejection(migrate(db))).toMatch(/0024_write_actors\.sql failed: .*Admin, KOLAB names an actor or account, but 'admin' and 'kolab' are reserved/);
    expect((await recorded(db)).map((r) => r.version)).toStrictEqual(versions.slice(0, at));
  });
});

// ---- the runner, with migrations of the test's own ---------------------------------

const m = (version: number, sql: string): Migration => ({ version, name: `m${version}`, sql });
const m1 = m(1, `create table t (n int not null)`);
const m2 = m(2, `insert into t values (2)`);
const m3 = m(3, `insert into t values (3)`);

test('migrations are applied in version order, and each only once', async () => {
  await withDb(async (db) => {
    // Listed out of order: 0002 needs the table 0001 makes.
    expect(await migrate(db, { migrations: [m2, m1] })).toStrictEqual({ baselined: false, applied: [1, 2] });
    expect(await migrate(db, { migrations: [m1, m2] })).toStrictEqual({ baselined: false, applied: [] });
    expect(await migrate(db, { migrations: [m1, m2, m3] })).toStrictEqual({ baselined: false, applied: [3] });
    expect((await db.query(`select n from t order by n`)).rows).toStrictEqual([{ n: 2 }, { n: 3 }]);
    expect((await recorded(db)).map((r) => r.version)).toStrictEqual([1, 2, 3]);
  });
});

test('a migration that fails leaves the database as it was', async () => {
  await withDb(async (db) => {
    await migrate(db, { migrations: [m1] });
    expect(await rejection(migrate(db, { migrations: [m1, m2, m(3, `insert into nowhere values (1)`)] }))).toMatch(/^Error: migration 0003_m3\.sql failed: .*nowhere/);
    expect((await db.query(`select n from t`)).rows).toStrictEqual([]);
    expect((await recorded(db)).map((r) => r.version)).toStrictEqual([1]);
  });
});

test('a fresh database whose first migration fails gets no record at all', async () => {
  await withDb(async (db) => {
    await rejection(migrate(db, { migrations: [m(1, `select nonsense from nowhere`)] }));
    expect((await db.query<{ t: string | null }>(`select to_regclass('public.kj_migration')::text as t`)).rows[0].t).toBeNull();
  });
});

test('Kolab refuses a database that a newer release has migrated', async () => {
  await withDb(async (db) => {
    await migrate(db, { migrations: [m1, m2] });
    expect(await rejection(migrate(db, { migrations: [m1] }))).toMatch(/has migration 0002_m2\.sql, which this release of Kolab doesn't know/);
  });
});

test('checkMigrations passes a database at exactly these migrations, and refuses one migrate would change, writing nothing', async () => {
  await withDb(async (db) => {
    expect(await rejection(checkMigrations(db, { migrations: [m1] }))).toMatch(/no migration record \(kj_migration\)/);
    expect((await db.query<{ t: string | null }>(`select to_regclass('public.kj_migration')::text as t`)).rows[0].t).toBeNull();
    await migrate(db, { migrations: [m1] });
    await checkMigrations(db, { migrations: [m1] });
    expect(await rejection(checkMigrations(db, { migrations: [m1, m2] }))).toMatch(/lacks 0002_m2\.sql, which this release would apply/);
    expect((await db.query(`select n from t`)).rows).toStrictEqual([]);
    expect((await recorded(db)).map((r) => r.version)).toStrictEqual([1]);
    await migrate(db, { migrations: [m1, m2] });
    expect(await rejection(checkMigrations(db, { migrations: [m1] }))).toMatch(/has migration 0002_m2\.sql, which this release of Kolab doesn't know/);
    expect(await rejection(checkMigrations(db, { migrations: [m1, m(2, `insert into t values (3)`)] }))).toMatch(/migration 0002_m2\.sql has changed/);
  });
});

test('Kolab opened without migrating refuses a database that needs a migration, and opens a current one unchanged', async () => {
  const fresh = await persistentStore();
  expect(await rejection(Kolab.open({ ...fresh, migrate: false }))).toMatch(/no migration record/);
  await withDb(async (db) => {
    expect((await db.query<{ t: string | null }>(`select to_regclass('public.kj_migration')::text as t`)).rows[0].t).toBeNull();
  }, fresh);

  const store = await persistentStore();
  await withDb((db) => migrate(db), store);
  const kolab = await Kolab.open({ ...store, migrate: false });
  try {
    expect((await recorded(kolab.db)).map((r) => r.version)).toStrictEqual(versions);
  } finally {
    await kolab.close();
  }
});

test('the baseline runs only on a database that has Kolab tables', async () => {
  await withDb(async (db) => {
    // No node table: fresh, so no baseline even though one is given.
    expect(await migrate(db, { migrations: [m1], baseline: `select nonsense from nowhere` })).toStrictEqual({ baselined: false, applied: [1] });
  });
  expect(BASELINE).toMatch(/add column if not exists/);
});

test('Kolab processes opening one database at once migrate it once', async () => {
  const store = await persistentStore();
  if (store.databaseUrl) {
    // Separate pools, as separate processes would have: the advisory lock makes the others wait.
    const opened = await Promise.all([1, 2, 3, 4].map(() => TestKolab.open(store)));
    try {
      expect((await recorded(opened[0].db)).map((r) => r.version)).toStrictEqual(versions);
      await opened[1].addActor('alice');
      expect((await opened[3].db.query(`select id from actor`)).rows).toStrictEqual([{ id: 'alice' }]);
    } finally { for (const k of opened) await k.close(); }
  } else {
    // PGlite is one process's database, so the race is within one connection's queue.
    await withDb(async (db) => {
      const results = await Promise.all([migrate(db), migrate(db), migrate(db)]);
      expect(results.map((r) => r.applied)).toStrictEqual([versions, [], []]);
      expect((await recorded(db)).map((r) => r.version)).toStrictEqual(versions);
    }, store);
  }
});

// ---- review findings: misnamed files, edited files, grants, transaction control -------

/**
 * A migrations folder of the test's own. Every .sql file is pinned in checksums.json, as the
 * loader requires, unless `pins` says otherwise.
 */
function migrationsDir(files: Record<string, string>, pins?: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  const pinned = pins ?? Object.fromEntries(Object.entries(files).filter(([f]) => /\.sql$/i.test(f)).map(([f, sql]) => [f, checksum(sql)]));
  writeFileSync(join(dir, 'checksums.json'), JSON.stringify(pinned));
  return { url: pathToFileURL(`${dir}/`), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function loadFrom(files: Record<string, string>, pins?: Record<string, string>) {
  const dir = migrationsDir(files, pins);
  try { return loadMigrations(dir.url); } finally { dir.done(); }
}

test('a misnamed .sql file in the migrations directory is an error, not skipped', () => {
  for (const bad of ['0002_add-query-kind-index.sql', '0002_AddIndex.sql', '0002_add_index.SQL', '2_add_index.sql']) {
    const dir = migrationsDir({ '0001_first.sql': 'create table t (n int)', 'baseline.sql': 'select 1', [bad]: 'select 1', 'notes.txt': 'not sql' });
    try {
      expect(() => loadMigrations(dir.url)).toThrow(`${bad} isn't named NNNN_lower_snake_case.sql`);
    } finally { dir.done(); }
  }
  const good = migrationsDir({ '0001_first.sql': 'select 1', '0002_second_one.sql': 'select 2', 'baseline.sql': 'select 0', 'notes.txt': '' });
  try {
    expect(loadMigrations(good.url).map((m) => `${m.version} ${m.name}`)).toStrictEqual(['1 first', '2 second_one']);
  } finally { good.done(); }
});

test('Kolab refuses a database whose applied migration has since been edited, naming the file', async () => {
  await withDb(async (db) => {
    await migrate(db, { migrations: [m1, m2] });
    const edited = m(1, `create table t (n int not null, email text)`);
    expect(await rejection(migrate(db, { migrations: [edited, m2] })))
      .toMatch(/migration 0001_m1\.sql has changed since it was applied to this database/);
  });
});

test('editing the shipped 0001 is caught on a baselined database too', async () => {
  await withDb(async (db) => {
    await db.exec(BEFORE_MIGRATIONS);
    await migrate(db);
    const edited = { ...MIGRATIONS[0], sql: `${MIGRATIONS[0].sql}\nalter table actor add column email text;` };
    expect(await rejection(migrate(db, { migrations: [edited, ...MIGRATIONS.slice(1)] }))).toMatch(/0001_schema\.sql has changed/);
  });
});

test('a later migration granting on all tables leaves kj_migration alike on fresh and upgraded databases', async () => {
  const grantAll = m(versions.length + 1, `grant select on all tables in schema public to kj_agent, kj_system`);
  const later = [...MIGRATIONS, grantAll];
  const acl = async (db: Db) => (await db.query<{ acl: string | null }>(
    `select relacl::text as acl from pg_class where oid = 'kj_migration'::regclass`)).rows[0].acl ?? '';
  const fresh = await withDb(async (db) => { await migrate(db, { migrations: later }); return { acl: await acl(db), schema: await schemaOf(db) }; });
  const upgraded = await withDb(async (db) => {
    await migrate(db);
    expect((await migrate(db, { migrations: later })).applied).toStrictEqual([grantAll.version]);
    return { acl: await acl(db), schema: await schemaOf(db) };
  });
  expect(upgraded).toStrictEqual(fresh);
  expect(fresh.acl).not.toMatch(/kj_agent|kj_system|[{,]=/);
});

test('a migration that controls the transaction is refused before anything runs', async () => {
  for (const sql of [
    'create table t (n int); commit; create table u (n int)',
    'BEGIN; create table t (n int)',
    'create table t (n int);\n  rollback',
    'savepoint s; create table t (n int)',
    'release s',
    'end',
    'start transaction',
  ]) {
    await withDb(async (db) => {
      expect(await rejection(migrate(db, { migrations: [m(1, sql)] }))).toMatch(/0001_m1\.sql controls the transaction/);
      expect((await db.query<{ t: string | null }>(`select to_regclass('public.t')::text as t`)).rows[0].t).toBeNull();
    });
  }
  const dir = migrationsDir({ '0001_first.sql': 'create table t (n int);\ncommit;' });
  try { expect(() => loadMigrations(dir.url)).toThrow('0001_first.sql controls the transaction'); } finally { dir.done(); }
});

test('begin, end and commit inside comments, strings and dollar-quoted bodies are not transaction control', () => {
  expect(statements(`
    -- commit; begin;
    /* rollback; */
    do $$ begin create role r; exception when others then null; end $$;
    create function f() returns text language sql as $body$ select 'commit;' $body$;
    insert into t values ('it''s; commit'), ("end;");
  `).map((s) => s.split(/\s+/)[0])).toStrictEqual(['do', 'create', 'insert']);
  // The shipped files pass, which loading them at import already proved.
  expect(MIGRATIONS.length).toBeGreaterThan(0);
  expect(BASELINE.length).toBeGreaterThan(0);
});

test('every shipped migration file matches its pinned checksum, and every file is pinned', () => {
  // Databases already record these files' checksums. Changing a pin means every one of them
  // stops opening, so a new migration adds a pin and never changes one (README.md, "Changing the schema").
  const dir = new URL('../../db/src/migrations/', import.meta.url);
  const pinned = JSON.parse(readFileSync(new URL('checksums.json', dir), 'utf8')) as Record<string, string>;
  const files = readdirSync(dir).filter((f) => /\.sql$/i.test(f)).sort();
  expect(Object.keys(pinned).sort()).toStrictEqual(files);
  for (const file of files) {
    expect(`${file} ${checksum(readFileSync(new URL(file, dir), 'utf8'))}`).toBe(`${file} ${pinned[file]}`);
  }
  expect(pinned['0001_schema.sql']).toBe('a2cc436568d0741b06261fe0f79e2b389f5a490668cebd731c66105bcf664947');
});

test("an escape string's backslashed quote doesn't hide transaction control", () => {
  expect(statements(String.raw`select E'\''; commit; select 'x';`).map((s) => s.split(/\s+/)[0])).toStrictEqual(['select', 'commit', 'select']);
  expect(statements(String.raw`select e'a\\'; commit`).map((s) => s.split(/\s+/)[0])).toStrictEqual(['select', 'commit']);
  // An identifier ending in e, followed by a plain string, is not an escape string.
  expect(statements(String.raw`select name'\'; commit; select '\'`).map((s) => s.split(/\s+/)[0])).toStrictEqual(['select', 'commit', 'select']);
});

test("a $ inside an identifier doesn't start a dollar quote that hides transaction control", () => {
  expect(statements('select 1 as q$t$; commit; select 1 as r$t$;').map((s) => s.split(/\s+/)[0])).toStrictEqual(['select', 'commit', 'select']);
  expect(statements('select $t$ a; commit $t$; commit').map((s) => s.split(/\s+/)[0])).toStrictEqual(['select', 'commit']);
});

test('nested block comments are skipped whole', () => {
  expect(statements('/* outer /* inner */ still a comment; commit; */ select 1').map((s) => s.split(/\s+/)[0])).toStrictEqual(['select']);
});

test('Kolab loads only files pinned in checksums.json, and only as pinned', () => {
  const files = { '0001_first.sql': 'select 1', '0002_add_x.sql': 'select 2', 'baseline.sql': 'select 0' };
  const pins = Object.fromEntries(Object.entries(files).map(([f, sql]) => [f, checksum(sql)]));
  expect(loadFrom(files, pins).map((m) => m.version)).toStrictEqual([1, 2]);

  // A draft left in the working tree, which the release would zip.
  const { '0002_add_x.sql': _draft, ...shipped } = pins;
  expect(thrown(() => loadFrom(files, shipped))).toMatch(/0002_add_x\.sql isn't in checksums\.json; add its sha256 there to ship it/);
  // A shipped file edited, even by a comment, and an edited baseline.
  expect(thrown(() => loadFrom({ ...files, '0001_first.sql': 'select 1 -- tidied' }, pins))).toMatch(/0001_first\.sql doesn't match its sha256 in checksums\.json/);
  expect(thrown(() => loadFrom({ ...files, 'baseline.sql': 'select 00' }, pins))).toMatch(/baseline\.sql doesn't match its sha256/);
  // A shipped file deleted, and no pins at all.
  const { '0002_add_x.sql': _gone, ...fewer } = files;
  expect(thrown(() => loadFrom(fewer, pins))).toMatch(/checksums\.json pins 0002_add_x\.sql, which is missing/);
  const bare = mkdtempSync(join(tmpdir(), 'konjir-migrations-'));
  try { expect(thrown(() => loadMigrations(pathToFileURL(`${bare}/`)))).toMatch(/can't read checksums\.json/); } finally { rmSync(bare, { recursive: true }); }
});

test('two migrations with the same number are named, not reported as a gap', () => {
  expect(thrown(() => loadFrom({ '0001_a.sql': 'select 1', '0002_b.sql': 'select 2', '0002_c.sql': 'select 3' })))
    .toMatch(/0002_b\.sql and 0002_c\.sql share version 2; renumber the newer one/);
});

test('a failing baseline names baseline.sql, and keeps the cause', async () => {
  await withDb(async (db) => {
    await db.exec(BEFORE_MIGRATIONS);
    let error: Error | undefined;
    try { await migrate(db, { baseline: 'alter table nowhere add column x int' }); } catch (e) { error = e as Error; }
    expect(String(error)).toMatch(/^Error: migration baseline\.sql failed: .*nowhere/);
    expect(String(error!.cause)).toMatch(/nowhere/);
    expect((await db.query<{ t: string | null }>(`select to_regclass('public.kj_migration')::text as t`)).rows[0].t).toBeNull();
  });
});

test('a begin atomic function body is refused, with the dollar-quoted way to write it', async () => {
  const atomic = 'create function f() returns int language sql begin atomic select 1; end;';
  await withDb(async (db) => {
    expect(await rejection(migrate(db, { migrations: [m(1, atomic)] })))
      .toMatch(/0001_m1\.sql controls the transaction \(end\).*write the body dollar-quoted/);
    const quoted = 'create function f() returns int language sql as $$ select 1 $$;';
    expect((await migrate(db, { migrations: [m(1, quoted)] })).applied).toStrictEqual([1]);
  });
});

test('databases on one cluster each migrate, with the kj_ roles another one made', async () => {
  // On Postgres the roles are the cluster's: the first database made them, and the second finds them.
  const [a, b] = [await persistentStore(), await persistentStore()];
  await withDb(async (db) => { await migrate(db); }, a);
  await withDb(async (db) => {
    expect((await migrate(db)).applied).toStrictEqual(versions);
    // Kolab's login can still switch into both.
    await db.transaction(async (tx) => { await tx.exec('set local role kj_agent'); await tx.exec('set local role kj_system'); });
  }, b);
});

test('on Postgres, the suite runs as a login that is not a superuser, as on RDS', async () => {
  await withDb(async (db, store) => {
    if (!store.databaseUrl) return;   // PGlite: closed before its first query, which closes it all the same
    const r = await db.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
      `select rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user`);
    expect(r.rows[0]).toStrictEqual({ rolsuper: false, rolcreaterole: true, rolcreatedb: true });
  });
});

// ---- 0027: typed konstruct kinds (W4.1; D77, D78, D79) ---------------------------------------

/** One element row, with its real fingerprint, as Kolab writes it. */
const elRow = (version: string, id: string, ord: number, text: string) => `('${version}', '${id}', ${ord}, '${text}', '${fingerprint(text)}')`;
/** One link row, pinned to its target's text as it was linked. */
const edgeRow = (id: string, kind: string, source: string, sourceEl: string | null, target: string, targetEl: string, text: string, heldBy = 'mirror-engineer') =>
  `('${id}', '${kind}', '${source}', ${sourceEl === null ? 'null' : `'${sourceEl}'`}, '${target}', '${targetEl}', '${fingerprint(text)}', '${heldBy}')`;
const V = 'insert into version(id, node_id, seq, base_version_id, layer, state, actor_id, active_role, submitted_by) values';
const N = 'insert into node(id, name, kind, layer, title, kolab_id, created_by) values';
const E = 'insert into element(version_id, element_id, ord, text, fingerprint) values';
const L = 'insert into edge(id, kind, source_version_id, source_element_id, target_version_id, target_element_id, target_fingerprint, held_by) values';

/**
 * Production as 0026 leaves it, by its shapes: Konjir's own kolab with its spec, its binding, its
 * plan (a wbs) and a prototype, the binding with a version in review; the demo walkthrough's two
 * kolabs (a spec and its binding; a spec alone, whose node name another kolab has); a kolab with
 * two bindings whose wbs links one; an archived kolab with a spec, a binding and a wbs; and a
 * superseded plan version that linked the spec directly, before D78.
 */
const BEFORE_KINDS = `
  insert into account(id, kind, name, created_by) values ('konjir', 'organization', 'Konjir', 'admin'), ('lee', 'user', 'Lee', 'admin'),
    ('acme-r1', 'organization', 'Acme', 'admin'), ('globex-r1', 'organization', 'Globex', 'admin');
  insert into actor(id, name, created_by) values ('lee', 'Lee', 'admin');
  insert into actor(id, name, kind, owner_id, created_by) values ('mirror-product', 'mirror-product', 'agent', 'konjir', 'admin'),
    ('mirror-engineer', 'mirror-engineer', 'agent', 'konjir', 'admin');
  insert into kolab(id, owner_id, title, created_by) values ('kolab', 'konjir', 'Kolab', 'admin'), ('acme-demo-r1', 'acme-r1', 'Acme', 'admin'),
    ('globex-demo-r1', 'globex-r1', 'Globex', 'admin'), ('lab', 'lee', 'Lab', 'admin'), ('old', 'lee', 'Old', 'admin');
  ${N} ('kolab', 'kolab', 'functional_spec', 'functional', 'Kolab — Functional Spec', 'kolab', 'admin'),
    ('kolab-binding', 'kolab-binding', 'technical_binding', 'technical', 'Kolab — Technical Binding', 'kolab', 'admin'),
    ('kolab-plan', 'kolab-plan', 'wbs', 'technical', 'Kolab — Plan', 'kolab', 'admin'),
    ('kolab-page', 'kolab-page', 'prototype', 'functional', 'Konjir Kolab', 'kolab', 'admin'),
    ('invitations', 'invitations', 'functional_spec', 'functional', 'Team invitations', 'acme-demo-r1', 'admin'),
    ('invitations-binding', 'invitations-binding', 'technical_binding', 'technical', 'Team invitations on Node', 'acme-demo-r1', 'admin'),
    ('~01JG0000000000000000000000', 'invitations', 'functional_spec', 'functional', 'Globex invitations', 'globex-demo-r1', 'admin'),
    ('lab-spec', 'lab-spec', 'functional_spec', 'functional', 'Lab', 'lab', 'admin'),
    ('lab-api', 'lab-api', 'technical_binding', 'technical', 'Lab API', 'lab', 'admin'),
    ('lab-ui', 'lab-ui', 'technical_binding', 'technical', 'Lab UI', 'lab', 'admin'),
    ('lab-plan', 'lab-plan', 'wbs', 'technical', 'Lab API plan', 'lab', 'admin'),
    ('old-spec', 'old-spec', 'functional_spec', 'functional', 'Old', 'old', 'admin'),
    ('old-binding', 'old-binding', 'technical_binding', 'technical', 'Old binding', 'old', 'admin'),
    ('old-plan', 'old-plan', 'wbs', 'technical', 'Old plan', 'old', 'admin');
  ${V} ('s1', 'kolab', 1, null, 'functional', 'committed', 'mirror-product', 'product', 'mirror-product'),
    ('s2', 'kolab', 2, 's1', 'functional', 'committed', 'mirror-product', 'product', 'mirror-product'),
    ('b1', 'kolab-binding', 1, null, 'technical', 'committed', 'mirror-engineer', 'engineer', 'mirror-engineer'),
    ('b2', 'kolab-binding', 2, 'b1', 'technical', 'committed', 'mirror-engineer', 'engineer', 'mirror-engineer'),
    ('b3', 'kolab-binding', 3, 'b2', 'technical', 'in_review', 'mirror-engineer', 'engineer', 'mirror-engineer'),
    ('w1', 'kolab-plan', 1, null, 'technical', 'committed', 'mirror-engineer', 'engineer', 'mirror-engineer'),
    ('w2', 'kolab-plan', 2, 'w1', 'technical', 'committed', 'mirror-engineer', 'engineer', 'mirror-engineer'),
    ('k1', 'kolab-page', 1, null, 'functional', 'committed', 'mirror-product', 'product', 'mirror-product'),
    ('ai1', 'invitations', 1, null, 'functional', 'committed', 'mirror-product', 'product', 'mirror-product'),
    ('ab1', 'invitations-binding', 1, null, 'technical', 'committed', 'mirror-engineer', 'engineer', 'mirror-engineer'),
    ('gi1', '~01JG0000000000000000000000', 1, null, 'functional', 'committed', 'mirror-product', 'product', 'mirror-product'),
    ('ls1', 'lab-spec', 1, null, 'functional', 'committed', 'lee', 'product', 'lee'),
    ('la1', 'lab-api', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee'),
    ('lu1', 'lab-ui', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee'),
    ('lp1', 'lab-plan', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee'),
    ('os1', 'old-spec', 1, null, 'functional', 'committed', 'lee', 'product', 'lee');
  ${E} ${elRow('s1', 'TEN1', 0, 'Konjir is one hosted service.')}, ${elRow('s1', 'KON1', 1, 'A kolab holds specs.')},
    ${elRow('s2', 'TEN1', 0, 'Konjir is one hosted service.')}, ${elRow('s2', 'KON1', 1, 'A kolab holds exactly one functional spec.')},
    ${elRow('b1', 'TEN-DATA', 0, 'Every row carries its kolab.')}, ${elRow('b2', 'TEN-DATA', 0, 'Every row carries its kolab.')},
    ${elRow('b2', 'KON-MODEL', 1, 'Node kinds are free labels.')},
    ${elRow('b3', 'TEN-DATA', 0, 'Every row carries its kolab.')}, ${elRow('b3', 'KON-MODEL', 1, 'Node kinds are typed.')},
    ${elRow('w1', 'W1.3', 0, 'Accounts and kolabs.')}, ${elRow('w2', 'W1.3', 0, 'Accounts and kolabs.')}, ${elRow('w2', 'W4.1', 1, 'Typed konstruct kinds.')},
    ${elRow('k1', 'home', 0, 'https://claude.ai/artifact/99doLyY9QFgZZkENDb4GNa')},
    ${elRow('ai1', 'R1', 0, 'An admin invites a teammate by email.')}, ${elRow('ab1', 'b1', 0, 'An invites table.')},
    ${elRow('gi1', 'R1', 0, 'Globex invites by link.')}, ${elRow('ls1', 'R1', 0, 'Lab runs.')},
    ${elRow('la1', 'a1', 0, 'An API.')}, ${elRow('lu1', 'u1', 0, 'A page.')}, ${elRow('lp1', 'p1', 0, 'Build the API.')},
    ${elRow('os1', 'R1', 0, 'Old runs.')};
  ${L} ${edgeRow('e-b1', 'dependency', 'b1', 'TEN-DATA', 's1', 'TEN1', 'Konjir is one hosted service.')},
    ${edgeRow('e-b2', 'dependency', 'b2', 'TEN-DATA', 's2', 'TEN1', 'Konjir is one hosted service.')},
    ${edgeRow('e-b2k', 'dependency', 'b2', 'KON-MODEL', 's2', 'KON1', 'A kolab holds exactly one functional spec.')},
    ${edgeRow('e-b3', 'dependency', 'b3', 'TEN-DATA', 's2', 'TEN1', 'Konjir is one hosted service.')},
    ${edgeRow('e-b3k', 'dependency', 'b3', 'KON-MODEL', 's2', 'KON1', 'A kolab holds exactly one functional spec.')},
    ${edgeRow('e-w1', 'dependency', 'w1', 'W1.3', 's1', 'TEN1', 'Konjir is one hosted service.')},
    ${edgeRow('e-w2', 'dependency', 'w2', 'W1.3', 'b2', 'TEN-DATA', 'Every row carries its kolab.')},
    ${edgeRow('e-w2k', 'dependency', 'w2', 'W4.1', 'b2', 'KON-MODEL', 'Node kinds are free labels.')},
    ${edgeRow('e-k1', 'equivalence', 'k1', 'home', 's2', 'TEN1', 'Konjir is one hosted service.', 'mirror-product')},
    ${edgeRow('e-ab1', 'dependency', 'ab1', 'b1', 'ai1', 'R1', 'An admin invites a teammate by email.')},
    ${edgeRow('e-la1', 'dependency', 'la1', 'a1', 'ls1', 'R1', 'Lab runs.', 'lee')},
    ${edgeRow('e-lu1', 'dependency', 'lu1', 'u1', 'ls1', 'R1', 'Lab runs.', 'lee')},
    ${edgeRow('e-lp1', 'dependency', 'lp1', 'p1', 'la1', 'a1', 'An API.', 'lee')};
  update kolab set archived_at = now() where id = 'old';`;

/** Every row of a database's Konjir data but the nodes, to show a migration lost nothing. */
async function konjirRows(db: Db) {
  const rows: Record<string, unknown[]> = {};
  for (const [t, key] of [['version', 'id'], ['element', 'version_id, element_id'], ['edge', 'id'], ['delta', 'id'], ['invalidation', 'id'], ['query', 'id'],
    ['kolab', 'id'], ['account', 'id'], ['actor', 'id']] as const) {
    rows[t] = (await db.query(`select * from ${t} order by ${key}`)).rows;
  }
  return rows;
}

test('a database at 0026 reaches 0027: each node is mapped by its label, wbs becomes plan, each binding names its spec and each plan its binding, and nothing else changes', async () => {
  const store = await persistentStore();
  const at = MIGRATIONS.findIndex((x) => x.name === 'konstruct_kinds');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(BEFORE_KINDS);
    const before = await konjirRows(db);
    const nodesBefore = (await db.query<Record<string, unknown>>(`select * from node order by id`)).rows;
    // The preflight finds nothing to refuse, and says which parent 0027 will give each node and why.
    const { refusals, parents } = await preflight0027(db);
    expect(refusals).toStrictEqual([]);
    expect(parents.filter((p) => p.kolab_id === 'kolab' || p.kolab_id === 'lab')).toStrictEqual([
      { kolab_id: 'kolab', node: 'kolab-binding', kind: 'binding', parent: 'kolab', how: 'its kolab\'s one spec' },
      { kolab_id: 'kolab', node: 'kolab-plan', kind: 'plan', parent: 'kolab-binding', how: 'the one binding its links reach' },
      { kolab_id: 'lab', node: 'lab-api', kind: 'binding', parent: 'lab-spec', how: 'its kolab\'s one spec' },
      { kolab_id: 'lab', node: 'lab-ui', kind: 'binding', parent: 'lab-spec', how: 'its kolab\'s one spec' },
      { kolab_id: 'lab', node: 'lab-plan', kind: 'plan', parent: 'lab-api', how: 'the one binding its links reach' },
    ]);
    expect(await migrate(db, { migrations: MIGRATIONS.slice(0, at + 1) })).toStrictEqual({ baselined: false, applied: [versions[at]] });
    // Each parent is the one the preflight named.
    const given = (await db.query<{ name: string; parent: string }>(`select n.name, p.name as parent from node n join node p on p.id = n.parent_node_id`)).rows;
    expect(given.map((g) => `${g.name}>${g.parent}`).sort()).toStrictEqual(parents.map((p) => `${p.node}>${p.parent}`).sort());
    expect((await db.query(`select kolab_id, name, kind, layer, parent_node_id from node order by kolab_id, name`)).rows).toStrictEqual([
      { kolab_id: 'acme-demo-r1', name: 'invitations', kind: 'spec', layer: 'functional', parent_node_id: null },
      { kolab_id: 'acme-demo-r1', name: 'invitations-binding', kind: 'binding', layer: 'technical', parent_node_id: 'invitations' },
      { kolab_id: 'globex-demo-r1', name: 'invitations', kind: 'spec', layer: 'functional', parent_node_id: null },
      { kolab_id: 'kolab', name: 'kolab', kind: 'spec', layer: 'functional', parent_node_id: null },
      { kolab_id: 'kolab', name: 'kolab-binding', kind: 'binding', layer: 'technical', parent_node_id: 'kolab' },
      { kolab_id: 'kolab', name: 'kolab-page', kind: 'prototype', layer: 'functional', parent_node_id: null },
      { kolab_id: 'kolab', name: 'kolab-plan', kind: 'plan', layer: 'technical', parent_node_id: 'kolab-binding' },
      // Of lab's two bindings, the plan's links deliver lab-api's alone: that is its binding.
      { kolab_id: 'lab', name: 'lab-api', kind: 'binding', layer: 'technical', parent_node_id: 'lab-spec' },
      { kolab_id: 'lab', name: 'lab-plan', kind: 'plan', layer: 'technical', parent_node_id: 'lab-api' },
      { kolab_id: 'lab', name: 'lab-spec', kind: 'spec', layer: 'functional', parent_node_id: null },
      { kolab_id: 'lab', name: 'lab-ui', kind: 'binding', layer: 'technical', parent_node_id: 'lab-spec' },
      // An archived kolab's nodes are mapped too, and it stays archived.
      { kolab_id: 'old', name: 'old-binding', kind: 'binding', layer: 'technical', parent_node_id: 'old-spec' },
      { kolab_id: 'old', name: 'old-plan', kind: 'plan', layer: 'technical', parent_node_id: 'old-binding' },
      { kolab_id: 'old', name: 'old-spec', kind: 'spec', layer: 'functional', parent_node_id: null },
    ]);
    // No data lost: every other row is as it was, and each node differs only in its kind's name (D77, D95) and its new parent.
    expect(await konjirRows(db)).toStrictEqual(before);
    const relabel = (n: Record<string, unknown>) => ({ ...n, kind: ({ wbs: 'plan', functional_spec: 'spec', technical_binding: 'binding' } as Record<string, string>)[n.kind as string] ?? n.kind });
    expect((await db.query<Record<string, unknown>>(`select * from node order by id`)).rows.map(({ parent_node_id: _, ...n }) => n)).toStrictEqual(nodesBefore.map(relabel));
    // The archived kolab still refuses every write.
    expect(await rejection(db.query(`update node set title = 'x' where id = 'old-spec'`))).toMatch(/kolab old is archived/);
  }, store);
  // The migrations after 0027 then bring it to the schema a fresh database reaches.
  expect(await withDb(async (db) => { await migrate(db); return schemaOf(db); }, store)).toStrictEqual(await currentSchema());

  const kolab = await TestKolab.open(store);
  try {
    // Kolab works on what was migrated: the mirror agents write the spec, its binding and its plan (D47's actors).
    await kolab.grant('kolab', 'mirror-product', 'write', { layers: ['functional'] });
    await kolab.grant('kolab', 'mirror-engineer', 'write', { layers: ['technical'] });
    const pm = await kolab.openSession('mirror-product', 'product', { kolab: 'kolab' });
    const eng = await kolab.openSession('mirror-engineer', 'engineer', { kolab: 'kolab' });
    expect(await rejection(kolab.createNode(pm, 'spec', 'A second spec', 'kolab-2'))).toMatch(/kolab kolab already holds its spec, kolab/);
    expect(await rejection(kolab.createNode(eng, 'plan', 'A second plan', 'kolab-plan-2'))).toMatch(/binding kolab-binding already has its plan, kolab-plan/);
    // A spec change flags the binding element that serves it, the work package that delivers that,
    // and the prototype's screen that shows it (M4's done-when, D93).
    await kolab.commit(pm, 'kolab', { elements: els({ TEN1: 'Konjir is one hosted service, at kolab.konjir.com.', KON1: 'A kolab holds exactly one functional spec.' }) });
    const on = async (node: string) => (await marksOn(kolab, node)).map((m) => [m.element_id, m.reason]);
    // The binding's committed version, and its version in review, which carries the same link.
    expect((await marksOn(kolab, 'kolab-binding')).map((m) => [m.version_id, m.element_id, m.reason]).sort()).toStrictEqual([['b2', 'TEN-DATA', 'changed'], ['b3', 'TEN-DATA', 'changed']]);
    expect(await on('kolab-plan')).toStrictEqual([['W1.3', 'upstream_dirty']]);
    expect(await on('kolab-page')).toStrictEqual([['home', 'changed']]);
    // The plan delivers the binding's elements, never the spec (KON6, D78).
    const plan = (await kolab.latestCommitted('kolab-plan'))!.id;
    expect(await rejection(kolab.link(eng, { kind: 'dependency', source: plan, sourceElement: 'W4.1', target: (await kolab.latestCommitted('kolab'))!.id, targetElement: 'KON1' })))
      .toMatch(/kolab-plan is a plan: its work packages deliver elements of its own binding, never the spec/);
    // The binding's version in review is as it was.
    expect((await kolab.version('b3')).state).toBe('in_review');
    // Listings and reads name each node's parent.
    expect((await kolab.listNodes(undefined, 'kolab')).map((n) => [n.name, n.kind, n.parent])).toStrictEqual([
      ['kolab-binding', 'binding', 'kolab'], ['kolab-plan', 'plan', 'kolab-binding'], ['kolab-page', 'prototype', null], ['kolab', 'spec', null],
    ]);
    expect((await kolab.readNode(eng, 'kolab-plan')).parent).toBe('kolab-binding');
  } finally { await kolab.close(); }
});

/** deploy/preflight/0027.sql, run as it ships: its refusals (no rows when 0027 applies) and the parents it infers. */
const PREFLIGHT_0027 = readFileSync(new URL('../../../deploy/preflight/0027.sql', import.meta.url), 'utf8');
async function preflight0027(db: Db) {
  const [refusals, parents] = PREFLIGHT_0027.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.replace(/^--.*$/gm, '').trim());
  return {
    refusals: (await db.query<{ ord: number; why: string; nodes: string }>(refusals)).rows,
    parents: (await db.query<{ kolab_id: string; node: string; kind: string; parent: string; how: string }>(parents)).rows,
  };
}

test('the preflight runs 0027\'s own check and its own inference of parents, text for text', () => {
  const migration = MIGRATIONS.find((x) => x.name === 'konstruct_kinds')!.sql;
  const block = (sql: string, name: string) => [...sql.matchAll(new RegExp(`-- ${name}:begin\\n([\\s\\S]*?)-- ${name}:end`, 'g'))].map((m) => m[1]);
  for (const name of ['check', 'parents']) {
    const ours = block(migration, name);
    expect(ours).toHaveLength(1);
    expect(block(PREFLIGHT_0027, name)).toStrictEqual(ours);
  }
  // The inference the check reasons about is the one the migration applies.
  expect(block(migration, 'check')[0].startsWith(block(migration, 'parents')[0])).toBe(true);
});

/** Migrates a fresh database to 0026, runs `seed`, then expects 0027 to stop with `refusal` and change nothing. */
async function refuses0027(seed: string, refusal: RegExp) {
  const at = MIGRATIONS.findIndex((x) => x.name === 'konstruct_kinds');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(seed);
    const before = await konjirRows(db);
    const nodes = (await db.query(`select * from node order by id`)).rows;
    // The preflight predicts it: it finds a refusal, and so does 0027.
    expect((await preflight0027(db)).refusals.length).toBeGreaterThan(0);
    expect(await rejection(migrate(db))).toMatch(new RegExp(`0027_konstruct_kinds\\.sql failed: migration 0027: .*${refusal.source}`, 'i'));
    expect((await recorded(db)).map((r) => r.version)).toStrictEqual(versions.slice(0, at));
    expect(await konjirRows(db)).toStrictEqual(before);
    expect((await db.query(`select * from node order by id`)).rows).toStrictEqual(nodes);
  });
}

const BASE_0026 = `
  insert into account(id, kind, name, created_by) values ('lee', 'user', 'Lee', 'admin');
  insert into actor(id, name, created_by) values ('lee', 'Lee', 'admin');
  insert into kolab(id, owner_id, title, created_by) values ('shop', 'lee', 'Shop', 'admin'), ('mall', 'lee', 'Mall', 'admin');`;

test('0027 refuses, naming them, nodes that are a work_package or an implementation: neither is a kind any more (D77, KON5, KON7)', async () => {
  await refuses0027(`${BASE_0026} ${N} ('wp1', 'wp1', 'work_package', 'technical', 'WP', 'shop', 'lee'), ('impl', 'impl', 'implementation', 'technical', 'I', 'mall', 'lee');`,
    /a node's kind is now one of spec, prototype, binding or plan \(D77, D95\).*These nodes have no kind to map to: mall\/impl \(implementation\), shop\/wp1 \(work_package\)\. Decide what each becomes\./);
});

test('0027 refuses a kolab with more than one spec, naming them: it won\'t choose which is the spec (KON1)', async () => {
  await refuses0027(`${BASE_0026} ${N} ('a', 'a', 'functional_spec', 'functional', 'A', 'shop', 'lee'), ('b', 'b', 'functional_spec', 'functional', 'B', 'shop', 'lee'),
      ('c', 'c', 'functional_spec', 'functional', 'C', 'mall', 'lee');`,
    /a kolab holds exactly one spec \(KON1, D77\), and these hold more: kolab shop: a, b\. Kolab won't choose which is the spec/);
});

test('0027 refuses a binding whose kolab holds no spec (D78)', async () => {
  await refuses0027(`${BASE_0026} ${N} ('b', 'b', 'technical_binding', 'technical', 'B', 'shop', 'lee'), ('s', 's', 'functional_spec', 'functional', 'S', 'mall', 'lee');`,
    /each binding names the spec it binds \(D78\), but these bindings' kolabs hold no spec: shop\/b\./);
});

test('0027 refuses a plan whose binding can\'t be told: no links and several bindings, none at all, or links into more than one (D78)', async () => {
  const two = `${BASE_0026} ${N} ('s', 's', 'functional_spec', 'functional', 'S', 'shop', 'lee'), ('b1', 'b1', 'technical_binding', 'technical', 'B1', 'shop', 'lee'),
      ('b2', 'b2', 'technical_binding', 'technical', 'B2', 'shop', 'lee'), ('w', 'w', 'wbs', 'technical', 'W', 'shop', 'lee');`;
  await refuses0027(two, /each plan names the binding it plans \(D78\), and these plans' bindings can't be told: shop\/w\./);
  await refuses0027(`${BASE_0026} ${N} ('s', 's', 'functional_spec', 'functional', 'S', 'shop', 'lee'), ('w', 'w', 'wbs', 'technical', 'W', 'shop', 'lee');`,
    /these plans' bindings can't be told: shop\/w\./);
  await refuses0027(`${two}
    ${V} ('b1v', 'b1', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee'), ('b2v', 'b2', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee'),
      ('wv', 'w', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee');
    ${E} ${elRow('b1v', 'x', 0, 'X.')}, ${elRow('b2v', 'y', 0, 'Y.')}, ${elRow('wv', 'w1', 0, 'Build X.')}, ${elRow('wv', 'w2', 1, 'Build Y.')};
    ${L} ${edgeRow('e1', 'dependency', 'wv', 'w1', 'b1v', 'x', 'X.', 'lee')}, ${edgeRow('e2', 'dependency', 'wv', 'w2', 'b2v', 'y', 'Y.', 'lee')};`,
  /these plans' bindings can't be told: shop\/w\./);
});

test('0027 refuses two plans of one binding (KON5)', async () => {
  await refuses0027(`${BASE_0026} ${N} ('s', 's', 'functional_spec', 'functional', 'S', 'shop', 'lee'), ('b', 'b', 'technical_binding', 'technical', 'B', 'shop', 'lee'),
      ('w1', 'w1', 'wbs', 'technical', 'W1', 'shop', 'lee'), ('w2', 'w2', 'wbs', 'technical', 'W2', 'shop', 'lee');`,
    /a binding has at most one plan \(KON5, D96\), and these bindings would have more: shop\/b: w1, w2\./);
});

test('0027 refuses a live link outside its parent, a plan\'s into the spec or a binding\'s into another kolab\'s spec; a superseded version\'s is history (D78, KON6)', async () => {
  const seed = `${BASE_0026}
    ${N} ('s', 's', 'functional_spec', 'functional', 'S', 'shop', 'lee'), ('b', 'b', 'technical_binding', 'technical', 'B', 'shop', 'lee'),
      ('w', 'w', 'wbs', 'technical', 'W', 'shop', 'lee'), ('m', 'm', 'functional_spec', 'functional', 'M', 'mall', 'lee');
    ${V} ('sv', 's', 1, null, 'functional', 'committed', 'lee', 'product', 'lee'), ('bv', 'b', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee'),
      ('wv1', 'w', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee'), ('wv2', 'w', 2, 'wv1', 'technical', 'committed', 'lee', 'engineer', 'lee'),
      ('mv', 'm', 1, null, 'functional', 'committed', 'lee', 'product', 'lee');
    ${E} ${elRow('sv', 'R1', 0, 'S runs.')}, ${elRow('bv', 'b1', 0, 'A table.')}, ${elRow('wv1', 'W1', 0, 'Build it.')}, ${elRow('wv2', 'W1', 0, 'Build it.')},
      ${elRow('mv', 'M1', 0, 'M runs.')};
    ${L} ${edgeRow('e-b', 'dependency', 'bv', 'b1', 'sv', 'R1', 'S runs.', 'lee')},
      ${edgeRow('e-old', 'dependency', 'wv1', 'W1', 'sv', 'R1', 'S runs.', 'lee')},
      ${edgeRow('e-w', 'dependency', 'wv2', 'W1', 'bv', 'b1', 'A table.', 'lee')}`;
  // As it stands, it migrates: the plan's live version delivers the binding, and its superseded one's link into the spec is history.
  const at = MIGRATIONS.findIndex((x) => x.name === 'konstruct_kinds');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(`${seed};`);
    expect((await migrate(db, { migrations: MIGRATIONS.slice(0, at + 1) })).applied).toStrictEqual([versions[at]]);
  });
  // The plan's live version into the spec, or the binding's into another kolab's spec, stops it.
  await refuses0027(`${seed}, ${edgeRow('e-bad', 'dependency', 'wv2', 'W1', 'sv', 'R1', 'S runs.', 'lee')};`,
    /a plan's links deliver its own binding's elements, never the spec \(KON6, D78\).*These links don't: shop\/w@2#W1 -> shop\/s@1#R1\. Decide what each should link to/);
  await refuses0027(`${seed}, ${edgeRow('e-bad', 'dependency', 'bv', 'b1', 'mv', 'M1', 'M runs.', 'lee')};`,
    /These links don't: shop\/b@1#b1 -> mall\/m@1#M1\./);
});

test('0027 refuses a node whose layer isn\'t its kind\'s, naming it, rather than move it (KON8)', async () => {
  await refuses0027(`${BASE_0026} ${N} ('s', 's', 'functional_spec', 'technical', 'S', 'shop', 'lee');`,
    /a node's layer follows from its kind \(KON8, D77\), and these nodes' don't: shop\/s \(functional_spec in the technical layer\)/);
});

/** A spec with R1 and R2, its binding, and a wbs with a committed version that delivers the binding: what the review's probes started from. */
const PLAN_0026 = `${BASE_0026}
  ${N} ('s', 's', 'functional_spec', 'functional', 'S', 'shop', 'lee'), ('b', 'b', 'technical_binding', 'technical', 'B', 'shop', 'lee'),
    ('w', 'w', 'wbs', 'technical', 'W', 'shop', 'lee');
  ${V} ('sv', 's', 1, null, 'functional', 'committed', 'lee', 'product', 'lee'), ('bv', 'b', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee'),
    ('wv1', 'w', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee');
  ${E} ${elRow('sv', 'R1', 0, 'S runs.')}, ${elRow('sv', 'R2', 1, 'S ships.')}, ${elRow('bv', 'b1', 0, 'A table.')}, ${elRow('wv1', 'W1', 0, 'Build it.')};
  ${L} ${edgeRow('e-b', 'dependency', 'bv', 'b1', 'sv', 'R1', 'S runs.', 'lee')}, ${edgeRow('e-w1', 'dependency', 'wv1', 'W1', 'bv', 'b1', 'A table.', 'lee')}`;

test('an abandoned plan draft that linked the spec is history: 0027 applies, and a spec commit that leaves its element as it was re-pins it, and the cascade finishes (review H1)', async () => {
  const store = await persistentStore();
  const at = MIGRATIONS.findIndex((x) => x.name === 'konstruct_kinds');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    // w@2, drafted on w@1 and abandoned (rejected), linked spec element R2.
    await db.exec(`${PLAN_0026};
      ${V} ('wv2', 'w', 2, 'wv1', 'technical', 'rejected', 'lee', 'engineer', 'lee');
      ${E} ${elRow('wv2', 'W1', 0, 'Build it.')};
      ${L} ${edgeRow('e-w2', 'dependency', 'wv2', 'W1', 'sv', 'R2', 'S ships.', 'lee')};`);
    expect((await preflight0027(db)).refusals).toStrictEqual([]);
    expect((await migrate(db, { migrations: MIGRATIONS.slice(0, at + 1) })).applied).toStrictEqual([versions[at]]);
  }, store);
  const kolab = await TestKolab.open(store);
  try {
    const pm = await kolab.openSession('lee', 'product', { kolab: 'shop' });   // lee owns shop
    // R1 changes and R2 doesn't: the abandoned draft's link to R2 is re-pinned to s@2, an update the trigger lets through.
    await kolab.commit(pm, 's', { elements: els({ R1: 'S runs fast.', R2: 'S ships.' }) });
    const s2 = (await kolab.latestCommitted('s'))!.id;
    expect((await kolab.db.query(`select target_version_id from edge where id = 'e-w2'`)).rows).toStrictEqual([{ target_version_id: s2 }]);
    expect(await kolab.outboxJobs()).toStrictEqual([]);
    // The binding element is marked, and the plan's work package through it.
    expect((await marksOn(kolab, 'b')).map((m) => [m.element_id, m.reason])).toStrictEqual([['b1', 'changed']]);
    expect((await marksOn(kolab, 'w')).filter((m) => m.version_id === 'wv1').map((m) => [m.element_id, m.reason])).toStrictEqual([['W1', 'upstream_dirty']]);
    // A link can't be moved onto another source to get outside its parent, for any role.
    expect(await rejection(kolab.db.query(`update edge set source_version_id = 'wv1' where id = 'e-w2'`))).toMatch(/a plan's links deliver its own binding's elements/);
  } finally { await kolab.close(); }
});

test('a cascade still owed would carry an unchecked link: 0027 refuses until the outbox drains, then applies (review H2)', async () => {
  // w@1 linked the spec; w@2 delivers the binding, and its after_commit job, which copies w@1's links onto it, hasn't run.
  const owed = (state: string) => `${PLAN_0026};
    ${V} ('wv2', 'w', 2, 'wv1', 'technical', 'committed', 'lee', 'engineer', 'lee');
    ${E} ${elRow('wv2', 'W1', 0, 'Build it.')}, ${elRow('wv2', 'W2', 1, 'Ship it.')};
    ${L} ${edgeRow('e-old', 'dependency', 'wv1', 'W1', 'sv', 'R2', 'S ships.', 'lee')}, ${edgeRow('e-w2', 'dependency', 'wv2', 'W2', 'bv', 'b1', 'A table.', 'lee')};
    insert into outbox(id, kind, version_id, state) values ('01JOB', 'after_commit', 'wv2', '${state}');`;
  for (const state of ['pending', 'dead']) {
    await refuses0027(owed(state),
      /A cascade Kolab still owes \(an after_commit job in the outbox, waiting or dead\) would carry these links forward, and they break the same rules: shop\/w@1#W1 -> shop\/s@1#R2\. Let the outbox drain first/);
  }
  // Drained, w@2's links are its own (it never had w@1's), and its superseded version is history.
  const at = MIGRATIONS.findIndex((x) => x.name === 'konstruct_kinds');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(owed('pending'));
    await db.exec(`delete from outbox`);
    expect((await preflight0027(db)).refusals).toStrictEqual([]);
    expect((await migrate(db, { migrations: MIGRATIONS.slice(0, at + 1) })).applied).toStrictEqual([versions[at]]);
  });
});

test('the preflight names every refusal at once, in 0027\'s order, and 0027 reports each of them', async () => {
  const at = MIGRATIONS.findIndex((x) => x.name === 'konstruct_kinds');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(`${BASE_0026} ${N} ('a', 'a', 'functional_spec', 'functional', 'A', 'shop', 'lee'), ('a2', 'a2', 'functional_spec', 'functional', 'A2', 'shop', 'lee'),
      ('x', 'x', 'work_package', 'technical', 'X', 'shop', 'lee'), ('b', 'b', 'technical_binding', 'technical', 'B', 'mall', 'lee'),
      ('w1', 'w1', 'wbs', 'technical', 'W1', 'mall', 'lee'), ('w2', 'w2', 'wbs', 'technical', 'W2', 'mall', 'lee');`);
    expect((await preflight0027(db)).refusals).toStrictEqual([
      { ord: 1, why: 'not a kind', nodes: 'shop/x (work_package)' },
      { ord: 3, why: 'more than one spec', nodes: 'kolab shop: a, a2' },
      { ord: 4, why: 'binding with no spec', nodes: 'mall/b' },
      { ord: 6, why: 'two plans of one binding', nodes: 'mall/b: w1, w2' },
    ]);
    const said = await rejection(migrate(db));
    for (const s of ['These nodes have no kind to map to: shop/x', 'these hold more: kolab shop: a, a2', 'hold no spec: mall/b', 'would have more: mall/b: w1, w2']) expect(said).toContain(s);
  });
});

test('0027 refuses a live version that is a variant of another kind: a plan or a binding on a spec\'s version (D95, KON6); a prototype on the spec\'s is fine', async () => {
  const seed = `${BASE_0026}
    ${N} ('s', 's', 'functional_spec', 'functional', 'S', 'shop', 'lee'), ('b', 'b', 'technical_binding', 'technical', 'B', 'shop', 'lee'),
      ('u', 'u', 'prototype', 'functional', 'U', 'shop', 'lee'), ('w', 'w', 'wbs', 'technical', 'W', 'shop', 'lee');
    ${V} ('sv', 's', 1, null, 'functional', 'committed', 'lee', 'product', 'lee'), ('bv', 'b', 1, null, 'technical', 'committed', 'lee', 'engineer', 'lee');
    insert into version(id, node_id, seq, parent_version_id, layer, state, actor_id, active_role, submitted_by) values
      ('uv', 'u', 1, 'sv', 'functional', 'committed', 'lee', 'product', 'lee')`;
  const at = MIGRATIONS.findIndex((x) => x.name === 'konstruct_kinds');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    await db.exec(`${seed};`);
    expect((await preflight0027(db)).refusals).toStrictEqual([]);
    expect((await migrate(db, { migrations: MIGRATIONS.slice(0, at + 1) })).applied).toStrictEqual([versions[at]]);
  });
  await refuses0027(`${seed}, ('wv', 'w', 1, 'sv', 'technical', 'committed', 'lee', 'engineer', 'lee');`,
    /A variant is of its parent's kind, and only a prototype may be derived from the spec \(KON3, KON6, D95\), and these live versions aren't: shop\/w@1 \(wbs\) on shop\/s@1 \(functional_spec\)\./);
});

// ---- 0029: work-package fields (W5.1a; PLN1, PLN2, D98) ------------------------------------------

test('a database at 0028 reaches 0029: nothing is rewritten, every element and link keeps its fingerprint, a plan then takes work fields, and the release before 0029 refuses it (D98)', async () => {
  const store = await persistentStore();
  const kinds = MIGRATIONS.findIndex((x) => x.name === 'konstruct_kinds');
  const at = MIGRATIONS.findIndex((x) => x.name === 'work_fields');
  expect(MIGRATIONS[at].version).toBe(29);
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, kinds) });
    await db.exec(BEFORE_KINDS);
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    const before = await konjirRows(db);
    expect(await migrate(db, { migrations: MIGRATIONS.slice(0, at + 1) })).toStrictEqual({ baselined: false, applied: [29] });
    // Every element and delta gains an empty work column, and nothing else changes: fingerprints, links, versions.
    const after = await konjirRows(db);
    for (const t of ['element', 'delta'] as const) {
      expect(after[t].every((r) => (r as { work: unknown }).work === null)).toBe(true);
      after[t] = after[t].map((r) => { const { work: _w, ...rest } = r as Record<string, unknown>; return rest; });
    }
    expect(after).toStrictEqual(before);
    // The release before 0029 refuses the database now: going back means restoring a snapshot (README, "Deploying to AWS").
    expect(await rejection(migrate(db, { migrations: MIGRATIONS.slice(0, at) }))).toMatch(/has migration 0029_work_fields\.sql, which this release of Kolab doesn't know/);
    expect(await rejection(checkMigrations(db, { migrations: MIGRATIONS.slice(0, at) }))).toMatch(/has migration 0029_work_fields\.sql, which this release of Kolab doesn't know/);
  }, store);
  expect(await withDb(async (db) => { await migrate(db); return schemaOf(db); }, store)).toStrictEqual(await currentSchema());

  const kolab = await TestKolab.open(store);
  try {
    // Lee's lab plan, made before work fields, takes them: its link to the API binding is a Delivers that passes PLN2.
    const lee = await kolab.openSession('lee', 'engineer', { kolab: 'lab' });
    const r = await kolab.submit(lee, await kolab.draft(lee, 'lab-plan', { elements: [
      { id: 'p1', text: 'Build the API.', work: { done_when: 'The API answers.', size: 'M' } },
      { id: 'M1', text: 'Lab ships.', work: { milestone: true, depends_on: ['p1'], target_date: '2026-12-01' } },
    ] }));
    expect(r).toMatchObject({ ok: true });
    const lp2 = (await kolab.latestCommitted('lab-plan'))!.id;
    expect((await kolab.elements(lp2)).map((e) => [e.element_id, e.work])).toStrictEqual([
      ['p1', { done_when: 'The API answers.', size: 'M' }], ['M1', { depends_on: ['p1'], milestone: true, target_date: '2026-12-01' }],
    ]);
    // The version before keeps the fingerprint its element always had.
    expect((await kolab.elements('lp1'))[0].fingerprint).toBe(fingerprint('Build the API.'));
  } finally { await kolab.close(); }
});

/** deploy/preflight/0029.sql, as it ships: advisory, one query, rows (ord, why, nodes). */
const PREFLIGHT_0029 = readFileSync(new URL('../../../deploy/preflight/0029.sql', import.meta.url), 'utf8');

test('preflight 0029 is advisory, runs on a database at 0028, and names exactly the links PLN2 then refuses a plan\'s next version for (review: production impact)', async () => {
  expect(PREFLIGHT_0029.split('\n')[0]).toBe('-- advisory');
  // On a database at 0028, before work fields exist: it runs, and finds nothing in an empty one.
  const at = MIGRATIONS.findIndex((x) => x.name === 'work_fields');
  await withDb(async (db) => {
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    expect((await db.query(PREFLIGHT_0029)).rows).toStrictEqual([]);
  });
  // A plan with links written before PLN2: a derivation, one from the whole plan, one to the whole binding.
  const { kolab, product, engineer } = await setup();
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  await kolab.createNode(engineer, 'binding', 'Orders on Postgres', 'orders-pg');
  const b1 = await kolab.commit(engineer, 'orders-pg', { elements: els({ b1: 'A cancel endpoint.', b2: 'A queue.' }) });
  await kolab.createNode(engineer, 'plan', 'Plan', 'orders-plan');
  const w1 = await kolab.commit(engineer, 'orders-plan', { elements: els({ W1: 'Build it.', W2: 'Ship it.' }) });
  await kolab.link(engineer, { kind: 'dependency', source: w1, sourceElement: 'W2', target: b1, targetElement: 'b2' });   // a good one
  const fp = async (el: string | null) => ((await kolab.resolveIn(b1, el, null)) as { fingerprint: string }).fingerprint;
  await kolab.db.query(`insert into edge(id, kind, source_version_id, source_element_id, target_version_id, target_element_id, target_fingerprint, held_by)
                        values ('d1', 'derivation', $1, 'W1', $2, 'b1', $3, 'bob'), ('d2', 'dependency', $1, null, $2, 'b1', $3, 'bob'),
                               ('d3', 'dependency', $1, 'W2', $2, null, $4, 'bob')`, [w1, b1, await fp('b1'), await fp(null)]);
  expect((await kolab.db.query(PREFLIGHT_0029)).rows).toStrictEqual([
    { ord: 2, why: 'Delivers of another kind than dependency', nodes: 'test/orders-plan@1#W1 -> test/orders-pg@1#b1 [d1] derivation' },
    { ord: 3, why: 'Delivers from the whole plan version', nodes: 'test/orders-plan@1 -> test/orders-pg@1#b1 [d2]' },
    { ord: 4, why: 'Delivers to the whole binding', nodes: 'test/orders-plan@1#W2 -> test/orders-pg@1 [d3]' },
  ]);
  // The next version is refused for exactly those three, and nothing else.
  const draft = await kolab.draft(engineer, 'orders-plan', { elements: els({ W1: 'Build it well.', W2: 'Ship it.' }) });
  const r = await kolab.submit(engineer, draft);
  expect(r.note).toBe('Plan checks failed (PLN2): a link from the whole version to orders-pg@1#b1 delivers nothing: a Delivers is from a work package, an element (PLN1); '
    + 'W1 delivers orders-pg@1#b1 through a derivation link, and a Delivers is a dependency link (PLN1); '
    + 'W2 delivers orders-pg@1, and a Delivers names one binding element, at element scope, not the whole binding (PLN1, LNK3).');
  // The draft that unlinks them is what the preflight then finds clean, and it commits.
  await kolab.abandon(engineer, draft);
  const fixed = await kolab.draft(engineer, 'orders-plan', { elements: els({ W1: 'Build it well.', W2: 'Ship it.' }), unlink: [{ link: 'd1' }, { link: 'd2' }, { link: 'd3' }] });
  const rows = (await kolab.db.query<{ ord: number }>(PREFLIGHT_0029)).rows;
  // Only the committed version, whose next draft would carry them, is still named; the draft is clean.
  expect(rows.every((x) => !JSON.stringify(x).includes('orders-plan@2'))).toBe(true);
  expect(await kolab.submit(engineer, fixed)).toMatchObject({ ok: true });
  expect((await kolab.db.query(PREFLIGHT_0029)).rows).toStrictEqual([]);
});
