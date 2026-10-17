// Regressions for the six bugs found in the first adversarial review.
import { expect, test } from '@jest/globals';
import { GateError } from '@konjir/engine';
import { setup, els, marksOn, textOf, rejection } from '@konjir/engine/testing';

test('a pending draft does not hide its node from the cascade; the draft catches up on commit', async () => {
  const { kolab, product, engineer } = await setup();
  const S = await kolab.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 30 seconds.' }) });
  const B = await kolab.createNode(engineer, 'technical_binding', 'B', 'B');
  const b1 = await kolab.commit(engineer, B, { elements: els({ b1: 'Order worker' }) });
  await kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1' });

  const draft = await kolab.draft(engineer, B, { elements: els({ b1: 'Order worker v2' }) });
  await kolab.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.' }) });
  expect((await marksOn(kolab, B)).map((m) => [m.version_id, m.reason])).toStrictEqual([[b1, 'changed']]);

  await kolab.review(draft);
  expect((await marksOn(kolab, B)).map((m) => [m.version_id, m.reason])).toStrictEqual([[draft, 'changed']]);
  await kolab.close();
});

test('a variant drafted while its parent moved on is rebased when the draft commits', async () => {
  const { kolab, product } = await setup();
  const P = await kolab.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await kolab.commit(product, P, { elements: els({ E1: 'Logo top-left.', E2: 'White background.' }) });
  const C = await kolab.createNode(product, 'functional_spec', 'C', 'C');
  await kolab.commit(product, C, { parent: p1, deltas: [{ kind: 'override', element: 'E2', text: 'Navy background.' }] });

  const draft = await kolab.draft(product, C, { deltas: [{ kind: 'add', element: 'X', text: 'Chat on.' }] });
  await kolab.commit(product, P, { elements: els({ E1: 'Logo top-center.', E2: 'White background.' }) });
  await kolab.review(draft);

  expect(await textOf(kolab, C)).toStrictEqual({ E1: 'Logo top-center.', E2: 'Navy background.', X: 'Chat on.' });
  await kolab.close();
});

test('optimistic concurrency: a draft overtaken by a human commit is rejected, not silently merged', async () => {
  const { kolab, engineer } = await setup();
  await kolab.addActor('dave');
  const dave = await kolab.openSession('dave', 'engineer');
  const B = await kolab.createNode(engineer, 'technical_binding', 'B', 'B');
  await kolab.commit(engineer, B, { elements: els({ b1: 'v1' }) });
  const bobDraft = await kolab.draft(engineer, B, { elements: els({ b1: 'bob edit' }) });
  await kolab.commit(dave, B, { elements: els({ b1: 'dave edit' }) });
  const r = await kolab.review(bobDraft);
  expect(r.ok).toBe(false);
  expect(r.note!).toMatch(/stale draft/);
  expect((await textOf(kolab, B)).b1).toBe('dave edit');
  await kolab.close();
});

test('a rejected override resolution keeps the mark and the query open', async () => {
  let reject = false;
  const { kolab, product } = await setup(() => (reject ? { ok: false, note: 'no' } : { ok: true }));
  const P = await kolab.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await kolab.commit(product, P, { elements: els({ E3: 'Timeout 15.' }) });
  const C = await kolab.createNode(product, 'functional_spec', 'C', 'C');
  await kolab.commit(product, C, { parent: p1, deltas: [{ kind: 'override', element: 'E3', text: 'Timeout 30.' }] });
  await kolab.commit(product, P, { elements: els({ E3: 'Timeout 10.' }) });
  const [m] = await marksOn(kolab, C);

  reject = true;
  const r = await kolab.resolveOverride(product, m.id, 'amend', 'Timeout 20.');
  expect(r.verdict.ok).toBe(false);
  expect((await marksOn(kolab, C)).map((x) => x.id)).toStrictEqual([m.id]);
  expect((await kolab.openQueries()).length).toBe(1);
  const precedents = await kolab.db.query(`select 1 from precedent`);
  expect(precedents.rows.length).toBe(0); // no precedent from a rejected resolution
  await kolab.close();
});

test('variants may not inherit from each other in a loop', async () => {
  const { kolab, product } = await setup();
  const A = await kolab.createNode(product, 'functional_spec', 'A', 'A');
  const a1 = await kolab.commit(product, A, { elements: els({ E: 'x' }) });
  const B = await kolab.createNode(product, 'functional_spec', 'B', 'B');
  const b1 = await kolab.commit(product, B, { parent: a1, deltas: [{ kind: 'add', element: 'F', text: 'y' }] });
  await expect(kolab.commit(product, A, { parent: b1, deltas: [{ kind: 'add', element: 'G', text: 'z' }] })).rejects.toBeInstanceOf(GateError);
  await kolab.close();
});

test('row-level security: agents cannot self-commit, mislabel a layer, or link from another layer', async () => {
  const { kolab, product, engineer } = await setup();
  const T = await kolab.createNode(engineer, 'technical_binding', 'T', 'T');
  const t1 = await kolab.commit(engineer, T, { elements: els({ t: 'x' }) });
  const S = await kolab.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await kolab.commit(product, S, { elements: els({ R: 'r' }) });
  const asAgent = (session: string, sql: string, params: unknown[] = []) => kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [session]);
    await tx.query(sql, params);
  });
  const ins = `insert into version(id, node_id, seq, layer, state, actor_id, active_role) values ($1, $2, 99, $3, $4, 'x', 'x')`;

  expect(await rejection(asAgent(product, ins, ['v1', 'T', 'functional', 'drafted']))).toMatch(/row-level security/); // layer label vs node
  expect(await rejection(asAgent(product, ins, ['v2', 'S', 'functional', 'committed']))).toMatch(/row-level security/); // self-commit
  expect(await rejection(asAgent(product,
    `insert into edge(id, kind, source_version_id, target_version_id, target_fingerprint) values ('e', 'dependency', $1, $2, 'x')`,
    [t1, s1]))).toMatch(/row-level security/); // edge from another layer
  await kolab.close();
});

test('a whole-version dependent gets one mark per commit, and clears only when every cause clears', async () => {
  const { kolab, product, engineer } = await setup();
  const S = await kolab.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await kolab.commit(product, S, { elements: els({ R1: 'a one', R2: 'b two' }) });
  const B = await kolab.createNode(engineer, 'technical_binding', 'B', 'B');
  const b = await kolab.commit(engineer, B, { elements: els({ b1: 'w1', b2: 'w2' }) });
  await kolab.link(engineer, { kind: 'dependency', source: b, sourceElement: 'b1', target: s1, targetElement: 'R1' });
  await kolab.link(engineer, { kind: 'dependency', source: b, sourceElement: 'b2', target: s1, targetElement: 'R2' });
  const X = await kolab.createNode(engineer, 'implementation', 'X', 'X');
  await kolab.commit(engineer, X, { elements: els({ c: 'code' }) });
  const x = (await kolab.latestCommitted(X))!.id;
  await kolab.link(engineer, { kind: 'dependency', source: x, target: b });

  await kolab.commit(product, S, { elements: els({ R1: 'a ONE', R2: 'b TWO' }) });
  expect((await marksOn(kolab, X)).length).toBe(1);

  const [d1, d2] = (await marksOn(kolab, B));
  await kolab.clear(engineer, d1.id);
  expect((await marksOn(kolab, X)).length).toBe(1); // still dirty: the other cause is open
  await kolab.clear(engineer, d2.id);
  expect((await marksOn(kolab, X)).length).toBe(0);
  await kolab.close();
});

test('an equivalence pair does not flag the version that was just committed', async () => {
  const { kolab, product } = await setup();
  const A = await kolab.createNode(product, 'functional_spec', 'A', 'A');
  const a1 = await kolab.commit(product, A, { elements: els({ E: 'x' }) });
  const B = await kolab.createNode(product, 'prototype', 'B', 'B');
  const b1 = await kolab.commit(product, B, { elements: els({ F: 'y' }) });
  await kolab.link(product, { kind: 'equivalence', source: a1, sourceElement: 'E', target: b1, targetElement: 'F' });
  await kolab.link(product, { kind: 'equivalence', source: b1, sourceElement: 'F', target: a1, targetElement: 'E' });
  await kolab.commit(product, A, { elements: els({ E: 'x changed' }) });
  expect((await kolab.openMarks()).map((m) => [m.version_id, m.element_id, m.reason])).toStrictEqual([[b1, 'F', 'changed']]);
  await kolab.close();
});

// ---- second review pass -------------------------------------------------------

test('folding keeps the draft author, so a second stale draft is rejected instead of erasing the first', async () => {
  const { kolab, product } = await setup();
  await kolab.addActor('erin');
  const erin = await kolab.openSession('erin', 'product');
  const P = await kolab.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await kolab.commit(product, P, { elements: els({ E1: 'one' }) });
  const C = await kolab.createNode(product, 'functional_spec', 'C', 'C');
  await kolab.commit(product, C, { parent: p1, deltas: [{ kind: 'add', element: 'X', text: 'x' }] });
  const d1 = await kolab.draft(product, C, { deltas: [{ kind: 'add', element: 'Y', text: 'y' }] });
  const d2 = await kolab.draft(erin, C, { deltas: [{ kind: 'add', element: 'Z', text: 'z' }] });
  await kolab.commit(product, P, { elements: els({ E1: 'one, revised' }) });

  expect((await kolab.review(d1)).ok).toBe(true);
  const second = await kolab.review(d2);
  expect(second.ok).toBe(false);
  expect(second.note!).toMatch(/stale draft/);
  expect(await textOf(kolab, C)).toStrictEqual({ E1: 'one, revised', X: 'x', Y: 'y' });
  await kolab.close();
});

test('folding carries the dependencies the draft declared', async () => {
  const { kolab, product } = await setup();
  const S = await kolab.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await kolab.commit(product, S, { elements: els({ R1: 'r one' }) });
  const P = await kolab.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await kolab.commit(product, P, { elements: els({ E1: 'one' }) });
  const C = await kolab.createNode(product, 'functional_spec', 'C', 'C');
  await kolab.commit(product, C, { parent: p1, deltas: [{ kind: 'add', element: 'K', text: 'k' }] });
  const draft = await kolab.draft(product, C, { deltas: [{ kind: 'add', element: 'K2', text: 'k2' }] });
  await kolab.link(product, { kind: 'dependency', source: draft, sourceElement: 'K2', target: s1, targetElement: 'R1' });
  await kolab.commit(product, P, { elements: els({ E1: 'one, revised' }) });
  const folded = await kolab.review(draft);
  expect(folded.ok).toBe(true);

  await kolab.commit(product, S, { elements: els({ R1: 'r one, changed' }) });
  expect((await marksOn(kolab, C)).map((m) => [m.version_id, m.element_id, m.reason])).toStrictEqual([[folded.version, 'K2', 'changed']]);
  await kolab.close();
});

test('a later successful rebase settles an earlier rebase_failed mark', async () => {
  let rejectSystem = true;
  const { kolab, product } = await setup(({ version }) =>
    rejectSystem && version.active_role === 'system' ? { ok: false, note: 'no' } : { ok: true });
  const P = await kolab.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await kolab.commit(product, P, { elements: els({ E1: 'one' }) });
  const C = await kolab.createNode(product, 'functional_spec', 'C', 'C');
  await kolab.commit(product, C, { parent: p1, deltas: [{ kind: 'add', element: 'X', text: 'x' }] });
  await kolab.commit(product, P, { elements: els({ E1: 'two' }) });
  expect((await marksOn(kolab, C)).map((m) => m.reason)).toStrictEqual(['rebase_failed']);
  // The inbox tells a failed rebase from a rejected review (D44).
  const [described] = await kolab.describeMarks({ node: C });
  expect(described).toMatchObject({ reason: 'rebase_failed', because: `parent ${P} version 2` });
  expect(described.next).toMatch(/^Rebasing onto the new parent failed/);

  rejectSystem = false;
  await kolab.commit(product, P, { elements: els({ E1: 'three' }) });
  expect(await marksOn(kolab, C)).toStrictEqual([]);
  expect((await kolab.openQueries()).length).toBe(0);
  expect((await textOf(kolab, C)).E1).toBe('three');
  await kolab.close();
});

test('propagation skips only the changed element, not the whole triggering node', async () => {
  const { kolab, product } = await setup();
  const A = await kolab.createNode(product, 'functional_spec', 'A', 'A');
  const a1 = await kolab.commit(product, A, { elements: els({ E1: 'e one', E2: 'e two' }) });
  const B = await kolab.createNode(product, 'prototype', 'B', 'B');
  const b1 = await kolab.commit(product, B, { elements: els({ F: 'f' }) });
  await kolab.link(product, { kind: 'dependency', source: b1, sourceElement: 'F', target: a1, targetElement: 'E1' });
  await kolab.link(product, { kind: 'dependency', source: a1, sourceElement: 'E2', target: b1, targetElement: 'F' });
  const a2 = await kolab.commit(product, A, { elements: els({ E1: 'e one, changed', E2: 'e two' }) });
  expect((await kolab.openMarks()).map((m) => [m.version_id, m.element_id, m.reason]).sort()).toStrictEqual([[a2, 'E2', 'upstream_dirty'], [b1, 'F', 'changed']].sort());
  await kolab.close();
});
