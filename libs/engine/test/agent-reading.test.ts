// A person reads their own agents' messages (Lee, 2026-11-22, PR #211): the agent's direct
// conversations and messages, one timeline of everything their agents sent and received, and each
// agent's status for konnect's app's Home. Only the owner, a person, from any of their sessions in a
// kolab both are members of; never an agent, another person, another kolab, or an organization's
// agent. Reading moves nothing: no receipt, no read position, no wake, no budget. And every party to
// a direct message with an agent is told its owner can read it (Member.owner_reads, readable_by).
import { expect, test } from '@jest/globals';
import { isInboxEvent, type KolabEvent } from '@konjir/types';
import { openKolab, rejection } from '@konjir/engine/testing';

/**
 * Ann owns hub; Bo writes there; Ann has two agents there, ann-claude and ann-codex, Bo one, bo-claude.
 * cy is in side alone, with ann-claude too.
 */
async function hub() {
  const k = await openKolab();
  for (const id of ['ann', 'bo', 'cy']) await k.addActor(id);
  for (const [id, owner] of [['ann-claude', 'ann'], ['ann-codex', 'ann'], ['bo-claude', 'bo']]) await k.addActor(id, { owner });
  await k.createKolab('hub', { owner: 'ann' });
  for (const id of ['bo', 'ann-claude', 'ann-codex', 'bo-claude']) await k.grant('hub', id, 'write');
  const s = {
    ann: await k.openSession('ann', 'product', { kolab: 'hub' }),
    bo: await k.openSession('bo', 'engineer', { kolab: 'hub' }),
    claude: await k.openSession('ann-claude', 'engineer', { kolab: 'hub' }),
    codex: await k.openSession('ann-codex', 'engineer', { kolab: 'hub' }),
    boAgent: await k.openSession('bo-claude', 'engineer', { kolab: 'hub' }),
  };
  const events: KolabEvent[] = [];
  k.onEvent((e) => { if (isInboxEvent(e)) events.push(e); });
  return { kolab: k, ...s, events };
}

/** Every receipt, read position, loop-cap count and rate hold: what reading must leave as it was. */
const state = async (k: Awaited<ReturnType<typeof hub>>['kolab']) => {
  const rows = async (sql: string) => (await k.db.query(sql)).rows;
  return {
    receipts: await rows(`select message_id, read_at from message_receipt order by message_id`),
    positions: await rows(`select channel_id, actor_id, read_to from channel_read order by channel_id, actor_id`),
    runs: await rows(`select * from kolab_chat_agent order by actor_id`),
    chat: await rows(`select * from kolab_chat order by kolab_id`),
    rates: await rows(`select count(*)::int as n from rate_event`),
  };
};

test('the owner reads their agent\'s conversations and messages, as the agent would, its unread its own; a non-owner, an agent, an unknown name and another kolab are refused', async () => {
  const { kolab, ann, bo, claude, boAgent } = await hub();
  const m1 = await kolab.sendMessage(bo, 'ann-claude', 'Can you take the importer?');
  const m2 = await kolab.sendMessage(claude, 'bo', 'Yes, after lunch.');
  const m3 = await kolab.sendMessage(boAgent, 'ann-claude', 'I have the exporter.');
  // The agent's own view, beside the owner's: the same conversations, the same unread.
  const own = await kolab.conversationsPage(claude);
  for (const agent of ['claude', 'ann/claude', 'ann-claude', '@ann/claude']) {
    const r = await kolab.agentConversationsPage(ann, agent);
    expect([agent, r.agent, r.items]).toStrictEqual([agent, 'ann-claude', own.items]);
  }
  expect(own.items.map((c) => [c.with, c.last.id, c.unread])).toStrictEqual([['bo-claude', m3.id, 1], ['bo', m2.id, 1]]);
  // The messages with one member, newest first, as list_messages with=<member> gives the agent its own.
  const msgs = await kolab.agentMessagesPage(ann, 'claude', 'bo');
  expect([msgs.agent, msgs.with, msgs.items]).toStrictEqual(['ann-claude', 'bo', (await kolab.messagesPage(claude, { with: 'bo' })).items]);
  expect(msgs.items.map((m) => m.id)).toStrictEqual([m2.id, m1.id]);
  expect((await kolab.agentMessagesPage(ann, 'claude', 'bo/claude')).items.map((m) => m.id)).toStrictEqual([m3.id]);
  // Paged as list_messages is.
  const first = await kolab.agentMessagesPage(ann, 'claude', 'bo', { limit: 1 });
  expect(first.items.map((m) => m.id)).toStrictEqual([m2.id]);
  expect((await kolab.agentMessagesPage(ann, 'claude', 'bo', { cursor: first.next!, limit: 1 })).items.map((m) => m.id)).toStrictEqual([m1.id]);

  // Not Bo's to read, though he is in the conversation; nor any agent's, its own included.
  const notYours = /AccessError: .* names no agent of yours in kolab hub/;
  expect(await rejection(kolab.agentConversationsPage(bo, 'ann/claude'))).toMatch(notYours);
  expect(await rejection(kolab.agentMessagesPage(bo, 'ann/claude', 'bo'))).toMatch(notYours);
  expect(await rejection(kolab.agentConversationsPage(ann, 'bo/claude'))).toMatch(notYours);
  expect(await rejection(kolab.agentConversationsPage(ann, 'nobody'))).toMatch(notYours);
  expect(await rejection(kolab.agentConversationsPage(ann, 'bo'))).toMatch(notYours);
  for (const call of [kolab.agentConversationsPage(claude, 'claude'), kolab.agentMessagesPage(boAgent, 'ann/claude', 'bo'), kolab.agentActivity(claude), kolab.myAgentsStatus(boAgent)]) {
    expect(await rejection(call)).toMatch(/AccessError: .* is an agent: only a person reads their own agents' messages/);
  }
  expect(await rejection(kolab.agentMessagesPage(ann, 'claude', ' '))).toMatch(/LimitError: name the member/);

  // Removed from hub, it is no longer read there.
  await kolab.revoke('hub', 'ann-claude');
  expect(await rejection(kolab.agentConversationsPage(ann, 'claude'))).toMatch(notYours);
  await kolab.grant('hub', 'ann-claude', 'write');

  // Another kolab: the reads are the session's kolab's alone, and an agent that isn't a member there is refused.
  await kolab.createKolab('side', { owner: 'cy' });
  await kolab.grant('side', 'ann', 'write');
  await kolab.endSession(ann);
  const annSide = await kolab.openSession('ann', 'product', { kolab: 'side' });
  expect(await rejection(kolab.agentConversationsPage(annSide, 'claude'))).toMatch(/names no agent of yours in kolab side/);
  await kolab.grant('side', 'ann-claude', 'write');
  expect((await kolab.agentConversationsPage(annSide, 'claude')).items).toStrictEqual([]);
  expect((await kolab.agentActivity(annSide)).items).toStrictEqual([]);
  expect((await kolab.agentMessagesPage(annSide, 'claude', 'bo')).items).toStrictEqual([]);
});

test('reading never writes: no receipt, no read position, no loop-cap count, no rate, no event', async () => {
  const { kolab, ann, bo, claude, events } = await hub();
  await kolab.sendMessage(bo, 'ann-claude', 'unread, and stays so');
  await kolab.sendChannelMessage(bo, 'general', 'hello @ann/claude', { mentions: ['ann/claude'] });
  await kolab.sendChannelMessage(claude, 'general', 'hi');
  const before = await state(kolab);
  events.length = 0;
  await kolab.agentConversationsPage(ann, 'claude');
  await kolab.agentMessagesPage(ann, 'claude', 'bo');
  await kolab.agentActivity(ann);
  await kolab.agentActivity(ann, { agent: 'claude' });
  await kolab.myAgentsStatus(ann);
  expect(await state(kolab)).toStrictEqual(before);
  expect(events).toStrictEqual([]);
  expect((await kolab.unreadMessages(claude)).unread).toBe(1);
});

test('an organization\'s agent is refused, for now', async () => {
  const kolab = await openKolab();
  await kolab.addOrganization('acme');
  await kolab.addActor('olga');
  await kolab.addMember('acme', 'olga', 'owner');
  await kolab.createKolab('shop', { owner: 'acme' });
  await kolab.addActor('acme-bot', { owner: 'acme' });
  await kolab.grant('shop', 'acme-bot', 'write');
  await kolab.grant('shop', 'olga', 'admin');
  const olga = await kolab.openSession('olga', 'product', { kolab: 'shop' });
  expect(await rejection(kolab.agentConversationsPage(olga, 'acme/bot'))).toMatch(/AccessError: acme\/bot is an organization's agent: reading an organization's agents' messages isn't open yet/);
  expect(await rejection(kolab.agentConversationsPage(olga, 'acme-bot'))).toMatch(/an organization's agent/);
  expect((await kolab.myAgentsStatus(olga)).agents).toStrictEqual([]);
  // And no one is said to read its messages.
  const members = (await kolab.membersPage(olga)).items;
  expect(members.find((m) => m.actor === 'acme-bot')).not.toHaveProperty('owner_reads');
});

test('activity is one timeline of both: channel messages an agent sent or that mention it, and direct messages to or from it, newest first, each once, paged by id', async () => {
  const { kolab, ann, bo, claude, codex, boAgent } = await hub();
  await kolab.makeChannel(bo, 'deploys');
  const a = await kolab.sendChannelMessage(claude, 'general', 'build is green');
  const b = await kolab.sendMessage(bo, 'ann-codex', 'can you look at the flaky test?');
  await kolab.sendChannelMessage(bo, 'general', 'no agent of Ann\'s here');
  const c = await kolab.sendChannelMessage(bo, 'deploys', 'shipping, @ann/codex @ann/claude', { mentions: ['ann/codex', 'ann/claude'] });
  const d = await kolab.sendMessage(claude, 'ann-codex', 'I can pair on it');
  await kolab.sendMessage(boAgent, 'bo', 'not Ann\'s');
  const e = await kolab.sendMessage(codex, 'ann', 'done: it was a race');

  const all = await kolab.agentActivity(ann);
  expect(all.items.map((i) => [i.kind, i.agent, i.id])).toStrictEqual([
    ['dm', 'ann-codex', e.id], ['dm', 'ann-claude', d.id], ['channel', 'ann-claude', c.id], ['dm', 'ann-codex', b.id], ['channel', 'ann-claude', a.id],
  ]);
  expect(all.items[0]).toStrictEqual({ kind: 'dm', agent: 'ann-codex', id: e.id, from: 'ann-codex', to: 'ann', message: 'done: it was a race', reply_to: null, sent_at: e.sent_at });
  expect(all.items[2]).toStrictEqual({ kind: 'channel', agent: 'ann-claude', id: c.id, from: 'bo', channel: 'deploys', message: 'shipping, @ann/codex @ann/claude', reply_to: null, mentions: ['ann-claude', 'ann-codex'], sent_at: c.sent_at });
  // One agent's alone.
  expect((await kolab.agentActivity(ann, { agent: 'codex' })).items.map((i) => [i.agent, i.id])).toStrictEqual([['ann-codex', e.id], ['ann-codex', d.id], ['ann-codex', c.id], ['ann-codex', b.id]]);
  // Paged by id.
  const p1 = await kolab.agentActivity(ann, {}, { limit: 2 });
  const p2 = await kolab.agentActivity(ann, {}, { limit: 2, cursor: p1.next! });
  const p3 = await kolab.agentActivity(ann, {}, { limit: 2, cursor: p2.next! });
  expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).toStrictEqual(all.items.map((i) => i.id));
  expect(p3.next).toBeNull();
  // A cursor is the list's it came from.
  expect(await rejection(kolab.agentActivity(ann, { agent: 'codex' }, { cursor: p1.next! }))).toMatch(/LimitError/);
  // Past the loop cap, an agent's message is marked capped.
  await kolab.setAgentReplyCap(ann, 1);
  await kolab.sendChannelMessage(bo, 'general', 'a person writes, and every agent\'s run starts again');
  await kolab.sendChannelMessage(claude, 'general', 'one');
  const capped = await kolab.sendChannelMessage(claude, 'general', 'two');
  expect((await kolab.agentActivity(ann, { agent: 'claude' })).items[0]).toMatchObject({ id: capped.id, capped: true });
  expect((await kolab.agentActivity(ann, { agent: 'claude' })).items[1]).not.toHaveProperty('capped');
});

test('status: here, the newest message, the agent\'s unread, and what it needs of its owner: its unread messages and mentions to them, the loop cap reached', async () => {
  const { kolab, ann, bo, claude, codex } = await hub();
  const quiet = (await kolab.myAgentsStatus(ann));
  expect(quiet).toStrictEqual({ kolab: 'hub', agents: [
    { agent: 'ann-claude', label: 'claude', state: null, here: true, last: null, unread: 0, channels: [{ channel: 'general', unread: 0 }], needs_you: { mentioned_unread: 0, capped: 0, not_running_with_unread: 0 } },
    { agent: 'ann-codex', label: 'codex', state: null, here: true, last: null, unread: 0, channels: [{ channel: 'general', unread: 0 }], needs_you: { mentioned_unread: 0, capped: 0, not_running_with_unread: 0 } },
  ] });
  // Claude writes to Ann twice and mentions her once; Bo writes to Claude and mentions it.
  const long = `${'x'.repeat(120)}`;
  const first = await kolab.sendMessage(claude, 'ann', 'a question for you');
  await kolab.sendMessage(claude, 'ann', long);
  await kolab.sendChannelMessage(claude, 'general', 'see this, @ann', { mentions: ['ann'] });
  await kolab.sendMessage(bo, 'ann-claude', 'and one for you');
  await kolab.sendChannelMessage(bo, 'general', '@ann/claude please', { mentions: ['ann/claude'] });
  await kolab.endSession(codex);
  const [c, x] = (await kolab.myAgentsStatus(ann)).agents;
  expect(c).toMatchObject({ agent: 'ann-claude', here: true, unread: 2, needs_you: { mentioned_unread: 3, capped: 0 } });
  expect(c.last).toStrictEqual({ kind: 'channel', at: expect.any(String), summary: '@ann/claude please' });
  expect(x).toMatchObject({ agent: 'ann-codex', here: false, last: null, unread: 0 });
  // Its channels: the ones it follows, and one it doesn't but was mentioned in, each with its own unread.
  await kolab.makeChannel(bo, 'deploys');
  await kolab.sendChannelMessage(bo, 'deploys', 'for you, @ann/codex', { mentions: ['ann/codex'] });
  await kolab.sendChannelMessage(bo, 'deploys', 'and more');
  expect((await kolab.myAgentsStatus(ann)).agents[1].channels.map((ch) => ch.channel)).toStrictEqual(['deploys', 'general']);
  expect((await kolab.myAgentsStatus(ann)).agents[0].channels.map((ch) => ch.channel)).toStrictEqual(['general']);
  // Ann reads the first of Claude's messages, and general: what is left for her goes down.
  await kolab.markMessagesRead(ann, 'ann/claude', first.id);
  await kolab.readChannel(ann, 'general');
  expect((await kolab.myAgentsStatus(ann)).agents[0].needs_you.mentioned_unread).toBe(1);
  // The newest, long, is cut to its first 100 characters.
  const last = await kolab.sendMessage(claude, 'bo', long);
  expect((await kolab.myAgentsStatus(ann)).agents[0].last).toStrictEqual({ kind: 'dm', at: last.sent_at, summary: 'x'.repeat(100) });
  // The cap: Claude's run since a person last wrote reaches it; a person's message starts it again.
  await kolab.setAgentReplyCap(ann, 2);
  await kolab.sendChannelMessage(claude, 'general', 'one');
  expect((await kolab.myAgentsStatus(ann)).agents[0].needs_you.capped).toBe(0);
  await kolab.sendChannelMessage(claude, 'general', 'two');
  expect((await kolab.myAgentsStatus(ann)).agents[0].needs_you.capped).toBe(1);
  await kolab.sendChannelMessage(claude, 'general', 'three, which wakes no agent');
  expect((await kolab.myAgentsStatus(ann)).agents[0].needs_you.capped).toBe(2);
  await kolab.sendChannelMessage(bo, 'general', 'a person writes');
  expect((await kolab.myAgentsStatus(ann)).agents[0].needs_you.capped).toBe(0);
});

test('a message to or from an agent signals its owner\'s answers too, in a direct message or a channel, once', async () => {
  const { kolab, bo, claude, boAgent, events } = await hub();
  const told = () => events.flatMap((e) => ('actor' in e ? [e.actor] : [])).sort();
  events.length = 0;
  await kolab.sendMessage(bo, 'ann-claude', 'to Ann\'s agent');
  expect(told()).toStrictEqual(['ann', 'ann-claude']);
  events.length = 0;
  await kolab.sendMessage(claude, 'bo', 'from Ann\'s agent');
  expect(told()).toStrictEqual(['ann', 'bo']);
  events.length = 0;
  await kolab.sendMessage(boAgent, 'ann-claude', 'between agents');
  expect(told()).toStrictEqual(['ann', 'ann-claude', 'bo']);
  // A channel Ann doesn't follow: she hears of her agent's message there, and of a mention of one.
  await kolab.makeChannel(bo, 'deploys');
  events.length = 0;
  await kolab.sendChannelMessage(bo, 'deploys', 'nothing of Ann\'s');
  expect(told()).not.toContain('ann');
  events.length = 0;
  await kolab.sendChannelMessage(bo, 'deploys', '@ann/claude', { mentions: ['ann/claude'] });
  expect(told()).toContain('ann');
  events.length = 0;
  await kolab.sendChannelMessage(claude, 'deploys', 'from Ann\'s agent');
  expect(told().filter((a) => a === 'ann')).toStrictEqual(['ann']);
});

test('disclosure: an agent whose owner is a member says owner_reads, and every direct message with one, and its conversation, names who else reads it', async () => {
  const { kolab, ann, bo, claude, boAgent } = await hub();
  const members = (await kolab.membersPage(bo)).items;
  expect(Object.fromEntries(members.map((m) => [m.actor, m.owner_reads ?? false]))).toStrictEqual({ ann: false, 'ann-claude': true, 'ann-codex': true, bo: false, 'bo-claude': true });
  // The send's result, when either end is an agent.
  expect(await kolab.sendMessage(bo, 'ann-claude', 'hi')).toMatchObject({ readable_by: ['ann'] });
  expect(await kolab.sendMessage(boAgent, 'ann-claude', 'hi')).toMatchObject({ readable_by: ['ann', 'bo'] });
  // The owner and their own agent: no one else.
  expect(await kolab.sendMessage(ann, 'ann-claude', 'hi')).not.toHaveProperty('readable_by');
  expect(await kolab.sendMessage(ann, 'bo', 'between people')).not.toHaveProperty('readable_by');
  // list_messages, read_messages, list_conversations say the same.
  expect((await kolab.messagesPage(bo, { with: 'ann/claude' })).items.map((m) => m.readable_by)).toStrictEqual([['ann']]);
  expect((await kolab.readMessages(claude)).messages.map((m) => [m.from, m.readable_by])).toStrictEqual([['bo', ['ann']], ['bo-claude', ['ann', 'bo']], ['ann', undefined]]);
  const convs = await kolab.conversationsPage(claude);
  expect(convs.items.map((c) => [c.with, c.readable_by, c.last.readable_by])).toStrictEqual([['ann', undefined, undefined], ['bo-claude', ['ann', 'bo'], ['ann', 'bo']], ['bo', ['ann'], ['ann']]]);
  expect((await kolab.conversationsPage(bo)).items.map((c) => [c.with, c.readable_by])).toStrictEqual([['ann', undefined], ['ann-claude', ['ann']]]);
  // An agent no longer a member is read by no one: its owner can't read it there.
  await kolab.revoke('hub', 'ann-claude');
  expect((await kolab.messagesPage(bo, { with: 'ann-claude' })).items.map((m) => m.readable_by)).toStrictEqual([undefined]);
});
