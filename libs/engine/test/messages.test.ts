// Messages between a kolab's members (migration 0050): a person or an agent sends plain words to
// another member, naming no element and no layer. Only the two of them read it; it reaches its
// recipient through their answers, which is signalled as it arrives, and waits unread until they
// read it. A reply names the message it answers. Messages stay in their kolab, go only between
// members (reading a public kolab makes no one a member), have a rate budget of their own, are
// never edited or removed, and touch nothing else: no question, mark, review or work.
import { expect, test } from '@jest/globals';
import { MAX_MESSAGES_PER_HOUR, MAX_ORG_MESSAGES_PER_HOUR, MAX_MESSAGE_TEXT, MESSAGES_AT_ONCE, isInboxEvent, type KolabEvent } from '@konjir/types';
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
  // Each agent's owner reads it, and the result says so (Lee, 2026-11-22).
  expect(sent).toStrictEqual({ id: sent.id, from: 'ann-claude', to: 'bo-claude', message: 'Are you taking the importer? I have the exporter.', reply_to: null, sent_at: sent.sent_at, read_at: null, readable_by: ['ann', 'bo'] });
  // The recipient's answers are signalled, and each agent's owner's, unchanged: no layer's inbox, and not the sender's.
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'hub', actor: 'bo-claude' }, { inbox: 'actor', kolab: 'hub', actor: 'ann' }, { inbox: 'actor', kolab: 'hub', actor: 'bo' }]);

  // It waits unread; looking at the answers marks nothing.
  expect(await kolab.unreadMessages(boAgent)).toStrictEqual({ unread: 1, items: [sent] });
  expect(await kolab.unreadMessages(boAgent)).toStrictEqual({ unread: 1, items: [sent] });
  // It is no one else's own: not the sender's unread, not the recipient's owner's (who reads it with konjir_list_agent_messages).
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
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'hub', actor: 'ann-claude' }, { inbox: 'actor', kolab: 'hub', actor: 'bo' }, { inbox: 'actor', kolab: 'hub', actor: 'ann' }]);
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

test('a direct conversation\'s history: the messages between two members, both ways, newest first, at most limit, marking nothing; no third member, no agent\'s owner sees any of it', async () => {
  const { kolab, ann, bo, annAgent, boAgent } = await hub();
  await kolab.grant('hub', 'sam', 'read');
  const sam = await kolab.openSession('sam', 'product', { kolab: 'hub' });
  const one = await kolab.sendMessage(annAgent, 'bo-claude', 'one');
  const two = await kolab.sendMessage(boAgent, 'ann-claude', 'two', { replyTo: one.id });
  const three = await kolab.sendMessage(annAgent, 'bo-claude', 'three');
  const theirs = [one.id, two.id, three.id];
  // Others' messages are no part of it.
  await kolab.sendMessage(ann, 'bo-claude', 'from ann');
  await kolab.sendMessage(sam, 'ann-claude', 'from sam');

  // Either party, naming the other by name or as <owner>/<label>, sees the same three, newest first.
  const mine = (await kolab.messagesPage(annAgent, { with: 'bo/claude' })).items;
  expect(mine.map((m) => m.message)).toStrictEqual(['three', 'two', 'one']);
  expect(mine.map((m) => [m.from, m.to])).toStrictEqual([['ann-claude', 'bo-claude'], ['bo-claude', 'ann-claude'], ['ann-claude', 'bo-claude']]);
  expect((await kolab.messagesPage(boAgent, { with: 'ann-claude' })).items.map((m) => m.id)).toStrictEqual([three.id, two.id, one.id]);
  expect((await kolab.messagesPage(boAgent, { with: '@ann/claude' }, { limit: 2 })).items.map((m) => m.id)).toStrictEqual([three.id, two.id]);
  // It marked nothing read.
  expect((await kolab.unreadMessages(boAgent)).items.map((m) => m.message)).toStrictEqual(['one', 'three', 'from ann']);
  expect((await kolab.unreadMessages(annAgent)).items.map((m) => m.message)).toStrictEqual(['two', 'from sam']);

  // A third member, and each agent's owner, see nothing of it, however they name the two.
  for (const [who, other] of [[sam, 'ann-claude'], [sam, 'bo-claude'], [ann, 'bo-claude'], [ann, 'ann-claude'], [bo, 'ann-claude'], [bo, 'bo/claude']] as const) {
    expect([other, (await kolab.messagesPage(who, { with: other })).items.filter((m) => theirs.includes(m.id))]).toStrictEqual([other, []]);
  }
  for (const who of [sam, ann, bo]) {
    for (const filter of [{}, { sent: true }]) {
      expect((await kolab.messagesPage(who, filter)).items.some((m) => theirs.includes(m.id))).toBe(false);
    }
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

test('each member\'s login is the GitHub username behind them, as they last signed in: a person\'s own, an agent\'s owner\'s, whatever its actor id; null without a GitHub identity', async () => {
  const { kolab, ann, bo } = await hub();
  // Signed up from GitHub: Ann-H, which reads as an agent of Ann's, as gh_ann-h; Admin, a reserved name, as gh_admin; another ann as ann_2.
  const annH = (await kolab.signInWith({ provider: 'github', subject: '101', login: 'Ann-H' })).actor;
  const admin = (await kolab.signInWith({ provider: 'github', subject: '102', login: 'Admin' })).actor;
  const ann2 = (await kolab.signInWith({ provider: 'github', subject: '103', login: 'ann' })).actor;
  expect([annH, admin, ann2]).toStrictEqual(['gh_ann-h', 'gh_admin', 'ann_2']);
  // Bo links his account an admin made: his login is GitHub's, not his actor id.
  await kolab.linkIdentity('bo', { provider: 'github', subject: '104', login: 'BoGH' }, { by: 'admin' });
  // A login that isn't GitHub's is no one's `login`.
  await kolab.linkIdentity('ann', { provider: 'stub', subject: 'ann', login: 'ann-at-stub' }, { by: 'admin' });
  for (const id of [annH, admin, ann2]) await kolab.grant('hub', id, 'read');
  // gh_admin's agent carries its owner's login.
  await kolab.addActor('gh_admin-bot', { owner: 'gh_admin' });
  await kolab.grant('hub', 'gh_admin-bot', 'read');
  const logins = Object.fromEntries((await kolab.membersPage(ann)).items.map((m) => [m.actor, m.login]));
  expect(logins).toStrictEqual({ ann: null, 'ann-claude': null, ann_2: 'ann', 'gh_ann-h': 'Ann-H', bo: 'BoGH', 'bo-claude': 'BoGH', gh_admin: 'Admin', 'gh_admin-bot': 'Admin' });
  // And the account's numeric id beside each, which never changes hands as a login can.
  const ids = Object.fromEntries((await kolab.membersPage(ann)).items.map((m) => [m.actor, m.github_id]));
  expect(ids).toStrictEqual({ ann: null, 'ann-claude': null, ann_2: '103', 'gh_ann-h': '101', bo: '104', 'bo-claude': '104', gh_admin: '102', 'gh_admin-bot': '102' });
  // Signing in again with a renamed account updates it.
  await kolab.signInWith({ provider: 'github', subject: '104', login: 'Bo-Renamed' });
  expect((await kolab.membersPage(bo)).items.find((m) => m.actor === 'bo')).toMatchObject({ login: 'Bo-Renamed', you: true });
});

test('members are listed by name for any member, with who is here now, and never what each holds', async () => {
  const { kolab, ann, boAgent, annAgent } = await hub();
  await kolab.endSession(annAgent);
  expect(await kolab.membersPage(boAgent)).toStrictEqual({
    kolab: 'hub', next: null,
    items: [
      { actor: 'ann', kind: 'person', owner: null, login: null, github_id: null, here: true },
      { actor: 'ann-claude', kind: 'agent', owner: 'ann', label: 'claude', login: null, github_id: null, here: false, owner_reads: true },
      { actor: 'bo', kind: 'person', owner: null, login: null, github_id: null, here: true },
      { actor: 'bo-claude', kind: 'agent', owner: 'bo', label: 'claude', login: null, github_id: null, here: true, owner_reads: true, you: true },
    ],
  });
  // An agent's label is its own field, so it can be named <owner>/<label>; one named otherwise has none.
  await kolab.addActor('helper', { owner: 'bo' });
  await kolab.grant('hub', 'helper', 'write');
  expect((await kolab.membersPage(ann)).items.find((m) => m.actor === 'helper')).toStrictEqual({ actor: 'helper', kind: 'agent', owner: 'bo', label: null, login: null, github_id: null, here: false, owner_reads: true });
  // A page at a time, by name; a cursor from another list is refused.
  const first = await kolab.membersPage(ann, { limit: 3 });
  expect(first.items.map((m) => m.actor)).toStrictEqual(['ann', 'ann-claude', 'bo']);
  expect((await kolab.membersPage(ann, { limit: 3, cursor: first.next })).items.map((m) => m.actor)).toStrictEqual(['bo-claude', 'helper']);
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
  expect(await rejection(kolab.sendMessage(annAgent, 'bo', 'x'.repeat(MAX_MESSAGE_TEXT + 1)))).toMatch(new RegExp(`LimitError: the message is ${(MAX_MESSAGE_TEXT + 1).toLocaleString('en')} characters; the limit is ${MAX_MESSAGE_TEXT.toLocaleString('en')}`));

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

test('a send repeated with its nonce returns the message it sent, once, for a direct message and a channel message alike; another message with that nonce is refused, and a bad nonce too', async () => {
  const { kolab, ann, bo, events } = await hub();
  const first = await kolab.sendMessage(ann, 'bo', 'Lunch at noon?', { nonce: 'a1b2-c3' });
  events.length = 0;
  // The app's Retry, its answer lost: the same message, nothing sent, signalled or spent again.
  expect(await kolab.sendMessage(ann, 'bo', 'Lunch at noon?', { nonce: 'a1b2-c3' })).toStrictEqual(first);
  // Two at once, as a retry racing the send it repeats: one message.
  const [x, y] = await Promise.all([1, 2].map(() => kolab.sendMessage(ann, 'bo', 'Coffee?', { nonce: 'n-2' })));
  expect(x.id).toBe(y.id);
  expect((await kolab.db.query<{ n: number }>(`select count(*)::int as n from message where sent_by = 'ann'`)).rows[0].n).toBe(2);
  expect(events.filter((e) => 'actor' in e && e.actor === 'bo').length).toBe(1);
  // To an agent, the repeat says who else reads it, as the first send did.
  const toAgent = await kolab.sendMessage(ann, 'bo-claude', 'For your agent', { nonce: 'agent-1' });
  expect(toAgent.readable_by).toStrictEqual(['bo']);
  expect(await kolab.sendMessage(ann, 'bo-claude', 'For your agent', { nonce: 'agent-1' })).toStrictEqual(toAgent);
  // The same nonce on another message, to someone else or in other words, is refused; another sender's own nonce is theirs.
  expect(await rejection(kolab.sendMessage(ann, 'bo', 'Dinner?', { nonce: 'a1b2-c3' }))).toMatch(/LimitError: nonce a1b2-c3 names another message you sent in kolab hub/);
  expect(await rejection(kolab.sendMessage(ann, 'bo-claude', 'Lunch at noon?', { nonce: 'a1b2-c3' }))).toMatch(/nonce a1b2-c3 names another message/);
  expect((await kolab.sendMessage(bo, 'ann', 'Lunch at noon?', { nonce: 'a1b2-c3' })).from).toBe('bo');
  for (const bad of ['', 'has space', 'x'.repeat(101), 'é']) {
    expect([bad, await rejection(kolab.sendMessage(ann, 'bo', 'hi', { nonce: bad }))]).toStrictEqual([bad, expect.stringMatching(/nonce is your own id for this send/)]);
  }
  // A channel message, the same way.
  const c = await kolab.sendChannelMessage(ann, 'general', 'Standup in 5', { nonce: 'c-1', mentions: ['bo'] });
  expect(await kolab.sendChannelMessage(ann, '#general', 'Standup in 5', { nonce: 'c-1', mentions: ['bo'] })).toStrictEqual(c);
  expect((await kolab.db.query<{ n: number }>(`select count(*)::int as n from channel_message where sent_by = 'ann'`)).rows[0].n).toBe(1);
  expect(await rejection(kolab.sendChannelMessage(ann, 'general', 'Standup in 10', { nonce: 'c-1' }))).toMatch(/nonce c-1 names another message/);
  // No nonce, no idempotence: each send is its own.
  expect((await kolab.sendMessage(ann, 'bo', 'again')).id).not.toBe((await kolab.sendMessage(ann, 'bo', 'again')).id);
});

test('the same nonce sent at once to two conversations, or two channels, sends one message and refuses the other as naming it, never a raw duplicate-key error', async () => {
  const { kolab, ann } = await hub();
  await kolab.makeChannel(ann, 'deploys');
  // At once, each under its own conversation's or channel's lock: on Postgres both may pass the repeat check.
  const dms = await Promise.allSettled([kolab.sendMessage(ann, 'bo', 'Lunch?', { nonce: 'race-1' }), kolab.sendMessage(ann, 'bo-claude', 'Lunch?', { nonce: 'race-1' })]);
  const chans = await Promise.allSettled([kolab.sendChannelMessage(ann, 'general', 'Ship it', { nonce: 'race-2' }), kolab.sendChannelMessage(ann, 'deploys', 'Ship it', { nonce: 'race-2' })]);
  for (const r of [dms, chans]) {
    expect(r.filter((x) => x.status === 'fulfilled').length).toBe(1);
    const refused = r.find((x): x is PromiseRejectedResult => x.status === 'rejected')!;
    expect(String(refused.reason)).toMatch(/LimitError: nonce race-\d names another message you sent in kolab hub/);
  }
  // The index's refusal itself, made certain: the checks before and under the lock see nothing (as a
  // send racing under another lock would), so the insert meets the earlier message's nonce. Then the
  // check runs again: the earlier message when it is this one, the LimitError when it is another.
  const transaction = kolab.db.transaction.bind(kolab.db);
  const query = kolab.db.query.bind(kolab.db);
  let blind = 0;
  const blinded = (q: typeof query) => ((sql: string, params?: unknown[]) => (blind > 0 && /m\.nonce = \$3/.test(sql) ? (blind--, Promise.resolve({ rows: [] })) : q(sql, params))) as typeof query;
  kolab.db.query = blinded(query);
  kolab.db.transaction = (<T>(fn: (tx: typeof kolab.db) => Promise<T>) => transaction((tx) => {
    tx.query = blinded(tx.query.bind(tx));
    return fn(tx);
  })) as typeof kolab.db.transaction;
  const dm = await kolab.sendMessage(ann, 'bo', 'Tea?', { nonce: 'blind-1' });
  const ch = await kolab.sendChannelMessage(ann, 'general', 'Tea?', { nonce: 'blind-2' });
  blind = 2;
  expect(await kolab.sendMessage(ann, 'bo', 'Tea?', { nonce: 'blind-1' })).toStrictEqual(dm);
  expect(blind).toBe(0);
  blind = 2;
  expect(await rejection(kolab.sendMessage(ann, 'bo-claude', 'Tea?', { nonce: 'blind-1' }))).toMatch(/LimitError: nonce blind-1 names another message/);
  expect(blind).toBe(0);
  blind = 2;
  expect(await kolab.sendChannelMessage(ann, 'general', 'Tea?', { nonce: 'blind-2' })).toStrictEqual(ch);
  expect(blind).toBe(0);
  blind = 2;
  expect(await rejection(kolab.sendChannelMessage(ann, 'deploys', 'Tea?', { nonce: 'blind-2' }))).toMatch(/LimitError: nonce blind-2 names another message/);
  expect(blind).toBe(0);
  kolab.db.transaction = transaction;
  kolab.db.query = query;
  expect((await kolab.db.query<{ n: number }>(`select count(*)::int as n from message where nonce is not null`)).rows[0].n).toBe(2);
  expect((await kolab.db.query<{ n: number }>(`select count(*)::int as n from channel_message where nonce is not null`)).rows[0].n).toBe(2);
});

test('a conversation\'s messages are numbered in the order they commit: each later than any already there, whichever of the two sent it', async () => {
  const { kolab, ann, bo } = await hub();
  const a = await kolab.sendMessage(ann, 'bo', 'one');
  // One there already numbered later than now, as a send that took its number first and committed after would be.
  const ahead = `${a.id.slice(0, 1)}ZZZZZZZZZ${a.id.slice(10)}`;
  await kolab.db.query(`insert into message(id, kolab_id, sent_by, sent_to, body) values ($1, 'hub', 'bo', 'ann', 'ahead')`, [ahead]);
  const b = await kolab.sendMessage(ann, 'bo', 'two');
  expect(b.id > ahead).toBe(true);
  const c = await kolab.sendMessage(bo, 'ann', 'three');
  expect(c.id > b.id).toBe(true);
  // Many at once between the two, both ways: every number distinct, and each later than those before it committed.
  const sent = await Promise.all(Array.from({ length: 12 }, (_, i) => kolab.sendMessage(i % 2 ? bo : ann, i % 2 ? 'ann' : 'bo', `m${i}`)));
  expect(new Set(sent.map((m) => m.id)).size).toBe(12);
  expect(sent.every((m) => m.id > c.id)).toBe(true);
});
