// konnect receive and konnect history end to end, against a Kolab started here (test/team.ts):
// receive pages oldest first, at most -n (20 by default) across direct messages and every channel
// followed, shows every message it receives (nothing is marked read unseen), and says how many more
// wait; --wait looks again every 2 seconds until something comes or the time runs out (exit 5);
// history shows a channel's recent messages and changes nothing; direct-message history waits on
// the service.
import { afterEach, expect, test } from '@jest/globals';
import { exitOf, fails, machine, teams } from './team.js';

const until = async (ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return;
  throw new Error(`it didn't happen in ${ms} ms`);
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('konnect receive pages oldest first, at most 20 by default, showing every message it receives, and says how many more wait', async () => {
  const { kolab, server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  const annS = await kolab.openSession('ann', 'product', { kolab: 'hub' });
  for (let i = 1; i <= 45; i++) await kolab.sendChannelMessage(annS, 'general', `flood ${i}`);

  const words = (text: string) => text.split('\n').filter((l) => /^ {2}flood \d+$/.test(l)).map((l) => Number(l.slice(8)));
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  // Oldest first, twenty at a time; the last line says how many more, and how to get them.
  const first = await bo.run(['receive']);
  expect(first).toMatch(/^#general\n\S+ \S+ {2}@ann\n {2}flood 1\n/);
  expect(words(first)).toStrictEqual(range(1, 20));
  expect(first.split('\n').pop()).toBe('(25 more unread: run konnect receive again)');
  // From one channel, the line names it.
  const second = await bo.run(['receive', '#general']);
  expect(words(second)).toStrictEqual(range(21, 40));
  expect(second.split('\n').pop()).toBe('(5 more unread: run konnect receive \'#general\' again)');
  const third = await bo.run(['receive', '#general']);
  expect(words(third)).toStrictEqual(range(41, 45));
  expect(third).not.toContain('more unread');
  expect(await bo.run(['receive', '#general'])).toBe('No unread messages in #general.');

  // -n counts across everything: the direct messages first, then each channel followed, until it runs out.
  await ann.run(['channel', 'create', 'deploys']);
  await bo.run(['channel', 'follow', 'deploys']);
  await ann.run(['send', '@bo', 'dm 1']);
  await ann.run(['send', '@bo', 'dm 2']);
  for (let i = 1; i <= 3; i++) await ann.run(['send', '#deploys', `deploy ${i}`]);
  for (let i = 1; i <= 2; i++) await ann.run(['send', '#general', `general ${i}`]);
  const paged = await bo.run(['receive', '-n', '4']);
  expect(paged).toMatch(/^\S+ \S+ {2}@ann\n {2}dm 1\n\n\S+ \S+ {2}@ann\n {2}dm 2\n\n#deploys\n\S+ \S+ {2}@ann\n {2}deploy 1\n\n\S+ \S+ {2}@ann\n {2}deploy 2\n\(3 more unread: run konnect receive again\)$/);
  const json = JSON.parse(await bo.run(['receive', '-n', '2', '--json']));
  expect(json).toMatchObject({ direct: [], channels: [{ channel: 'deploys', messages: [{ message: 'deploy 3' }] }, { channel: 'general', messages: [{ message: 'general 1' }] }], more: 1 });
  expect(await bo.run(['receive', '--limit', '200'])).toMatch(/^#general\n\S+ \S+ {2}@ann\n {2}general 2$/);
  expect(await bo.run(['receive'])).toBe('No unread messages.');
});

test('konnect receive --wait: with nothing unread it looks again every 2 seconds until something comes, or the time runs out (exit 5)', async () => {
  const { kolab, server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');

  // Something comes while it waits: on the second look.
  const paused: number[] = [];
  const pause = async (ms: number) => { paused.push(ms); if (paused.length === 2) await ann.run(['send', '@bo', 'here at last']); };
  expect(await bo.run(['receive', '--wait', '1m'], { pause })).toMatch(/^\S+ \S+ {2}@ann\n {2}here at last$/);
  expect(paused).toStrictEqual([2_000, 2_000]);

  // Nothing comes: it looks until the time is spent, the last wait cut short, then stops with exit 5.
  paused.length = 0;
  const idle = async (ms: number) => { paused.push(ms); };
  expect(await fails(bo.run(['receive', '--wait', '5s'], { pause: idle }))).toBe('nothing arrived in the time given');
  expect(paused).toStrictEqual([2_000, 2_000, 1_000]);
  expect(await exitOf(bo.run(['receive', '--wait', '1s'], { pause: idle }))).toBe(5);
  // From one member, or one channel: it says which. A message from someone else doesn't end the wait.
  await kolab.sendMessage(await kolab.openSession('ann-reviewer', 'product', { kolab: 'hub' }), 'bo', 'not from ann');
  expect(await fails(bo.run(['receive', '@ann', '--wait', '3s'], { pause: idle }))).toBe('nothing arrived from @ann in the time given');
  expect(await fails(bo.run(['receive', '#general', '--wait', '2s'], { pause: idle }))).toBe('nothing arrived in #general in the time given');
  // With something unread already, it doesn't wait at all.
  paused.length = 0;
  expect(await bo.run(['receive', '--wait', '5s'], { pause: idle })).toMatch(/@ann\/reviewer\n {2}not from ann$/);
  expect(paused).toStrictEqual([]);
});

test('konnect history: a channel\'s newest messages, newest last, at most -n, changing nothing; and the direct messages between you and a member', async () => {
  const { server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  expect(await bo.run(['history', '#general'])).toBe('No messages in #general yet.');
  for (const w of ['one', 'two', 'three']) await ann.run(['send', '#general', w]);
  expect(await bo.run(['history', '#general', '-n', '2'])).toMatch(/^#general\n\S+ \S+ {2}@ann\n {2}two\n\n\S+ \S+ {2}@ann\n {2}three$/);
  expect(JSON.parse(await bo.run(['history', '#general', '--json'])).map((m: { message: string }) => m.message)).toStrictEqual(['one', 'two', 'three']);
  // Nothing was marked: all three are still Bo's to receive.
  expect((await bo.run(['receive', '#general'])).match(/^ {2}\w+$/gm)).toStrictEqual(['  one', '  two', '  three']);
  expect(await fails(bo.run(['history', '#nowhere']))).toMatch(/nowhere/);

  // Direct messages: both directions, newest last, at most -n, and nothing is marked.
  expect(await bo.run(['history', '@ann'])).toBe('No messages between you and @ann yet.');
  await ann.run(['send', '@bo', 'first']);
  await bo.run(['send', '@ann', 'second']);
  await ann.run(['send', '@bo', 'third']);
  expect(await bo.run(['history', '@ann'])).toMatch(/^\S+ \S+ {2}@ann\n {2}first\n\n\S+ \S+ {2}@bo\n {2}second\n\n\S+ \S+ {2}@ann\n {2}third$/);
  expect(JSON.parse(await bo.run(['history', '-n', '2', '--json', '@ann'])).map((m: { message: string }) => m.message)).toStrictEqual(['second', 'third']);
  expect((await bo.run(['receive', '@ann'])).match(/^ {2}\w+$/gm)).toStrictEqual(['  first', '  third']);
  // Someone who isn't in the team is refused (4).
  expect(await exitOf(bo.run(['history', '@nobody-here']))).toBe(4);
});

test('konnect watch prints messages as they arrive, from what you follow or from one place, and marks nothing; --json gives a line each', async () => {
  const { kolab, server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  await ann.run(['send', '#general', 'before watching']);
  const annSession = await kolab.openSession('ann', 'product', { kolab: 'hub' });
  // What is asked of the service, as it is asked.
  const asked: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof init?.body === 'string') asked.push(init.body);
    return realFetch(input, init);
  }) as typeof fetch;

  // Bo watches everything: what was there before isn't printed; what arrives is, as it arrives.
  const lines: string[] = [];
  let end: () => void = () => undefined;
  const watching = bo.run(['watch'], { out: (l) => lines.push(l), waking: (e) => { end = e; } });
  // Said once it knows where each place stands: whatever comes after is printed, even while its
  // subscription is still opening, so nothing more is waited for.
  await until(() => bo.err.some((l) => l.startsWith('Watching team hub as @bo.')));
  await kolab.sendChannelMessage(annSession, 'general', 'first in general');
  await until(() => lines.length === 1);
  await kolab.sendMessage(annSession, 'bo', 'a direct one');
  await until(() => lines.length === 2);
  await kolab.sendChannelMessage(annSession, 'general', 'second in general');
  await until(() => lines.length === 3);
  end();
  await watching;
  expect(lines[0]).toMatch(/^#general\n\S+ \S+ {2}@ann\n {2}first in general$/);
  expect(lines[1]).toMatch(/^\nDirect, from @ann\n\S+ \S+ {2}@ann\n {2}a direct one$/);
  expect(lines[2]).toMatch(/^\n#general\n\S+ \S+ {2}@ann\n {2}second in general$/);
  // Nothing was marked: all of it is still Bo's to receive.
  expect((await bo.run(['receive'])).match(/^ {2}.+$/gm)).toStrictEqual(['  a direct one', '  before watching', '  first in general', '  second in general']);

  // One place alone, as JSON lines.
  const json: string[] = [];
  // With --json nothing is said as it starts: it has taken where each place stands once it asks for its subscription.
  const listens = () => asked.filter((b) => b.includes('subscriptions/listen')).length;
  const before = listens();
  const one = bo.run(['watch', '--json', '@ann'], { out: (l) => json.push(l), waking: (e) => { end = e; } });
  await until(() => listens() > before);
  await kolab.sendChannelMessage(annSession, 'general', 'not watched');
  await kolab.sendMessage(annSession, 'bo', 'only this');
  await until(() => json.length === 1);
  end();
  await one;
  expect(JSON.parse(json[0])).toMatchObject({ direct: true, from: 'ann', to: 'bo', message: 'only this' });
  expect(await fails(bo.run(['watch', 'general']))).toMatch(/^say whether general is a member or a channel/);
});
