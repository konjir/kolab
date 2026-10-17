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
   * @onivoro/server-pg-notify's `NotificationListener`, which re-establishes it when it's lost,
   * with backoff (1 s, 2 s, 4 s and so on, up to 30 s, without limit) until it's closed.
   * `fn` gets each payload, parsed as JSON; it should check what it gets, since anyone who can
   * connect to the database can NOTIFY. Whatever `fn` throws is logged by the error's name and
   * goes no further. A payload that isn't JSON at all never reaches `fn`, and costs no
   * reconnect: it goes to `hooks.onBadPayload`, which is never given the payload. The connection
   * is named `application_name` (at most 63 bytes). Resolves once the LISTEN is in place, and
   * rejects, leaving nothing behind, if it can't be. On PGlite it resolves to undefined: nothing
   * else can write to its database.
   */
  listen(channel: string, fn: (payload: unknown) => void, opts: { applicationName: string } & ListenHooks): Promise<Listening | undefined>;
  close(): Promise<void>;
}

/** What a listener reports besides its notifications. None of them is given a payload. */
export interface ListenHooks {
  /**
   * The LISTEN is in place: first with `reconnected` false, then true after each loss. What
   * was notified while it was down was missed, so a caller re-reads what it serves then.
   */
  onListening?(e: { reconnected: boolean }): void;
  /** A notification whose payload isn't JSON was dropped. */
  onBadPayload?(): void;
}

export interface Listening {
  /** Whether the LISTEN is in place now. While it isn't, notifications are missed. */
  connected(): boolean;
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

// Loaded on first use, on Postgres only: its listener brings in pg-listen, which PGlite and the
// CLI's client verbs never need. The /listener entry is the package without NestJS.
let pgNotify: Promise<typeof import('@onivoro/server-pg-notify/listener')> | undefined;
const loadPgNotify = () => (pgNotify ??= import('@onivoro/server-pg-notify/listener'));

/**
 * The listener's own log lines, in Kolab's format, at warn and error only, as the server logs.
 * It never puts a payload in them.
 */
const listenerLogger = {
  log: () => undefined,
  warn: (m: string) => console.warn(`postgres: ${m}`),
  error: (m: string) => console.error(`postgres: ${m}`),
};

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

  async listen(channel: string, fn: (payload: unknown) => void, opts: { applicationName: string } & ListenHooks): Promise<Listening | undefined> {
    if (!this.databaseUrl) return undefined;
    const { NotificationListener } = await loadPgNotify();
    const { onListening, onBadPayload } = opts;
    const listener = new (class extends NotificationListener<unknown> {
      onNotification(payload: unknown) { fn(payload); }
      protected override onListening(e: { reconnected: boolean }) { onListening?.(e); }
      protected override onBadPayload() { onBadPayload?.(); }
    })(channel, { connectionString: this.databaseUrl, application_name: opts.applicationName }, { logger: listenerLogger });
    // A failed boot closes its connection and schedules no retry.
    await listener.onModuleInit();
    return { connected: () => listener.isListening, close: () => listener.onModuleDestroy() };
  }

  private closing?: Promise<void>;

  /** Closing again, or while it's closing, waits for the same close; after a failed close, it tries again. */
  close() {
    return (this.closing ??= this.shutdown().catch((e) => { this.closing = undefined; throw e; }));
  }

  private async shutdown() {
    try {
      await this.k.destroy();
    } finally {
      // Kysely destroys only a driver it has initialized, on the first query. A PGlite starts up
      // as soon as it's made, so one closed before any query would otherwise go on starting up,
      // and stay open, after its Db was closed. It's closed here too if destroy failed.
      if (this.pglite && !this.pglite.closed) await this.pglite.close();
    }
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
