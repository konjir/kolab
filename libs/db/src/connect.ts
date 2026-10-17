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
  /**
   * NOTIFY `channel` with `payload`, through @onivoro/server-pg-notify's `buildNotifyQuery`.
   * Call it on a transaction's Db: Postgres delivers the notification when that transaction
   * commits, and never if it rolls back. A payload too long for NOTIFY (8000 bytes) is sent as
   * `oversized(payload)` instead. On PGlite, which is one process with no one else to tell, it
   * does nothing.
   */
  notify(channel: string, payload: string, oversized: (payload: string) => string): Promise<void>;
  /**
   * Hear `channel` on one connection of its own, apart from the pool, through
   * @onivoro/server-pg-notify's `NotificationListener`, which re-establishes it when it's lost.
   * `fn` gets each payload, parsed as JSON; it should check what it gets, since anyone who can
   * connect to the database can NOTIFY. Whatever `fn` throws is logged, without the payload,
   * and goes no further. The connection is named `application_name` (at most 63 bytes), so
   * `connected` can find it. Resolves once the LISTEN is in place, and rejects, leaving nothing
   * behind, if it can't be. On PGlite it resolves to undefined: nothing else can write to its
   * database.
   */
  listen(channel: string, fn: (payload: unknown) => void, opts: { applicationName: string }): Promise<Listening | undefined>;
  close(): Promise<void>;
}

export interface Listening {
  /**
   * Whether the listening connection is up now, as Postgres sees it: a backend with its
   * application_name exists. While it's down, notifications are missed.
   */
  connected(): Promise<boolean>;
  close(): Promise<void>;
}

/** Postgres when `databaseUrl` is given; otherwise PGlite, persisted to `dataDir` or in memory. */
export function openDb(opts: { databaseUrl?: string; dataDir?: string } = {}): Db {
  if (opts.databaseUrl) {
    return new KyselyDb(new Kysely<unknown>({ dialect: new PostgresDialect({ pool: pool(opts.databaseUrl) }) }), opts.databaseUrl);
  }
  const pglite = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  return new KyselyDb(new Kysely<unknown>({ dialect: new PGliteDialect(pglite) }), undefined, pglite);
}

// Loaded on first use, on Postgres only: its listener brings in NestJS's logger and pg-listen,
// which PGlite and the CLI's client verbs never need.
let pgNotify: Promise<typeof import('@onivoro/server-pg-notify')> | undefined;
const loadPgNotify = () => (pgNotify ??= import('@onivoro/server-pg-notify'));

function pool(connectionString: string) {
  const p = new pg.Pool({ connectionString });
  // An idle connection the server drops (a restart, a failover) is replaced on next use; unhandled,
  // its error would end the process.
  p.on('error', (e) => console.error(`postgres: idle connection lost: ${e.message}`));
  return p;
}

class KyselyDb implements Db {
  /**
   * `databaseUrl` is Postgres's; without it, this is PGlite. `pglite` is given only to the Db
   * that owns it, not to its transactions, so only that one closes it.
   */
  constructor(private readonly k: Kysely<unknown>, private readonly databaseUrl?: string, private readonly pglite?: PGlite) {}

  async query<R>(text: string, params: unknown[] = []) {
    const r = await this.k.executeQuery<R>(CompiledQuery.raw(text, params));
    return { rows: r.rows ?? [] };
  }

  async exec(text: string) {
    // With no parameters, pg and PGlite both use the simple protocol, which allows several statements.
    await this.k.executeQuery(CompiledQuery.raw(text, []));
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.k.transaction().execute((trx) => fn(new KyselyDb(trx, this.databaseUrl)));
  }

  async notify(channel: string, payload: string, oversized: (payload: string) => string) {
    if (!this.databaseUrl) return;
    const { buildNotifyQuery } = await loadPgNotify();
    const q = buildNotifyQuery(channel, payload, { onOversized: oversized });
    if (!q) throw new Error(`a notification on ${channel} is too long for NOTIFY, even as ${oversized(payload)}`);
    await this.query(q.text, q.values);
  }

  async listen(channel: string, fn: (payload: unknown) => void, opts: { applicationName: string }): Promise<Listening | undefined> {
    if (!this.databaseUrl) return undefined;
    const { NotificationListener } = await loadPgNotify();
    const listener = new (class extends NotificationListener<unknown> {
      onNotification(payload: unknown) {
        // pg-listen calls this from pg's socket handler, where a throw would end the process.
        try { fn(payload); } catch (e) {
          console.error(`postgres: a notification on ${channel} failed: ${e instanceof Error ? e.message : 'unknown error'}`);
        }
      }
    })(channel, {
      connectionString: this.databaseUrl,
      application_name: opts.applicationName,
      // pg-listen's own reconnect loop can't be stopped once it starts, so a listener closed
      // mid-reconnect would go on connecting. With one attempt it makes none and reports the
      // loss at once, and NotificationListener, which stops when closed, owns every retry:
      // after 1 s, 2 s, 4 s and so on, up to 30 s, without limit.
      ...({ retryLimit: 1 } as object),
    });
    try {
      await listener.onModuleInit();
    } catch (e) {
      // Its connection's handlers are already attached, and would keep reconnecting it.
      await listener.onModuleDestroy().catch(() => undefined);
      throw e;
    }
    return {
      connected: async () => (await this.query(
        `select 1 from pg_stat_activity where datname = current_database() and application_name = $1`,
        [opts.applicationName])).rows.length > 0,
      close: () => listener.onModuleDestroy(),
    };
  }

  private closing?: Promise<void>;

  close() {
    return (this.closing ??= (async () => {
      await this.k.destroy();
      // Kysely destroys only a driver it has initialized, on the first query. A PGlite starts up
      // as soon as it's made, so one closed before any query would otherwise go on starting up,
      // and stay open, after its Db was closed.
      if (this.pglite && !this.pglite.closed) await this.pglite.close();
    })());
  }
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
