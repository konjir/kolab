// Messages between a kolab's members (migration 0050): a person or an agent sends plain words to
// another member, naming no element and no layer. Only the two of them read it; it reaches its
// recipient through their answers, which is signalled as it arrives, and waits unread until they
// read it. A reply names the message it answers. Messages stay in their kolab, go only between
// members (reading a public kolab makes no one a member), have a rate budget of their own, are
// never edited or removed, and touch nothing else: no question, mark, review or work.
import { expect, test } from '@jest/globals';
import { MAX_MESSAGES_PER_HOUR, MAX_ORG_MESSAGES_PER_HOUR, MAX_TEXT, MESSAGES_AT_ONCE, isInboxEvent, type KolabEvent } from '@konjir/types';
import { openKolab, rejection, TestKolab } from '@konjir/engine/testing';

/**
 * Ann owns `hub`, a kolab with no spec, binding or work in it. Bo writes there. Each has an agent
 * of their own with access, and Sam has none. Everyone but Sam has a session open in it.
 */
async function hub(kolab?: TestKolab) {
  const k = kolab ?? await openKolab();
  for (const id of ['ann', 'bo', 'sam']) await k.addActor(id);
  await k.addActor('ann-claude', { owner: 'ann' });
  await k.addActor('bo-claude', { owner: 'bo' });
  await k.createKolab('hub', { owner: 'ann' });
  await k.grant('hub', 'bo', 'write');
  await k.grant('hub', 'ann-claude', 'write');
  await k.grant('hub', 'bo-claude', 'write');
  const ann = await k.openSession('ann', 'product', { kolab: 'hub' });
  const bo = await k.openSession('bo', 'engineer', { kolab: 'hub' });
  const annAgent = await k.openSession('ann-claude', 'product', { kolab: 'hub' });
  const boAgent = await k.openSession('bo-claude', 'engineer', { kolab: 'hub' });
  const events: KolabEvent[] = [];
  k.onEvent((e) => { if (isInboxEvent(e)) events.push(e); });
  return { kolab: k, ann, bo, annAgent, boAgent, events };
}

test('an agent sends a message to another owner\'s agent in a kolab with no spec or work; it waits unread in their answers, is signalled, and a reply comes back', async () => {
  const { kolab, annAgent, boAgent, bo, events } = await hub();
  const sent = await kolab.sendMessage(annAgent, 'bo-claude', 'Are you taking the importer? I have the exporter.');
  expect(sent).toStrictEqual({ id: sent.id, from: 'ann-claude', to: 'bo-claude', message: 'Are you taking the importer? I have the exporter.', reply_to: null, sent_at: sent.sent_at, read_at: null });
  // Only the recipient's answers are signalled: no layer's inbox, and not the sender's.
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'hub', actor: 'bo-claude' }]);

  // It waits unread; looking at the answers marks nothing.
  expect(await kolab.unreadMessages(boAgent)).toStrictEqual({ unread: 1, items: [sent] });
  expect(await kolab.unreadMessages(boAgent)).toStrictEqual({ unread: 1, items: [sent] });
  // No one else reads it: not the sender as its own, not the recipient's owner.
  expect(await kolab.unreadMessages(annAgent)).toStrictEqual({ unread: 0, items: [] });
  expect(await kolab.unreadMessages(bo)).toStrictEqual({ unread: 0, items: [] });
  expect((await kolab.messagesPage(bo)).items).toStrictEqual([]);

  // Reading marks it read, once.
  const read = await kolab.readMessages(boAgent);
  expect(read.more).toBe(0);
  expect(read.messages).toStrictEqual([{ ...sent, read_at: read.messages[0].read_at }]);
  expect(read.messages[0].read_at).not.toBeNull();
  expect(await kolab.readMessages(boAgent)).toStrictEqual({ messages: [], more: 0 });
  expect(await kolab.unreadMessages(boAgent)).toStrictEqual({ unread: 0, items: [] });

  // The reply names what it answers, and reaches the first sender the same way.
  events.length = 0;
  const reply = await kolab.sendMessage(boAgent, 'ann-claude', 'Yes, the importer is mine.', { replyTo: sent.id });
  expect(reply).toMatchObject({ from: 'bo-claude', to: 'ann-claude', reply_to: sent.id, read_at: null });
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'hub', actor: 'ann-claude' }]);
  expect((await kolab.unreadMessages(annAgent)).items).toStrictEqual([reply]);

  // Each side lists the exchange, newest first; the sender sees when theirs was read.
  const exchange = (await kolab.messagesPage(annAgent, { with: 'bo-claude' })).items;
  expect(exchange.map((m) => [m.id, m.from])).toStrictEqual([[reply.id, 'bo-claude'], [sent.id, 'ann-claude']]);
  expect(exchange[1].read_at).toBe(read.messages[0].read_at);
  expect((await kolab.messagesPage(annAgent, { sent: true })).items.map((m) => m.id)).toStrictEqual([sent.id]);
  expect((await kolab.messagesPage(annAgent)).items.map((m) => m.id)).toStrictEqual([reply.id]);
  expect((await kolab.messagesPage(annAgent, { with: 'bo-claude', sent: false })).items.map((m) => m.id)).toStrictEqual([reply.id]);

  // Nothing else was written: no question, no mark, no work.
  for (const table of ['query', 'invalidation', 'work_package', 'review_request']) {
    expect((await kolab.db.query(`select 1 from ${table}`)).rows).toStrictEqual([]);
  }
});

test('a person and an agent message each other, and a message to someone with no session open waits for them', async () => {
  const { kolab, ann, boAgent } = await hub();
  await kolab.endSession(boAgent);
  const sent = await kolab.sendMessage(ann, 'bo-claude', 'Start with the migration when you are back.');
  const back = await kolab.openSession('bo-claude', 'engineer', { kolab: 'hub' });
  expect(await kolab.unreadMessages(back)).toStrictEqual({ unread: 1, items: [sent] });
  await kolab.sendMessage(back, 'ann', 'Starting now.', { replyTo: sent.id });
  expect((await kolab.readMessages(ann)).messages.map((m) => [m.from, m.message, m.reply_to])).toStrictEqual([['bo-claude', 'Starting now.', sent.id]]);
});

test('members are listed by name for any member, with who is here now, and never what each holds', async () => {
  const { kolab, ann, boAgent, annAgent } = await hub();
  await kolab.endSession(annAgent);
  expect(await kolab.membersPage(boAgent)).toStrictEqual({
    kolab: 'hub', next: null,
    items: [
      { actor: 'ann', kind: 'person', owner: null, here: true },
      { actor: 'ann-claude', kind: 'agent', owner: 'ann', here: false },
      { actor: 'bo', kind: 'person', owner: null, here: true },
      { actor: 'bo-claude', kind: 'agent', owner: 'bo', here: true, you: true },
    ],
  });
  // A page at a time, by name; a cursor from another list is refused.
  const first = await kolab.membersPage(ann, { limit: 3 });
  expect(first.items.map((m) => m.actor)).toStrictEqual(['ann', 'ann-claude', 'bo']);
  expect((await kolab.membersPage(ann, { limit: 3, cursor: first.next })).items.map((m) => m.actor)).toStrictEqual(['bo-claude']);
  await kolab.sendMessage(ann, 'bo', 'one');
  await kolab.sendMessage(ann, 'bo', 'two');
  const page = await kolab.messagesPage(ann, { sent: true }, { limit: 1 });
  expect(await rejection(kolab.membersPage(ann, { cursor: page.next }))).toMatch(/LimitError: invalid cursor/);
  expect((await kolab.messagesPage(ann, { sent: true }, { limit: 1, cursor: page.next })).items.map((m) => m.message)).toStrictEqual(['one']);
  expect(await rejection(kolab.messagesPage(ann, {}, { cursor: page.next }))).toMatch(/LimitError: invalid cursor/);
});

test('a message goes only to another member, in the sender\'s own kolab; the refusal is the same whether or not the name exists', async () => {
  const { kolab, ann, annAgent, events } = await hub();
  const count = async () => (await kolab.db.query(`select 1 from message`)).rows.length;
  expect(await rejection(kolab.sendMessage(annAgent, 'sam', 'hello'))).toMatch(/AccessError: sam is not a member of kolab hub, so no message can go to them: konjir_list_members lists who is/);
  expect(await rejection(kolab.sendMessage(annAgent, 'nobody', 'hello'))).toMatch(/AccessError: nobody is not a member of kolab hub, so no message can go to them/);
  expect(await rejection(kolab.sendMessage(annAgent, 'ann-claude', 'hello'))).toMatch(/LimitError: ann-claude is you/);
  expect(await rejection(kolab.sendMessage(annAgent, 'bo', '   '))).toMatch(/LimitError: a message needs some words/);
  expect(await rejection(kolab.sendMessage(annAgent, 'bo', 'x'.repeat(MAX_TEXT + 1)))).toMatch(new RegExp(`LimitError: the message is ${(MAX_TEXT + 1).toLocaleString('en')} characters; the limit is ${MAX_TEXT.toLocaleString('en')}`));

  // Another kolab is another room: its members aren't this one's, and its messages aren't read here.
  await kolab.createKolab('other', { owner: 'sam' });
  const sam = await kolab.openSession('sam', 'product', { kolab: 'other' });
  expect(await rejection(kolab.sendMessage(sam, 'ann', 'hello'))).toMatch(/AccessError: ann is not a member of kolab other/);
  await kolab.grant('other', 'ann', 'read');
  await kolab.endSession(ann);
  const annThere = await kolab.openSession('ann', 'product', { kolab: 'other' });
  const there = await kolab.sendMessage(sam, 'ann', 'hello from other');
  expect((await kolab.unreadMessages(annThere)).unread).toBe(1);
  await kolab.endSession(annThere);
  const annHere = await kolab.openSession('ann', 'product', { kolab: 'hub' });
  expect(await kolab.unreadMessages(annHere)).toStrictEqual({ unread: 0, items: [] });
  // A reply names a message between the same two members, in the same kolab.
  expect(await rejection(kolab.sendMessage(annHere, 'bo', 'hi', { replyTo: there.id }))).toMatch(/LimitError: reply_to names no message between you and bo in kolab hub/);
  expect(await rejection(kolab.sendMessage(annHere, 'bo', 'hi', { replyTo: 'nope' }))).toMatch(/LimitError: reply_to names no message between you and bo/);
  expect(await count()).toBe(1);
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'other', actor: 'ann' }]);

  // Someone who lost their access is no member any more: nothing goes to them.
  await kolab.revoke('hub', 'bo-claude');
  expect(await rejection(kolab.sendMessage(annAgent, 'bo-claude', 'still there?'))).toMatch(/AccessError: bo-claude is not a member of kolab hub/);
  expect(await count()).toBe(1);
});

test('reading a public kolab makes no one a member: a reader sends nothing, receives nothing and lists no members', async () => {
  const kolab = await openKolab();
  for (const id of ['ann', 'sam']) await kolab.addActor(id);
  await kolab.createKolab('open', { owner: 'ann', visibility: 'public' });
  const ann = await kolab.openSession('ann', 'product', { kolab: 'open' });
  const sam = await kolab.openSession('sam', 'product', { kolab: 'open' });
  expect(await rejection(kolab.sendMessage(sam, 'ann', 'hello'))).toMatch(/AccessError: sam is not a member of kolab open: messages go between those who hold access there/);
  expect(await rejection(kolab.membersPage(sam))).toMatch(/AccessError: sam is not a member of kolab open/);
  expect(await rejection(kolab.sendMessage(ann, 'sam', 'hello'))).toMatch(/AccessError: sam is not a member of kolab open, so no message can go to them/);
  expect((await kolab.membersPage(ann)).items.map((m) => m.actor)).toStrictEqual(['ann']);
});

test('messages have an hourly budget of their own, shared by a person and their agents; a refused one is not written and spends nothing of the questions\' budget', async () => {
  const { kolab, ann, annAgent, bo } = await hub();
  expect([kolab.rates.messages, kolab.rates.orgMessages]).toStrictEqual([MAX_MESSAGES_PER_HOUR, MAX_ORG_MESSAGES_PER_HOUR]);
  expect(MAX_ORG_MESSAGES_PER_HOUR).toBe(5 * MAX_MESSAGES_PER_HOUR);
  Object.assign(kolab.rates, { messages: 3, asks: 1 });
  await kolab.sendMessage(ann, 'bo', 'one');
  await kolab.sendMessage(annAgent, 'bo', 'two');
  // A refused message costs nothing.
  expect(await rejection(kolab.sendMessage(ann, 'sam', 'no'))).toMatch(/not a member/);
  await kolab.sendMessage(annAgent, 'bo', 'three');
  expect(await rejection(kolab.sendMessage(ann, 'bo', 'four'))).toMatch(/LimitError: ann and ann's agents sent 3 messages in the last hour; the limit is 3 in an hour, shared by a person and their agents\. Wait \d+ minutes? before sending again, or put several points in one message/);
  expect(await rejection(kolab.sendMessage(annAgent, 'bo', 'four'))).toMatch(/LimitError: ann-claude, with the rest of ann's agents and ann, sent 3 messages/);
  expect((await kolab.db.query(`select 1 from message`)).rows.length).toBe(3);
  // Bo's budget is his own, and the questions' budget is untouched.
  await kolab.sendMessage(bo, 'ann', 'received all three');
  expect((await kolab.db.query<{ kind: string; n: number }>(`select kind, count(*)::int as n from rate_event group by kind order by kind`)).rows).toStrictEqual([{ kind: 'message', n: 4 }]);
});

test('unread messages are read oldest first, a batch at a time, and the answers say how many wait in all', async () => {
  const { kolab, ann, bo, events } = await hub();
  const n = MESSAGES_AT_ONCE + 3;
  for (let i = 1; i <= n; i++) await kolab.sendMessage(ann, 'bo', `message ${i}`);
  const waiting = await kolab.unreadMessages(bo);
  expect(waiting.unread).toBe(n);
  expect(waiting.items.map((m) => m.message)).toStrictEqual(Array.from({ length: MESSAGES_AT_ONCE }, (_, i) => `message ${i + 1}`));
  events.length = 0;
  const few = await kolab.readMessages(bo, { limit: 2 });
  expect(few.messages.map((m) => m.message)).toStrictEqual(['message 1', 'message 2']);
  expect(few.more).toBe(n - 2);
  // Bo's other sessions hear that fewer are unread.
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'hub', actor: 'bo' }]);
  const batch = await kolab.readMessages(bo);
  expect(batch.messages.length).toBe(MESSAGES_AT_ONCE);
  expect(batch.messages[0].message).toBe('message 3');
  expect(batch.more).toBe(1);
  expect(await rejection(kolab.readMessages(bo, { limit: 0 }))).toMatch(/LimitError: limit is a whole number/);
  expect((await kolab.readMessages(bo, { limit: 500 })).messages.map((m) => m.message)).toStrictEqual([`message ${n}`]);
});

test('a message and its receipt are never edited or removed, no session\'s role reads them, and an archived kolab takes none', async () => {
  const { kolab, ann, bo } = await hub();
  const sent = await kolab.sendMessage(ann, 'bo', 'keep this');
  await kolab.readMessages(bo);
  for (const sql of [`update message set body = 'changed'`, `delete from message`, `truncate message cascade`, `update message_receipt set read_at = now()`, `delete from message_receipt`]) {
    expect(await rejection(kolab.db.query(sql))).toMatch(/never edited or removed/);
  }
  // Other tables give a session's role its whole kolab to read; a message is its two members' alone.
  for (const table of ['message', 'message_receipt']) {
    expect(await rejection(kolab.readAs(bo, (q) => q.query(`select 1 from ${table}`)))).toMatch(/permission denied/);
  }
  const waiting = await kolab.sendMessage(ann, 'bo', 'unread when archived');
  await kolab.archive({ kolab: 'hub' });
  expect(await rejection(kolab.db.query(`insert into message(id, kolab_id, sent_by, sent_to, body) values ('m2', 'hub', 'ann', 'bo', 'late')`))).toMatch(/archived/);
  expect((await kolab.db.query<{ id: string }>(`select id from message order by id`)).rows.map((r) => r.id)).toStrictEqual([sent.id, waiting.id]);
});
