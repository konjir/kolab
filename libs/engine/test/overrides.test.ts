import { expect, test } from '@jest/globals';
import { commitReviewed, els, marksOn, people, rejection, setup, textOf } from '@konjir/engine/testing';

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
  const parent = await kolab.createNode(product, 'spec', 'Storefront', 'P');
  const p1 = await kolab.commit(product, parent, { elements: els(PARENT_V1) });
  const child = await kolab.createNode(product, 'prototype', 'Storefront for Acme', 'C');
  await kolab.commit(product, child, { parent: p1, deltas: CHILD_DELTAS });
  const sibling = await kolab.createNode(product, 'prototype', 'Storefront for Globex', 'G');
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

  expect(await textOf(kolab, child)).toStrictEqual({
    E1: 'Background is navy.',                 // override retired; now inherited
    E2: 'Logo sits top-center.',               // inherited change arrived automatically
    E3: 'Session timeout is 30 minutes.',      // dirty, but the override still stands
    E4: 'Show the promo banner on weekends.',  // orphaned, still stands
    X1: 'Support chat is on.',                 // child's own addition
  });

  const childV = (await kolab.latestCommitted(child))!;
  const marks = (await kolab.openMarks()).filter((m) => m.version_id === childV.id);
  expect(marks.map((m) => [m.element_id, m.reason]).sort()).toStrictEqual([['E3', 'override_stale'], ['E4', 'override_orphaned']]);
  const deltaKinds = (await kolab.db.query<{ element_id: string; state: string }>(
    `select element_id, state from delta where version_id = $1 order by element_id`, [childV.id])).rows;
  expect(deltaKinds.map((d) => [d.element_id, d.state])).toStrictEqual([['E3', 'dirty'], ['E4', 'orphaned'], ['X1', 'clean']]);   // E1's override is gone
  expect((await kolab.openQueries()).filter((q) => q.version_id === childV.id).length).toBe(2);
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
  expect(e4.version_id).toBe((await kolab.latestCommitted(child))!.id);
  await kolab.resolveOverride(product, e4.id, 'reaffirm');

  expect(await open()).toStrictEqual([]);
  const t = await textOf(kolab, child);
  expect(t.E3).toBe('Session timeout is 10 minutes for admins, 30 for shoppers.');
  expect(t.E4).toBe('Show the promo banner on weekends.');
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
  expect((await textOf(kolab, sibling)).E3).toBe('Session timeout is 10 minutes.');
  const globexV = (await kolab.latestCommitted(sibling))!.id;
  expect((await kolab.openMarks()).filter((m) => m.version_id === globexV)).toStrictEqual([]);
  await kolab.close();
});

test('a rebase Kolab makes commits after structural checks only, without review, even past what a reviewer would catch (VER12, D19)', async () => {
  // Toy submission checks, standing in for a reviewer: one spec may not state two different
  // header colors. They run on people's versions only; Kolab's own rebases get the structural
  // checks alone.
  let reviewed = 0;
  const { kolab, product } = await setup(({ elements }) => {
    reviewed++;
    const colors = new Set(elements.flatMap((e) => /Header is (\w+)/.exec(e.text)?.[1] ?? []));
    return colors.size > 1 ? { ok: false, note: `header color conflict: ${[...colors].join(' vs ')}` } : { ok: true };
  });
  await people(kolab, 'dave', { layers: ['functional'] });
  const dave = await kolab.openSession('dave', 'product');   // a reviewer for alice's versions
  const parent = await kolab.createNode(product, 'spec', 'Theme', 'Q');
  const q1 = await commitReviewed(kolab, product, dave, parent, { elements: els({ A1: 'Header is blue.' }) });
  const child = await kolab.createNode(product, 'prototype', 'Theme for Acme', 'QC');
  const c1 = await commitReviewed(kolab, product, dave, child, { parent: q1, deltas: [{ kind: 'override', element: 'A1', text: 'Header is green.' }] });
  expect(reviewed).toBe(2);

  // Parent adds a different element, consistent with itself, that contradicts
  // the child's override. No shared element, so the three-way rule sees nothing,
  // and the rebase commits on structural checks, with no review request.
  await commitReviewed(kolab, product, dave, parent, { elements: els({ A1: 'Header is blue.', A2: 'Header is blue on mobile too.' }) });
  expect(reviewed).toBe(3);   // the parent's own version only

  const rebased = (await kolab.latestCommitted(child))!;
  expect(rebased.id).not.toBe(c1);
  expect([rebased.active_role, rebased.state]).toStrictEqual(['system', 'committed']);
  expect(await kolab.reviewRequests()).toStrictEqual([]);
  expect((await kolab.db.query(`select 1 from review_request where version_id = $1`, [rebased.id])).rows).toStrictEqual([]);
  expect(await textOf(kolab, child)).toStrictEqual({ A1: 'Header is green.', A2: 'Header is blue on mobile too.' });
  expect(await kolab.openMarks()).toStrictEqual([]);
  await kolab.close();
});

test('a rebase that fails the structural checks leaves its variant a rebase_failed mark and question', async () => {
  const { kolab, product } = await setup();
  const parent = await kolab.createNode(product, 'spec', 'Theme', 'Q');
  const q1 = await kolab.commit(product, parent, { elements: els({ A1: 'Header is blue.' }) });
  const child = await kolab.createNode(product, 'prototype', 'Theme for Acme', 'QC');
  const c1 = await kolab.commit(product, child, { parent: q1, deltas: [{ kind: 'override', element: 'A1', text: 'Header is green.' }] });
  // The parent adds, word for word, the text the child overrides A1 with.
  await kolab.commit(product, parent, { elements: els({ A1: 'Header is blue.', A2: 'Header is green.' }) });

  expect((await kolab.latestCommitted(child))!.id).toBe(c1); // child stays on its old parent
  expect((await kolab.openMarks()).map((m) => [m.version_id, m.reason])).toStrictEqual([[c1, 'rebase_failed']]);
  expect((await kolab.openQueries())[0].question).toMatch(/A2 repeats A1 word for word/);
  await kolab.close();
});

test('resolving an override checks who may resolve before telling what the mark is: a Read-only session and another kolab\'s learn nothing of it', async () => {
  const { kolab, product, parent, child } = await family();
  const p1 = (await kolab.latestCommitted(parent))!.id;
  const d1 = await kolab.commit(product, await kolab.createNode(product, 'prototype', 'Docs', 'D'), { elements: els({ D1: 'Sessions time out.' }) });
  await kolab.link(product, { kind: 'dependency', source: d1, sourceElement: 'D1', target: p1, targetElement: 'E3' });
  await kolab.commit(product, parent, { elements: els({ ...PARENT_V1, E3: 'Session timeout is 10 minutes.' }) });
  const childV = (await kolab.latestCommitted(child))!.id;
  const override = (await kolab.openMarks()).find((m) => m.version_id === childV && m.element_id === 'E3')!;
  const changed = (await kolab.openMarks()).find((m) => m.reason === 'changed')!;

  // carol holds only Read: refused for want of Write, whichever the mark.
  const carol = await kolab.openSession('carol', 'product');
  for (const m of [override, changed]) {
    const refused = await rejection(kolab.resolveOverride(carol, m.id, 'reaffirm'));
    expect(refused).toMatch(/AccessError: carol may not write the functional layer/);
    expect(refused).not.toMatch(/override mark/);
  }
  expect(await rejection(kolab.resolveOverride(carol, 'nope', 'reaffirm'))).toBe('Error: no mark nope');
  // From another kolab, the marks are as if they weren't there, like an id no mark has.
  await kolab.addActor('dana');
  await kolab.createKolab('elsewhere', { owner: 'dana' });
  const dana = await kolab.openSession('dana', 'product', { kolab: 'elsewhere' });
  for (const id of [override.id, changed.id]) expect(await rejection(kolab.resolveOverride(dana, id, 'reaffirm'))).toBe(`Error: no mark ${id}`);
  // Only to the layer that owns it is a mark that isn't an override's told so.
  expect(await rejection(kolab.resolveOverride(product, changed.id, 'reaffirm'))).toBe(`Error: ${changed.id} is not an open override mark`);
  await kolab.close();
});

test('marksFor picks only the marks its filter asks for, as the session, before describing them', async () => {
  const { kolab, product, parent, child, sibling } = await family();
  await kolab.commit(product, parent, { elements: els({ ...PARENT_V1, E3: 'Session timeout is 10 minutes.' }) });
  const childV = (await kolab.latestCommitted(child))!.id;
  const childMarks = (await kolab.openMarks()).filter((m) => m.version_id === childV).map((m) => m.id).sort();
  expect(childMarks).toHaveLength(1);
  expect((await kolab.openMarks()).length).toBeGreaterThan(childMarks.length);   // the sibling's too

  const described: (string[] | undefined)[] = [];
  const describe = kolab.describeMarks.bind(kolab);
  kolab.describeMarks = (filter) => { described.push(filter?.ids); return describe(filter); };
  expect((await kolab.marksFor(product, { node: child })).map((m) => m.mark)).toStrictEqual(childMarks);
  expect(described).toStrictEqual([childMarks]);
  // A layer with no marks picks none, so nothing is described.
  expect(await kolab.marksFor(product, { layer: 'technical' })).toStrictEqual([]);
  expect(described).toHaveLength(1);
  expect((await kolab.marksFor(product, { node: sibling })).map((m) => m.reason)).toStrictEqual(['override_stale']);
  expect(described).toHaveLength(2);
  await kolab.close();
});
