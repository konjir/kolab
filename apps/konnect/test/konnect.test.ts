// konnect end to end against a Kolab started here, with a stub in GitHub's place: two people sign
// in to one team with `konnect team`, each with a config folder of their own, and exchange direct
// messages through `konnect send` and `konnect read`; `konnect who` names the team's members, an
// agent as owner/label; several teams are kept apart, one sign-in each; a folder's .konnect.json
// remembers a team and is followed only to a Kolab konnect trusts; and the commands the server
// can't serve yet say so. The "browser" follows Kolab's redirects with its cookies and submits the
// consent page.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from '@jest/globals';
import { fails, machine, pressing, teams } from './team.js';
import { HOSTED_URL, normalUrl, parseArgs, readProject, rememberTeam, type IO } from '../src/konnect.js';
import { printable } from '../src/names.js';

test('two people in one team exchange direct messages through konnect send and konnect read; konnect who names the members, an agent as owner/label', async () => {
  const { kolab, server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');

  expect(await signIn(ann, annId, 'hub')).toBe('Signed in to team hub as ann. This folder remembers it (.konnect.json).');
  expect(ann.err.join('\n')).toContain('Opening your browser to sign in to team hub with GitHub.');
  expect(await signIn(bo, boId, 'hub')).toBe('Signed in to team hub as bo. This folder remembers it (.konnect.json).');

  // Each sign-in is kept in the person's own konnect folder, one file per team, closed to others; the folder's file holds no token.
  const file = join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams')).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(file, 'utf8'))[server.url].tokens.refresh_token).toMatch(/^kjr_/);
  const remembered = readFileSync(join(ann.cwd, '.konnect.json'), 'utf8');
  expect(JSON.parse(remembered)).toStrictEqual({ team: 'hub', url: server.url });
  expect(remembered).not.toMatch(/kj[rsa]_/);

  // Signing in to the same team again uses the sign-in kept: no browser.
  expect(await ann.run(['team', 'hub'], { open: () => { throw new Error('no browser'); } })).toBe('Using team hub as ann. This folder remembers it (.konnect.json).');

  // Bo writes to Ann; Ann reads it, oldest first, and it is marked read.
  expect(await bo.run(['send', '@ann', 'the', 'deploy', 'is', 'green'])).toBe('Sent to @ann.');
  expect(await bo.run(['send', '@ann', 'and the docs are up'])).toBe('Sent to @ann.');
  const read = await ann.run(['read']);
  expect(read).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d {2}@bo\n {2}the deploy is green\n\n\d{4}-\d\d-\d\d \d\d:\d\d {2}@bo\n {2}and the docs are up$/);
  expect(await ann.run(['read'])).toBe('No unread messages.');

  // Ann answers from stdin, several lines; Bo reads it as JSON.
  expect(await ann.run(['send', '@bo'], { stdin: async () => 'thanks!\nshipping now\n' })).toBe('Sent to @bo.');
  const got = JSON.parse(await bo.run(['read', '--json'])).direct;
  expect(got).toMatchObject([{ from: 'ann', to: 'bo', message: 'thanks!\nshipping now' }]);
  expect(got[0].read_at).not.toBeNull();
  expect(JSON.parse(await bo.run(['read', '--json']))).toStrictEqual({ direct: [], channels: [] });

  // An agent is @owner/label, stored as owner-label.
  expect(await bo.run(['send', '@ann/reviewer', 'please review the importer'])).toBe('Sent to @ann/reviewer.');
  const reviewer = await kolab.openSession('ann-reviewer', 'product', { kolab: 'hub' });
  expect((await kolab.readMessages(reviewer)).messages).toMatchObject([{ from: 'bo', to: 'ann-reviewer', message: 'please review the importer' }]);
  // Its answer reads as from ann/reviewer.
  await kolab.sendMessage(reviewer, 'bo', 'on it');
  expect(await bo.run(['read'])).toMatch(/ {2}@ann\/reviewer\n {2}on it$/);

  // konnect who: everyone, you marked, an agent as owner/label, who has a session open.
  const who = (await bo.run(['who'])).split('\n');
  expect(who).toHaveLength(3);
  expect(who[0]).toMatch(/^ann {2,}person {2}connected$/);
  expect(who[1]).toMatch(/^ann\/reviewer {2,}agent {3}connected$/);
  expect(who[2]).toMatch(/^bo \(you\) {2,}person {2}connected$/);
  const whoJson = JSON.parse(await bo.run(['who', '--json']));
  expect(whoJson).toContainEqual({ actor: 'ann-reviewer', kind: 'agent', owner: 'ann', label: 'reviewer', here: true, name: 'ann/reviewer' });

  // konnect read @name: only theirs, oldest first, marked read; the rest stay unread, and the last line says so.
  await bo.run(['send', '@ann', 'one more thing']);
  await kolab.sendMessage(reviewer, 'ann', 'from the reviewer');
  expect(await ann.run(['read', '@bo'])).toMatch(/@bo\n {2}one more thing\n\(1 direct message\)$/);
  expect(await ann.run(['read', '@ann/reviewer'])).toMatch(/@ann\/reviewer\n {2}from the reviewer$/);
  expect(await ann.run(['read'])).toBe('No unread messages.');

  // Someone who isn't in the team, or a name that isn't one, is refused, saying what to do.
  expect(await fails(bo.run(['send', '@sam', 'hi']))).toBe('@sam isn\'t in team hub: konnect who lists who is');
  expect(await fails(bo.run(['send', '@ann/Not A Label', 'hi']))).toMatch(/isn't a member's name: an agent is @<owner>\/<label>/);
  expect(await fails(bo.run(['send', '@ann'], { stdin: async () => '\n' }))).toBe('konnect send: the message is empty');

  // konnect logout revokes the sign-in and forgets it; the folder's file stays, and says what to do.
  expect(await bo.run(['logout'])).toBe('Signed out of team hub.');
  expect(await fails(bo.run(['who']))).toBe('you aren\'t signed in to team hub: run konnect team hub');
  expect((await kolab.db.query(`select 1 from session s join oauth_grant g on g.id = s.grant_id where s.actor_id = 'bo' and s.ended_at is null`)).rows).toStrictEqual([]);
});

test('several teams, one sign-in each: --team chooses, the folder remembers one, and with neither konnect asks which', async () => {
  const { server, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  const sideDir = join(ann.root, 'side');
  mkdirSync(sideDir);
  const annSide = { ...ann, run: async (argv: string[], more: Partial<IO> = {}) => ann.run(argv, { cwd: sideDir, ...more }) };
  await signIn(annSide as typeof ann, annId, 'side');
  expect(JSON.parse(readFileSync(join(sideDir, '.konnect.json'), 'utf8')).team).toBe('side');

  // Each team its own file.
  expect(existsSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json'))).toBe(true);
  expect(existsSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'side.json'))).toBe(true);

  // Each folder works in its own team.
  expect(await ann.run(['who', '--json'])).toContain('"ann-reviewer"');
  expect(await ann.run(['who', '--json'], { cwd: sideDir })).not.toContain('"ann-reviewer"');
  // --team overrides the folder.
  expect(await ann.run(['who', '--team', 'side', '--json'])).not.toContain('"ann-reviewer"');

  // konnect team lists them, marking the folder's.
  expect(await ann.run(['team'])).toBe('hub  (this folder)\nside');
  // A folder that names no team: with two, konnect asks which.
  const elsewhere = join(ann.root, 'elsewhere');
  mkdirSync(elsewhere);
  expect(await fails(ann.run(['who'], { cwd: elsewhere }))).toBe('you\'re in 2 teams (hub, side): pass --team <name>, or run konnect team <name> here to remember one in this folder');
  expect(await ann.run(['team'], { cwd: elsewhere })).toBe('hub\nside');
  // With one left, it is the one used.
  await ann.run(['logout', '--team', 'side']);
  expect(await ann.run(['who', '--json'], { cwd: elsewhere })).toContain('"ann-reviewer"');
  // A team you aren't signed in to says so.
  expect(await fails(ann.run(['who', '--team', 'side'], { cwd: elsewhere }))).toBe('you aren\'t signed in to team side: run konnect team side');
  expect(await fails(ann.run(['who', '--team', 'Bad_Name']))).toBe('Bad_Name isn\'t a team\'s name: lowercase letters, digits and -, at most 40 characters');
});

test('konnect team makes a team whose name is free; one that is someone else\'s is refused, nothing kept, with a free name suggested', async () => {
  const { kolab, server, signIn, bo: boId } = await teams();
  const bo = machine(server.url, 'bo');
  let page = '';
  expect(await signIn(bo, boId, 'bos-team', (b, h) => { page = h; return pressing('decision=allow')(b); })).toBe('Signed in to team bos-team as bo. This folder remembers it (.konnect.json).');
  expect(page).toContain('<code>bos-team</code>');
  expect(await kolab.kolabRow('bos-team')).toMatchObject({ owner: 'bo', visibility: 'private' });
  // Ann's: refused on the page, which offers Deny alone.
  const err = await fails(signIn(bo, boId, 'side', (b) => pressing('decision=')(b)));
  expect(err).toMatch(/^Kolab didn't sign you in to team side: .*Make your own instead: konnect team \S+$/);
  expect(Object.values(JSON.parse(readFileSync(join(bo.env.KONNECT_CONFIG_DIR, 'teams', 'side.json'), 'utf8')) as { tokens?: unknown }[]).filter((v) => v.tokens)).toStrictEqual([]);
  expect(JSON.parse(readFileSync(join(bo.cwd, '.konnect.json'), 'utf8')).team).toBe('bos-team');
});

test('.konnect.json: found from a folder below it in a repository, never above outside one, and its URL followed only to a Kolab konnect trusts', async () => {
  const { server, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  await signIn(ann, annId, 'hub');
  const noUrl = { KONNECT_CONFIG_DIR: ann.env.KONNECT_CONFIG_DIR };
  const repo = join(ann.root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
  const file = join(repo, '.konnect.json');

  // Its URL is a Kolab on this machine: followed, from a folder below it too, with no KONNECT_URL.
  writeFileSync(file, JSON.stringify({ team: 'hub', url: server.url }));
  expect(await ann.run(['who', '--json'], { cwd: join(repo, 'src', 'deep'), env: noUrl })).toContain('"ann-reviewer"');

  // Outside a repository, a folder above is never read.
  const plain = join(ann.root, 'plain');
  mkdirSync(join(plain, 'below'), { recursive: true });
  writeFileSync(join(plain, '.konnect.json'), JSON.stringify({ team: 'nope' }));
  expect(await ann.run(['team', '--json'], { cwd: join(plain, 'below'), env: noUrl })).toContain('"folder": null');

  // A URL konnect hasn't been given is refused before anything is sent.
  writeFileSync(file, JSON.stringify({ team: 'hub', url: 'https://kolab.example.com/mcp' }));
  expect(await fails(ann.run(['who'], { cwd: repo, env: noUrl }))).toMatch(/names Kolab at https:\/\/kolab\.example\.com\/mcp, which you haven't given konnect yourself, so konnect won't use it/);
  // The hosted Kolab is followed (and here, holds no sign-in of this test's).
  writeFileSync(file, JSON.stringify({ team: 'hub', url: HOSTED_URL }));
  expect(await fails(ann.run(['who'], { cwd: repo, env: noUrl }))).toBe('you aren\'t signed in to team hub: run konnect team hub');
  // KONNECT_URL wins over the file.
  writeFileSync(file, JSON.stringify({ team: 'hub', url: 'https://kolab.example.com/mcp' }));
  expect(await ann.run(['who', '--json'], { cwd: repo })).toContain('"ann-reviewer"');

  // A file that isn't konnect's is refused, never passed over.
  writeFileSync(file, JSON.stringify({ team: 'Not A Team' }));
  expect(await fails(ann.run(['who'], { cwd: repo }))).toMatch(/\.konnect\.json names a team badly: it names a team, \{"team": "<name>"\}/);
  writeFileSync(file, '{"team": "hub", "token": "kjr_x", "url": "http://user:pw@127.0.0.1/mcp"}');
  expect(await fails(ann.run(['who'], { cwd: repo }))).toMatch(/names Kolab's URL badly/);
  // A team the file names that you aren't signed in to says so.
  writeFileSync(file, JSON.stringify({ team: 'side' }));
  expect(await fails(ann.run(['who'], { cwd: repo }))).toBe('you aren\'t signed in to team side: run konnect team side');
  expect(await ann.run(['team'], { cwd: repo })).toBe('hub\nThis folder\'s .konnect.json names team side, which you aren\'t signed in to: run konnect team side.');
});

test('the commands the server can\'t serve yet say so, before anything is read or sent; help names them', async () => {
  const m = machine('http://127.0.0.1:9/mcp', 'later');
  const said = async (argv: string[]) => fails(m.run(argv));
  expect(await said(['frobnicate'])).toBe('konnect has no command frobnicate: run konnect help');
  const help = await m.run(['help']);
  for (const line of ['konnect team <name>', 'konnect who', 'konnect send @name [message]', 'konnect send \'#channel\' [message]', 'konnect read @name', 'konnect read \'#channel\'', 'konnect logout', 'konnect channel new <name>', 'konnect channel join|leave <name>', 'konnect mcp --agent <label>', 'konnect recruit', 'konnect claude <label>', 'konnect codex|opencode <label>', 'konnect join', 'konnect leave', 'konnect remove @name', 'live chat']) expect(help).toContain(line);
  expect(await m.run(['--version'])).toBe('development (run from source)');
  // A Kolab that isn't there is said plainly.
  expect(await fails(m.run(['team', 'hub'], { open: () => undefined }))).toMatch(/^can't reach Kolab at http:\/\/127\.0\.0\.1:9\/mcp: check your connection and try again, or start the local Kolab$/);
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

test('a sign-in whose identity check fails is revoked and forgotten, never kept unchecked; a kept sign-in that isn\'t the person\'s in the team is refused before any call', async () => {
  const { kolab, server, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  // konjir_whoami fails right after the tokens are saved: nothing stays kept, and the grant is revoked.
  failCalls('konjir_whoami');
  expect(await fails(signIn(ann, annId, 'hub'))).toMatch(/^can't reach Kolab/);
  globalThis.fetch = realFetch;
  expect(JSON.parse(readFileSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json'), 'utf8'))).toStrictEqual({});
  expect((await kolab.db.query(`select 1 from session where actor_id = 'ann' and grant_id is not null and ended_at is null`)).rows).toStrictEqual([]);
  expect(existsSync(join(ann.cwd, '.konnect.json'))).toBe(false);

  // A file for team side that holds a sign-in to hub: refused when it opens, before anything is sent.
  await signIn(ann, annId, 'hub');
  copyFileSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json'), join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'side.json'));
  expect(await fails(ann.run(['send', '@bo', '--team', 'side', 'hi'])))
    .toBe('the sign-in kept for team side isn\'t yours in team side, so konnect won\'t use it: run konnect team side to sign in again');
  expect(await fails(ann.run(['who', '--team', 'side'])))
    .toBe('the sign-in kept for team side isn\'t yours in team side, so konnect won\'t use it: run konnect team side to sign in again');
});

test('KONNECT_URL is kept as it reads back: a path of /mcp when it has none, its host lowercased, never with credentials, a query or a fragment', () => {
  expect(normalUrl('https://kolab.example.com')).toBe('https://kolab.example.com/mcp');
  expect(normalUrl('https://Kolab.Example.com/mcp')).toBe('https://kolab.example.com/mcp');
  expect(normalUrl('http://127.0.0.1:7420/mcp')).toBe('http://127.0.0.1:7420/mcp');
  expect(() => normalUrl('https://u:p@kolab.example.com/mcp')).toThrow(/user name or password/);
  expect(() => normalUrl('https://kolab.example.com/mcp?x=1')).toThrow(/query or a fragment/);
  expect(() => normalUrl('https://kolab.example.com/mcp#x')).toThrow(/query or a fragment/);
  expect(() => normalUrl('ftp://kolab.example.com/mcp')).toThrow(/is ftp/);
  // Whatever konnect writes, it reads back.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'konnect-url-')));
  for (const u of ['https://kolab.example.com', 'https://Kolab.example.com/mcp', 'http://LOCALHOST:7420']) {
    const path = rememberTeam(dir, 'hub', normalUrl(u));
    expect(readProject(path)).toStrictEqual({ path, team: 'hub', url: normalUrl(u) });
  }
  expect(() => rememberTeam(dir, 'hub', 'https://u:p@kolab.example.com/mcp')).toThrow(/couldn't read it back/);
});

test('konnect read looks names up before it marks anything read: if that fails the messages still show, by stored name; --json needs no names', async () => {
  const { server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  await bo.run(['send', '@ann', 'first']);
  failCalls('konjir_list_members');
  expect(await ann.run(['read'])).toMatch(/@bo\n {2}first$/);
  await bo.run(['send', '@ann', 'second']);
  expect(JSON.parse(await ann.run(['read', '--json'])).direct).toMatchObject([{ from: 'bo', message: 'second' }]);
});

test('a message is never read for flags: after the recipient, its words are the message as written; -- ends the flags', async () => {
  expect(parseArgs(['send', '@ann', 'use', '--json', 'here'])).toStrictEqual({ json: false, forget: false, words: ['send', '@ann', 'use', '--json', 'here'] });
  expect(parseArgs(['send', '@ann', 'try', '--team', 'x'])).toStrictEqual({ json: false, forget: false, words: ['send', '@ann', 'try', '--team', 'x'] });
  expect(parseArgs(['--json', 'send', '--team', 'hub', '@ann', 'hi'])).toStrictEqual({ json: true, team: 'hub', forget: false, words: ['send', '@ann', 'hi'] });
  expect(parseArgs(['send', '@ann', '--json', 'hi'])).toStrictEqual({ json: true, forget: false, words: ['send', '@ann', 'hi'] });
  expect(parseArgs(['send', '@ann', '--', '--json'])).toStrictEqual({ json: false, forget: false, words: ['send', '@ann', '--json'] });
  expect(parseArgs(['read', '--', '--json'])).toStrictEqual({ json: false, forget: false, words: ['read', '--json'] });

  const { server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');
  expect(await bo.run(['send', '@ann', 'use', '--json', 'here', '--team', 'side'])).toBe('Sent to @ann.');
  expect(JSON.parse(await ann.run(['read', '--json'])).direct).toMatchObject([{ message: 'use --json here --team side' }]);
});

test('text from Kolab or a file reaches the terminal as text: bidirectional and zero-width characters are shown as ?', () => {
  expect(printable('ann‮gnp.exe')).toBe('ann?gnp.exe');
  expect(printable('a​b\u001b[2Jc\nd')).toBe('a?b?[2Jc\nd');
});

test('konnect leaves a config folder it didn\'t make as it is, refusing one others may write in; it updates the .konnect.json it found, never shadows it; send reads its message before opening a session', async () => {
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
  expect(await fails(ann.run(['team', 'hub'], { env: { ...ann.env, KONNECT_CONFIG_DIR: open } }))).toMatch(/^others may write in .*open, so konnect won't keep a sign-in there/);
  expect(statSync(open).mode & 0o777).toBe(0o777);

  // In a repository, konnect team below the root updates the root's .konnect.json.
  const repo = join(ann.root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, '.konnect.json'), JSON.stringify({ team: 'side', other: 1 }));
  expect(await ann.run(['team', 'hub'], { cwd: join(repo, 'src') })).toBe(`Using team hub as ann. ${join(repo, '.konnect.json')} remembers it.`);
  expect(existsSync(join(repo, 'src', '.konnect.json'))).toBe(false);
  expect(JSON.parse(readFileSync(join(repo, '.konnect.json'), 'utf8'))).toStrictEqual({ team: 'hub', other: 1, url: server.url });

  // The message is read first: with no sign-in for the team, stdin was still read, before konnect found none.
  let asked = 0;
  expect(await fails(ann.run(['send', '@bo', '--team', 'side'], { stdin: async () => { asked++; return 'hi'; } }))).toBe('you aren\'t signed in to team side: run konnect team side');
  expect(asked).toBe(1);
});
