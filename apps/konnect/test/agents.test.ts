// konnect's teams and agents end to end, against a Kolab started here (test/team.ts): the owner
// invites a teammate by GitHub username, who runs konnect login with no team, picks the invitation
// on Kolab's page and lands in the team; team list shows the owner who is invited; team remove
// withdraws an invitation or removes a member; team leave names the team and drops the agents'
// logins with it. Then `konnect agent run|add|list|remove`: the agent made and logged in through
// Kolab's setup page, its entry with no token, the harness started (or what to install), and
// `--agent` acting as it.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@jest/globals';
import { agentSetupScope, systemPrompt, toolCommand } from '../src/konnect.js';
import { browse, exitOf, fails, machine, pressing, teams } from './team.js';

const cy = { subject: '43', login: 'cy' };

test('the owner invites by GitHub username; the teammate runs konnect login with no team, accepts on Kolab\'s page and lands in it; team list, remove and leave', async () => {
  const { server, idp, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  const cyM = machine(server.url, 'cy');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');

  // Cy, in no team and invited nowhere: konnect login says there is nothing to log in to, and what to do (4).
  idp.next(cy);
  expect(await fails(cyM.run(['login'], { open: (u) => { void browse(u, (b) => pressing('decision=')(b)); } })))
    .toBe('there is nothing to log in to yet: no invitation waits for your GitHub account, and you are in no team. Create your own with konnect team create <name>, or ask a team\'s owner to run konnect team invite <your GitHub username>, then run konnect login again');

  // Only the owner invites.
  expect(await fails(bo.run(['team', 'invite', 'cy']))).toBe('only team hub\'s owner can do that: ask them');
  expect(await exitOf(bo.run(['team', 'invite', 'cy']))).toBe(4);
  expect(await fails(ann.run(['team', 'invite']))).toBe('konnect team invite <github-user>...: name who to invite');
  expect(await ann.run(['team', 'invite', '@cy', 'bo'])).toBe('Invited: cy.\nAlready in the team: bo.\nThey join by running, with the GitHub account you named:\n  npx @konjir/konnect login');
  expect(await ann.run(['team', 'invite', 'cy'])).toBe('Already invited: cy.\nThey join by running, with the GitHub account you named:\n  npx @konjir/konnect login');
  // The owner's team list shows who is invited; anyone else's doesn't.
  const owners = (await ann.run(['team', 'list'])).split('\n');
  expect(owners.slice(0, 3)).toStrictEqual(['@ann (you)     person', '@ann/reviewer  agent', '@bo            person']);
  expect(owners[3]).toMatch(/^@cy {12}person {2}invited \d{4}-\d\d-\d\d$/);
  expect(owners).toHaveLength(4);
  expect(JSON.parse(await ann.run(['team', 'list', '--json'])).invited).toMatchObject([{ account: 'cy', invited_by: 'ann' }]);
  expect(await bo.run(['team', 'list'])).not.toContain('@cy');

  // Cy runs konnect login with no team: Kolab's page lists the invitation, and Cy accepts it.
  let page = '';
  idp.next(cy);
  const joined = await cyM.run(['login'], { open: (u) => { void browse(u, (b, h) => { page = h; return pressing('pick=accept:')(b); }); } });
  expect(page).toContain('hub');
  expect(joined).toMatch(/^You're in team hub, as @cy\.\n\n@ann {2,}person\n/);
  expect(joined).toContain('\n@cy (you)      person\n');
  expect(joined).toMatch(/\n\nNext:\n {2}konnect status {22}what is waiting for you\n {2}konnect send '#general' "hello" {5}say hello to the team\n {2}konnect agent run <name> claude {5}bring an agent of yours into the team$/);
  expect(existsSync(join(cyM.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json'))).toBe(true);
  // Nothing of the choosing login is left behind under its own name.
  expect(readdirSync(join(cyM.env.KONNECT_CONFIG_DIR, 'teams'))).toStrictEqual(['hub.json']);
  expect(readdirSync(cyM.cwd)).toStrictEqual([]);
  // A Read member talks: in #general, and with a direct message.
  expect(await cyM.run(['send', '#general', 'hi all'])).toBe('Sent to #general.');
  expect(await ann.run(['receive', '#general'])).toMatch(/@cy\n {2}hi all$/);
  expect(await ann.run(['team', 'list'])).not.toContain('invited');

  // team remove <person>: an invitation that waits is withdrawn; a member is removed, agents and all.
  idp.account({ subject: '44', login: 'dee' });
  await ann.run(['team', 'invite', 'dee']);
  expect(await ann.run(['team', 'remove', '@dee'])).toBe('Withdrew dee\'s invitation to team hub.');
  expect(await ann.run(['team', 'list'])).not.toContain('@dee');
  expect(await exitOf(ann.run(['team', 'remove', 'dee']))).toBe(4);
  expect(await fails(ann.run(['team', 'remove', '@ann/reviewer']))).toBe('konnect team remove takes a person, and ann/reviewer is an agent: its owner removes it with konnect agent remove reviewer');
  expect(await exitOf(ann.run(['team', 'remove', '@ann/reviewer']))).toBe(2);
  expect(await fails(bo.run(['team', 'remove', '@cy']))).toBe('only team hub\'s owner can do that: ask them');
  expect(await ann.run(['team', 'remove', '@cy'])).toMatch(/^Removed @cy from team hub: \d+ sessions? ended\.$/);
  expect(await exitOf(cyM.run(['team', 'list']))).toBe(3);

  // team leave <team>: named, never resolved; the agents go too, and konnect drops their logins here.
  const allow = (u: URL) => { idp.next(boId); void browse(u, pressing('decision=allow')); };
  await bo.run(['agent', 'add', 'bot'], { open: allow, self: () => ({ command: 'node', args: ['k.mjs'] }) });
  expect(existsSync(join(bo.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'bot.json'))).toBe(true);
  expect(await fails(bo.run(['team', 'leave']))).toBe('konnect team leave <team>: name the team to leave');
  expect(await bo.run(['team', 'leave', 'hub'])).toMatch(/^You left team hub, and your agents \S+ with you\. konnect dropped its logins to it here\.$/);
  expect(existsSync(join(bo.env.KONNECT_CONFIG_DIR, 'agents', 'hub'))).toBe(false);
  expect(await fails(bo.run(['status']))).toBe('you aren\'t logged in to a team: run konnect login, or konnect team create <name>');
  expect(await ann.run(['team', 'list'])).not.toMatch(/@bo/);
  // The owner can't leave.
  expect(await fails(ann.run(['team', 'leave', 'hub']))).toBe('you own team hub, so you can\'t leave it');
  expect(await exitOf(ann.run(['team', 'leave', 'hub']))).toBe(4);
});

test('konnect agent run <name> claude: the agent added and logged in on Kolab\'s setup page, its .mcp.json entry with no token and with its system prompt\'s parts, and Claude Code started as the agent', async () => {
  const { server, idp, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  const self = () => ({ command: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs'] });
  let page = '';
  let pages = 0;
  const allow = (u: URL) => { pages++; idp.next(annId); void browse(u, (b, h) => { page = h; return pressing('decision=allow')(b); }); };
  const started: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const start = async (c: { cmd: string; args: string[]; env: Record<string, string> }) => { started.push(c); return 0; };

  const out = await ann.run(['agent', 'run', '--wake-on', '#general', '--wake-on', 'deploys', '--act-for', 'me', '--system-prompt', 'Be brief.', 'helper', 'claude', '--model', 'opus'], { open: allow, self, start });
  expect(out).toBe('');
  expect(page).toContain('helper');
  expect(ann.err.join('\n')).toContain('Your agent @ann/helper is added to team hub.');
  // Nothing is written in the folder: everything Claude Code needs is on its command line, for this session alone.
  expect(existsSync(join(ann.cwd, '.mcp.json'))).toBe(false);
  const entryEnv = { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper', KONNECT_ACT_FOR: 'me', KONNECT_WAKE_ON: 'general,deploys', KONNECT_SYSTEM_PROMPT: 'Be brief.', KONNECT_URL: server.url };
  expect(started).toHaveLength(1);
  const [flagServer, serverJson, flagSettings, settingsJson, flagPrompt, prompt, ...own] = started[0].args;
  expect([started[0].cmd, flagServer, flagSettings, flagPrompt]).toStrictEqual(['claude', '--mcp-config', '--settings', '--append-system-prompt']);
  // Its server, with no token; the hook wakes it, so the server itself is told not to.
  expect(JSON.parse(serverJson)).toStrictEqual({ mcpServers: { 'konnect-helper': { type: 'stdio', command: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs', 'mcp'], env: { ...entryEnv, KONNECT_WAKE: 'hook' } } } });
  expect(started[0].args.join(' ')).not.toMatch(/kj[rsa]_/);
  // The hook that wakes the idle session after each turn and as it starts, and leave to call the agent's own tools.
  const hook = { type: 'command', command: '/usr/bin/node /opt/konnect/konnect.mjs wake', async: true, asyncRewake: true, timeout: 1_728_000 };
  expect(JSON.parse(settingsJson)).toStrictEqual({ permissions: { allow: ['mcp__konnect-helper'] }, hooks: { SessionStart: [{ hooks: [hook] }], Stop: [{ hooks: [hook] }] } });
  // The system prompt is Claude Code's own, added to it; the harness's own arguments follow, untouched.
  expect(prompt).toBe(systemPrompt({ team: 'hub', name: 'helper', owner: 'ann', actFor: 'me', wakeOn: ['general', 'deploys'], own: 'Be brief.' }));
  expect(own).toStrictEqual(['--model', 'opus']);
  // konnect commands run inside the harness act as the agent, and the hook reads the same.
  expect(started[0].env).toStrictEqual(entryEnv);
  // The agent's login is where konnect mcp reads it, the agent's own.
  const file = join(ann.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'helper.json');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, 'utf8'))[server.url].tokens.refresh_token).toMatch(/^kjr_/);
  expect(agentSetupScope('hub', 'helper')).toBe('konjir kolab:hub setup:helper:engineer');

  // Run again: the login kept still works, so no browser; --act-for nobody is the default, left out of the entry.
  expect(pages).toBe(1);
  await ann.run(['agent', 'run', '--act-for', 'nobody', 'helper', 'claude'], { open: () => { throw new Error('no browser'); }, self, start });
  expect(ann.err.join('\n')).toContain('Your agent @ann/helper is in team hub.');
  expect(started[1].env).toStrictEqual({ KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper', KONNECT_URL: server.url });

  // The person's own --settings and --append-system-prompt, after the harness: merged with konnect's, each passed once.
  await ann.run(['agent', 'run', 'helper', 'claude', '--settings', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"mine"}]}]},"permissions":{"allow":["Read"]},"model":"opus"}', '--append-system-prompt', 'Mine too.', '-p', 'hi'], { self, start });
  const third = started[2].args;
  expect(third.filter((w) => w === '--settings' || w === '--append-system-prompt')).toHaveLength(2);
  const merged = JSON.parse(third[third.indexOf('--settings') + 1]);
  expect(merged.model).toBe('opus');
  expect(merged.permissions.allow).toStrictEqual(['Read', 'mcp__konnect-helper']);
  expect(merged.hooks.Stop).toHaveLength(2);
  expect(third[third.indexOf('--append-system-prompt') + 1]).toBe(`${systemPrompt({ team: 'hub', name: 'helper', owner: 'ann' })}\n\nMine too.`);
  expect(third.slice(-2)).toStrictEqual(['-p', 'hi']);
  expect(await fails(ann.run(['agent', 'run', 'helper', 'claude', '--settings', 'not json'], { self, start }))).toMatch(/^konnect couldn't read the --settings file not json/);

  // Claude Code not installed: what to install, and the command to run it with.
  expect(await fails(ann.run(['agent', 'run', 'helper', 'claude'], { self, start: async () => -1 })))
    .toMatch(/^claude isn't installed here \(no claude on PATH\)\. Install Claude Code: npm install -g @anthropic-ai\/claude-code, then run this again\. To start it yourself: claude --mcp-config /);

  // Only claude, codex or opencode; a harness missing, a bad name or a bad channel: nothing is done (2).
  const before = started.length;
  expect(await fails(ann.run(['agent', 'run', 'helper', 'aider'], { self, start }))).toBe('konnect agent run starts claude, codex or opencode, and aider is none of them. For another harness: konnect agent add helper, and put the entry it prints there. For a script: konnect --agent helper send ...');
  expect(await exitOf(ann.run(['agent', 'run', 'helper', 'aider'], { self, start }))).toBe(2);
  expect(await fails(ann.run(['agent', 'run', 'helper'], { self, start }))).toBe('konnect agent run helper <harness>: say what to run it in: claude, codex or opencode');
  expect(await fails(ann.run(['agent', 'run'], { self, start }))).toBe('konnect agent run <name> <harness> [<argument>...]: name the agent, then claude, codex or opencode');
  expect(await fails(ann.run(['agent', 'run', 'Bad Name', 'claude'], { self, start }))).toMatch(/^Bad Name isn't an agent's name: /);
  // An option after the name is the harness's: it is no harness.
  expect(await fails(ann.run(['agent', 'run', 'helper', '--wake-on', '#x', 'claude'], { self, start }))).toMatch(/^konnect agent run: --wake-on is an option of konnect's, and options go before <name>/);
  expect(await fails(ann.run(['agent', 'run', '--wake-on', 'Bad!', 'newer', 'claude'], { open: () => { throw new Error('no browser'); }, self, start }))).toBe('--wake-on names a channel (Bad! isn\'t one)');
  expect(existsSync(join(ann.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'newer.json'))).toBe(false);
  expect(started).toHaveLength(before);
});

test('konnect agent run in codex and opencode: the entry on the command line or in the environment, no file written; Codex isn\'t woken, and OpenCode is, by the konnect beside it', async () => {
  const { server, idp, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  const self = () => ({ command: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs'] });
  const allow = (u: URL) => { idp.next(annId); void browse(u, pressing('decision=allow')); };
  const started: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const start = async (c: { cmd: string; args: string[]; env: Record<string, string> }) => { started.push(c); return 0; };

  await ann.run(['agent', 'run', 'coder', 'codex', 'exec', 'hi'], { open: allow, self, start });
  expect(ann.err.join('\n')).toMatch(/^Your agent @ann\/coder is added to team hub\.\nCodex isn't woken by messages: the agent receives at the start of each turn\.$/m);
  expect(started[0]).toStrictEqual({
    cmd: 'codex',
    args: ['-c', 'mcp_servers.konnect-coder.command="/usr/bin/node"', '-c', 'mcp_servers.konnect-coder.args=["/opt/konnect/konnect.mjs", "mcp"]', '-c', `mcp_servers.konnect-coder.env={ KONNECT_TEAM = "hub", KONNECT_AGENT = "coder", KONNECT_URL = ${JSON.stringify(server.url)} }`, 'exec', 'hi'],
    env: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'coder', KONNECT_URL: server.url },
  });
  // OpenCode is woken by the konnect that started it: it is started on a port of its own, and konnect
  // stays beside it as the agent, submitting the notice of new messages as a prompt, until it ends.
  const waking: { port: number; label: string; owner: string; wakeOn?: string }[] = [];
  let stops = 0;
  const wakeOpenCode = async (o: { port: number; label: string; owner: string; wakeOn?: string }) => { waking.push({ port: o.port, label: o.label, owner: o.owner, wakeOn: o.wakeOn }); return async () => { stops++; }; };
  await ann.run(['agent', 'run', '--wake-on', 'general', 'coder', 'opencode', '--model', 'x/y'], { self, start, port: async () => 4777, wakeOpenCode });
  expect(ann.err.join('\n')).not.toContain('isn\'t woken');
  expect(started[1]).toMatchObject({ cmd: 'opencode', args: ['--port', '4777', '--model', 'x/y'], env: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'coder', KONNECT_WAKE_ON: 'general', KONNECT_URL: server.url } });
  expect(waking).toStrictEqual([{ port: 4777, label: 'coder', owner: 'ann', wakeOn: 'general' }]);
  expect(stops).toBe(1);
  // The server is told not to wake the session itself; konnect does.
  expect(JSON.parse(started[1].env.OPENCODE_CONFIG_CONTENT).mcp['konnect-coder']).toStrictEqual({ type: 'local', command: ['/usr/bin/node', '/opt/konnect/konnect.mjs', 'mcp'], environment: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'coder', KONNECT_WAKE_ON: 'general', KONNECT_URL: server.url, KONNECT_WAKE: 'hook' }, enabled: true });
  expect(readdirSync(ann.cwd)).toStrictEqual([]);
  // A port the person gives OpenCode themselves is the one used, and isn't given twice.
  await ann.run(['agent', 'run', 'coder', 'opencode', '--port', '5123'], { self, start, port: async () => { throw new Error('asked for a port'); }, wakeOpenCode });
  expect(started[2].args).toStrictEqual(['--port', '5123']);
  expect(waking[1].port).toBe(5123);

  // In the background it is konnect that runs in the session, with OpenCode in front of it, so that something is there to wake it.
  const ran: string[][] = [];
  const up = new Set<string>();
  const exec = async (cmd: string, args: string[]) => {
    ran.push([cmd, ...args]);
    if (cmd !== 'tmux') return { code: -1, out: '' };
    if (args[0] === 'new-session') up.add(args[3]);
    return { code: args[0] === 'has-session' ? (up.has(args[2].slice(1)) ? 0 : 1) : 0, out: '' };
  };
  await ann.run(['agent', 'run', '--background', '--act-for', 'me', '--wake-on', 'general', 'coder', 'opencode', '--model', 'x/y'], { self, start, exec, wakeOpenCode, pause: async () => undefined });
  // tmux is given konnect's own plumbing, where konnect keeps its files, and a file's name; what is to run, and where, waits in the file.
  const line = ran.find((c) => c[1] === 'new-session')!;
  expect(line.slice(0, -1)).toStrictEqual(['tmux', 'new-session', '-d', '-s', 'konnect-hub-coder', 'env', `KONNECT_CONFIG_DIR=${ann.env.KONNECT_CONFIG_DIR}`, '/usr/bin/node', '/opt/konnect/konnect.mjs', '_start']);
  expect(line.at(-1)).toMatch(/\/agents\/hub\/coder\.[0-9a-f]{12}\.start\.json$/);
  expect(JSON.parse(readFileSync(line.at(-1)!, 'utf8'))).toStrictEqual({ cmd: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs', '--team', 'hub', 'agent', 'run', '--act-for', 'me', '--wake-on', 'general', 'coder', 'opencode', '--model', 'x/y'], env: { KONNECT_URL: server.url, KONNECT_CONFIG_DIR: ann.env.KONNECT_CONFIG_DIR }, cwd: ann.cwd });
});

test('OpenCode is woken through its own API: the notice is put in its prompt box and submitted, each message once, and tried again while OpenCode isn\'t up', async () => {
  const { kolab, server, idp, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  await ann.run(['agent', 'add', 'coder'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, self: () => ({ command: 'node', args: ['k.mjs'] }) });
  const bo = await kolab.openSession('bo', 'product', { kolab: 'hub' });
  const { wakeOpenCode, withPort } = await import('../src/opencode.js');
  // The port is settled once: the person's when it is usable, else konnect's, and an unusable one of theirs is taken out.
  const ours = async () => 4000;
  expect(await withPort(['--model', 'x'], ours)).toStrictEqual({ port: 4000, args: ['--port', '4000', '--model', 'x'] });
  expect(await withPort(['--port', '5123', '-c'], ours)).toStrictEqual({ port: 5123, args: ['--port', '5123', '-c'] });
  expect(await withPort(['--port=77'], ours)).toStrictEqual({ port: 77, args: ['--port', '77'] });
  expect(await withPort(['--port', '0', '--model', 'x'], ours)).toStrictEqual({ port: 4000, args: ['--port', '4000', '--model', 'x'] });

  // A stand-in for OpenCode's prompt box: what is put in it, and what is sent when it is submitted.
  const given: string[] = [];
  let box = '';
  let appends = 0;
  let up = false;
  let submits = true;
  const stop = await wakeOpenCode({
    team: 'hub', url: server.url, file: join(ann.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'coder.json'), label: 'coder', owner: 'ann', port: 1,
    append: async (text) => { if (!up) return false; appends++; box += text; return true; },
    submit: async () => { if (!submits) return false; given.push(box); box = ''; return true; },
  });
  try {
    // A message while OpenCode isn't answering yet: tried again, and given once it is.
    await kolab.sendMessage(bo, 'ann-coder', 'SECRET are you there?');
    await new Promise((r) => setTimeout(r, 600));
    expect(given).toStrictEqual([]);
    // It takes the notice but not the submit, at first: the notice is put in once, never twice.
    submits = false;
    up = true;
    for (const end = Date.now() + 10_000; !appends && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1_200));
    expect(appends).toBe(1);
    submits = true;
    for (const end = Date.now() + 10_000; !given.length && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
    expect(given).toHaveLength(1);
    expect(given[0]).toMatch(/^New for you in team hub: a direct message from @bo\.\nReceive it now with konnect_receive/);
    expect(given[0]).not.toContain('SECRET');
    // Another message: a second notice, of that one alone.
    await kolab.sendChannelMessage(bo, 'general', 'and this?', { mentions: ['ann/coder'] });
    for (const end = Date.now() + 10_000; given.length < 2 && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
    expect(given[1]).toMatch(/^New for you in team hub: a message in #general \(mentioning you\)\./);
    expect(given).toHaveLength(2);
  } finally { await stop(); }
});

test('konnect agent add prints the entry and starts nothing; agent list says which agents are connected and which are set up here', async () => {
  const { kolab, server, idp, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  const self = () => ({ command: 'node', args: ['k.mjs'] });
  const allow = (u: URL) => { idp.next(annId); void browse(u, pressing('decision=allow')); };
  const start = async () => { throw new Error('started'); };

  const entry = { mcpServers: { 'konnect-helper': { type: 'stdio', command: 'node', args: ['k.mjs', 'mcp'], env: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper', KONNECT_ACT_FOR: 'team', KONNECT_WAKE_ON: 'deploys', KONNECT_SYSTEM_PROMPT: 'Be brief.', KONNECT_URL: server.url } } } };
  expect(await ann.run(['agent', 'add', 'helper', '--act-for', 'team', '--wake-on', '#deploys', '--system-prompt', 'Be brief.'], { open: allow, self, start })).toBe([
    'Your agent @ann/helper is added to team hub, and logged in on this machine.',
    'Put this entry in the harness it runs in (an MCP server):',
    '',
    JSON.stringify(entry, null, 2),
  ].join('\n'));
  expect(readdirSync(ann.cwd)).toStrictEqual([]);
  expect(JSON.parse(await ann.run(['agent', 'add', 'helper', '--json', '--act-for', 'team', '--wake-on', '#deploys', '--system-prompt', 'Be brief.'], { open: () => { throw new Error('no browser'); }, self, start })))
    .toStrictEqual({ team: 'hub', agent: 'ann/helper', added: false, entry });
  expect(await fails(ann.run(['agent', 'add', 'helper', 'claude'], { self, start }))).toBe('konnect agent add <name>: unknown claude. To start a harness with it: konnect agent run helper claude');
  expect(await fails(ann.run(['agent', 'add'], { self, start }))).toBe('konnect agent add <name>...: name the agent, such as konnect agent add reviewer');

  // Ann's agents: reviewer (made on the service, not set up here) and helper; connected is the
  // service's word (it calls an agent connected while a login of its is open).
  const lines = (await ann.run(['agent', 'list'])).split('\n').sort();
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^helper {5}(connected {3}| {12})set up here$/);
  expect(lines[1]).toBe('reviewer');
  expect(JSON.parse(await ann.run(['agent', 'list', '--json']))).toContainEqual({ name: 'helper', connected: expect.any(Boolean), set_up_here: true, running_here: false, running_on: [] });
  await kolab.openSession('ann-reviewer', 'product', { kolab: 'hub' });
  expect(JSON.parse(await ann.run(['agent', 'list', '--json']))).toContainEqual({ name: 'reviewer', connected: true, set_up_here: false, running_here: false, running_on: [] });
  expect((await ann.run(['agent', 'list'])).split('\n')).toContain('reviewer   connected');
  // Someone with none.
  const bo = machine(server.url, 'bo');
  await signIn(bo, boId, 'hub');
  expect(await bo.run(['agent', 'list'])).toBe('You have no agents in team hub. Add one with: konnect agent run <name> claude');

  // agent remove: someone else's agent is refused (4); your own is removed, and its login here dropped.
  expect(await exitOf(bo.run(['agent', 'remove', 'helper']))).toBe(4);
  expect(await fails(ann.run(['agent', 'remove', 'helper', 'x']))).toBe('konnect agent remove <name>: unknown x');
  // Named as someone else's, it is refused (4), never taken for your own of that name.
  expect(await fails(ann.run(['agent', 'remove', '@bo/helper']))).toBe('@bo/helper is bo\'s agent, not yours: only its owner can add, run or remove it');
  expect(await exitOf(ann.run(['agent', 'remove', 'bo/helper']))).toBe(4);
  expect(existsSync(join(ann.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'helper.json'))).toBe(true);
  expect(await ann.run(['agent', 'remove', '@ann/helper'])).toMatch(/^Removed your agent helper from team hub: \d+ sessions? ended\.$/);
  expect(existsSync(join(ann.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'helper.json'))).toBe(false);
  expect(await ann.run(['agent', 'list'])).not.toMatch(/^helper\b/m);
  expect(await exitOf(ann.run(['agent', 'remove', 'helper']))).toBe(4);
});

test('--agent <name> (or KONNECT_AGENT): status, send, receive, history, channel list and team list act as that agent, with its own login', async () => {
  const { server, idp, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  await ann.run(['agent', 'add', 'helper'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, self: () => ({ command: 'node', args: ['k.mjs'] }) });

  expect(await ann.run(['--agent', 'helper', 'status'])).toBe('hub, as @ann/helper\n\n  Nothing unread.');
  expect(await ann.run(['--agent', 'helper', 'send', '#general', 'hello from the agent'])).toBe('Sent to #general.');
  expect(await bo.run(['receive', '#general'])).toMatch(/ {2}@ann\/helper\n {2}hello from the agent$/);
  await bo.run(['send', '@ann/helper', 'for the agent']);
  await bo.run(['send', '@ann', 'for ann']);
  // KONNECT_AGENT as well as --agent; the agent receives its own, never Ann's.
  const asAgent = { env: { ...ann.env, KONNECT_AGENT: 'helper' } };
  expect(await ann.run(['status'], asAgent)).toBe('hub, as @ann/helper\n\n  direct messages   1 unread');
  expect(await ann.run(['receive'], asAgent)).toMatch(/^\S+ \S+ {2}@bo\n {2}for the agent$/);
  expect(await ann.run(['receive'])).toMatch(/^\S+ \S+ {2}@bo\n {2}for ann\n\n#general\n\S+ \S+ {2}@ann\/helper\n {2}hello from the agent$/);
  expect(await ann.run(['--agent', 'helper', 'history', '#general'])).toMatch(/^#general\n[\s\S]*@ann\/helper\n {2}hello from the agent$/);
  expect(await ann.run(['--agent', 'helper', 'channel', 'list'])).toMatch(/^#general/);
  // team list as the agent: it is you, and who is invited isn't shown.
  expect(await ann.run(['--agent', 'helper', 'team', 'list'])).toContain('@ann/helper (you)');
  expect(JSON.parse(await ann.run(['--agent', 'helper', 'team', 'list', '--json'])).invited).toBeUndefined();
  // ann/helper, owner and all, is the same agent; another person's name for it isn't.
  expect(await ann.run(['--agent', 'ann/helper', 'status'])).toMatch(/^hub, as @ann\/helper\n/);
  expect(await exitOf(ann.run(['--agent', 'bo/helper', 'status']))).toBe(3);
  // An agent with no login here: said, for its owner (3).
  expect(await fails(ann.run(['--agent', 'nothere', 'status']))).toBe('agent nothere has no login to team hub on this machine: its owner should run konnect agent add nothere again to renew it');
  // Anything else is refused as the agent (4).
  expect(await exitOf(ann.run(['--agent', 'helper', 'channel', 'create', 'x']))).toBe(4);
});

test('konnect agent run --background keeps the harness in tmux, or in screen where tmux is missing; agent attach looks in, agent stop ends it, agent list says it is running here', async () => {
  const { server, idp, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  const self = () => ({ command: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs'] });
  const allow = (u: URL) => { idp.next(annId); void browse(u, pressing('decision=allow')); };
  // A stand-in for the machine's tmux and screen: which are installed, and which sessions are running.
  const has = { tmux: false, screen: true };
  const sessions = new Set<string>();
  const ran: string[][] = [];
  const exec = async (cmd: string, args: string[]) => {
    ran.push([cmd, ...args]);
    if (!has[cmd as 'tmux' | 'screen']) return { code: -1, out: 'not installed' };
    if (cmd === 'tmux' && args[0] === '-V') return { code: 0, out: 'tmux 3.4' };
    if (cmd === 'tmux' && args[0] === 'has-session') return { code: sessions.has(args[2].slice(1)) ? 0 : 1, out: '' };
    if (cmd === 'tmux' && args[0] === 'new-session') { sessions.add(args[3]); return { code: 0, out: '' }; }
    if (cmd === 'tmux' && args[0] === 'kill-session') { sessions.delete(args[2].slice(1)); return { code: 0, out: '' }; }
    if (cmd === 'screen' && args[0] === '-v') return { code: 1, out: 'Screen version 4.00.03' };
    if (cmd === 'screen' && args[0] === '-ls') return { code: 0, out: [...sessions].map((s) => `\t1234.${s}\t(Detached)`).join('\n') };
    if (cmd === 'screen' && args[0] === '-dmS') { sessions.add(args[1]); return { code: 0, out: '' }; }
    // screen is told which session by its own name for it, <pid>.<name>: a name alone would reach any session that begins with it.
    if (cmd === 'screen' && args[0] === '-S') { if (!/^1234\./.test(args[1])) return { code: 1, out: 'several suitable screens' }; sessions.delete(args[1].slice(5)); return { code: 0, out: '' }; }
    return { code: 1, out: 'unexpected' };
  };
  const start = async () => { throw new Error('started in this terminal'); };

  // With screen alone: the harness is started detached, with the agent's environment and Claude Code's command line.
  const out = await ann.run(['agent', 'run', '--background', '--act-for', 'me', 'helper', 'claude', '--model', 'opus'], { open: allow, self, exec, start });
  expect(out).toMatch(/^Your agent @ann\/helper is added to team hub, and claude is running as it in the background \(screen session konnect-hub-helper\)\.\n {2}konnect agent attach helper {5}look in on it; Ctrl-a d leaves it running\n {2}konnect agent stop helper {7}end it\nThe first time in a folder, Claude Code asks whether to trust it: attach once and answer\.$/);
  // screen is given konnect's own plumbing, where konnect keeps its files, and a file's name, never the words
  // themselves or the folder: what is to run, and where, waits in the file, the person's alone.
  const launch = ran.find((c) => c[0] === 'screen' && c[1] === '-dmS')!;
  const kept = launch.at(-1)!;
  expect(launch.slice(0, -1)).toStrictEqual(['screen', '-dmS', 'konnect-hub-helper', 'env', `KONNECT_CONFIG_DIR=${ann.env.KONNECT_CONFIG_DIR}`, '/usr/bin/node', '/opt/konnect/konnect.mjs', '_start']);
  expect(kept).toMatch(new RegExp(`^${ann.env.KONNECT_CONFIG_DIR}/agents/hub/helper\\.[0-9a-f]{12}\\.start\\.json$`));
  expect(statSync(kept).mode & 0o777).toBe(0o600);
  const { cwd: where, ...waiting } = JSON.parse(readFileSync(kept, 'utf8')) as { cmd: string; args: string[]; env: Record<string, string>; cwd: string };
  expect(where).toBe(ann.cwd);
  expect(waiting.cmd).toBe('claude');
  expect(waiting.args[0]).toBe('--mcp-config');
  expect(waiting.args.slice(-2)).toStrictEqual(['--model', 'opus']);
  expect(waiting.env).toMatchObject({ KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper', KONNECT_ACT_FOR: 'me', KONNECT_URL: server.url, KONNECT_CONFIG_DIR: ann.env.KONNECT_CONFIG_DIR });
  expect(JSON.stringify(waiting)).not.toMatch(/kj[rsa]_/);
  // konnect _start, in the session, runs what waits there once, and the file is gone.
  const inSession: { cmd: string; args: string[]; env: Record<string, string>; dir: string }[] = [];
  await ann.run(['_start', kept], { cwd: '/', start: async (c, dir) => { inSession.push({ ...c, dir }); return 0; } });
  expect(inSession).toStrictEqual([{ ...waiting, dir: ann.cwd }]);
  expect(existsSync(kept)).toBe(false);
  // It runs nothing but a file konnect wrote, in its own folder.
  writeFileSync(join(ann.cwd, 'x.start.json'), JSON.stringify({ ...waiting, cwd: ann.cwd }));
  expect(await fails(ann.run(['_start', join(ann.cwd, 'x.start.json')], { start }))).toMatch(/^konnect _start is plumbing/);
  expect(await fails(ann.run(['_start', kept], { start }))).toMatch(/^konnect _start is plumbing/);
  expect(sessions).toStrictEqual(new Set(['konnect-hub-helper']));

  // It is said where your agents are listed; a second one for the same agent is refused (4).
  expect(await ann.run(['agent', 'list'], { exec })).toMatch(/^helper\s+(connected\s+)?set up here\s+running here, in the background$/m);
  expect(await fails(ann.run(['agent', 'run', '--background', 'helper', 'claude'], { self, exec, start }))).toBe('your agent helper is running in the background here already: look in with konnect agent attach helper, or stop it with konnect agent stop helper');

  // attach hands this terminal to the session; stop ends it, and the agent stays in the team.
  const attached: { cmd: string; args: string[] }[] = [];
  await ann.run(['agent', 'attach', 'helper'], { exec, start: async (c) => { attached.push(c); return 0; } });
  expect(attached).toMatchObject([{ cmd: 'screen', args: ['-r', '1234.konnect-hub-helper'] }]);
  expect(await ann.run(['agent', 'stop', 'helper'], { exec })).toBe('Stopped your agent helper\'s harness here. It stays in team hub.');
  expect(sessions.size).toBe(0);
  expect(await fails(ann.run(['agent', 'stop', 'helper'], { exec }))).toBe('your agent helper isn\'t running in the background on this machine: konnect agent run --background helper <harness> starts it');
  expect(await exitOf(ann.run(['agent', 'attach', 'helper'], { exec }))).toBe(4);
  expect(await ann.run(['agent', 'list'], { exec })).toMatch(/^helper\s+(connected\s+)?set up here$/m);

  // With tmux installed it is tmux, started in this folder.
  has.tmux = true;
  expect(await ann.run(['agent', 'run', '--background', 'helper', 'codex'], { self, exec, start })).toMatch(/codex is running as it in the background \(tmux session konnect-hub-helper\)\.\n {2}konnect agent attach helper {5}look in on it; Ctrl-b d leaves it running/);
  const tmux = ran.find((c) => c[0] === 'tmux' && c[1] === 'new-session')!;
  expect(tmux.slice(0, -1)).toStrictEqual(['tmux', 'new-session', '-d', '-s', 'konnect-hub-helper', 'env', `KONNECT_CONFIG_DIR=${ann.env.KONNECT_CONFIG_DIR}`, '/usr/bin/node', '/opt/konnect/konnect.mjs', '_start']);
  // The folder is never tmux's to read (it would run a #(...) in its name): it waits in the file with the rest.
  expect(tmux).not.toContain('-c');
  expect(JSON.parse(readFileSync(tmux.at(-1)!, 'utf8')).cwd).toBe(ann.cwd);
  // A system prompt that ends in ';', which tmux would read as the end of its command, never reaches tmux's command line.
  await ann.run(['agent', 'stop', 'helper'], { exec });
  ran.length = 0;
  await ann.run(['agent', 'run', '--background', '--system-prompt', 'be brief;', 'helper', 'claude'], { self, exec, start });
  expect(ran.flat().some((w) => w.includes(';'))).toBe(false);
  expect(JSON.parse(readFileSync(ran.find((c) => c[1] === 'new-session')!.at(-1)!, 'utf8')).env.KONNECT_SYSTEM_PROMPT).toBe('be brief;');
  // A session that is gone a moment after it was started ran nothing (the harness isn't installed, say), and that is said.
  await ann.run(['agent', 'stop', 'helper'], { exec });
  const dying = async (cmd: string, args: string[]) => { const r = await exec(cmd, args); if (args[0] === 'new-session') sessions.clear(); return r; };
  expect(await fails(ann.run(['agent', 'run', '--background', 'helper', 'claude'], { self, exec: dying, start }))).toBe('claude ended as soon as it was started in the background as helper: run konnect agent run helper claude in a terminal here to see why.');
  await ann.run(['agent', 'run', '--background', 'helper', 'claude'], { self, exec, start });

  // Stopping ends what the session runs, not only the session: the window's own group is hung up on, as a closed
  // terminal would, then told to end, and only then is a session still there closed. (On macOS, screen leaves a harness running.)
  const signals: [number, string | number][] = [];
  let alive = true;
  const signal = (pid: number, sig: NodeJS.Signals | 0) => { signals.push([pid, sig]); if (sig === 'SIGTERM') alive = false; return alive || sig === 'SIGTERM'; };
  const panes = async (cmd: string, args: string[]) => { if (cmd === 'tmux' && args[0] === 'list-panes') { ran.push([cmd, ...args]); return { code: 0, out: '4242\n' }; } if (cmd === 'pgrep') { ran.push([cmd, ...args]); return { code: 0, out: '5151\n' }; } return exec(cmd, args); };
  expect(await ann.run(['agent', 'stop', 'helper'], { exec: panes, signal, pause: async () => undefined })).toBe('Stopped your agent helper\'s harness here. It stays in team hub.');
  expect([...ran].reverse().find((c) => c[1] === 'list-panes')).toStrictEqual(['tmux', 'list-panes', '-s', '-t', '=konnect-hub-helper', '-F', '#{pane_pid}']);
  expect(signals.filter(([, sig]) => sig !== 0).map(([pid, sig]) => `${pid} ${sig}`)).toStrictEqual(['-4242 SIGHUP', '-4242 SIGTERM']);
  expect(sessions.size).toBe(0);
  // Under screen, the window's process is found beneath screen's own, by the session's full name.
  has.tmux = false;
  await ann.run(['agent', 'run', '--background', 'helper', 'claude'], { self, exec, start });
  signals.length = 0; alive = true;
  await ann.run(['agent', 'stop', 'helper'], { exec: panes, signal, pause: async () => undefined });
  expect([...ran].reverse().find((c) => c[0] === 'pgrep')).toStrictEqual(['pgrep', '-P', '1234']);
  expect(signals.filter(([, sig]) => sig !== 0).map(([pid, sig]) => `${pid} ${sig}`)).toStrictEqual(['-5151 SIGHUP', '-5151 SIGTERM']);
  // A pid that could be every process, or none, is never signalled.
  expect(signals.every(([pid]) => pid < -1)).toBe(true);
  has.tmux = true;
  await ann.run(['agent', 'run', '--background', 'helper', 'claude'], { self, exec, start });

  // With neither, it says what to install, and starts nothing; --background belongs to agent run alone (2).
  has.tmux = false; has.screen = false;
  expect(await fails(ann.run(['agent', 'run', '--background', 'helper', 'claude'], { self, exec, start }))).toBe('konnect agent run --background keeps the harness in tmux or screen, and neither is installed here: install tmux, or run it without --background');
  expect(await fails(ann.run(['agent', 'add', '--background', 'helper'], { self, exec }))).toBe('konnect agent add takes no --background: konnect agent run and konnect host run do');
});

test('several agents at once: konnect agent add <name>... and konnect agent run --background --count <n> allow them all on one page of the browser', async () => {
  const { server, idp, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  const self = () => ({ command: 'node', args: ['k.mjs'] });
  let pages = 0;
  let page = '';
  const allow = (u: URL) => { pages++; idp.next(annId); void browse(u, (b, h) => { page = h; return pressing('decision=allow')(b); }); };

  // agent add with two names: one page names both, and each gets its own login and its own entry.
  const added = JSON.parse(await ann.run(['agent', 'add', '--json', 'one', 'two'], { open: allow, self }));
  expect(pages).toBe(1);
  expect(page).toContain('one');
  expect(page).toContain('two');
  expect(added.agents).toStrictEqual([{ agent: 'ann/one', added: true }, { agent: 'ann/two', added: true }]);
  expect(Object.keys(added.entry.mcpServers)).toStrictEqual(['konnect-one', 'konnect-two']);
  for (const n of ['one', 'two']) expect(JSON.parse(readFileSync(join(ann.env.KONNECT_CONFIG_DIR, 'agents', 'hub', `${n}.json`), 'utf8'))[server.url].tokens.refresh_token).toMatch(/^kjr_/);
  expect(await fails(ann.run(['agent', 'add', 'one', 'one'], { open: allow, self }))).toBe('konnect agent add one one: an agent is named twice');

  // --count: <name>-1 to <name>-<n>, each in the background, allowed together; it needs --background (2).
  const sessions = new Set<string>();
  const exec = async (cmd: string, args: string[]) => {
    if (cmd !== 'tmux') return { code: -1, out: '' };
    if (args[0] === 'has-session') return { code: sessions.has(args[2].slice(1)) ? 0 : 1, out: '' };
    if (args[0] === 'new-session') sessions.add(args[3]);
    return { code: 0, out: '' };
  };
  expect(await fails(ann.run(['agent', 'run', '--count', '3', 'worker', 'claude'], { open: allow, self, exec }))).toBe('konnect agent run --count starts several harnesses, which one terminal can\'t hold: add --background');
  const out = await ann.run(['agent', 'run', '--background', '--count', '3', 'worker', 'claude'], { open: allow, self, exec });
  expect(pages).toBe(2);
  expect(out).toMatch(/^Your agents @ann\/worker-1, @ann\/worker-2, @ann\/worker-3 are in team hub, and claude is running as each in the background \(tmux sessions konnect-hub-worker-1 to konnect-hub-worker-3\)\./);
  expect(sessions).toStrictEqual(new Set(['konnect-hub-worker-1', 'konnect-hub-worker-2', 'konnect-hub-worker-3']));
  expect(await ann.run(['agent', 'list'], { exec })).toMatch(/^worker-2\s+(connected\s+)?set up here\s+running here, in the background$/m);
  expect(await fails(ann.run(['agent', 'run', '--background', '--count', '11', 'worker', 'claude'], { self, exec }))).toBe('--count is a whole number from 1 to 10');

  // One that can't be started: those started before it keep running, and that is said.
  const failing = async (cmd: string, args: string[]) => (cmd === 'tmux' && args[0] === 'new-session' && args[3].endsWith('-2') ? { code: 1, out: 'no space left' } : exec(cmd, args));
  expect(await fails(ann.run(['agent', 'run', '--background', '--count', '3', 'crew', 'claude'], { open: allow, self, exec: failing })))
    .toBe('tmux couldn\'t start claude in the background as crew-2: no space left. crew-1 is running in the background: konnect agent stop <name> ends one.');
  expect(sessions.has('konnect-hub-crew-1')).toBe(true);
  expect(sessions.has('konnect-hub-crew-3')).toBe(false);
});
