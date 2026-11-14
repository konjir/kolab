// Work found already built (migration 0051): a kolab's spec need not cover the whole of its product,
// and a product may be older than its kolab, so what a work package asks for can be there before the
// package is pulled. Its assignee builds nothing and submits it as found built, saying where; it is
// reviewed like any other; it reads as found built while In review or Done; and a forecast leaves its
// run out, since it is no measure of how long work of its size takes.
import { expect, test } from '@jest/globals';
import { els, openKolab, people, registeredRepository } from '@konjir/engine/testing';
import type { ElementInput } from '@konjir/types';

const DAY = 86_400_000;
const rejection = (p: Promise<unknown>) => p.then(() => 'resolved', (e) => String((e as Error).message ?? e));
const commit = (c: string) => ({ kind: 'commit', sha: c.repeat(40), title: 'main', files: ['src/x.ts'] });

/** A spec of one requirement and a binding with a decision and four S packages. Bob builds, eve reviews. */
async function planned() {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const product = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'engineer');
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  const spec = (await kolab.latestCommitted('orders'))!.id;
  await kolab.createNode(bob, 'binding', 'orders-pg', 'orders-pg');
  const d = els({ d1: 'A cancel endpoint, as built.' });
  const v = await kolab.draft(bob, 'orders-pg', { elements: d, links: [{ kind: 'dependency', sourceElement: 'd1', target: spec, targetElement: 'R1' }] });
  expect((await kolab.submit(bob, v)).ok).toBe(true);
  const work: ElementInput[] = ['W1', 'W2', 'W3', 'W4'].map((id) => ({ id, text: `${id}.`, work: { size: 'S' as const } }));
  const w = await kolab.draft(bob, 'orders-pg', { elements: [...d, ...work],
    links: work.map((x) => ({ kind: 'dependency' as const, sourceElement: x.id!, target: v, targetElement: 'd1' })) });
  expect((await kolab.submit(bob, w)).ok).toBe(true);
  await registeredRepository(kolab, { binding: 'orders-pg' });
  await people(kolab, 'eve', { layers: ['technical'] });
  const eve = await kolab.openSession('eve', 'engineer');
  const item = async (id: string) => (await kolab.listWork(bob, { binding: 'orders-pg' })).items.find((i) => i.id === id)!;
  return { kolab, bob, eve, item };
}

test('a package the product already met is submitted as found built, with a note saying where and the commit it was checked at; it is reviewed like any other and reads as found built', async () => {
  const { kolab, bob, eve, item } = await planned();
  expect(await kolab.pullWork(bob, { binding: 'orders-pg' })).toMatchObject({ pulled: true, item: { id: 'W1' } });
  // Its assignee's claim needs its reason, and the evidence any submission needs.
  expect(await rejection(kolab.submitWork(bob, 'kj:orders-pg#W1', { evidence: [commit('a')], foundBuilt: true }))).toMatch(/found_built needs a note/);
  expect(await rejection(kolab.submitWork(bob, 'kj:orders-pg#W1', { note: 'src/cancel.ts:12 does it.', foundBuilt: true }))).toMatch(/no commit or pull request/);
  expect(await item('W1')).not.toHaveProperty('found_built');

  const sub = await kolab.submitWork(bob, 'kj:orders-pg#W1', { evidence: [commit('a')], note: 'src/cancel.ts:12 does it; npm test: 40 passed.', foundBuilt: true });
  expect(sub).toMatchObject({ state: 'in_review', in_review: true, reviewers: ['eve'], found_built: true });
  expect(await item('W1')).toMatchObject({ state: 'in_review', found_built: true });
  const read = await kolab.readWork(eve, 'kj:orders-pg#W1');
  expect(read).toMatchObject({ found_built: true });
  expect(read.events.find((e) => e.kind === 'submitted')).toMatchObject({ actor: 'bob', note: 'found built: src/cancel.ts:12 does it; npm test: 40 passed.' });

  await kolab.reviewWork(eve, 'kj:orders-pg#W1', { verdict: 'approve', note: 'Ran it at that commit.' });
  expect(await item('W1')).toMatchObject({ state: 'done', found_built: true });
  // A package built the usual way says nothing of the kind.
  expect(await kolab.pullWork(bob, { binding: 'orders-pg' })).toMatchObject({ pulled: true, item: { id: 'W2' } });
  expect(await kolab.submitWork(bob, 'kj:orders-pg#W2', { evidence: [commit('b')] })).not.toHaveProperty('found_built');
  expect(await item('W2')).not.toHaveProperty('found_built');
});

test('a found-built package sent back, or reopened, is work to build: it is found built no longer, and the database keeps the flag to In review and Done', async () => {
  const { kolab, bob, eve, item } = await planned();
  await kolab.pullWork(bob, { binding: 'orders-pg' });
  await kolab.submitWork(bob, 'kj:orders-pg#W1', { evidence: [commit('a')], note: 'Already there.', foundBuilt: true });
  await kolab.reviewWork(eve, 'kj:orders-pg#W1', { verdict: 'request_changes', note: 'It cancels, but not a shipped order.' });
  expect(await item('W1')).toMatchObject({ state: 'in_progress' });
  expect(await item('W1')).not.toHaveProperty('found_built');
  // Built this time, and submitted as that.
  await kolab.submitWork(bob, 'kj:orders-pg#W1', { evidence: [commit('b')], note: 'Now a shipped order too.' });
  expect(await item('W1')).not.toHaveProperty('found_built');
  await kolab.reviewWork(eve, 'kj:orders-pg#W1', { verdict: 'approve', note: 'Checked.' });

  await kolab.pullWork(bob, { binding: 'orders-pg' });
  await kolab.submitWork(bob, 'kj:orders-pg#W2', { evidence: [commit('c')], note: 'Already there.', foundBuilt: true });
  await kolab.reviewWork(eve, 'kj:orders-pg#W2', { verdict: 'approve', note: 'Checked.' });
  expect(await item('W2')).toMatchObject({ state: 'done', found_built: true });
  await kolab.reopenWork(eve, 'kj:orders-pg#W2', { note: 'It broke.' });
  expect(await item('W2')).toMatchObject({ state: 'todo' });
  expect(await item('W2')).not.toHaveProperty('found_built');
  expect(await rejection(kolab.db.query(`update work_package set found_built = true where element_id = 'W2'`))).toBe('resolved');
  expect((await kolab.db.query(`select found_built from work_package where element_id = 'W2'`)).rows).toStrictEqual([{ found_built: false }]);
});

test('a forecast leaves a found-built run out: it is no measure of how long work of its size takes', async () => {
  const { kolab, bob, eve, item } = await planned();
  const finish = async (id: string, c: string, found: boolean) => {
    expect(await kolab.pullWork(bob, { binding: 'orders-pg' })).toMatchObject({ pulled: true, item: { id } });
    await kolab.submitWork(bob, `kj:orders-pg#${id}`, { evidence: [commit(c)], note: 'See the commit.', ...(found ? { foundBuilt: true } : {}) });
    await kolab.reviewWork(eve, `kj:orders-pg#${id}`, { verdict: 'approve', note: 'Checked.' });
  };
  await finish('W1', 'a', true);
  // Only a found-built run so far: nothing to forecast an S package from.
  expect((await item('W3')).finish).toMatchObject({ kind: 'no_forecast' });
  await finish('W2', 'b', false);

  // Known times: W1, found built, took minutes; W2, built, took four days.
  const now = new Date((await kolab.db.query<{ now: Date | string }>(`select clock_timestamp() as now`)).rows[0].now);
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  await kolab.db.query(`alter table work_event disable trigger work_event_fixed`);
  try {
    await kolab.db.query(`update work_event set at = $1 where kind = 'added'`, [ago(30)]);
    for (const [element, kind, when] of [['W1', 'pulled', ago(10)], ['W1', 'approved', ago(10 - 1 / 288)], ['W2', 'pulled', ago(7)], ['W2', 'approved', ago(3)]] as const) {
      await kolab.db.query(`update work_event set at = $3 where element_id = $1 and kind = $2`, [element, kind, when]);
    }
  } finally {
    await kolab.db.query(`alter table work_event enable trigger work_event_fixed`);
  }
  // W1 keeps its own actual dates; W3's forecast rests on W2's four days alone.
  expect((await item('W1')).start).toStrictEqual({ at: ago(10).toISOString(), kind: 'actual' });
  const w3 = await item('W3');
  expect(w3.finish).toMatchObject({ kind: 'forecast', basis: { size: 'S', durations: 1, from: 'binding' } });
  expect(Date.parse(w3.finish!.at!) - Date.parse(w3.start!.at!)).toBe(4 * DAY);
});
