import { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery, Kysely, PostgresAdapter, PostgresDialect, PostgresIntrospector, PostgresQueryCompiler,
  type DatabaseConnection, type Dialect, type Driver, type QueryResult,
} from 'kysely';
import pg from 'pg';

/**
 * Kolab's database, reached through Kysely (DAT1): managed Postgres over pg in production,
 * PGlite in tests and local development. The engine speaks raw SQL with positional
 * parameters, for its recursive walks and row-level security.
 */
export interface Db {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Runs one or more statements that take no parameters. */
  exec(text: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres when `databaseUrl` is given; otherwise PGlite, persisted to `dataDir` or in memory. */
export function openDb(opts: { databaseUrl?: string; dataDir?: string } = {}): Db {
  const dialect = opts.databaseUrl
    ? new PostgresDialect({ pool: pool(opts.databaseUrl) })
    : new PGliteDialect(opts.dataDir ? new PGlite(opts.dataDir) : new PGlite());
  return new KyselyDb(new Kysely<unknown>({ dialect }));
}

function pool(connectionString: string) {
  const p = new pg.Pool({ connectionString });
  // An idle connection the server drops (a restart, a failover) is replaced on next use; unhandled,
  // its error would end the process.
  p.on('error', (e) => console.error(`postgres: idle connection lost: ${e.message}`));
  return p;
}

class KyselyDb implements Db {
  constructor(private readonly k: Kysely<unknown>) {}

  async query<R>(text: string, params: unknown[] = []) {
    const r = await this.k.executeQuery<R>(CompiledQuery.raw(text, params));
    return { rows: r.rows ?? [] };
  }

  async exec(text: string) {
    // With no parameters, pg and PGlite both use the simple protocol, which allows several statements.
    await this.k.executeQuery(CompiledQuery.raw(text, []));
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.k.transaction().execute((trx) => fn(new KyselyDb(trx)));
  }

  close() { return this.k.destroy(); }
}

// ---------------------------------------------------------------------------
// PGlite for Kysely. PGlite is one connection, so the driver hands it out to one
// query or transaction at a time.
// ---------------------------------------------------------------------------

class PGliteDialect implements Dialect {
  constructor(private readonly pglite: PGlite) {}
  createAdapter() { return new PostgresAdapter(); }
  createDriver() { return new PGliteDriver(this.pglite); }
  createIntrospector(db: Kysely<unknown>) { return new PostgresIntrospector(db); }
  createQueryCompiler() { return new PostgresQueryCompiler(); }
}

class PGliteDriver implements Driver {
  private readonly connection: PGliteConnection;
  private queue: Promise<void> = Promise.resolve();
  private release?: () => void;

  constructor(private readonly pglite: PGlite) { this.connection = new PGliteConnection(pglite); }

  async init() { await this.pglite.waitReady; }

  async acquireConnection() {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise((resolve) => { release = resolve; });
    await previous;
    this.release = release;
    return this.connection;
  }

  async releaseConnection() {
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  async beginTransaction(c: DatabaseConnection) { await c.executeQuery(CompiledQuery.raw('begin')); }
  async commitTransaction(c: DatabaseConnection) { await c.executeQuery(CompiledQuery.raw('commit')); }
  async rollbackTransaction(c: DatabaseConnection) { await c.executeQuery(CompiledQuery.raw('rollback')); }

  async destroy() { await this.pglite.close(); }
}

class PGliteConnection implements DatabaseConnection {
  constructor(private readonly pglite: PGlite) {}

  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    if (q.parameters.length === 0) {
      const last = (await this.pglite.exec(q.sql)).at(-1);
      return { rows: (last?.rows ?? []) as R[], numAffectedRows: affected(last?.affectedRows) };
    }
    const r = await this.pglite.query<R>(q.sql, [...q.parameters]);
    return { rows: r.rows, numAffectedRows: affected(r.affectedRows) };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('PGlite connections do not stream');
  }
}

const affected = (n: number | undefined) => (n === undefined ? undefined : BigInt(n));
