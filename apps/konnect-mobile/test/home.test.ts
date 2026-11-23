import { describe, expect, test } from '@jest/globals';
import type { AgentStatus, Member } from '@konjir/types';
import { homeOf, type HomeInput } from '../src/kolab/home';
import { memberHref, shortWhen } from '../src/routes';

const members: Member[] = [
  { actor: 'ann', kind: 'person', owner: null, here: true, you: true } as Member,
  { actor: 'ann-helper', kind: 'agent', owner: 'ann', label: 'helper', here: false } as Member,
  { actor: 'bo', kind: 'person', owner: null, here: true } as Member,
  { actor: 'bo-builder', kind: 'agent', owner: 'bo', label: 'builder', here: false } as Member,
  { actor: 'cy', kind: 'person', owner: null, here: false } as Member,
];
const base = (over: Partial<HomeInput> = {}): HomeInput => ({
  me: 'ann',
  channels: [{ channel: 'general', following: true }, { channel: 'design', following: true }, { channel: 'releases', following: false }],
  members,
  conversations: [
    { with: 'bo', last_at: '2026-11-22T10:00:00Z' },
    { with: 'bo-builder', last_at: '2026-11-22T09:00:00Z' },
    { with: 'ann-helper', last_at: '2026-11-22T08:00:00Z' },
  ],
  unread: {
    dms: new Map([['bo', { count: 2, mentions: 2 }], ['ann-helper', { count: 1, mentions: 1 }]]),
    channels: new Map([['general', { count: 3, mentions: 1 }]]),
  },
  statuses: [{ agent: 'ann-helper', state: 'idle' } as AgentStatus],
  showUnreads: false,
  ...over,
});
/** Every place a thing is listed, as kind:name. */
const listed = (h: ReturnType<typeof homeOf>) => [
  ...h.unreads.map((r) => (r.kind === 'channel' ? `c:${r.name}` : `d:${r.with}`)),
  ...h.channels.map((r) => `c:${r.name}`),
  ...h.dms.map((r) => `d:${r.with}`),
  ...h.agents.filter((a) => a.unread?.count).map((a) => `d:${a.member.actor}`),
];

describe('Home', () => {
  test('without Unreads, each thing is listed once: followed channels, DMs with people and others\' agents, your agents with their DM\'s unread', () => {
    const h = homeOf(base());
    expect(h.unreads).toEqual([]);
    expect(h.channels.map((c) => c.name)).toEqual(['general', 'design']);
    expect(h.channels[0]!.unread).toEqual({ count: 3, mentions: 1 });
    expect(h.dms.map((d) => d.with)).toEqual(['bo', 'bo-builder']);
    expect(h.agents.map((a) => a.member.actor)).toEqual(['ann-helper']);
    expect(h.agents[0]!.unread).toEqual({ count: 1, mentions: 1 });
    expect(h.agents[0]!.status?.state).toBe('idle');
    const all = listed(h);
    expect(new Set(all).size).toBe(all.length);
  });

  test('with Unreads, what is unread moves up out of its section, your agents keep their row without the badge, and nothing is listed twice', () => {
    const h = homeOf(base({ showUnreads: true }));
    expect(h.unreads.map((r) => (r.kind === 'channel' ? `#${r.name}` : r.with))).toEqual(['#general', 'bo', 'ann-helper']);
    expect(h.channels.map((c) => c.name)).toEqual(['design']);
    expect(h.dms.map((d) => d.with)).toEqual(['bo-builder']);
    expect(h.agents.map((a) => [a.member.actor, a.unread])).toEqual([['ann-helper', undefined]]);
    const all = listed(h);
    expect(new Set(all).size).toBe(all.length);
  });

  test('a channel unread that you don\'t follow, and a DM Kolab hasn\'t listed yet, still show', () => {
    const h = homeOf(base({ unread: { dms: new Map([['cy', { count: 1, mentions: 1 }]]), channels: new Map([['releases', { count: 1, mentions: 1 }]]) } }));
    expect(h.channels.map((c) => c.name)).toEqual(['general', 'design', 'releases']);
    expect(h.dms.map((d) => d.with)).toEqual(['cy', 'bo', 'bo-builder']);
  });

  test('Jump to… filters every section, by name or @handle, with or without its @ or #', () => {
    expect(listed(homeOf(base({ query: 'b' })))).toEqual(['d:bo', 'd:bo-builder']);
    expect(homeOf(base({ query: '@bo/builder' })).dms.map((d) => d.with)).toEqual(['bo-builder']);
    expect(homeOf(base({ query: '#gen' })).channels.map((c) => c.name)).toEqual(['general']);
    expect(homeOf(base({ query: 'helper' })).agents.map((a) => a.member.actor)).toEqual(['ann-helper']);
  });

  test('a DM\'s unread is its conversation\'s whole count, beyond the first unread messages the answers list', () => {
    const h = homeOf(base({
      conversations: [{ with: 'cy', last_at: '2026-11-22T11:00:00Z', unread: 1 }, { with: 'bo', last_at: '2026-11-22T10:00:00Z', unread: 25 }, { with: 'ann-helper', last_at: '2026-11-22T08:00:00Z', unread: 2 }],
      unread: { dms: new Map([['bo', { count: 20, mentions: 20 }]]), channels: new Map() },
    }));
    expect(h.dms.map((d) => [d.with, d.unread?.count])).toEqual([['cy', 1], ['bo', 25]]);
    expect(h.agents[0]!.unread).toEqual({ count: 2, mentions: 2 });
    expect(homeOf(base({ showUnreads: true, conversations: [{ with: 'cy', last_at: '2026-11-22T11:00:00Z', unread: 1 }], unread: { dms: new Map(), channels: new Map() } })).unreads.map((u) => (u.kind === 'dm' ? u.with : u.name))).toEqual(['cy']);
  });

  test('someone else\'s agent is never under Your agents', () => {
    expect(homeOf(base({ me: 'bo' })).agents.map((a) => a.member.actor)).toEqual(['bo-builder']);
  });
});

describe('routes', () => {
  test('every agent opens the agent screen, and a person their profile', () => {
    expect(memberHref('bo-builder', 'agent')).toEqual({ pathname: '/agent/[actor]', params: { actor: 'bo-builder' } });
    expect(memberHref('bo', 'person')).toEqual({ pathname: '/profile/[actor]', params: { actor: 'bo' } });
  });

  test('a list\'s time is the time today, else the day', () => {
    const now = new Date('2026-11-22T15:00:00');
    expect(shortWhen(new Date('2026-11-22T09:05:00').toISOString(), now)).toMatch(/9:05/);
    expect(shortWhen(new Date('2026-11-20T09:05:00').toISOString(), now)).toMatch(/20/);
    expect(shortWhen(undefined, now)).toBeUndefined();
    expect(shortWhen('not a date', now)).toBeUndefined();
  });
});
