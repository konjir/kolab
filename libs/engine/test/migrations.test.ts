// Versioned migrations (DAT2): a fresh database and one made before migrations began both reach
// the current schema through the files, each migration runs once and in order, and Kolab
// processes opening one database together don't trip over each other.
import { expect, test } from '@jest/globals';
import { BASELINE, MIGRATIONS, migrate, openDb, type Db, type Migration } from '@konjir/db';
import { Kolab } from '@konjir/engine';
import { els, persistentStore, rejection, testStore, type Store } from '@konjir/engine/testing';
import { MARK_REASONS, QUERY_KINDS } from '@konjir/types';

const versions = MIGRATIONS.map((m) => m.version);

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
  return (await db.query<{ version: number; name: string; baselined: boolean }>(
    `select version, name, baselined from kj_migration order by version`)).rows;
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
    expect(await recorded(db)).toStrictEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name, baselined: false })));
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
    // What the test server's RDS database is: the schema of 0001, applied before migrations were recorded.
    await db.exec(MIGRATIONS[0].sql);
    await db.query(`insert into actor(id, name) values ('alice', 'Alice')`);

    expect(await migrate(db)).toStrictEqual({ baselined: true, applied: versions.slice(1) });
    expect((await recorded(db))[0]).toStrictEqual({ version: 1, name: 'schema', baselined: true });
    expect(await schemaOf(db)).toStrictEqual(current);
    expect((await db.query(`select id from actor`)).rows).toStrictEqual([{ id: 'alice' }]);
    // And again: nothing left to do.
    expect(await migrate(db)).toStrictEqual({ baselined: false, applied: [] });
  });
});

test('a database from release 0.5, before the query columns, is baselined and reaches the current schema', async () => {
  const current = await currentSchema();
  await withDb(async (db) => {
    await db.exec(MIGRATIONS[0].sql);
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
    expect(await rejection(migrate(db, { migrations: [m1] }))).toMatch(/has migration 2, which this release of Kolab doesn't know/);
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
