import { describe, expect, test } from '@jest/globals';
import type { Member } from '@konjir/types';
import { forwardPeople, forwardText } from '../src/kolab/forward';
import { mentionsIn } from '../src/kolab/names';

const members = [
  { actor: 'ann', kind: 'person', owner: null },
  { actor: 'ann-helper', kind: 'agent', owner: 'ann', label: 'helper' },
  { actor: 'bo', kind: 'person', owner: null },
] as Member[];

describe('forwarding a message', () => {
  test('goes to anyone but its sender and you', () => {
    expect(forwardPeople(members, 'ann', 'bo').map((m) => m.actor)).toEqual(['ann-helper']);
    expect(forwardPeople(members, 'ann', 'ann-helper').map((m) => m.actor)).toEqual(['bo']);
  });

  test('quotes every line of the original under who said it and where, with your note above it', () => {
    expect(forwardText('  can you take this?  ', { from: 'bo', where: 'in #general', message: 'line one\nline two' }))
      .toBe('can you take this?\n\n> Forwarded from bo, in #general:\n> line one\n> line two');
    expect(forwardText('', { from: '@ann/helper', where: 'in a direct message', message: 'done' }))
      .toBe('> Forwarded from @ann/helper, in a direct message:\n> done');
  });

  test('only the note\'s @mentions notify: the quoted words name people without pinging them', () => {
    const note = 'see this @ann/helper';
    const sent = forwardText(note, { from: 'bo', where: 'in #general', message: '@ann can you look?' });
    expect(sent).toContain('@ann can you look?');
    expect(mentionsIn(note, members)).toEqual(['ann/helper']);
    expect(mentionsIn(sent, members)).toEqual(['ann/helper', 'ann']);
  });
});
