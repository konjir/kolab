// How konnect names members: an agent is stored as <owner>-<label> and shown and taken as
// <owner>/<label>; a person is their name.
import { expect, test } from '@jest/globals';
import { formatMembers, shownName, storedName } from '../src/konnect.js';

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

test('konnect who\'s lines: name, kind, connected; a name can\'t carry a control character to the terminal', () => {
  expect(formatMembers([
    { actor: 'ann', kind: 'person', owner: null, here: true, you: true },
    { actor: 'ann-reviewer', kind: 'agent', owner: 'ann', here: false },
    { actor: 'b\u001b[2Jo', kind: 'person', owner: null, here: true },
  ]).split('\n')).toStrictEqual([
    'ann (you)     person  connected',
    'ann/reviewer  agent',
    'b?[2Jo        person  connected',
  ]);
});
