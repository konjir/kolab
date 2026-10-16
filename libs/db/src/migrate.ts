import { readdirSync, readFileSync } from 'node:fs';
import type { Db } from './connect.js';

/** One schema change: `migrations/NNNN_name.sql`, applied once, in version order (DAT2). */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * The migration files beside this module. They sit in `src/migrations` and the build copies
 * them to `dist/migrations`, so they're found whether Kolab runs its source or its build.
 */
const DIR = new URL('./migrations/', import.meta.url);
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Reads the numbered migrations in `dir`, in version order. */
export function loadMigrations(dir: URL = DIR): Migration[] {
  const migrations = readdirSync(dir)
    .map((file) => FILE.exec(file))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(([file, version, name]) => ({
      version: Number(version),
      name,
      sql: readFileSync(new URL(file, dir), 'utf8'),
    }))
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations: expected version ${i + 1}, found ${m.version}_${m.name}`);
  });
  return migrations;
}

/** Every migration, in version order. */
export const MIGRATIONS: readonly Migration[] = loadMigrations();

/** Brings a database made before migrations began to migration 0001; see the file. */
export const BASELINE: string = readFileSync(new URL('baseline.sql', DIR), 'utf8');

/**
 * Advisory locks are scoped to one database, so this key serializes Kolab processes migrating
 * the same database and no others on the cluster.
 */
const LOCK = 0x4b4a_0002; // "KJ", 2

export interface MigrateResult {
  /** True when the database predated migrations and the baseline ran. */
  baselined: boolean;
  /** The versions this call applied, in order. */
  applied: number[];
}

/**
 * Brings the database to the newest migration. Everything runs in one transaction that holds
 * an advisory lock, so a second process opening the same database waits, then finds the work
 * done; and a failing migration leaves the database as it was.
 *
 * - **No `kj_migration` table and no `node` table:** a fresh database. Every migration runs.
 * - **`node` but no `kj_migration`:** a database made before migrations began. The baseline
 *   brings it to 0001, which is recorded as baselined, and the later migrations run.
 * - **A recorded version this release doesn't have:** a newer release migrated it, and this
 *   one refuses to run on it.
 */
export async function migrate(
  db: Db,
  { migrations: given = MIGRATIONS, baseline = BASELINE }: { migrations?: readonly Migration[]; baseline?: string } = {},
): Promise<MigrateResult> {
  const migrations = [...given].sort((a, b) => a.version - b.version);
  return db.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock($1)`, [LOCK]);
    const tables = await tx.query<{ migrations: string | null; node: string | null }>(
      `select to_regclass('public.kj_migration')::text as migrations, to_regclass('public.node')::text as node`);
    const { migrations: recorded, node } = tables.rows[0];

    const done = new Set<number>();
    if (recorded) {
      for (const r of (await tx.query<{ version: number }>(`select version from kj_migration`)).rows) done.add(r.version);
      const known = new Set(migrations.map((m) => m.version));
      const unknown = [...done].filter((v) => !known.has(v)).sort((a, b) => a - b);
      if (unknown.length) {
        throw new Error(`the database has migration ${unknown.join(', ')}, which this release of Kolab doesn't know; run a newer release`);
      }
    }

    const first = migrations[0];
    const baselined = !recorded && !!node;
    if (baselined) {
      if (first?.version !== 1) throw new Error('migrations: a baseline needs migration 0001');
      await tx.exec(baseline);
      done.add(first.version);
    }

    const applied: number[] = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await tx.exec(m.sql);
      applied.push(m.version);
    }

    // Made after the migrations, so 0001's grants on every table never reach it: the record is Kolab's alone.
    if (!recorded) {
      await tx.exec(`
        create table kj_migration (
          version    int primary key,
          name       text not null,
          baselined  boolean not null default false,
          applied_at timestamptz not null default now()
        )`);
    }
    if (baselined) await tx.query(`insert into kj_migration(version, name, baselined) values ($1, $2, true)`, [first.version, first.name]);
    for (const v of applied) {
      await tx.query(`insert into kj_migration(version, name) values ($1, $2)`, [v, migrations.find((m) => m.version === v)!.name]);
    }
    return { baselined, applied };
  });
}
