// konnect end to end against a Kolab started here, with a stub in GitHub's place: two people log in
// to one team with `konnect login`, each with a config folder of their own, and exchange direct
// messages through `konnect send` and `konnect receive`; `konnect team list` names the members, an
// agent as @owner/name under its owner; `konnect status` says what waits and changes nothing;
// several teams are kept apart, one login each, and the team a command works in is --team, then
// KONNECT_TEAM, then the one logged in to; `konnect team create` makes a team; konnect keeps no
// file in the folder it runs in; and the names 0.1.0 used still work, saying the new name once.
// The "browser" follows Kolab's redirects with its cookies and submits the consent page.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from '@jest/globals';
import { browse, exitOf, fails, machine, pressing, teams } from './team.js';
import { normalUrl } from '../src/konnect.js';
import { teamsAt } from '../src/teams.js';
import { wellFormedUrl } from '../src/teams.js';
import { printable } from '../src/names.js';

test('two people in one team exchange direct messages through konnect send and konnect receive; konnect team list names the members, an agent as @owner/name under its owner', async () => {
  const { kolab, server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');

  expect(await signIn(ann, annId, 'hub')).toBe('Logged in to team hub as @ann.');
  expect(ann.err.join('\n')).toContain('Opening your browser to log in to team hub with GitHub. Check what the page says, then Allow.');
  expect(await signIn(bo, boId, 'hub')).toBe('Logged in to team hub as @bo.');

  // Each login is kept in the person's own konnect folder, one file per team, closed to others;
  // nothing is written in the folder konnect runs in.
  const file = join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams')).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(file, 'utf8'))[server.url].tokens.refresh_token).toMatch(/^kjr_/);
  expect(readdirSync(ann.cwd)).toStrictEqual([]);

  // Logging in to the same team again uses the login kept: no browser.
  expect(await ann.run(['login', 'hub'], { open: () => { throw new Error('no browser'); } })).toBe('Already logged in to team hub as @ann.');
  expect(JSON.parse(await ann.run(['login', 'hub', '--json'], { open: () => { throw new Error('no browser'); } }))).toStrictEqual({ team: 'hub', name: 'ann', logged_in: 'already' });

  // Bo writes to Ann; Ann receives it, oldest first, and it is no longer unread.
  expect(await bo.run(['send', '@ann', 'the', 'deploy', 'is', 'green'])).toBe('Sent to @ann.');
  expect(await bo.run(['send', '@ann', 'and the docs are up'])).toBe('Sent to @ann.');
  expect(await ann.run(['receive'])).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d {2}@bo\n {2}the deploy is green\n\n\d{4}-\d\d-\d\d \d\d:\d\d {2}@bo\n {2}and the docs are up$/);
  expect(await ann.run(['receive'])).toBe('No unread messages.');

  // Ann answers from stdin, several lines; Bo receives it as JSON.
  expect(await ann.run(['send', '@bo'], { stdin: async () => 'thanks!\nshipping now\n' })).toBe('Sent to @bo.');
  const got = JSON.parse(await bo.run(['receive', '--json']));
  expect(got).toMatchObject({ direct: [{ from: 'ann', to: 'bo', message: 'thanks!\nshipping now' }], channels: [], more: 0 });
  expect(got.direct[0].read_at).not.toBeNull();
  expect(JSON.parse(await bo.run(['receive', '--json']))).toStrictEqual({ direct: [], channels: [], more: 0 });

  // An agent is @owner/name, stored as owner-name. Sending to one says when it isn't connected.
  expect(await bo.run(['send', '@ann/reviewer', 'please review the importer'])).toBe('Sent to @ann/reviewer. It isn\'t connected, so the message waits for it.');
  const reviewer = await kolab.openSession('ann-reviewer', 'product', { kolab: 'hub' });
  expect(await bo.run(['send', '@ann/reviewer', 'and the exporter'])).toBe('Sent to @ann/reviewer.');
  expect((await kolab.readMessages(reviewer)).messages).toMatchObject([{ from: 'bo', to: 'ann-reviewer', message: 'please review the importer' }, { message: 'and the exporter' }]);
  // Its answer reads as from @ann/reviewer.
  await kolab.sendMessage(reviewer, 'bo', 'on it');
  expect(await bo.run(['receive'])).toMatch(/ {2}@ann\/reviewer\n {2}on it$/);

  // konnect team list: each person, their agents under them, you marked; connected is said of agents alone.
  expect((await bo.run(['team', 'list'])).split('\n')).toStrictEqual([
    '@ann           person',
    '@ann/reviewer  agent   connected',
    '@bo (you)      person',
  ]);
  const listed = JSON.parse(await bo.run(['team', 'list', '--json']));
  expect(listed.members).toContainEqual({ name: 'ann/reviewer', kind: 'agent', owner: 'ann', connected: true });
  expect(listed.members).toContainEqual(expect.objectContaining({ name: 'bo', kind: 'person', owner: null, you: true }));
  // Who is invited is the owner's to see: Bo's list has none, Ann's says none wait.
  expect(listed.invited).toBeUndefined();
  expect(JSON.parse(await ann.run(['team', 'list', '--json'])).invited).toStrictEqual([]);

  // konnect receive @name: only theirs, oldest first; the rest stay unread for konnect receive.
  await bo.run(['send', '@ann', 'one more thing']);
  await kolab.sendMessage(reviewer, 'ann', 'from the reviewer');
  expect(await ann.run(['receive', '@bo'])).toMatch(/^\S+ \S+ {2}@bo\n {2}one more thing$/);
  expect(await ann.run(['receive', '@bo'])).toBe('No unread messages from @bo.');
  expect(await ann.run(['receive'])).toMatch(/^\S+ \S+ {2}@ann\/reviewer\n {2}from the reviewer$/);

  // Someone who isn't in the team is refused (4); a name that isn't one, or no message, is a wrong command line (2).
  expect(await fails(bo.run(['send', '@sam', 'hi']))).toBe('@sam isn\'t in team hub: konnect team list shows who is');
  expect(await exitOf(bo.run(['send', '@sam', 'hi']))).toBe(4);
  expect(await fails(bo.run(['send', '@ann/Not A Label', 'hi']))).toBe('@ann/Not A Label isn\'t a member\'s name: an agent is @<owner>/<name>, such as @ann/reviewer. konnect team list shows your team');
  expect(await exitOf(bo.run(['send', '@ann/Not A Label', 'hi']))).toBe(2);
  expect(await fails(bo.run(['send', '@ann'], { stdin: async () => '\n' }))).toBe('konnect send: the message is empty');

  // konnect logout revokes the login and forgets it; then a command says what to do (3).
  expect(await bo.run(['logout'])).toBe('Logged out of team hub.');
  expect(await fails(bo.run(['team', 'list']))).toBe('you aren\'t logged in to a team: run konnect login, or konnect team create <name>');
  expect(await fails(bo.run(['--team', 'hub', 'team', 'list']))).toBe('you aren\'t logged in to team hub: run konnect login hub');
  expect(await exitOf(bo.run(['--team', 'hub', 'team', 'list']))).toBe(3);
  expect(await bo.run(['logout', 'hub'])).toBe('You weren\'t logged in to team hub.');
  expect((await kolab.db.query(`select 1 from session s join oauth_grant g on g.id = s.grant_id where s.actor_id = 'bo' and s.ended_at is null`)).rows).toStrictEqual([]);
});

test('konnect status: the team, who you are, then direct-message and channel unread counts, or Nothing unread; it changes nothing', async () => {
  const { server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  expect(await bo.run(['status'])).toBe('hub, as @bo\n\n  Nothing unread.');
  expect(JSON.parse(await bo.run(['status', '--json']))).toStrictEqual({ team: 'hub', name: 'bo', direct: 0, direct_more: false, channels: [] });

  await ann.run(['channel', 'create', 'deploys']);
  await ann.run(['send', '@bo', 'one']);
  await ann.run(['send', '@bo', 'two']);
  await ann.run(['send', '#general', 'standup in 5']);
  // A channel Bo doesn't follow counts only what mentions him.
  await ann.run(['send', '#deploys', 'not for bo']);
  await ann.run(['send', '#deploys', '@bo a question']);
  const before = await bo.run(['status']);
  expect(before).toBe([
    'hub, as @bo',
    '',
    '  direct messages   2 unread',
    '  #deploys          1 mentioning you',
    '  #general          1 unread',
  ].join('\n'));
  // Nothing was marked: the same again, and receive still gets them.
  expect(await bo.run(['status'])).toBe(before);
  const kept = JSON.parse(await bo.run(['status', '--json']));
  expect(kept).toMatchObject({ team: 'hub', name: 'bo', direct: 2, direct_more: false });
  expect(kept.channels).toContainEqual(expect.objectContaining({ channel: 'general', following: true, unread: 1 }));
  expect(await bo.run(['receive'])).toMatch(/ {2}one\n\n\S+ \S+ {2}@ann\n {2}two\n\n#general\n\S+ \S+ {2}@ann\n {2}standup in 5\n\(1 mentioning you in #deploys\)$/);
  expect(await bo.run(['status'])).toBe('hub, as @bo\n\n  #deploys   1 mentioning you');
});

test('several teams, one login each: --team chooses, then KONNECT_TEAM, then the one logged in to; with several and none named, konnect names them', async () => {
  const { server, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  // One team: it is the one used, wherever konnect runs.
  expect(await ann.run(['status'])).toMatch(/^hub, as @ann\n/);
  await signIn(ann, annId, 'side');

  // Each team its own file.
  expect(existsSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json'))).toBe(true);
  expect(existsSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'side.json'))).toBe(true);

  // Two, and none named: a wrong command line, naming them.
  expect(await fails(ann.run(['team', 'list']))).toBe('you\'re logged in to 2 teams (hub, side): say which with --team <name>, or set KONNECT_TEAM');
  expect(await exitOf(ann.run(['team', 'list']))).toBe(2);
  // --team, else KONNECT_TEAM.
  expect(await ann.run(['--team', 'hub', 'team', 'list', '--json'])).toContain('"ann/reviewer"');
  expect(await ann.run(['team', 'list', '--json'], { env: { ...ann.env, KONNECT_TEAM: 'side' } })).not.toContain('"ann/reviewer"');
  expect(await ann.run(['status', '--team', 'hub'], { env: { ...ann.env, KONNECT_TEAM: 'side' } })).toMatch(/^hub, as @ann\n/);
  expect(await ann.run(['status'], { env: { ...ann.env, KONNECT_TEAM: 'side' } })).toMatch(/^side, as @ann\n/);
  // A name that can't be a team's: a wrong command line, from either.
  expect(await fails(ann.run(['status'], { env: { ...ann.env, KONNECT_TEAM: 'Bad_Name' } }))).toBe('Bad_Name isn\'t a team\'s name: lowercase letters, digits and -, at most 40 characters');
  expect(await exitOf(ann.run(['status'], { env: { ...ann.env, KONNECT_TEAM: 'Bad_Name' } }))).toBe(2);

  // With one left, it is the one used.
  expect(await ann.run(['logout', 'side'])).toBe('Logged out of team side.');
  expect(await ann.run(['team', 'list', '--json'])).toContain('"ann/reviewer"');
  // A team you aren't logged in to says so.
  expect(await fails(ann.run(['team', 'list', '--team', 'side']))).toBe('you aren\'t logged in to team side: run konnect login side');
  // konnect neither reads nor writes a folder's file.
  expect(readdirSync(ann.cwd)).toStrictEqual([]);
});

test('konnect team create makes a team whose name is free, with you as its owner; one that is someone else\'s is refused (4), nothing kept', async () => {
  const { kolab, server, create, bo: boId } = await teams();
  const bo = machine(server.url, 'bo');
  let page = '';
  expect(await create(bo, boId, 'bos-team', (b, h) => { page = h; return pressing('decision=allow')(b); }))
    .toBe('Created team bos-team, with you (@bo) as its owner, and logged in to it.\nInvite people with: konnect team invite <github-user>');
  expect(bo.err.join('\n')).toContain('Opening your browser to create team bos-team with GitHub, with you as its owner. Check what the page says, then Allow.');
  expect(page).toContain('<code>bos-team</code>');
  expect(await kolab.kolabRow('bos-team')).toMatchObject({ owner: 'bo', visibility: 'private' });
  // Already logged in to a team of that name: refused before any browser.
  expect(await fails(bo.run(['team', 'create', 'bos-team'], { open: () => { throw new Error('no browser'); } }))).toBe('you\'re already logged in to a team named bos-team: pick another name');

  // Ann's: refused on the page, which offers Deny alone; nothing is kept.
  expect(await fails(create(bo, boId, 'side', (b) => pressing('decision=')(b)))).toMatch(/^the service didn't create team side: /);
  expect(await exitOf(create(bo, boId, 'side', (b) => pressing('decision=')(b)))).toBe(4);
  expect(Object.values(JSON.parse(readFileSync(join(bo.env.KONNECT_CONFIG_DIR, 'teams', 'side.json'), 'utf8')) as { tokens?: unknown }[]).filter((v) => v.tokens)).toStrictEqual([]);

  // With a second team logged in to, the next step names the new one.
  expect(await create(bo, boId, 'bos-other')).toBe('Created team bos-other, with you (@bo) as its owner, and logged in to it.\nInvite people with: konnect --team bos-other team invite <github-user>');
});

test('konnect login <team> to someone else\'s team is refused (4), and nothing kept', async () => {
  const { server, signIn, bo: boId } = await teams();
  const bo = machine(server.url, 'bo');
  expect(await fails(signIn(bo, boId, 'side', (b) => pressing('decision=')(b)))).toMatch(/^the service didn't log you in to team side: /);
  expect(await exitOf(signIn(bo, boId, 'side', (b) => pressing('decision=')(b)))).toBe(4);
  expect(Object.values(JSON.parse(readFileSync(join(bo.env.KONNECT_CONFIG_DIR, 'teams', 'side.json'), 'utf8')) as { tokens?: unknown }[]).filter((v) => v.tokens)).toStrictEqual([]);
});

test('konnect login <team> never creates a team, and konnect team create <name> never joins one: each is refused, and keeps nothing', async () => {
  const { server, signIn, create, ann: annId, bo: boId } = await teams();
  const bo = machine(server.url, 'bo');
  const deny = (b: string[]) => pressing('decision=')(b);

  // A name nobody has: login refuses it (4), where 0.1.0's konnect team <name> would have made the team.
  const noSuch = await fails(signIn(bo, boId, 'nowhere', deny));
  expect(noSuch).toMatch(/^the service didn't log you in to team nowhere: /);
  expect(noSuch).toMatch(/no team named nowhere exists/);
  expect(noSuch).not.toMatch(/konnect team create/);
  expect(await exitOf(signIn(bo, boId, 'nowhere', deny))).toBe(4);
  expect(teamsAt(server.url, bo.env)).toStrictEqual([]);

  // A name that is taken: team create refuses it (4), with a free name to try, and logs in to nothing.
  const taken = await fails(create(bo, boId, 'side', deny));
  expect(taken).toMatch(/^the service didn't create team side: /);
  expect(taken).toMatch(/A name that is free: konnect team create side-/);
  expect(await exitOf(create(bo, boId, 'side', deny))).toBe(4);
  // Even a team the person is in: on a machine not logged in to it, create still never joins.
  const ann = machine(server.url, 'ann');
  expect(await fails(create(ann, annId, 'hub', deny))).toMatch(/^the service didn't create team hub: /);
  expect(teamsAt(server.url, ann.env)).toStrictEqual([]);
  expect(teamsAt(server.url, bo.env)).toStrictEqual([]);

  // A free name is created, and its maker logged in to it.
  expect(await create(bo, boId, 'bos-own')).toMatch(/^Created team bos-own, with you \(@bo\) as its owner, and logged in to it\./);
  expect(teamsAt(server.url, bo.env)).toStrictEqual(['bos-own']);
});

test('the names 0.1.0 used still work for one release, each saying its new name once on stderr; konnect team <name> is not kept', async () => {
  const { kolab, server, idp, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  const old = async (m: typeof ann, argv: string[], more: Parameters<typeof ann.run>[1] = {}) => {
    const out = await m.run(argv, more);
    return { out, err: [...m.err] };
  };

  // who: team list.
  const list = await bo.run(['team', 'list']);
  expect(await old(bo, ['who'])).toStrictEqual({ out: list, err: ['(konnect who is now konnect team list)'] });
  // read: receive; read --history: history.
  await ann.run(['send', '@bo', 'hello']);
  const read = await old(bo, ['read']);
  expect(read.out).toMatch(/@ann\n {2}hello$/);
  expect(read.err).toStrictEqual(['(konnect read is now konnect receive)']);
  await ann.run(['send', '#general', 'in general']);
  expect(await old(bo, ['read', '--history', '#general'])).toMatchObject({ out: expect.stringMatching(/^#general\n[\s\S]* {2}in general$/), err: ['(konnect read is now konnect history)'] });
  // history marked nothing.
  expect(await bo.run(['receive', '#general'])).toMatch(/ {2}in general$/);
  // join: login.
  expect(await old(bo, ['join', 'hub'], { open: () => { throw new Error('no browser'); } })).toStrictEqual({ out: 'Already logged in to team hub as @bo.', err: ['(konnect join is now konnect login)'] });
  // channel new | join | leave: create | follow | unfollow.
  expect(await old(ann, ['channel', 'new', 'deploys'])).toStrictEqual({ out: 'Created #deploys. You follow it, and everyone in the team can read it and send to it.', err: ['(konnect channel new is now konnect channel create)'] });
  expect(await old(bo, ['channel', 'join', 'deploys'])).toStrictEqual({ out: 'Following #deploys: konnect receive includes it from now on.', err: ['(konnect channel join is now konnect channel follow)'] });
  expect(await old(bo, ['channel', 'leave', 'deploys'])).toStrictEqual({ out: 'No longer following #deploys. A message there that mentions you still reaches you.', err: ['(konnect channel leave is now konnect channel unfollow)'] });
  // recruit: team invite; --list: team list; --withdraw: team remove.
  expect(await old(ann, ['recruit', 'cy'])).toMatchObject({ out: expect.stringMatching(/^Invited: cy\./), err: ['(konnect recruit is now konnect team invite)'] });
  expect(await old(ann, ['recruit', '--list'])).toMatchObject({ out: expect.stringMatching(/^@cy {12}person {2}invited \d{4}-\d\d-\d\d$/m), err: ['(konnect recruit is now konnect team list)'] });
  expect(await old(ann, ['recruit', '--withdraw', 'cy'])).toStrictEqual({ out: 'Withdrew cy\'s invitation to team hub.', err: ['(konnect recruit is now konnect team remove)'] });
  // claude|codex|opencode <name>: agent run <name> <harness>; --no-start: agent add; --listen: --wake-on.
  const allow = (u: URL) => { idp.next(annId); void browse(u, pressing('decision=allow')); };
  const self = () => ({ command: 'node', args: ['k.mjs'] });
  const started: { cmd: string; env: Record<string, string> }[] = [];
  const ran = await old(ann, ['claude', 'helper', '--listen', '#general', '--', '--model', 'opus'], { open: allow, self, start: async (c) => { started.push(c); return 0; } });
  expect(ran.err[0]).toBe('(konnect claude is now konnect agent run helper claude)');
  expect(started).toMatchObject([{ cmd: 'claude' }]);
  expect(JSON.parse(readFileSync(join(ann.cwd, '.mcp.json'), 'utf8')).mcpServers['konnect-helper'].env.KONNECT_WAKE_ON).toBe('general');
  const added = await old(ann, ['codex', 'coder', '--no-start'], { open: allow, self, start: async () => { throw new Error('started'); } });
  expect(added.err[0]).toBe('(konnect codex is now konnect agent add coder)');
  expect(added.err.filter((l) => l.startsWith('('))).toHaveLength(1);
  expect(added.out).toMatch(/^Your agent @ann\/coder is added to team hub, and logged in on this machine\./);
  // remove: team remove. leave: team leave <the team konnect works in>.
  idp.account({ subject: '44', login: 'dee' });
  await kolab.signInWith({ provider: 'stub', subject: '44', login: 'dee' });
  await kolab.grant('hub', 'dee', 'write');
  expect(await old(ann, ['remove', '@dee'])).toMatchObject({ out: expect.stringMatching(/^Removed @dee from team hub: \d+ sessions? ended\.$/), err: ['(konnect remove is now konnect team remove)'] });
  expect(await old(bo, ['leave'])).toStrictEqual({ out: 'You left team hub. konnect dropped its logins to it here.', err: ['(konnect leave is now konnect team leave <team>)'] });
  // konnect team <name> isn't kept: it says the two commands it could have meant (2).
  expect(await fails(ann.run(['team', 'hub']))).toBe('konnect team has no hub: it is list, create, invite, remove or leave. To log in to a team: konnect login hub. To create one: konnect team create hub');
  expect(ann.err).toStrictEqual([]);
});

// ---- the review of #151 ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
/** Makes every MCP call of `tool` fail as a network failure does, until the test ends. */
function failCalls(tool: string) {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof init?.body === 'string' && init.body.includes(`"${tool}"`)) throw new TypeError('fetch failed');
    return realFetch(input, init);
  }) as typeof fetch;
}

test('a login whose identity check fails is revoked and forgotten, never kept unchecked; a kept login that isn\'t the person\'s in the team is refused before any call', async () => {
  const { kolab, server, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  // konjir_whoami fails right after the tokens are saved: nothing stays kept, and the grant is revoked.
  failCalls('konjir_whoami');
  expect(await fails(signIn(ann, annId, 'hub'))).toMatch(/^can't reach the service at /);
  globalThis.fetch = realFetch;
  expect(JSON.parse(readFileSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json'), 'utf8'))).toStrictEqual({});
  expect((await kolab.db.query(`select 1 from session where actor_id = 'ann' and grant_id is not null and ended_at is null`)).rows).toStrictEqual([]);
  expect(readdirSync(ann.cwd)).toStrictEqual([]);

  // A file for team side that holds a login to hub: refused when it opens (3), before anything is sent.
  await signIn(ann, annId, 'hub');
  copyFileSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json'), join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'side.json'));
  const wrong = 'the login kept for team side isn\'t yours in team side, so konnect won\'t use it: run konnect login side';
  expect(await fails(ann.run(['--team', 'side', 'send', '@bo', 'hi']))).toBe(wrong);
  expect(await fails(ann.run(['team', 'list', '--team', 'side']))).toBe(wrong);
  expect(await exitOf(ann.run(['team', 'list', '--team', 'side']))).toBe(3);
});

test('KONNECT_URL is kept as it reads back: a path of /mcp when it has none, its host lowercased, never with credentials, a query or a fragment', () => {
  expect(normalUrl('https://kolab.example.com')).toBe('https://kolab.example.com/mcp');
  expect(normalUrl('https://Kolab.Example.com/mcp')).toBe('https://kolab.example.com/mcp');
  expect(normalUrl('http://127.0.0.1:7420/mcp')).toBe('http://127.0.0.1:7420/mcp');
  expect(() => normalUrl('https://u:p@kolab.example.com/mcp')).toThrow(/user name or password/);
  expect(() => normalUrl('https://kolab.example.com/mcp?x=1')).toThrow(/query or a fragment/);
  expect(() => normalUrl('https://kolab.example.com/mcp#x')).toThrow(/query or a fragment/);
  expect(() => normalUrl('ftp://kolab.example.com/mcp')).toThrow(/is ftp/);
  // Whatever konnect keeps, it reads back as it is.
  for (const u of ['https://kolab.example.com', 'https://Kolab.example.com/mcp', 'http://LOCALHOST:7420']) {
    expect(wellFormedUrl(normalUrl(u))).toBe(true);
    expect(normalUrl(normalUrl(u))).toBe(normalUrl(u));
  }
});

test('konnect receive looks names up before it receives anything: if that fails the messages still show, by stored name; --json needs no names', async () => {
  const { server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  await bo.run(['send', '@ann', 'first']);
  failCalls('konjir_list_members');
  expect(await ann.run(['receive'])).toMatch(/@bo\n {2}first$/);
  await bo.run(['send', '@ann', 'second']);
  expect(JSON.parse(await ann.run(['receive', '--json'])).direct).toMatchObject([{ from: 'bo', message: 'second' }]);
});

test('a message is never read for options: after the recipient, its words are the message as written', async () => {
  const { server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  expect(await bo.run(['send', '@ann', 'use', '--json', 'here', '--team', 'side'])).toBe('Sent to @ann.');
  expect(JSON.parse(await ann.run(['receive', '--json'])).direct).toMatchObject([{ message: 'use --json here --team side' }]);
});

test('text from Kolab or a file reaches the terminal as text: bidirectional and zero-width characters are shown as ?', () => {
  expect(printable('ann\u202egnp.exe')).toBe('ann?gnp.exe');
  expect(printable('a\u200bb\u001b[2Jc\nd')).toBe('a?b?[2Jc\nd');
});

test('konnect leaves a config folder it didn\'t make as it is, refusing one others may write in; send reads its message before opening a session', async () => {
  const { server, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  // A config folder that was there already, 0755: used, and left 0755.
  const own = join(ann.root, 'mine');
  mkdirSync(own);
  chmodSync(own, 0o755);
  ann.env.KONNECT_CONFIG_DIR = own;
  await signIn(ann, annId, 'hub');
  expect(statSync(own).mode & 0o777).toBe(0o755);
  expect(statSync(join(own, 'teams')).mode & 0o777).toBe(0o700);
  // One others may write in: refused, and left as it is.
  const open = join(ann.root, 'open');
  mkdirSync(open);
  chmodSync(open, 0o777);
  expect(await fails(ann.run(['login', 'hub'], { env: { ...ann.env, KONNECT_CONFIG_DIR: open }, open: () => undefined }))).toMatch(/^others may write in .*open, so konnect won't keep a sign-in there/);
  expect(statSync(open).mode & 0o777).toBe(0o777);

  // The message is read first: with no login for the team, stdin was still read, before konnect found none.
  let asked = 0;
  expect(await fails(ann.run(['--team', 'side', 'send', '@bo'], { stdin: async () => { asked++; return 'hi'; } }))).toBe('you aren\'t logged in to team side: run konnect login side');
  expect(asked).toBe(1);
});
