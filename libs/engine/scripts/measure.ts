/**
 * How many versions does one spec edit dirty?
 *
 * One kolab, with its one spec (KON1) and bindings of it (D78). The binding holds its own work
 * (D104): a work package is an element with a work field, relying on the binding's decision it
 * builds (PLN1). Lineage per requirement i:
 *
 *   spec S#R_i -> binding B's decision b_i -> B's work package W_i
 *              -> component binding C_i's decision c (relying on W_i, the work that builds it, D77)
 *              -> C_i's own work package X
 *
 * One requirement changes; we count dirty versions and marks under four addressing modes,
 * against the design notes' lockstep rule (every downstream version re-mints: B and each C_i).
 * A mode sets both ends of each link between two versions: b_i's to S, and c's to B. A work
 * package's link to the decision it relies on stays inside its own binding's version, from one
 * element to another, in every mode.
 */
import { ADMIN_DOER } from '@konjir/types';
import { Kolab } from '../src/index.js';
import { people } from '../src/testing.js';

type Mode = { name: string; targetElement: boolean; sourceElement: boolean; componentWhole: boolean };

const MODES: Mode[] = [
  { name: 'Version scope on every edge', targetElement: false, sourceElement: false, componentWhole: false },
  { name: 'Element targets, version-wide sources', targetElement: true, sourceElement: false, componentWhole: false },
  { name: 'Element targets + element sources (decision 1)', targetElement: true, sourceElement: true, componentWhole: false },
  { name: 'Decision 1, but each component relies on the whole binding', targetElement: true, sourceElement: true, componentWhole: true },
];

async function run(n: number, mode: Mode) {
  const kolab = await Kolab.open();
  Object.assign(kolab.rates, { asks: Infinity, drafts: Infinity }); // a benchmark's writes, not a runaway agent's
  await people(kolab, 'alice', { layers: ['functional'] }); await people(kolab, 'bob', { layers: ['technical'] });   // each alone on its layer: no review
  const product = await kolab.openSession('alice', 'product', { by: ADMIN_DOER });
  const engineer = await kolab.openSession('bob', 'engineer', { by: ADMIN_DOER });
  const range = [...Array(n).keys()];
  const elems = (p: string, text: (i: number) => string) => range.map((i) => ({ id: `${p}${i}`, text: text(i) }));

  const link = (source: string, sourceElement: string | undefined, target: string, targetElement: string | undefined, whole = false) =>
    kolab.link(engineer, {
      kind: 'dependency', source, target,
      sourceElement: mode.sourceElement && !whole ? sourceElement : undefined,
      targetElement: mode.targetElement && !whole ? targetElement : undefined,
    });

  const S = await kolab.createNode(product, 'spec', 'Spec', 'S');
  const s1 = await kolab.commit(product, S, { elements: elems('R', (i) => `Requirement ${i} holds.`) });

  // The binding: its decisions, each serving a requirement, then its work packages, each relying
  // on the decision it builds, declared in the draft that adds it (WRK11).
  const B = await kolab.createNode(engineer, 'binding', 'Binding', 'B');
  const decisions = elems('b', (i) => `Binding for ${i}`);
  const b1 = await kolab.commit(engineer, B, { elements: decisions });
  for (const i of range) await link(b1, `b${i}`, s1, `R${i}`);
  const b2 = await kolab.commit(engineer, B, {
    elements: [...decisions, ...range.map((i) => ({ id: `W${i}`, text: `Build ${i}.`, work: {} }))],
    links: range.map((i) => ({ kind: 'dependency' as const, sourceElement: `W${i}`, target: b1, targetElement: `b${i}` })),
  });

  // A component's own binding, relying on the work package W_i that builds it (D77), and holding
  // its own work package X, which relies on its decision c.
  for (const i of range) {
    const C = await kolab.createNode(engineer, 'binding', `C${i}`, `C${i}`);
    const c1 = await kolab.commit(engineer, C, { elements: [{ id: 'c', text: `Component ${i}` }] });
    await link(c1, 'c', b2, `W${i}`, mode.componentWhole);
    await kolab.commit(engineer, C, {
      elements: [{ id: 'c', text: `Component ${i}` }, { id: 'X', text: `Build component ${i}.`, work: {} }],
      links: [{ kind: 'dependency', sourceElement: 'X', target: c1, targetElement: 'c' }],
    });
  }

  const t0 = performance.now();
  await kolab.commit(product, S, { elements: elems('R', (i) => (i === 0 ? 'Requirement 0 changed.' : `Requirement ${i} holds.`)) });
  await kolab.drainOutbox();
  const ms = performance.now() - t0;

  const marks = await kolab.openMarks();
  const result = {
    mode: mode.name,
    dirtyVersions: new Set(marks.map((m) => m.version_id)).size,
    marks: marks.length,
    lockstep: 1 + n,   // the binding and every component binding re-mint
    ms: Math.round(ms),
  };
  await kolab.close();
  return result;
}

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
for (const n of sizes.length ? sizes : [10, 40]) {
  console.log(`\nN = ${n} requirements; ${n + 1} downstream versions; one requirement edited`);
  const rows = [];
  for (const m of MODES) rows.push(await run(n, m));
  console.table(rows);
}
