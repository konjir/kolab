// Versioned migrations (DAT2): a fresh database and one made before migrations began both reach
// the current schema through the files, each migration runs once and in order, and Kolab
// processes opening one database together don't trip over each other.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@jest/globals';
import {
  BASELINE, MIGRATIONS, checksum, loadMigrations, migrate, openDb, statements, type Db, type Migration,
} from '@konjir/db';
import { Kolab, sessionKey } from '@konjir/engine';
import { els, people, persistentStore, rejection, testStore, thrown, type Store } from '@konjir/engine/testing';
import { ACCESS_LEVELS, ACCOUNT_KINDS, ACTOR_KINDS, MARK_REASONS, ORG_ROLES, QUERY_KINDS, VISIBILITIES } from '@konjir/types';

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

  const kolab = await Kolab.open(store);
  try {
    await people(kolab, 'alice');
    const product = await kolab.openSession('alice', 'product');
    await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
    await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  } finally { await kolab.close(); }
});

test("the database's value lists are @konjir/types' MARK_REASONS, QUERY_KINDS, ACTOR_KINDS, ACCOUNT_KINDS, ORG_ROLES, ACCESS_LEVELS and VISIBILITIES", async () => {
  // A new value in either list needs a migration that redefines the check (README.md, "Changing the schema").
  await withDb(async (db) => {
    await migrate(db);
    const check = async (name: string) => {
      const r = await db.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [name]);
      return [...r.rows[0].def.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
    };
    expect(await check('invalidation_reason_check')).toStrictEqual([...MARK_REASONS].sort());
    expect(await check('query_kind_check')).toStrictEqual([...QUERY_KINDS].sort());
    expect(await check('actor_kind_check')).toStrictEqual([...ACTOR_KINDS].sort());
    expect(await check('account_kind_check')).toStrictEqual([...ACCOUNT_KINDS].sort());
    expect(await check('org_member_role_check')).toStrictEqual([...ORG_ROLES].sort());
    expect(await check('kolab_grant_level_check')).toStrictEqual([...ACCESS_LEVELS].sort());
    expect(await check('kolab_base_permission_check')).toStrictEqual([...ACCESS_LEVELS].sort());
    expect(await check('kolab_visibility_check')).toStrictEqual([...VISIBILITIES].sort());
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

  const kolab = await Kolab.open(store);
  try {
    expect(await kolab.sessionInfo('kjs_old')).toStrictEqual({
      session: 'kjs_old', actor: 'lee', kind: 'person', owner: null, role: 'product', layer: 'functional',
      kolab: 'kolab', access: { level: 'write', layers: ['functional', 'technical'] },   // 0006
    });
    expect(await kolab.author('v1')).toStrictEqual({ actor: 'lee', kind: 'person', owner: null, role: 'product' });
    await kolab.addActor('lee-pm', { owner: 'lee' });
    await kolab.grant('kolab', 'lee-pm', 'write');
    const token = await kolab.openSession('lee-pm', 'product');   // beside Lee's own open session
    const v2 = await kolab.commit(token, 'orders', { elements: els({ R1: 'Orders can be cancelled within an hour.' }) });
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

  const kolab = await Kolab.open(store);
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
        ('P', 'functional_spec', 'functional', 'P'), ('V', 'functional_spec', 'functional', 'V'),
        ('W', 'functional_spec', 'functional', 'W'), ('X', 'functional_spec', 'functional', 'X'),
        ('Y', 'functional_spec', 'functional', 'Y');
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

  const kolab = await Kolab.open(store);
  try {
    expect((await kolab.openQueries()).find((q) => q.id === 'q0004_m3')?.question).toMatch(/^Rebasing onto the new parent failed; the reason was not recorded\./);
    // P's next commit rebases the variants, and each rebase that passes settles its mark.
    await kolab.commit('kjs_lee', 'P', { elements: els({ E1: 'Five.' }) });
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

  const kolab = await Kolab.open(store);
  try {
    // Open sessions keep working, in kolab, with the access everyone had before.
    expect(await kolab.sessionInfo('kjs_pm')).toMatchObject({ actor: 'lee-pm', owner: 'lee', kolab: 'kolab', access: { level: 'write', layers: ['functional', 'technical'] } });
    const v2 = await kolab.commit('kjs_pm', 'kolab', { elements: els({ TEN1: 'Konjir is one hosted service that every account shares.' }) });
    expect(await kolab.author(v2)).toStrictEqual({ actor: 'lee-pm', kind: 'agent', owner: 'lee', role: 'product' });
    expect((await kolab.listNodes(undefined, 'kolab')).map((n) => n.id)).toStrictEqual(['kolab', 'kolab-binding']);
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
    const opened = await Promise.all([1, 2, 3, 4].map(() => Kolab.open(store)));
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
