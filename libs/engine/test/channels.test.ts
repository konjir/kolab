// Channels in a kolab (migration 0052): named rooms every member reads and writes. Every kolab has
// `general`, which a member follows unless they unfollow it; any member makes another. A channel
// message may mention members, resolved as it is sent; it signals every follower and everyone it
// mentions, and waits unread in their answers, each member with a read position of their own,
// which starts when they follow the channel (or join, for those they follow then): what was said
// before is history, listed but not unread. Agent-sent messages in a row past the kolab's
// agent_reply_cap wake no agent. Direct messages are unchanged and stay their two members' alone.
import { expect, test } from '@jest/globals';
import { DEFAULT_AGENT_REPLY_CAP, MAX_CHANNELS, MAX_MENTIONS, MAX_MESSAGE_TEXT, MESSAGES_AT_ONCE, UNREAD_COUNT_CEILING, isInboxEvent, type KolabEvent } from '@konjir/types';
import { openKolab, rejection, TestKolab } from '@konjir/engine/testing';
import { CHANNEL_COUNTS_SQL } from '@konjir/engine';

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
  // Each agent is seen following general before anything is said there: its read position starts at the start.
  await k.unreadChannels(annAgent);
  await k.unreadChannels(boAgent);
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
    items: [{ channel: 'general', following: true, unread: 0, unread_more: false, mentions: 0, mentions_more: false, made_by: null, made_at: first.items[0].made_at }],
  });
  // Another kolab has its own general.
  await kolab.createKolab('other', { owner: 'sam' });
  expect((await kolab.db.query(`select kolab_id, name from channel order by kolab_id`)).rows).toStrictEqual([{ kolab_id: 'hub', name: 'general' }, { kolab_id: 'other', name: 'general' }]);

  const made = await kolab.makeChannel(boAgent, '#deploys');
  expect(made).toStrictEqual({ channel: 'deploys', following: true, unread: 0, unread_more: false, mentions: 0, mentions_more: false, made_by: 'bo-claude', made_at: made.made_at });
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
    { channel: 'general', following: true, unread: 1, unread_more: false, mentions: 0, mentions_more: false, items: [item({ mentions_you: false, capped: false, wakes: false })] },
  ]);
  // Bo doesn't follow general, but the mention reaches him.
  expect(await kolab.unreadChannels(bo)).toStrictEqual([
    { channel: 'general', following: false, unread: 1, unread_more: false, mentions: 1, mentions_more: false, items: [item({ mentions_you: true, capped: false, wakes: false })] },
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
  expect(await rejection(kolab.sendChannelMessage(ann, 'deploys', 'x'.repeat(MAX_MESSAGE_TEXT + 1)))).toMatch(new RegExp(`LimitError: the message is .* characters; the limit is ${MAX_MESSAGE_TEXT.toLocaleString('en')}`));
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

test('a member who joins later starts unread at their joining, the history still listed; then reads oldest first, a batch at a time; their own messages are never unread to them', async () => {
  const { kolab, ann, events } = await hub();
  await kolab.sendChannelMessage(ann, 'general', 'before sam');
  await kolab.grant('hub', 'sam', 'read');
  const sam = await kolab.openSession('sam', 'product', { kolab: 'hub' });
  // What was said before is history: listed, never unread.
  expect(await kolab.unreadChannels(sam)).toStrictEqual([]);
  expect((await kolab.channelsPage(sam)).items.map((c) => [c.channel, c.unread])).toStrictEqual([['general', 0]]);
  expect((await kolab.channelMessagesPage(sam, 'general')).items.map((m) => m.message)).toStrictEqual(['before sam']);
  expect(await kolab.readChannel(sam, 'general')).toStrictEqual({ channel: 'general', messages: [], more: 0 });
  const n = MESSAGES_AT_ONCE + 2;
  for (let i = 1; i <= n; i++) await kolab.sendChannelMessage(ann, 'general', `message ${i}`);
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
  for (const table of ['kolab_chat', 'channel', 'channel_follow', 'channel_message', 'channel_mention', 'channel_read', 'message']) {
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

test('a mention is among the items however much is unread before it, and wakes its agent; counts stop at the ceiling and say there are more', async () => {
  const { kolab, ann, bo, boAgent } = await hub();
  Object.assign(kolab.rates, { messages: Infinity });
  for (let i = 1; i <= MESSAGES_AT_ONCE + 5; i++) await kolab.sendChannelMessage(ann, 'general', `chatter ${i}`);
  const mention = await kolab.sendChannelMessage(ann, 'general', 'bo-claude, look at this', { mentions: ['bo/claude'] });
  const general = (await kolab.unreadChannels(boAgent))[0];
  expect([general.unread, general.mentions, general.items.length]).toStrictEqual([MESSAGES_AT_ONCE + 6, 1, MESSAGES_AT_ONCE + 1]);
  expect(general.items.slice(0, MESSAGES_AT_ONCE).every((m) => !m.wakes)).toBe(true);
  expect(general.items[MESSAGES_AT_ONCE]).toMatchObject({ id: mention.id, mentions_you: true, capped: false, wakes: true });
  // Unfollowed, only the mention shows.
  await kolab.followChannel(boAgent, 'general', false);
  expect((await kolab.unreadChannels(boAgent)).map((c) => [c.channel, c.following, c.unread, c.items.map((m) => m.id)])).toStrictEqual([['general', false, 1, [mention.id]]]);

  // Past the ceiling the count stops, and says there are more.
  await kolab.db.query(
    `insert into channel_message(id, kolab_id, channel_id, sent_by, body, agent_run)
     select '01K' || lpad(g::text, 23, '0'), 'hub', 'general:hub', 'ann', 'old', 0 from generate_series(1, $1::int) g`, [UNREAD_COUNT_CEILING]);
  const many = (await kolab.channelsPage(bo)).items[0];
  expect([many.unread, many.unread_more, many.mentions, many.mentions_more]).toStrictEqual([UNREAD_COUNT_CEILING, true, 0, false]);
  expect((await kolab.unreadChannels(bo))[0]).toMatchObject({ unread: UNREAD_COUNT_CEILING, unread_more: true });
});

test('a person\'s read position starts when they follow a channel: at its newest message, or just before the oldest that mentions them; one who joined before positions started so reads the whole history', async () => {
  const { kolab, ann, bo } = await hub();
  await kolab.makeChannel(ann, 'deploys');
  await kolab.sendChannelMessage(ann, 'deploys', 'old one');
  await kolab.sendChannelMessage(ann, 'deploys', 'old two');
  // Following starts Bo's unread now; the history stays listed.
  expect(await kolab.followChannel(bo, 'deploys', true)).toStrictEqual({ channel: 'deploys', following: true });
  expect((await kolab.channelsPage(bo)).items.map((c) => [c.channel, c.unread])).toStrictEqual([['deploys', 0], ['general', 0]]);
  expect(await kolab.unreadChannels(bo)).toStrictEqual([]);
  expect((await kolab.channelMessagesPage(bo, 'deploys')).items.map((m) => m.message)).toStrictEqual(['old two', 'old one']);
  const after = await kolab.sendChannelMessage(ann, 'deploys', 'after');
  expect((await kolab.unreadChannels(bo)).map((c) => [c.channel, c.items.map((m) => m.id)])).toStrictEqual([['deploys', [after.id]]]);
  // Unfollowing and following again moves nothing: the position stays where it was.
  await kolab.followChannel(bo, 'deploys', false);
  await kolab.followChannel(bo, 'deploys', true);
  expect((await kolab.readChannel(bo, 'deploys')).messages.map((m) => m.message)).toStrictEqual(['after']);

  // A mention of them before they follow is kept: their unread starts just before it.
  await kolab.makeChannel(ann, 'ops');
  await kolab.sendChannelMessage(ann, 'ops', 'ops history');
  const mention = await kolab.sendChannelMessage(ann, 'ops', 'bo, look at this', { mentions: ['bo'] });
  const next = await kolab.sendChannelMessage(ann, 'ops', 'and this');
  await kolab.followChannel(bo, 'ops', true);
  expect((await kolab.readChannel(bo, 'ops')).messages.map((m) => m.id)).toStrictEqual([mention.id, next.id]);

  // A member with no position (one who joined before positions started at joining) reads the whole history.
  await kolab.db.query(`delete from channel_read where actor_id = 'bo' and channel_id = 'general:hub'`);
  await kolab.sendChannelMessage(ann, 'general', 'g1');
  await kolab.sendChannelMessage(ann, 'general', 'g2');
  expect((await kolab.readChannel(bo, 'general')).messages.map((m) => m.message)).toStrictEqual(['g1', 'g2']);
});

test('a person granted access to a kolab starts unread at their joining in the channels they follow; one who held access already keeps what they had', async () => {
  const { kolab, ann } = await hub();
  await kolab.sendChannelMessage(ann, 'general', 'before');
  // Rejoining after leaving keeps the position they had.
  await kolab.grant('hub', 'sam', 'read');
  const sam = await kolab.openSession('sam', 'product', { kolab: 'hub' });
  expect(await kolab.unreadChannels(sam)).toStrictEqual([]);
  await kolab.revoke('hub', 'sam', { by: 'ann' });
  await kolab.sendChannelMessage(ann, 'general', 'while away');
  await kolab.grant('hub', 'sam', 'read');
  const back = await kolab.openSession('sam', 'product', { kolab: 'hub' });
  expect((await kolab.unreadChannels(back)).map((c) => c.items.map((m) => m.message))).toStrictEqual([['while away']]);
  // A grant changed for someone who holds one already starts nothing.
  await kolab.db.query(`delete from channel_read where actor_id = 'sam'`);
  await kolab.grant('hub', 'sam', 'write');
  expect((await kolab.unreadChannels(back)).map((c) => c.items.map((m) => m.message))).toStrictEqual([['before', 'while away']]);
});

test('an agent\'s read position starts at the newest message the first time it is seen in a channel, followed or not', async () => {
  const { kolab, ann } = await hub();
  await kolab.sendChannelMessage(ann, 'general', 'history');
  await kolab.makeChannel(ann, 'deploys');
  await kolab.sendChannelMessage(ann, 'deploys', 'more history');
  await kolab.addActor('ann-helper', { owner: 'ann' });
  await kolab.grant('hub', 'ann-helper', 'write');
  const helper = await kolab.openSession('ann-helper', 'product', { kolab: 'hub' });
  expect(await kolab.unreadChannels(helper)).toStrictEqual([]);
  expect((await kolab.channelsPage(helper)).items.map((c) => [c.channel, c.unread])).toStrictEqual([['deploys', 0], ['general', 0]]);
  // Following a channel starts it there too; the history stays listed.
  await kolab.followChannel(helper, 'deploys', true);
  expect(await kolab.readChannel(helper, 'deploys')).toStrictEqual({ channel: 'deploys', messages: [], more: 0 });
  expect((await kolab.channelMessagesPage(helper, 'deploys')).items.map((m) => m.message)).toStrictEqual(['more history']);
  const later = await kolab.sendChannelMessage(ann, 'general', 'now');
  expect((await kolab.unreadChannels(helper)).map((c) => c.items.map((m) => m.id))).toStrictEqual([[later.id]]);
});

test('a kolab holds at most MAX_CHANNELS channels, general among them', async () => {
  const { kolab, ann, bo } = await hub();
  await kolab.db.query(
    `insert into channel(id, kolab_id, name, made_by) select 'c' || g, 'hub', 'c' || g, 'ann' from generate_series(1, $1::int) g`, [MAX_CHANNELS - 2]);
  await kolab.makeChannel(bo, 'last');
  expect(await rejection(kolab.makeChannel(ann, 'one-more'))).toBe(`LimitError: kolab hub has ${MAX_CHANNELS} channels, the most a kolab holds (${MAX_CHANNELS}): talk in one of them (konjir_list_channels)`);
  expect((await kolab.db.query(`select count(*)::int as n from channel where kolab_id = 'hub'`)).rows[0]).toStrictEqual({ n: MAX_CHANNELS });
});

// On PGlite, one connection, these run one transaction at a time; under KONJIR_TEST_POSTGRES they
// race for real, and the channel's row lock is what keeps the order (sendChannelMessage).
test('messages sent at once to one channel are numbered in the order they commit, and a reader reading meanwhile skips none', async () => {
  const { kolab, ann, bo, annAgent, boAgent } = await hub();
  Object.assign(kolab.rates, { messages: Infinity });
  const senders = [ann, bo, boAgent];
  const read: string[] = [];
  const reads: Promise<void>[] = [];
  await Promise.all(Array.from({ length: 30 }, async (_, i) => {
    await kolab.sendChannelMessage(senders[i % 3], 'general', `m${i}`);
    if (i % 5 === 0) reads.push(kolab.readChannel(annAgent, 'general').then((r) => { read.push(...r.messages.map((m) => m.id)); }));
  }));
  await Promise.all(reads);
  for (let r = await kolab.readChannel(annAgent, 'general'); r.messages.length; r = await kolab.readChannel(annAgent, 'general')) read.push(...r.messages.map((m) => m.id));
  const rows = (await kolab.db.query<{ id: string }>(`select id from channel_message order by sent_at, id`)).rows.map((r) => r.id);
  expect(rows).toStrictEqual([...rows].sort());
  expect([...read].sort()).toStrictEqual([...rows].sort());
  expect(new Set(read).size).toBe(30);
});

test('after agent_reply_cap messages from one agent that could wake an agent, with none from a person, its further ones wake no agent until a person posts; two looping agents stop waking each other', async () => {
  const { kolab, ann, bo, annAgent, boAgent } = await hub();
  // Only the kolab's owner sets the cap.
  expect(await rejection(kolab.setAgentReplyCap(bo, 2))).toMatch(/AccessError: bo does not own kolab hub: only its owner sets agent_reply_cap/);
  expect(await rejection(kolab.setAgentReplyCap(annAgent, 2))).toMatch(/AccessError: ann-claude does not own kolab hub/);
  expect(await rejection(kolab.setAgentReplyCap(ann, 0))).toMatch(/LimitError: agent_reply_cap is a whole number from 1 to/);
  expect(await kolab.setAgentReplyCap(ann, 2)).toStrictEqual({ kolab: 'hub', agent_reply_cap: 2 });
  expect((await kolab.channelsPage(bo)).agent_reply_cap).toBe(2);

  // Two agents answer each other, each mentioning the other: each one's third wakes no one.
  for (const [who, text] of [[annAgent, 'one'], [boAgent, 'two'], [annAgent, 'three'], [boAgent, 'four'], [annAgent, 'five'], [boAgent, 'six']] as const) {
    await kolab.sendChannelMessage(who, 'general', text, { mentions: [who === annAgent ? 'bo/claude' : 'ann/claude'] });
  }
  const flags = async (s: string) => (await kolab.unreadChannels(s))[0]?.items.map((m) => [m.message, m.capped, m.wakes]) ?? [];
  expect(await flags(boAgent)).toStrictEqual([['one', false, true], ['three', false, true], ['five', true, false]]);
  expect(await flags(annAgent)).toStrictEqual([['two', false, true], ['four', false, true], ['six', true, false]]);
  // The flag is the same to any reader; a person is never woken.
  expect((await flags(bo)).map(([m, capped]) => [m, capped])).toStrictEqual([['one', false], ['two', false], ['three', false], ['four', false], ['five', true], ['six', true]]);
  expect((await kolab.db.query<{ agent_run: number }>(`select agent_run from channel_message order by id`)).rows.map((r) => r.agent_run)).toStrictEqual([1, 1, 2, 2, 3, 3]);

  // A person posts: every agent's run starts again. A person's message is never capped.
  await kolab.readChannel(annAgent, 'general');
  await kolab.readChannel(boAgent, 'general');
  await kolab.sendChannelMessage(bo, 'general', 'carry on', { mentions: ['ann/claude', 'bo/claude'] });
  await kolab.sendChannelMessage(annAgent, 'general', 'seven', { mentions: ['bo/claude'] });
  expect(await flags(boAgent)).toStrictEqual([['carry on', false, true], ['seven', false, true]]);
  expect(await flags(annAgent)).toStrictEqual([['carry on', false, true]]);
  // The cap is judged as it is now: raising it uncaps what is still unread.
  await kolab.setAgentReplyCap(ann, 100);
  expect((await flags(bo)).every(([, capped]) => capped === false)).toBe(true);
});

test('the loop cap is each agent\'s own, across the whole kolab: hopping channels doesn\'t reset it, one member\'s agents exhausting theirs leave another\'s waking, direct messages to a person never count, and a person anywhere resets every run', async () => {
  const { kolab, ann, bo, annAgent, boAgent } = await hub();
  Object.assign(kolab.rates, { messages: Infinity });
  await kolab.setAgentReplyCap(ann, 2);
  await kolab.addActor('ann-helper', { owner: 'ann' });
  await kolab.grant('hub', 'ann-helper', 'write');
  const helper = await kolab.openSession('ann-helper', 'product', { kolab: 'hub' });
  await kolab.unreadChannels(helper);
  for (const c of ['one', 'two', 'three']) await kolab.makeChannel(annAgent, c);
  for (const c of ['one', 'two', 'three']) await kolab.followChannel(boAgent, c, true);
  // Each message in a fresh channel: ann-claude's run goes on, and its third is capped.
  await kolab.sendChannelMessage(annAgent, 'one', 'a', { mentions: ['bo/claude'] });
  await kolab.sendChannelMessage(annAgent, 'two', 'b', { mentions: ['bo/claude'] });
  await kolab.sendChannelMessage(annAgent, 'three', 'c', { mentions: ['bo/claude'] });
  // Ann's other agent is spent too, in direct messages to an agent.
  const h1 = await kolab.sendMessage(helper, 'bo-claude', 'h1');
  const h2 = await kolab.sendMessage(helper, 'bo-claude', 'h2');
  const h3 = await kolab.sendMessage(helper, 'bo-claude', 'h3');
  const flags = async (s: string) => (await kolab.unreadChannels(s)).flatMap((c) => c.items.map((m) => [c.channel, m.message, m.capped, m.wakes]));
  expect(await flags(boAgent)).toStrictEqual([['one', 'a', false, true], ['three', 'c', true, false], ['two', 'b', false, true]]);
  // Past the cap, an agent's direct message to an agent is delivered and unread, but wakes no one.
  expect((await kolab.unreadMessages(boAgent)).items).toStrictEqual([h1, h2, { ...h3, capped: true }]);
  expect(await kolab.wakingMessages(boAgent)).toStrictEqual({ waking: 2 });
  // Bo's agent, another member's, is untouched: its mention still wakes ann-claude.
  const fromBo = await kolab.sendChannelMessage(boAgent, 'general', 'ann-claude, a question', { mentions: ['ann/claude'] });
  expect((await kolab.unreadChannels(annAgent)).flatMap((c) => c.items).find((m) => m.id === fromBo.id)).toMatchObject({ capped: false, wakes: true });

  // Direct messages to a person never count, however many.
  const before = (await kolab.db.query<{ run: number }>(`select run from kolab_chat_agent where actor_id = 'bo-claude'`)).rows;
  for (let i = 0; i < 4; i++) await kolab.sendMessage(boAgent, 'ann', `to a person ${i}`);
  expect((await kolab.db.query<{ run: number }>(`select run from kolab_chat_agent where actor_id = 'bo-claude'`)).rows).toStrictEqual(before);
  expect((await kolab.unreadMessages(ann)).items.every((m) => m.capped === undefined)).toBe(true);

  // A person's message anywhere, here a direct one, starts every agent's run again.
  await kolab.sendMessage(bo, 'ann', 'carry on');
  const d = await kolab.sendMessage(helper, 'bo-claude', 'again');
  const c = await kolab.sendChannelMessage(annAgent, 'one', 'again', { mentions: ['bo/claude'] });
  expect((await kolab.unreadMessages(boAgent)).items.at(-1)).toStrictEqual(d);
  expect((await kolab.unreadChannels(boAgent)).flatMap((x) => x.items).find((m) => m.id === c.id)).toMatchObject({ capped: false, wakes: true });
  // Two agents looping in direct messages stop waking each other at the cap.
  await kolab.sendMessage(ann, 'bo', 'reset');
  const loop = [];
  for (let i = 0; i < 3; i++) {
    loop.push(await kolab.sendMessage(annAgent, 'bo-claude', `ping ${i}`));
    loop.push(await kolab.sendMessage(boAgent, 'ann-claude', `pong ${i}`));
  }
  const capped = async (s: string, ids: string[]) => (await kolab.unreadMessages(s)).items.filter((m) => ids.includes(m.id)).map((m) => m.capped ?? false);
  expect(await capped(boAgent, loop.filter((m) => m.from === 'ann-claude').map((m) => m.id))).toStrictEqual([false, false, true]);
  expect(await capped(annAgent, loop.filter((m) => m.from === 'bo-claude').map((m) => m.id))).toStrictEqual([false, false, true]);
});

test('a mention sent before an agent is first seen following the channel still wakes it: its position starts just before its oldest mention', async () => {
  const { kolab, ann } = await hub();
  await kolab.sendChannelMessage(ann, 'general', 'long ago');
  await kolab.addActor('ann-helper', { owner: 'ann' });
  await kolab.grant('hub', 'ann-helper', 'write');
  await kolab.sendChannelMessage(ann, 'general', 'before');
  const early = await kolab.sendChannelMessage(ann, 'general', 'helper, when you start, look here', { mentions: ['ann/helper'] });
  const after = await kolab.sendChannelMessage(ann, 'general', 'and this');
  const helper = await kolab.openSession('ann-helper', 'product', { kolab: 'hub' });
  // list_channels writes nothing, and counts from where the position would start.
  expect((await kolab.channelsPage(helper)).items[0]).toMatchObject({ channel: 'general', unread: 2, mentions: 1 });
  expect((await kolab.db.query(`select 1 from channel_read where actor_id = 'ann-helper'`)).rows).toStrictEqual([]);
  const general = (await kolab.unreadChannels(helper))[0];
  expect(general.items.map((m) => [m.id, m.wakes])).toStrictEqual([[early.id, true], [after.id, false]]);
  // The position stays where it started.
  expect((await kolab.unreadChannels(helper))[0].items.map((m) => m.id)).toStrictEqual([early.id, after.id]);
  // A channel whose oldest message mentions it starts from nothing read.
  await kolab.makeChannel(ann, 'fresh');
  await kolab.sendChannelMessage(ann, 'fresh', 'first, for helper', { mentions: ['ann/helper'] });
  await kolab.sendChannelMessage(ann, 'fresh', 'second');
  await kolab.followChannel(helper, 'fresh', true);
  expect((await kolab.readChannel(helper, 'fresh')).messages.map((m) => m.message)).toStrictEqual(['first, for helper', 'second']);
});

test('an agent\'s first position is not written when its kolab is archived; the answers still read', async () => {
  const { kolab, ann } = await hub();
  await kolab.addActor('ann-helper', { owner: 'ann' });
  await kolab.grant('hub', 'ann-helper', 'write');
  await kolab.sendChannelMessage(ann, 'general', 'hi');
  // Archiving ends the kolab's sessions, so a read that gets this far began before it: the write is skipped, not raised.
  await kolab.db.query(`update kolab set archived_at = now() where id = 'hub'`);
  const start = (kolab as unknown as { startAgentPositions(s: object): Promise<void> }).startAgentPositions.bind(kolab);
  await expect(start({ id: 'x', actor_id: 'ann-helper', kolab: 'hub', kind: 'agent', owner: 'ann' })).resolves.toBeUndefined();
  expect((await kolab.db.query(`select 1 from channel_read where actor_id = 'ann-helper'`)).rows).toStrictEqual([]);
});

// Under KONJIR_TEST_POSTGRES, on a server's planner; on PGlite too. With sequential scans off, each
// count must be able to read an index range from the position on: a plan that can't falls back to a
// sequential scan and fails.
test('each of a channel\'s counts is a range of one index from the member\'s position', async () => {
  const { kolab, bo } = await hub();
  const plan = await kolab.db.transaction(async (tx) => {
    await tx.exec('set local enable_seqscan = off');
    return JSON.stringify((await tx.query<{ 'QUERY PLAN': unknown }>(`explain (format json) ${CHANNEL_COUNTS_SQL}`,
      ['hub', 'bo', 'general', UNREAD_COUNT_CEILING + 1, null, MAX_CHANNELS, false, 2 * UNREAD_COUNT_CEILING])).rows[0]['QUERY PLAN']);
  });
  const nodes: { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Index Cond'?: string }[] = [];
  const walk = (n: Record<string, unknown>) => { nodes.push(n as never); for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c); };
  walk((JSON.parse(plan) as { Plan: Record<string, unknown> }[])[0].Plan);
  const on = (rel: string) => nodes.filter((n) => n['Relation Name'] === rel);
  expect(on('channel_message').map((n) => [n['Node Type'].replace('Only ', ''), n['Index Name']]))
    .toEqual(expect.arrayContaining([['Index Scan', 'channel_message_in']]));
  expect(on('channel_message').filter((n) => n['Index Name'] === 'channel_message_in').some((n) => /channel_id.*id > /s.test(n['Index Cond'] ?? ''))).toBe(true);
  expect(on('channel_mention').some((n) => n['Index Name'] === 'channel_mention_actor' && /message_id > /.test(n['Index Cond'] ?? ''))).toBe(true);
  expect(nodes.some((n) => n['Node Type'] === 'Seq Scan' && ['channel_message', 'channel_mention'].includes(n['Relation Name'] ?? ''))).toBe(false);
  expect(typeof bo).toBe('string');
});

test('a mention in a channel the agent doesn\'t follow, after a long history, is where its reading starts: the mention wakes it, and reading the channel begins there', async () => {
  const { kolab, ann, boAgent } = await hub();
  Object.assign(kolab.rates, { messages: Infinity });
  await kolab.makeChannel(ann, 'side');
  for (let i = 1; i <= MESSAGES_AT_ONCE + 5; i++) await kolab.sendChannelMessage(ann, 'side', `history ${i}`);
  const mention = await kolab.sendChannelMessage(ann, 'side', 'bo-claude, over here', { mentions: ['bo/claude'] });
  await kolab.sendChannelMessage(ann, 'side', 'after it');
  const side = (await kolab.unreadChannels(boAgent)).find((c) => c.channel === 'side')!;
  expect([side.following, side.items.map((m) => [m.id, m.wakes])]).toStrictEqual([false, [[mention.id, true]]]);
  const read = await kolab.readChannel(boAgent, 'side');
  expect([read.messages.map((m) => m.message), read.more]).toStrictEqual([['bo-claude, over here', 'after it'], 0]);
  expect((await kolab.unreadChannels(boAgent)).find((c) => c.channel === 'side')).toBeUndefined();
});

test('a member\'s own messages never pile up after its read position: a send moves it when nothing of others\' is unread, and reading passes a tail of its own', async () => {
  const { kolab, ann, bo } = await hub();
  Object.assign(kolab.rates, { messages: Infinity });
  // Posting alone, read up or with nothing read: the position follows each message.
  for (let i = 0; i < 5; i++) await kolab.sendChannelMessage(bo, 'general', `alone ${i}`);
  const at = async (who: string) => (await kolab.db.query<{ read_to: string | null }>(`select read_to from channel_read where channel_id = 'general:hub' and actor_id = $1`, [who])).rows[0]?.read_to;
  const last = (await kolab.channelMessagesPage(bo, 'general', { limit: 1 })).items[0].id;
  expect(await at('bo')).toBe(last);
  expect((await kolab.channelsPage(bo)).items[0]).toMatchObject({ unread: 0, unread_more: false });
  // With something of others' unread, a send leaves the position where it was.
  const theirs = await kolab.sendChannelMessage(ann, 'general', 'from ann');
  await kolab.sendChannelMessage(bo, 'general', 'bo again');
  expect(await at('bo')).toBe(last);
  expect((await kolab.readChannel(bo, 'general')).messages.map((m) => m.id)).toStrictEqual([theirs.id]);

  // A tail of its own longer than a read looks ahead (written before this rule): reading passes it.
  await kolab.db.query(
    `insert into channel_message(id, kolab_id, channel_id, sent_by, body, agent_run)
     select '01Z' || lpad(g::text, 23, '0'), 'hub', 'general:hub', 'bo', 'mine', 0 from generate_series(1, $1::int) g`, [2 * UNREAD_COUNT_CEILING + 50]);
  await kolab.db.query(`insert into channel_message(id, kolab_id, channel_id, sent_by, body, agent_run) values ('01ZZ', 'hub', 'general:hub', 'ann', 'after the tail', 0)`);
  expect(await kolab.readChannel(bo, 'general')).toStrictEqual({ channel: 'general', messages: [], more: 0 });
  expect((await kolab.readChannel(bo, 'general')).messages.map((m) => m.message)).toStrictEqual(['after the tail']);
});

test('the answers count the unread direct messages that may wake, read as unreadMessages reads them, up to the ceiling, then say there are more', async () => {
  const { kolab, ann, annAgent, boAgent } = await hub();
  await kolab.sendMessage(ann, 'bo-claude', 'one');
  await kolab.sendMessage(annAgent, 'bo-claude', 'two');
  expect(await kolab.wakingMessages(boAgent)).toStrictEqual({ waking: 2 });
  await kolab.readMessages(boAgent);
  expect(await kolab.wakingMessages(boAgent)).toStrictEqual({ waking: 0 });
  await kolab.db.query(
    `insert into message(id, kolab_id, sent_by, sent_to, body) select '01M' || lpad(g::text, 23, '0'), 'hub', 'ann', 'bo-claude', 'm' from generate_series(1, $1::int) g`, [UNREAD_COUNT_CEILING + 1]);
  expect(await kolab.wakingMessages(boAgent)).toStrictEqual({ waking: UNREAD_COUNT_CEILING, waking_more: true });
});

test('an agent\'s run never goes back: a newer person_seq a send of its own already counted against is kept, and the run goes on', async () => {
  const { kolab, annAgent } = await hub();
  await kolab.sendChannelMessage(annAgent, 'general', 'one', { mentions: ['bo'] });
  // As if a send of this agent's, which read a newer person_seq, committed between this one's read and its lock.
  await kolab.db.query(`update kolab_chat_agent set person_seq = person_seq + 5 where actor_id = 'ann-claude'`);
  await kolab.sendChannelMessage(annAgent, 'general', 'two');
  expect((await kolab.db.query(`select run, (k.person_seq - a.person_seq)::int as behind from kolab_chat_agent a join kolab_chat k using (kolab_id) where a.actor_id = 'ann-claude'`)).rows)
    .toStrictEqual([{ run: 2, behind: -5 }]);
});
