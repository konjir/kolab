// "Read up to here" (konnect's app, S2): a member moves their own read position in a channel
// forward to a message, never back, and marks read the direct messages a member sent them up to a
// message of their conversation, without reading either. Each id must belong to that channel or
// that conversation; each signals the caller's own answers, so their other clients update.
import { expect, test } from '@jest/globals';
import { isInboxEvent, type KolabEvent } from '@konjir/types';
import { openKolab, rejection } from '@konjir/engine/testing';

/** Ann owns `hub`; Bo writes there, with an agent of his own; Sam has no access. */
async function hub() {
  const k = await openKolab();
  for (const id of ['ann', 'bo', 'sam']) await k.addActor(id);
  await k.addActor('bo-claude', { owner: 'bo' });
  await k.createKolab('hub', { owner: 'ann' });
  await k.grant('hub', 'bo', 'write');
  await k.grant('hub', 'bo-claude', 'write');
  const ann = await k.openSession('ann', 'product', { kolab: 'hub' });
  const bo = await k.openSession('bo', 'engineer', { kolab: 'hub' });
  const boAgent = await k.openSession('bo-claude', 'engineer', { kolab: 'hub' });
  await k.unreadChannels(boAgent);
  const events: KolabEvent[] = [];
  k.onEvent((e) => { if (isInboxEvent(e)) events.push(e); });
  return { kolab: k, ann, bo, boAgent, events };
}

test('mark_channel_read moves the caller\'s position forward to up_to, never back, and signals only the caller', async () => {
  const { kolab, ann, bo, events } = await hub();
  const m = [];
  for (let i = 0; i < 4; i++) m.push(await kolab.sendChannelMessage(ann, 'general', `m${i}`));
  expect((await kolab.channelsPage(bo)).items[0]).toMatchObject({ channel: 'general', unread: 4 });

  events.length = 0;
  expect(await kolab.markChannelRead(bo, '#general', m[2].id)).toStrictEqual({ channel: 'general', read_to: m[2].id, moved: true });
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'hub', actor: 'bo' }]);
  expect((await kolab.channelsPage(bo)).items[0]).toMatchObject({ unread: 1 });
  // Ann's position is her own, untouched.
  expect((await kolab.channelsPage(ann)).items[0]).toMatchObject({ unread: 0 });

  // Back, or to where it is, does nothing and signals nothing.
  events.length = 0;
  expect(await kolab.markChannelRead(bo, 'general', m[0].id)).toStrictEqual({ channel: 'general', read_to: m[2].id, moved: false });
  expect(await kolab.markChannelRead(bo, 'general', m[2].id)).toStrictEqual({ channel: 'general', read_to: m[2].id, moved: false });
  expect(events).toStrictEqual([]);
  // Reading goes on from there: only the last is unread.
  expect((await kolab.readChannel(bo, 'general')).messages.map((x) => x.id)).toStrictEqual([m[3].id]);
});

test('mark_channel_read starts a position for one who had none, a person who never followed the channel or an agent', async () => {
  const { kolab, ann, bo, boAgent } = await hub();
  await kolab.makeChannel(ann, 'deploys');
  const a = await kolab.sendChannelMessage(ann, 'deploys', 'one');
  const b = await kolab.sendChannelMessage(ann, 'deploys', 'two');
  expect(await kolab.markChannelRead(bo, 'deploys', a.id)).toMatchObject({ read_to: a.id, moved: true });
  expect((await kolab.readChannel(bo, 'deploys')).messages.map((x) => x.id)).toStrictEqual([b.id]);
  expect(await kolab.markChannelRead(boAgent, 'deploys', b.id)).toMatchObject({ read_to: b.id, moved: true });
  expect((await kolab.readChannel(boAgent, 'deploys')).messages).toStrictEqual([]);
});

test('mark_channel_read refuses an id of another channel, a direct message\'s, an unknown one, a channel that doesn\'t exist, and a non-member; nothing moves', async () => {
  const { kolab, ann, bo } = await hub();
  await kolab.makeChannel(ann, 'deploys');
  const other = await kolab.sendChannelMessage(ann, 'deploys', 'elsewhere');
  const dm = await kolab.sendMessage(ann, 'bo', 'direct');
  await kolab.sendChannelMessage(ann, 'general', 'here');
  for (const id of [other.id, dm.id, '01JZZZZZZZZZZZZZZZZZZZZZZZ', '']) {
    expect(await rejection(kolab.markChannelRead(bo, 'general', id))).toMatch(/LimitError: up_to (names no message of #general in kolab hub|is the id of a message of the channel)/);
  }
  expect(await rejection(kolab.markChannelRead(bo, 'nope', other.id))).toMatch(/LimitError: kolab hub has no channel #nope/);
  expect((await kolab.channelsPage(bo)).items.find((c) => c.channel === 'general')).toMatchObject({ unread: 1 });

  // A reader of a public kolab is no member, and moves no position there.
  const k = await openKolab();
  for (const id of ['ann', 'sam']) await k.addActor(id);
  await k.createKolab('open', { owner: 'ann', visibility: 'public' });
  const said = await k.sendChannelMessage(await k.openSession('ann', 'product', { kolab: 'open' }), 'general', 'public words');
  const sam = await k.openSession('sam', 'product', { kolab: 'open' });
  expect(await rejection(k.markChannelRead(sam, 'general', said.id))).toMatch(/AccessError: sam is not a member of kolab open/);
});

test('mark_messages_read marks theirs to the caller up to and including up_to, which may be either\'s; only the caller\'s receipts, and only theirs', async () => {
  const { kolab, ann, bo, boAgent, events } = await hub();
  const a1 = await kolab.sendMessage(ann, 'bo', 'one');
  const b1 = await kolab.sendMessage(bo, 'ann', 'mine');
  const a2 = await kolab.sendMessage(ann, 'bo', 'two');
  const a3 = await kolab.sendMessage(ann, 'bo', 'three');
  const x = await kolab.sendMessage(boAgent, 'bo', 'from my agent');
  expect((await kolab.unreadMessages(bo)).unread).toBe(4);

  events.length = 0;
  expect(await kolab.markMessagesRead(bo, 'ann', a2.id)).toStrictEqual({ with: 'ann', up_to: a2.id, marked: 2 });
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'hub', actor: 'bo' }]);
  expect((await kolab.unreadMessages(bo)).items.map((m) => m.id)).toStrictEqual([a3.id, x.id]);
  // Ann's own message to Bo stays unread to Bo's agent and Ann; Bo's to Ann stays unread to her.
  expect((await kolab.unreadMessages(ann)).items.map((m) => m.id)).toStrictEqual([b1.id]);

  // up_to may be the caller's own message: theirs before it are marked. Again marks nothing, and signals nothing.
  const b2 = await kolab.sendMessage(bo, 'ann', 'mine again');
  events.length = 0;
  const before = (await kolab.messagesPage(bo, { with: 'ann' })).items.find((m) => m.id === a1.id)!.read_at;
  expect(await kolab.markMessagesRead(bo, '@ann', b2.id)).toStrictEqual({ with: 'ann', up_to: b2.id, marked: 1 });
  expect(await kolab.markMessagesRead(bo, 'ann', b2.id)).toStrictEqual({ with: 'ann', up_to: b2.id, marked: 0 });
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'hub', actor: 'bo' }]);
  // A message read already keeps when it was read.
  expect((await kolab.messagesPage(bo, { with: 'ann' })).items.find((m) => m.id === a1.id)!.read_at).toBe(before);
  // An agent by <owner>/<label>.
  expect(await kolab.markMessagesRead(bo, 'bo/claude', x.id)).toStrictEqual({ with: 'bo-claude', up_to: x.id, marked: 1 });
  expect((await kolab.unreadMessages(bo)).unread).toBe(0);
});

test('mark_messages_read refuses an id outside the conversation: someone else\'s, a channel message\'s, unknown; and an archived kolab', async () => {
  const { kolab, ann, bo, boAgent } = await hub();
  const toAgent = await kolab.sendMessage(ann, 'bo-claude', 'for the agent');
  const toBo = await kolab.sendMessage(ann, 'bo', 'for bo');
  const ch = await kolab.sendChannelMessage(ann, 'general', 'room');
  // Ann's message to Bo's agent is not Bo's conversation with Ann.
  for (const id of [toAgent.id, ch.id, '01JZZZZZZZZZZZZZZZZZZZZZZZ']) {
    expect(await rejection(kolab.markMessagesRead(bo, 'ann', id))).toMatch(/LimitError: up_to names no message between you and ann in kolab hub/);
  }
  // Nor is a message to Bo his conversation with his agent.
  expect(await rejection(kolab.markMessagesRead(bo, 'bo-claude', toBo.id))).toMatch(/LimitError: up_to names no message between you and bo-claude/);
  expect(await rejection(kolab.markMessagesRead(bo, '', toBo.id))).toMatch(/LimitError: name the member/);
  expect((await kolab.unreadMessages(bo)).unread).toBe(1);
  expect((await kolab.unreadMessages(boAgent)).unread).toBe(1);

  await kolab.archive({ kolab: 'hub' }, { by: 'admin' });
  expect(await rejection(kolab.markMessagesRead(bo, 'ann', toBo.id))).toMatch(/no open session|archived/);
});
