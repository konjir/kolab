// konnect doctor and shell completion, against a Kolab started here: what doctor says of a machine
// where everything works and of one where things need doing, and what completion offers at each
// place on the command line, from what konnect itself knows and from the team's channels and members.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@jest/globals';
import { browse, exitOf, fails, machine, pressing, teams } from './team.js';

test('konnect doctor says what works and what needs doing on this machine, changes nothing, and exits 1 when something does', async () => {
  const { server, idp, signIn, create, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  const installed: Record<string, string> = { claude: '2.1.327 (Claude Code)', tmux: 'tmux 3.4' };
  const exec = async (cmd: string) => (installed[cmd] !== undefined ? { code: 0, out: installed[cmd] } : { code: -1, out: '' });
  const latest = async () => '9.9.9';

  // Not logged in anywhere: that is the thing to do (1).
  const nobody = await ann.run(['doctor'], { exec, latest });
  expect(nobody).toMatch(/^-- {2}konnect is running from source\nok {2}Node\.js \d+\.\d+\.\d+\n-- {2}KONNECT_URL points konnect at \S+\n!! {2}you aren't logged in to a team at http:\/\/127\.0\.0\.1:\d+\/mcp\n {6}konnect login, or konnect team create <name>\n/);
  expect(nobody).toMatch(/\n1 thing needs doing\.$/);
  expect(await exitOf(ann.run(['doctor', 'x'], { exec, latest }))).toBe(2);

  // Logged in, with an agent set up here, a Claude Code that is woken, and tmux: nothing needs doing.
  await signIn(ann, annId, 'hub');
  await ann.run(['agent', 'add', 'helper'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, self: () => ({ command: 'node', args: ['k.mjs'] }) });
  const fine = await ann.run(['doctor'], { exec, latest });
  expect(fine.split('\n')).toStrictEqual([
    '--  konnect is running from source',
    expect.stringMatching(/^ok {2}Node\.js /),
    expect.stringMatching(/^-- {2}KONNECT_URL points konnect at http:\/\/127\.0\.0\.1:\d+\/mcp$/),
    'ok  logged in to team hub as @ann',
    'ok  agent helper is set up here for team hub',
    'ok  Claude Code 2.1.327: messages wake an idle session',
    'ok  tmux is installed: konnect agent run --background works',
    '',
    'Nothing needs doing.',
  ]);
  expect(JSON.parse(await ann.run(['doctor', '--json'], { exec, latest }))).toMatchObject({ ok: true, checks: expect.arrayContaining([{ ok: true, what: 'logged in to team hub as @ann' }]) });

  // An old Claude Code, a second team with nothing saying which to use, an agent whose login is gone,
  // and what an earlier konnect left in the folder: each said, with what to do.
  installed.claude = '2.1.100 (Claude Code)';
  delete installed.tmux;
  await create(ann, annId, 'anns-other');
  writeFileSync(join(ann.env.KONNECT_CONFIG_DIR, 'agents', 'hub', 'helper.json'), '{}');
  writeFileSync(join(ann.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'konnect-helper': { command: 'node', args: ['k.mjs', 'mcp'], env: { KONNECT_AGENT: 'helper' } } } }));
  writeFileSync(join(ann.cwd, '.konnect.json'), '{"team":"hub"}');
  const wrong = await ann.run(['doctor'], { exec, latest });
  expect(wrong).toContain('!!  you\'re logged in to 2 teams, and nothing says which a command works in\n      pass --team <name>, or set KONNECT_TEAM (one of: anns-other, hub)');
  expect(wrong).toMatch(/!! {2}agent helper \(team hub\): agent helper has no login to team hub on this machine: .*\n {6}konnect --team hub agent add helper/);
  expect(wrong).toContain('!!  Claude Code 2.1.100 is too old to be woken by messages\n      update Claude Code to 2.1.318 or later');
  expect(wrong).toContain('--  neither tmux nor screen is installed: konnect agent run --background needs one');
  expect(wrong).toContain('--  this folder\'s .mcp.json holds konnect-helper, written by an earlier konnect: konnect agent run <name> claude takes it out');
  expect(wrong).toContain('--  this folder holds a .konnect.json, which konnect no longer reads: it can be deleted');
  expect(wrong).toMatch(/\n3 things need doing\.$/);
  // It changed nothing.
  expect(existsSync(join(ann.cwd, '.mcp.json'))).toBe(true);
  expect(await ann.run(['doctor', '--team', 'hub'], { exec, latest })).toContain('ok  commands work in team hub (--team)');
});

test('shell completion: konnect completion prints what to load, and konnect _complete offers what could come next, the team\'s channels and members among it', async () => {
  const { server, idp, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  await ann.run(['channel', 'create', 'deploys']);
  await ann.run(['agent', 'add', 'helper'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, self: () => ({ command: 'node', args: ['k.mjs'] }) });
  const next = async (...words: string[]) => (await ann.run(['_complete', '--', ...words])).split('\n').filter(Boolean);

  for (const shell of ['bash', 'zsh', 'fish']) expect(await ann.run(['completion', shell])).toContain('konnect _complete -- ');
  expect(await fails(ann.run(['completion', 'tcsh']))).toMatch(/^konnect completion <shell>: bash, zsh or fish\./);

  // Commands, verbs and options: what konnect itself knows.
  expect(await next('')).toStrictEqual(['status', 'send', 'receive', 'history', 'watch', 'login', 'logout', 'channel', 'team', 'agent', 'lease', 'host', 'doctor', 'completion']);
  expect(await next('re')).toStrictEqual(['receive']);
  expect(await next('agent', '')).toStrictEqual(['list', 'add', 'run', 'attach', 'stop', 'remove']);
  expect(await next('lease', 'r')).toStrictEqual(['release', 'run']);
  expect(await next('receive', '-')).toStrictEqual(['-n', '--wait', '--team', '--agent', '--json', '--help']);
  expect(await next('agent', 'run', '--act-for', '')).toStrictEqual(['nobody', 'me', 'team']);
  expect(await next('agent', 'run', '--act-for', 'me', 'helper', '')).toStrictEqual(['claude', 'codex', 'opencode']);
  expect(await next('completion', '')).toStrictEqual(['bash', 'zsh', 'fish']);
  // What this machine keeps logins for: teams, and your agents.
  expect(await next('--team', '')).toStrictEqual(['hub']);
  expect(await next('login', '')).toStrictEqual(['hub']);
  expect(await next('agent', 'stop', '')).toStrictEqual(['helper']);
  expect(await next('--agent', 'h')).toStrictEqual(['helper']);
  // The team's channels and members, where a place is named: asked for once, then kept beside the logins.
  expect(await next('send', '')).toStrictEqual(['#deploys', '#general', '@ann', '@bo', '@ann/helper', '@ann/reviewer']);
  expect(await next('history', '#d')).toStrictEqual(['#deploys']);
  expect(await next('send', '@ann/')).toStrictEqual(['@ann/helper', '@ann/reviewer']);
  expect(await next('channel', 'unfollow', '')).toStrictEqual(['deploys', 'general']);
  expect(await next('team', 'remove', '')).toStrictEqual(['ann', 'bo']);
  expect(await next('agent', 'run', '--wake-on', 'de')).toStrictEqual(['deploys']);
  const kept = JSON.parse(readFileSync(join(ann.env.KONNECT_CONFIG_DIR, 'completion', 'hub.json'), 'utf8'));
  expect(kept.channels).toStrictEqual(['deploys', 'general']);
  await bo.run(['channel', 'create', 'later']);
  expect(await next('channel', 'follow', '')).toStrictEqual(['deploys', 'general']);
  // After a message's recipient nothing is offered: the words are the message.
  expect(await next('send', '@bo', '')).toStrictEqual([]);
  // bash is given a channel quoted, since # starts a comment there.
  expect((await ann.run(['_complete', '--', 'send', '\'#'], { env: { ...ann.env, KONNECT_COMPLETE: 'bash' } })).split('\n')).toStrictEqual(['\'#deploys\'', '\'#general\'']);
});
