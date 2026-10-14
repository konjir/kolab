// Questions and notes across the layer boundary: the engineer asks or
// annotates the spec, the answer comes back to the element that waited on it,
// and every inbox change is pushed to subscribed agents.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kolab, RoleError } from '@konjir/engine';
import type { KolabEvent } from '@konjir/types';
import { startServer } from '@konjir/server';
import { call, connect, watch } from '../src/cli.js';
import { els, marksOn, setup } from '@konjir/engine/testing';

async function specAndBinding() {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({
    R8: 'Office staff can cancel an order.',
    R13: 'Photos taken more than 50 meters from the property are flagged.',
  }) });
  await kolab.createNode(engineer, 'technical_binding', 'Orders on Postgres', 'orders-pg');
  const draft = await kolab.draft(engineer, 'orders-pg', { elements: els({
    b1: 'orders.status allows cancel from Open and Assigned (pending a spec question).',
    b2: 'Photo GPS distance check in the mobile app.',
  }) });
  return { ...ctx, draft };
}

test('a question asked from a binding element comes back to that element as a mark', async () => {
  const { kolab, product, engineer, draft } = await specAndBinding();
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));

  // Asked while the binding is still a draft, about a quoted span.
  const q = await kolab.raiseQuery(engineer, 'kj:orders#R8~q({"exact":"cancel an order"})',
    'From which statuses, and what happens to its invoices?', { from: 'kj:orders-pg@1#b1' });
  assert.deepEqual(events, [{ inbox: 'layer', layer: 'functional' }]);
  assert.equal((await kolab.review(draft)).ok, true);

  const [listed] = await kolab.listQueries({ layer: 'functional', state: 'open' });
  assert.deepEqual(
    [listed.id, listed.kind, listed.address, listed.from, listed.raised_by],
    [q, 'question', 'kj:orders@1#R8~q({"exact":"cancel an order"})', 'kj:orders-pg@1#b1', 'bob']);

  // Only the owning layer answers. The answer marks b1, not b2, and tells the asker.
  await assert.rejects(kolab.answerQuery(engineer, q, 'any time'), RoleError);
  events.length = 0;
  await kolab.answerQuery(product, q, 'Open or Assigned only; invoices are voided.');
  const [mark] = await marksOn(kolab, 'orders-pg');
  assert.deepEqual([mark.reason, mark.element_id], ['query_answered', 'b1']);
  assert.match(mark.note!, /you asked "From which statuses.*answered: "Open or Assigned only/);
  assert.deepEqual(
    (await kolab.describeMarks({ layer: 'technical' })).map((m) => [m.dirty, m.because.slice(0, 15)]),
    [['kj:orders-pg@1#b1', 'kj:orders#R8: y']]);
  assert.deepEqual(new Set(events.map((e) => JSON.stringify(e))), new Set([
    JSON.stringify({ inbox: 'layer', layer: 'technical' }),   // the new mark
    JSON.stringify({ inbox: 'layer', layer: 'functional' }),  // the queue shrank
    JSON.stringify({ inbox: 'actor', actor: 'bob' }),         // the asker's answers
  ]));
  assert.deepEqual((await kolab.listQueries({ raisedBy: 'bob' })).map((x) => [x.state, x.answered_by]), [['answered', 'alice']]);

  // Revising b1 addresses the mark; nothing else was touched.
  await kolab.commit(engineer, 'orders-pg', { deltas: [{ kind: 'override', element: 'b1', text: 'orders.status allows cancel from Open and Assigned; cancelling voids both invoices.' }] });
  assert.deepEqual(await marksOn(kolab, 'orders-pg'), []);
});

test('a note asks nothing: it waits in the owner\'s queue, and a reply marks nothing', async () => {
  const { kolab, product, engineer, draft } = await specAndBinding();
  await kolab.review(draft);
  const n = await kolab.raiseQuery(engineer, 'kj:orders#R13', 'Read "flagged" as a warning on the photo that does not block submission.',
    { kind: 'note', from: 'kj:orders-pg#b2' });
  assert.deepEqual((await kolab.listQueries({ layer: 'functional', state: 'open' })).map((x) => [x.id, x.kind]), [[n, 'note']]);
  await kolab.answerQuery(product, n, 'Agreed.');
  assert.deepEqual(await marksOn(kolab, 'orders-pg'), []);
  assert.equal((await kolab.listQueries({ raisedBy: 'bob' }))[0].answer, 'Agreed.');
});

test('from must name the asker\'s own layer, and must resolve', async () => {
  const { kolab, engineer } = await specAndBinding();
  await assert.rejects(kolab.raiseQuery(engineer, 'kj:orders#R8', 'q', { from: 'kj:orders#R13' }), /own layer/);
  await assert.rejects(kolab.raiseQuery(engineer, 'kj:orders#R8', 'q', { from: 'kj:orders-pg@1#nope' }), /does not resolve/);
});

test('an answer to an element the binding has since removed still reaches the asker, without a mark', async () => {
  const { kolab, product, engineer, draft } = await specAndBinding();
  await kolab.review(draft);
  const q = await kolab.raiseQuery(engineer, 'kj:orders#R8', 'Who can cancel?', { from: 'kj:orders-pg#b1' });
  await kolab.commit(engineer, 'orders-pg', { deltas: [{ kind: 'remove', element: 'b1' }] });
  await kolab.answerQuery(product, q, 'Office staff.');
  assert.deepEqual(await marksOn(kolab, 'orders-pg'), []);
  assert.equal((await kolab.listQueries({ raisedBy: 'bob' }))[0].state, 'answered');
});

test('a database from the previous release is migrated on open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-migrate-'));
  try {
    let kolab = await Kolab.open({ dataDir: dir });
    // Put the tables back the way 0.5 created them.
    await kolab.db.exec(`
      alter table query drop constraint query_kind_check;
      alter table query drop column selector, drop column kind, drop column from_version_id,
                        drop column from_element_id, drop column answered_by, drop column created_at;
      alter table invalidation drop constraint invalidation_reason_check;
      alter table invalidation add constraint invalidation_reason_check check (reason in
        ('changed','fuzzy_reanchor','orphaned','override_stale','override_orphaned',
         'upstream_dirty','review_failed','role_boundary'));`);
    await kolab.addActor('alice'); await kolab.addActor('bob');
    const product = await kolab.openSession('alice', 'product');
    await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
    await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
    await kolab.close();

    kolab = await Kolab.open({ dataDir: dir });
    const engineer = await kolab.openSession('bob', 'engineer');
    await kolab.createNode(engineer, 'technical_binding', 'B', 'b');
    await kolab.commit(engineer, 'b', { elements: els({ b1: 'Cancel endpoint.' }) });
    const q = await kolab.raiseQuery(engineer, 'kj:orders#R1~q({"exact":"cancelled"})', 'By whom?', { from: 'kj:b#b1' });
    await kolab.answerQuery(product, q, 'Office staff.');
    assert.deepEqual((await marksOn(kolab, 'b')).map((m) => m.reason), ['query_answered']);
    await kolab.close();
    // Opening again is a no-op.
    await (await Kolab.open({ dataDir: dir })).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- over MCP --------------------------------------------------------------------

const open: { close(): Promise<void> }[] = [];
after(async () => { for (const o of open.reverse()) await o.close().catch(() => undefined); });

test('over MCP: questions sit beside the spec element, and answers are pushed to the asker', async () => {
  const server = await startServer({ adminToken: 'admin' });
  open.push(server);
  const admin = await connect(server.url, 'admin');
  open.push(admin);
  const agent = async (actor: string, role: 'product' | 'engineer') => {
    await call(admin, 'admin_add_actor', { id: actor });
    const { token } = await call(admin, 'admin_open_session', { actor, role }) as { token: string };
    const c = await connect(server.url, token);
    open.push(c);
    return c;
  };
  const pm = await agent('pm', 'product');
  const eng = await agent('eng', 'engineer');

  assert.deepEqual((await call(eng, 'whoami') as { subscribe: string[] }).subscribe,
    ['konjir://inbox/technical', 'konjir://answers/eng']);

  // Each side watches its own inboxes.
  const pushed: { who: string; uri: string; body: { queries?: { kind: string; answer?: string | null }[]; marks?: unknown[] } }[] = [];
  const arrived = (n: number) => new Promise<void>((resolve) => {
    const t = setInterval(() => { if (pushed.length >= n) { clearInterval(t); resolve(); } }, 10);
  });
  const wPm = await watch(pm, (uri, body) => { pushed.push({ who: 'pm', uri, body: body as never }); });
  const wEng = await watch(eng, (uri, body) => { pushed.push({ who: 'eng', uri, body: body as never }); });
  open.push(wPm.subscription, wEng.subscription);

  await call(pm, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 1 });
  await call(eng, 'create_node', { kind: 'technical_binding', title: 'Orders on Postgres', id: 'orders-pg' });
  await call(eng, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'Cancel allowed from Open.' }] });

  // The engineer asks; product is told.
  pushed.length = 0;
  const { query } = await call(eng, 'ask', { address: 'kj:orders#R8', question: 'From which statuses?', from: 'kj:orders-pg@1#b1' }) as { query: string };
  await call(eng, 'annotate', { address: 'kj:orders#R8', note: 'Assuming office staff means the Office role.' });
  await arrived(2);
  assert.ok(pushed.every((p) => p.who === 'pm' && p.uri === 'konjir://inbox/functional'));
  assert.deepEqual(pushed.at(-1)!.body.queries!.map((q) => q.kind), ['question', 'note']);

  // The spec moves on to v2; the question still shows beside R8.
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order that is not yet completed.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 2 });
  const read = await call(pm, 'read_node', { node: 'orders' }) as { version: number; elements: { id: string; questions?: { id: string; on: string; kind: string; from: string | null }[] }[] };
  assert.equal(read.version, 2);
  assert.deepEqual(read.elements[0].questions!.map((q) => [q.id, q.kind, q.on, q.from]), [
    [query, 'question', 'kj:orders@1#R8', 'kj:orders-pg@1#b1'],
    [read.elements[0].questions![1].id, 'note', 'kj:orders@1#R8', null],
  ]);

  // Product answers; the engineer hears it on both inboxes.
  pushed.length = 0;
  await call(pm, 'answer_query', { query, answer: 'Any status before Completed.' });
  await arrived(3);
  const engHeard = new Set(pushed.filter((p) => p.who === 'eng').map((p) => p.uri));
  assert.deepEqual(engHeard, new Set(['konjir://inbox/technical', 'konjir://answers/eng']));
  const answers = pushed.find((p) => p.uri === 'konjir://answers/eng')!.body.queries!;
  assert.equal(answers.find((q) => q.kind === 'question')!.answer, 'Any status before Completed.');

  // Nobody reads someone else's answers.
  await assert.rejects(pm.readResource({ uri: 'konjir://answers/eng' }), /your own answers/);
});
