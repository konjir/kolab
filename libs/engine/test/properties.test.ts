// Property tests for the cascade and rebases (W2.5, binding element TST2, serving LNK4, LNK5 and
// OVR3-OVR7). fast-check generates a spec family (cascade-model.ts) and a sequence of edits to it:
// parent commits that change, delete and restore elements, variant overrides, binding and wbs edits
// of marked elements, clears and override resolutions. After every step the test compares Kolab
// with the reference model, and checks that every link either re-pins to the element it
// fingerprints or carries an open mark.
//
// Deterministic: the seed is fixed. KONJIR_PROPERTY_SEED and KONJIR_PROPERTY_RUNS change it and the
// number of runs, to replay a failure fast-check reported or to search harder. It runs on PGlite,
// and on Postgres under npm run test:postgres.
import { expect, test } from '@jest/globals';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { GateError, type Kolab } from '@konjir/engine';
import { setup } from '@konjir/engine/testing';
import {
  B_ELS, LINKS, Model, P_ORDER, P_PARENTS, W_ELS, fp, textFor,
  type El, type NodeKey, type Resolution, type VariantKey,
} from './cascade-model.js';

const SEED = Number(process.env.KONJIR_PROPERTY_SEED ?? 0x5eed);
const RUNS = Number(process.env.KONJIR_PROPERTY_RUNS ?? 40);

// ---- generators ---------------------------------------------------------------

const text = fc.integer({ min: 0, max: 3 });
const variant = fc.constantFrom<VariantKey>('V1', 'V2');

/** The family's starting point: which elements each variant overrides, and with which text. */
const start = fc.record({
  v1: fc.dictionary(fc.constantFrom('E1', 'E2', 'E3'), text),
  v2: fc.dictionary(fc.constantFrom('E1', 'E2', 'E3', 'X1'), text),
});

const op = fc.oneof(
  // The product owner commits P: each change rewrites an element, restores one, or deletes it.
  { weight: 5, arbitrary: fc.record({
    t: fc.constant('parent' as const),
    changes: fc.array(fc.record({ el: fc.constantFrom(...P_ORDER), to: fc.option(text, { nil: null }) }), { minLength: 1, maxLength: 3 }),
  }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('override' as const), v: variant, el: fc.constantFrom('E1', 'E2', 'E3', 'X1'), i: text }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('edit' as const), node: fc.constantFrom<'B' | 'W'>('B', 'B', 'W'), el: fc.nat(4), i: text }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('clear' as const), k: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({
    t: fc.constant('resolve' as const), k: fc.nat(), how: fc.constantFrom<Resolution>('reaffirm', 'adopt_parent', 'amend'), i: text,
  }) },
);
type Op = typeof op extends fc.Arbitrary<infer T> ? T : never;

// ---- Kolab, as the model sees it ---------------------------------------------

type Ctx = Awaited<ReturnType<typeof setup>>;
type Run = { tag: string; ids: Record<NodeKey, string>; byId: Map<string, NodeKey> };

let runs = 0;

async function live(kolab: Kolab, node: string) {
  return (await kolab.latestCommitted(node))!;
}

/** Builds the family in Kolab and in the model. */
async function build(ctx: Ctx, s: { v1: Partial<Record<string, number>>; v2: Partial<Record<string, number>> }) {
  const { kolab, product, engineer } = ctx;
  const tag = `r${++runs}`;
  const ids = Object.fromEntries((['P', 'V1', 'V2', 'B', 'W'] as const).map((k) => [k, `${tag}${k}`])) as Record<NodeKey, string>;
  const run: Run = { tag, ids, byId: new Map(Object.entries(ids).map(([k, id]) => [id, k as NodeKey])) };
  const m = new Model();
  const t = (el: string, i: number) => textFor(tag, el, i);

  m.P = P_ORDER.map((id) => ({ id, text: t(id, 0), parent: P_PARENTS[id] }));
  await kolab.createNode(product, 'functional_spec', 'P', ids.P);
  const p = await kolab.commit(product, ids.P, { elements: m.P.map(input) });

  await kolab.createNode(product, 'functional_spec', 'V1', ids.V1);
  const v1Deltas = [
    ...Object.entries(s.v1).map(([el, i]) => ({ kind: 'override' as const, element: el, text: t(el, i!) })),
    { kind: 'add' as const, element: 'X1', text: t('X1', 0) },
  ];
  const v1 = await kolab.commit(product, ids.V1, { parent: p, deltas: v1Deltas });
  for (const d of v1Deltas) {
    const pe = m.P.find((e) => e.id === d.element);
    m.V.V1.set(d.element, { kind: d.kind, text: d.text, baseFp: pe ? fp(pe.text) : null, state: 'clean', parent: pe?.parent ?? null });
  }

  await kolab.createNode(product, 'functional_spec', 'V2', ids.V2);
  const v2Deltas = Object.entries(s.v2).map(([el, i]) => ({ kind: 'override' as const, element: el, text: t(el, i!) }));
  const v1Els = m.mat('V1');
  const v2 = await kolab.commit(product, ids.V2, { parent: v1, deltas: v2Deltas });
  for (const d of v2Deltas) {
    const pe = v1Els.find((e) => e.id === d.element)!;
    m.V.V2.set(d.element, { kind: 'override', text: d.text, baseFp: fp(pe.text), state: 'clean', parent: pe.parent });
  }

  for (const el of B_ELS) m.B.set(el, t(el, 0));
  for (const el of W_ELS) m.W.set(el, t(el, 0));
  await kolab.createNode(engineer, 'technical_binding', 'B', ids.B);
  const b = await kolab.commit(engineer, ids.B, { elements: m.mat('B').map(input) });
  await kolab.createNode(engineer, 'wbs', 'W', ids.W);
  const w = await kolab.commit(engineer, ids.W, { elements: m.mat('W').map(input) });

  const versions: Record<NodeKey, string> = { P: p, V1: v1, V2: v2, B: b, W: w };
  for (const l of LINKS) {
    await kolab.link(engineer, { kind: 'dependency', source: versions[l.src], sourceElement: l.srcEl, target: versions[l.tgt], targetElement: l.tgtEl ?? undefined });
    m.edges.push({ ...l, key: `${l.src}.${l.srcEl}`, pinned: fp(m.content(l.tgt, l.tgtEl)!) });
  }
  return { run, m };
}

/** Fails with the steps so far when Kolab and the model disagree. */
function same(where: string, got: unknown, want: unknown) {
  if (!isDeepStrictEqual(got, want)) {
    throw new Error(`Kolab and the model disagree ${where}\n  Kolab: ${JSON.stringify(got)}\n  model: ${JSON.stringify(want)}`);
  }
}

const input = (e: El) => ({ id: e.id, text: e.text, parent: e.parent ?? undefined });

/** An open mark in Kolab, under the model's key for it. */
type Seen = { key: string; id: string; version: string; node: NodeKey; questions: number };

/** Kolab's open marks on the family, keyed as the model keys them. */
async function observe(kolab: Kolab, run: Run): Promise<Seen[]> {
  const nodes = Object.values(run.ids);
  const marks = (await kolab.db.query<{
    id: string; reason: string; element_id: string | null; edge_id: string | null; delta_id: string | null;
    version_id: string; node_id: string; edge_source: string | null; edge_element: string | null; questions: number;
  }>(
    `select i.id, i.reason, i.element_id, i.edge_id, i.delta_id, i.version_id, v.node_id,
            ev.node_id as edge_source, e.source_element_id as edge_element,
            (select count(*)::int from query q where q.invalidation_id = i.id and q.state = 'open') as questions
       from invalidation i
       join version v on v.id = i.version_id
       left join edge e on e.id = i.edge_id
       left join version ev on ev.id = e.source_version_id
      where i.state = 'open' and v.node_id = any($1)`, [nodes])).rows;
  const causes = (await kolab.db.query<{ mark_id: string; cause_id: string }>(
    `select mark_id, cause_id from invalidation_cause where mark_id = any($1)`, [marks.map((x) => x.id)])).rows;
  const byId = new Map(marks.map((x) => [x.id, x]));
  const edgeKey = (x: { edge_source: string | null; edge_element: string | null }) => `${run.byId.get(x.edge_source!)}.${x.edge_element}`;

  return marks.map((x) => {
    const node = run.byId.get(x.node_id)!;
    let key: string;
    if (x.reason === 'upstream_dirty') {
      // LNK5: an upstream mark stays open only while one of its causes is open.
      const mine = causes.filter((c) => c.mark_id === x.id).map((c) => byId.get(c.cause_id));
      const names = mine.map((c) => (c ? edgeKey(c) : 'a cleared mark')).sort();
      key = `upstream_dirty ${node}.${x.element_id} <- ${names.join(', ') || 'nothing'}`;
    } else if (x.edge_id) {
      key = `edge ${edgeKey(x)} ${x.reason}`;
      if (edgeKey(x) !== `${node}.${x.element_id}`) key += ` (but the mark sits on ${node}.${x.element_id})`;
    } else if (x.delta_id) {
      key = `${x.reason} ${node}.${x.element_id}`;
    } else {
      key = `${x.reason} ${node}.${x.element_id ?? '(whole)'}`;
    }
    return { key, id: x.id, version: x.version_id, node, questions: x.questions };
  });
}

/** Compares Kolab with the model, after `step`. Returns the open marks by key, for the next step. */
async function check(kolab: Kolab, run: Run, m: Model, step: string, before: Map<string, string>) {
  const where = `after ${step}`;
  const latest = {} as Record<NodeKey, string>;
  for (const k of Object.keys(run.ids) as NodeKey[]) latest[k] = (await live(kolab, run.ids[k])).id;

  // Text: every node reads as the model says.
  for (const k of Object.keys(run.ids) as NodeKey[]) {
    const els = await kolab.elements(latest[k]);
    same(where, [k, Object.fromEntries(els.map((e) => [e.element_id, e.text]))], [k, m.textOf(k)]);
  }

  // OVR3: each variant sits on its parent's live version. CAS5: its overrides are in the model's states.
  for (const v of ['V1', 'V2'] as const) {
    const ver = await kolab.version(latest[v]);
    same(where, [v, 'parent', ver.parent_version_id], [v, 'parent', latest[m.parentOf(v)]]);
    const deltas = (await kolab.db.query<{ element_id: string; kind: string; state: string; text: string }>(
      `select element_id, kind, state, text from delta where version_id = $1 order by element_id`, [latest[v]])).rows;
    const want = [...m.V[v]].map(([el, d]) => ({ element_id: el, kind: d.kind, state: d.state, text: d.text }))
      .sort((a, b) => a.element_id.localeCompare(b.element_id));
    same(where, [v, deltas], [v, want]);
  }

  // Marks: exactly the model's open marks, each on its node's live version (CAS3), each override
  // mark with one open question and every other mark with none.
  const seen = await observe(kolab, run);
  same(where, [seen.map((s) => s.key).sort()], [m.openMarks()]);
  for (const s of seen) {
    same(where, [s.key, 'on live version', s.version], [s.key, 'on live version', latest[s.node]]);
    same(where, [s.key, 'questions', s.questions], [s.key, 'questions', s.key.startsWith('override_') ? 1 : 0]);
  }
  const questions = (await kolab.db.query<{ n: number }>(
    `select count(*)::int as n from query q join version v on v.id = q.version_id
      where q.state = 'open' and v.node_id = any($1)`, [Object.values(run.ids)])).rows[0].n;
  same(where, ['open questions', questions], ['open questions', seen.filter((s) => s.key.startsWith('override_')).length]);

  // A mark that stays open is the same mark, carried forward, not cleared and raised again.
  const now = new Map(seen.map((s) => [s.key, s.id]));
  for (const [key, id] of now) {
    if (before.has(key)) same(where, [key, 'same mark', id], [key, 'same mark', before.get(key)]);
  }

  // Links (LNK4): each live source element keeps its one link, to the element it was made for.
  // A link with no open mark is pinned to its target's live version and fingerprints what that
  // version says there. Every link is pinned where the model says.
  const edges = (await kolab.db.query<{
    id: string; source_version_id: string; source_element_id: string; target_version_id: string;
    target_element_id: string | null; target_fingerprint: string; target_node: string;
  }>(
    `select e.id, e.source_version_id, e.source_element_id, e.target_version_id, e.target_element_id,
            e.target_fingerprint, t.node_id as target_node
       from edge e join version t on t.id = e.target_version_id
      where e.source_version_id = any($1)`, [[latest.B, latest.W]])).rows;
  const marked = new Set((await kolab.db.query<{ edge_id: string }>(
    `select edge_id from invalidation where state = 'open' and edge_id = any($1)`, [edges.map((e) => e.id)])).rows.map((r) => r.edge_id));
  const got = edges.map((e) => `${e.source_version_id === latest.B ? 'B' : 'W'}.${e.source_element_id} -> ${run.byId.get(e.target_node)}.${e.target_element_id ?? '(whole)'}`).sort();
  same(where, [got], [m.edges.map((e) => `${e.key} -> ${e.tgt}.${e.tgtEl ?? '(whole)'}`).sort()]);
  for (const e of edges) {
    const me = m.edges.find((x) => x.key === `${e.source_version_id === latest.B ? 'B' : 'W'}.${e.source_element_id}`)!;
    same(where, [me.key, 'pinned', e.target_fingerprint], [me.key, 'pinned', me.pinned]);
    same(where, [me.key, 'marked', marked.has(e.id)], [me.key, 'marked', !!me.mark]);
    if (marked.has(e.id)) continue;
    const r = await kolab.resolveIn(latest[me.tgt], e.target_element_id, null);
    same(where, [me.key, e.target_version_id, r.status, r.status === 'ok' && r.fingerprint], [me.key, latest[me.tgt], 'ok', e.target_fingerprint]);
  }

  // No variant was left behind on a failed rebase.
  same(where, [seen.filter((s) => s.key.startsWith('rebase_failed'))], [[]]);
  return now;
}

/** Applies one operation to Kolab and the model. Returns a description of what it did, for messages. */
async function apply(ctx: Ctx, run: Run, m: Model, o: Op, marks: Map<string, string>): Promise<string> {
  const { kolab, product, engineer } = ctx;
  const t = (el: string, i: number) => textFor(run.tag, el, i);
  switch (o.t) {
    case 'parent': {
      const now = new Map(m.P.map((e) => [e.id, e.text]));
      for (const c of o.changes) {
        if (c.to === null) {
          now.delete(c.el);
          if (c.el === 'E2') now.delete('E2a');
        } else if (c.el !== 'E2a' || now.has('E2')) now.set(c.el, t(c.el, c.to));
      }
      const next = P_ORDER.filter((id) => now.has(id)).map((id) => ({ id, text: now.get(id)!, parent: P_PARENTS[id] }));
      const what = `P := {${next.map((e) => `${e.id}: ${JSON.stringify(e.text)}`).join(', ')}}`;
      const was = m.P;
      if (!m.commitParent(next)) {
        await expect(kolab.commit(product, run.ids.P, { elements: next.map(input) })).rejects.toThrow(GateError);
        expect(m.P).toBe(was);
        return `${what} (rejected)`;
      }
      await kolab.commit(product, run.ids.P, { elements: next.map(input) });
      return what;
    }
    case 'override': {
      const text = t(o.el, o.i);
      const what = `${o.v}.${o.el} := ${JSON.stringify(text)}`;
      const ok = m.override(o.v, o.el, text);
      const call = kolab.commit(product, run.ids[o.v], { deltas: [{ kind: 'override', element: o.el, text }] });
      if (!ok) {
        await expect(call).rejects.toThrow(/not in parent/);
        return `${what} (refused: not in the parent)`;
      }
      await call;
      return what;
    }
    case 'edit': {
      const names = o.node === 'B' ? B_ELS : W_ELS;
      const el = names[o.el % names.length];
      const text = t(el, o.i);
      m.edit(o.node, el, text);
      const els = m.mat(o.node).map((e) => (e.id === el ? { ...e, text } : e));
      await kolab.commit(engineer, run.ids[o.node], { elements: els.map(input) });
      return `${o.node}.${el} := ${JSON.stringify(text)}`;
    }
    case 'clear': {
      const open = [...marks.keys()].filter((k) => k.startsWith('edge ') || k.startsWith('upstream_dirty ')).sort();
      if (!open.length) return 'clear (nothing to clear)';
      const key = open[o.k % open.length];
      const id = marks.get(key)!;
      if (key.startsWith('edge ')) {
        if (!m.clearEdge(key.split(' ')[1])) {
          await expect(kolab.clear(engineer, id)).rejects.toThrow(/no longer exists/);
          return `clear ${key} (refused: the target is gone)`;
        }
      } else {
        const [, w, , cause] = key.split(' ');
        m.clearUp(`${w.slice(2)}|${cause}`);
      }
      await kolab.clear(engineer, id);
      return `clear ${key}`;
    }
    case 'resolve': {
      const open = [...marks.keys()].filter((k) => k.startsWith('override_')).sort();
      if (!open.length) return 'resolve (nothing to resolve)';
      const key = open[o.k % open.length];
      const [v, el] = key.split(' ')[1].split('.') as [VariantKey, string];
      const amended = t(el, o.i);
      m.resolve(v, el, o.how, amended);
      const r = await kolab.resolveOverride(product, marks.get(key)!, o.how, o.how === 'amend' ? amended : undefined);
      expect([key, r.verdict.ok]).toStrictEqual([key, true]);
      return `resolve ${key} ${o.how}${o.how === 'amend' ? ` ${JSON.stringify(amended)}` : ''}`;
    }
  }
}

test('generated edit sequences never leave a mark uncleared or a link pointing at the wrong element', async () => {
  const ctx = await setup();
  await fc.assert(
    fc.asyncProperty(start, fc.array(op, { minLength: 1, maxLength: 12 }), async (s, ops) => {
      const { run, m } = await build(ctx, s);
      let marks = await check(ctx.kolab, run, m, 'setup', new Map());
      const done: string[] = [];
      for (const o of ops) {
        done.push(await apply(ctx, run, m, o, marks));
        marks = await check(ctx.kolab, run, m, `${done.length} step(s):\n  ${done.join('\n  ')}\n`, marks);
      }
    }),
    { seed: SEED, numRuns: RUNS, endOnFailure: process.env.KONJIR_PROPERTY_SHRINK === '0' },
  );
}, 600_000);
