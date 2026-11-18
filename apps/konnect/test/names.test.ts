// How konnect names members: an agent is stored as <owner>-<label> and shown and taken as
// <owner>/<label>; a person is their name.
import { expect, test } from '@jest/globals';
import { formatTeam, memberJson, shownName, storedName } from '../src/konnect.js';

test('@owner/label is the stored owner-label; @name is name; anything else is refused, saying how to name a member', () => {
  expect(storedName('@ann')).toBe('ann');
  expect(storedName('ann')).toBe('ann');
  expect(storedName('@ann/reviewer')).toBe('ann-reviewer');
  expect(storedName('@gh_ann/cli-2')).toBe('gh_ann-cli-2');
  for (const bad of ['@', '@ann/', '@/reviewer', '@ann/Reviewer', '@ann/a/b', '@-ann', '@ann bo']) {
    expect(() => storedName(bad)).toThrow(/isn't a member's name/);
  }
});

test('an agent shows as owner/label: from the server\'s label when it gives one, else from its stored name', () => {
  expect(shownName({ actor: 'ann', kind: 'person', owner: null })).toBe('ann');
  expect(shownName({ actor: 'ann-reviewer', kind: 'agent', owner: 'ann' })).toBe('ann/reviewer');
  expect(shownName({ actor: 'ann-reviewer', kind: 'agent', owner: 'ann', label: 'reviewer' })).toBe('ann/reviewer');
  // An owner who isn't a member (Kolab gives no owner then), or a name that isn't <owner>-<label>: the stored name.
  expect(shownName({ actor: 'ann-reviewer', kind: 'agent', owner: null })).toBe('ann-reviewer');
  expect(shownName({ actor: 'reviewer', kind: 'agent', owner: 'ann' })).toBe('reviewer');
});

test('konnect team list\'s lines: each person, their agents under them, connected said of agents alone, then who is invited; a name can\'t carry a control character to the terminal', () => {
  expect(formatTeam([
    { actor: 'bo', kind: 'person', owner: null, here: true },
    { actor: 'zed-x', kind: 'agent', owner: 'zed', label: 'x', here: true },
    { actor: 'ann-reviewer', kind: 'agent', owner: 'ann', label: 'reviewer', here: true },
    { actor: 'ann', kind: 'person', owner: null, here: true, you: true },
    { actor: 'bo-bot', kind: 'agent', owner: 'bo', label: 'bot', here: false },
    { actor: 'c\u001b[2Jy', kind: 'person', owner: null, here: false },
  ], [{ account: 'dee', created_at: '2026-11-16T10:00:00Z' }]).split('\n')).toStrictEqual([
    '@bo            person',
    '@bo/bot        agent',
    '@ann (you)     person',
    '@ann/reviewer  agent   connected',
    '@c?[2Jy        person',
    // An agent whose owner isn't a member comes after the people.
    '@zed/x         agent   connected',
    '@dee           person  invited 2026-11-16',
  ]);
  expect(formatTeam([], [])).toBe('');
});

test('a member as --json gives one: by the name konnect shows, connected, and you only when it is you', () => {
  expect(memberJson({ actor: 'ann-reviewer', kind: 'agent', owner: 'ann', label: 'reviewer', here: true })).toStrictEqual({ name: 'ann/reviewer', kind: 'agent', owner: 'ann', connected: true });
  expect(memberJson({ actor: 'bo', kind: 'person', owner: null, here: false, you: true })).toStrictEqual({ name: 'bo', kind: 'person', owner: null, connected: false, you: true });
});
