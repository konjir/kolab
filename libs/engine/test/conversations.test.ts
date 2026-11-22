// A member's direct conversations (konnect's app, S3): one row per member they have exchanged a
// message with, either way, with the newest message between them, their unread count (capped at
// UNREAD_COUNT_CEILING) and when it was sent, the most recent first, a page at a time. Only the
// caller's own, found through migration 0057's indexes a member at a time.
import { expect, test } from '@jest/globals';
import { UNREAD_COUNT_CEILING } from '@konjir/types';
import { openKolab, rejection } from '@konjir/engine/testing';

async function hub() {
  const k = await openKolab();
  for (const id of ['ann', 'bo', 'cy', 'sam']) await k.addActor(id);
  await k.addActor('bo-claude', { owner: 'bo' });
  await k.createKolab('hub', { owner: 'ann' });
  for (const id of ['bo', 'cy', 'bo-claude']) await k.grant('hub', id, 'write');
  const s = {
    ann: await k.openSession('ann', 'product', { kolab: 'hub' }),
    bo: await k.openSession('bo', 'engineer', { kolab: 'hub' }),
    cy: await k.openSession('cy', 'engineer', { kolab: 'hub' }),
    agent: await k.openSession('bo-claude', 'engineer', { kolab: 'hub' }),
  };
  return { kolab: k, ...s };
}

test('one row per member talked with, either way, newest first, each with the newest message, the unread from them and when', async () => {
  const { kolab, ann, bo, cy, agent } = await hub();
  expect(await kolab.conversationsPage(ann)).toStrictEqual({ items: [], next: null });
  const toBo = await kolab.sendMessage(ann, 'bo', 'hi bo');
  const fromCy1 = await kolab.sendMessage(cy, 'ann', 'hi ann');
  const fromCy2 = await kolab.sendMessage(cy, 'ann', 'are you there?');
  const fromAgent = await kolab.sendMessage(agent, 'ann', 'bo asked me to ask');
  // Between others: never Ann's.
  await kolab.sendMessage(bo, 'cy', 'not for ann');
  // Channel messages are no conversation.
  await kolab.sendChannelMessage(bo, 'general', 'room');

  const page = await kolab.conversationsPage(ann);
  expect(page.next).toBeNull();
  expect(page.items).toStrictEqual([
    // Bo reads his agent's conversations, and it says so (Lee, 2026-11-22).
    { with: 'bo-claude', last: fromAgent, unread: 1, unread_more: false, last_at: fromAgent.sent_at, readable_by: ['bo'] },
    { with: 'cy', last: fromCy2, unread: 2, unread_more: false, last_at: fromCy2.sent_at },
    { with: 'bo', last: toBo, unread: 0, unread_more: false, last_at: toBo.sent_at },
  ]);

  // A reply moves that conversation to the top; reading changes the count, and the last message's read_at.
  const reply = await kolab.sendMessage(bo, 'ann', 'hi ann');
  await kolab.markMessagesRead(ann, 'cy', fromCy1.id);
  const after = (await kolab.conversationsPage(ann)).items;
  expect(after.map((c) => [c.with, c.last.id, c.unread])).toStrictEqual([['bo', reply.id, 1], ['bo-claude', fromAgent.id, 1], ['cy', fromCy2.id, 1]]);
  await kolab.readMessages(ann, { from: 'cy' });
  expect((await kolab.conversationsPage(ann)).items[2]).toMatchObject({ with: 'cy', unread: 0, last: { id: fromCy2.id, read_at: expect.any(String) } });

  // Each side sees its own: Bo's has Ann (her hello unread) and Cy, Cy's has Ann and Bo; the agent's has Ann alone.
  expect((await kolab.conversationsPage(bo)).items.map((c) => [c.with, c.unread])).toStrictEqual([['ann', 1], ['cy', 0]]);
  expect((await kolab.conversationsPage(cy)).items.map((c) => [c.with, c.unread])).toStrictEqual([['bo', 1], ['ann', 0]]);
  expect((await kolab.conversationsPage(agent)).items.map((c) => c.with)).toStrictEqual(['ann']);
});

test('pages by the newest message, at most limit at a time, with a cursor bound to the caller', async () => {
  const { kolab, ann, bo } = await hub();
  const others = Array.from({ length: 7 }, (_, i) => `p${i}`);
  for (const id of others) {
    await kolab.addActor(id);
    await kolab.grant('hub', id, 'read');
  }
  for (const id of others) await kolab.sendMessage(ann, id, `hello ${id}`);
  const seen: string[] = [];
  let cursor: string | null | undefined;
  do {
    const p = await kolab.conversationsPage(ann, { limit: 3, cursor });
    expect(p.items.length).toBeLessThanOrEqual(3);
    seen.push(...p.items.map((c) => c.with));
    cursor = p.next;
  } while (cursor);
  expect(seen).toStrictEqual([...others].reverse());
  // Another caller's cursor, or a made-up one, is refused.
  const first = await kolab.conversationsPage(ann, { limit: 3 });
  expect(await rejection(kolab.conversationsPage(bo, { cursor: first.next }))).toMatch(/invalid cursor/);
  expect(await rejection(kolab.conversationsPage(ann, { cursor: 'nope' }))).toMatch(/invalid cursor/);
});

test('the unread count stops at the ceiling and says there are more', async () => {
  const { kolab, ann, bo } = await hub();
  // Written straight in, as many as the ceiling and one more: the budget is not what is tested here.
  await kolab.db.query(
    `insert into message(id, kolab_id, sent_by, sent_to, body)
     select '01J' || lpad(g::text, 23, '0'), 'hub', 'bo', 'ann', 'x' from generate_series(1, $1::int) g`, [UNREAD_COUNT_CEILING + 1]);
  expect((await kolab.conversationsPage(ann)).items).toMatchObject([{ with: 'bo', unread: UNREAD_COUNT_CEILING, unread_more: true }]);
  expect((await kolab.conversationsPage(bo)).items).toMatchObject([{ with: 'ann', unread: 0, unread_more: false }]);
});

test('the members talked with are found through the indexes, not by reading every message', async () => {
  const { kolab } = await hub();
  const plan = (await kolab.db.query<{ 'QUERY PLAN': string }>(
    `explain select sent_by from message where kolab_id = 'hub' and sent_to = 'ann' and sent_by > 'bo' order by sent_by limit 1`)).rows.map((r) => r['QUERY PLAN']).join('\n');
  expect(plan).toMatch(/message_to_from|message_from_to|Index/);
});

test('a conversation\'s unread reads at most twice the ceiling of their newest messages, however long it is: a long one read through has none and no more, a long unread one says there are more', async () => {
  const { kolab, ann, bo } = await hub();
  const many = (from: string, n: number, prefix: string) => kolab.db.query(
    `insert into message(id, kolab_id, sent_by, sent_to, body) select '01J' || $3 || lpad(g::text, 22, '0'), 'hub', $1, 'ann', 'x' from generate_series(1, $2::int) g`,
    [from, n, prefix]);
  // Bo: 2,100 messages, every one read, then one new.
  await many('bo', 2 * UNREAD_COUNT_CEILING + 100, 'A');
  await kolab.db.query(`insert into message_receipt(message_id, kolab_id, actor_id) select id, kolab_id, sent_to from message where sent_by = 'bo'`);
  await kolab.sendMessage(bo, 'ann', 'one new');
  // Cy: 2,100, none read.
  await many('cy', 2 * UNREAD_COUNT_CEILING + 100, 'B');
  const rows = Object.fromEntries((await kolab.conversationsPage(ann)).items.map((c) => [c.with, [c.unread, c.unread_more]]));
  expect(rows.cy).toStrictEqual([UNREAD_COUNT_CEILING, true]);
  expect(rows.bo).toStrictEqual([1, false]);
});
