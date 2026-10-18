import { createHash } from 'node:crypto';
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
const BASELINE_FILE = 'baseline.sql';

/** A migration's file name, as errors and the README spell it. */
export const fileOf = (m: Pick<Migration, 'version' | 'name'>) => `${String(m.version).padStart(4, '0')}_${m.name}.sql`;

/** The sha256 of a migration's text, recorded when it's applied, so an edited file is caught. */
export const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

const PINS_FILE = 'checksums.json';

/**
 * Reads the numbered migrations in `dir`, in version order. Any other `.sql` file there is an
 * error, not something to skip, so a misnamed migration can't silently never run.
 *
 * Every `.sql` file, `baseline.sql` included, must match its sha256 in `checksums.json`. The
 * release zips the working tree, so this is what keeps a draft migration, or an edit to a
 * shipped one, from reaching a database: an unpinned or changed file stops Kolab loading.
 */
export function loadMigrations(dir: URL = DIR): Migration[] {
  let pins: Record<string, string>;
  try {
    pins = JSON.parse(readFileSync(new URL(PINS_FILE, dir), 'utf8')) as Record<string, string>;
  } catch (e) {
    throw new Error(`migrations: can't read ${PINS_FILE}: ${(e as Error).message}`, { cause: e });
  }
  const files = readdirSync(dir).filter((f) => /\.sql$/i.test(f)).sort();
  for (const file of Object.keys(pins)) {
    if (!files.includes(file)) throw new Error(`migrations: ${PINS_FILE} pins ${file}, which is missing`);
  }

  const migrations: Migration[] = [];
  for (const file of files) {
    const sql = readFileSync(new URL(file, dir), 'utf8');
    const match = FILE.exec(file);
    if (file !== BASELINE_FILE && !match) throw new Error(`migrations: ${file} isn't named NNNN_lower_snake_case.sql`);
    if (!pins[file]) throw new Error(`migrations: ${file} isn't in ${PINS_FILE}; add its sha256 there to ship it`);
    if (pins[file] !== checksum(sql)) {
      throw new Error(`migrations: ${file} doesn't match its sha256 in ${PINS_FILE}; a shipped migration must never change, so make the change in a new one`);
    }
    assertNoTransactionControl(file, sql);
    if (match) migrations.push({ version: Number(match[1]), name: match[2], sql });
  }
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    const prev = migrations[i - 1];
    if (prev?.version === m.version) {
      throw new Error(`migrations: ${fileOf(prev)} and ${fileOf(m)} share version ${m.version}; renumber the newer one`);
    }
    if (m.version !== i + 1) throw new Error(`migrations: expected version ${i + 1}, found ${fileOf(m)}`);
  });
  return migrations;
}

/**
 * The SQL's top-level statements, with comments, string literals, quoted identifiers and
 * dollar-quoted bodies (a `do` block's or a function's) blanked out.
 */
export function statements(sql: string): string[] {
  let out = '';
  let i = 0;
  const skipTo = (end: string, from: number) => { const j = sql.indexOf(end, from); return j < 0 ? sql.length : j + end.length; };
  // A letter, digit, _ or $ just before means we're inside an identifier, as in q$t$ or name'x'.
  const inWord = (at: number) => at > 0 && /[A-Za-z0-9_$]/.test(sql[at - 1]);
  while (i < sql.length) {
    const c = sql[i];
    const dollar = c === '$' && !inWord(i) ? /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i)) : null;
    const escape = (c === 'E' || c === 'e') && sql[i + 1] === "'" && !inWord(i);
    if (c === '-' && sql[i + 1] === '-') { i = skipTo('\n', i); out += ' '; }
    else if (c === '/' && sql[i + 1] === '*') {
      // Block comments nest in Postgres.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      out += ' ';
    }
    else if (c === "'" || c === '"' || escape) {
      // A doubled quote is an escaped one, so it just continues the literal. In an E'…' string a
      // backslash also escapes the next character.
      const q = escape ? "'" : c;
      let j = i + (escape ? 2 : 1);
      while (j < sql.length) {
        if (escape && sql[j] === '\\') j += 2;
        else if (sql[j] === q && sql[j + 1] === q) j += 2;
        else if (sql[j] === q) break;
        else j++;
      }
      i = j + 1;
      out += `${q}${q}`;
    }
    else if (dollar) { i = skipTo(dollar[0], i + dollar[0].length); out += ' $$ '; }
    else { out += c; i++; }
  }
  return out.split(';').map((s) => s.trim()).filter(Boolean);
}

const TRANSACTION_CONTROL = /^(begin|commit|rollback|end|abort|savepoint|release|start\s+transaction|prepare\s+transaction)\b/i;

/**
 * Every migration runs inside the runner's one transaction. A `commit` or `begin` in a file
 * would end it early, releasing the advisory lock and recording a half-applied database.
 */
export function assertNoTransactionControl(file: string, sql: string) {
  const bad = statements(sql).find((s) => TRANSACTION_CONTROL.test(s));
  if (bad) {
    const word = bad.split(/\s+/)[0];
    const hint = /^end$/i.test(word) ? `; if it ends a begin atomic function body, write the body dollar-quoted (as $$ … $$) instead` : '';
    throw new Error(`migrations: ${file} controls the transaction (${word}); the runner wraps every file in one transaction${hint}`);
  }
}

/** Every migration, in version order. */
export const MIGRATIONS: readonly Migration[] = loadMigrations();

/** Brings a database made before migrations began to migration 0001; see the file. loadMigrations checked its pin. */
export const BASELINE: string = readFileSync(new URL(BASELINE_FILE, DIR), 'utf8');

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
 * - **A recorded migration whose file has changed since, or that this release doesn't have:**
 *   Kolab refuses to open the database.
 */
export async function migrate(
  db: Db,
  { migrations: given = MIGRATIONS, baseline = BASELINE }: { migrations?: readonly Migration[]; baseline?: string } = {},
): Promise<MigrateResult> {
  const migrations = [...given].sort((a, b) => a.version - b.version);
  for (const m of migrations) assertNoTransactionControl(fileOf(m), m.sql);
  assertNoTransactionControl(BASELINE_FILE, baseline);

  return db.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock($1)`, [LOCK]);
    // This transaction is the migration runner's: a migration may backfill an archived kolab's rows,
    // which no other path may write (kj_migrating, 0014). Transaction-local, so it ends with it.
    await tx.query(`select set_config('kj.migrating', 'on', true)`);
    const tables = await tx.query<{ migrations: string | null; node: string | null }>(
      `select to_regclass('public.kj_migration')::text as migrations, to_regclass('public.node')::text as node`);
    const { migrations: recorded, node } = tables.rows[0];

    const done = new Set<number>();
    if (recorded) {
      const rows = (await tx.query<{ version: number; name: string; checksum: string }>(
        `select version, name, checksum from kj_migration order by version`)).rows;
      for (const r of rows) {
        const m = migrations.find((x) => x.version === r.version);
        if (!m) {
          throw new Error(`the database has migration ${fileOf(r)}, which this release of Kolab doesn't know; run a newer release`);
        }
        if (checksum(m.sql) !== r.checksum) {
          throw new Error(`migration ${fileOf(m)} has changed since it was applied to this database; ` +
            'restore the file as it shipped, and make the change in a new migration');
        }
        done.add(r.version);
      }
    }

    const first = migrations[0];
    const baselined = !recorded && !!node;
    if (baselined) {
      if (first?.version !== 1) throw new Error('migrations: a baseline needs migration 0001');
      await run(tx, BASELINE_FILE, baseline);
      done.add(first.version);
    }

    const applied: Migration[] = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await run(tx, fileOf(m), m.sql);
      applied.push(m);
    }

    if (!recorded) {
      await tx.exec(`
        create table kj_migration (
          version    int primary key,
          name       text not null,
          checksum   text not null,          -- sha256 of the file as applied
          baselined  boolean not null default false,
          applied_at timestamptz not null default now()
        )`);
    }
    const record = (m: Migration, isBaseline: boolean) => tx.query(
      `insert into kj_migration(version, name, checksum, baselined) values ($1, $2, $3, $4)`,
      [m.version, m.name, checksum(m.sql), isBaseline]);
    if (baselined) await record(first, true);
    for (const m of applied) await record(m, false);

    // A migration that grants on all tables would reach the record on a database that already had
    // it, but not on a fresh one. The record is Kolab's login's alone, on every database.
    await tx.exec(`
      revoke all on kj_migration from public;
      do $$ declare r text; begin
        foreach r in array array['kj_agent', 'kj_system'] loop
          if exists (select 1 from pg_roles where rolname = r) then
            execute format('revoke all on kj_migration from %I', r);
          end if;
        end loop;
      end $$`);
    return { baselined, applied: applied.map((m) => m.version) };
  });
}

/** Runs one file, so that its failure names it. */
async function run(tx: Db, file: string, sql: string) {
  try {
    await tx.exec(sql);
  } catch (e) {
    throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
  }
}
