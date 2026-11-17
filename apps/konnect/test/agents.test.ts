// konnect's teams and agents end to end, against a Kolab started here (test/team.ts): the owner
// recruits a teammate by GitHub username, who runs bare konnect, picks the invitation on Kolab's
// page and lands in the team; recruit --list and --withdraw; remove and leave; bare konnect with a
// team; and `konnect claude|codex|opencode <label>`: the agent made and signed in through Kolab's
// setup page, its entry with no token, and the tool started (or what to install).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@jest/globals';
import { agentSetupScope, toolCommand } from '../src/konnect.js';
import { browse, fails, machine, pressing, teams } from './team.js';

const cy = { subject: '43', login: 'cy' };

test('the owner recruits by GitHub username; the teammate runs konnect with no team, accepts on Kolab\'s page and lands in it; list, withdraw, remove, leave', async () => {
  const { server, idp, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  const cyM = machine(server.url, 'cy');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');

  // Cy, in no team and invited nowhere: bare konnect says there is nothing to join, and what to do.
  idp.next(cy);
  expect(await fails(cyM.run([], { open: (u) => { void browse(u, (b) => pressing('decision=')(b)); } }))).toMatch(/^there is nothing to join yet: .*konnect recruit <your GitHub username>/);

  // Only the owner recruits.
  expect(await fails(bo.run(['recruit', 'cy']))).toBe('only team hub\'s owner can do that: ask them');
  expect(await ann.run(['recruit', 'cy', 'bo'])).toBe('Invited: cy.\nAlready in the team: bo.\nThey join by running, with the GitHub account you named:\n  npx @konjir/konnect');
  expect(await ann.run(['recruit', 'cy'])).toMatch(/^Already invited: cy\./);
  expect(await ann.run(['recruit', '--list'])).toMatch(/^cy {2}invited by ann on \d{4}-\d\d-\d\d$/);

  // Cy runs konnect with no team: Kolab's page lists the invitation, and Cy accepts it.
  let page = '';
  idp.next(cy);
  const joined = await cyM.run([], { open: (u) => { void browse(u, (b, h) => { page = h; return pressing('pick=accept:')(b); }); } });
  expect(page).toContain('hub');
  expect(joined).toMatch(/^You're in team hub, as cy\. This folder remembers it \(\.konnect\.json\)\.\n\nann {2,}person/);
  expect(joined).toContain('konnect claude <label>');
  expect(JSON.parse(readFileSync(join(cyM.cwd, '.konnect.json'), 'utf8')).team).toBe('hub');
  expect(existsSync(join(cyM.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json'))).toBe(true);
  // Nothing of the choosing sign-in is left behind under its own name.
  expect(readFileSync(join(cyM.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json'), 'utf8')).toContain('refresh_token');
  // A Read member talks: in #general, and with a direct message.
  expect(await cyM.run(['send', '#general', 'hi all'])).toBe('Sent to #general.');
  expect(await ann.run(['read', '#general'])).toMatch(/@cy\n {2}hi all$/);
  expect(await ann.run(['recruit', '--list'])).toBe('No invitations to team hub are waiting.');

  // Bare konnect with a team: no live chat yet, what is unread, and what to run.
  await ann.run(['send', '@cy', 'welcome']);
  expect(await cyM.run([])).toMatch(/^Live chat isn't available yet\.\nTeam hub: 1 direct message\.\n\n {2}konnect read/);

  // Withdraw: an invitation taken back.
  idp.account({ subject: '44', login: 'dee' });
  await ann.run(['recruit', 'dee']);
  expect(await ann.run(['recruit', '--withdraw', '@dee'])).toBe('Withdrew dee\'s invitation to team hub.');
  expect(await fails(ann.run(['recruit', '--withdraw', 'dee']))).toMatch(/^no invitation to team hub waits for dee/);

  // Remove: the owner removes Bo; leave: Cy leaves, and konnect forgets the sign-in.
  expect(await fails(bo.run(['remove', '@cy']))).toBe('only team hub\'s owner can do that: ask them');
  expect(await ann.run(['remove', '@bo'])).toMatch(/^Removed @bo from team hub: \d+ sessions? ended\.$/);
  expect(await fails(bo.run(['who']))).toMatch(/sign-in to team hub has ended or was revoked|isn't yours in team hub/);
  expect(await cyM.run(['leave'])).toBe('You left team hub. konnect forgot its sign-in here.');
  expect(await fails(cyM.run(['who']))).toBe('you aren\'t signed in to team hub: run konnect team hub');
  expect(await fails(ann.run(['leave']))).toBe('you own team hub, so you can\'t leave it');
});

test('konnect claude <label>: the agent made and signed in on Kolab\'s setup page, its .mcp.json entry with no token, and Claude Code started with its channel; codex and opencode', async () => {
  const { server, idp, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  const self = () => ({ command: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs'] });
  let page = '';
  const allow = (u: URL) => { idp.next(annId); void browse(u, (b, h) => { page = h; return pressing('decision=allow')(b); }); };
  const started: { cmd: string; args: string[]; env: Record<string, string> }[] = [];

  const out = await ann.run(['claude', 'helper', '--listen', '#general,#deploys', '--', '--model', 'opus'], { open: allow, self, start: async (c) => { started.push(c); return 0; } });
  expect(page).toContain('helper');
  expect(out).toBe(`Your agent ann/helper is made and signed in to team hub; ${join(ann.cwd, '.mcp.json')} has its entry, konnect-helper.`);
  const mcp = JSON.parse(readFileSync(join(ann.cwd, '.mcp.json'), 'utf8'));
  expect(mcp.mcpServers['konnect-helper']).toStrictEqual({
    type: 'stdio', command: '/usr/bin/node', args: ['/opt/konnect/konnect.mjs', 'mcp'],
    env: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'helper', KONNECT_LISTEN: 'general,deploys', KONNECT_URL: server.url },
  });
  expect(JSON.stringify(mcp)).not.toMatch(/kj[rsa]_/);
  expect(started).toStrictEqual([{ cmd: 'claude', args: ['--dangerously-load-development-channels', 'server:konnect-helper', '--model', 'opus'], env: {} }]);
  // The agent's sign-in is where konnect mcp reads it, the agent's own.
  const file = join(ann.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'helper.json');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, 'utf8'))[server.url].tokens.refresh_token).toMatch(/^kjr_/);
  expect(agentSetupScope('hub', 'helper')).toBe('konjir kolab:hub setup:helper:engineer');

  // Claude Code not installed: what to install, and the command to run later.
  expect(await fails(ann.run(['claude', 'helper'], { open: allow, self, start: async () => -1 })))
    .toBe('claude isn\'t installed here (no claude on PATH). Install Claude Code: npm install -g @anthropic-ai/claude-code, then run: claude --dangerously-load-development-channels server:konnect-helper');
  // Set up only.
  expect(await ann.run(['claude', 'helper', '--no-start'], { open: allow, self, start: async () => { throw new Error('started'); } }))
    .toMatch(/is signed in to team hub; .* has its entry, konnect-helper\.\nStart it with: claude --dangerously-load-development-channels server:konnect-helper$/);

  // Codex and OpenCode: the entry on the command line or in the environment, no file; not woken, said so.
  const codex = JSON.parse(await ann.run(['codex', 'coder', '--no-start', '--json'], { open: allow, self }));
  expect(codex.file).toBeNull();
  expect(codex.command).toStrictEqual(['codex', '-c', 'mcp_servers.konnect-coder.command="/usr/bin/node"', '-c', 'mcp_servers.konnect-coder.args=["/opt/konnect/konnect.mjs", "mcp"]', '-c', `mcp_servers.konnect-coder.env={ KONNECT_TEAM = "hub", KONNECT_AGENT = "coder", KONNECT_URL = ${JSON.stringify(server.url)} }`]);
  expect(await ann.run(['opencode', 'coder', '--no-start'], { open: allow, self })).toContain('OpenCode isn\'t woken by messages in this release');
  const oc = toolCommand('opencode', 'konnect-coder', { command: 'node', args: ['k.mjs', 'mcp'], env: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'coder' } }, []);
  expect(JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT).mcp['konnect-coder']).toStrictEqual({ type: 'local', command: ['node', 'k.mjs', 'mcp'], environment: { KONNECT_TEAM: 'hub', KONNECT_AGENT: 'coder' }, enabled: true });
  expect(await fails(ann.run(['codex', 'coder', '--listen', '#general'], { open: allow, self }))).toMatch(/only Claude Code is woken/);
  expect(await fails(ann.run(['claude', 'Bad Label'], { self }))).toMatch(/isn't an agent's label/);
});
