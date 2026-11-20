// konnect host, against a Kolab started here: a machine of a person's own that starts their agents
// when they ask from another machine paired with it. What a request may carry and what it may not,
// who may ask, how an agent's login reaches the machine, and hosting itself: starting, pairing,
// taking over, ending.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from '@jest/globals';
import { TeamClient, agentFile, answerBound, fingerprint, formatHosts, keyOf, newCode, parseArgs, readCode, readStart, readStop, requestBound, seal, teamFile, thisMachine, unseal } from '../src/konnect.js';
import { browse, exitOf, fails, machine, pressing, teams } from './team.js';

afterEach(() => { process.exitCode = 0; });

const self = () => ({ command: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs'] });
/** Waits without waiting: a hosting machine's tick, and an asker's look, in a moment. */
const soon = () => new Promise<void>((r) => { setTimeout(r, 10); });
const until = async (what: () => Promise<boolean>, why: string) => {
  for (let i = 0; i < 400; i++) { if (await what()) return; await soon(); }
  throw new Error(`never happened: ${why}`);
};
const ID = 'a'.repeat(32);
const WORD = 'b'.repeat(32);
const hex = () => randomBytes(16).toString('hex');

/** A stand-in for one machine's tmux: the sessions it holds, and every command line it was given. */
function tmux(installed = true) {
  const sessions = new Set<string>();
  const ran: string[][] = [];
  const state = { installed };
  const exec = async (cmd: string, args: string[]) => {
    ran.push([cmd, ...args]);
    if (cmd !== 'tmux' || !state.installed) return { code: -1, out: 'not installed' };
    if (args[0] === '-V') return { code: 0, out: 'tmux 3.4' };
    if (args[0] === 'has-session') return { code: sessions.has(args[2].slice(1)) ? 0 : 1, out: '' };
    if (args[0] === 'list-sessions') return sessions.size ? { code: 0, out: [...sessions].join('\n') } : { code: 1, out: 'no server running' };
    if (args[0] === 'new-session') { sessions.add(args[3]); return { code: 0, out: '' }; }
    if (args[0] === 'kill-session') { sessions.delete(args[2].slice(1)); return { code: 0, out: '' }; }
    return { code: 1, out: 'unexpected' };
  };
  /** The command line tmux was given to start a session, and what waits in the file it names. */
  const started = (session: string) => {
    const line = ran.find((c) => c[1] === 'new-session' && c[4] === session)!;
    return { line, file: line.at(-1)!, waiting: JSON.parse(readFileSync(line.at(-1)!, 'utf8')) as { cmd: string; args: string[]; env: Record<string, string>; cwd: string } };
  };
  return { sessions, ran, state, exec, started };
}

test('a pairing code makes the key a request is sealed with: for one machine in one team, as one kind of thing, and a changed one doesn\'t open', () => {
  const code = newCode();
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
  expect(newCode()).not.toBe(code);
  // As a person types it: any case, spaces for dashes, O for 0 and I or L for 1.
  expect(readCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code);
  expect(readCode('o1il-0000-0000-0000-0000-0000')).toBe('0111-0000-0000-0000-0000-0000');
  expect(readCode('too short')).toBeUndefined();
  expect(readCode(`${code}-AAAA`)).toBeUndefined();

  const key = keyOf(code, 'hub', 'desk');
  expect(key).toHaveLength(32);
  // Another machine, another team, another code: another key. What is published of it gives none of it away.
  for (const other of [keyOf(code, 'hub', 'mini'), keyOf(code, 'side', 'desk'), keyOf(newCode(), 'hub', 'desk')]) expect(other.equals(key)).toBe(false);
  expect(() => keyOf('not a code', 'hub', 'desk')).toThrow('that isn\'t a pairing code');
  expect(fingerprint(key, 'hub', 'desk')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(fingerprint(key, 'hub', 'desk')).not.toBe(key.toString('base64url'));
  expect(fingerprint(keyOf(newCode(), 'hub', 'desk'), 'hub', 'desk')).not.toBe(fingerprint(key, 'hub', 'desk'));

  const sealed = seal(key, '{"tokens":"secret"}', requestBound('start', 'hub', 'desk'));
  expect(sealed).toMatch(/^k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  expect(sealed).not.toContain('secret');
  expect(unseal(key, sealed, requestBound('start', 'hub', 'desk'))).toBe('{"tokens":"secret"}');
  // Sealed twice, it reads differently each time.
  expect(seal(key, '{"tokens":"secret"}', requestBound('start', 'hub', 'desk'))).not.toBe(sealed);
  // Another code's key, another kind of request, another machine, a request read as an answer: none opens it.
  expect(() => unseal(keyOf(newCode(), 'hub', 'desk'), sealed, requestBound('start', 'hub', 'desk'))).toThrow();
  expect(() => unseal(key, sealed, requestBound('stop', 'hub', 'desk'))).toThrow();
  expect(() => unseal(key, sealed, requestBound('start', 'hub', 'mini'))).toThrow();
  expect(() => unseal(key, sealed, answerBound('hub', 'desk', ID))).toThrow();
  // Changed on the way, it doesn't open.
  const parts = sealed.split('.');
  parts[2] = `${parts[2].slice(0, -2)}${parts[2].endsWith('AA') ? 'BB' : 'AA'}`;
  expect(() => unseal(key, parts.join('.'), requestBound('start', 'hub', 'desk'))).toThrow();
  expect(() => unseal(key, 'not sealed', requestBound('start', 'hub', 'desk'))).toThrow('that isn\'t sealed');
});

test('a request to start agents carries names, a harness and konnect\'s own options, and anything else is refused, never ignored', () => {
  const ok = { v: 1, id: ID, word: WORD, harness: 'claude', agents: [{ name: 'helper' }], act_for: 'me', wake_on: ['general', '#deploys'], system_prompt: 'be brief;' };
  expect(readStart(JSON.stringify(ok))).toStrictEqual({ v: 1, id: ID, word: WORD, harness: 'claude', agents: [{ name: 'helper' }], act_for: 'me', wake_on: ['general', 'deploys'], system_prompt: 'be brief;' });
  expect(readStart(JSON.stringify({ v: 1, id: ID, word: WORD, harness: 'opencode', agents: [{ name: 'a' }, { name: 'b' }] }))).toStrictEqual({ v: 1, id: ID, word: WORD, harness: 'opencode', agents: [{ name: 'a' }, { name: 'b' }] });
  const refused = (change: Record<string, unknown>) => { try { readStart(JSON.stringify({ ...ok, ...change })); return 'read'; } catch (e) { return (e as Error).message; } };
  // No command, no arguments for the harness, no folder: a request holding any is refused whole.
  expect(refused({ args: ['--dangerously-skip-permissions'] })).toBe('the request holds args, which this konnect doesn\'t know: update konnect on this machine');
  expect(refused({ command: 'rm -rf ~', cwd: '/' })).toMatch(/^the request holds command, cwd, which this konnect doesn't know/);
  expect(refused({ agents: [{ name: 'helper', args: ['-p', 'x'] }] })).toMatch(/^an agent in the request holds args/);
  // Only the harnesses konnect starts, and only names that are an agent's.
  expect(refused({ harness: 'bash' })).toBe('the request names no harness konnect starts: claude, codex or opencode');
  expect(refused({ harness: ['claude', '--x'] })).toMatch(/names no harness/);
  expect(refused({ agents: [{ name: '../../etc' }] })).toMatch(/isn't an agent's name/);
  expect(refused({ agents: [{ name: '-rf' }] })).toMatch(/isn't an agent's name/);
  expect(refused({ agents: [] })).toBe('the request names no agents, or more than 10');
  expect(refused({ agents: Array.from({ length: 11 }, (_, i) => ({ name: `a${i}` })) })).toBe('the request names no agents, or more than 10');
  expect(refused({ agents: [{ name: 'a' }, { name: 'a' }] })).toBe('the request names an agent twice');
  expect(refused({ act_for: 'everyone' })).toBe('the request\'s act_for isn\'t nobody, me or team');
  expect(refused({ wake_on: ['general', 'has space'] })).toBe('the request\'s wake_on names something that isn\'t a channel');
  expect(refused({ wake_on: ['a,b'] })).toMatch(/isn't a list of at most 20 channels/);
  expect(refused({ system_prompt: 'x'.repeat(16_001) })).toBe('the request\'s system prompt isn\'t text of at most 16000 characters');
  expect(refused({ system_prompt: 'a\0b' })).toMatch(/system prompt isn't text/);
  expect(refused({ system_prompt: ['x'] })).toMatch(/system prompt isn't text/);
  // Every request has a name of its own, and carries the word the machine gave for it.
  expect(refused({ v: 2 })).toBe('the request is from a newer konnect than this machine\'s: update konnect on this machine');
  expect(refused({ id: 'short' })).toBe('the request isn\'t one konnect wrote');
  expect(refused({ word: 'now' })).toBe('the request isn\'t one konnect wrote');
  expect(refused({ word: undefined })).toBe('the request isn\'t one konnect wrote');
  expect(refused({ at: 1 })).toMatch(/^the request holds at, /);
  expect(() => readStart('not json')).toThrow('the request isn\'t one konnect wrote');
  expect(() => readStart('[]')).toThrow('the request isn\'t one konnect wrote');

  // A login sent with it is kept as a login alone: nothing nested, and nothing that says where it is renewed.
  const login = { client: { client_id: 'c1', redirect_uris: ['http://127.0.0.1/cb'], token_endpoint: 'https://elsewhere.example/token', metadata: { token_endpoint: 'https://elsewhere.example/token' } }, tokens: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 60, issuer: 'https://kolab.example', discovery: { x: 1 } }, discovery: { authorizationServerUrl: 'https://elsewhere.example' } };
  expect(readStart(JSON.stringify({ ...ok, agents: [{ name: 'a', login }] })).agents[0].login).toStrictEqual({ client: { client_id: 'c1', redirect_uris: ['http://127.0.0.1/cb'] }, tokens: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 60, issuer: 'https://kolab.example' } });
  expect(refused({ agents: [{ name: 'a', login: 'plain text' }] })).toBe('the login sent for a isn\'t a login');
  expect(refused({ agents: [{ name: 'a', login: { client: {}, tokens: {} } }] })).toBe('the login sent for a isn\'t a login');
  expect(refused({ agents: [{ name: 'a', login: { client: { client_id: 'c' }, tokens: { access_token: ['a'], refresh_token: 'r' } } }] })).toBe('the login sent for a isn\'t a login');

  expect(readStop(JSON.stringify({ v: 1, id: ID, word: WORD, agent: 'helper' }))).toStrictEqual({ v: 1, id: ID, word: WORD, agent: 'helper' });
  expect(() => readStop(JSON.stringify({ v: 1, id: ID, word: WORD, agent: 'x', signal: 9 }))).toThrow(/holds signal/);
  expect(() => readStop(JSON.stringify({ v: 1, id: ID, word: WORD, agent: '../x' }))).toThrow(/isn't an agent's name/);
  expect(() => readStop(JSON.stringify({ v: 1, id: ID, agent: 'x' }))).toThrow('the request isn\'t one konnect wrote');

  // A machine is named after itself unless told; --on is read with its machine.
  expect(thisMachine('Anns-MacBook-Pro.local')).toBe('anns-macbook-pro');
  expect(thisMachine('desk_01.lan')).toBe('desk-01');
  expect(thisMachine('---')).toBeUndefined();
  expect(parseArgs(['agent', 'run', '--on', 'desk', 'helper', 'claude'])).toMatchObject({ on: 'desk', words: ['agent', 'run', 'helper', 'claude'] });
  expect(formatHosts([
    { name: 'desk', folder: '~/proj', serving: true, started_at: '2026-11-18T10:00:00Z', seen_at: '2026-11-18T10:00:00Z', agents: ['helper'], running: ['helper', 'worker-1'], public_key: 'x' },
    { name: 'mini', folder: null, serving: false, started_at: '2026-11-18T08:00:00Z', seen_at: '2026-11-18T08:00:00Z', agents: [], running: ['old'], public_key: 'x' },
  ], Date.parse('2026-11-18T10:00:00Z'))).toBe('desk   hosting             ~/proj   running: helper, worker-1\nmini   last seen 2 h ago');
});

test('konnect host run makes a machine start your agents when you ask from one paired with it: host pair, agent run --on and agent stop --on, the login sent sealed, and only what konnect itself offers', async () => {
  const { server, idp, signIn, ann: annId, bo: boId } = await teams();
  const laptop = machine(server.url, 'ann-laptop');
  const desk = machine(server.url, 'ann-desk');
  const bo = machine(server.url, 'bo');
  await signIn(laptop, annId, 'hub');
  await signIn(desk, annId, 'hub');
  await signIn(bo, boId, 'hub');
  const allow = (u: URL) => { idp.next(annId); void browse(u, pressing('decision=allow')); };
  const noBrowser = () => { throw new Error('the browser was opened'); };
  const there = tmux();
  // The desk's home folder, where Claude Code has been run in the folder it hosts in.
  (desk.env as Record<string, string>).HOME = desk.root;
  writeFileSync(join(desk.root, '.claude.json'), JSON.stringify({ projects: { [desk.cwd]: { hasTrustDialogAccepted: true } } }));

  // Nothing hosts until a machine is told to; and it needs tmux or screen to keep what it starts.
  expect(await laptop.run(['host', 'list'])).toBe('No machine of yours hosts in team hub. On one that should: konnect host run');
  expect(await fails(laptop.run(['agent', 'run', '--on', 'desk', 'helper', 'claude'], { open: noBrowser, pause: soon }))).toBe('no machine of yours is hosting as desk in team hub: on that machine, run konnect host run desk');
  expect(await fails(desk.run(['host', 'run', 'desk'], { exec: tmux(false).exec, self, pause: soon }))).toBe('a machine that hosts keeps each harness it starts in tmux or screen, and neither is installed here: install tmux');

  // The desk hosts, in the folder it was told to in, until it is ended; it shows its code, which goes nowhere else.
  const deskErr: string[] = [];
  const hosting = desk.run(['host', 'run', 'desk'], { exec: there.exec, self, pause: soon, err: (l) => deskErr.push(l) });
  // Listed once the service has its word, which can be before the desk has its answer and says so: both are waited for.
  await until(async () => /^desk\s+hosting/.test(await laptop.run(['host', 'list'])) && deskErr.length > 0, 'the desk hosts, and says so');
  expect(deskErr[0]).toMatch(/^This machine hosts for you \(@ann\) in team hub as desk, in ~\/work\.\nTo ask it from another machine of yours, pair that machine once, there:\n {2}konnect host pair desk [0-9A-Z]{4}(-[0-9A-Z]{4}){5}\nThen, from it: konnect agent run --on desk <name> claude\nIt starts claude, codex or opencode as an agent of yours, with konnect's own options, and only for a machine paired with it; what the agent may do here is set in its harness\. Ctrl-C ends hosting\.$/);
  const code = /konnect host pair desk (\S+)/.exec(deskErr[0])![1];
  expect(JSON.parse(await laptop.run(['host', 'list', '--json']))).toMatchObject([{ name: 'desk', folder: '~/work', serving: true, agents: [], running: [] }]);
  expect(await laptop.run(['host', 'list', '--json'])).not.toContain('public_key');
  // The code is said again on the desk, where it is kept, and nowhere else.
  expect(await desk.run(['host', 'list'])).toMatch(new RegExp(`^desk\\s+hosting\\s+~/work\\n\\nTo ask this machine from another machine of yours, pair that machine once, there:\\n  konnect host pair desk ${code}$`));
  expect(await laptop.run(['host', 'list'])).not.toContain('pair');
  expect(await desk.run(['host', 'list', '--json'])).not.toContain(code);

  // A machine that isn't paired can't ask, whoever is logged in on it (4); no browser is opened, and the desk hears nothing.
  expect(await fails(laptop.run(['agent', 'run', '--on', 'desk', 'helper', 'claude'], { open: noBrowser, pause: soon }))).toBe('this machine isn\'t paired with desk: pair it once with konnect host pair desk <code>, the code konnect host run shows on desk');
  expect(await exitOf(laptop.run(['agent', 'stop', '--on', 'desk', 'helper'], { pause: soon }))).toBe(4);
  expect(await exitOf(laptop.run(['host', 'stop', 'desk'], { pause: soon, exec: tmux().exec }))).toBe(4);
  // Pairing: the desk's code, given once. A code that isn't the desk's is said now (4); what isn't a code at all is a wrong command line (2).
  expect(await fails(laptop.run(['host', 'pair', 'desk', newCode()]))).toBe('that isn\'t desk\'s code: it is the one konnect host run shows on desk, or konnect host list there');
  expect(await fails(laptop.run(['host', 'pair', 'desk', 'hunter2']))).toBe('that isn\'t a pairing code: it is six groups of four letters and digits, as konnect host run shows on desk');
  expect(await exitOf(laptop.run(['host', 'pair', 'desk', 'hunter2']))).toBe(2);
  expect(await fails(laptop.run(['host', 'pair', 'mini', code]))).toBe('no machine of yours hosts as mini in team hub: on that machine, run konnect host run mini');
  expect(await laptop.run(['host', 'pair', 'desk'], { stdin: async () => `${code.toLowerCase().replace(/-/g, ' ')}\n` })).toBe('Paired with desk. From this machine: konnect agent run --on desk <name> claude');
  expect(await laptop.run(['host', 'pair', 'desk', code])).toMatch(/^Paired with desk\./);

  // From the laptop: the agent is new, so it is allowed in the browser there, and started on the desk.
  const out = await laptop.run(['agent', 'run', '--on', 'desk', '--act-for', 'me', '--wake-on', 'general', '--system-prompt', 'be brief;', 'helper', 'claude'], { open: allow, pause: soon });
  expect(out).toBe('Your agent @ann/helper is added to team hub, and claude is running as it on desk, in ~/work.\n  konnect agent stop --on desk helper     end it\nTo look in on it, on desk: konnect agent attach helper');
  expect(there.sessions).toStrictEqual(new Set(['konnect_hub_helper']));
  // Its login is kept on the desk, where it runs, and not on the laptop, where it was allowed.
  expect(existsSync(agentFile('hub', 'helper', desk.env))).toBe(true);
  expect(existsSync(agentFile('hub', 'helper', laptop.env))).toBe(false);
  // The desk started what konnect agent run --background starts, in its own folder, from its own konnect:
  // tmux is given konnect's plumbing and a file's name, and what is to run, and where, waits in the file.
  const first = there.started('konnect_hub_helper');
  expect(first.line.slice(0, -1)).toStrictEqual(['tmux', 'new-session', '-d', '-s', 'konnect_hub_helper', 'env', `KONNECT_CONFIG_DIR=${desk.env.KONNECT_CONFIG_DIR}`, '/usr/bin/node', '/opt/konnect/konnect.mjs', '_start']);
  expect(first.file).toMatch(new RegExp(`^${desk.env.KONNECT_CONFIG_DIR}/agents/hub/helper\\.[0-9a-f]{12}\\.start\\.json$`));
  expect(first.waiting.cmd).toBe('claude');
  expect(first.waiting.cwd).toBe(desk.cwd);
  expect(first.waiting.env).toMatchObject({ KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper', KONNECT_ACT_FOR: 'me', KONNECT_WAKE_ON: 'general', KONNECT_SYSTEM_PROMPT: 'be brief;', KONNECT_CONFIG_DIR: desk.env.KONNECT_CONFIG_DIR });
  // Nothing a person wrote reached tmux's command line, where a ';' would end its command.
  expect(there.ran.flat().some((w) => w.includes(';') || w.includes('be brief'))).toBe(false);
  expect(deskErr.join('\n')).toMatch(/\d\d:\d\d:\d\d {2}started helper in claude \(tmux session konnect_hub_helper\)/);

  // The lists say where it runs; a second start of the same agent there is refused (4).
  await until(async () => /^desk\s+hosting\s+\S+\s+running: helper$/.test(await laptop.run(['host', 'list'])), 'the desk says helper runs there');
  expect(await laptop.run(['agent', 'list'], { exec: tmux().exec })).toMatch(/^helper\s+not answering\s+running on desk$/m);
  expect(JSON.parse(await laptop.run(['agent', 'list', '--json'], { exec: tmux().exec }))).toContainEqual(expect.objectContaining({ name: 'helper', set_up_here: false, running_here: false, running_on: ['desk'] }));
  expect(await fails(laptop.run(['agent', 'run', '--on', 'desk', 'helper', 'claude'], { open: noBrowser, pause: soon }))).toBe('your agent helper is running on desk already: konnect agent stop --on desk helper ends it');
  expect(await exitOf(laptop.run(['agent', 'run', '--on', 'desk', 'helper', 'claude'], { open: noBrowser, pause: soon }))).toBe(4);

  // Arguments for the harness are never sent: what an agent may do on a machine is set on that machine (2).
  expect(await fails(laptop.run(['agent', 'run', '--on', 'desk', 'other', 'claude', '--dangerously-skip-permissions'], { open: noBrowser, pause: soon })))
    .toBe('konnect agent run --on sends no arguments for the harness (--dangerously-skip-permissions): what an agent may do on another machine is set on that machine. Leave them out');
  expect(await exitOf(laptop.run(['agent', 'run', '--on', 'desk', 'other', 'claude', '-p', 'x'], { open: noBrowser, pause: soon }))).toBe(2);
  expect(await fails(laptop.run(['agent', 'run', '--on', 'desk', '--background', 'other', 'claude'], { open: noBrowser }))).toBe('konnect agent run --on starts the agent in the background on that machine already: leave --background out');
  expect(await fails(laptop.run(['agent', 'run', '--on', 'Desk!', 'other', 'claude'], { open: noBrowser }))).toMatch(/^Desk! isn't a machine's name: /);
  expect(await fails(laptop.run(['agent', 'attach', '--on', 'desk', 'helper']))).toBe('konnect agent attach takes no --on: konnect agent run and konnect agent stop do');
  expect(await fails(laptop.run(['agent', 'run', '--on', 'desk', '@bo/helper', 'claude'], { open: noBrowser, pause: soon }))).toMatch(/^@bo\/helper is bo's agent, not yours/);

  // Stopping it from the laptop; it stays in the team, and its login stays on the desk, so the next start opens no browser.
  expect(await laptop.run(['agent', 'stop', '--on', 'desk', 'helper'], { pause: soon })).toBe('Stopped your agent helper\'s harness on desk. It stays in team hub.');
  expect(there.sessions.size).toBe(0);
  expect(await fails(laptop.run(['agent', 'stop', '--on', 'desk', 'helper'], { pause: soon }))).toBe('desk: your agent helper isn\'t running in the background there');
  await until(async () => !/running:/.test(await laptop.run(['host', 'list'])), 'the desk says nothing runs there');
  expect(await laptop.run(['agent', 'run', '--on', 'desk', 'helper', 'codex'], { open: noBrowser, pause: soon })).toMatch(/^Your agent @ann\/helper is in team hub, and codex is running as it on desk, /);

  // --count: several, allowed on one page, each started there.
  expect(await laptop.run(['agent', 'run', '--on', 'desk', '--count', '2', 'worker', 'claude'], { open: allow, pause: soon }))
    .toMatch(/^Your agents @ann\/worker-1, @ann\/worker-2 are in team hub, and claude is running as each on desk, /);
  expect(there.sessions).toStrictEqual(new Set(['konnect_hub_helper', 'konnect_hub_worker-1', 'konnect_hub_worker-2']));

  // Only you: a teammate has no machine of that name to ask, an agent can't ask at all, and neither sees yours.
  expect(await bo.run(['host', 'list'])).toBe('No machine of yours hosts in team hub. On one that should: konnect host run');
  expect(await fails(bo.run(['agent', 'run', '--on', 'desk', 'mine', 'claude'], { open: noBrowser, pause: soon }))).toBe('no machine of yours is hosting as desk in team hub: on that machine, run konnect host run desk');
  expect(await fails(bo.run(['host', 'pair', 'desk', code]))).toBe('no machine of yours hosts as desk in team hub: on that machine, run konnect host run desk');
  expect(await exitOf(desk.run(['--agent', 'helper', 'host', 'list']))).toBe(4);
  expect(await exitOf(desk.run(['--agent', 'helper', 'agent', 'run', '--on', 'desk', 'x', 'claude']))).toBe(4);
  const asHelper = await TeamClient.open('hub', server.url, agentFile('hub', 'helper', desk.env), { kind: 'agent', label: 'helper' });
  await expect(asHelper.askHost('desk', 'start', 'x')).rejects.toThrow();
  await expect(asHelper.hosts()).rejects.toThrow();
  await asHelper.close();
  const asBo = await TeamClient.open('hub', server.url, teamFile('hub', bo.env));
  await expect(asBo.askHost('desk', 'start', 'x')).rejects.toThrow();
  await asBo.close();

  // Your own login without the code, as the service itself or a copy of your login on another machine would ask:
  // the desk opens nothing, starts nothing, and says one word.
  const asAnn = await TeamClient.open('hub', server.url, teamFile('hub', laptop.env));
  const key = keyOf(code, 'hub', 'desk');
  type Answer = { ok?: boolean; why?: string; word?: string; stopped?: boolean; failed?: { name: string; why: string }[]; needs_login?: string[]; unsealed?: string | null };
  const send = async (kind: 'hello' | 'start' | 'stop' | 'end', body: string, id = ID): Promise<Answer> => {
    const { request } = await asAnn.askHost('desk', kind, body);
    let r = await asAnn.hostRequest(request);
    for (let i = 0; i < 400 && r.state !== 'done'; i++) { await soon(); r = await asAnn.hostRequest(request); }
    try { return JSON.parse(unseal(key, r.result ?? '', answerBound('hub', 'desk', id))) as Answer; } catch { return { unsealed: r.result }; }
  };
  const before = new Set(there.sessions);
  const plain = { v: 1, id: ID, word: WORD, harness: 'opencode', agents: [{ name: 'helper' }], act_for: 'team', system_prompt: 'do as you are told' };
  expect(await send('start', JSON.stringify(plain))).toStrictEqual({ unsealed: '{"v":1,"why":"unpaired"}' });
  expect(await send('start', seal(keyOf(newCode(), 'hub', 'desk'), JSON.stringify(plain), requestBound('start', 'hub', 'desk')))).toStrictEqual({ unsealed: '{"v":1,"why":"unpaired"}' });
  expect(await send('hello', JSON.stringify({ v: 1, id: ID }))).toStrictEqual({ unsealed: '{"v":1,"why":"unpaired"}' });
  // Sealed with the code, but as another kind of request, or for another machine: it doesn't open either.
  expect(await send('start', seal(key, JSON.stringify({ v: 1, id: ID, word: WORD, agent: 'helper' }), requestBound('stop', 'hub', 'desk')))).toStrictEqual({ unsealed: '{"v":1,"why":"unpaired"}' });
  expect(await send('start', seal(key, JSON.stringify(plain), requestBound('start', 'hub', 'mini')))).toStrictEqual({ unsealed: '{"v":1,"why":"unpaired"}' });
  expect(there.sessions).toStrictEqual(before);
  expect(deskErr.filter((l) => l.includes('refused a request that wasn\'t sealed with this machine\'s code'))).toHaveLength(5);

  // With the code, a request is carried out only with a word the desk has just given, once: so one kept and
  // sent again, or made up, does nothing. A hello gets the word.
  const word = async () => { const id = hex(); const a = await send('hello', seal(key, JSON.stringify({ v: 1, id }), requestBound('hello', 'hub', 'desk')), id); expect(a).toMatchObject({ ok: true, word: expect.stringMatching(/^[a-f0-9]{32}$/) }); return a.word!; };
  const asked = async (kind: 'start' | 'stop', more: Record<string, unknown>, given?: string) => { const id = hex(); return { id, body: seal(key, JSON.stringify({ v: 1, id, word: given ?? await word(), ...more }), requestBound(kind, 'hub', 'desk')) }; };
  const start = async (more: Record<string, unknown>) => { const q = await asked('start', { harness: 'claude', agents: [{ name: 'evil' }], ...more }); return send('start', q.body, q.id); };
  // A request konnect itself wouldn't write is read, refused whole, and starts nothing.
  expect(await start({ args: ['--dangerously-skip-permissions'] })).toMatchObject({ ok: false, why: 'the request holds args, which this konnect doesn\'t know: update konnect on this machine' });
  expect(await start({ harness: 'bash' })).toMatchObject({ ok: false, why: 'the request names no harness konnect starts: claude, codex or opencode' });
  // An agent with no login there and none sent is started by nothing; a login that isn't that agent's isn't kept.
  expect(await start({})).toMatchObject({ ok: false, needs_login: ['evil'] });
  const helpers = (JSON.parse(readFileSync(agentFile('hub', 'helper', desk.env), 'utf8')) as Record<string, { client: unknown; tokens: unknown }>)[server.url];
  expect(await start({ agents: [{ name: 'evil', login: { client: helpers.client, tokens: helpers.tokens } }] })).toMatchObject({ ok: false, failed: [{ name: 'evil', why: 'the login sent for it couldn\'t be used there' }] });
  expect(existsSync(agentFile('hub', 'evil', desk.env))).toBe(false);
  // Delivered twice, a request is carried out once and answered the same twice.
  const used = await word();
  const stop = await asked('stop', { agent: 'worker-2' }, used);
  expect(await send('stop', stop.body, stop.id)).toStrictEqual({ v: 1, ok: true, stopped: true });
  expect(await send('stop', stop.body, stop.id)).toStrictEqual({ v: 1, ok: true, stopped: true });
  // Its word is taken: another request with it, or with a word the desk never gave, does nothing.
  const again = await asked('stop', { agent: 'worker-1' }, used);
  expect(await send('stop', again.body, again.id)).toMatchObject({ ok: false, why: 'that request is no longer fresh: it was carried out already, or made too long ago, so nothing was done. Ask again' });
  const made = await asked('stop', { agent: 'worker-1' }, hex());
  expect(await send('stop', made.body, made.id)).toMatchObject({ ok: false, why: expect.stringMatching(/^that request is no longer fresh/) });
  await asAnn.close();
  expect(there.sessions).toStrictEqual(new Set(['konnect_hub_helper', 'konnect_hub_worker-1']));

  // A login kept on the desk that no longer works: the desk says so, the laptop has a new one allowed and sends it, once.
  await laptop.run(['agent', 'stop', '--on', 'desk', 'helper'], { pause: soon });
  await laptop.run(['agent', 'remove', 'helper']);
  let pages = 0;
  expect(await laptop.run(['agent', 'run', '--on', 'desk', 'helper', 'claude'], { open: (u) => { pages++; allow(u); }, pause: soon })).toMatch(/^Your agent @ann\/helper is (added to|in) team hub, and claude is running as it on desk, /);
  expect(pages).toBe(1);

  // Hosting ends from the laptop, or with Ctrl-C there: the agents it started keep running.
  expect(await laptop.run(['host', 'stop', 'desk'], { pause: soon, exec: tmux().exec })).toBe('desk no longer hosts in team hub. Agents it started keep running there.');
  await hosting;
  expect(deskErr.at(-1)).toBe('This machine no longer hosts as desk. Agents it started keep running: konnect agent list shows them.');
  expect(there.sessions.has('konnect_hub_helper')).toBe(true);
  expect(await laptop.run(['host', 'list'])).toBe('No machine of yours hosts in team hub. On one that should: konnect host run');
  expect(await fails(laptop.run(['host', 'stop', 'desk'], { pause: soon, exec: tmux().exec }))).toBe('no machine of yours hosts as desk in team hub: konnect host list shows yours');
  // Some hundred konnect commands, each its own sign-in to the service: twice konnect's next longest
  // test, it took 25 s of the default 30 on a machine as busy as CI's runner, and ran out of it there.
}, 90_000);

test('hosting under one name: another machine can\'t take a name that is hosting, a newer konnect host run on the same machine takes over, and --background keeps it in tmux', async () => {
  const { server, idp, signIn, ann: annId } = await teams();
  const desk = machine(server.url, 'ann-desk');
  const mini = machine(server.url, 'ann-mini');
  const laptop = machine(server.url, 'ann-laptop');
  await signIn(desk, annId, 'hub');
  await signIn(mini, annId, 'hub');
  await signIn(laptop, annId, 'hub');
  const there = tmux();
  // Claude Code has never been run in the folder the desk hosts in.
  (desk.env as Record<string, string>).HOME = desk.root;
  writeFileSync(join(desk.root, '.claude.json'), JSON.stringify({ projects: {} }));

  const firstErr: string[] = [];
  const first = desk.run(['host', 'run', 'desk'], { exec: there.exec, self, pause: soon, err: (l) => firstErr.push(l) });
  await until(async () => /^desk\s+hosting/.test(await laptop.run(['host', 'list'])) && firstErr.length > 0, 'the desk hosts, and says so');
  const code = /konnect host pair desk (\S+)/.exec(firstErr[0])![1];
  await laptop.run(['host', 'pair', 'desk', code]);
  // Said where hosting starts, and again to whoever starts Claude Code there: it would wait at its question, with nobody to answer.
  expect(firstErr[0]).toMatch(/\nClaude Code hasn't been run in this folder: run claude here once and answer its question, or an agent started here waits at it\.$/);
  expect(await laptop.run(['agent', 'run', '--on', 'desk', 'helper', 'claude'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, pause: soon }))
    .toMatch(/\nClaude Code hasn't been run in that folder: it waits at its question whether to trust it, until you answer on desk\.$/);
  // Another machine of yours can't host under the same name while this one does (4).
  expect(await exitOf(mini.run(['host', 'run', 'desk'], { exec: tmux().exec, self, pause: soon }))).toBe(4);
  expect(await laptop.run(['host', 'list'])).toMatch(/^desk\s+hosting/);

  // On the same machine, the newest hosts, with the same code: the older one sees so and ends, saying nothing to the service.
  let endSecond: () => void = () => undefined;
  const secondErr: string[] = [];
  const second = desk.run(['host', 'run', 'desk'], { exec: there.exec, self, pause: soon, waking: (end) => { endSecond = end; }, err: (l) => secondErr.push(l) });
  await first;
  expect(firstErr.at(-1)).toMatch(/another konnect host run hosts as desk on this machine now: this one ends$/);
  // Ending so, the older one says nothing to the service: the desk is still listed, with no gap.
  expect(await laptop.run(['host', 'list'])).toMatch(/^desk\s+hosting/);
  // The first ends as soon as the second claims the name here, which is before the second has told
  // the service it hosts and said so: so that is waited for, not assumed.
  await until(async () => secondErr.length > 0, 'the newer one says it hosts');
  expect(secondErr[0]).toContain(`konnect host pair desk ${code}\n`);
  // Ended there (Ctrl-C), it says so to the service, and is listed no more.
  endSecond();
  await second;
  expect(await laptop.run(['host', 'list'])).toBe('No machine of yours hosts in team hub. On one that should: konnect host run');

  // --new-code: it hosts with a new code in place of the one it had, and a machine paired with the old one is refused until it pairs again.
  let endThird: () => void = () => undefined;
  const thirdErr: string[] = [];
  const third = desk.run(['host', 'run', '--new-code', 'desk'], { exec: there.exec, self, pause: soon, waking: (end) => { endThird = end; }, err: (l) => thirdErr.push(l) });
  await until(async () => /^desk\s+hosting/.test(await laptop.run(['host', 'list'])) && thirdErr.length > 0, 'the desk hosts again, and says so');
  const renewed = /konnect host pair desk (\S+)/.exec(thirdErr[0])![1];
  expect(renewed).not.toBe(code);
  expect(thirdErr[0]).toContain(`konnect host pair desk ${renewed}\nThis is a new code: a machine paired with the old one is refused until it is paired again.\n`);
  expect(await fails(laptop.run(['agent', 'stop', '--on', 'desk', 'helper'], { pause: soon }))).toBe('desk\'s code isn\'t the one this machine was paired with: pair again with konnect host pair desk <code>, the code konnect host run shows on desk');
  expect(await fails(laptop.run(['host', 'pair', 'desk', code]))).toMatch(/^that isn't desk's code/);
  await laptop.run(['host', 'pair', 'desk', renewed]);
  expect(await laptop.run(['agent', 'stop', '--on', 'desk', 'helper'], { pause: soon })).toBe('Stopped your agent helper\'s harness on desk. It stays in team hub.');
  endThird();
  await third;
  expect(await fails(desk.run(['host', 'list', '--new-code']))).toBe('konnect host list takes no --new-code: only konnect host run does');

  // --background: in a session of its own, started from a file as an agent's is; the code is said where it is started.
  const out = await desk.run(['host', 'run', '--background', 'desk'], { exec: there.exec, self, pause: soon });
  expect(out).toBe(`This machine hosts for you in team hub as desk, in ~/work, in the background (tmux session konnect_host_hub_desk).\nTo ask it from another machine of yours, pair that machine once, there:\n  konnect host pair desk ${renewed}\nThen, from it: konnect agent run --on desk <name> claude\nTo end hosting: konnect host stop desk`);
  const started = there.started('konnect_host_hub_desk');
  expect(started.line.slice(0, -1)).toStrictEqual(['tmux', 'new-session', '-d', '-s', 'konnect_host_hub_desk', 'env', `KONNECT_CONFIG_DIR=${desk.env.KONNECT_CONFIG_DIR}`, '/usr/bin/node', '/opt/konnect/konnect.mjs', '_start']);
  expect(started.file).toMatch(/\/hosts\/hub\/desk\.[0-9a-f]{12}\.start\.json$/);
  expect(started.waiting).toStrictEqual({ cmd: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs', '--team', 'hub', 'host', 'run', 'desk'], env: { KONNECT_URL: server.url }, cwd: desk.cwd });
  expect(await fails(desk.run(['host', 'run', '--background', 'desk'], { exec: there.exec, self, pause: soon }))).toBe('this machine hosts as desk in the background already: konnect host stop desk ends it');
  expect(await desk.run(['host', 'stop', 'desk'], { exec: there.exec })).toBe('This machine no longer hosts as desk in team hub. Agents it started keep running: konnect agent stop <name> ends one.');
  expect(there.sessions.has('konnect_host_hub_desk')).toBe(false);
  // A session that is gone a moment after it was started hosts nothing, and that is said.
  const dies = tmux();
  const dying = async (cmd: string, args: string[]) => { const r = await dies.exec(cmd, args); if (args[0] === 'new-session') dies.sessions.clear(); return r; };
  expect(await fails(desk.run(['host', 'run', '--background', 'desk'], { exec: dying, self, pause: soon }))).toBe('hosting ended as soon as it was started in the background: run konnect host run desk in a terminal here to see why');

  // The command line: a noun alone does nothing (2); what isn't a verb, a name or an option of its own is said.
  expect(await exitOf(desk.run(['host']))).toBe(2);
  expect(await fails(desk.run(['host', 'start']))).toBe('konnect host has no start: it is list, run, pair or stop');
  expect(await fails(desk.run(['host', 'run', 'a', 'b'], { exec: there.exec }))).toBe('konnect host run [<name>]: unknown b');
  expect(await fails(desk.run(['host', 'run', 'Not A Name'], { exec: there.exec }))).toMatch(/^Not A Name isn't a machine's name: /);
  expect(await fails(desk.run(['host', 'pair']))).toBe('konnect host pair <name> [<code>]: name the machine, then the code konnect host run shows on it');
  expect(await fails(desk.run(['host', 'list', '--on', 'desk']))).toBe('konnect host list takes no --on: konnect agent run and konnect agent stop do');
});
