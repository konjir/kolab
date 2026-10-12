import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, els, marksOn, textOf } from './helpers.js';

const PARENT_V1 = {
  E1: 'Background is white.',
  E2: 'Logo sits top-left.',
  E3: 'Session timeout is 15 minutes.',
  E4: 'Show the promo banner.',
};
const CHILD_DELTAS = [
  { kind: 'override' as const, element: 'E1', text: 'Background is navy.' },
  { kind: 'override' as const, element: 'E3', text: 'Session timeout is 30 minutes.' },
  { kind: 'override' as const, element: 'E4', text: 'Show the promo banner on weekends.' },
  { kind: 'add' as const, element: 'X1', text: 'Support chat is on.' },
];

async function family() {
  const ctx = await setup();
  const { kolab, product } = ctx;
  const parent = await kolab.createNode(product, 'functional_spec', 'Storefront', 'P');
  const p1 = await kolab.commit(product, parent, { elements: els(PARENT_V1) });
  const child = await kolab.createNode(product, 'functional_spec', 'Storefront for Acme', 'C');
  await kolab.commit(product, child, { parent: p1, deltas: CHILD_DELTAS });
  const sibling = await kolab.createNode(product, 'functional_spec', 'Storefront for Globex', 'G');
  await kolab.commit(product, sibling, {
    parent: p1, deltas: [{ kind: 'override', element: 'E3', text: 'Session timeout is 30 minutes.' }],
  });
  return { ...ctx, parent, child, sibling };
}

test('three-way rule: every row of the outcomes table', async () => {
  const { kolab, product, parent, child } = await family();

  await kolab.commit(product, parent, {
    elements: els({
      E1: 'Background is navy.',               // parent converges on the child's override
      E2: 'Logo sits top-center.',             // parent changes an element the child inherits
      E3: 'Session timeout is 10 minutes.',    // parent changes an element the child overrides
      // E4 deleted                            // parent deletes an element the child overrides
    }),
  });

  assert.deepEqual(await textOf(kolab, child), {
    E1: 'Background is navy.',                 // override retired; now inherited
    E2: 'Logo sits top-center.',               // inherited change arrived automatically
    E3: 'Session timeout is 30 minutes.',      // dirty, but the override still stands
    E4: 'Show the promo banner on weekends.',  // orphaned, still stands
    X1: 'Support chat is on.',                 // child's own addition
  });

  const childV = (await kolab.latestCommitted(child))!;
  const marks = (await kolab.openMarks()).filter((m) => m.version_id === childV.id);
  assert.deepEqual(marks.map((m) => [m.element_id, m.reason]).sort(),
    [['E3', 'override_stale'], ['E4', 'override_orphaned']]);
  const deltaKinds = (await kolab.db.query<{ element_id: string; state: string }>(
    `select element_id, state from delta where version_id = $1 order by element_id`, [childV.id])).rows;
  assert.deepEqual(deltaKinds.map((d) => [d.element_id, d.state]),
    [['E3', 'dirty'], ['E4', 'orphaned'], ['X1', 'clean']]);   // E1's override is gone
  assert.equal((await kolab.openQueries()).filter((q) => q.version_id === childV.id).length, 2);
  await kolab.close();
});

test('resolving a stale override: amend, then reaffirm an orphan as a local addition', async () => {
  const { kolab, product, parent, child } = await family();
  await kolab.commit(product, parent, {
    elements: els({ E1: 'Background is white.', E2: 'Logo sits top-left.', E3: 'Session timeout is 10 minutes.' }),
  });
  const open = () => marksOn(kolab, child);
  const e3 = (await open()).find((m) => m.element_id === 'E3')!;
  await kolab.resolveOverride(product, e3.id, 'amend', 'Session timeout is 10 minutes for admins, 30 for shoppers.');

  // The other open override mark followed the child to its new version.
  const e4 = (await open()).find((m) => m.element_id === 'E4')!;
  assert.equal(e4.version_id, (await kolab.latestCommitted(child))!.id);
  await kolab.resolveOverride(product, e4.id, 'reaffirm');

  assert.deepEqual(await open(), []);
  const t = await textOf(kolab, child);
  assert.equal(t.E3, 'Session timeout is 10 minutes for admins, 30 for shoppers.');
  assert.equal(t.E4, 'Show the promo banner on weekends.');
  await kolab.close();
});

test('precedent: the same (base, parent, child) triple resolves itself next time', async () => {
  const { kolab, product, parent, child, sibling } = await family();
  await kolab.commit(product, parent, {
    elements: els({ ...PARENT_V1, E3: 'Session timeout is 10 minutes.' }),
  });
  const childV = (await kolab.latestCommitted(child))!.id;
  const acmeMark = (await kolab.openMarks()).find((m) => m.element_id === 'E3' && m.version_id === childV)!;
  await kolab.resolveOverride(product, acmeMark.id, 'adopt_parent');

  // Globex had the identical override. On the parent's next commit it rebases,
  // finds the precedent, and adopts the parent without asking anyone.
  await kolab.commit(product, parent, {
    elements: els({ ...PARENT_V1, E3: 'Session timeout is 10 minutes.', E2: 'Logo sits top-center.' }),
  });
  assert.equal((await textOf(kolab, sibling)).E3, 'Session timeout is 10 minutes.');
  const globexV = (await kolab.latestCommitted(sibling))!.id;
  assert.deepEqual((await kolab.openMarks()).filter((m) => m.version_id === globexV), []);
  await kolab.close();
});

test('the review gate catches what the three-way rule cannot see', async () => {
  // Toy reviewer: one spec may not state two different header colors.
  const { kolab, product } = await setup(({ elements }) => {
    const colors = new Set(elements.flatMap((e) => /Header is (\w+)/.exec(e.text)?.[1] ?? []));
    return colors.size > 1 ? { ok: false, note: `header color conflict: ${[...colors].join(' vs ')}` } : { ok: true };
  });
  const parent = await kolab.createNode(product, 'functional_spec', 'Theme', 'Q');
  const q1 = await kolab.commit(product, parent, { elements: els({ A1: 'Header is blue.' }) });
  const child = await kolab.createNode(product, 'functional_spec', 'Theme for Acme', 'QC');
  const c1 = await kolab.commit(product, child, { parent: q1, deltas: [{ kind: 'override', element: 'A1', text: 'Header is green.' }] });

  // Parent adds a different element, consistent with itself, that contradicts
  // the child's override. No shared element, so the three-way rule sees nothing.
  await kolab.commit(product, parent, { elements: els({ A1: 'Header is blue.', A2: 'Header is blue on mobile too.' }) });

  assert.equal((await kolab.latestCommitted(child))!.id, c1, 'child stays on its old parent');
  const marks = await kolab.openMarks();
  assert.deepEqual(marks.map((m) => [m.version_id, m.reason]), [[c1, 'review_failed']]);
  assert.match((await kolab.openQueries())[0].question, /green vs blue/);
  await kolab.close();
});
