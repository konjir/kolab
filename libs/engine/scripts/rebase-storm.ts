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
 *   npm run rebase-storm -- --races [--postgres]  # deterministic reproductions of the commit races (W1.17)
 *   npm run rebase-storm -- --E 100 --W 50 --D 3 --B 1 --K 10 --F 0.2   # one shape
 *
 * Each shape runs --repeat <n> times (default 3, each on a fresh database) and reports the
 * median storm, after one throwaway warm-up storm per backend. --budget <ms> (default 60000)
 * stops scaling a series once a storm's median takes longer than that. The npm script runs
 * with --expose-gc, so the memory baseline is taken after a collection; without it, the
 * growth figures are upper bounds.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Checks } from '@konjir/types';
import { GateError, Kolab, structuralChecks } from '../src/index.js';
import { people } from '../src/testing.js';

type Shape = { E: number; W: number; D: number; B: number; K: number; F: number };
type Backend = { name: string; url?: () => Promise<string>; stop?: () => Promise<void> };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : undefined; };
const BUDGET = opt('budget') ?? 60_000;
const REPEAT = opt('repeat') ?? 3;

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
  await people(kolab, 'alice');
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
    const earlier = new Set((await kolab.db.query<{ id: string }>(`select id from version`)).rows.map((r) => r.id));

    global.gc?.();
    resetStats();
    const rss0 = process.memoryUsage().rss;
    // Since P6 (D43) the commit returns once P is committed, with its variants' rebases queued, and
    // the outbox worker runs them: here, this process drains the outbox at once, as a worker would.
    // `commitMs` is what the parent's author waits; `ms` is the commit and every rebase.
    const t0 = performance.now();
    let commitMs = 0;
    const [, peak] = await peakRss(async () => {
      await kolab.commit(product, P, { elements: next });
      commitMs = performance.now() - t0;
      await kolab.drainOutbox();
    });
    const ms = performance.now() - t0;
    stats.on = false;

    // Only the versions this storm made: Kolab's own, on the variants, absent before the commit.
    const rebased = (await kolab.db.query<{ id: string; node_id: string; state: string }>(
      `select id, node_id, state from version where active_role = 'system' and node_id <> 'P'`)).rows
      .filter((r) => !earlier.has(r.id));
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
      commitMs: Math.round(commitMs),
      ms: Math.round(ms),
      msPerRebase: rebased.length ? +(ms / rebased.length).toFixed(1) : 0,
      statements: stats.statements,
      stmtPerRebase: rebased.length ? Math.round(stats.statements / rebased.length) : 0,
      transactions: stats.transactions,
      txPerRebase: rebased.length ? +(stats.transactions / rebased.length).toFixed(1) : 0,
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

/** The shape REPEAT times, each on a fresh database: the run with the median time, plus every run's time. */
async function medianStorm(backend: Backend, s: Shape) {
  const runs = [];
  for (let i = 0; i < REPEAT; i++) runs.push(await storm(backend, s));
  const sorted = [...runs].sort((a, b) => a.ms - b.ms);
  return { ...sorted[Math.floor((sorted.length - 1) / 2)], runs: runs.map((r) => r.ms).join('/') };
}

/** One throwaway storm, so the first measured one doesn't pay for a cold container, pool or JIT. */
async function warmUp(backend: Backend) {
  await storm(backend, { E: 20, W: 50, D: 1, B: 1, K: 10, F: 0.2 });
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
 * - a variant writer commits human edits to the variants, in reverse creation order. The
 *   cascade's child query has no order, so this only makes it likely, not certain, that the
 *   edits land on variants still waiting for their rebase; `--races` is the deterministic version.
 * Their latencies are compared with the same writes on an idle Kolab, and every failure is kept.
 */
async function probe(backend: Backend, s: Shape) {
  const kolab = await Kolab.open(backend.url ? { databaseUrl: await backend.url() } : {});
  instrument(kolab);
  try {
    const { product, P, next, depth } = await family(kolab, s);
    // An engineer, so the product owner stays the only one on her layer and her edits commit
    // without waiting for review (W1.6).
    await people(kolab, 'dave', { layers: ['technical'] });
    const other = await kolab.openSession('dave', 'engineer');
    const U = await kolab.createNode(other, 'technical_binding', 'Unrelated', 'U');
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
    const failedBefore = await rebaseFailed(kolab);

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
    await kolab.commit(product, P, { elements: next }).then(() => kolab.drainOutbox()).catch((e) => { stormError = String(e); });
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
      rebaseFailedMarks: (await rebaseFailed(kolab)) - failedBefore,
      variantsBehindParent: behind,
      humanEditsCommitted: edits,
      humanEditsLost: lost,
    };
  } finally {
    await kolab.close();
  }
}

async function rebaseFailed(kolab: Kolab) {
  return (await kolab.db.query<{ n: number }>(`select count(*)::int as n from invalidation where reason = 'rebase_failed'`)).rows[0].n;
}

// ---------------------------------------------------------------------------
// The commit races, reproduced deterministically (--races)
// ---------------------------------------------------------------------------
//
// Each race injects one concurrent write at an exact point, through a checks hook or a
// wrapper on db.query, into a small family: P with three elements, and variants that each
// override E2. Each prints what happened and a verdict against what W1.17 (one serialized
// commit step per node) guarantees: no committed edit is lost, and no caller gets a raw
// database error. Reproductions after the PR #16 review; libs/engine/test/concurrency.test.ts
// runs the same races as tests, on PGlite and Postgres.

type Hook = (ctx: Parameters<Checks>[0]) => Promise<void>;

async function raceKolab(backend: Backend) {
  let hook: Hook | undefined;
  const checks: Checks = async (ctx) => { await hook?.(ctx); return structuralChecks(ctx); };
  // The hook runs before people's reviews and before the structural checks of Kolab's own rebases (W1.6).
  const kolab = await Kolab.open({ submissionChecks: checks, checks, ...(backend.url ? { databaseUrl: await backend.url() } : {}) });
  return { kolab, setHook: (h: Hook | undefined) => { hook = h; } };
}

/** P@1 and `roots` variants V0, V1, …, each with `children` variants under it (V0.0, …). */
async function raceFamily(kolab: Kolab, roots: number, children = 0) {
  await people(kolab, 'alice');
  const s = await kolab.openSession('alice', 'product');
  await kolab.createNode(s, 'functional_spec', 'P', 'P');
  const p1 = await kolab.commit(s, 'P', { elements: [0, 1, 2].map((i) => ({ id: `E${i}`, text: `Parent element ${i}, rev 1.` })) });
  const ids: string[] = [];
  const add = async (id: string, parent: string) => {
    ids.push(id);
    await kolab.createNode(s, 'functional_spec', id, id);
    return kolab.commit(s, id, { parent, deltas: [{ kind: 'override', element: 'E2', text: `${id} says E2 its own way.` }] });
  };
  for (let r = 0; r < roots; r++) {
    const v = await add(`V${r}`, p1);
    for (let c = 0; c < children; c++) await add(`V${r}.${c}`, v);
  }
  const next = [0, 1, 2].map((i) => ({ id: `E${i}`, text: i === 0 ? 'Parent element 0, rev 2.' : `Parent element ${i}, rev 1.` }));
  return { s, ids, next };
}

async function raceHistory(kolab: Kolab, node: string) {
  const rows = (await kolab.db.query<{ id: string; seq: number; active_role: string; state: string; parent_version_id: string }>(
    `select id, seq, active_role, state, parent_version_id from version where node_id = $1 order by seq`, [node])).rows;
  const out = [];
  for (const v of rows) {
    const p = await kolab.version(v.parent_version_id);
    const els = (await kolab.elements(v.id)).map((e) => e.element_id).join(',');
    out.push(`  ${node} seq ${v.seq} ${v.active_role.padEnd(7)} ${v.state.padEnd(9)} on ${p.node_id}@${p.seq} [${els}]`);
  }
  return out.join('\n');
}

const liveHas = async (kolab: Kolab, node: string, element: string) =>
  (await kolab.elements((await kolab.latestCommitted(node))!.id)).some((e) => e.element_id === element);

/** Marks other than the expected override_stale ones: a lost edit should at least raise one. */
const otherMarks = async (kolab: Kolab) => JSON.stringify(Object.fromEntries((await kolab.db.query<{ reason: string; n: number }>(
  `select reason, count(*)::int as n from invalidation where reason <> 'override_stale' group by reason`)).rows.map((r) => [r.reason, r.n])));

/** Variants whose live version doesn't sit on their parent node's live version. */
async function stranded(kolab: Kolab, ids: string[]) {
  const out = [];
  for (const id of ids) {
    const v = (await kolab.latestCommitted(id))!;
    const parentNode = (await kolab.version(v.parent_version_id!)).node_id;
    if ((await kolab.latestCommitted(parentNode))!.id !== v.parent_version_id) out.push(id);
  }
  return out;
}

const verdict = (ok: boolean, what: string) => console.log(`  ${ok ? 'SAFE' : 'RACE'}: ${what}`);

/**
 * 1a. The stale child list. While the storm reviews its first root's rebase, a human commits
 * `add H` to the other root. The storm then rebases the version it listed before the edit.
 */
async function race1a(backend: Backend) {
  const { kolab, setHook } = await raceKolab(backend);
  try {
    const { s, next } = await raceFamily(kolab, 2, 1);
    let edited: string | undefined;
    setHook(async (ctx) => {
      if (edited || ctx.version.active_role !== 'system' || !/^V\d$/.test(ctx.version.node_id)) return;
      edited = ctx.version.node_id === 'V0' ? 'V1' : 'V0';
      await kolab.commit(s, edited, { deltas: [{ kind: 'add', element: 'H', text: `Human edit to ${edited}.` }] });
    });
    let error: unknown;
    await kolab.commit(s, 'P', { elements: next }).then(() => kolab.drainOutbox()).catch((e) => { error = e; });
    setHook(undefined);
    console.log(`\n1a. Stale child list: a human commits to ${edited} while the storm rebases the other root`);
    console.log(`  parent commit: ${error ? String(error) : 'ok'}`);
    console.log(await raceHistory(kolab, edited!));
    const own = await liveHas(kolab, edited!, 'H'), child = await liveHas(kolab, `${edited}.0`, 'H');
    console.log(`  other marks: ${await otherMarks(kolab)}`);
    verdict(own, `${edited}'s live version ${own ? 'keeps' : 'has lost'} the human edit H`);
    verdict(child, `its child ${edited}.0 ${child ? 'inherits' : 'has lost'} H`);
  } finally { await kolab.close(); }
}

/**
 * 1b. Review's check-then-act. A human draft of V0 is in review (the reviewer is slow, as an
 * LLM gate is) when P commits and the storm rebases V0. The staleness check ran before.
 */
async function race1b(backend: Backend) {
  const { kolab, setHook } = await raceKolab(backend);
  try {
    const { s, ids, next } = await raceFamily(kolab, 1);
    const draft = await kolab.draft(s, 'V0', { deltas: [{ kind: 'add', element: 'H', text: 'Human edit to V0.' }] });
    let fired = false;
    setHook(async (ctx) => {
      if (fired || ctx.version.id !== draft) return;
      fired = true;
      await kolab.commit(s, 'P', { elements: next });
      await kolab.drainOutbox();
    });
    const r = await kolab.review(draft);
    setHook(undefined);
    console.log('\n1b. Review check-then-act: P commits while a human draft of V0 is in review');
    console.log(`  human review: ok=${r.ok}${r.version === draft ? ', committed the draft' : `, folded into ${r.version}`}`);
    console.log(await raceHistory(kolab, 'V0'));
    const kept = await liveHas(kolab, 'V0', 'H');
    console.log(`  other marks: ${await otherMarks(kolab)}; stranded: ${JSON.stringify(await stranded(kolab, ids))}`);
    verdict(kept || !r.ok, kept ? 'V0 keeps H' : r.ok ? 'the review said ok, but V0\'s live version has lost H' : 'the draft was refused');
  } finally { await kolab.close(); }
}

/**
 * 2a. The seq collision, rebase loses. A human commits to a variant between the storm's
 * nextSeq read for it and its insert. The commit starts there but isn't awaited there: since
 * W1.17 that read runs in the transaction that holds the variant's lock, so the human's commit
 * waits for it to end, as a concurrent caller's would.
 */
async function race2a(backend: Backend) {
  const { kolab } = await raceKolab(backend);
  const proto = Object.getPrototypeOf(kolab.db);
  const query = proto.query;
  try {
    const { s, ids, next } = await raceFamily(kolab, 4);
    let armed = true, edited: string | undefined, human: Promise<unknown> | undefined;
    proto.query = async function (sql: string, params?: unknown[]) {
      const res = await query.call(this, sql, params);
      const node = params?.[0];
      if (armed && sql.includes('coalesce(max(seq)') && typeof node === 'string' && node.startsWith('V')) {
        armed = false; edited = node;
        human = kolab.commit(s, node, { deltas: [{ kind: 'add', element: 'H', text: `Human edit to ${node}.` }] })
          .then(() => 'ok', (e) => String(e));
      }
      return res;
    };
    let error: unknown;
    await kolab.commit(s, 'P', { elements: next }).then(() => kolab.drainOutbox()).catch((e) => { error = e; });
    const humanResult = await human;
    proto.query = query;
    const left = await stranded(kolab, ids);
    console.log(`\n2a. Seq collision, the rebase loses: a human commits to ${edited} between the storm's nextSeq and its insert`);
    console.log(`  parent commit: ${error ? String(error).slice(0, 140) : 'ok'}; P live at seq ${(await kolab.latestCommitted('P'))!.seq}`);
    console.log(`  human commit: ${String(humanResult).slice(0, 140)}`);
    console.log(await raceHistory(kolab, edited!));
    console.log(`  other marks: ${await otherMarks(kolab)}`);
    verdict(!error, error ? 'the parent committed, but its caller got a raw database error' : 'the parent commit returned');
    const kept = await liveHas(kolab, edited!, 'H');
    verdict(humanResult === 'ok' && kept, humanResult !== 'ok' ? `the human commit failed: ${String(humanResult).slice(0, 80)}`
      : `${edited}'s live version ${kept ? 'keeps' : 'has lost'} the human edit H`);
    verdict(!left.length, left.length ? `${left.join(', ')} left on the old parent, with no mark` : 'every variant is on the new parent');
    if (left.length) {
      // A stranded variant catches up on its own next commit (cascade step 5), or on P's next commit.
      const last = left.at(-1)!;
      await kolab.commit(s, last, { deltas: [{ kind: 'add', element: 'Z', text: `Later edit to ${last}.` }] });
      console.log(`  after a later commit to ${last}, it is ${(await stranded(kolab, [last])).length ? 'still stranded' : 'on the new parent'}`);
    }
  } finally { proto.query = query; await kolab.close(); }
}

/** 2b. Two concurrent human commits to one node, `n` times; tallies what the live version kept. */
async function race2b(backend: Backend, n = 10) {
  const tally: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const { kolab } = await raceKolab(backend);
    try {
      const { s } = await raceFamily(kolab, 1);
      await people(kolab, 'bob');
      const s2 = await kolab.openSession('bob', 'product');
      // Each one's version waits in review, and the other approves it (W1.6).
      const reviewed = async (author: string, reviewer: string, element: string, text: string) => {
        const r = await kolab.review(await kolab.draft(author, 'V0', { deltas: [{ kind: 'add', element, text }] }));
        const done = r.in_review ? await kolab.recordReview(reviewer, r.version, { verdict: 'approve' }) : r;
        if (!done.ok) throw new GateError(`review rejected: ${done.note ?? ''}`);
      };
      const rs = await Promise.allSettled([
        reviewed(s, s2, 'A', 'Alice adds A.'),
        reviewed(s2, s, 'B', 'Bob adds B.'),
      ]);
      const ok = rs.filter((r) => r.status === 'fulfilled').length;
      const kept = [] as string[];
      for (const e of ['A', 'B']) if (await liveHas(kolab, 'V0', e)) kept.push(e);
      const failure = rs.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      // Kolab's own error for an overtaken draft is a GateError naming it stale; anything else is raw.
      const key = `${ok} of 2 commits ok, live has ${kept.join('+') || 'neither'}`
        + (failure ? `; the other got ${failure.reason instanceof GateError ? '' : 'raw '}${String(failure.reason).slice(0, 80)}` : '');
      tally[key] = (tally[key] ?? 0) + 1;
    } finally { await kolab.close(); }
  }
  console.log(`\n2b. Two concurrent human commits to V0, ${n} runs:`);
  for (const [k, c] of Object.entries(tally)) {
    console.log(`  ${c}× ${k}`);
  }
  const lost = Object.entries(tally).filter(([k]) => k.startsWith('2 of 2') && !k.includes('A+B')).reduce((a, [, c]) => a + c, 0);
  const raw = Object.entries(tally).filter(([k]) => k.includes('the other got raw')).reduce((a, [, c]) => a + c, 0);
  verdict(!lost, `${lost} of ${n} runs reported both commits ok and lost one edit`);
  verdict(!raw, `${raw} of ${n} runs gave one caller a raw database error`);
}

/**
 * 3. Edits while the rebases wait in the queue (P6, D43). P's commit returns with its variants'
 * rebases queued; before the worker runs them, a human commits to a root and to another root's
 * child. Each rebase must build on the variant's live version when it runs, so no edit is lost,
 * the edited root's child inherits the edit, and every variant ends on its parent's latest.
 */
async function race3(backend: Backend) {
  const { kolab } = await raceKolab(backend);
  try {
    const { s, ids, next } = await raceFamily(kolab, 3, 1);
    const r = await kolab.review(await kolab.draft(s, 'P', { elements: next }));
    await kolab.commit(s, 'V1', { deltas: [{ kind: 'add', element: 'H', text: 'Human edit to V1.' }] });
    await kolab.commit(s, 'V0.0', { deltas: [{ kind: 'add', element: 'H', text: 'Human edit to V0.0.' }] });
    const queued = (await kolab.outboxJobs()).filter((j) => j.kind === 'rebase').length;
    await kolab.drainOutbox();
    const left = await stranded(kolab, ids);
    console.log('\n3. Edits while the rebases wait in the queue: P commits, then a human edits V1 and V0.0 before the worker runs');
    console.log(`  parent commit: ok=${r.ok}, rebases queued ${r.rebases ?? 0}; ${queued} rebase jobs before the worker ran`);
    console.log(await raceHistory(kolab, 'V1'));
    console.log(`  other marks: ${await otherMarks(kolab)}; jobs left: ${(await kolab.outboxJobs()).length}`);
    const v1 = await liveHas(kolab, 'V1', 'H'), v10 = await liveHas(kolab, 'V1.0', 'H'), v00 = await liveHas(kolab, 'V0.0', 'H');
    verdict(v1 && v10, `V1 ${v1 ? 'keeps' : 'has lost'} H, and its child V1.0 ${v10 ? 'inherits' : 'has lost'} it`);
    verdict(v00, `V0.0 ${v00 ? 'keeps' : 'has lost'} its own H`);
    verdict(!left.length, left.length ? `${left.join(', ')} left on an old parent` : 'every variant is on its parent\'s latest');
  } finally { await kolab.close(); }
}

async function races(backend: Backend) {
  await race1a(backend);
  await race1b(backend);
  await race2a(backend);
  await race2b(backend);
  await race3(backend);
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
    if (flag('races')) {
      await races(backend);
      return;
    }
    if (flag('probe')) {
      for (const s of [
        { E: 20, W: 50, D: 3, B: 1, K: 10, F: 0.2 },
        { E: 100, W: 50, D: 5, B: 1, K: 10, F: 0.2 },
      ]) console.log(JSON.stringify(await probe(backend, s), null, 2));
      return;
    }
    if (opt('W') !== undefined) {
      const s = { E: opt('E') ?? 20, W: opt('W')!, D: opt('D') ?? 1, B: opt('B') ?? 1, K: opt('K') ?? 1, F: opt('F') ?? 0.2 };
      await warmUp(backend);
      const r = await medianStorm(backend, s);
      console.log(JSON.stringify(r));
      print([r]);
      return;
    }
    await warmUp(backend);
    const all: Record<string, unknown>[] = [];
    for (const series of grid()) {
      for (const s of series) {
        const r = await medianStorm(backend, s);
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
