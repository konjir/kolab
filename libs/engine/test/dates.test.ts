// Dates and forecasts (W8.8; WRK9): a work package's start and finish are a read, never a row. Actual
// dates come from its current run's events; a forecast is the median finished duration of its size in
// its binding, else the kolab, following the dependency order; with no size, or none of its size
// finished, it has no forecast, and nor has what waits on it. Every forecast is labelled, with its basis.
import { expect, test } from '@jest/globals';
import pg from 'pg';
import { median, workDates, type Kolab } from '@konjir/engine';
import { commitReviewed, els, openKolab, people, registeredRepository } from '@konjir/engine/testing';
import type { ElementInput } from '@konjir/types';

const DAY = 86_400_000;
const at = (d: Date) => ({ at: d.toISOString(), kind: 'actual' });

/** Every table's rows, as one digest each: what a read must leave as it found it. */
async function tables(kolab: Kolab) {
  const names = (await kolab.db.query<{ t: string }>(`select tablename as t from pg_tables where schemaname = 'public' order by tablename`)).rows.map((r) => r.t);
  const out: Record<string, string | null> = {};
  for (const t of names) out[t] = (await kolab.db.query<{ d: string | null }>(`select md5(string_agg(x::text, '|' order by x::text)) as d from ${pg.escapeIdentifier(t)} x`)).rows[0].d;
  return out;
}

test('a median is the middle duration, or the mean of the middle two (WRK9)', () => {
  expect([median([3]), median([4, 1, 3]), median([2, 4]), median([5, 1, 2, 9])]).toStrictEqual([3, 3, 3, 3.5]);
});

test('with no finished duration in its binding, a package\'s forecast is the kolab\'s; one waiting on a package with none has none; a cycle stops (WRK9)', () => {
  const now = new Date(Date.UTC(2026, 10, 12));
  const pkg = (id: string, o: Partial<Parameters<typeof workDates>[0][number]> = {}) => ({ id, address: `kj:b#${id}`, state: 'todo' as const, milestone: false, size: 'M' as const, depends_on: [], ...o });
  const d = workDates([pkg('A'), pkg('B', { size: 'L', depends_on: ['A'] }), pkg('C', { depends_on: ['D'] }), pkg('D', { depends_on: ['C'] })],
    { binding: new Map(), kolab: new Map([['M', [DAY, 3 * DAY]]]) }, now);
  expect(d.get('A')).toStrictEqual({
    start: { at: now.toISOString(), kind: 'forecast', basis: { size: 'M', durations: 2, from: 'kolab' } },
    finish: { at: new Date(now.getTime() + 2 * DAY).toISOString(), kind: 'forecast', basis: { size: 'M', durations: 2, from: 'kolab' } },
  });
  expect(d.get('B')!.start).toStrictEqual({ at: null, kind: 'no_forecast', reason: 'no L package in the kolab has a finished duration' });
  // A cycle stops: each date of each says what it waits on.
  const c = { at: null, kind: 'no_forecast', reason: 'it waits on kj:b#D, which has no forecast' };
  const dd = { at: null, kind: 'no_forecast', reason: 'it waits on kj:b#C, which has no forecast' };
  expect(d.get('C')).toStrictEqual({ start: c, finish: c });
  expect(d.get('D')).toStrictEqual({ start: dd, finish: dd });
});

test('a Done dependency has finished by now, whatever its run records; a milestone with a member that has no forecast has none either (WRK9)', () => {
  const now = new Date(Date.UTC(2026, 10, 12));
  const pkg = (id: string, o: Partial<Parameters<typeof workDates>[0][number]> = {}) => ({ id, address: `kj:b#${id}`, state: 'todo' as const, milestone: false, size: 'S' as const, depends_on: [], ...o });
  const S = { size: 'S', durations: 1, from: 'binding' };
  const d = workDates([
    // Restored Done: no pull, no approval in its run.
    pkg('A', { state: 'done' }), pkg('B', { depends_on: ['A'] }),
    pkg('U', { size: null }), pkg('M', { milestone: true, size: null, depends_on: ['B', 'U'] }),
  ], { binding: new Map([['S', [DAY]]]), kolab: new Map([['S', [DAY]]]) }, now);
  expect(d.get('A')).toStrictEqual({
    start: { at: null, kind: 'no_forecast', reason: 'kj:b#A was Done with no pull in its run' },
    finish: { at: null, kind: 'no_forecast', reason: 'kj:b#A is Done with no event that made it Done in its run' },
  });
  expect(d.get('B')).toStrictEqual({ start: { at: now.toISOString(), kind: 'forecast', basis: S }, finish: { at: new Date(now.getTime() + DAY).toISOString(), kind: 'forecast', basis: S } });
  const waits = { at: null, kind: 'no_forecast', reason: 'it waits on kj:b#U, which has no forecast' };
  expect(d.get('M')).toStrictEqual({ start: waits, finish: waits });
});

test('a milestone passes over a Done member whose run records no dates, and takes its other members\' (WRK9)', () => {
  const now = new Date(Date.UTC(2026, 10, 12));
  const pkg = (id: string, o: Partial<Parameters<typeof workDates>[0][number]> = {}) => ({ id, address: `kj:b#${id}`, state: 'todo' as const, milestone: false, size: 'S' as const, depends_on: [], ...o });
  const S = { size: 'S', durations: 1, from: 'binding' };
  const d = workDates([
    pkg('A', { state: 'done' }), pkg('B'), pkg('M', { milestone: true, size: null, depends_on: ['A', 'B'] }),
    pkg('C', { state: 'done' }), pkg('N', { milestone: true, size: null, depends_on: ['C'] }),
  ], { binding: new Map([['S', [DAY]]]), kolab: new Map([['S', [DAY]]]) }, now);
  expect(d.get('M')).toStrictEqual({
    start: { at: now.toISOString(), kind: 'forecast', basis: { ...S, via: 'kj:b#B' } },
    finish: { at: new Date(now.getTime() + DAY).toISOString(), kind: 'forecast', basis: { ...S, via: 'kj:b#B' } },
  });
  // Every member Done with nothing recorded: nothing to go on, and it says so.
  expect(d.get('N')!.start).toStrictEqual({ at: null, kind: 'no_forecast', reason: "kj:b#N's members are Done with no start in their runs" });
});

/**
 * A spec of one requirement; binding orders-pg with a decision and its packages; binding orders-my
 * with one L package. Bob builds, eve reviews, alice (product) reads.
 */
async function planned() {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const product = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'engineer');
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  const spec = (await kolab.latestCommitted('orders'))!.id;
  const binding = async (name: string, work: ElementInput[]) => {
    await kolab.createNode(bob, 'binding', name, name);
    const d = els({ d1: 'A cancel endpoint.' });
    const v = await kolab.draft(bob, name, { elements: d, links: [{ kind: 'dependency', sourceElement: 'd1', target: spec, targetElement: 'R1' }] });
    expect((await kolab.submit(bob, v)).ok).toBe(true);
    const w = await kolab.draft(bob, name, { elements: [...d, ...work],
      links: work.filter((x) => !x.work?.milestone).map((x) => ({ kind: 'dependency' as const, sourceElement: x.id!, target: v, targetElement: 'd1' })) });
    expect((await kolab.submit(bob, w)).ok).toBe(true);
  };
  await binding('orders-pg', [
    { id: 'W1', text: 'Cancel.', work: { size: 'S' } },
    { id: 'W2', text: 'Refund.', work: { size: 'S' } },
    { id: 'W3', text: 'Notify.', work: { size: 'S' } },
    { id: 'W4', text: 'Undo a cancel.', work: { size: 'S', depends_on: ['W3'] } },
    { id: 'W5', text: 'Unsized.', work: {} },
    { id: 'W6', text: 'Waits on the unsized one.', work: { size: 'S', depends_on: ['W5'] } },
    { id: 'W7', text: 'Large.', work: { size: 'L' } },
    { id: 'W8', text: 'Medium.', work: { size: 'M' } },
    { id: 'M1', text: 'Cancel and refund.', work: { milestone: true, depends_on: ['W1', 'W2'] } },
    { id: 'M2', text: 'Notify and undo.', work: { milestone: true, depends_on: ['W3', 'W4'] } },
  ]);
  await binding('orders-my', [{ id: 'X1', text: 'Cancel on MySQL.', work: { size: 'L' } }]);
  await registeredRepository(kolab, { binding: 'orders-pg' });
  await registeredRepository(kolab, { binding: 'orders-my', url: 'https://github.com/acme/orders-my', root: 'e'.repeat(40) });
  await people(kolab, 'eve', { layers: ['technical'] });
  const eve = await kolab.openSession('eve', 'engineer');
  return { kolab, product, bob, eve };
}

test('a To do S package after an In progress one: the Done packages\' actual dates, the In progress one\'s actual start and forecast finish from the median, the To do one\'s forecast start at that finish, each labelled with its basis; an unsized package and what waits on it with no forecast; and the read writes nothing (WRK9)', async () => {
  const { kolab, product, bob, eve } = await planned();
  /** Pulls `id` as bob, submits it with a commit, and has eve approve it. */
  const finish = async (binding: string, id: string, c: string) => {
    expect(await kolab.pullWork(bob, { binding })).toMatchObject({ pulled: true, item: { id } });
    await kolab.submitWork(bob, `kj:${binding}#${id}`, { evidence: [{ kind: 'commit', sha: c.repeat(40), title: id, files: ['src/x.ts'] }] });
    await kolab.reviewWork(eve, `kj:${binding}#${id}`, { verdict: 'approve', note: 'Checked.' });
  };
  await finish('orders-my', 'X1', 'a');
  await finish('orders-pg', 'W1', 'b');
  await finish('orders-pg', 'W2', 'c');
  expect(await kolab.pullWork(bob, { binding: 'orders-pg' })).toMatchObject({ pulled: true, item: { id: 'W3' } });

  // Known times: W1 took two days, W2 four, so an S package's median is three; X1, an L, took five.
  const now = new Date((await kolab.db.query<{ now: Date | string }>(`select clock_timestamp() as now`)).rows[0].now);
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const times: [string, string, Date][] = [
    ['X1', 'pulled', ago(20)], ['X1', 'approved', ago(15)],
    ['W1', 'pulled', ago(10)], ['W1', 'approved', ago(8)],
    ['W2', 'pulled', ago(7)], ['W2', 'approved', ago(3)], ['M1', 'milestone_done', ago(3)],
    ['W3', 'pulled', ago(1 / 24)],
  ];
  // Events are never edited (PLN5), but a test can set when they happened: the packages were added first.
  await kolab.db.query(`alter table work_event disable trigger work_event_fixed`);
  try {
    await kolab.db.query(`update work_event set at = $1 where kind = 'added'`, [ago(30)]);
    for (const [element, kind, when] of times) await kolab.db.query(`update work_event set at = $3 where element_id = $1 and kind = $2`, [element, kind, when]);
  } finally {
    await kolab.db.query(`alter table work_event enable trigger work_event_fixed`);
  }

  const before = await tables(kolab);
  const board = new Map((await kolab.listWork(product, { binding: 'orders-pg' })).items.map((i) => [i.id, i]));
  const read = await kolab.readWork(product, 'kj:orders-pg#W4');
  // A read writes no row.
  expect(await tables(kolab)).toStrictEqual(before);

  const S = { size: 'S', durations: 2, from: 'binding' };
  const w3Finish = new Date(ago(1 / 24).getTime() + 3 * DAY);
  const dates = (id: string) => ({ start: board.get(id)!.start, finish: board.get(id)!.finish });
  expect(dates('W1')).toStrictEqual({ start: at(ago(10)), finish: at(ago(8)) });
  expect(dates('W2')).toStrictEqual({ start: at(ago(7)), finish: at(ago(3)) });
  expect(dates('W3')).toStrictEqual({ start: at(ago(1 / 24)), finish: { at: w3Finish.toISOString(), kind: 'forecast', basis: S } });
  expect(dates('W4')).toStrictEqual({
    start: { at: w3Finish.toISOString(), kind: 'forecast', basis: { ...S, via: 'kj:orders-pg#W3' } },
    finish: { at: new Date(w3Finish.getTime() + 3 * DAY).toISOString(), kind: 'forecast', basis: S },
  });
  // konjir_read_work gives the same.
  expect({ start: read.start, finish: read.finish }).toStrictEqual(dates('W4'));
  // No size: no forecast, and none for what waits on it.
  expect(dates('W5')).toStrictEqual({ start: { at: null, kind: 'no_forecast', reason: 'kj:orders-pg#W5 has no size' }, finish: { at: null, kind: 'no_forecast', reason: 'kj:orders-pg#W5 has no size' } });
  const waits = { at: null, kind: 'no_forecast', reason: 'it waits on kj:orders-pg#W5, which has no forecast' };
  expect(dates('W6')).toStrictEqual({ start: waits, finish: waits });
  // An L package: none finished in its binding, so the kolab's, from orders-my.
  const w7 = dates('W7');
  expect(w7.start).toMatchObject({ kind: 'forecast', basis: { size: 'L', durations: 1, from: 'kolab' } });
  expect(Date.parse(w7.finish!.at!) - Date.parse(w7.start!.at!)).toBe(5 * DAY);
  // An M package: none finished in the kolab.
  expect(dates('W8').finish).toStrictEqual({ at: null, kind: 'no_forecast', reason: 'no M package in the kolab has a finished duration' });
  // A milestone: its earliest member's start, and its own finish once Done, or its members' latest.
  expect(dates('M1')).toStrictEqual({ start: at(ago(10)), finish: at(ago(3)) });
  expect(dates('M2')).toStrictEqual({ start: at(ago(1 / 24)), finish: { ...dates('W4').finish, basis: { ...S, via: 'kj:orders-pg#W4' } } });
});

test('a run starts again when a package is reopened or restored: a reopened one is To do, then starts at its new pull; a restored Done one has no actual dates, and what depends on it starts now (WRK9)', async () => {
  const { kolab, product, bob, eve } = await planned();
  const finish = async (id: string, c: string) => {
    expect(await kolab.pullWork(bob, { binding: 'orders-pg' })).toMatchObject({ pulled: true, item: { id } });
    await kolab.submitWork(bob, `kj:orders-pg#${id}`, { evidence: [{ kind: 'commit', sha: c.repeat(40), title: id, files: ['src/x.ts'] }] });
    await kolab.reviewWork(eve, `kj:orders-pg#${id}`, { verdict: 'approve', note: 'Checked.' });
  };
  await finish('W1', 'b');
  await finish('W2', 'c');
  await finish('W3', 'd');
  const item = async (id: string) => (await kolab.listWork(product, { binding: 'orders-pg' })).items.find((i) => i.id === id)!;
  expect((await item('W1')).start!.kind).toBe('actual');

  // Reopened: To do again, so forecast, from W2's and W3's durations; pulled again, it starts at the new pull, not the first.
  await kolab.reopenWork(bob, 'kj:orders-pg#W1', { note: 'Again.' });
  expect((await item('W1')).start).toMatchObject({ kind: 'forecast', basis: { size: 'S', durations: 2, from: 'binding' } });
  expect(await kolab.pullWork(bob, { binding: 'orders-pg' })).toMatchObject({ pulled: true, item: { id: 'W1' } });
  const pulls = (await kolab.db.query<{ at: Date }>(`select at from work_event where element_id = 'W1' and kind = 'pulled' order by at`)).rows.map((r) => new Date(r.at));
  expect(pulls).toHaveLength(2);
  expect((await item('W1')).start).toStrictEqual(at(pulls[1]));

  // Restored: the binding drops W2 (Done), then adds it back, with W9 depending on it.
  const all = (await kolab.elements((await kolab.latestCommitted('orders-pg'))!.id))
    .map((e) => ({ id: e.element_id, text: e.text, ...(e.parent_element_id ? { parent: e.parent_element_id } : {}), ...(e.work ? { work: e.work } : {}) }));
  await commitReviewed(kolab, bob, eve, 'orders-pg', { elements: all.filter((e) => e.id !== 'W2').map((e) => (e.id === 'M1' ? { ...e, work: { milestone: true, depends_on: ['W1'] } } : e)) });
  const v = (await kolab.latestCommitted('orders-pg'))!.id;
  await commitReviewed(kolab, bob, eve, 'orders-pg', { elements: [...all, { id: 'W9', text: 'After the refund.', work: { size: 'S', depends_on: ['W2'] } }],
    links: ['W2', 'W9'].map((w) => ({ kind: 'dependency' as const, sourceElement: w, target: v, targetElement: 'd1' })) });
  expect((await kolab.db.query(`select from_state, to_state from work_event where element_id = 'W2' and kind = 'restored'`)).rows).toStrictEqual([{ from_state: 'done', to_state: 'done' }]);
  const w2 = await item('W2');
  expect(w2.state).toBe('done');
  expect({ start: w2.start, finish: w2.finish }).toStrictEqual({
    start: { at: null, kind: 'no_forecast', reason: 'kj:orders-pg#W2 was Done with no pull in its run' },
    finish: { at: null, kind: 'no_forecast', reason: 'kj:orders-pg#W2 is Done with no event that made it Done in its run' },
  });
  // W2 is Done, so it has finished by now: W9 starts now, not at a date W2 can't give. W2's run, restored, counts no duration: W3's alone.
  const w9 = await item('W9');
  const basis = { size: 'S', durations: 1, from: 'binding' };
  expect(w9.start).toMatchObject({ kind: 'forecast', basis });
  expect(w9.start).not.toHaveProperty('basis.via');
  expect(Math.abs(Date.parse(w9.start!.at!) - Date.now())).toBeLessThan(60_000);
  expect(w9.finish).toMatchObject({ kind: 'forecast', basis });
});
