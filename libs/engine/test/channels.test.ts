// Channels in a kolab (migration 0052): named rooms every member reads and writes. Every kolab has
// `general`, which a member follows unless they unfollow it; any member makes another. A channel
// message may mention members, resolved as it is sent; it signals every follower and everyone it
// mentions, and waits unread in their answers, each member with a read position of their own. A
// member who joins later reads the whole history. Agent-sent messages in a row past the kolab's
// agent_reply_cap wake no agent. Direct messages are unchanged and stay their two members' alone.
import { expect, test } from '@jest/globals';
import { DEFAULT_AGENT_REPLY_CAP, MAX_MENTIONS, MAX_TEXT, MESSAGES_AT_ONCE, isInboxEvent, type KolabEvent } from '@konjir/types';
import { openKolab, rejection, TestKolab } from '@konjir/engine/testing';

/**
 * Ann owns `hub`. Bo writes there. Each has an agent of their own with access (ann-claude,
 * bo-claude), and Sam has none. Everyone but Sam has a session open in it.
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

const signalled = (events: KolabEvent[]) => events.map((e) => ('actor' in e ? e.actor : null)).sort();

test('every kolab has general, made with it, which every member follows without choosing; any member makes another, which only its maker follows', async () => {
  const { kolab, ann, bo, boAgent } = await hub();
  const first = await kolab.channelsPage(bo);
  expect(first).toStrictEqual({
    kolab: 'hub', agent_reply_cap: DEFAULT_AGENT_REPLY_CAP, next: null,
    items: [{ channel: 'general', following: true, unread: 0, mentions: 0, made_by: null, made_at: first.items[0].made_at }],
  });
  // Another kolab has its own general.
  await kolab.createKolab('other', { owner: 'sam' });
  expect((await kolab.db.query(`select kolab_id, name from channel order by kolab_id`)).rows).toStrictEqual([{ kolab_id: 'hub', name: 'general' }, { kolab_id: 'other', name: 'general' }]);

  const made = await kolab.makeChannel(boAgent, '#deploys');
  expect(made).toStrictEqual({ channel: 'deploys', following: true, unread: 0, mentions: 0, made_by: 'bo-claude', made_at: made.made_at });
  expect((await kolab.channelsPage(boAgent)).items.map((c) => [c.channel, c.following])).toStrictEqual([['deploys', true], ['general', true]]);
  expect((await kolab.channelsPage(ann)).items.map((c) => [c.channel, c.following])).toStrictEqual([['deploys', false], ['general', true]]);

  // Names: 1 to 40 lowercase letters, digits and hyphens, unique in the kolab.
  for (const bad of ['', 'Deploys', '-x', 'a b', 'x'.repeat(41), 'café']) {
    expect(await rejection(kolab.makeChannel(ann, bad))).toMatch(/LimitError: .* is no channel name: a channel is named with 1 to 40 lowercase letters/);
  }
  expect(await kolab.makeChannel(ann, 'x'.repeat(40))).toMatchObject({ channel: 'x'.repeat(40) });
  expect(await rejection(kolab.makeChannel(ann, 'deploys'))).toMatch(/LimitError: kolab hub already has a channel #deploys/);
  expect(await rejection(kolab.makeChannel(ann, 'general'))).toMatch(/already has a channel #general/);
  expect(await rejection(kolab.readChannel(ann, 'nope'))).toMatch(/LimitError: kolab hub has no channel #nope: konjir_list_channels lists its channels/);

  // A page at a time, by name.
  const page = await kolab.channelsPage(ann, { limit: 2 });
  expect(page.items.map((c) => c.channel)).toStrictEqual(['deploys', 'general']);
  expect((await kolab.channelsPage(ann, { limit: 2, cursor: page.next })).items.map((c) => c.channel)).toStrictEqual(['x'.repeat(40)]);

  // Unfollowing and following again, general too.
  expect(await kolab.followChannel(ann, 'general', false)).toStrictEqual({ channel: 'general', following: false });
  expect(await kolab.followChannel(ann, '#deploys', true)).toStrictEqual({ channel: 'deploys', following: true });
  expect((await kolab.channelsPage(ann)).items.map((c) => [c.channel, c.following])).toStrictEqual([['deploys', true], ['general', false], ['x'.repeat(40), true]]);
});

test('a channel message reaches every follower and everyone it mentions, waits unread in their answers, and each member reads it at their own pace', async () => {
  const { kolab, ann, bo, annAgent, boAgent, events } = await hub();
  await kolab.followChannel(bo, 'general', false);
  // Unfollowing tells the member's own other sessions.
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'hub', actor: 'bo' }]);
  events.length = 0;
  const sent = await kolab.sendChannelMessage(ann, '#general', 'Deploy is green.', { mentions: ['bo'] });
  expect(sent).toStrictEqual({ id: sent.id, channel: 'general', from: 'ann', message: 'Deploy is green.', reply_to: null, mentions: ['bo'], sent_at: sent.sent_at });
  // Every follower and the one it mentions, but not the sender.
  expect(signalled(events)).toStrictEqual(['ann-claude', 'bo', 'bo-claude']);

  // Unread for each other member, with whether it mentions them; a person is never woken.
  const item = (o: object) => ({ ...sent, ...o });
  expect(await kolab.unreadChannels(annAgent)).toStrictEqual([
    { channel: 'general', following: true, unread: 1, mentions: 0, items: [item({ mentions_you: false, capped: false, wakes: false })] },
  ]);
  // Bo doesn't follow general, but the mention reaches him.
  expect(await kolab.unreadChannels(bo)).toStrictEqual([
    { channel: 'general', following: false, unread: 1, mentions: 1, items: [item({ mentions_you: true, capped: false, wakes: false })] },
  ]);
  expect(await kolab.unreadChannels(ann)).toStrictEqual([]);

  // An agent is woken by a message that mentions it, and by no other.
  const reply = await kolab.sendChannelMessage(ann, 'general', 'bo-claude, can you watch it?', { mentions: ['bo/claude'], replyTo: sent.id });
  expect(reply.mentions).toStrictEqual(['bo-claude']);
  const forAgent = (await kolab.unreadChannels(boAgent))[0];
  expect(forAgent).toMatchObject({ channel: 'general', following: true, unread: 2, mentions: 1 });
  expect(forAgent.items.map((m) => [m.id, m.mentions_you, m.wakes])).toStrictEqual([[sent.id, false, false], [reply.id, true, true]]);
  expect((await kolab.channelsPage(boAgent)).items).toMatchObject([{ channel: 'general', unread: 2, mentions: 1 }]);

  // Reading moves only the reader's position, and looking at the answers or the list moves none.
  events.length = 0;
  const one = await kolab.readChannel(boAgent, 'general', { limit: 1 });
  expect(one).toStrictEqual({ channel: 'general', messages: [sent], more: 1 });
  expect(events).toStrictEqual([{ inbox: 'actor', kolab: 'hub', actor: 'bo-claude' }]);
  expect((await kolab.readChannel(boAgent, 'general')).messages.map((m) => m.id)).toStrictEqual([reply.id]);
  expect(await kolab.readChannel(boAgent, 'general')).toStrictEqual({ channel: 'general', messages: [], more: 0 });
  expect(await kolab.unreadChannels(boAgent)).toStrictEqual([]);
  expect((await kolab.unreadChannels(annAgent))[0].unread).toBe(2);
  expect((await kolab.channelMessagesPage(annAgent, 'general')).items.map((m) => m.id)).toStrictEqual([reply.id, sent.id]);
  expect((await kolab.unreadChannels(annAgent))[0].unread).toBe(2);
  expect((await kolab.readChannel(annAgent, 'general')).messages.map((m) => m.id)).toStrictEqual([sent.id, reply.id]);

  // A reply names a message of the same channel.
  await kolab.makeChannel(ann, 'deploys');
  expect(await rejection(kolab.sendChannelMessage(ann, 'deploys', 'hi', { replyTo: sent.id }))).toMatch(/LimitError: reply_to names no message of #deploys in kolab hub/);
  expect(await rejection(kolab.sendChannelMessage(ann, 'deploys', '  '))).toMatch(/LimitError: a message needs some words/);
  expect(await rejection(kolab.sendChannelMessage(ann, 'deploys', 'x'.repeat(MAX_TEXT + 1)))).toMatch(/LimitError: the message is .* characters; the limit is/);
  // A message in a channel no one else follows signals only those it mentions.
  events.length = 0;
  await kolab.sendChannelMessage(ann, 'deploys', 'quiet here');
  await kolab.sendChannelMessage(ann, 'deploys', 'unless you are named', { mentions: ['ann-claude'] });
  expect(signalled(events)).toStrictEqual(['ann-claude']);
});

test('a mention names a member, by name or as <owner>/<label>; anyone else is refused, the same whether or not the name exists, and nothing is written', async () => {
  const { kolab, ann, annAgent } = await hub();
  const count = async () => (await kolab.db.query(`select 1 from channel_message`)).rows.length;
  expect((await kolab.sendChannelMessage(ann, 'general', 'all of you', { mentions: ['@bo', 'ann-claude', 'bo/claude', 'bo'] })).mentions).toStrictEqual(['ann-claude', 'bo', 'bo-claude']);
  for (const who of ['sam', 'nobody', 'sam/claude', 'ann/claude-x', 'bo/ann']) {
    expect(await rejection(kolab.sendChannelMessage(annAgent, 'general', 'hello', { mentions: ['bo', who] })))
      .toStrictEqual(`AccessError: ${who} is not a member of kolab hub, so a message can't mention them: konjir_list_members lists who is`);
  }
  // <owner>/<label> names that owner's agent: not a person, and not another owner's agent.
  await kolab.addActor('bo-x');
  await kolab.grant('hub', 'bo-x', 'write');
  expect(await rejection(kolab.sendChannelMessage(ann, 'general', 'hello', { mentions: ['bo/x'] }))).toMatch(/AccessError: bo\/x is not a member of kolab hub/);
  expect((await kolab.sendChannelMessage(ann, 'general', 'hello', { mentions: ['bo-x'] })).mentions).toStrictEqual(['bo-x']);
  expect(await rejection(kolab.sendChannelMessage(ann, 'general', 'too many', { mentions: Array.from({ length: MAX_MENTIONS + 1 }, () => 'bo') })))
    .toMatch(`LimitError: a message mentions at most ${MAX_MENTIONS} members`);
  // Someone who lost their access is no member any more.
  await kolab.revoke('hub', 'bo-claude');
  expect(await rejection(kolab.sendChannelMessage(ann, 'general', 'still there?', { mentions: ['bo/claude'] }))).toMatch(/AccessError: bo\/claude is not a member of kolab hub/);
  expect(await count()).toBe(2);
  expect((await kolab.db.query(`select count(*)::int as n from channel_mention`)).rows[0]).toStrictEqual({ n: 4 });
});

test('a member who joins later reads the whole history, oldest first, a batch at a time; their own messages are never unread to them', async () => {
  const { kolab, ann, events } = await hub();
  const n = MESSAGES_AT_ONCE + 2;
  for (let i = 1; i <= n; i++) await kolab.sendChannelMessage(ann, 'general', `message ${i}`);
  await kolab.grant('hub', 'sam', 'read');
  const sam = await kolab.openSession('sam', 'product', { kolab: 'hub' });
  const waiting = await kolab.unreadChannels(sam);
  expect(waiting.map((c) => [c.channel, c.unread, c.items.length])).toStrictEqual([['general', n, MESSAGES_AT_ONCE]]);
  expect(waiting[0].items[0].message).toBe('message 1');
  const batch = await kolab.readChannel(sam, 'general');
  expect(batch.messages.length).toBe(MESSAGES_AT_ONCE);
  expect(batch.more).toBe(2);
  // A Read-only member writes too: a channel is open to every member.
  events.length = 0;
  await kolab.sendChannelMessage(sam, 'general', 'hello, I am new');
  expect(signalled(events)).toStrictEqual(['ann', 'ann-claude', 'bo', 'bo-claude']);
  expect((await kolab.readChannel(sam, 'general')).messages.map((m) => m.message)).toStrictEqual([`message ${n - 1}`, `message ${n}`]);
  expect(await kolab.unreadChannels(sam)).toStrictEqual([]);
  expect(await rejection(kolab.readChannel(sam, 'general', { limit: 0 }))).toMatch(/LimitError: limit is a whole number/);
});

test('after agent_reply_cap agent messages in a row in a channel, with none from a person, further agent messages wake no agent until a person posts', async () => {
  const { kolab, ann, bo, annAgent, boAgent } = await hub();
  // Only the kolab's owner sets the cap.
  expect(await rejection(kolab.setAgentReplyCap(bo, 2))).toMatch(/AccessError: bo does not own kolab hub: only its owner sets agent_reply_cap/);
  expect(await rejection(kolab.setAgentReplyCap(annAgent, 2))).toMatch(/AccessError: ann-claude does not own kolab hub/);
  expect(await rejection(kolab.setAgentReplyCap(ann, 0))).toMatch(/LimitError: agent_reply_cap is a whole number from 1 to/);
  expect(await kolab.setAgentReplyCap(ann, 2)).toStrictEqual({ kolab: 'hub', agent_reply_cap: 2 });
  expect((await kolab.channelsPage(bo)).agent_reply_cap).toBe(2);

  // Two agents answer each other, each mentioning the other.
  const a1 = await kolab.sendChannelMessage(annAgent, 'general', 'one', { mentions: ['bo/claude'] });
  const b1 = await kolab.sendChannelMessage(boAgent, 'general', 'two', { mentions: ['ann/claude'] });
  const a2 = await kolab.sendChannelMessage(annAgent, 'general', 'three', { mentions: ['bo/claude'] });
  const b2 = await kolab.sendChannelMessage(boAgent, 'general', 'four', { mentions: ['ann/claude'] });
  const flags = async (s: string) => (await kolab.unreadChannels(s))[0]?.items.map((m) => [m.message, m.capped, m.wakes]) ?? [];
  // The first two wake; from the third, at the cap, none does, and the flag says so to any reader.
  expect(await flags(boAgent)).toStrictEqual([['one', false, true], ['three', true, false]]);
  expect(await flags(annAgent)).toStrictEqual([['two', false, true], ['four', true, false]]);
  expect(await flags(bo)).toStrictEqual([['one', false, false], ['two', false, false], ['three', true, false], ['four', true, false]]);
  expect((await kolab.db.query(`select id, agent_run from channel_message order by id`)).rows.map((r) => (r as { agent_run: number }).agent_run)).toStrictEqual([1, 2, 3, 4]);
  expect([a1, b1, a2, b2].every((m) => typeof m.id === 'string')).toBe(true);

  // A person posts: the run starts again. A person's message is never capped.
  await kolab.readChannel(annAgent, 'general');
  await kolab.readChannel(boAgent, 'general');
  await kolab.sendChannelMessage(bo, 'general', 'carry on', { mentions: ['ann/claude', 'bo/claude'] });
  await kolab.sendChannelMessage(annAgent, 'general', 'five', { mentions: ['bo/claude'] });
  expect(await flags(boAgent)).toStrictEqual([['carry on', false, true], ['five', false, true]]);
  expect(await flags(annAgent)).toStrictEqual([['carry on', false, true]]);

  // The cap is per channel: another channel's run is its own.
  await kolab.makeChannel(annAgent, 'side');
  await kolab.sendChannelMessage(annAgent, 'side', 'six', { mentions: ['bo/claude'] });
  expect((await kolab.unreadChannels(boAgent)).find((c) => c.channel === 'side')!.items.map((m) => [m.message, m.capped, m.wakes])).toStrictEqual([['six', false, true]]);
  // Raising the cap applies to what is unread now.
  await kolab.setAgentReplyCap(ann, 100);
  expect(await flags(bo)).toStrictEqual([['one', false, false], ['two', false, false], ['three', false, false], ['four', false, false], ['five', false, false]]);
});

test('channel messages and channels are counted in the message budget, with direct messages; a refused one is not written', async () => {
  const { kolab, ann, annAgent, bo } = await hub();
  Object.assign(kolab.rates, { messages: 3 });
  await kolab.sendMessage(ann, 'bo', 'one');
  await kolab.sendChannelMessage(annAgent, 'general', 'two');
  expect(await rejection(kolab.sendChannelMessage(ann, 'general', 'no', { mentions: ['sam'] }))).toMatch(/not a member/);
  await kolab.makeChannel(ann, 'three');
  expect(await rejection(kolab.sendChannelMessage(ann, 'general', 'four'))).toMatch(/LimitError: ann and ann's agents sent 3 messages in the last hour; the limit is 3 in an hour/);
  expect(await rejection(kolab.makeChannel(annAgent, 'four'))).toMatch(/LimitError: ann-claude, with the rest of ann's agents and ann, sent 3 messages/);
  expect(await rejection(kolab.sendMessage(ann, 'bo', 'four'))).toMatch(/LimitError: ann and ann's agents sent 3 messages/);
  expect((await kolab.db.query(`select count(*)::int as n from channel_message`)).rows[0]).toStrictEqual({ n: 1 });
  expect((await kolab.db.query(`select name from channel order by name`)).rows).toStrictEqual([{ name: 'general' }, { name: 'three' }]);
  // Bo's budget is his own.
  await kolab.sendChannelMessage(bo, 'general', 'mine');
});

test('direct messages stay their two members\' alone: a channel shows none of them, they show no channel message, and no session\'s role reads a channel table', async () => {
  const { kolab, ann, bo, annAgent, boAgent } = await hub();
  const direct = await kolab.sendMessage(ann, 'bo', 'just between us');
  const open = await kolab.sendChannelMessage(ann, 'general', 'for everyone', { mentions: ['bo'] });
  expect(await kolab.unreadMessages(bo)).toStrictEqual({ unread: 1, items: [direct] });
  expect(await kolab.unreadMessages(boAgent)).toStrictEqual({ unread: 0, items: [] });
  expect((await kolab.messagesPage(annAgent)).items).toStrictEqual([]);
  expect((await kolab.channelMessagesPage(boAgent, 'general')).items).toStrictEqual([open]);
  expect((await kolab.unreadChannels(bo))[0].items.map((m) => m.id)).toStrictEqual([open.id]);
  expect((await kolab.readMessages(bo)).messages.map((m) => m.id)).toStrictEqual([direct.id]);
  expect((await kolab.unreadChannels(bo))[0].unread).toBe(1);
  for (const table of ['channel', 'channel_follow', 'channel_message', 'channel_mention', 'channel_read', 'channel_setting', 'message']) {
    expect(await rejection(kolab.readAs(bo, (q) => q.query(`select 1 from ${table}`)))).toMatch(/permission denied/);
  }
});

test('only a member reads or writes a channel: not a reader of a public kolab, and not an agent whose access was taken away', async () => {
  const kolab = await openKolab();
  for (const id of ['ann', 'sam']) await kolab.addActor(id);
  await kolab.createKolab('open', { owner: 'ann', visibility: 'public' });
  const sam = await kolab.openSession('sam', 'product', { kolab: 'open' });
  await kolab.openSession('ann', 'product', { kolab: 'open' });
  const refusal = /AccessError: sam is not a member of kolab open: its channels are for those who hold access there/;
  expect(await rejection(kolab.channelsPage(sam))).toMatch(refusal);
  expect(await rejection(kolab.readChannel(sam, 'general'))).toMatch(refusal);
  expect(await rejection(kolab.channelMessagesPage(sam, 'general'))).toMatch(refusal);
  expect(await rejection(kolab.sendChannelMessage(sam, 'general', 'hi'))).toMatch(refusal);
  expect(await rejection(kolab.makeChannel(sam, 'mine'))).toMatch(refusal);
  expect(await rejection(kolab.followChannel(sam, 'general', true))).toMatch(refusal);
  expect(await kolab.unreadChannels(sam)).toStrictEqual([]);

  const { kolab: k, ann, boAgent } = await hub();
  await k.sendChannelMessage(ann, 'general', 'before');
  await k.revoke('hub', 'bo-claude');
  expect(await rejection(k.readChannel(boAgent, 'general'))).toMatch(/session|not a member/);
  expect(await rejection(k.channelMessagesPage(boAgent, 'general'))).toMatch(/session|not a member/);
  // Another kolab's channel can't be named from here: a session reads its own kolab's alone.
  await k.createKolab('elsewhere', { owner: 'sam' });
  const samThere = await k.openSession('sam', 'product', { kolab: 'elsewhere' });
  await k.makeChannel(samThere, 'secret');
  expect(await rejection(k.readChannel(ann, 'secret'))).toMatch(/LimitError: kolab hub has no channel #secret/);
});

test('a channel and its messages and mentions are never edited or removed; an archived kolab takes no new channel, follow or read position', async () => {
  const { kolab, ann, bo } = await hub();
  await kolab.sendChannelMessage(ann, 'general', 'keep this', { mentions: ['bo'] });
  await kolab.sendChannelMessage(ann, 'general', 'and this');
  await kolab.readChannel(bo, 'general', { limit: 1 });
  for (const sql of [`update channel_message set body = 'changed'`, `delete from channel_message`, `truncate channel_message cascade`,
    `delete from channel_mention`, `update channel_mention set actor_id = 'ann'`, `delete from channel`, `update channel set kolab_id = 'x'`, `truncate channel cascade`]) {
    expect(await rejection(kolab.db.query(sql))).toMatch(/never edited or removed/);
  }
  await kolab.archive({ kolab: 'hub' });
  expect(await rejection(kolab.db.query(`insert into channel(id, kolab_id, name, made_by) values ('c2', 'hub', 'late', 'ann')`))).toMatch(/archived/);
  expect(await rejection(kolab.db.query(`update channel_read set read_to = read_to`))).toMatch(/archived/);
  expect(await rejection(kolab.db.query(`insert into channel_follow(channel_id, kolab_id, actor_id, following) values ('general:hub', 'hub', 'ann', false)`))).toMatch(/archived/);
  expect((await kolab.db.query(`select count(*)::int as n from channel_message`)).rows[0]).toStrictEqual({ n: 2 });
});

test('direct messages: read_messages from=<member> reads and marks only theirs, by name or as <owner>/<label>; the rest stay unread', async () => {
  const { kolab, ann, bo, boAgent } = await hub();
  const fromAnn = await kolab.sendMessage(ann, 'bo', 'from ann');
  const fromAgent = await kolab.sendMessage(boAgent, 'bo', 'from my agent');
  const fromAnn2 = await kolab.sendMessage(ann, 'bo', 'from ann again');
  const read = await kolab.readMessages(bo, { from: 'bo/claude' });
  expect(read.messages.map((m) => m.id)).toStrictEqual([fromAgent.id]);
  expect(read.more).toBe(0);
  expect((await kolab.unreadMessages(bo)).items.map((m) => m.id)).toStrictEqual([fromAnn.id, fromAnn2.id]);
  expect(await kolab.readMessages(bo, { from: 'nobody' })).toStrictEqual({ messages: [], more: 0 });
  const one = await kolab.readMessages(bo, { from: '@ann', limit: 1 });
  expect([one.messages.map((m) => m.id), one.more]).toStrictEqual([[fromAnn.id], 1]);
  expect((await kolab.readMessages(bo)).messages.map((m) => m.id)).toStrictEqual([fromAnn2.id]);
});
