// konnect host, against a Kolab started here: a machine of a person's own that starts their agents
// when they ask from another machine. What a request may carry and what it may not, who may ask,
// how an agent's login reaches the machine, and hosting itself: starting, taking over, ending.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from '@jest/globals';
import { TeamClient, agentFile, bound, formatHosts, newKeys, parseArgs, readStart, readStop, seal, teamFile, thisMachine, unseal } from '../src/konnect.js';
import { browse, exitOf, fails, machine, pressing, teams } from './team.js';

afterEach(() => { process.exitCode = 0; });

const self = () => ({ command: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs'] });
/** Waits without waiting: a hosting machine's tick, and an asker's look, in a moment. */
const soon = () => new Promise<void>((r) => { setTimeout(r, 10); });
const until = async (what: () => Promise<boolean>, why: string) => {
  for (let i = 0; i < 400; i++) { if (await what()) return; await soon(); }
  throw new Error(`never happened: ${why}`);
};

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
  return { sessions, ran, state, exec };
}

test('a login is sealed to one machine\'s key, for one team, machine and agent: nothing else opens it, and a changed one doesn\'t open', () => {
  const desk = newKeys();
  const other = newKeys();
  expect(desk.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const sealed = seal(desk.publicKey, '{"tokens":"secret"}', bound('hub', 'desk', 'helper'));
  expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  expect(sealed).not.toContain('secret');
  expect(unseal(desk, sealed, bound('hub', 'desk', 'helper'))).toBe('{"tokens":"secret"}');
  // Sealed twice, it reads differently each time.
  expect(seal(desk.publicKey, '{"tokens":"secret"}', bound('hub', 'desk', 'helper'))).not.toBe(sealed);
  // Another machine's key, another agent, another machine's name, another team: none opens it.
  expect(() => unseal(other, sealed, bound('hub', 'desk', 'helper'))).toThrow();
  expect(() => unseal(desk, sealed, bound('hub', 'desk', 'other'))).toThrow();
  expect(() => unseal(desk, sealed, bound('hub', 'mini', 'helper'))).toThrow();
  expect(() => unseal(desk, sealed, bound('side', 'desk', 'helper'))).toThrow();
  // Changed on the way, it doesn't open.
  const parts = sealed.split('.');
  parts[3] = `${parts[3].slice(0, -2)}${parts[3].endsWith('AA') ? 'BB' : 'AA'}`;
  expect(() => unseal(desk, parts.join('.'), bound('hub', 'desk', 'helper'))).toThrow();
  expect(() => unseal(desk, 'not sealed', bound('hub', 'desk', 'helper'))).toThrow('that isn\'t a sealed login');
  expect(() => seal('short', 'x', 'y')).toThrow('that isn\'t a machine\'s key');
});

test('a request to start agents carries names, a harness and konnect\'s own options, and anything else is refused, never ignored', () => {
  const ok = { v: 1, harness: 'claude', agents: [{ name: 'helper' }], act_for: 'me', wake_on: ['general', '#deploys'], system_prompt: 'be brief;' };
  expect(readStart(JSON.stringify(ok))).toStrictEqual({ v: 1, harness: 'claude', agents: [{ name: 'helper' }], act_for: 'me', wake_on: ['general', 'deploys'], system_prompt: 'be brief;' });
  expect(readStart(JSON.stringify({ v: 1, harness: 'opencode', agents: [{ name: 'a' }, { name: 'b' }] }))).toStrictEqual({ v: 1, harness: 'opencode', agents: [{ name: 'a' }, { name: 'b' }] });
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
  expect(refused({ agents: [{ name: 'a', login: 'plain text' }] })).toBe('the login sent for a isn\'t a sealed login');
  expect(refused({ act_for: 'everyone' })).toBe('the request\'s act_for isn\'t nobody, me or team');
  expect(refused({ wake_on: ['general', 'has space'] })).toBe('the request\'s wake_on names something that isn\'t a channel');
  expect(refused({ wake_on: ['a,b'] })).toMatch(/isn't a list of at most 20 channels/);
  expect(refused({ system_prompt: 'x'.repeat(16_001) })).toBe('the request\'s system prompt isn\'t text of at most 16000 characters');
  expect(refused({ system_prompt: ['x'] })).toMatch(/system prompt isn't text/);
  expect(refused({ v: 2 })).toBe('the request is from a newer konnect than this machine\'s: update konnect on this machine');
  expect(() => readStart('not json')).toThrow('the request isn\'t one konnect wrote');
  expect(() => readStart('[]')).toThrow('the request isn\'t one konnect wrote');
  expect(readStop('{"v":1,"agent":"helper"}')).toStrictEqual({ agent: 'helper' });
  expect(() => readStop('{"v":1,"agent":"x","signal":9}')).toThrow(/holds signal/);
  expect(() => readStop('{"v":1,"agent":"../x"}')).toThrow(/isn't an agent's name/);

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

test('konnect host run makes a machine start your agents when you ask from another: agent run --on and agent stop --on, the login sent sealed, and only what konnect itself offers', async () => {
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

  // The desk hosts, in the folder it was told to in, until it is ended.
  let endHosting: () => void = () => undefined;
  const deskErr: string[] = [];
  const hosting = desk.run(['host', 'run', 'desk'], { exec: there.exec, self, pause: soon, waking: (end) => { endHosting = end; }, err: (l) => deskErr.push(l) });
  await until(async () => /^desk\s+hosting/.test(await laptop.run(['host', 'list'])), 'the desk hosts');
  expect(deskErr[0]).toBe(`This machine hosts for you (@ann) in team hub as desk, in ~/work.\nFrom any machine you are logged in on: konnect agent run --on desk <name> claude\nOnly you can start an agent here, and only claude, codex or opencode with konnect's own options; what it may do here is set in its harness. Ctrl-C ends hosting.`);
  expect(JSON.parse(await laptop.run(['host', 'list', '--json']))).toMatchObject([{ name: 'desk', folder: '~/work', serving: true, agents: [], running: [] }]);
  expect(await laptop.run(['host', 'list', '--json'])).not.toContain('public_key');

  // From the laptop: the agent is new, so it is allowed in the browser there, and started on the desk.
  const out = await laptop.run(['agent', 'run', '--on', 'desk', '--act-for', 'me', '--wake-on', 'general', '--system-prompt', 'be brief;', 'helper', 'claude'], { open: allow, pause: soon });
  expect(out).toBe(`Your agent @ann/helper is added to team hub, and claude is running as it on desk, in ~/work.\n  konnect agent stop --on desk helper     end it\nTo look in on it, on desk: konnect agent attach helper`);
  expect(there.sessions).toStrictEqual(new Set(['konnect-hub-helper']));
  // Its login is kept on the desk, where it runs, and not on the laptop, where it was allowed.
  expect(existsSync(agentFile('hub', 'helper', desk.env))).toBe(true);
  expect(existsSync(agentFile('hub', 'helper', laptop.env))).toBe(false);
  // The desk started what konnect agent run --background starts, in its own folder, from its own konnect.
  const kept = join(desk.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'helper.start.json');
  expect(there.ran.find((c) => c[1] === 'new-session')).toStrictEqual(['tmux', 'new-session', '-d', '-s', 'konnect-hub-helper', '-c', desk.cwd, '/usr/bin/node', '/opt/konnect/konnect.mjs', '_start', kept]);
  const waiting = JSON.parse(readFileSync(kept, 'utf8')) as { cmd: string; args: string[]; env: Record<string, string> };
  expect(waiting.cmd).toBe('claude');
  expect(waiting.env).toMatchObject({ KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper', KONNECT_ACT_FOR: 'me', KONNECT_WAKE_ON: 'general', KONNECT_SYSTEM_PROMPT: 'be brief;', KONNECT_CONFIG_DIR: desk.env.KONNECT_CONFIG_DIR });
  // Nothing a person wrote reached tmux's command line, where a ';' would end its command.
  expect(there.ran.flat().some((w) => w.includes(';') || w.includes('be brief'))).toBe(false);
  expect(deskErr.join('\n')).toMatch(/\d\d:\d\d:\d\d {2}started helper in claude \(tmux session konnect-hub-helper\)/);

  // The lists say where it runs; a second start of the same agent there is refused (4).
  await until(async () => /^desk\s+hosting\s+\S+\s+running: helper$/.test(await laptop.run(['host', 'list'])), 'the desk says helper runs there');
  expect(await laptop.run(['agent', 'list'], { exec: tmux().exec })).toMatch(/^helper\s+(connected\s+)?running on desk$/m);
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
  expect(there.sessions).toStrictEqual(new Set(['konnect-hub-helper', 'konnect-hub-worker-1', 'konnect-hub-worker-2']));

  // Only you: a teammate has no machine of that name to ask, an agent can't ask at all, and neither sees yours.
  expect(await bo.run(['host', 'list'])).toBe('No machine of yours hosts in team hub. On one that should: konnect host run');
  expect(await fails(bo.run(['agent', 'run', '--on', 'desk', 'mine', 'claude'], { open: noBrowser, pause: soon }))).toBe('no machine of yours is hosting as desk in team hub: on that machine, run konnect host run desk');
  expect(await exitOf(desk.run(['--agent', 'helper', 'host', 'list']))).toBe(4);
  expect(await exitOf(desk.run(['--agent', 'helper', 'agent', 'run', '--on', 'desk', 'x', 'claude']))).toBe(4);
  const asHelper = await TeamClient.open('hub', server.url, agentFile('hub', 'helper', desk.env), { kind: 'agent', label: 'helper' });
  await expect(asHelper.askHost('desk', 'start', JSON.stringify({ v: 1, harness: 'claude', agents: [{ name: 'evil' }] }))).rejects.toThrow();
  await expect(asHelper.hosts()).rejects.toThrow();
  await asHelper.close();
  const asBo = await TeamClient.open('hub', server.url, teamFile('hub', bo.env));
  await expect(asBo.askHost('desk', 'start', JSON.stringify({ v: 1, harness: 'claude', agents: [{ name: 'evil' }] }))).rejects.toThrow();
  await asBo.close();

  // A request konnect itself wouldn't write, sent by you all the same: the desk reads it, refuses it whole, and starts nothing.
  const asAnn = await TeamClient.open('hub', server.url, teamFile('hub', laptop.env));
  const ask = async (body: unknown) => {
    const { request } = await asAnn.askHost('desk', 'start', JSON.stringify(body));
    let r = await asAnn.hostRequest(request);
    for (let i = 0; i < 400 && r.state !== 'done'; i++) { await soon(); r = await asAnn.hostRequest(request); }
    return { ok: r.ok, ...(JSON.parse(r.result ?? '{}') as { why?: string; failed?: { name: string; why: string }[]; needs_login?: string[] }) };
  };
  const before = there.sessions.size;
  expect(await ask({ v: 1, harness: 'claude', agents: [{ name: 'evil' }], args: ['--dangerously-skip-permissions'] })).toMatchObject({ ok: false, why: 'the request holds args, which this konnect doesn\'t know: update konnect on this machine' });
  expect(await ask({ v: 1, harness: 'bash', agents: [{ name: 'evil' }] })).toMatchObject({ ok: false, why: 'the request names no harness konnect starts: claude, codex or opencode' });
  // An agent with no login there and none sent is started by nothing; a login that isn't one, or sealed for another agent, isn't kept.
  expect(await ask({ v: 1, harness: 'claude', agents: [{ name: 'evil' }] })).toMatchObject({ ok: false, needs_login: ['evil'] });
  const key = (await asAnn.hosts())[0].public_key;
  expect(await ask({ v: 1, harness: 'claude', agents: [{ name: 'evil', login: seal(key, '{"client":{},"tokens":{}}', bound('hub', 'desk', 'evil')) }] })).toMatchObject({ ok: false, failed: [{ name: 'evil', why: 'the login sent for it couldn\'t be used there' }] });
  expect(await ask({ v: 1, harness: 'claude', agents: [{ name: 'evil', login: seal(key, readFileSync(agentFile('hub', 'helper', desk.env), 'utf8'), bound('hub', 'desk', 'other')) }] })).toMatchObject({ ok: false, failed: [{ name: 'evil' }] });
  await asAnn.close();
  expect(there.sessions.size).toBe(before);
  expect(existsSync(agentFile('hub', 'evil', desk.env))).toBe(false);

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
  expect(there.sessions.has('konnect-hub-helper')).toBe(true);
  expect(await laptop.run(['host', 'list'])).toBe('No machine of yours hosts in team hub. On one that should: konnect host run');
  expect(await fails(laptop.run(['host', 'stop', 'desk'], { pause: soon, exec: tmux().exec }))).toBe('no machine of yours hosts as desk in team hub: konnect host list shows yours');
  void endHosting;
});

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
  await until(async () => /^desk\s+hosting/.test(await laptop.run(['host', 'list'])), 'the desk hosts');
  // Said where hosting starts, and again to whoever starts Claude Code there: it would wait at its question, with nobody to answer.
  expect(firstErr[0]).toMatch(/\nClaude Code hasn't been run in this folder: run claude here once and answer its question, or an agent started here waits at it\.$/);
  expect(await laptop.run(['agent', 'run', '--on', 'desk', 'helper', 'claude'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, pause: soon }))
    .toMatch(/\nClaude Code hasn't been run in that folder: it waits at its question whether to trust it, until you answer on desk\.$/);
  // Another machine of yours can't host under the same name while this one does (4).
  expect(await exitOf(mini.run(['host', 'run', 'desk'], { exec: tmux().exec, self, pause: soon }))).toBe(4);
  expect(await laptop.run(['host', 'list'])).toMatch(/^desk\s+hosting/);

  // On the same machine, the newest hosts: the older one sees so and ends, saying nothing to the service.
  let endSecond: () => void = () => undefined;
  const second = desk.run(['host', 'run', 'desk'], { exec: there.exec, self, pause: soon, waking: (end) => { endSecond = end; }, err: () => undefined });
  await first;
  expect(firstErr.at(-1)).toMatch(/another konnect host run hosts as desk on this machine now: this one ends$/);
  expect(await laptop.run(['host', 'list'])).toMatch(/^desk\s+hosting/);
  // Ended there (Ctrl-C), it says so to the service, and is listed no more.
  endSecond();
  await second;
  expect(await laptop.run(['host', 'list'])).toBe('No machine of yours hosts in team hub. On one that should: konnect host run');

  // --background: in a session of its own, started from a file as an agent's is; host stop ends it here.
  const out = await desk.run(['host', 'run', '--background', 'desk'], { exec: there.exec, self });
  expect(out).toBe(`This machine hosts for you in team hub as desk, in ~/work, in the background (tmux session konnect_host_hub_desk).\n  konnect agent run --on desk <name> claude     from any machine you are logged in on, start an agent here\n  konnect host stop desk                        end it`);
  const kept = join(desk.env.KONNECT_CONFIG_DIR, 'hosts', 'hub', 'desk.start.json');
  expect(there.ran.find((c) => c[1] === 'new-session')).toStrictEqual(['tmux', 'new-session', '-d', '-s', 'konnect_host_hub_desk', '-c', desk.cwd, '/usr/bin/node', '/opt/konnect/konnect.mjs', '_start', kept]);
  expect(JSON.parse(readFileSync(kept, 'utf8'))).toStrictEqual({ cmd: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs', '--team', 'hub', 'host', 'run', 'desk'], env: { KONNECT_URL: server.url, KONNECT_CONFIG_DIR: desk.env.KONNECT_CONFIG_DIR } });
  expect(await fails(desk.run(['host', 'run', '--background', 'desk'], { exec: there.exec, self }))).toBe('this machine hosts as desk in the background already: konnect host stop desk ends it');
  expect(await desk.run(['host', 'stop', 'desk'], { exec: there.exec })).toBe('This machine no longer hosts as desk in team hub. Agents it started keep running: konnect agent stop <name> ends one.');
  expect(there.sessions.has('konnect_host_hub_desk')).toBe(false);
  rmSync(kept, { force: true });

  // The command line: a noun alone does nothing (2); what isn't a verb, a name or an option of its own is said.
  expect(await exitOf(desk.run(['host']))).toBe(2);
  expect(await fails(desk.run(['host', 'start']))).toBe('konnect host has no start: it is list, run or stop');
  expect(await fails(desk.run(['host', 'run', 'a', 'b'], { exec: there.exec }))).toBe('konnect host run [<name>]: unknown b');
  expect(await fails(desk.run(['host', 'run', 'Not A Name'], { exec: there.exec }))).toMatch(/^Not A Name isn't a machine's name: /);
  expect(await fails(desk.run(['host', 'list', '--on', 'desk']))).toBe('konnect host list takes no --on: konnect agent run and konnect agent stop do');
});
