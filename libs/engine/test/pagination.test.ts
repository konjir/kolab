// Cursor pagination (W2.21, P13, D71): every list reads a page at a time, with an opaque cursor
// on a stable sort ending in a unique id. The first page needs no cursor; next is null on the last
// page; a row added between two pages is neither repeated nor makes another one skipped; a cursor
// from another list, or one tampered with, is refused; a limit over the maximum is cut to it.
import { expect, test } from '@jest/globals';
import {
  activity, cursorFor, kolabNodesPage, LimitError, markDetailsPage, nodeQueriesPage, nodeThreads, nodeVersionsPage, queryDetailsPage, readableNodes, scoped,
  reviewRequestsPage, submissionsOf, type PageOpts,
} from '@konjir/engine';
import { PAGE_DEFAULT, PAGE_MAX, THREADS_PER_ELEMENT } from '@konjir/types';
import { els, people, rejection, setup, TEST_KOLAB } from '@konjir/engine/testing';

/** Every item of a list, page by page, and the pages' sizes. */
async function all<T>(read: (page: PageOpts) => Promise<{ items: T[]; next: string | null }>, limit?: number) {
  const items: T[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  do {
    const p: { items: T[]; next: string | null } = await read({ cursor, limit });
    items.push(...p.items);
    sizes.push(p.items.length);
    cursor = p.next;
  } while (cursor);
  return { items, sizes };
}

/** A spec with `n` elements, and a binding linking to each. */
async function kolabWith(n: number) {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
  const ids = Array.from({ length: n }, (_, i) => `R${i + 1}`);
  await kolab.commit(product, 'orders', { elements: els(Object.fromEntries(ids.map((id) => [id, `Requirement ${id} holds.`]))) });
  await kolab.createNode(engineer, 'technical_binding', 'Orders on Postgres', 'orders-pg');
  await kolab.commit(engineer, 'orders-pg', { elements: els(Object.fromEntries(ids.map((id) => [`b${id}`, `Binding for ${id}.`]))) });
  return { ...ctx, ids };
}

test('questions page by cursor, oldest first; the last page says so; one asked between pages is neither repeated nor skips another', async () => {
  const { kolab, engineer, product } = await kolabWith(1);
  for (let i = 0; i < 7; i++) await kolab.raiseQuery(engineer, 'kj:orders#R1', `Question ${i}?`);
  const first = await kolab.queriesPage(product, { layer: 'functional', state: 'open' }, { limit: 3 });
  expect(first.items.map((q) => q.question)).toStrictEqual(['Question 0?', 'Question 1?', 'Question 2?']);
  expect(first.next).toEqual(expect.any(String));
  // One asked now sorts after every one already listed: it shows on a later page, once.
  await kolab.raiseQuery(engineer, 'kj:orders#R1', 'Question 7?');
  const rest = await all((p) => kolab.queriesPage(product, { layer: 'functional', state: 'open' }, { ...p, cursor: p.cursor ?? first.next }), 3);
  expect(rest.items.map((q) => q.question)).toStrictEqual(['Question 3?', 'Question 4?', 'Question 5?', 'Question 6?', 'Question 7?']);
  expect(rest.sizes).toStrictEqual([3, 2]);
  // The whole list, with no limit: one page of at most PAGE_DEFAULT, and no next.
  expect(await kolab.queriesPage(product, { layer: 'functional', state: 'open' })).toMatchObject({ next: null });
  // Exactly a page's worth: the last page is that one, with no empty page after it.
  expect((await kolab.queriesPage(product, { layer: 'functional', state: 'open' }, { limit: 8 })).next).toBeNull();
});

test('a cursor from another list, a tampered one, and a bad limit are refused; a limit over the maximum is cut to it', async () => {
  const { kolab, product } = await kolabWith(1);
  const other = cursorFor('marks', ['2026-01-01 00:00:00+00', 'x']);
  expect(await rejection(kolab.queriesPage(product, {}, { cursor: other }))).toMatch(/LimitError: invalid cursor: that isn't one this list gave/);
  expect(await rejection(kolab.queriesPage(product, {}, { cursor: 'not-a-cursor' }))).toMatch(/LimitError/);
  expect(await rejection(kolab.queriesPage(product, {}, { limit: 0 }))).toMatch(new RegExp(`limit is a whole number from 1 to ${PAGE_MAX}`));
  expect(await rejection(kolab.queriesPage(product, {}, { limit: 1.5 }))).toMatch(/LimitError/);
  await expect(kolab.queriesPage(product, {}, { limit: 10_000 })).resolves.toMatchObject({ next: null });
  expect(new LimitError('x').name).toBe('LimitError');
});

test('a cursor whose key parts are the wrong shape, or that another filter gave, is refused as invalid before it reaches the database', async () => {
  const { kolab, product, engineer } = await kolabWith(2);
  const invalid = /^LimitError: invalid cursor: that isn't one this list gave/;
  // The right list and filters, a key part that isn't a timestamp, or one out of range, or not a whole number.
  const marks = scoped('marks', { layer: 'technical', kolab: TEST_KOLAB });
  for (const key of [['not a time', 'x'], ['2026-13-01 00:00:00+00', 'x'], ['2026-02-30 00:00:00+00', 'x'], [5, 'x'], ['2026-01-01 00:00:00+00', 7]]) {
    expect(await rejection(kolab.marksPage(engineer, { layer: 'technical' }, { cursor: cursorFor(marks, key) }))).toMatch(invalid);
  }
  await expect(kolab.marksPage(engineer, { layer: 'technical' }, { cursor: cursorFor(marks, ['2026-01-01 00:00:00.123456+00', 'x']) })).resolves.toMatchObject({ items: [] });
  const rulings = scoped('rulings', { kolab: TEST_KOLAB });
  expect(await rejection(kolab.rulingsPage(product, {}, { cursor: cursorFor(rulings, ['yesterday', 'x']) }))).toMatch(invalid);
  const reviews = scoped('reviews', { reviewer: 'bob', kolab: TEST_KOLAB });
  expect(await rejection(kolab.reviewRequestsPage({ reviewer: 'bob', kolab: TEST_KOLAB }, { cursor: cursorFor(reviews, ['now', 'bob', 'x']) }))).toMatch(invalid);
  expect(await rejection(nodeVersionsPage(kolab, product, 'orders', { which: 'shown', actor: 'alice' }, { cursor: cursorFor(scoped('web:versions', { nodeId: 'orders', which: 'shown', actor: 'alice' }), [-1]) }))).toMatch(invalid);
  // A cursor is bound to the filters it was read with, the layer included.
  for (let i = 0; i < 3; i++) await kolab.raiseQuery(engineer, 'kj:orders#R1', `Question ${i}?`);
  const page = await kolab.queriesPage(product, { layer: 'functional', state: 'open' }, { limit: 1 });
  expect(await rejection(kolab.queriesPage(product, { layer: 'technical', state: 'open' }, { cursor: page.next }))).toMatch(invalid);
  expect(await rejection(kolab.queriesPage(product, { layer: 'functional', state: 'answered' }, { cursor: page.next }))).toMatch(invalid);
  await expect(kolab.queriesPage(product, { layer: 'functional', state: 'open' }, { cursor: page.next })).resolves.toMatchObject({ items: [expect.anything(), expect.anything()], next: null });
});

test('case files page newest opened first, on a key that doesn\'t move when a case is argued', async () => {
  const { kolab, product, engineer } = await kolabWith(3);
  const opened: string[] = [];
  for (const r of ['R1', 'R2', 'R3']) {
    opened.push(await kolab.openCase(engineer, `kj:orders#${r}`, { question: `Is ${r} right?`, claim: 'It reads two ways.', evidence: [`kj:orders#${r}`], seeks: 'change_intent' }));
  }
  const first = await kolab.casesPage(product, { state: 'open' }, { limit: 1 });
  expect(first.items.map((c) => c.case)).toStrictEqual([opened[2]]);
  // Arguing the oldest while the list is paged doesn't move it, or make another one skipped.
  await kolab.addPosition(product, opened[0], { claim: 'It reads one way.', evidence: ['kj:orders#R1'] });
  const rest = await all((p) => kolab.casesPage(product, { state: 'open' }, { ...p, cursor: p.cursor ?? first.next }), 1);
  expect(rest.items.map((c) => c.case)).toStrictEqual([opened[1], opened[0]]);
});

test('marks, nodes, lineage, review requests and submissions page by cursor to their last page', async () => {
  const { kolab, product, engineer, ids } = await kolabWith(5);
  for (const id of ids) await kolab.link(engineer, { kind: 'dependency', source: (await kolab.latestCommitted('orders-pg'))!.id, sourceElement: `b${id}`, target: (await kolab.latestCommitted('orders'))!.id, targetElement: id });
  // A new version of every requirement marks every link: five marks on the technical layer.
  await kolab.commit(product, 'orders', { elements: els(Object.fromEntries(ids.map((id) => [id, `Requirement ${id} holds, changed.`]))) });
  const marks = await all((p) => kolab.marksPage(engineer, { layer: 'technical' }, p), 2);
  expect(marks.sizes).toStrictEqual([2, 2, 1]);
  expect(new Set(marks.items.map((m) => m.mark)).size).toBe(5);
  expect(marks.items.map((m) => m.mark)).toStrictEqual((await kolab.marksFor(engineer, { layer: 'technical' })).map((m) => m.mark));
  // The web interface's marks, the same marks a page at a time.
  expect((await all((p) => markDetailsPage(kolab, engineer, p), 2)).items.map((m) => m.id)).toStrictEqual(marks.items.map((m) => m.mark));

  for (const name of ['a', 'b', 'c']) await kolab.createNode(product, 'functional_spec', name.toUpperCase(), name);
  const nodes = await all((p) => kolab.nodesPage(TEST_KOLAB, undefined, p), 2);
  expect(nodes.items.map((n) => n.name)).toStrictEqual(['a', 'b', 'c', 'orders', 'orders-pg']);
  expect((await all((p) => kolabNodesPage(kolab, product, p), 2)).items.map((n) => n.name)).toStrictEqual(['a', 'b', 'c', 'orders', 'orders-pg']);
  expect((await all((p) => kolabNodesPage(kolab, product, p, { committed: true }), 1)).items.map((n) => n.name)).toStrictEqual(['orders', 'orders-pg']);
  expect((await all((p) => readableNodes(kolab, product, TEST_KOLAB, p).then((r) => r!), 1)).items.map((n) => n.name)).toStrictEqual(['orders', 'orders-pg']);

  const live = (await kolab.latestCommitted('orders'))!.id;
  const down = await all((p) => kolab.lineagePage(live, 'downstream', p), 2);
  expect(down.sizes).toStrictEqual([2, 2, 1]);
  expect(down.items.map((e) => e.edge)).toStrictEqual((await kolab.lineage(live, 'downstream')).map((e) => e.edge));

  // Review requests and submissions: a second writer on the functional layer, so versions wait in review.
  await people(kolab, 'dana', { layers: ['functional'] });
  const dana = await kolab.openSession('dana', 'product');
  for (const name of ['a', 'b', 'c']) await kolab.submit(product, await kolab.draft(product, name, { elements: els({ X1: `${name} says one thing.` }) }));
  const requests = await all((p) => kolab.reviewRequestsPage({ reviewer: 'dana', kolab: TEST_KOLAB }, p), 2);
  expect(requests.items.map((r) => r.subject)).toStrictEqual(['kj:a@1', 'kj:b@1', 'kj:c@1']);
  expect((await all((p) => reviewRequestsPage(kolab, dana, { reviewer: 'dana', layer: 'functional' }, p), 2)).items.map((r) => r.node)).toStrictEqual(['a', 'b', 'c']);
  const mine = await all((p) => kolab.submissionsPage('alice', { kolab: TEST_KOLAB }, p), 2);
  expect(mine.items.map((s) => s.subject)).toStrictEqual(['kj:c@1', 'kj:b@1', 'kj:a@1']);
  expect((await all((p) => submissionsOf(kolab, product, 'alice', p), 2)).items.map((s) => s.node)).toStrictEqual(['c', 'b', 'a']);
});

test('case files and rulings page newest first; the activity and the web interface\'s questions too', async () => {
  const { kolab, product, engineer } = await kolabWith(4);
  await people(kolab, 'lee', { layers: ['functional'] });
  const lee = await kolab.openSession('lee', 'product');
  const cases: string[] = [];
  for (const el of ['R1', 'R2', 'R3', 'R4']) {
    cases.push(await kolab.openCase(engineer, `kj:orders#${el}`, { question: `Can ${el} be met?`, claim: `${el} can't be met.`, seeks: 'change_intent', evidence: ['a test run'] }));
  }
  const listed = await all((p) => kolab.casesPage(product, { state: 'open' }, p), 3);
  expect(listed.items.map((c) => c.case)).toStrictEqual([...cases].reverse());
  expect(listed.sizes).toStrictEqual([3, 1]);
  for (const el of ['R1', 'R2', 'R3']) await kolab.rule(lee, { address: `kj:orders#${el}`, text: `${el} stands.`, effect: 'keep_intent' });
  const rulings = await all((p) => kolab.rulingsPage(product, {}, p), 2);
  expect(rulings.items.map((r) => r.text)).toStrictEqual(['R3 stands.', 'R2 stands.', 'R1 stands.']);

  for (let i = 0; i < 5; i++) await kolab.raiseQuery(engineer, 'kj:orders#R4', `Question ${i}?`);
  const open = await all((p) => queryDetailsPage(kolab, product, { open: true }, p), 2);
  expect(open.items.map((q) => q.question)).toStrictEqual(['Question 4?', 'Question 3?', 'Question 2?', 'Question 1?', 'Question 0?']);
  expect((await queryDetailsPage(kolab, product, { open: false })).items.every((q) => q.state !== 'open')).toBe(true);

  const everything = await all((p) => activity(kolab, product, p), 4);
  const once = await activity(kolab, product, { limit: PAGE_MAX });
  expect(once.next).toBeNull();
  expect(everything.items).toStrictEqual(once.items);
  expect(everything.items.length).toBeGreaterThan(10);
});

test('the admin lists page by id', async () => {
  const { kolab } = await kolabWith(1);
  for (const id of ['p1', 'p2', 'p3']) await kolab.addActor(id);
  const actors = await all((p) => kolab.actorsPage({}, p), 2);
  expect(actors.items.map((a) => a.id)).toStrictEqual((await kolab.listActors()).map((a) => a.id));
  for (const id of ['k1', 'k2']) await kolab.createKolab(id, { owner: 'p1' });
  expect((await all((p) => kolab.kolabsPage({}, p), 1)).items.map((k) => k.id)).toStrictEqual((await kolab.listKolabs()).map((k) => k.id));
  expect((await all((p) => kolab.outboxPage({}, p), 1)).items).toStrictEqual(await kolab.outboxJobs());
  expect(PAGE_DEFAULT).toBe(50);
});

test('read_node reads the newest questions of the page\'s elements in SQL, and counts the rest; an outside reader\'s are counted as it sees them', async () => {
  const { kolab, engineer, product } = await kolabWith(2);
  for (let i = 0; i < 5; i++) await kolab.raiseQuery(engineer, 'kj:orders#R1', `R1 question ${i}?`);
  for (let i = 0; i < 3; i++) await kolab.raiseQuery(engineer, 'kj:orders#R2', `R2 question ${i}?`);
  await kolab.raiseQuery(engineer, 'kj:orders', 'About the whole spec?');
  // The first element's page: R1's newest two, oldest first, and the node's own; nothing of R2's.
  const first = await kolab.readNode(product, 'orders', undefined, { threads: { per: 2, from: 0, count: 1 } });
  expect(first.queries.map((q) => q.question)).toStrictEqual(['R1 question 3?', 'R1 question 4?', 'About the whole spec?']);
  expect(Object.fromEntries(first.query_counts!)).toStrictEqual({ '': 1, R1: 5 });
  // The second: R2's newest two, and not the node's again.
  const second = await kolab.readNode(product, 'orders', undefined, { threads: { per: 2, from: 1, count: 1 } });
  expect(second.queries.map((q) => q.question)).toStrictEqual(['R2 question 1?', 'R2 question 2?']);
  expect(Object.fromEntries(second.query_counts!)).toStrictEqual({ R2: 3 });
  // Without threads, every question, as before; with threads: false, none.
  expect((await kolab.readNode(product, 'orders')).queries).toHaveLength(9);
  expect((await kolab.readNode(product, 'orders', undefined, { threads: false })).queries).toStrictEqual([]);
});

test('a node\'s versions and each element\'s questions page newest first for its web page, and a kolab\'s invites and who holds access page too', async () => {
  const { kolab, engineer, product } = await kolabWith(1);
  for (let i = 2; i <= 5; i++) await kolab.commit(product, 'orders', { elements: els({ R1: `Requirement R1 holds, take ${i}.` }) });
  const productId = (await kolab.sessionInfo(product)).actor;
  const versions = await all((p) => nodeVersionsPage(kolab, product, 'orders', { which: 'shown', actor: productId }, p), 2);
  expect(versions.items.map((v) => v.seq)).toStrictEqual([5, 4, 3, 2, 1]);
  expect(versions.sizes).toStrictEqual([2, 2, 1]);
  // A version written between pages is newer than every one listed: it isn't on a later page.
  const top = await nodeVersionsPage(kolab, product, 'orders', { which: 'shown', actor: productId }, { limit: 2 });
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Requirement R1 holds, take 6.' }) });
  const rest = await all((p) => nodeVersionsPage(kolab, product, 'orders', { which: 'shown', actor: productId }, { ...p, cursor: p.cursor ?? top.next }), 2);
  expect(rest.items.map((v) => v.seq)).toStrictEqual([3, 2, 1]);
  expect(await rejection(nodeVersionsPage(kolab, product, 'orders', { which: 'shown', actor: productId }, { cursor: cursorFor('web:versions', ['x']) }))).toMatch(/LimitError/);

  for (let i = 0; i < 5; i++) await kolab.raiseQuery(engineer, 'kj:orders#R1', `Question ${i}?`);
  const threads = await nodeThreads(kolab, product, 'orders', 2);
  expect(threads.get('R1')!.items.map((q) => q.question)).toStrictEqual(['Question 4?', 'Question 3?']);
  const older = await all((p) => nodeQueriesPage(kolab, product, 'orders', 'R1', { ...p, cursor: p.cursor ?? threads.get('R1')!.next }), 2);
  expect(older.items.map((q) => q.question)).toStrictEqual(['Question 2?', 'Question 1?', 'Question 0?']);
  expect((await nodeQueriesPage(kolab, product, 'orders', null, {})).items).toStrictEqual([]);

  // Invites and who holds access, for a kolab's admin: a person's own kolab.
  const k = kolab;
  for (const id of ['ann', 'eli', 'fay', 'gus']) await k.addActor(id);
  await k.createKolab('anns', { owner: 'ann' });
  for (const id of ['eli', 'fay', 'gus']) await k.grant('anns', id, 'read');
  const ann = await k.openSession('ann', 'product', { kolab: 'anns' });
  const made: string[] = [];
  for (let i = 0; i < 5; i++) made.push((await k.createInvite(ann, { level: 'read' })).invite.id);
  const invites = await all((p) => k.invitesPage(ann, p), 2);
  expect(invites.items.map((i) => i.id)).toStrictEqual([...made].reverse());
  expect(invites.sizes).toStrictEqual([2, 2, 1]);
  expect(invites.items.map((i) => i.id)).toStrictEqual((await k.listInvites(ann)).map((i) => i.id));
  const whole = await k.listAccess(ann);
  const holders: string[] = [];
  let cursor: string | null | undefined = null;
  do {
    const p = await k.listAccess(ann, { cursor, limit: 2 });
    expect(p.holders.length).toBeLessThanOrEqual(2);
    expect(p.teams).toStrictEqual(whole.teams);
    holders.push(...p.holders.map((h) => h.actor));
    cursor = p.next;
  } while (cursor);
  // Highest access first, then by name: Ann, then her three readers.
  expect(holders).toStrictEqual(['ann', 'eli', 'fay', 'gus']);
  expect(whole.holders.map((h) => h.actor)).toStrictEqual(holders);
  expect(await rejection(k.listAccess(ann, { cursor: cursorFor('invites', ['a', 'b']) }))).toMatch(/LimitError/);
});

test('many nodes, questions and marks list in pages quickly, on the indexes the paged reads need', async () => {
  const { kolab, product, engineer } = await kolabWith(2);
  const v = (await kolab.latestCommitted('orders'))!.id;
  const t = (await kolab.latestCommitted('orders-pg'))!.id;
  // In bulk, straight into the tables: 2,000 nodes, 20,000 questions and 5,000 open marks.
  await kolab.db.exec(`
    insert into node(id, name, kind, layer, title, kolab_id, created_by)
      select 'n' || lpad(i::text, 5, '0'), 'n' || lpad(i::text, 5, '0'), 'functional_spec', 'functional', 'Node ' || i, '${TEST_KOLAB}', 'alice' from generate_series(1, 2000) i;
    insert into query(id, version_id, element_id, question, state, kind, kolab_id, created_at)
      select '01Q' || lpad(i::text, 8, '0'), '${v}', 'R1', 'Question ' || i, case when i % 3 = 0 then 'answered' else 'open' end, 'question',
             '${TEST_KOLAB}', now() - (20000 - i) * interval '1 second' from generate_series(1, 20000) i;
    insert into invalidation(id, version_id, element_id, triggered_by, reason, state, kolab_id, created_at)
      select '01M' || lpad(i::text, 8, '0'), '${t}', 'bR1', '${v}', 'changed', 'open', '${TEST_KOLAB}', now() - (5000 - i) * interval '1 second'
        from generate_series(1, 5000) i;
    analyze;
  `);
  const timed = async <T>(fn: () => Promise<T>) => { const at = performance.now(); const r = await fn(); return { r, ms: performance.now() - at }; };
  const queries = await timed(() => kolab.queriesPage(product, { layer: 'functional', state: 'open' }));
  expect(queries.r.items).toHaveLength(PAGE_DEFAULT);
  const deep = await timed(() => kolab.queriesPage(product, { layer: 'functional', state: 'open' }, { cursor: queries.r.next, limit: PAGE_MAX }));
  expect(deep.r.items).toHaveLength(PAGE_MAX);
  const marks = await timed(() => kolab.marksPage(engineer, { layer: 'technical' }));
  expect(marks.r.items).toHaveLength(PAGE_DEFAULT);
  const nodes = await timed(() => kolab.nodesPage(TEST_KOLAB, undefined, { limit: PAGE_MAX }));
  expect(nodes.r.items).toHaveLength(PAGE_MAX);
  const web = await timed(() => queryDetailsPage(kolab, product, { open: true }));
  expect(web.r.items).toHaveLength(PAGE_DEFAULT);
  // A node's page and read_node read only each element's newest questions, and count the rest, in SQL.
  const threads = await timed(() => nodeThreads(kolab, product, 'orders', THREADS_PER_ELEMENT));
  expect(threads.r.get('R1')!.items).toHaveLength(THREADS_PER_ELEMENT);
  expect(threads.r.get('R1')!.next).toEqual(expect.any(String));
  const read = await timed(() => kolab.readNode(product, 'orders', undefined, { threads: { per: THREADS_PER_ELEMENT, from: 0, count: 250 } }));
  expect(read.r.queries).toHaveLength(THREADS_PER_ELEMENT);
  expect(read.r.query_counts!.get('R1')).toBe(20000);
  // Generous for a loaded CI runner on PGlite: what matters is that a page doesn't read the kolab.
  for (const { ms } of [queries, deep, marks, nodes, web, threads, read]) expect(ms).toBeLessThan(3000);

  // The plans: each paged read starts from an index, never a scan of the whole table.
  const plan = async (sql: string, params: unknown[]) => (await kolab.db.query<{ 'QUERY PLAN': string }>(`explain ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
  for (const [sql, params] of [
    [`select id from query where kolab_id = $1 and state = 'open' and id > $2 order by id limit 51`, [TEST_KOLAB, '01Q00000100']],
    [`select id from query where kolab_id = $1 and (created_at, id) < (now(), $2) order by created_at desc, id desc limit 51`, [TEST_KOLAB, '01Q00009000']],
    [`select id from invalidation where kolab_id = $1 and state = 'open' and (created_at, id) > (now() - interval '1 hour', $2) order by created_at, id limit 51`, [TEST_KOLAB, '01M']],
    [`select name from node where kolab_id = $1 and (kind, name) > ($2, $3) order by kind, name limit 51`, [TEST_KOLAB, 'functional_spec', 'n01000']],
  ] as const) {
    const p = await plan(sql, [...params]);
    expect(p).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    expect(p).not.toMatch(/Seq Scan/);
  }
  // The per-actor rates, counted before each ask and draft, have an index of their own: the
  // versions here are too few for the planner to choose it, so it is asked to avoid a scan.
  for (const [sql, index] of [
    [`select count(*) from query where raised_by = $1 and created_at > now() - interval '1 hour'`, /query_raised_(at|by)/],
    [`select count(*) from version where actor_id = $1 and created_at > now() - interval '1 hour'`, /version_actor_(at|created)/],
  ] as const) {
    const p = await kolab.db.transaction(async (tx) => {
      await tx.exec('set local enable_seqscan = off');
      return (await tx.query<{ 'QUERY PLAN': string }>(`explain ${sql}`, ['someone'])).rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(p).toMatch(index);
    expect(p).not.toMatch(/Seq Scan/);
  }
});
