// Versioned migrations (DAT2): a fresh database and one made before migrations began both reach
// the current schema through the files, each migration runs once and in order, and Kolab
// processes opening one database together don't trip over each other.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@jest/globals';
import {
  BASELINE, MIGRATIONS, checksum, loadMigrations, migrate, openDb, statements, type Db, type Migration,
} from '@konjir/db';
import { Kolab } from '@konjir/engine';
import { els, persistentStore, rejection, testStore, type Store } from '@konjir/engine/testing';
import { MARK_REASONS, QUERY_KINDS } from '@konjir/types';

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
    await kolab.addActor('alice');
    const product = await kolab.openSession('alice', 'product');
    await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
    await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  } finally { await kolab.close(); }
});

test("the database's value lists are @konjir/types' MARK_REASONS and QUERY_KINDS", async () => {
  // A new value in either list needs a migration that redefines the check (README.md, "Changing the schema").
  await withDb(async (db) => {
    await migrate(db);
    const check = async (name: string) => {
      const r = await db.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [name]);
      return [...r.rows[0].def.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
    };
    expect(await check('invalidation_reason_check')).toStrictEqual([...MARK_REASONS].sort());
    expect(await check('query_kind_check')).toStrictEqual([...QUERY_KINDS].sort());
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
    expect(await rejection(migrate(db, { migrations: [m1, m2, m(3, `insert into nowhere values (1)`)] }))).toMatch(/nowhere/);
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

function migrationsDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return { url: pathToFileURL(`${dir}/`), done: () => rmSync(dir, { recursive: true, force: true }) };
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
