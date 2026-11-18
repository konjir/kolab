// konnect's teams and agents end to end, against a Kolab started here (test/team.ts): the owner
// invites a teammate by GitHub username, who runs konnect login with no team, picks the invitation
// on Kolab's page and lands in the team; team list shows the owner who is invited; team remove
// withdraws an invitation or removes a member; team leave names the team and drops the agents'
// logins with it. Then `konnect agent run|add|list|remove`: the agent made and logged in through
// Kolab's setup page, its entry with no token, the harness started (or what to install), and
// `--agent` acting as it.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@jest/globals';
import { agentSetupScope, toolCommand } from '../src/konnect.js';
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
  expect(ann.err.join('\n')).toContain(`Your agent @ann/helper is added to team hub; ${join(ann.cwd, '.mcp.json')} has its entry, konnect-helper.`);
  const mcp = JSON.parse(readFileSync(join(ann.cwd, '.mcp.json'), 'utf8'));
  expect(mcp.mcpServers['konnect-helper']).toStrictEqual({
    type: 'stdio', command: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs', 'mcp'],
    env: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper', KONNECT_ACT_FOR: 'me', KONNECT_WAKE_ON: 'general,deploys', KONNECT_SYSTEM_PROMPT: 'Be brief.', KONNECT_URL: server.url },
  });
  expect(JSON.stringify(mcp)).not.toMatch(/kj[rsa]_/);
  // Claude Code with the server as its channel, the harness's own arguments untouched, and konnect
  // commands run inside it acting as the agent.
  expect(started).toStrictEqual([{ cmd: 'claude', args: ['--dangerously-load-development-channels', 'server:konnect-helper', '--model', 'opus'], env: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper', KONNECT_URL: server.url } }]);
  // The agent's login is where konnect mcp reads it, the agent's own.
  const file = join(ann.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'helper.json');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, 'utf8'))[server.url].tokens.refresh_token).toMatch(/^kjr_/);
  expect(agentSetupScope('hub', 'helper')).toBe('konjir kolab:hub setup:helper:engineer');

  // Run again: the login kept still works, so no browser; --act-for nobody is the default, left out of the entry.
  expect(pages).toBe(1);
  await ann.run(['agent', 'run', '--act-for', 'nobody', 'helper', 'claude'], { open: () => { throw new Error('no browser'); }, self, start });
  expect(ann.err.join('\n')).toContain('Your agent @ann/helper is in team hub;');
  expect(JSON.parse(readFileSync(join(ann.cwd, '.mcp.json'), 'utf8')).mcpServers['konnect-helper'].env).toStrictEqual({ KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper', KONNECT_URL: server.url });

  // Claude Code not installed: what to install, and the command to run it with.
  expect(await fails(ann.run(['agent', 'run', 'helper', 'claude'], { self, start: async () => -1 })))
    .toBe('claude isn\'t installed here (no claude on PATH). Install Claude Code: npm install -g @anthropic-ai/claude-code, then run this again. To start it yourself: claude --dangerously-load-development-channels server:konnect-helper');

  // Only claude, codex or opencode; a harness missing, a bad name or a bad channel: nothing is done (2).
  const before = started.length;
  expect(await fails(ann.run(['agent', 'run', 'helper', 'aider'], { self, start }))).toBe('konnect agent run starts claude, codex or opencode, and aider is none of them. For another harness: konnect agent add helper, and put the entry it prints there. For a script: konnect --agent helper send ...');
  expect(await exitOf(ann.run(['agent', 'run', 'helper', 'aider'], { self, start }))).toBe(2);
  expect(await fails(ann.run(['agent', 'run', 'helper'], { self, start }))).toBe('konnect agent run helper <harness>: say what to run it in: claude, codex or opencode');
  expect(await fails(ann.run(['agent', 'run'], { self, start }))).toBe('konnect agent run <name> <harness> [<argument>...]: name the agent, then claude, codex or opencode');
  expect(await fails(ann.run(['agent', 'run', 'Bad Name', 'claude'], { self, start }))).toMatch(/^Bad Name isn't an agent's name: /);
  // An option after the name is the harness's: it is no harness.
  expect(await fails(ann.run(['agent', 'run', 'helper', '--wake-on', '#x', 'claude'], { self, start }))).toMatch(/^konnect agent run starts claude, codex or opencode, and --wake-on is none of them/);
  expect(await fails(ann.run(['agent', 'run', '--wake-on', 'Bad!', 'newer', 'claude'], { open: () => { throw new Error('no browser'); }, self, start }))).toBe('--wake-on names a channel (Bad! isn\'t one)');
  expect(existsSync(join(ann.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'newer.json'))).toBe(false);
  expect(started).toHaveLength(before);
});

test('konnect agent run in codex and opencode: the entry on the command line or in the environment, no file written, and not woken, said so', async () => {
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
  await ann.run(['agent', 'run', 'coder', 'opencode'], { self, start });
  expect(ann.err.join('\n')).toContain('OpenCode isn\'t woken by messages: the agent receives at the start of each turn.');
  expect(started[1]).toMatchObject({ cmd: 'opencode', args: [], env: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'coder', KONNECT_URL: server.url } });
  expect(JSON.parse(started[1].env.OPENCODE_CONFIG_CONTENT).mcp['konnect-coder']).toStrictEqual({ type: 'local', command: ['/usr/bin/node', '/opt/konnect/konnect.mjs', 'mcp'], environment: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'coder', KONNECT_URL: server.url }, enabled: true });
  expect(readdirSync(ann.cwd)).toStrictEqual([]);
  const oc = toolCommand('opencode', 'konnect-coder', { command: 'node', args: ['k.mjs', 'mcp'], env: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'coder' } }, []);
  expect(JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT).mcp['konnect-coder']).toStrictEqual({ type: 'local', command: ['node', 'k.mjs', 'mcp'], environment: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'coder' }, enabled: true });
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
  expect(await fails(ann.run(['agent', 'add'], { self, start }))).toBe('konnect agent add <name>: name the agent, such as konnect agent add reviewer');

  // Ann's agents: reviewer (made on the service, not set up here) and helper; connected is the
  // service's word (it calls an agent connected while a login of its is open).
  const lines = (await ann.run(['agent', 'list'])).split('\n').sort();
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^helper {5}(connected {3}| {12})set up here$/);
  expect(lines[1]).toBe('reviewer');
  expect(JSON.parse(await ann.run(['agent', 'list', '--json']))).toContainEqual({ name: 'helper', connected: expect.any(Boolean), set_up_here: true });
  await kolab.openSession('ann-reviewer', 'product', { kolab: 'hub' });
  expect(JSON.parse(await ann.run(['agent', 'list', '--json']))).toContainEqual({ name: 'reviewer', connected: true, set_up_here: false });
  expect((await ann.run(['agent', 'list'])).split('\n')).toContain('reviewer   connected');
  // Someone with none.
  const bo = machine(server.url, 'bo');
  await signIn(bo, boId, 'hub');
  expect(await bo.run(['agent', 'list'])).toBe('You have no agents in team hub. Add one with: konnect agent run <name> claude');

  // agent remove: someone else's agent is refused (4); your own is removed, and its login here dropped.
  expect(await exitOf(bo.run(['agent', 'remove', 'helper']))).toBe(4);
  expect(await fails(ann.run(['agent', 'remove', 'helper', 'x']))).toBe('konnect agent remove <name>: unknown x');
  expect(await ann.run(['agent', 'remove', 'helper'])).toMatch(/^Removed your agent helper from team hub: \d+ sessions? ended\.$/);
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
