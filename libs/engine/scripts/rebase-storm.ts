/**
 * How expensive is one parent commit with many variants under it? (W2.7, CAS8)
 *
 * A parent spec P has E elements. Under it hang W variant trees, each D levels deep with
 * B children per variant per level, so V = W * (1 + B + ... + B^(D-1)) variants. Every
 * variant overrides a fraction F of the elements, a different window each. P then commits
 * a version that changes K elements, and Kolab rebases every variant onto it (OVR3),
 * level by level, each rebase through the structural gate (OVR10, VER12) and the
 * three-way rule (CAS5).
 *
 * For that one commit it counts the versions rebased (in all and per depth), the wall time
 * of the parent's commit call, the marks raised by reason, the queries raised, the SQL
 * statements and transactions run, the longest transaction, and the peak resident memory.
 *
 *   npm run rebase-storm                          # the grid, on PGlite
 *   npm run rebase-storm -- --postgres            # the grid, on Postgres 18 in a container (needs Docker)
 *   npm run rebase-storm -- --probe [--postgres]  # other writers during a storm
 *   npm run rebase-storm -- --E 100 --W 50 --D 3 --B 1 --K 10 --F 0.2   # one shape
 *
 * --budget <ms> (default 60000) stops scaling a series once a storm takes longer than that.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Kolab } from '../src/index.js';

type Shape = { E: number; W: number; D: number; B: number; K: number; F: number };
type Backend = { name: string; url?: () => Promise<string>; stop?: () => Promise<void> };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : undefined; };
const BUDGET = opt('budget') ?? 60_000;

// ---------------------------------------------------------------------------
// Instrumentation: count every statement and time every transaction, wherever it runs.
// ---------------------------------------------------------------------------

const stats = { on: false, statements: 0, transactions: 0, txMs: 0, txMaxMs: 0 };

function instrument(kolab: Kolab) {
  const proto = Object.getPrototypeOf(kolab.db);
  if (proto.__measured) return;
  proto.__measured = true;
  const query = proto.query, exec = proto.exec, transaction = proto.transaction;
  proto.query = function (...a: unknown[]) { if (stats.on) stats.statements++; return query.apply(this, a); };
  proto.exec = function (...a: unknown[]) { if (stats.on) stats.statements++; return exec.apply(this, a); };
  proto.transaction = async function (...a: unknown[]) {
    const t0 = performance.now();
    try { return await transaction.apply(this, a); } finally {
      if (stats.on) {
        const ms = performance.now() - t0;
        stats.transactions++; stats.txMs += ms; stats.txMaxMs = Math.max(stats.txMaxMs, ms);
      }
    }
  };
}

function resetStats() { Object.assign(stats, { on: true, statements: 0, transactions: 0, txMs: 0, txMaxMs: 0 }); }

/** Peak resident set while `fn` runs, sampled every 10 ms. */
async function peakRss<T>(fn: () => Promise<T>): Promise<[T, number]> {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  try { return [await fn(), Math.max(peak, process.memoryUsage().rss)]; } finally { clearInterval(timer); }
}

// ---------------------------------------------------------------------------
// The family: a parent and its variant trees
// ---------------------------------------------------------------------------

const text = (i: number, gen = 1) => `Element ${i} holds, as of revision ${gen}.`;

async function family(kolab: Kolab, s: Shape) {
  await kolab.addActor('alice');
  const product = await kolab.openSession('alice', 'product');
  const range = [...Array(s.E).keys()];
  const P = await kolab.createNode(product, 'functional_spec', 'Parent', 'P');
  const p1 = await kolab.commit(product, P, { elements: range.map((i) => ({ id: `E${i}`, text: text(i) })) });

  const depth = new Map<string, number>();
  const overrides = Math.max(1, Math.round(s.F * s.E));
  let n = 0;
  const grow = async (parentVersion: string, path: string, level: number) => {
    const id = `V${path}`;
    const k = n++;
    // A window of `overrides` elements, starting at a different place for each variant.
    const start = (k * 7) % s.E;
    const deltas = [...Array(overrides).keys()].map((j) => {
      const i = (start + j) % s.E;
      return { kind: 'override' as const, element: `E${i}`, text: `Variant ${id} says element ${i} differently.` };
    });
    await kolab.createNode(product, 'functional_spec', `Variant ${id}`, id);
    const v = await kolab.commit(product, id, { parent: parentVersion, deltas });
    depth.set(id, level);
    if (level < s.D) for (let b = 0; b < s.B; b++) await grow(v, `${path}.${b}`, level + 1);
  };
  for (let w = 0; w < s.W; w++) await grow(p1, `${w}`, 1);

  const next = range.map((i) => ({ id: `E${i}`, text: i < s.K ? text(i, 2) : text(i) }));
  return { product, P, next, depth };
}

// ---------------------------------------------------------------------------
// One storm
// ---------------------------------------------------------------------------

async function storm(backend: Backend, s: Shape) {
  const kolab = await Kolab.open(backend.url ? { databaseUrl: await backend.url() } : {});
  instrument(kolab);
  try {
    const setup0 = performance.now();
    const { product, P, next, depth } = await family(kolab, s);
    const setupMs = performance.now() - setup0;
    const before = await counts(kolab);

    global.gc?.();
    resetStats();
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    const [, peak] = await peakRss(() => kolab.commit(product, P, { elements: next }));
    const ms = performance.now() - t0;
    stats.on = false;

    const rebased = (await kolab.db.query<{ node_id: string; state: string }>(
      `select node_id, state from version where active_role = 'system' and node_id <> 'P'`)).rows;
    const perDepth = Array<number>(s.D).fill(0);
    for (const r of rebased) perDepth[depth.get(r.node_id)! - 1]++;
    const after = await counts(kolab);
    const marks: Record<string, number> = {};
    for (const [reason, c] of Object.entries(after.marks)) {
      const d = c - (before.marks[reason] ?? 0);
      if (d) marks[reason] = d;
    }
    return {
      ...s,
      V: depth.size,
      rebased: rebased.length,
      committed: rebased.filter((r) => r.state === 'committed').length,
      perDepth: perDepth.join('/'),
      ms: Math.round(ms),
      msPerRebase: rebased.length ? +(ms / rebased.length).toFixed(1) : 0,
      statements: stats.statements,
      stmtPerRebase: rebased.length ? Math.round(stats.statements / rebased.length) : 0,
      transactions: stats.transactions,
      txMaxMs: +stats.txMaxMs.toFixed(1),
      txShare: +(stats.txMs / ms).toFixed(2),
      marks,
      queries: after.queries - before.queries,
      peakRssMb: Math.round(peak / 2 ** 20),
      rssGrowMb: Math.round((peak - rss0) / 2 ** 20),
      setupMs: Math.round(setupMs),
    };
  } finally {
    await kolab.close();
  }
}

async function counts(kolab: Kolab) {
  const marks = Object.fromEntries((await kolab.db.query<{ reason: string; n: number }>(
    `select reason, count(*)::int as n from invalidation group by reason`)).rows.map((r) => [r.reason, r.n]));
  const queries = (await kolab.db.query<{ n: number }>(`select count(*)::int as n from query`)).rows[0].n;
  return { marks, queries };
}

// ---------------------------------------------------------------------------
// Other writers during a storm
// ---------------------------------------------------------------------------

/**
 * While P's commit rebases every variant, two other writers run in a loop:
 * - an unrelated writer commits new versions of a node outside the family;
 * - a variant writer commits human edits to the variants, starting from the last to be
 *   rebased and working back, so that most edits land on variants still waiting for theirs.
 * Their latencies are compared with the same writes on an idle Kolab, and every failure is kept.
 */
async function probe(backend: Backend, s: Shape) {
  const kolab = await Kolab.open(backend.url ? { databaseUrl: await backend.url() } : {});
  instrument(kolab);
  try {
    const { product, P, next, depth } = await family(kolab, s);
    await kolab.addActor('dave');
    const other = await kolab.openSession('dave', 'product');
    const U = await kolab.createNode(other, 'functional_spec', 'Unrelated', 'U');
    let u = 0;
    const unrelated = () => kolab.commit(other, U, { elements: [{ id: 'X', text: `Unrelated revision ${++u}.` }] });
    const variants = [...depth.keys()].reverse();
    let l = 0;
    const variantEdit = () => {
      const id = variants[l++ % variants.length];
      return kolab.commit(product, id, { deltas: [{ kind: 'add', element: `H${l}`, text: `Human edit ${l} to ${id}.` }] });
    };

    const time = async (fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      try { await fn(); return { ms: performance.now() - t0 }; } catch (e) { return { ms: performance.now() - t0, error: String(e) }; }
    };
    const idleUnrelated: number[] = [], idleVariant: number[] = [];
    for (let i = 0; i < 10; i++) idleUnrelated.push((await time(unrelated)).ms);
    for (let i = 0; i < 10; i++) idleVariant.push((await time(variantEdit)).ms);
    const failedBefore = await reviewFailed(kolab);

    let running = true;
    const during = { unrelated: [] as number[], variant: [] as number[], errors: [] as string[] };
    const loop = async (fn: () => Promise<unknown>, into: number[]) => {
      while (running) {
        const r = await time(fn);
        into.push(r.ms);
        if (r.error) during.errors.push(r.error);
      }
    };
    const t0 = performance.now();
    const writers = [loop(unrelated, during.unrelated), loop(variantEdit, during.variant)];
    let stormError: string | undefined;
    await kolab.commit(product, P, { elements: next }).catch((e) => { stormError = String(e); });
    const ms = performance.now() - t0;
    running = false;
    await Promise.all(writers);

    const summary = (xs: number[]) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return { n: xs.length, p50: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), max: Math.round(sorted.at(-1) ?? 0) };
    };
    // A variant is behind if its live version does not sit on its parent node's live version.
    let behind = 0;
    for (const id of depth.keys()) {
      const v = (await kolab.latestCommitted(id))!;
      const parentNode = (await kolab.version(v.parent_version_id!)).node_id;
      if ((await kolab.latestCommitted(parentNode))!.id !== v.parent_version_id) behind++;
    }
    // A human edit is lost if a variant committed it and its live version no longer has it.
    let lost = 0, edits = 0;
    for (const id of variants) {
      const added = (await kolab.db.query<{ element_id: string }>(
        `select distinct d.element_id from delta d join version v on v.id = d.version_id
          where v.node_id = $1 and v.state = 'committed' and v.active_role <> 'system' and d.kind = 'add'`, [id])).rows;
      const live = new Set((await kolab.elements((await kolab.latestCommitted(id))!.id)).map((e) => e.element_id));
      edits += added.length;
      lost += added.filter((a) => !live.has(a.element_id)).length;
    }
    return {
      backend: backend.name, ...s, V: depth.size, stormMs: Math.round(ms), stormError,
      idleUnrelated: summary(idleUnrelated), duringUnrelated: summary(during.unrelated),
      idleVariant: summary(idleVariant), duringVariant: summary(during.variant),
      errors: [...new Set(during.errors.map((e) => e.replace(/V[\d.]+/g, 'V…').slice(0, 160)))],
      errorCount: during.errors.length,
      reviewFailedMarks: (await reviewFailed(kolab)) - failedBefore,
      variantsBehindParent: behind,
      humanEditsCommitted: edits,
      humanEditsLost: lost,
    };
  } finally {
    await kolab.close();
  }
}

async function reviewFailed(kolab: Kolab) {
  return (await kolab.db.query<{ n: number }>(`select count(*)::int as n from invalidation where reason = 'review_failed'`)).rows[0].n;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

const pglite: Backend = { name: 'PGlite' };

/** Postgres 18 in a container, reached as a non-superuser like RDS's master user (as jest.global-setup.js does). */
async function postgres(): Promise<Backend> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  try { await admin.query(`create role kolab login password 'kolab' createdb createrole nosuperuser`); } finally { await admin.end(); }
  const server = new URL(container.getConnectionUri());
  server.username = 'kolab'; server.password = 'kolab';
  return {
    name: 'Postgres 18',
    url: async () => {
      const name = `kj_storm_${randomBytes(6).toString('hex')}`;
      const c = new pg.Client({ connectionString: server.toString() });
      await c.connect();
      try { await c.query(`create database ${name}`); } finally { await c.end(); }
      const url = new URL(server); url.pathname = `/${name}`;
      return url.toString();
    },
    stop: async () => { await container.stop(); },
  };
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/** Series of growing W for each (E, D, K); a series stops once a storm exceeds the budget. */
function grid(): Shape[][] {
  const series: Shape[][] = [];
  for (const E of [20, 100]) for (const K of [1, 10]) for (const D of [1, 3, 5]) {
    series.push([1, 10, 50, 200].map((W) => ({ E, W, D, B: 1, K, F: 0.2 })));
  }
  // Branching trees: the same depth, many more variants per root.
  for (const E of [20, 100]) series.push([1, 4, 16].map((W) => ({ E, W, D: 5, B: 2, K: 10, F: 0.2 })));
  return series;
}

function print(rows: Record<string, unknown>[]) {
  console.table(rows.map((r) => ({ ...r, marks: JSON.stringify(r.marks).replace(/[{}"]/g, '') })));
}

async function main() {
  const backend = flag('postgres') ? await postgres() : pglite;
  try {
    console.log(`backend: ${backend.name}; node ${process.version}`);
    if (flag('probe')) {
      for (const s of [
        { E: 20, W: 50, D: 3, B: 1, K: 10, F: 0.2 },
        { E: 100, W: 50, D: 5, B: 1, K: 10, F: 0.2 },
      ]) console.log(JSON.stringify(await probe(backend, s), null, 2));
      return;
    }
    if (opt('W') !== undefined) {
      const s = { E: opt('E') ?? 20, W: opt('W')!, D: opt('D') ?? 1, B: opt('B') ?? 1, K: opt('K') ?? 1, F: opt('F') ?? 0.2 };
      print([await storm(backend, s)]);
      return;
    }
    const all: Record<string, unknown>[] = [];
    for (const series of grid()) {
      for (const s of series) {
        const r = await storm(backend, s);
        all.push(r);
        console.log(JSON.stringify(r));
        if (r.ms > BUDGET) { console.log(`  storm took ${r.ms} ms, over the ${BUDGET} ms budget: the rest of this series is skipped`); break; }
      }
    }
    print(all);
  } finally {
    await backend.stop?.();
  }
}

await main();
