/**
 * How many versions does one spec edit dirty?
 *
 * Lineage per requirement i:  spec R_i -> binding b_i -> plan w_i -> component binding C_i -> its plan X_i
 * (each kind of node there is, D77: a component's binding relies on the work item that builds it).
 * One requirement changes; we count dirty versions and marks under four
 * addressing modes, against the design notes' lockstep rule (every downstream
 * version re-mints).
 */
import { ADMIN_DOER } from '@konjir/types';
import { Kolab } from '../src/index.js';
import { people } from '../src/testing.js';

type Mode = { name: string; targetElement: boolean; sourceElement: boolean; planWhole: boolean };

const MODES: Mode[] = [
  { name: 'Version scope on every edge', targetElement: false, sourceElement: false, planWhole: false },
  { name: 'Element targets, version-wide sources', targetElement: true, sourceElement: false, planWhole: false },
  { name: 'Element targets + element sources (decision 1)', targetElement: true, sourceElement: true, planWhole: false },
  { name: 'Decision 1, but the plan derives from the whole binding', targetElement: true, sourceElement: true, planWhole: true },
];

async function run(n: number, mode: Mode) {
  const kolab = await Kolab.open();
  Object.assign(kolab.rates, { asks: Infinity, drafts: Infinity }); // a benchmark's writes, not a runaway agent's
  await people(kolab, 'alice', { layers: ['functional'] }); await people(kolab, 'bob', { layers: ['technical'] });   // each alone on its layer: no review
  const product = await kolab.openSession('alice', 'product', { by: ADMIN_DOER });
  const engineer = await kolab.openSession('bob', 'engineer', { by: ADMIN_DOER });
  const range = [...Array(n).keys()];
  const elems = (p: string, text: (i: number) => string) => range.map((i) => ({ id: `${p}${i}`, text: text(i) }));

  const S = await kolab.createNode(product, 'spec', 'Spec', 'S');
  const s1 = await kolab.commit(product, S, { elements: elems('R', (i) => `Requirement ${i} holds.`) });
  const B = await kolab.createNode(engineer, 'binding', 'Binding', 'B');
  const b = await kolab.commit(engineer, B, { elements: elems('b', (i) => `Binding for ${i}`) });
  const W = await kolab.createNode(engineer, 'plan', 'Plan', 'W', { parent: 'B' });
  const w = await kolab.commit(engineer, W, { elements: elems('w', (i) => `Work for ${i}`) });

  const link = (source: string, sourceElement: string | undefined, target: string, targetElement: string | undefined, kind: 'dependency' | 'derivation' = 'dependency') =>
    kolab.link(engineer, {
      kind, source, target,
      sourceElement: mode.sourceElement ? sourceElement : undefined,
      targetElement: mode.targetElement ? targetElement : undefined,
    });

  if (mode.planWhole) await link(w, undefined, b, undefined, 'derivation');
  for (const i of range) {
    await link(b, `b${i}`, s1, `R${i}`);
    if (!mode.planWhole) await link(w, `w${i}`, b, `b${i}`, 'derivation');
    // A component's own binding, relying as a whole on the work item w_i, and that binding's plan (D78).
    const C = await kolab.createNode(engineer, 'binding', `C${i}`, `C${i}`);
    const c = await kolab.commit(engineer, C, { elements: [{ id: 'c', text: `Component ${i}` }] });
    await link(c, undefined, w, `w${i}`);
    const X = await kolab.createNode(engineer, 'plan', `X${i}`, `X${i}`, { parent: `C${i}` });
    const x = await kolab.commit(engineer, X, { elements: [{ id: 'x', text: `Build component ${i}` }] });
    await link(x, undefined, c, undefined);
  }

  const t0 = performance.now();
  await kolab.commit(product, S, { elements: elems('R', (i) => (i === 0 ? 'Requirement 0 changed.' : `Requirement ${i} holds.`)) });
  const ms = performance.now() - t0;

  const marks = await kolab.openMarks();
  const result = {
    mode: mode.name,
    dirtyVersions: new Set(marks.map((m) => m.version_id)).size,
    marks: marks.length,
    lockstep: 2 + 2 * n,   // binding + plan + every component binding + its plan re-mint
    ms: Math.round(ms),
  };
  await kolab.close();
  return result;
}

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
for (const n of sizes.length ? sizes : [10, 40]) {
  console.log(`\nN = ${n} requirements; ${2 * n + 2} downstream versions; one requirement edited`);
  const rows = [];
  for (const m of MODES) rows.push(await run(n, m));
  console.table(rows);
}
