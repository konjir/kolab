// Property tests for the cascade and rebases (W2.5, binding element TST2, serving LNK4, LNK5 and
// OVR3-OVR7). fast-check generates a spec family (cascade-model.ts) and a sequence of edits to it:
// parent commits that change, delete and restore elements, variant overrides, edits of marked
// binding, WBS and work-package elements, clears and override resolutions, some of which the
// review gate rejects. After every step the test compares Kolab with the reference model, and
// checks that every link either re-pins to the element it fingerprints or carries an open mark.
//
// Deterministic: the seed is fixed. Environment variables tune it:
// - KONJIR_PROPERTY_SEED: the seed, to replay a failure fast-check reported or to search elsewhere
// - KONJIR_PROPERTY_RUNS: how many sequences; by default 25 on PGlite and 60 on Postgres, which
//   runs this suite about twice as fast
// - KONJIR_PROPERTY_SHRINK=0: stop at the first failure instead of shrinking it to a minimal one
import { isDeepStrictEqual } from 'node:util';
import { expect, test } from '@jest/globals';
import fc from 'fast-check';
import { GateError, structuralReviewer, type Kolab } from '@konjir/engine';
import { setup } from '@konjir/engine/testing';
import {
  FUNCTIONAL, LINKS, Model, NODES, P_ORDER, P_PARENTS, PLAIN, VETO, fp, linkKey, textFor, vetoed,
  type El, type NodeKey, type Resolution, type VariantKey,
} from './cascade-model.js';

const SEED = Number(process.env.KONJIR_PROPERTY_SEED ?? 0x5eed);
const RUNS = Number(process.env.KONJIR_PROPERTY_RUNS ?? (process.env.KONJIR_TEST_DATABASE_URL ? 60 : 25));

// ---- generators ---------------------------------------------------------------

/** A text for a person's edit: one of the four ordinary ones, or now and then one the reviewer rejects. */
const text = fc.oneof({ weight: 9, arbitrary: fc.integer({ min: 0, max: 3 }) }, { weight: 1, arbitrary: fc.constant(VETO) });
const variant = fc.constantFrom<VariantKey>('V1', 'V2');

/** The family's starting point: which elements each variant overrides, and with which text. */
const start = fc.record({
  v1: fc.dictionary(fc.constantFrom('E1', 'E2', 'E3'), fc.integer({ min: 0, max: 3 })),
  v2: fc.dictionary(fc.constantFrom('E1', 'E2', 'E3', 'X1'), fc.integer({ min: 0, max: 3 })),
});

const op = fc.oneof(
  // The product owner commits P: each change rewrites an element, restores one, or deletes it.
  { weight: 5, arbitrary: fc.record({
    t: fc.constant('parent' as const),
    changes: fc.array(fc.record({ el: fc.constantFrom(...P_ORDER), to: fc.option(text, { nil: null }) }), { minLength: 1, maxLength: 3 }),
  }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('override' as const), v: variant, el: fc.constantFrom('E1', 'E2', 'E3', 'X1'), i: text }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('edit' as const), node: fc.constantFrom<'B' | 'W' | 'X'>('B', 'B', 'W', 'X'), el: fc.nat(5), i: text }) },
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

/** The review gate: structural checks, and a veto on any version that holds a vetoed text. Plan versions skip it (PLN2). */
const reviewer: Parameters<typeof setup>[0] = (ctx) => {
  const veto = ctx.elements.find((e) => vetoed(e.text));
  return veto ? { ok: false, note: `vetoed: ${veto.element_id}` } : structuralReviewer(ctx);
};

/** Builds the family in Kolab and in the model. */
async function build(ctx: Ctx, s: { v1: Partial<Record<string, number>>; v2: Partial<Record<string, number>> }) {
  const { kolab, product, engineer } = ctx;
  const tag = `r${++runs}`;
  const ids = Object.fromEntries(NODES.map((k) => [k, `${tag}${k}`])) as Record<NodeKey, string>;
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

  const versions: Partial<Record<NodeKey, string>> = { P: p, V1: v1, V2: v2 };
  for (const [key, kind] of [['B', 'technical_binding'], ['W', 'wbs'], ['X', 'work_package']] as const) {
    for (const el of PLAIN[key]) m.plain[key].set(el, t(el, 0));
    await kolab.createNode(engineer, kind, key, ids[key]);
    versions[key] = await kolab.commit(engineer, ids[key], { elements: m.mat(key).map(input) });
  }

  for (const l of LINKS) {
    await kolab.link(FUNCTIONAL.includes(l.src) ? product : engineer, {
      kind: 'dependency', source: versions[l.src]!, sourceElement: l.srcEl, target: versions[l.tgt]!, targetElement: l.tgtEl ?? undefined,
    });
    m.edges.push({ ...l, key: linkKey(l), pinned: fp(m.content(l.tgt, l.tgtEl)!) });
  }
  return { run, m };
}

const input = (e: El) => ({ id: e.id, text: e.text, parent: e.parent ?? undefined });

/** Fails with the steps so far when Kolab and the model disagree. */
function same(where: string, got: unknown, want: unknown) {
  if (!isDeepStrictEqual(got, want)) {
    throw new Error(`Kolab and the model disagree ${where}\n  Kolab: ${JSON.stringify(got)}\n  model: ${JSON.stringify(want)}`);
  }
}

/** An open mark in Kolab, under the model's key for it. */
type Seen = { key: string; id: string; version: string; node: NodeKey; questions: number };

/** Kolab's open marks on the family, keyed as the model keys them. */
async function observe(kolab: Kolab, run: Run): Promise<Seen[]> {
  const marks = (await kolab.db.query<{
    id: string; reason: string; element_id: string | null; edge_id: string | null; delta_id: string | null;
    version_id: string; node_id: string; src_node: string | null; src_el: string | null; tgt_node: string | null; tgt_el: string | null;
    questions: number;
  }>(
    `select i.id, i.reason, i.element_id, i.edge_id, i.delta_id, i.version_id, v.node_id,
            sv.node_id as src_node, e.source_element_id as src_el, tv.node_id as tgt_node, e.target_element_id as tgt_el,
            (select count(*)::int from query q where q.invalidation_id = i.id and q.state = 'open') as questions
       from invalidation i
       join version v on v.id = i.version_id
       left join edge e on e.id = i.edge_id
       left join version sv on sv.id = e.source_version_id
       left join version tv on tv.id = e.target_version_id
      where i.state = 'open' and v.node_id = any($1)`, [Object.values(run.ids)])).rows;
  const causes = (await kolab.db.query<{ mark_id: string; cause_id: string }>(
    `select mark_id, cause_id from invalidation_cause where mark_id = any($1)`, [marks.map((x) => x.id)])).rows;
  const byId = new Map(marks.map((x) => [x.id, x]));
  const edgeKey = (x: typeof marks[number]) =>
    linkKey({ src: run.byId.get(x.src_node!)!, srcEl: x.src_el!, tgt: run.byId.get(x.tgt_node!)!, tgtEl: x.tgt_el });

  return marks.map((x) => {
    const node = run.byId.get(x.node_id)!;
    let key: string;
    if (x.reason === 'upstream_dirty') {
      // LNK5: an upstream mark stays open only while one of its causes is open.
      const names = causes.filter((c) => c.mark_id === x.id).map((c) => byId.get(c.cause_id)).map((c) => (c ? edgeKey(c) : 'a cleared mark')).sort();
      key = `upstream_dirty ${node}.${x.element_id} <- ${names.join(', ') || 'nothing'}`;
    } else if (x.edge_id) {
      key = `edge ${edgeKey(x)} ${x.reason}`;
      if (`${run.byId.get(x.src_node!)}.${x.src_el}` !== `${node}.${x.element_id}`) key += ` (but the mark sits on ${node}.${x.element_id})`;
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
  for (const k of NODES) latest[k] = (await kolab.latestCommitted(run.ids[k]))!.id;

  // Text: every node reads as the model says.
  for (const k of NODES) {
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
  same(where, seen.map((s) => s.key).sort(), m.openMarks());
  for (const s of seen) {
    same(where, [s.key, 'on live version', s.version], [s.key, 'on live version', latest[s.node]]);
    same(where, [s.key, 'questions', s.questions], [s.key, 'questions', s.key.startsWith('override_') ? 1 : 0]);
  }
  const questions = (await kolab.db.query<{ n: number }>(
    `select count(*)::int as n from query q join version v on v.id = q.version_id
      where q.state = 'open' and v.node_id = any($1)`, [Object.values(run.ids)])).rows[0].n;
  same(where, ['open questions', questions], ['open questions', seen.filter((s) => s.key.startsWith('override_')).length]);

  // A mark that stays open is the same mark, carried forward, not cleared and raised again.
  const count = new Map<string, number>();
  for (const s of seen) count.set(s.key, (count.get(s.key) ?? 0) + 1);
  const now = new Map(seen.filter((s) => count.get(s.key) === 1).map((s) => [s.key, s.id]));
  for (const [key, id] of now) {
    if (before.has(key)) same(where, [key, 'same mark', id], [key, 'same mark', before.get(key)]);
  }

  // Links (LNK4): each live source element keeps its links, to the elements they were made for.
  // A link with no open mark is pinned to its target's live version and fingerprints what that
  // version says there. Every link is pinned where the model says.
  const sources = [...new Set(LINKS.map((l) => l.src))];
  const edges = (await kolab.db.query<{
    id: string; source_version_id: string; source_element_id: string; target_version_id: string;
    target_element_id: string | null; target_fingerprint: string; source_node: string; target_node: string;
  }>(
    `select e.id, e.source_version_id, e.source_element_id, e.target_version_id, e.target_element_id,
            e.target_fingerprint, s.node_id as source_node, t.node_id as target_node
       from edge e join version s on s.id = e.source_version_id join version t on t.id = e.target_version_id
      where e.source_version_id = any($1)`, [sources.map((k) => latest[k])])).rows;
  const marked = new Set((await kolab.db.query<{ edge_id: string }>(
    `select edge_id from invalidation where state = 'open' and edge_id = any($1)`, [edges.map((e) => e.id)])).rows.map((r) => r.edge_id));
  const keyOf = (e: typeof edges[number]) => linkKey({
    src: run.byId.get(e.source_node)!, srcEl: e.source_element_id, tgt: run.byId.get(e.target_node)!, tgtEl: e.target_element_id,
  });
  same(where, edges.map(keyOf).sort(), m.edges.map((e) => e.key).sort());
  for (const e of edges) {
    const me = m.edges.find((x) => x.key === keyOf(e))!;
    same(where, [me.key, 'pinned', e.target_fingerprint], [me.key, 'pinned', me.pinned]);
    same(where, [me.key, 'marked', marked.has(e.id)], [me.key, 'marked', !!me.mark]);
    if (marked.has(e.id)) continue;
    const r = await kolab.resolveIn(latest[me.tgt], e.target_element_id, null);
    same(where, [me.key, e.target_version_id, r.status, r.status === 'ok' && r.fingerprint], [me.key, latest[me.tgt], 'ok', e.target_fingerprint]);
  }
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
      if (!m.commitParent(next)) {
        await expect(kolab.commit(product, run.ids.P, { elements: next.map(input) })).rejects.toThrow(GateError);
        return `${what} (rejected)`;
      }
      await kolab.commit(product, run.ids.P, { elements: next.map(input) });
      return what;
    }
    case 'override': {
      const text = t(o.el, o.i);
      const what = `${o.v}.${o.el} := ${JSON.stringify(text)}`;
      const outcome = m.override(o.v, o.el, text);
      const call = kolab.commit(product, run.ids[o.v], { deltas: [{ kind: 'override', element: o.el, text }] });
      if (outcome === 'refused') {
        await expect(call).rejects.toThrow(/not in parent/);
        return `${what} (refused: not in the parent)`;
      }
      if (outcome === 'rejected') {
        await expect(call).rejects.toThrow(GateError);
        return `${what} (rejected)`;
      }
      await call;
      return what;
    }
    case 'edit': {
      const names = PLAIN[o.node];
      const el = names[o.el % names.length];
      const text = t(el, o.i);
      const els = m.mat(o.node).map((e) => (e.id === el ? { ...e, text } : e));
      const call = kolab.commit(engineer, run.ids[o.node], { elements: els.map(input) });
      if (!m.edit(o.node, el, text)) {
        await expect(call).rejects.toThrow(GateError);
        return `${o.node}.${el} := ${JSON.stringify(text)} (rejected)`;
      }
      await call;
      return `${o.node}.${el} := ${JSON.stringify(text)}`;
    }
    case 'clear': {
      const open = [...marks.keys()].filter((k) => k.startsWith('edge ') || k.startsWith('upstream_dirty ')).sort();
      if (!open.length) return 'clear (nothing to clear)';
      const key = open[o.k % open.length];
      const id = marks.get(key)!;
      const node = key.split(' ')[1].split(/[.>]/)[0] as NodeKey;
      const session = FUNCTIONAL.includes(node) ? product : engineer;
      if (key.startsWith('edge ')) {
        if (!m.clearEdge(key.split(' ')[1])) {
          await expect(kolab.clear(session, id)).rejects.toThrow(/no longer exists/);
          return `clear ${key} (refused: the target is gone)`;
        }
      } else {
        m.clearUp(key);
      }
      await kolab.clear(session, id);
      return `clear ${key}`;
    }
    case 'resolve': {
      const open = [...marks.keys()].filter((k) => k.startsWith('override_')).sort();
      if (!open.length) return 'resolve (nothing to resolve)';
      const key = open[o.k % open.length];
      const [v, el] = key.split(' ')[1].split('.') as [VariantKey, string];
      const amended = t(el, o.i);
      const what = `resolve ${key} ${o.how}${o.how === 'amend' ? ` ${JSON.stringify(amended)}` : ''}`;
      const ok = m.resolve(v, el, o.how, amended);
      const markId = marks.get(key)!;
      const r = await kolab.resolveOverride(product, markId, o.how, o.how === 'amend' ? amended : undefined);
      same(what, [key, 'committed', r.verdict.ok], [key, 'committed', ok]);
      // The question is answered with the ruling, by whoever made it (or stays open, if rejected).
      const q = (await kolab.db.query<{ state: string; answer: string | null; answered_by: string | null }>(
        `select state, answer, answered_by from query where invalidation_id = $1`, [markId])).rows;
      same(what, [key, 'question', q], [key, 'question', [ok
        ? { state: 'answered', answer: o.how, answered_by: 'alice' }
        : { state: 'open', answer: null, answered_by: null }]]);
      return ok ? what : `${what} (rejected)`;
    }
  }
}

test('generated edit sequences never leave a mark uncleared or a link pointing at the wrong element', async () => {
  const ctx = await setup(reviewer);
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
