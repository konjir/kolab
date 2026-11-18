// How konnect names members: an agent is stored as <owner>-<label> and shown and taken as
// <owner>/<label>; a person is their name.
import { expect, test } from '@jest/globals';
import { formatTeam, memberJson, shownName, stateWord, storedName } from '../src/konnect.js';

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

test('konnect team list\'s lines: each person, their agents under them, what each agent is doing, then who is invited; a name can\'t carry a control character to the terminal', () => {
  expect(formatTeam([
    { actor: 'bo', kind: 'person', owner: null, here: true },
    { actor: 'zed-x', kind: 'agent', owner: 'zed', label: 'x', here: true, state: 'working' },
    { actor: 'ann-reviewer', kind: 'agent', owner: 'ann', label: 'reviewer', here: true, state: 'idle' },
    { actor: 'ann', kind: 'person', owner: null, here: true, you: true },
    { actor: 'bo-bot', kind: 'agent', owner: 'bo', label: 'bot', here: true, state: null },
    { actor: 'c\u001b[2Jy', kind: 'person', owner: null, here: false },
  ], [{ account: 'dee', created_at: '2026-11-16T10:00:00Z' }]).split('\n')).toStrictEqual([
    '@bo            person',
    // Nothing runs as it, though its login is open: a message for it waits.
    '@bo/bot        agent   not running',
    '@ann (you)     person',
    '@ann/reviewer  agent   idle',
    '@c?[2Jy        person',
    // An agent whose owner isn't a member comes after the people.
    '@zed/x         agent   working',
    '@dee           person  invited 2026-11-16',
  ]);
  // A service that tells no states yet says only whether an agent's login is open, which is all connected ever meant.
  expect(formatTeam([{ actor: 'ann-a', kind: 'agent', owner: 'ann', label: 'a', here: true }, { actor: 'ann-b', kind: 'agent', owner: 'ann', label: 'b', here: false }], []).split('\n')).toStrictEqual(['@ann/a  agent   connected', '@ann/b  agent']);
  expect(stateWord({ kind: 'agent', here: true, state: 'running' })).toBe('running');
  expect(stateWord({ kind: 'person', here: true, state: undefined })).toBe('');
  expect(formatTeam([], [])).toBe('');
});

test('a member as --json gives one: by the name konnect shows, connected, and you only when it is you', () => {
  expect(memberJson({ actor: 'ann-reviewer', kind: 'agent', owner: 'ann', label: 'reviewer', here: true })).toStrictEqual({ name: 'ann/reviewer', kind: 'agent', owner: 'ann', connected: true });
  expect(memberJson({ actor: 'ann-reviewer', kind: 'agent', owner: 'ann', label: 'reviewer', here: true, state: null })).toStrictEqual({ name: 'ann/reviewer', kind: 'agent', owner: 'ann', connected: true, state: null });
  expect(memberJson({ actor: 'ann-reviewer', kind: 'agent', owner: 'ann', label: 'reviewer', here: true, state: 'idle' })).toMatchObject({ state: 'idle' });
  expect(memberJson({ actor: 'bo', kind: 'person', owner: null, here: false, you: true })).toStrictEqual({ name: 'bo', kind: 'person', owner: null, connected: false, you: true });
});
