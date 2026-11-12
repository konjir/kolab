// Progress over MCP (W8.7; WRK8, WRK6, PLN7, DAT18): a read, never a row. read_node gives each
// element its progress, a spec element's as a list with one entry per binding, and list_rulings
// each ruling's, from the elements whose Source line names it; a work package moving through its
// states moves its decision, the spec element it serves, that element's sections and the ruling with
// it, a second binding's entry stays as it was, and the reads write nothing.
import { expect, test } from '@jest/globals';
import pg from 'pg';
import type { Kolab } from '@konjir/engine';
import { startServer } from '@konjir/server';
import { call, connect } from '../src/cli.js';
import { closeAtEnd, commitReviewed, els, openKolab, people, registeredRepository } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';

/**
 * Every table's rows, as one digest each: what a read must leave as it found it. With `lease`, the
 * work packages' without what a call by a package's holder renews (PLN15): its lease, and when it was touched; the leases apart.
 */
async function tables(kolab: Kolab, opts: { lease?: boolean } = {}) {
  const names = (await kolab.db.query<{ t: string }>(`select tablename as t from pg_tables where schemaname = 'public' order by tablename`)).rows.map((r) => r.t);
  const out: Record<string, string | null> = {};
  for (const t of names) {
    const row = opts.lease && t === 'work_package' ? `(to_jsonb(x) - 'lease_until' - 'updated_at' - 'touched_at')::text` : 'x::text';
    out[t] = (await kolab.db.query<{ d: string | null }>(`select md5(string_agg(${row}, '|' order by ${row})) as d from ${pg.escapeIdentifier(t)} x`)).rows[0].d;
  }
  if (opts.lease) out.leases = (await kolab.db.query<{ d: string | null }>(`select string_agg(element_id || '=' || lease_until::text, ',' order by element_id) as d from work_package where lease_until is not null`)).rows[0].d;
  return out;
}

test('read_node and list_rulings give progress as it is read: a package through its states moves its decision, the spec element it serves, its sections and the ruling its Source names; another binding\'s entry stays; at risk follows a mark; no row is written (WRK8)', async () => {
  const kolab = await openKolab();
  const server = await startServer({ adminToken: ADMIN, kolab });
  closeAtEnd(server);
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const product = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'engineer');
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  // R1's Source line names D7; R1a sits two levels under S; R3 is served by a decision no work relies on.
  await kolab.commit(product, 'orders', { elements: els(
    { S: 'Orders.', R1: 'Orders can be cancelled.\nSource: D7, D12.', R1a: 'Within a day.', R2: 'Orders ship in a day.', R3: 'Orders are cheap.' },
    { R1: 'S', R1a: 'R1', R2: 'S', R3: 'S' }) });
  // D7 is named by the spec, D9 by a decision of orders-pg, D8 by nothing; one with no ref has no progress.
  for (const ref of ['D7', 'D8', 'D9']) await kolab.rule(product, { address: 'kj:orders#R2', text: `Ruling ${ref}.`, effect: 'keep_intent', ref });
  await kolab.rule(product, { address: 'kj:orders#R2', text: 'A ruling with no ref.', effect: 'keep_intent' });
  const spec = (await kolab.latestCommitted('orders'))!.id;
  /** A binding: its decisions, serving the spec, then its work packages, each relying on one decision. */
  const binding = async (name: string, decisions: [string, string, string][], work: [string, string][]) => {
    await kolab.createNode(bob, 'binding', name, name);
    const d = els(Object.fromEntries(decisions.map(([id, text]) => [id, text])));
    const v = await kolab.draft(bob, name, { elements: d, links: decisions.map(([id, , r]) => ({ kind: 'dependency' as const, sourceElement: id, target: spec, targetElement: r })) });
    expect((await kolab.submit(bob, v)).ok).toBe(true);
    const w = await kolab.draft(bob, name, {
      elements: [...d, ...work.map(([id]) => ({ id, text: `Build ${id}.`, work: { size: 'S' as const } }))],
      links: work.map(([id, on]) => ({ kind: 'dependency' as const, sourceElement: id, target: v, targetElement: on })),
    });
    expect((await kolab.submit(bob, w)).ok).toBe(true);
  };
  await binding('orders-pg', [['b1', 'A cancel endpoint.\nSource: D9', 'R1a'], ['b2', 'A shipping queue.', 'R2'], ['b3', 'Cheap hosting.', 'R3']], [['W1', 'b1'], ['W2', 'b2']]);
  await binding('orders-my', [['c1', 'A cancel endpoint on MySQL.', 'R1']], [['X1', 'c1']]);
  await registeredRepository(kolab, { binding: 'orders-pg' });
  await people(kolab, 'eve', { layers: ['technical'] });
  const eve = await kolab.openSession('eve', 'engineer');
  const reader = await connect(server.url, product);
  // Bob reads too, holding W1 once he pulls it: his calls renew its lease (PLN15), and nothing else.
  const holder = await connect(server.url, bob);
  closeAtEnd(reader, holder);

  type El = { id: string; progress?: unknown };
  const nodeProgress = async (node: string, as = reader) =>
    Object.fromEntries(((await call(as, 'read_node', { node })) as { elements: El[] }).elements.map((e) => [e.id, e.progress]));
  const rulingProgress = async (as = reader) =>
    Object.fromEntries(((await call(as, 'list_rulings', {})) as { rulings: { ref: string | null; text: string; progress?: unknown }[] }).rulings.map((r) => [r.ref ?? r.text, r.progress]));
  /** What each verb gives, with W1 at `w1`, at risk or not: nothing else moves. */
  const expected = (w1: string, risk = false) => {
    const p = (progress: string, at_risk = false) => ({ progress, at_risk });
    const b = (binding: string, progress: string, at_risk = false) => ({ binding, progress, at_risk });
    return {
      binding: { b1: p(w1, risk), b2: p('todo'), b3: p('no_work'), W1: p(w1, risk), W2: p('todo') },
      other: { c1: p('todo'), X1: p('todo') },
      spec: {
        // The section, through R1 and R1a two levels down, R2 and R3: R3's decision has no work, so it is left out.
        S: [b('orders-my', 'todo'), b('orders-pg', w1 === 'todo' ? 'todo' : 'in_progress', risk)],
        R1: [b('orders-my', 'todo'), b('orders-pg', w1, risk)],
        R1a: [b('orders-my', 'not_served'), b('orders-pg', w1, risk)],
        R2: [b('orders-my', 'not_served'), b('orders-pg', 'todo')],
        R3: [b('orders-my', 'not_served'), b('orders-pg', 'no_work')],
      },
      rulings: { D7: [b('orders-my', 'todo'), b('orders-pg', w1, risk)], D9: [b('orders-pg', w1, risk)], D8: undefined, 'A ruling with no ref.': undefined },
    };
  };
  const read = async (as = reader) => ({
    binding: await nodeProgress('orders-pg', as), other: await nodeProgress('orders-my', as), spec: await nodeProgress('orders', as), rulings: await rulingProgress(as),
  });
  const check = async (w1: string, risk = false) => {
    const before = await tables(kolab);
    expect(await read()).toStrictEqual(expected(w1, risk));
    await call(reader, 'list_work', {});
    await call(reader, 'read_work', { work: 'kj:orders-pg#W1' });
    // A read writes no row.
    expect(await tables(kolab)).toStrictEqual(before);
  };

  await check('todo');
  const pulled = await kolab.pullWork(bob, { binding: 'orders-pg' });
  expect(pulled).toMatchObject({ pulled: true, item: { id: 'W1' } });
  await check('in_progress');
  // As W1's holder, its lease pushed back so that a call renews it: the renewal is all that is written.
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '2 minutes' where element_id = 'W1'`);
  const held = await tables(kolab, { lease: true });
  expect(await read(holder)).toStrictEqual(expected('in_progress'));
  await call(holder, 'list_work', {});
  await call(holder, 'read_work', { work: 'kj:orders-pg#W1' });
  const renewed = await tables(kolab, { lease: true });
  expect(renewed.leases).not.toBe(held.leases);
  expect({ ...renewed, leases: null }).toStrictEqual({ ...held, leases: null });
  // A move writes the package's own state and events, and the submission's evidence, review request and rate count: nothing of progress.
  const before = await tables(kolab);
  await kolab.submitWork(bob, 'kj:orders-pg#W1', { evidence: [{ kind: 'commit', sha: 'a'.repeat(40), title: 'Cancel', files: ['src/cancel.ts'] }] });
  const after = await tables(kolab);
  expect(Object.keys(after).filter((t) => after[t] !== before[t]).sort()).toStrictEqual(['evidence', 'rate_event', 'review_request', 'work_event', 'work_package']);
  await check('in_progress');
  await kolab.reviewWork(eve, 'kj:orders-pg#W1', { verdict: 'approve', note: 'Checked.' });
  await check('done');
  // Progress is on the latest committed version only.
  expect(((await call(reader, 'read_node', { node: 'orders-pg', version: 1 })) as { elements: El[] }).elements.map((e) => e.progress)).toStrictEqual([undefined, undefined, undefined]);
  // The decision W1 relies on changes: the mark puts W1 at risk, and with it all that counts it (WRK6).
  const all = (await kolab.elements((await kolab.latestCommitted('orders-pg'))!.id))
    .map((e) => ({ id: e.element_id, text: e.element_id === 'b1' ? 'A cancel endpoint, idempotent.\nSource: D9' : e.text, ...(e.work ? { work: e.work } : {}) }));
  await commitReviewed(kolab, bob, eve, 'orders-pg', { elements: all });
  await check('done', true);
  // One who only reads sees progress, and not whether work is at risk: that tells of a mark (D58).
  await people(kolab, 'carol', { level: 'read' });
  const carol = await connect(server.url, await kolab.openSession('carol', 'product'));
  closeAtEnd(carol);
  const r1 = ((await call(carol, 'read_node', { node: 'orders' })) as { elements: El[] }).elements.find((e) => e.id === 'R1');
  expect(r1?.progress).toStrictEqual([{ binding: 'orders-my', progress: 'todo' }, { binding: 'orders-pg', progress: 'done' }]);
});
