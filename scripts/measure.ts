/**
 * How many versions does one spec edit dirty?
 *
 * Lineage per requirement i:  spec R_i -> binding b_i -> WBS w_i -> package WP_i -> impl I_i
 * One requirement changes; we count dirty versions and marks under four
 * addressing modes, against the design notes' lockstep rule (every downstream
 * version re-mints).
 */
import { Kolab } from '../src/kolab.js';

type Mode = { name: string; targetElement: boolean; sourceElement: boolean; wbsWhole: boolean };

const MODES: Mode[] = [
  { name: 'Version scope on every edge', targetElement: false, sourceElement: false, wbsWhole: false },
  { name: 'Element targets, version-wide sources', targetElement: true, sourceElement: false, wbsWhole: false },
  { name: 'Element targets + element sources (decision 1)', targetElement: true, sourceElement: true, wbsWhole: false },
  { name: 'Decision 1, but WBS derives from whole binding', targetElement: true, sourceElement: true, wbsWhole: true },
];

async function run(n: number, mode: Mode) {
  const kolab = await Kolab.open();
  await kolab.addActor('alice'); await kolab.addActor('bob');
  const product = await kolab.openSession('alice', 'product');
  const engineer = await kolab.openSession('bob', 'engineer');
  const range = [...Array(n).keys()];
  const elems = (p: string, text: (i: number) => string) => range.map((i) => ({ id: `${p}${i}`, text: text(i) }));

  const S = await kolab.createNode(product, 'functional_spec', 'Spec', 'S');
  const s1 = await kolab.commit(product, S, { elements: elems('R', (i) => `Requirement ${i} holds.`) });
  const B = await kolab.createNode(engineer, 'technical_binding', 'Binding', 'B');
  const b = await kolab.commit(engineer, B, { elements: elems('b', (i) => `Binding for ${i}`) });
  const W = await kolab.createNode(engineer, 'wbs', 'WBS', 'W');
  const w = await kolab.commit(engineer, W, { elements: elems('w', (i) => `Work for ${i}`) });

  const link = (source: string, sourceElement: string | undefined, target: string, targetElement: string | undefined, kind: 'dependency' | 'derivation' = 'dependency') =>
    kolab.link(engineer, {
      kind, source, target,
      sourceElement: mode.sourceElement ? sourceElement : undefined,
      targetElement: mode.targetElement ? targetElement : undefined,
    });

  if (mode.wbsWhole) await link(w, undefined, b, undefined, 'derivation');
  for (const i of range) {
    await link(b, `b${i}`, s1, `R${i}`);
    if (!mode.wbsWhole) await link(w, `w${i}`, b, `b${i}`, 'derivation');
    const P = await kolab.createNode(engineer, 'work_package', `WP${i}`, `WP${i}`);
    const pk = await kolab.commit(engineer, P, { elements: [{ id: 't', text: `Task ${i}` }] });
    await link(pk, undefined, w, `w${i}`);
    const I = await kolab.createNode(engineer, 'implementation', `I${i}`, `I${i}`);
    const im = await kolab.commit(engineer, I, { elements: [{ id: 'code', text: `module ${i}` }] });
    await link(im, undefined, pk, undefined);
  }

  const t0 = performance.now();
  await kolab.commit(product, S, { elements: elems('R', (i) => (i === 0 ? 'Requirement 0 changed.' : `Requirement ${i} holds.`)) });
  const ms = performance.now() - t0;

  const marks = await kolab.openMarks();
  const result = {
    mode: mode.name,
    dirtyVersions: new Set(marks.map((m) => m.version_id)).size,
    marks: marks.length,
    lockstep: 2 + 2 * n,   // binding + WBS + every package + every impl re-mint
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
