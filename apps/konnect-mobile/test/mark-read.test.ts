import { describe, expect, test } from '@jest/globals';
import { SignedOut, TeamChanged } from '../src/auth/tokens';
import { markReader } from '../src/kolab/mark-read';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('marking read as a conversation scrolls', () => {
  test('a failure is tried again a few times, with what was last on screen, then stops', async () => {
    const calls: string[] = [];
    const m = markReader<string>(async (v) => { calls.push(v); throw new Error('offline'); }, { delayMs: 5, tries: 3 });
    m.run('a');
    await wait(60);
    expect(calls).toEqual(['a', 'a', 'a']);
    m.dispose();
  });

  test('stops at once when the screen closes, with a retry waiting or a mark under way', async () => {
    const calls: string[] = [];
    const m = markReader<string>(async (v) => { calls.push(v); await wait(5); throw new Error('offline'); }, { delayMs: 5, tries: 10 });
    m.run('a');
    await wait(1);
    m.dispose();
    await wait(60);
    expect(calls).toEqual(['a']);

    const later = markReader<string>(async (v) => { calls.push(v); throw new Error('offline'); }, { delayMs: 5, tries: 10 });
    later.run('b');
    await wait(1);
    later.dispose();
    later.run('c');
    await wait(40);
    expect(calls).toEqual(['a', 'b']);
  });

  test('a sign-in that moved to another team, or ended, is never retried', async () => {
    for (const e of [new TeamChanged('moved'), new SignedOut('gone')]) {
      let n = 0;
      const m = markReader<string>(async () => { n++; throw e; }, { delayMs: 1, tries: 5 });
      m.run('a');
      await wait(20);
      expect(n).toBe(1);
      m.dispose();
    }
  });

  test('one at a time: a scroll during a mark is marked after it, and a success needs no retry', async () => {
    const calls: string[] = [];
    const m = markReader<string>(async (v) => { calls.push(v); await wait(5); }, { delayMs: 1 });
    m.run('a');
    m.run('b');
    m.run('c');
    await wait(40);
    expect(calls).toEqual(['a', 'c']);
    m.dispose();
  });
});
