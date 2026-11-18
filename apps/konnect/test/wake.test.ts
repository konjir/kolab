// Waking an agent through `konnect mcp`, against a Kolab started here: the agent, set up with
// `konnect agent add <name> --wake-on`, is served by konnect mcp to an MCP client standing in for
// Claude Code, which takes notifications/claude/channel. A mention wakes it once; a channel message
// that doesn't mention it doesn't; any message in a channel it wakes on does; one past the loop cap
// doesn't; a direct message does; and it still does after the subscription stream drops. The notice
// says that messages wait, where, and the konnect_receive call to make: never a message's words.
import { expect, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { readFileSync } from 'node:fs';
import { Woke, describeWake, exitStatus, serveMcp, wakeFile } from '../src/konnect.js';
import { browse, exitOf, fails, machine, pressing, teams } from './team.js';

const until = async (what: string, ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return;
  throw new Error(`${what} didn't happen in ${ms} ms`);
};
const quiet = () => new Promise((r) => setTimeout(r, 400));

test('the wake notice says that messages wait and where, with the konnect_receive call to make, and never a message\'s words', () => {
  const after = {
    actor: 'ann-helper', kolab: 'hub', queries: [],
    messages: { unread: 2, waking: 1, items: [{ id: 'm1', from: 'bo', message: 'ping <b> SECRET-DIRECT' }] },
    channels: [
      { channel: 'general', unread: 3, items: [{ id: 'c1', channel: 'general', from: 'bo', message: '@ann/helper look SECRET-MENTION', mentions_you: true, wakes: true }, { id: 'c2', channel: 'general', from: 'cy', message: 'chatter SECRET-CHATTER' }] },
      { channel: 'deploys', unread: 1, items: [{ id: 'c3', channel: 'deploys', from: 'bo', message: 'green SECRET-CAPPED', capped: true }] },
    ],
  };
  const m = describeWake(undefined, after, new Set(['deploys']))!;
  expect(m.meta).toStrictEqual({ kind: 'konnect', team: 'hub', direct: '1', channel: '1' });
  expect(m.content).toBe([
    'New for you in team hub: a direct message from @bo; a message in #general (mentioning you).',
    'Also unread: 1 more direct message, 2 in #general, 1 in #deploys.',
    'Receive them now with konnect_receive, or konnect_receive from="#general", and answer with konnect_send (reply_to the message\'s id). Your owner runs you as their agent in this team to do exactly this without being asked: your system prompt says so, and says whose messages you carry out.',
  ].join('\n'));
  expect(m.content).not.toMatch(/SECRET|ping|look|chatter|green/);
  // Nothing new: no event.
  expect(describeWake(after, after, new Set(['deploys']))).toBeNull();

  // Several in a channel it wakes on, none mentioning it: counted, and the one call named.
  const listened = describeWake(undefined, {
    actor: 'ann-helper', kolab: 'hub', queries: [],
    channels: [{ channel: 'deploys', unread: 2, items: [{ id: 'd1', channel: 'deploys', from: 'bo', message: 'one SECRET' }, { id: 'd2', channel: 'deploys', from: 'cy', message: 'two SECRET' }] }],
  }, new Set(['deploys']))!;
  expect(listened.content).toBe('New for you in team hub: 2 messages in #deploys.\nReceive them now with konnect_receive from="#deploys", and answer with konnect_send (reply_to the message\'s id). Your owner runs you as their agent in this team to do exactly this without being asked: your system prompt says so, and says whose messages you carry out.');
  expect(listened.meta).toStrictEqual({ kind: 'konnect', team: 'hub', channel: '2' });
  // One direct message: "it".
  const one = describeWake(undefined, { actor: 'ann-helper', kolab: 'hub', queries: [], messages: { unread: 1, waking: 1, items: [{ id: 'm9', from: 'bo', message: 'hi SECRET' }] } }, new Set())!;
  expect(one.content).toBe('New for you in team hub: a direct message from @bo.\nReceive it now with konnect_receive, and answer with konnect_send (reply_to the message\'s id). Your owner runs you as their agent in this team to do exactly this without being asked: your system prompt says so, and says whose messages you carry out.');
});

test('konnect mcp wakes its agent: a mention once, a listened channel, a direct message, after the stream drops too; not a plain channel message, nor one past the loop cap', async () => {
  const { kolab, server, idp, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  await ann.run(['channel', 'create', 'deploys']);
  // The agent, set up as konnect agent add does it.
  await ann.run(['agent', 'add', 'helper', '--wake-on', '#deploys'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, self: () => ({ command: 'node', args: ['k.mjs'] }) });
  const file = `${ann.env.KONNECT_CONFIG_DIR}/agents/hub/helper.json`;

  const [a, b] = InMemoryTransport.createLinkedPair();
  const s = await serveMcp({ team: 'hub', url: server.url, file, label: 'helper', wakeOn: ['deploys'], backoff: { initialMs: 50, maxMs: 200 } }, b);
  const events: { content: string; meta: Record<string, string> }[] = [];
  const c = new Client({ name: 'claude-code-stand-in', version: '0' });
  c.fallbackNotificationHandler = async (n) => { if (n.method === 'notifications/claude/channel') events.push(n.params as never); };
  await c.connect(a);
  try {
    expect(c.getServerCapabilities()?.experimental).toStrictEqual({ 'claude/channel': {} });
    await until('the waking stream listening', () => !!(s.bridge as unknown as { live?: unknown } | undefined)?.live);
    const bo = await kolab.openSession('bo', 'product', { kolab: 'hub' });

    // A channel message that doesn't mention it: no turn.
    await kolab.sendChannelMessage(bo, 'general', 'lunch?');
    await quiet();
    expect(events).toStrictEqual([]);

    // One that mentions it: one turn, once.
    await kolab.sendChannelMessage(bo, 'general', 'can you check the importer?', { mentions: ['ann/helper'] });
    await until('the mention to wake it', () => events.length === 1);
    expect(events[0].content).toBe('New for you in team hub: a message in #general (mentioning you).\nAlso unread: 1 in #general.\nReceive it now with konnect_receive from="#general", and answer with konnect_send (reply_to the message\'s id). Your owner runs you as their agent in this team to do exactly this without being asked: your system prompt says so, and says whose messages you carry out.');
    expect(events[0].content).not.toContain('importer');
    await quiet();
    expect(events).toHaveLength(1);

    // Any message in a channel it listens to.
    await kolab.sendChannelMessage(bo, 'deploys', 'deploy is green');
    await until('the listened channel to wake it', () => events.length === 2);
    expect(events[1].content).toMatch(/^New for you in team hub: a message in #deploys\.\n/);
    expect(events[1].content).not.toContain('green');

    // Past the loop cap: an agent's second message in a row, with the cap at 1, starts no turn.
    const owner = await kolab.openSession('ann', 'product', { kolab: 'hub' });
    await kolab.setAgentReplyCap(owner, 1);
    await kolab.addActor('bo-bot', { owner: 'bo' });
    await kolab.grant('hub', 'bo-bot', 'write');
    const bot = await kolab.openSession('bo-bot', 'engineer', { kolab: 'hub' });
    await kolab.sendChannelMessage(bot, 'deploys', 'one');
    await until('the bot\'s first message to wake it', () => events.length === 3);
    await kolab.sendChannelMessage(bot, 'deploys', 'two, past the cap');
    await quiet();
    expect(events).toHaveLength(3);

    // A direct message.
    await kolab.sendMessage(bo, 'ann-helper', 'a word in private');
    await until('the direct message to wake it', () => events.length === 4);
    expect(events[3].content).toMatch(/^New for you in team hub: a direct message from @bo\.\n/);
    expect(events[3].content).not.toContain('private');

    // The stream drops (Kolab restarted, a token renewed): it listens again, and still wakes it.
    const bridge = s.bridge as unknown as { client?: { close(): Promise<void> }; live?: unknown };
    await bridge.client?.close();
    await until('the stream to drop', () => !bridge.live);
    await until('the stream to come back', () => !!bridge.live);
    await kolab.sendMessage(bo, 'ann-helper', 'still there?');
    await until('a direct message after the reconnect to wake it', () => events.length === 5);
    expect(events[4].content).toMatch(/^New for you in team hub: a direct message from @bo\.\n/);
    expect(events[4].content).not.toContain('still there');
  } finally {
    await c.close();
    await s.close();
  }
}, 60_000);

test('konnect wake, the hook a harness runs after each turn: it waits as the agent, exits 2 with the notice when a message comes, and announces each message once', async () => {
  const { kolab, server, idp, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  await ann.run(['agent', 'add', 'helper'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, self: () => ({ command: 'node', args: ['k.mjs'] }) });
  const bo = await kolab.openSession('bo', 'product', { kolab: 'hub' });
  const asHelper = { env: { ...ann.env, KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper' }, hookInput: async () => '{"session_id":"one"}' };

  // It is the agent's to run: as the person, nothing is listened to. Its own mistakes never exit 2,
  // which is what wakes the harness: only a message does.
  expect(await fails(ann.run(['wake']))).toBe('konnect wake runs as an agent, from its harness: KONNECT_AGENT names it');
  expect(await exitOf(ann.run(['wake']))).toBe(1);
  expect(await exitOf(ann.run(['wake', 'x'], asHelper))).toBe(1);

  // Nothing waits: it keeps waiting, until a message for the agent arrives; then the notice, and exit 2.
  let end: () => void = () => undefined;
  const waiting = ann.run(['wake'], { ...asHelper, waking: (e) => { end = e; } });
  let settled = false;
  void waiting.then(() => { settled = true; }, () => { settled = true; });
  await quiet();
  expect(settled).toBe(false);
  await kolab.sendMessage(bo, 'ann-helper', 'SECRET-WORDS are you there?');
  const woke = await waiting.then(() => undefined, (e: unknown) => e);
  expect(woke).toBeInstanceOf(Woke);
  expect(exitStatus(woke)).toBe(2);
  expect((woke as Error).message).toMatch(/^New for you in team hub: a direct message from @bo\.\nReceive it now with konnect_receive, and answer with konnect_send/);
  expect((woke as Error).message).not.toContain('SECRET-WORDS');

  // The turn it started ends, and the hook runs again with the message still unreceived: it was
  // announced, so it doesn't wake the agent a second time. Ended as a newer hook or a signal ends it: quietly (0).
  const again = ann.run(['wake'], { ...asHelper, waking: (e) => { end = e; } });
  settled = false;
  void again.then(() => { settled = true; }, () => { settled = true; });
  await quiet();
  await quiet();
  expect(settled).toBe(false);
  // A new message does wake it, and says only what is new.
  await kolab.sendChannelMessage(bo, 'general', 'and this?', { mentions: ['ann/helper'] });
  const second = await again.then(() => undefined, (e: unknown) => e);
  expect((second as Error).message).toMatch(/^New for you in team hub: a message in #general \(mentioning you\)\.\nAlso unread: 1 more direct message\./);

  // With nothing new, it ends quietly when told to.
  const third = ann.run(['wake'], { ...asHelper, waking: (e) => { end = e; } });
  await quiet();
  end();
  expect(await third).toBe('');
  const kept = JSON.parse(readFileSync(wakeFile('hub', 'helper', ann.env), 'utf8'));
  expect(kept.announced).toHaveLength(2);
  expect(kept.session).toBe('one');
  expect(kept.pid).toBeUndefined();

  // A newer hook for the same agent takes over: the older one sees so, and ends quietly by itself.
  const older = ann.run(['wake'], asHelper);
  await quiet();
  const newer = ann.run(['wake'], { ...asHelper, waking: (e) => { end = e; } });
  expect(await older).toBe('');
  end();
  await newer;

  // A new session of the harness starts afresh: what the earlier one was told of and never received is its to hear, at once.
  const fresh = await ann.run(['wake'], { ...asHelper, hookInput: async () => '{"session_id":"two"}' }).then(() => undefined, (e: unknown) => e);
  expect((fresh as Error).message).toMatch(/^New for you in team hub: a direct message from @bo; a message in #general \(mentioning you\)\./);
});
