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
  // While it waits, the harness is idle, which the agent's own server reads here to tell the service; once it wakes the harness, it isn't.
  expect(JSON.parse(readFileSync(wakeFile('hub', 'helper', ann.env), 'utf8')).waiting).toBe(true);
  await kolab.sendMessage(bo, 'ann-helper', 'SECRET-WORDS are you there?');
  const woke = await waiting.then(() => undefined, (e: unknown) => e);
  expect(woke).toBeInstanceOf(Woke);
  expect(JSON.parse(readFileSync(wakeFile('hub', 'helper', ann.env), 'utf8')).waiting).toBeUndefined();
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

test('Codex is woken with its own codex queue: its session is named by the agent\'s first konnect call, one wake waits at a time until the agent receives, and an older Codex is left to receive at each turn', async () => {
  const { kolab, server, idp, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  await ann.run(['agent', 'add', 'helper'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, self: () => ({ command: 'node', args: ['k.mjs'] }) });
  const file = `${ann.env.KONNECT_CONFIG_DIR}/agents/hub/helper.json`;
  const THREAD = '0190a6c2-7d1e-7f33-9a41-5b7c8d9e0f12';
  // A stand-in for the codex on PATH: what it was run with, and whether it has a queue command at all.
  const ran: string[][] = [];
  const has = { queue: true };
  const queue = async (args: string[]) => { ran.push(args); return { code: has.queue ? 0 : 2, out: has.queue ? 'Queued message 1 for thread.' : 'error: unrecognized subcommand \'queue\'' }; };

  const [a, b] = InMemoryTransport.createLinkedPair();
  const logged: string[] = [];
  const s = await serveMcp({ team: 'hub', url: server.url, file, label: 'helper', codex: true, queue, log: (l) => logged.push(l), backoff: { initialMs: 50, maxMs: 200 } }, b);
  const events: unknown[] = [];
  const c = new Client({ name: 'codex-stand-in', version: '0' });
  c.fallbackNotificationHandler = async (n) => { events.push(n); };
  await c.connect(a);
  const receive = (meta: Record<string, unknown>) => c.callTool({ name: 'konnect_receive', arguments: {}, _meta: meta });
  const bo = await kolab.openSession('bo', 'product', { kolab: 'hub' });
  try {
    await until('the waking stream listening', () => !!(s.bridge as unknown as { live?: unknown } | undefined)?.live);
    const mention = (words: string) => kolab.sendChannelMessage(bo, 'general', words, { mentions: ['ann/helper'] });

    // Until the agent has called a konnect tool, konnect doesn't know which session is its own: nothing is run.
    await mention('are you there? SECRET');
    await quiet();
    expect(ran).toStrictEqual([]);

    // Codex names the session with every tool call. From then on a message for the agent is queued for that
    // session: the notice, never the message's words, and nothing is sent to Codex as a notification.
    await receive({ threadId: THREAD, sessionId: 's1' });
    await mention('can you check the importer? SECRET');
    await until('the wake to be queued', () => ran.length === 2);
    expect(ran[0]).toStrictEqual(['queue', '--help']);
    expect(ran[1]).toStrictEqual(['queue', `--thread=${THREAD}`, expect.stringMatching(/^--message=New for you in team hub: a message in #general \(mentioning you\)\.\n/)]);
    expect(ran[1][2]).not.toContain('SECRET');
    expect(events).toStrictEqual([]);

    // One wake waits at a time: until the agent has received, another would only start another turn.
    await mention('and the exporter? SECRET');
    await quiet();
    expect(ran).toHaveLength(2);
    await receive({ threadId: THREAD });
    await mention('one more SECRET');
    await until('the next wake to be queued', () => ran.length === 3);
    expect(ran[2].slice(0, 2)).toStrictEqual(['queue', `--thread=${THREAD}`]);

    // What isn't a session's name is never put on a command line: the session known stays the one woken.
    await receive({ threadId: '--remote=ws://elsewhere.example' });
    await mention('again SECRET');
    await until('a wake after a name that isn\'t one', () => ran.length === 4);
    expect(ran[3][1]).toBe(`--thread=${THREAD}`);

    // A queue that fails is said, and tried again at the next message.
    has.queue = false;
    await receive({ threadId: THREAD });
    await mention('once more SECRET');
    await until('the failed wake to be said', () => logged.some((l) => l.includes('couldn\'t wake Codex')));
    expect(logged.join('\n')).not.toContain('SECRET');
  } finally { await c.close(); await s.close(); }

  // A Codex with no queue command (before 0.149) is asked once, said once, and left to receive at each turn.
  ran.length = 0; logged.length = 0;
  const [a2, b2] = InMemoryTransport.createLinkedPair();
  const s2 = await serveMcp({ team: 'hub', url: server.url, file, label: 'helper', codex: true, queue, log: (l) => logged.push(l), backoff: { initialMs: 50, maxMs: 200 } }, b2);
  const c2 = new Client({ name: 'old-codex-stand-in', version: '0' });
  await c2.connect(a2);
  try {
    await until('the waking stream listening', () => !!(s2.bridge as unknown as { live?: unknown } | undefined)?.live);
    await c2.callTool({ name: 'konnect_receive', arguments: {}, _meta: { threadId: THREAD } });
    await kolab.sendChannelMessage(bo, 'general', 'hello', { mentions: ['ann/helper'] });
    await until('the old Codex to be said', () => logged.some((l) => l.includes('can\'t be woken by messages')));
    await kolab.sendChannelMessage(bo, 'general', 'hello again', { mentions: ['ann/helper'] });
    await quiet();
    expect(ran).toStrictEqual([['queue', '--help']]);
    expect(logged.filter((l) => l.includes('can\'t be woken by messages'))).toHaveLength(1);
  } finally { await c2.close(); await s2.close(); }
});

test('a running agent says what it is doing, and the lists and konnect send say it: idle, working, then not running once it has ended', async () => {
  const { server, idp, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  await ann.run(['agent', 'add', 'helper'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, self: () => ({ command: 'node', args: ['k.mjs'] }) });
  const file = `${ann.env.KONNECT_CONFIG_DIR}/agents/hub/helper.json`;
  const helperLine = async () => (await bo.run(['team', 'list'])).split('\n').find((l) => l.startsWith('@ann/helper'));
  // Its login is kept, and nothing runs as it.
  expect(await helperLine()).toBe('@ann/helper    agent   not running');
  expect(await bo.run(['send', '@ann/helper', 'are you there?'])).toBe('Sent to @ann/helper. It isn\'t running now, so the message waits for it.');

  // konnect mcp runs for as long as the agent's harness does, and says its state as it starts and every so often after.
  let state: 'idle' | 'working' | 'running' = 'idle';
  const [a, b] = InMemoryTransport.createLinkedPair();
  const s = await serveMcp({ team: 'hub', url: server.url, file, label: 'helper', wake: false, state: () => state, stateEveryMs: 60 }, b);
  const c = new Client({ name: 'harness-stand-in', version: '0' });
  await c.connect(a);
  try {
    for (let i = 0; i < 100 && await helperLine() !== '@ann/helper    agent   idle'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await helperLine()).toBe('@ann/helper    agent   idle');
    expect(await bo.run(['send', '@ann/helper', 'hello'])).toBe('Sent to @ann/helper.');
    expect(JSON.parse(await bo.run(['team', 'list', '--json'])).members).toContainEqual({ name: 'ann/helper', kind: 'agent', owner: 'ann', connected: true, state: 'idle' });
    expect(await ann.run(['agent', 'list'])).toMatch(/^helper\s+idle\s+set up here$/m);
    // In a turn: a message is seen when the turn ends, and that is said to whoever sends one.
    state = 'working';
    for (let i = 0; i < 100 && await helperLine() !== '@ann/helper    agent   working'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await helperLine()).toBe('@ann/helper    agent   working');
    expect(await bo.run(['send', '@ann/helper', 'when you can'])).toBe('Sent to @ann/helper. It is in the middle of a turn, and sees the message when that ends.');
    // A harness konnect can't see into is only known to be running.
    state = 'running';
    for (let i = 0; i < 100 && await helperLine() !== '@ann/helper    agent   running'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await helperLine()).toBe('@ann/helper    agent   running');
  } finally { await c.close(); await s.close(); }
  // Its harness ended: said as it goes, so nobody waits a minute and a half to learn it.
  expect(await helperLine()).toBe('@ann/helper    agent   not running');
});
