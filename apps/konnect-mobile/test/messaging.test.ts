import { describe, expect, test } from '@jest/globals';
import { complete, completing, handleOf, mentionsIn, suggestions } from '../src/kolab/names';
import { activityOf, readThrough, unreadOf } from '../src/kolab/unread';
import { rowsOf, type Msg } from '../src/kolab/thread';
import type { Answers } from '../src/kolab/api';

const members = [
  { actor: 'ann', owner: null, label: null },
  { actor: 'bo', owner: null, label: null },
  { actor: 'ann-reviewer', owner: 'ann', label: 'reviewer' },
];

describe('the composer\'s names', () => {
  test('mentions are members, once each, an agent as owner/label, whatever the case', () => {
    expect(mentionsIn('@bo and @Ann/reviewer, ping @bo again; @nobody, mail me@bo.dev', members)).toEqual(['bo', 'ann/reviewer']);
    expect(mentionsIn('@ann-reviewer', members)).toEqual(['ann/reviewer']);
    expect(handleOf(members[2]!)).toBe('ann/reviewer');
  });

  test('at most 20 mentions', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ actor: `p${i}`, owner: null, label: null }));
    expect(mentionsIn(many.map((m) => `@${m.actor}`).join(' '), many)).toHaveLength(20);
  });

  test('completes the @ or # word at the cursor', () => {
    expect(completing('hi @an', 6)).toEqual({ kind: '@', query: 'an', start: 3 });
    expect(completing('see #gen', 8)).toEqual({ kind: '#', query: 'gen', start: 4 });
    expect(completing('hi @an there', 12)).toBeUndefined();
    expect(completing('mail me@bo', 10)).toBeUndefined();
    expect(suggestions('re', ['ann', 'ann/reviewer', 'reports', 'bo'])).toEqual(['reports', 'ann/reviewer']);
    expect(complete('hi @an there', { kind: '@', start: 3 }, 6, 'ann/reviewer')).toEqual({ text: 'hi @ann/reviewer  there', cursor: 17 });
  });
});

const answers: Answers = {
  actor: 'ann',
  messages: { unread: 3, items: [
    { id: 'm1', from: 'bo', message: 'hi' }, { id: 'm2', from: 'bo', message: 'there', reply_to: 'mine1' }, { id: 'm3', from: 'cy', message: 'yo' },
  ] },
  channels: [
    { channel: 'general', unread: 5, items: [
      { id: 'c1', channel: 'general', from: 'bo', message: '@ann look', mentions_you: true },
      { id: 'c2', channel: 'general', from: 'ann-reviewer', message: 'done', capped: true },
      { id: 'c3', channel: 'general', from: 'bo', message: 're', reply_to: 'mine2' },
    ] },
    { channel: 'quiet', unread: 0 },
  ],
};

describe('unread and Activity', () => {
  test('counts unread per DM partner and per channel, with mentions', () => {
    const u = unreadOf(answers);
    expect(u.dms.get('bo')).toEqual({ count: 2, mentions: 2 });
    expect(u.dms.get('cy')).toEqual({ count: 1, mentions: 1 });
    expect(u.channels.get('general')).toEqual({ count: 5, mentions: 1 });
    expect(u.channels.has('quiet')).toBe(false);
    expect(u.total).toBe(8);
    expect(unreadOf(undefined).total).toBe(0);
  });

  test('Activity: mentions, replies to what you sent, and capped messages, newest first', () => {
    expect(activityOf(answers, new Set(['mine1', 'mine2'])).map((a) => [a.kind, a.item.id])).toEqual([
      ['reply', 'm2'], ['reply', 'c3'], ['capped', 'c2'], ['mention', 'c1'],
    ]);
  });

  test('a conversation is read through the newest unread message seen', () => {
    expect(readThrough(['a', 'b', 'c', 'd'], ['x', 'b'])).toBe(2);
    expect(readThrough(['a', 'b', 'c'], ['c', 'a'])).toBe(3);
    expect(readThrough(['a', 'b'], ['z'])).toBe(0);
  });
});

describe('a conversation\'s rows', () => {
  const at = (h: number, m = 0, d = 21) => `2026-11-${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  const msgs: Msg[] = [
    { id: '5', from: 'bo', message: 'e', sent_at: at(10, 5) },
    { id: '4', from: 'bo', message: 'd', sent_at: at(10, 4, 21).replace(':00.000', ':30.000') },
    { id: '3', from: 'ann', message: 'c', sent_at: at(10, 4) },
    { id: '2', from: 'ann', message: 'b', sent_at: at(9, 0) },
    { id: '1', from: 'ann', message: 'a', sent_at: at(9, 0, 20) },
  ];
  test('groups by sender and minute, with day separators and the New line', () => {
    const rows = rowsOf(msgs, '4');
    expect(rows.map((r) => (r.type === 'message' ? `${r.msg.id}${r.head ? '*' : ''}` : r.type === 'day' ? `day:${r.label}` : 'new'))).toEqual([
      '5', '4*', 'new', '3*', '2*', 'day:2026-11-21', '1*', 'day:2026-11-20',
    ]);
  });
});
