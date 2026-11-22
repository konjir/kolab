import { describe, expect, test } from '@jest/globals';
import { readersOf, type AgentActivityItem, type AgentStatus } from '../src/kolab/agents';
import {
  agentChannels, agentNotifyOf, agentsIn, ago, at, contextOf, disclosureOf, lastLine, legacyAgentNotify, needsYouCount, needsYouWords,
  onlyAgent, ownAgents, readOnlyBanner, whereOf, yourAgentsActivity,
} from '../src/kolab/your-agents';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const members = [
  { actor: 'ann', kind: 'person' as const, owner: null, label: null },
  { actor: 'bo', kind: 'person' as const, owner: null, label: null },
  { actor: 'ann-helper', kind: 'agent' as const, owner: 'ann', label: 'helper', owner_reads: true },
  { actor: 'ann-reviewer', kind: 'agent' as const, owner: 'ann', label: 'reviewer', owner_reads: true },
  { actor: 'bo-builder', kind: 'agent' as const, owner: 'bo', label: 'builder', owner_reads: true },
];
const status = (agent: string, over: Partial<AgentStatus> = {}): AgentStatus => ({
  agent, label: null, state: null, here: false, last: null, unread: 0, channels: [], needs_you: { mentioned_unread: 0, capped: 0, not_running_with_unread: 0 }, ...over,
});
const item = (over: Partial<AgentActivityItem>): AgentActivityItem => ({ kind: 'dm', agent: 'ann-helper', id: 'm1', from: 'bo', to: 'ann-helper', message: 'hi', reply_to: null, sent_at: '2026-11-22T11:58:00Z', ...over });

describe('Kolab\'s owner tools, as the app reads them', () => {
  test('who else can read a DM: everyone its messages\' readable_by name, once each', () => {
    expect(readersOf([{ readable_by: ['ann'] }, {}, { readable_by: ['ann', 'bo'] }])).toEqual(['ann', 'bo']);
    expect(readersOf([{}, {}])).toEqual([]);
  });
});

describe('Home\'s Agents section', () => {
  test('your agents are the ones you own', () => {
    expect(ownAgents(members, 'ann').map((m) => m.actor)).toEqual(['ann-helper', 'ann-reviewer']);
    expect(ownAgents(members, '')).toEqual([]);
  });

  test('one line of what it did last, and when', () => {
    expect(ago('2026-11-22T11:59:30Z', NOW)).toBe('now');
    expect(ago('2026-11-22T11:58:00Z', NOW)).toBe('2m');
    expect(ago('2026-11-22T09:00:00Z', NOW)).toBe('3h');
    expect(ago('2026-11-20T12:00:00Z', NOW)).toBe('2d');
    expect(lastLine(status('ann-helper', { last: { kind: 'channel', at: '2026-11-22T11:58:00Z', summary: 'replied to @bo in #general' } }), NOW)).toBe('replied to @bo in #general · 2m');
    expect(lastLine(status('ann-helper'), NOW)).toBeUndefined();
    expect(lastLine(undefined, NOW)).toBeUndefined();
  });

  test('"needs you" when anything waits, said in words', () => {
    expect(needsYouCount(status('a').needs_you)).toBe(0);
    const n = { mentioned_unread: 1, capped: 2, not_running_with_unread: 3 };
    expect(needsYouCount(n)).toBe(6);
    expect(needsYouWords(n)).toEqual(['1 unread mention', '2 capped', 'not running, 3 unread']);
    expect(needsYouWords(undefined)).toEqual([]);
  });
});

describe('the agent screen', () => {
  test('each row says where it was, and opens it: the channel, or the DM read-only', () => {
    expect(whereOf(item({ kind: 'channel', channel: 'general', to: undefined }), members)).toBe('#general');
    expect(whereOf(item({}), members)).toBe('DM with @bo');
    expect(whereOf(item({ from: 'ann-helper', to: 'bo-builder' }), members)).toBe('DM with @bo/builder');
    expect(contextOf(item({ kind: 'channel', channel: 'general' }))).toEqual({ kind: 'channel', name: 'general' });
    expect(contextOf(item({ from: 'ann-helper', to: 'bo' }))).toEqual({ kind: 'dm', name: 'bo', as: 'ann-helper' });
  });

  test('its channels: Kolab\'s, with the backlog, most first; until its status is read, those its activity names', () => {
    expect(agentChannels(status('a', { channels: [{ channel: 'design', unread: 1 }, { channel: 'general', unread: 4 }] }), [])).toEqual([{ channel: 'general', unread: 4 }, { channel: 'design', unread: 1 }]);
    const items = [item({ kind: 'channel', channel: 'general', sent_at: 'b' }), item({ id: 'm2' }), item({ id: 'm3', kind: 'channel', channel: 'general', sent_at: 'a' }), item({ id: 'm4', kind: 'channel', channel: 'design', sent_at: 'c' })];
    expect(agentChannels(undefined, items)).toEqual([{ channel: 'general', last: 'b' }, { channel: 'design', last: 'c' }]);
  });

  test('the read-only banner names both sides', () => {
    expect(readOnlyBanner(at('ann-helper', members), at('bo', members))).toBe("@ann/helper's conversation with @bo · read-only");
  });
});

describe('the Activity tab\'s "Your agents"', () => {
  test('DMs to them, mentions of them, capped; not their own messages; stuck agents first; newest first', () => {
    const statuses = [status('ann-helper', { needs_you: { mentioned_unread: 0, capped: 0, not_running_with_unread: 2 } }), status('ann-reviewer')];
    const rows = yourAgentsActivity([
      item({ id: 'dm', sent_at: '2026-11-22T11:00:00Z' }),
      item({ id: 'own', from: 'ann-helper', to: 'bo', sent_at: '2026-11-22T11:30:00Z' }),
      item({ id: 'mention', kind: 'channel', channel: 'general', to: undefined, mentions: ['ann/helper'], sent_at: '2026-11-22T11:10:00Z' }),
      item({ id: 'plain', kind: 'channel', channel: 'general', to: undefined, mentions: [], sent_at: '2026-11-22T11:20:00Z' }),
      item({ id: 'capped', agent: 'ann-reviewer', kind: 'channel', channel: 'general', from: 'bo-builder', to: undefined, capped: true, sent_at: '2026-11-22T11:40:00Z' }),
      item({ id: 'theirs', agent: 'bo-builder', to: 'bo-builder', from: 'bo', sent_at: '2026-11-22T11:50:00Z' }),
    ], statuses, members);
    expect(rows.map((r) => ('item' in r ? `${r.kind}:${r.item.id}` : `${r.kind}:${r.agent}:${r.unread}`))).toEqual(['stuck:ann-helper:2', 'capped:capped', 'mention:mention', 'dm:dm']);
  });
});

describe('a channel\'s "Only @you/bot"', () => {
  const msgs = [
    { id: '1', from: 'bo', message: 'hello', mentions: [] },
    { id: '2', from: 'ann-helper', message: 'done' },
    { id: '3', from: 'bo', message: '@ann/helper thanks', mentions: ['ann/helper'] },
    { id: '4', from: 'ann-reviewer', message: 'lgtm' },
  ];
  test('shows what your agent sent there or was mentioned in', () => {
    expect(onlyAgent(msgs, members[2]!).map((m) => m.id)).toEqual(['2', '3']);
  });
  test('is offered for your agents that have spoken there', () => {
    expect(agentsIn(msgs, ownAgents(members, 'ann')).map((a) => a.actor)).toEqual(['ann-helper', 'ann-reviewer']);
    expect(agentsIn(msgs, ownAgents(members, 'bo'))).toEqual([]);
  });
});

describe('the disclosure in a DM with an agent', () => {
  test('says the owner can read it, from Kolab\'s owner_reads', () => {
    expect(disclosureOf(members[4], 'ann')).toBe('@bo, its owner, can read this conversation');
    expect(disclosureOf(members[2], 'bo')).toBe('@ann, its owner, can read this conversation');
  });
  test('is driven by Kolab\'s fields alone: nothing without them, and the readers a result names', () => {
    expect(disclosureOf({ ...members[4]!, owner_reads: false }, 'ann')).toBeUndefined();
    expect(disclosureOf({ ...members[4]!, owner_reads: false }, 'ann', ['bo'])).toBe('@bo, its owner, can read this conversation');
    expect(disclosureOf({ ...members[4]!, owner_reads: false }, 'ann', ['cy', 'dee'])).toBe('@cy, @dee can read this conversation');
  });
  test('isn\'t said to the owner, nor in a DM with a person', () => {
    expect(disclosureOf(members[2], 'ann')).toBeUndefined();
    expect(disclosureOf(members[1], 'ann', ['cy'])).toBeUndefined();
    expect(disclosureOf(undefined, 'ann')).toBeUndefined();
  });
});

describe('notifications for your agents', () => {
  test('stuck or capped by default, else what Kolab\'s prefs say', () => {
    expect(agentNotifyOf(undefined, 'ann-helper')).toBe('stuck');
    expect(agentNotifyOf({ 'ann-helper': 'all' }, 'ann-helper')).toBe('all');
    expect(agentNotifyOf({ 'ann-helper': 'all' }, 'ann-reviewer')).toBe('stuck');
  });
  test('what an earlier build kept on the phone is read for moving to Kolab, the valid choices only', () => {
    expect(legacyAgentNotify('{"ann-helper":"all","ann-reviewer":"never","x":"loud"}')).toEqual({ 'ann-helper': 'all', 'ann-reviewer': 'never' });
    expect(legacyAgentNotify('not json')).toEqual({});
    expect(legacyAgentNotify('[1]')).toEqual({});
    expect(legacyAgentNotify(null)).toEqual({});
  });
});
