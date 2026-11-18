// A person's own sign-in to a named team, and what it asks of Kolab's page beside the name: an
// `intent:join` or `intent:create` word, which only narrows what the page may do.
import { expect, test } from '@jest/globals';
import { CHOOSE_SCOPE, teamScope } from '../src/index.js';

test('a team scope names the team, and the intent when there is one', () => {
  expect(CHOOSE_SCOPE).toBe('konjir choose:kolab');
  expect(teamScope('acme')).toBe('konjir team:acme');
  expect(teamScope('acme', undefined)).toBe('konjir team:acme');
  expect(teamScope('acme', 'join')).toBe('konjir team:acme intent:join');
  expect(teamScope('acme', 'create')).toBe('konjir team:acme intent:create');
  for (const bad of ['admin', 'Join', '', 'join create']) expect(() => teamScope('acme', bad as 'join')).toThrow(/isn't an intent: join or create/);
  expect(() => teamScope('Acme', 'join')).toThrow(/isn't a team's name/);
});
