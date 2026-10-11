// Regressions for the six bugs found in the first adversarial review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GateError } from '../src/hub.js';
import { setup, els, marksOn, textOf } from './helpers.js';

test('a pending draft does not hide its node from the cascade; the draft catches up on commit', async () => {
  const { hub, product, engineer } = await setup();
  const S = await hub.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await hub.commit(product, S, { elements: els({ R1: 'Checkout within 30 seconds.' }) });
  const B = await hub.createNode(engineer, 'technical_binding', 'B', 'B');
  const b1 = await hub.commit(engineer, B, { elements: els({ b1: 'Order worker' }) });
  await hub.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: s1, targetElement: 'R1' });

  const draft = await hub.draft(engineer, B, { elements: els({ b1: 'Order worker v2' }) });
  await hub.commit(product, S, { elements: els({ R1: 'Checkout within 10 seconds.' }) });
  assert.deepEqual((await marksOn(hub, B)).map((m) => [m.version_id, m.reason]), [[b1, 'changed']]);

  await hub.review(draft);
  assert.deepEqual((await marksOn(hub, B)).map((m) => [m.version_id, m.reason]), [[draft, 'changed']]);
  await hub.close();
});

test('a variant drafted while its parent moved on is rebased when the draft commits', async () => {
  const { hub, product } = await setup();
  const P = await hub.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await hub.commit(product, P, { elements: els({ E1: 'Logo top-left.', E2: 'White background.' }) });
  const C = await hub.createNode(product, 'functional_spec', 'C', 'C');
  await hub.commit(product, C, { parent: p1, deltas: [{ kind: 'override', element: 'E2', text: 'Navy background.' }] });

  const draft = await hub.draft(product, C, { deltas: [{ kind: 'add', element: 'X', text: 'Chat on.' }] });
  await hub.commit(product, P, { elements: els({ E1: 'Logo top-center.', E2: 'White background.' }) });
  await hub.review(draft);

  assert.deepEqual(await textOf(hub, C), { E1: 'Logo top-center.', E2: 'Navy background.', X: 'Chat on.' });
  await hub.close();
});

test('optimistic concurrency: a draft overtaken by a human commit is rejected, not silently merged', async () => {
  const { hub, engineer } = await setup();
  await hub.addActor('dave');
  const dave = await hub.openSession('dave', 'engineer');
  const B = await hub.createNode(engineer, 'technical_binding', 'B', 'B');
  await hub.commit(engineer, B, { elements: els({ b1: 'v1' }) });
  const bobDraft = await hub.draft(engineer, B, { elements: els({ b1: 'bob edit' }) });
  await hub.commit(dave, B, { elements: els({ b1: 'dave edit' }) });
  const r = await hub.review(bobDraft);
  assert.equal(r.ok, false);
  assert.match(r.note!, /stale draft/);
  assert.equal((await textOf(hub, B)).b1, 'dave edit');
  await hub.close();
});

test('a rejected override resolution keeps the mark and the query open', async () => {
  let reject = false;
  const { hub, product } = await setup(() => (reject ? { ok: false, note: 'no' } : { ok: true }));
  const P = await hub.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await hub.commit(product, P, { elements: els({ E3: 'Timeout 15.' }) });
  const C = await hub.createNode(product, 'functional_spec', 'C', 'C');
  await hub.commit(product, C, { parent: p1, deltas: [{ kind: 'override', element: 'E3', text: 'Timeout 30.' }] });
  await hub.commit(product, P, { elements: els({ E3: 'Timeout 10.' }) });
  const [m] = await marksOn(hub, C);

  reject = true;
  const r = await hub.resolveOverride(product, m.id, 'amend', 'Timeout 20.');
  assert.equal(r.verdict.ok, false);
  assert.deepEqual((await marksOn(hub, C)).map((x) => x.id), [m.id]);
  assert.equal((await hub.openQueries()).length, 1);
  const precedents = await hub.db.query(`select 1 from precedent`);
  assert.equal(precedents.rows.length, 0, 'no precedent from a rejected resolution');
  await hub.close();
});

test('variants may not inherit from each other in a loop', async () => {
  const { hub, product } = await setup();
  const A = await hub.createNode(product, 'functional_spec', 'A', 'A');
  const a1 = await hub.commit(product, A, { elements: els({ E: 'x' }) });
  const B = await hub.createNode(product, 'functional_spec', 'B', 'B');
  const b1 = await hub.commit(product, B, { parent: a1, deltas: [{ kind: 'add', element: 'F', text: 'y' }] });
  await assert.rejects(hub.commit(product, A, { parent: b1, deltas: [{ kind: 'add', element: 'G', text: 'z' }] }), GateError);
  await hub.close();
});

test('row-level security: agents cannot self-commit, mislabel a layer, or link from another layer', async () => {
  const { hub, product, engineer } = await setup();
  const T = await hub.createNode(engineer, 'technical_binding', 'T', 'T');
  const t1 = await hub.commit(engineer, T, { elements: els({ t: 'x' }) });
  const S = await hub.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await hub.commit(product, S, { elements: els({ R: 'r' }) });
  const asAgent = (session: string, sql: string, params: unknown[] = []) => hub.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [session]);
    await tx.query(sql, params);
  });
  const ins = `insert into version(id, node_id, seq, layer, state, actor_id, active_role) values ($1, $2, 99, $3, $4, 'x', 'x')`;

  await assert.rejects(asAgent(product, ins, ['v1', 'T', 'functional', 'drafted']), /row-level security/, 'layer label vs node');
  await assert.rejects(asAgent(product, ins, ['v2', 'S', 'functional', 'committed']), /row-level security/, 'self-commit');
  await assert.rejects(asAgent(product,
    `insert into edge(id, kind, source_version_id, target_version_id, target_fingerprint) values ('e', 'dependency', $1, $2, 'x')`,
    [t1, s1]), /row-level security/, 'edge from another layer');
  await hub.close();
});

test('a whole-version dependent gets one mark per commit, and clears only when every cause clears', async () => {
  const { hub, product, engineer } = await setup();
  const S = await hub.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await hub.commit(product, S, { elements: els({ R1: 'a one', R2: 'b two' }) });
  const B = await hub.createNode(engineer, 'technical_binding', 'B', 'B');
  const b = await hub.commit(engineer, B, { elements: els({ b1: 'w1', b2: 'w2' }) });
  await hub.link(engineer, { kind: 'dependency', source: b, sourceElement: 'b1', target: s1, targetElement: 'R1' });
  await hub.link(engineer, { kind: 'dependency', source: b, sourceElement: 'b2', target: s1, targetElement: 'R2' });
  const X = await hub.createNode(engineer, 'implementation', 'X', 'X');
  await hub.commit(engineer, X, { elements: els({ c: 'code' }) });
  const x = (await hub.latestCommitted(X))!.id;
  await hub.link(engineer, { kind: 'dependency', source: x, target: b });

  await hub.commit(product, S, { elements: els({ R1: 'a ONE', R2: 'b TWO' }) });
  assert.equal((await marksOn(hub, X)).length, 1);

  const [d1, d2] = (await marksOn(hub, B));
  await hub.clear(engineer, d1.id);
  assert.equal((await marksOn(hub, X)).length, 1, 'still dirty: the other cause is open');
  await hub.clear(engineer, d2.id);
  assert.equal((await marksOn(hub, X)).length, 0);
  await hub.close();
});

test('an equivalence pair does not flag the version that was just committed', async () => {
  const { hub, product } = await setup();
  const A = await hub.createNode(product, 'functional_spec', 'A', 'A');
  const a1 = await hub.commit(product, A, { elements: els({ E: 'x' }) });
  const B = await hub.createNode(product, 'prototype', 'B', 'B');
  const b1 = await hub.commit(product, B, { elements: els({ F: 'y' }) });
  await hub.link(product, { kind: 'equivalence', source: a1, sourceElement: 'E', target: b1, targetElement: 'F' });
  await hub.link(product, { kind: 'equivalence', source: b1, sourceElement: 'F', target: a1, targetElement: 'E' });
  await hub.commit(product, A, { elements: els({ E: 'x changed' }) });
  assert.deepEqual((await hub.openMarks()).map((m) => [m.version_id, m.element_id, m.reason]), [[b1, 'F', 'changed']]);
  await hub.close();
});

// ---- second review pass -------------------------------------------------------

test('folding keeps the draft author, so a second stale draft is rejected instead of erasing the first', async () => {
  const { hub, product } = await setup();
  await hub.addActor('erin');
  const erin = await hub.openSession('erin', 'product');
  const P = await hub.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await hub.commit(product, P, { elements: els({ E1: 'one' }) });
  const C = await hub.createNode(product, 'functional_spec', 'C', 'C');
  await hub.commit(product, C, { parent: p1, deltas: [{ kind: 'add', element: 'X', text: 'x' }] });
  const d1 = await hub.draft(product, C, { deltas: [{ kind: 'add', element: 'Y', text: 'y' }] });
  const d2 = await hub.draft(erin, C, { deltas: [{ kind: 'add', element: 'Z', text: 'z' }] });
  await hub.commit(product, P, { elements: els({ E1: 'one, revised' }) });

  assert.equal((await hub.review(d1)).ok, true);
  const second = await hub.review(d2);
  assert.equal(second.ok, false);
  assert.match(second.note!, /stale draft/);
  assert.deepEqual(await textOf(hub, C), { E1: 'one, revised', X: 'x', Y: 'y' });
  await hub.close();
});

test('folding carries the dependencies the draft declared', async () => {
  const { hub, product } = await setup();
  const S = await hub.createNode(product, 'functional_spec', 'S', 'S');
  const s1 = await hub.commit(product, S, { elements: els({ R1: 'r one' }) });
  const P = await hub.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await hub.commit(product, P, { elements: els({ E1: 'one' }) });
  const C = await hub.createNode(product, 'functional_spec', 'C', 'C');
  await hub.commit(product, C, { parent: p1, deltas: [{ kind: 'add', element: 'K', text: 'k' }] });
  const draft = await hub.draft(product, C, { deltas: [{ kind: 'add', element: 'K2', text: 'k2' }] });
  await hub.link(product, { kind: 'dependency', source: draft, sourceElement: 'K2', target: s1, targetElement: 'R1' });
  await hub.commit(product, P, { elements: els({ E1: 'one, revised' }) });
  const folded = await hub.review(draft);
  assert.equal(folded.ok, true);

  await hub.commit(product, S, { elements: els({ R1: 'r one, changed' }) });
  assert.deepEqual((await marksOn(hub, C)).map((m) => [m.version_id, m.element_id, m.reason]),
    [[folded.version, 'K2', 'changed']]);
  await hub.close();
});

test('a later successful rebase settles an earlier review_failed mark', async () => {
  let rejectSystem = true;
  const { hub, product } = await setup(({ version }) =>
    rejectSystem && version.active_role === 'system' ? { ok: false, note: 'no' } : { ok: true });
  const P = await hub.createNode(product, 'functional_spec', 'P', 'P');
  const p1 = await hub.commit(product, P, { elements: els({ E1: 'one' }) });
  const C = await hub.createNode(product, 'functional_spec', 'C', 'C');
  await hub.commit(product, C, { parent: p1, deltas: [{ kind: 'add', element: 'X', text: 'x' }] });
  await hub.commit(product, P, { elements: els({ E1: 'two' }) });
  assert.deepEqual((await marksOn(hub, C)).map((m) => m.reason), ['review_failed']);

  rejectSystem = false;
  await hub.commit(product, P, { elements: els({ E1: 'three' }) });
  assert.deepEqual(await marksOn(hub, C), []);
  assert.equal((await hub.openQueries()).length, 0);
  assert.equal((await textOf(hub, C)).E1, 'three');
  await hub.close();
});

test('propagation skips only the changed element, not the whole triggering node', async () => {
  const { hub, product } = await setup();
  const A = await hub.createNode(product, 'functional_spec', 'A', 'A');
  const a1 = await hub.commit(product, A, { elements: els({ E1: 'e one', E2: 'e two' }) });
  const B = await hub.createNode(product, 'prototype', 'B', 'B');
  const b1 = await hub.commit(product, B, { elements: els({ F: 'f' }) });
  await hub.link(product, { kind: 'dependency', source: b1, sourceElement: 'F', target: a1, targetElement: 'E1' });
  await hub.link(product, { kind: 'dependency', source: a1, sourceElement: 'E2', target: b1, targetElement: 'F' });
  const a2 = await hub.commit(product, A, { elements: els({ E1: 'e one, changed', E2: 'e two' }) });
  assert.deepEqual((await hub.openMarks()).map((m) => [m.version_id, m.element_id, m.reason]).sort(),
    [[a2, 'E2', 'upstream_dirty'], [b1, 'F', 'changed']].sort());
  await hub.close();
});
