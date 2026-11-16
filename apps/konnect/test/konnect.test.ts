// konnect end to end against a Kolab started here, with a stub in GitHub's place: two people sign
// in to one team with `konnect team`, each with a config folder of their own, and exchange direct
// messages through `konnect send` and `konnect read`; `konnect who` names the team's members, an
// agent as owner/label; several teams are kept apart, one sign-in each; a folder's .konnect.json
// remembers a team and is followed only to a Kolab konnect trusts; and the commands the server
// can't serve yet say so. The "browser" follows Kolab's redirects with its cookies and submits the
// consent page.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@jest/globals';
import { StubIdentity, startServer } from '@konjir/server';
import { closeAtEnd, openKolab, rejection, type TestKolab } from '@konjir/engine/testing';
import { HOSTED_URL, main, type IO } from '../src/konnect.js';

/** The person's browser: follows Kolab's redirects with its cookies, submits the consent page as `form` says, and lands on konnect's loopback callback. */
async function browse(start: URL, form: Record<string, string>): Promise<string> {
  const jar = new Map<string, string>();
  const go = async (url: URL, init: RequestInit = {}) => {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; jar.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)); }
    return res;
  };
  let url = start;
  let res = await go(url);
  while (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get('location')!, url); res = await go(url); }
  const html = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const signIn = /name="sign_in" value="([^"]+)"/.exec(html)?.[1];
  if (!csrf) throw new Error(`no consent page at ${url.pathname}: ${res.status}`);
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, sign_in: signIn ?? '', decision: 'allow', ...form }).toString(),
  });
  await (await fetch(new URL(done.headers.get('location')!))).text();
  return html;
}

const AS_SELF = (team: string) => ({ as: 'self', kolab: `kolab:${team}`, role: 'product' });

/** What a command that fails says: the line konnect prints. */
const fails = async (p: Promise<unknown>) => (await rejection(p)).replace(/^Error: /, '');

/** One person's machine: their own config folder and a folder to work in, and what konnect printed there. */
function machine(url: string, name: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `konnect-${name}-`)));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const out: string[] = [];
  const err: string[] = [];
  const env = { KONNECT_URL: url, KONNECT_CONFIG_DIR: join(root, 'config') };
  const run = async (argv: string[], more: Partial<IO> = {}) => {
    out.length = 0; err.length = 0;
    await main(argv, { env, cwd, out: (l) => out.push(l), err: (l) => err.push(l), ...more });
    return out.join('\n');
  };
  return { root, cwd, env, out, err, run };
}

/** Ann owns team `hub`, where Bo writes and Ann's agent ann-reviewer works; Ann also owns `side`. */
async function teams() {
  const kolab: TestKolab = await openKolab();
  const idp = new StubIdentity();
  const server = await startServer({ adminToken: 'konnect-admin', kolab, identity: idp, webRoot: null });
  closeAtEnd(server);
  await kolab.signInWith({ provider: 'stub', subject: '41', login: 'ann' });
  await kolab.signInWith({ provider: 'stub', subject: '42', login: 'bo' });
  await kolab.createKolab('hub', { owner: 'ann' });
  await kolab.createKolab('side', { owner: 'ann' });
  await kolab.grant('hub', 'bo', 'write');
  await kolab.addActor('ann-reviewer', { owner: 'ann' });
  await kolab.grant('hub', 'ann-reviewer', 'write');
  const signIn = async (m: ReturnType<typeof machine>, login: { subject: string; login: string }, team: string, form = AS_SELF(team)) => {
    idp.next(login);
    return m.run(['team', team], { open: (u) => { void browse(u, form); } });
  };
  return { kolab, server, idp, signIn, ann: { subject: '41', login: 'ann' }, bo: { subject: '42', login: 'bo' } };
}

test('two people in one team exchange direct messages through konnect send and konnect read; konnect who names the members, an agent as owner/label', async () => {
  const { kolab, server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');

  expect(await signIn(ann, annId, 'hub')).toBe('Signed in to team hub as ann. This folder remembers it (.konnect.json).');
  expect(ann.err.join('\n')).toContain('choose Yourself (not an agent) and kolab hub');
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
  expect(await bo.run(['send', 'ann', 'and the docs are up'])).toBe('Sent to @ann.');
  const read = await ann.run(['read']);
  expect(read).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d {2}@bo\n {2}the deploy is green\n\n\d{4}-\d\d-\d\d \d\d:\d\d {2}@bo\n {2}and the docs are up$/);
  expect(await ann.run(['read'])).toBe('No unread messages.');

  // Ann answers from stdin, several lines; Bo reads it as JSON.
  expect(await ann.run(['send', '@bo'], { stdin: async () => 'thanks!\nshipping now\n' })).toBe('Sent to @bo.');
  const got = JSON.parse(await bo.run(['read', '--json']));
  expect(got).toMatchObject([{ from: 'ann', to: 'bo', message: 'thanks!\nshipping now' }]);
  expect(got[0].read_at).not.toBeNull();
  expect(JSON.parse(await bo.run(['read', '--json']))).toStrictEqual([]);

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
  expect(whoJson).toContainEqual({ actor: 'ann-reviewer', kind: 'agent', owner: 'ann', here: true, name: 'ann/reviewer' });

  // konnect read @name: only theirs, oldest first, left unread (Kolab marks them read only all at once).
  await bo.run(['send', '@ann', 'one more thing']);
  await kolab.sendMessage(reviewer, 'ann', 'from the reviewer');
  expect(await ann.run(['read', '@bo'])).toMatch(/@bo\n {2}one more thing$/);
  expect(ann.err.join('\n')).toContain('These stay unread for now');
  expect(await ann.run(['read', '@ann/reviewer'])).toMatch(/@ann\/reviewer\n {2}from the reviewer$/);
  expect((await ann.run(['read'])).match(/@/g)).toHaveLength(2);

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

test('a sign-in as an agent, or in another kolab, is revoked and never kept', async () => {
  const { kolab, server, signIn, ann: annId } = await teams();
  const ann = machine(server.url, 'ann');
  expect(await fails(signIn(ann, annId, 'hub', { as: 'agent:ann-reviewer', kolab: 'kolab:hub', role: 'product' })))
    .toMatch(/^you signed in as ann-reviewer, an agent, not as yourself in team hub, so konnect kept nothing\. Run konnect team hub again/);
  expect(await fails(signIn(ann, annId, 'hub', AS_SELF('side')))).toMatch(/^you signed in in kolab side, not as yourself in team hub, so konnect kept nothing/);
  expect(JSON.parse(readFileSync(join(ann.env.KONNECT_CONFIG_DIR, 'teams', 'hub.json'), 'utf8'))).toStrictEqual({});
  expect(existsSync(join(ann.cwd, '.konnect.json'))).toBe(false);
  expect((await kolab.db.query(`select 1 from session where actor_id in ('ann', 'ann-reviewer') and grant_id is not null and ended_at is null`)).rows).toStrictEqual([]);
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
  expect(await said([])).toBe('Live chat (konnect with no command) isn\'t available yet.');
  expect(await said(['send', '#general', 'deploy is green'])).toBe('Channel messages (konnect send \'#general\') isn\'t available yet.');
  expect(await said(['read', '#deploys'])).toBe('Channel messages (konnect read \'#deploys\') isn\'t available yet.');
  expect(await said(['channel', 'new', 'deploys'])).toBe('Channels (konnect channel) isn\'t available yet.');
  expect(await said(['recruit', 'sam-gh'])).toBe('Inviting people (konnect recruit) isn\'t available yet.');
  expect(await said(['remove', '@sam'])).toBe('Removing a member (konnect remove) isn\'t available yet.');
  for (const tool of ['claude', 'codex', 'opencode']) expect(await said([tool, 'reviewer', '--team', 'acme'])).toBe(`Starting an agent (konnect ${tool}) isn't available yet.`);
  expect(await said(['frobnicate'])).toBe('konnect has no command frobnicate: run konnect help');
  const help = await m.run(['help']);
  for (const line of ['konnect team <name>', 'konnect who', 'konnect send @name [message]', 'konnect read [@name]', 'konnect logout', 'konnect channel new|join|leave|list', 'konnect recruit', 'konnect claude|codex|opencode <label>', 'live chat']) expect(help).toContain(line);
  expect(await m.run(['--version'])).toBe('development (run from source)');
  // A Kolab that isn't there is said plainly.
  expect(await fails(m.run(['team', 'hub'], { open: () => undefined }))).toMatch(/^can't reach Kolab at http:\/\/127\.0\.0\.1:9\/mcp: check your connection and try again, or start the local Kolab$/);
});
