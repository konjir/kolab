// A work package's fields and the plan's checks (W5.1a; PLN1, PLN2, PLN3, D98; migration 0029): a
// plan's elements carry done-when, Depends on, size, milestone, target date and repo; they are read
// back as stored, carried by deltas, and covered by the fingerprint only where they exist; a plan
// version that breaks PLN2 goes back to its author, naming it; and the database holds work fields
// to a plan's elements, in the shape Kolab stores, for every role.
import { expect, test } from '@jest/globals';
import { fingerprint } from '@konjir/address';
import { elementFingerprint, sessionKey } from '@konjir/engine';
import { els, marksOn, rejection, setup } from '@konjir/engine/testing';
import { ADMIN_DOER, MAX_DEPENDS_ON, MAX_DONE_WHEN, WORK_SIZES, type ElementInput } from '@konjir/types';

/** The kolab's spec, a binding of it with three elements, and its plan, made but empty. */
async function planned() {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  const s1 = await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.', R2: 'Orders ship in a day.', R3: 'Orders can be tracked.' }) });
  await kolab.createNode(engineer, 'binding', 'Orders on Postgres', 'orders-pg');
  const b1 = await kolab.commit(engineer, 'orders-pg', { elements: els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.', b3: 'A tracking page.' }) });
  await kolab.createNode(engineer, 'plan', 'Plan', 'orders-plan');
  /** A Delivers: a dependency link from work package `from` to binding element `to`. */
  const delivers = (from: string, to: string) => ({ kind: 'dependency' as const, sourceElement: from, target: b1, targetElement: to });
  return { ...ctx, s1, b1, delivers };
}

/** The M5 check's plan: four work packages, W2.1 after W1.1, and milestone M1 gathering them, with a date. */
const PLAN: ElementInput[] = [
  { id: 'W1.1', text: 'Build the cancel endpoint.', work: { done_when: 'POST /orders/:id/cancel cancels an order that has not shipped.', size: 'M' } },
  { id: 'W1.2', text: 'Build the shipping queue.', work: { size: 'S' } },
  { id: 'W1.10', text: 'Build the tracking page.', work: { done_when: 'A customer sees where the order is.' } },
  { id: 'W2.1', text: 'Cancel from the tracking page.', work: { depends_on: ['W1.1'], size: 'L' } },
  { id: 'M1', text: 'Orders can be run end to end.', work: { milestone: true, depends_on: ['W1.1', 'W1.2', 'W1.10', 'W2.1'], target_date: '2026-12-01', done_when: 'Every member is Done.' } },
];

/** Drafts `elements` of the plan, with `links`, and submits it: the outcome. */
async function submitPlan(ctx: Awaited<ReturnType<typeof planned>>, elements: ElementInput[], links: ReturnType<Awaited<ReturnType<typeof planned>>['delivers']>[] = []) {
  const id = await ctx.kolab.draft(ctx.engineer, 'orders-plan', { elements, links });
  return { id, ...(await ctx.kolab.submit(ctx.engineer, id)) };
}

test('a plan\'s work packages carry their fields: stored in one form, read back, and a valid plan commits on its checks alone (PLN1, PLN2, PLN3)', async () => {
  const ctx = await planned();
  const { kolab, delivers } = ctx;
  // Fields given in any order, and a done-when to trim, are stored in one form.
  const given: ElementInput[] = PLAN.map((e) => (e.id === 'W1.10' ? { ...e, work: { done_when: '  A customer sees where the order is. ' } }
    : e.id === 'M1' ? { ...e, work: { target_date: '2026-12-01', milestone: true, done_when: 'Every member is Done.', depends_on: ['W1.1', 'W1.2', 'W1.10', 'W2.1'] } } : e));
  const r = await submitPlan(ctx, given, [delivers('W1.1', 'b1'), delivers('W1.2', 'b2'), delivers('W1.10', 'b3'), delivers('W2.1', 'b1')]);
  expect(r).toMatchObject({ ok: true, version: r.id });
  expect(r.note).toMatch(/A plan version commits after structural checks, without review \(PLN2\)/);
  const stored = await kolab.elements(r.id);
  expect(stored.map((e) => [e.element_id, e.work])).toStrictEqual([
    ['W1.1', { done_when: 'POST /orders/:id/cancel cancels an order that has not shipped.', size: 'M' }],
    ['W1.2', { size: 'S' }],
    ['W1.10', { done_when: 'A customer sees where the order is.' }],
    ['W2.1', { depends_on: ['W1.1'], size: 'L' }],
    ['M1', { done_when: 'Every member is Done.', depends_on: ['W1.1', 'W1.2', 'W1.10', 'W2.1'], milestone: true, target_date: '2026-12-01' }],
  ]);
  // The fingerprint covers the fields where there are any.
  for (const e of stored) expect(e.fingerprint).toBe(elementFingerprint(e.text, e.work));
  expect(stored[0].fingerprint).not.toBe(fingerprint(stored[0].text));
  // read_node shows them as stored.
  const read = await kolab.readNode(ctx.engineer, 'orders-plan');
  expect(read.elements.find((e) => e.element_id === 'M1')?.work).toMatchObject({ milestone: true, target_date: '2026-12-01' });
});

test('an element with no work fields keeps the fingerprint it always had, on a plan and everywhere else, so links to it stay put (D98)', async () => {
  const ctx = await planned();
  const { kolab, s1, b1 } = ctx;
  for (const v of [s1, b1]) for (const e of await kolab.elements(v)) {
    expect(e).not.toHaveProperty('work');
    expect(e.fingerprint).toBe(fingerprint(e.text));
  }
  const r = await submitPlan(ctx, els({ W1: 'Build the cancel endpoint.' }));
  expect(r.ok).toBe(true);
  const [w1] = await kolab.elements(r.id);
  expect(w1).toStrictEqual({ element_id: 'W1', parent_element_id: null, ord: 0, text: 'Build the cancel endpoint.', fingerprint: fingerprint('Build the cancel endpoint.') });
});

test('deltas and full element lists alike keep an element\'s work fields unless they give new ones, and null clears them; changing a field is a change (D98, review M1)', async () => {
  const ctx = await planned();
  const { kolab, engineer } = ctx;
  const v1 = (await submitPlan(ctx, PLAN)).id;
  const work = async (v: string) => Object.fromEntries((await kolab.elements(v)).map((e) => [e.element_id, e.work]));
  const fp = async (v: string, id: string) => (await kolab.elements(v)).find((e) => e.element_id === id)!.fingerprint;
  // An override of the text alone keeps the fields; one that gives them replaces them whole; null clears them.
  const v2 = await kolab.commit(engineer, 'orders-plan', { deltas: [
    { kind: 'override', element: 'W1.1', text: 'Build the cancel endpoint, idempotently.' },
    { kind: 'override', element: 'W1.2', work: { size: 'L', done_when: 'Orders leave the queue within a day.' } },
    { kind: 'override', element: 'W1.10', work: null },
    { kind: 'add', element: 'W2.2', text: 'Track a cancelled order.', work: { depends_on: ['W2.1'] } },
  ] });
  expect(await work(v2)).toStrictEqual({
    'W1.1': PLAN[0].work, 'W1.2': { done_when: 'Orders leave the queue within a day.', size: 'L' }, 'W1.10': undefined,
    'W2.1': PLAN[3].work, 'M1': PLAN[4].work, 'W2.2': { depends_on: ['W2.1'] },
  });
  // A change of the fields alone is a change: the delta says so, and the fingerprint moved.
  const deltas = (await kolab.db.query<{ element_id: string; kind: string }>(`select element_id, kind from delta where version_id = $1 order by element_id`, [v2])).rows;
  expect(deltas).toStrictEqual([{ element_id: 'W1.1', kind: 'override' }, { element_id: 'W1.10', kind: 'override' }, { element_id: 'W1.2', kind: 'override' }, { element_id: 'W2.2', kind: 'add' }]);
  expect(await fp(v2, 'W1.2')).not.toBe(await fp(v1, 'W1.2'));
  expect(await fp(v2, 'W1.10')).toBe(fingerprint('Build the tracking page.'));
  expect(await fp(v2, 'W2.1')).toBe(await fp(v1, 'W2.1'));
  // The same fields in another order, or a done-when spaced differently, are no change.
  const same = await kolab.draft(engineer, 'orders-plan', { elements: (await kolab.elements(v2)).map((e) => ({
    id: e.element_id, text: e.text,
    work: e.work && { ...Object.fromEntries(Object.entries(e.work).reverse()), ...(e.work.done_when ? { done_when: ` ${e.work.done_when.replace(/ /g, '  ')} ` } : {}) },
  })) });
  expect((await kolab.db.query(`select 1 from delta where version_id = $1`, [same])).rows).toStrictEqual([]);
  await kolab.abandon(engineer, same);
  // A full element list built from the text alone keeps every element's fields: nothing is wiped.
  const v3 = await kolab.commit(engineer, 'orders-plan', { elements: (await kolab.elements(v2)).map((e) => ({ id: e.element_id, text: e.text })) });
  expect(await work(v3)).toStrictEqual(await work(v2));
  expect((await kolab.db.query(`select 1 from delta where version_id = $1`, [v3])).rows).toStrictEqual([]);
  // null clears an element's fields; fields given replace them whole.
  const v4 = await kolab.commit(engineer, 'orders-plan', { elements: (await kolab.elements(v3)).map((e) => ({
    id: e.element_id, text: e.text, ...(e.element_id === 'W1.1' ? { work: null } : e.element_id === 'W1.2' ? { work: { size: 'M' as const } } : {}),
  })) });
  expect((await work(v4))['W1.1']).toBeUndefined();
  expect((await work(v4))['W1.2']).toStrictEqual({ size: 'M' });
  expect((await work(v4))['W2.1']).toStrictEqual(PLAN[3].work);
  // A ruling applied to a plan (the D37 mirror's path) keeps them the same way.
  await kolab.applyRuling('orders-plan', { elements: (await kolab.elements(v4)).map((e) => ({ id: e.element_id, text: e.text })) }, { id: 'D98', actor: 'bob', by: ADMIN_DOER });
  expect(await work((await kolab.latestCommitted('orders-plan'))!.id)).toStrictEqual(await work(v4));
});

test('a plan version that breaks PLN2 goes back to its author, still drafted, naming PLN2 and each problem', async () => {
  const ctx = await planned();
  const { kolab, delivers } = ctx;
  const refused = async (elements: ElementInput[], problem: string, links: ReturnType<typeof delivers>[] = []) => {
    const r = await submitPlan(ctx, elements, links);
    expect(r.ok).toBe(false);
    expect(r.note).toContain('Plan checks failed (PLN2): ');
    expect(r.note).toContain(problem);
    const v = await kolab.version(r.id);
    expect(v.state).toBe('drafted');
    await kolab.abandon(ctx.engineer, r.id);
  };
  const w = (id: string, work: ElementInput['work']): ElementInput => ({ id, text: `Work package ${id}.`, work });
  // Every Depends on names a work package of the same version, and not itself.
  await refused([w('W1', { depends_on: ['W9'] })], "W1 depends on W9, which isn't a work package of this version");
  await refused([w('W1', { depends_on: ['W1'] })], 'W1 depends on itself');
  // No cycle in Depends on.
  await refused([w('W1', { depends_on: ['W3'] }), w('W2', { depends_on: ['W1'] }), w('W3', { depends_on: ['W2'] })], 'Depends on has a cycle: W1 → W3 → W2 → W1');
  // A milestone depends on its members, and delivers nothing.
  await refused([w('M1', { milestone: true })], 'M1 is a milestone, and depends on no members');
  // A milestone's Delivers is refused as the draft declares it, against the draft's own elements (review L3).
  expect(await rejection(kolab.draft(ctx.engineer, 'orders-plan', { elements: [w('W1', null), w('M1', { milestone: true, depends_on: ['W1'] })], links: [delivers('M1', 'b1')] })))
    .toBe('GateError: M1 is a milestone, and a milestone delivers nothing (PLN2, PLN3): link the work package that delivers orders-pg@1#b1, and make the milestone depend on it');
  // All of them at once, each named.
  const r = await submitPlan(ctx, [w('W1', { depends_on: ['W2', 'W7'] }), w('W2', { depends_on: ['W1'] }), w('M1', { milestone: true })]);
  expect(r.note).toBe("Plan checks failed (PLN2): W1 depends on W7, which isn't a work package of this version; M1 is a milestone, and depends on no members: a milestone depends on the work packages it gathers (PLN3); Depends on has a cycle: W1 → W2 → W1.");
  // Fixed, the same draft's next version commits.
  await kolab.abandon(ctx.engineer, r.id);
  expect((await submitPlan(ctx, [w('W1', null), w('W2', { depends_on: ['W1'] }), w('M1', { milestone: true, depends_on: ['W1', 'W2'] })])).ok).toBe(true);
});

test('only a milestone carries a target date: a dated work package is refused as it is drafted, naming PLN2, as is a malformed field', async () => {
  const ctx = await planned();
  const { kolab, engineer } = ctx;
  const draft = (work: unknown) => rejection(kolab.draft(engineer, 'orders-plan', { elements: [{ id: 'W1', text: 'Build it.', work } as ElementInput] }));
  expect(await draft({ target_date: '2026-12-01' })).toBe('GateError: W1 carries a target date, and only a milestone carries one (PLN2): make it a milestone (milestone: true), or leave the date out.');
  expect(await draft({ milestone: true, depends_on: ['W0'], target_date: '2026-02-30' })).toMatch(/W1's target_date is a date, YYYY-MM-DD, not "2026-02-30"/);
  expect(await draft({ size: 'XL' })).toBe('GateError: W1\'s size is one of S, M, L, not "XL".');
  expect(await draft({ estimate: '3 days' })).toMatch(/W1's work has estimate, which is no field of a work package: they are done_when, depends_on, size, milestone, target_date, repo/);
  expect(await draft({ depends_on: ['W0', 'W0'] })).toMatch(/W1's depends_on names W0 more than once/);
  expect(await draft({ depends_on: 'W0' })).toMatch(/W1's depends_on lists work packages by their element ids/);
  expect(await draft(['W0'])).toMatch(/W1's work is an object of/);
  // Nothing given is dropped quietly: an empty field is refused, saying to leave it out (review nits).
  expect(await draft({ done_when: '   ' })).toBe("GateError: W1's done_when is empty: say when it is done, or leave done_when out.");
  expect(await draft({ depends_on: [] })).toBe("GateError: W1's depends_on is empty: name the work packages it depends on, or leave depends_on out.");
  expect(await draft({ milestone: false, size: 'S' })).toBe("GateError: W1's milestone is false: a milestone says milestone: true, and a work package that isn't one leaves milestone out.");
  expect(await draft({})).toBe("GateError: W1's work is empty: give its fields, or null to clear them.");
  // A work field beside the text, not inside work, is refused, not dropped (review M1).
  expect(await rejection(kolab.draft(engineer, 'orders-plan', { elements: [{ id: 'W1', text: 'Build it.', done_when: 'Built.' } as ElementInput] })))
    .toBe('GateError: W1 has done_when beside its text: work fields go inside work, as {"work":{"done_when":…}}.');
  expect(await rejection(kolab.draft(engineer, 'orders-plan', { deltas: [{ kind: 'add', element: 'W1', text: 'Build it.', size: 'S' } as never] })))
    .toMatch(/W1 has size beside its text: work fields go inside work/);
  // Over a limit, it says which.
  expect(await draft({ done_when: 'x'.repeat(MAX_DONE_WHEN + 1) })).toBe(`LimitError: W1's done_when is ${(MAX_DONE_WHEN + 1).toLocaleString('en')} characters; the limit is ${MAX_DONE_WHEN.toLocaleString('en')}.`);
  expect(await draft({ depends_on: Array.from({ length: MAX_DEPENDS_ON + 1 }, (_, i) => `W${i + 2}`) })).toMatch(new RegExp(`^LimitError: W1 depends on ${MAX_DEPENDS_ON + 1} work packages; the limit is ${MAX_DEPENDS_ON}`));
  // Nothing was written.
  expect((await kolab.db.query(`select 1 from version v join node n on n.id = v.node_id where n.name = 'orders-plan'`)).rows).toStrictEqual([]);
});

test('work fields are only on a plan\'s elements: Kolab refuses them elsewhere, and so does the database, for every role (PLN1, D98)', async () => {
  const ctx = await planned();
  const { kolab, product, engineer, b1 } = ctx;
  expect(await rejection(kolab.draft(engineer, 'orders-pg', { elements: [{ id: 'b1', text: 'A cancel endpoint.', work: { size: 'S' } }] })))
    .toBe("GateError: work fields (done_when, depends_on, size, milestone, target_date, repo) are only on a plan's elements, its work packages (PLN1, D98), and orders-pg is a binding");
  expect(await rejection(kolab.draft(product, 'orders', { deltas: [{ kind: 'override', element: 'R1', work: { done_when: 'Shipped.' } }] })))
    .toMatch(/are only on a plan's elements, its work packages \(PLN1, D98\), and orders is a spec/);
  // Null or none is no work: a binding may say so.
  await kolab.abandon(engineer, await kolab.draft(engineer, 'orders-pg', { elements: [{ id: 'b1', text: 'A cancel endpoint.', work: null }] }));
  // Kolab's own login: refused by the trigger.
  expect(await rejection(kolab.db.query(`update element set work = '{"size":"S"}' where version_id = $1 and element_id = 'b1'`, [b1])))
    .toMatch(/element: work fields .* are only on a plan's elements, its work packages \(PLN1, D98\); orders-pg is a binding/);
  // An agent's own session, past row-level security: refused too.
  const draft = await kolab.draft(engineer, 'orders-pg', { elements: els({ b1: 'A cancel endpoint.' }) });
  const asAgent = (sql: string, params: unknown[]) => kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(engineer)]);
    await tx.query(sql, params);
  });
  expect(await rejection(asAgent(`insert into element(version_id, element_id, ord, text, fingerprint, work) values ($1, 'b9', 9, 'More.', 'x', '{"size":"S"}')`, [draft])))
    .toMatch(/only on a plan's elements/);
  expect(await rejection(asAgent(`insert into delta(id, version_id, element_id, kind, text, work) values ('d9', $1, 'b9', 'add', 'More.', '{"size":"S"}')`, [draft])))
    .toMatch(/delta: work fields .* only on a plan's elements/);
});

test('the database stores work fields only in the shape Kolab writes, and its sizes are WORK_SIZES (migration 0029)', async () => {
  const { kolab, engineer } = await planned();
  const valid = async (w: unknown) => (await kolab.db.query<{ ok: boolean }>(`select kj_work_valid($1::jsonb) as ok`, [w === null ? null : JSON.stringify(w)])).rows[0].ok;
  for (const size of WORK_SIZES) expect(await valid({ size })).toBe(true);
  expect(await valid(null)).toBe(true);
  expect(await valid({ done_when: 'Done.', depends_on: ['W1'], size: 'M', milestone: true, target_date: '2026-12-01', repo: 'r1' })).toBe(true);
  for (const w of [
    {}, [], 'W1', { size: 'XL' }, { size: 1 }, { estimate: 3 }, { milestone: false }, { milestone: 'yes' },
    { target_date: '2026-12-01' }, { milestone: true, target_date: '2026-02-30' }, { milestone: true, target_date: '1 Dec 2026' },
    { depends_on: [] }, { depends_on: ['W1', 'W1'] }, { depends_on: [''] }, { depends_on: [1] }, { depends_on: Array.from({ length: MAX_DEPENDS_ON + 1 }, (_, i) => `W${i}`) },
    { done_when: '' }, { done_when: 'x'.repeat(MAX_DONE_WHEN + 1) }, { repo: '' },
  ]) expect([w, await valid(w)]).toStrictEqual([w, false]);
  // And the check holds both columns to it, on a plan too, for Kolab's own login.
  const v = await kolab.draft(engineer, 'orders-plan', { elements: els({ W1: 'Build it.' }) });
  expect(await rejection(kolab.db.query(`update element set work = '{"size":"XL"}' where version_id = $1`, [v]))).toMatch(/element_work_valid/);
  expect(await rejection(kolab.db.query(`insert into delta(id, version_id, element_id, kind, text, work) values ('d1', $1, 'W2', 'add', 'More.', '{}')`, [v]))).toMatch(/delta_work_valid/);
  await kolab.db.query(`update element set work = '{"size":"L"}' where version_id = $1`, [v]);
});

test('a Delivers is a dependency link from a work package to one binding element, never from a milestone: refused as it is declared (PLN1, PLN2, LNK3)', async () => {
  const ctx = await planned();
  const { kolab, engineer, b1 } = ctx;
  const v1 = (await submitPlan(ctx, [{ id: 'W1', text: 'Build it.' }, { id: 'M1', text: 'Ship it.', work: { milestone: true, depends_on: ['W1'] } }])).id;
  const link = (e: Partial<Parameters<typeof kolab.link>[1]>) => rejection(kolab.link(engineer, { kind: 'dependency', source: v1, sourceElement: 'W1', target: b1, targetElement: 'b1', ...e }));
  expect(await link({ kind: 'derivation' })).toBe('GateError: a work package delivers a binding element through a dependency link (PLN1), not a derivation link: link orders-pg@1#<element> with kind dependency');
  expect(await link({ kind: 'equivalence' })).toMatch(/not a equivalence link|not an equivalence link/);
  expect(await link({ targetElement: undefined })).toMatch(/a work package delivers whole binding elements, at element scope \(PLN1, LNK3\), not the whole binding/);
  expect(await link({ selector: { exact: 'cancel endpoint' } })).toMatch(/at element scope \(PLN1, LNK3\), not a quote inside one/);
  expect(await link({ sourceElement: undefined })).toMatch(/a Delivers is from a work package, one element of the plan, not the whole version \(PLN1\)/);
  expect(await link({ sourceElement: 'M1' })).toBe('GateError: M1 is a milestone, and a milestone delivers nothing (PLN2, PLN3): link the work package that delivers orders-pg@1#b1, and make the milestone depend on it');
  // The one that passes.
  await kolab.link(engineer, { kind: 'dependency', source: v1, sourceElement: 'W1', target: b1, targetElement: 'b1' });
});

test('links a plan version carries forward are checked when it is submitted: one written before PLN2 that breaks it stops the next version until it is removed', async () => {
  const ctx = await planned();
  const { kolab, engineer, b1 } = ctx;
  const v1 = (await submitPlan(ctx, els({ W1: 'Build it.', W2: 'Ship it.' }))).id;
  // A link from before these checks: a derivation, and one to the whole binding, written directly.
  const fp = async (el: string | null) => (await kolab.resolveIn(b1, el, null) as { fingerprint: string }).fingerprint;
  await kolab.db.query(`insert into edge(id, kind, source_version_id, source_element_id, target_version_id, target_element_id, target_fingerprint, held_by)
                        values ('old1', 'derivation', $1, 'W1', $2, 'b1', $3, 'bob'), ('old2', 'dependency', $1, 'W2', $2, null, $4, 'bob')`, [v1, b1, await fp('b1'), await fp(null)]);
  const r = await submitPlan(ctx, els({ W1: 'Build it well.', W2: 'Ship it.' }));
  expect(r.ok).toBe(false);
  expect(r.note).toBe('Plan checks failed (PLN2): W1 delivers orders-pg@1#b1 through a derivation link, and a Delivers is a dependency link (PLN1); W2 delivers orders-pg@1, and a Delivers names one binding element, at element scope, not the whole binding (PLN1, LNK3).');
  await kolab.abandon(engineer, r.id);
  // Removing W2 drops its link; unlinking W1's drops the other: then it commits.
  const ok = await kolab.draft(engineer, 'orders-plan', { elements: els({ W1: 'Build it well.' }), unlink: [{ link: 'old1' }] });
  expect(await kolab.submit(engineer, ok)).toMatchObject({ ok: true });
  expect(await marksOn(kolab, 'orders-plan')).toStrictEqual([]);
});

test('the plan checks are Kolab\'s own: a substituted check doesn\'t stand in for them', async () => {
  const ctx = await setup(() => ({ ok: true, note: 'anything goes' }), () => ({ ok: true, note: 'anything goes' }));
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  await kolab.createNode(engineer, 'binding', 'Orders on Postgres', 'orders-pg');
  await kolab.commit(engineer, 'orders-pg', { elements: els({ b1: 'A cancel endpoint.' }) });
  await kolab.createNode(engineer, 'plan', 'Plan', 'orders-plan');
  const id = await kolab.draft(engineer, 'orders-plan', { elements: [{ id: 'W1', text: 'Build it.', work: { depends_on: ['W1'] } }] });
  expect(await kolab.submit(engineer, id)).toMatchObject({ ok: false, note: 'Plan checks failed (PLN2): W1 depends on itself.' });
});

test('an element-scope link into a work package sees a change to its work fields, and none moves for an element without them (D98, review M2)', async () => {
  const ctx = await planned();
  const { kolab, engineer } = ctx;
  const v1 = (await submitPlan(ctx, [{ id: 'W1', text: 'Build it.', work: { done_when: 'It is built.' } }, { id: 'W2', text: 'Ship it.' }, { id: 'W3', text: 'Tell people.' }])).id;
  // W2 relies on W1, and W3 on W2 (which has no work fields): links within the plan (D78).
  await kolab.link(engineer, { kind: 'dependency', source: v1, sourceElement: 'W2', target: v1, targetElement: 'W1' });
  await kolab.link(engineer, { kind: 'dependency', source: v1, sourceElement: 'W3', target: v1, targetElement: 'W2' });
  // A link to an element with no work fields is pinned to its text alone, as it always was.
  const pinned = (await kolab.db.query<{ target_fingerprint: string; target_element_id: string }>(
    `select target_fingerprint, target_element_id from edge where source_version_id = $1 order by target_element_id`, [v1])).rows;
  expect(pinned[1]).toStrictEqual({ target_element_id: 'W2', target_fingerprint: fingerprint('Ship it.') });
  // Only W1's done-when changes: W2's link to it is marked changed, and W3 only through W2 (its own link to W2 holds).
  await kolab.commit(engineer, 'orders-plan', { deltas: [{ kind: 'override', element: 'W1', work: { done_when: 'It is built and tested.' } }] });
  expect((await marksOn(kolab, 'orders-plan')).map((m) => [m.element_id, m.reason])).toStrictEqual([['W2', 'changed'], ['W3', 'upstream_dirty']]);
});

test('a Delivers from an element that has become a milestone is refused, whichever comes first: the link or the commit (review L4)', async () => {
  const ctx = await planned();
  const { kolab, engineer, b1 } = ctx;
  const v1 = (await submitPlan(ctx, [{ id: 'W1', text: 'Build it.' }, { id: 'W2', text: 'Ship it.' }])).id;
  // The link first, on the committed version a draft that makes W1 a milestone is built on: the draft carries it, and is refused.
  const draft = await kolab.draft(engineer, 'orders-plan', { elements: [{ id: 'W1', text: 'Build it.', work: { milestone: true, depends_on: ['W2'] } }, { id: 'W2', text: 'Ship it.' }] });
  const link = await kolab.link(engineer, { kind: 'dependency', source: v1, sourceElement: 'W1', target: b1, targetElement: 'b1' });
  expect(await kolab.submit(engineer, draft)).toMatchObject({ ok: false, note: expect.stringContaining('W1 is a milestone, and delivers orders-pg@1#b1') });
  await kolab.abandon(engineer, draft);
  await kolab.db.query(`delete from edge where id = $1`, [link]);
  // The commit first: a link added afterwards to the version it superseded is refused, under the node's lock.
  await kolab.commit(engineer, 'orders-plan', { elements: [{ id: 'W1', text: 'Build it.', work: { milestone: true, depends_on: ['W2'] } }, { id: 'W2', text: 'Ship it.' }] });
  expect(await rejection(kolab.link(engineer, { kind: 'dependency', source: v1, sourceElement: 'W1', target: b1, targetElement: 'b1' })))
    .toBe('GateError: W1 is a milestone, and a milestone delivers nothing (PLN2, PLN3): link the work package that delivers orders-pg@1#b1, and make the milestone depend on it');
});

test('konjir_link from a draft is checked against the draft\'s own elements: a milestone it turned into a work package may deliver (verification Low 1)', async () => {
  const ctx = await planned();
  const { kolab, engineer, b1 } = ctx;
  await submitPlan(ctx, [{ id: 'W1', text: 'Build it.' }, { id: 'M1', text: 'Ship it.', work: { milestone: true, depends_on: ['W1'] } }]);
  // Draft @2 makes M1 a work package: a Delivers from it, declared with konjir_link on the draft, stands.
  const draft = await kolab.draft(engineer, 'orders-plan', { elements: [{ id: 'W1', text: 'Build it.' }, { id: 'M1', text: 'Ship it.', work: null }] });
  await kolab.link(engineer, { kind: 'dependency', source: draft, sourceElement: 'M1', target: b1, targetElement: 'b2' });
  expect(await kolab.submit(engineer, draft)).toMatchObject({ ok: true });
  // And a draft that keeps M1 a milestone is still refused it, against its own elements.
  const kept = await kolab.draft(engineer, 'orders-plan', { elements: [{ id: 'W1', text: 'Build it.' }, { id: 'M1', text: 'Ship it.', work: { milestone: true, depends_on: ['W1'] } }] });
  expect(await rejection(kolab.link(engineer, { kind: 'dependency', source: kept, sourceElement: 'M1', target: b1, targetElement: 'b1' })))
    .toMatch(/^GateError: M1 is a milestone, and a milestone delivers nothing \(PLN2, PLN3\)/);
});

test('a ruling that fails PLN2 in its commit step, after a link slipped in, is rejected, not left drafted (verification Low 2, D47)', async () => {
  const ctx = await planned();
  const { kolab, b1 } = ctx;
  const v1 = (await submitPlan(ctx, [{ id: 'W1', text: 'Build it.' }, { id: 'W2', text: 'Ship it.' }])).id;
  const fp = ((await kolab.resolveIn(b1, 'b1', null)) as { fingerprint: string }).fingerprint;
  // Between the ruling's PLN2 checks in judge and its commit step, a Delivers from W1 lands on the version it is built on.
  const k = kolab as unknown as { planChecks: (...a: unknown[]) => Promise<unknown> };
  const original = k.planChecks.bind(kolab);
  let calls = 0;
  k.planChecks = async (...a: unknown[]) => {
    const r = await original(...a);
    if (++calls === 1) {
      await kolab.db.query(`insert into edge(id, kind, source_version_id, source_element_id, target_version_id, target_element_id, target_fingerprint, held_by)
                            values ('late', 'dependency', $1, 'W1', $2, 'b1', $3, 'bob')`, [v1, b1, fp]);
    }
    return r;
  };
  const r = await kolab.applyRuling('orders-plan', { elements: [{ id: 'W1', text: 'Build it.', work: { milestone: true, depends_on: ['W2'] } }, { id: 'W2', text: 'Ship it.' }] },
    { id: 'D98', actor: 'bob', by: ADMIN_DOER });
  expect(calls).toBe(2);
  expect(r).toMatchObject({ ok: false, note: expect.stringContaining('W1 is a milestone, and delivers orders-pg@1#b1') });
  expect((await kolab.version(r.version)).state).toBe('rejected');
  expect((await kolab.latestCommitted('orders-plan'))!.id).toBe(v1);
});
