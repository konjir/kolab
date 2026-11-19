#!/usr/bin/env node
// The contract a published konnect holds this checkout's server to: an older @konjir/konnect from
// npm, run against a Kolab started from this checkout, still works, and still recognises the
// server's words it depends on (docs/plans/rebrand-and-site.md, "Older konnect keeps working"):
//
//   node apps/konnect/scripts/compat.mjs --konnect <an installed @konjir/konnect's bin/konnect>
//   node apps/konnect/scripts/compat.mjs --versions    the versions to test, from npm, as JSON
//
// .github/workflows/konnect-compat.yml runs it for each version --versions lists: every release
// published on npm from MIN_VERSION on, read when it runs, so each new release is covered with no
// change here. Prereleases and the 0.0.x placeholders (0.0.0-stage, 0.0.1: a name held on npm, with
// no konnect in it) are left out. 0.1.0, the first release, is covered, though its commands differ.
// The Kolab, the people's machines and their browser are scripts/harness.mjs's, as scripts/e2e.mjs
// has them: the checkout's server on PGlite, the stub identity in GitHub's place, nothing else reached.
//
// Each version is driven only with commands it has. Which set it has is read from its own help:
//   - 0.2.0 on: konnect team create / team invite / login / send / receive / status / team list
//   - 0.1.0: konnect team <name> / recruit / join / send / read / who, and bare konnect for what is unread
//
//   1. lead creates a team; lead invites peer; peer logs in and joins, accepting on Kolab's page
//   2. both send and receive in #general; konnect status (0.1.0: bare konnect) shows the unread;
//      the members are listed
//   3. a direct message to someone who isn't in the team: konnect says they aren't in the team
//      (it recognises Kolab's `is not a member of kolab`)
//   4. an owner's action (inviting) by peer, who isn't the owner: konnect says only the team's
//      owner can (it recognises Kolab's `only the owner of kolab`)
//   5. a revoked login: peer's kept login, revoked on Kolab by konnect logout and then put back,
//      is refused, and konnect says the login has ended or was revoked and to log in again (its
//      sign-in recognition: `401|Unauthorized|has ended or was revoked|run konjir login|invalid
//      Konjir token`), never a bare error
//   6. Kolab logged each konnect that connected, by its name and the version it gives (event
//      mcp_client): 0.1.0 for every release up to 0.8.0, which all said so; its own from then on
//
// Exits nonzero, saying which check failed. KEEP=1 keeps the temp folder, and prints where.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { check, harness, konnectArg } from './harness.mjs';

/** The oldest release tested: the first, 0.1.0. Raise it only once no one runs the older ones (Kolab's mcp_client lines say). */
const MIN_VERSION = '0.1.0';
/** Every release up to this one told Kolab it was 0.1.0. */
const SAID_0_1_0_UNTIL = '0.8.0';

const parts = (v) => v.split('.').map(Number);
const atLeast = (v, min) => { const [a, b] = [parts(v), parts(min)]; for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

if (process.argv.includes('--versions')) {
  const all = JSON.parse(execFileSync('npm', ['view', '@konjir/konnect', 'versions', '--json'], { encoding: 'utf8' }));
  const tested = [all].flat().filter((v) => /^\d+\.\d+\.\d+$/.test(v) && atLeast(v, MIN_VERSION));
  if (!tested.length) { console.error(`npm lists no @konjir/konnect release from ${MIN_VERSION} on: ${JSON.stringify(all)}`); process.exit(1); }
  console.log(JSON.stringify(tested));
  process.exit(0);
}

const h = harness(konnectArg('--konnect <path to an installed @konjir/konnect\'s bin/konnect>'), 'konnect-compat');
const { step, konnect, say, signingIn } = h;
const TEAM = `compat-${randomBytes(3).toString('hex')}`;
const PEOPLE = { lead: { subject: '601', login: 'lead' }, peer: { subject: '602', login: 'peer' }, third: { subject: '603', login: 'third' } };
const said = (r) => `exit ${r.code}\n${r.out}${r.err}`;

/** Kolab's own log lines, as it printed them (JSON, one each). */
const logged = [];
h.onLog = (line) => { try { logged.push(JSON.parse(line)); } catch { /* not one of Kolab's lines */ } };

/**
 * The commands of the version under test, by what its help lists. Each returns konnect's result;
 * the steps check what it said.
 */
function surfaceOf(help) {
  if (/konnect team create <name>/.test(help) && /konnect receive/.test(help) && /konnect status/.test(help)) {
    return {
      name: '0.2.0 and later (team create, login, receive, status)',
      create: (m, who) => signingIn(m, who, ['team', 'create', TEAM], 'decision=allow'),
      created: (r) => r.out.includes(`Created team ${TEAM}`),
      invite: (m, login) => konnect(m, ['team', 'invite', login]),
      invited: (r, login) => r.code === 0 && r.out.includes(`Invited: ${login}.`),
      join: (m, who) => signingIn(m, who, ['login'], 'pick=accept:'),
      joined: (r) => r.out.includes(`You're in team ${TEAM}, as @peer.`),
      send: (m, to, text) => konnect(m, ['send', to, text]),
      sent: (r) => r.code === 0 && /^Sent to /.test(r.out.trim()),
      receive: (m, from) => konnect(m, ['receive', from]),
      status: (m) => konnect(m, ['status']),
      unread: (r) => r.code === 0 && r.out.startsWith(`${TEAM}, as @lead`) && /#general\s+1 unread/.test(r.out),
      members: (m) => konnect(m, ['team', 'list']),
      listed: (r) => r.code === 0 && /@lead \(you\)/.test(r.out) && /@peer\b/.test(r.out),
      // A refusal is exit 4; a login to renew, 3.
      refused: 4, signIn: 3,
      // What a person runs that needs the login: konnect status.
      afterRevoked: (m) => konnect(m, ['status']),
      relogin: `run konnect login ${TEAM}`,
    };
  }
  if (/konnect team <name>/.test(help) && /konnect recruit/.test(help) && /konnect read/.test(help)) {
    return {
      name: '0.1.0 (team <name>, recruit, join, read)',
      create: (m, who) => signingIn(m, who, ['team', TEAM], 'decision=allow'),
      created: (r) => r.out.includes(TEAM),
      invite: (m, login) => konnect(m, ['recruit', login]),
      invited: (r, login) => r.code === 0 && r.out.includes(login),
      join: (m, who) => signingIn(m, who, ['join'], 'pick=accept:'),
      joined: (r) => r.out.includes(TEAM),
      send: (m, to, text) => konnect(m, ['send', to, text]),
      sent: (r) => r.code === 0 && /^Sent to /.test(r.out.trim()),
      receive: (m, from) => konnect(m, ['read', from]),
      // With a team, bare konnect says what is unread.
      status: (m) => konnect(m, []),
      unread: (r) => r.code === 0 && /#general/.test(r.out) && /\b1\b/.test(r.out),
      members: (m) => konnect(m, ['who']),
      listed: (r) => r.code === 0 && /^lead \(you\)/m.test(r.out) && /^peer\b/m.test(r.out),
      // 0.1.0 exits 1 on any failure.
      refused: null, signIn: null,
      // Bare konnect says a login has ended and still exits 0: konnect who needs it, and fails.
      afterRevoked: (m) => konnect(m, ['who']),
      relogin: `run konnect team ${TEAM}`,
    };
  }
  return undefined;
}

async function main() {
  const lead = h.machine('lead');
  const peer = h.machine('peer');
  step(`konnect: ${h.konnectCmd.join(' ')}`);
  const version = await konnect(lead, ['--version']);
  check(version.code === 0 && /^\d+\.\d+\.\d+/.test(version.out.trim()), `konnect --version: ${said(version)}`);
  const help = await konnect(lead, ['help'], { env: { KONNECT_CONFIG_DIR: `${lead.home}/none` } });
  const k = surfaceOf(`${help.out}${help.err}`);
  check(k, `konnect ${version.out.trim()}'s help lists none of the command sets this test knows: add it to surfaceOf\n${said(help)}`);
  step(`konnect ${version.out.trim()}: ${k.name}`);

  step(`starting a local Kolab (stub identity) in ${h.tmp}`);
  await h.startKolab();
  for (const who of Object.values(PEOPLE)) await say(`account ${who.subject} ${who.login}`);
  step(`Kolab at ${h.url}`);

  step(`1. lead creates team ${TEAM}, invites peer, and peer joins`);
  const made = await k.create(lead, PEOPLE.lead);
  check(k.created(made), `lead creating the team said: ${said(made)}`);
  const invited = await k.invite(lead, 'peer');
  check(k.invited(invited, 'peer'), `lead inviting peer: ${said(invited)}`);
  const joined = await k.join(peer, PEOPLE.peer);
  check(k.joined(joined), `peer joining: ${said(joined)}`);

  step('2. both talk in #general; status shows the unread; the members are listed');
  const hello = await k.send(peer, '#general', 'hello from peer');
  check(k.sent(hello), `peer's send: ${said(hello)}`);
  const waits = await k.status(lead);
  check(k.unread(waits), `lead's status: ${said(waits)}`);
  const leadGot = await k.receive(lead, '#general');
  check(leadGot.code === 0 && /@peer/.test(leadGot.out) && leadGot.out.includes('hello from peer'), `lead's receive: ${said(leadGot)}`);
  const reply = await k.send(lead, '#general', 'welcome, peer');
  check(k.sent(reply), `lead's send: ${said(reply)}`);
  const peerGot = await k.receive(peer, '#general');
  check(peerGot.code === 0 && /@lead/.test(peerGot.out) && peerGot.out.includes('welcome, peer'), `peer's receive: ${said(peerGot)}`);
  const members = await k.members(lead);
  check(k.listed(members), `lead's list of members: ${said(members)}`);

  step('3. a direct message to someone who isn\'t in the team: konnect says so (Kolab\'s "is not a member of kolab")');
  const stranger = await k.send(lead, '@third', 'are you there?');
  check(stranger.code !== 0 && (k.refused === null || stranger.code === k.refused) && stranger.err.includes(`@third isn't in team ${TEAM}`),
    `a message to @third, who isn't in the team: konnect didn't say "@third isn't in team ${TEAM}": ${said(stranger)}`);

  step('4. an owner\'s action by someone who isn\'t the owner: konnect says only the owner can (Kolab\'s "only the owner of kolab")');
  const notOwner = await k.invite(peer, 'third');
  check(notOwner.code !== 0 && (k.refused === null || notOwner.code === k.refused) && notOwner.err.includes(`only team ${TEAM}'s owner can do that`),
    `peer inviting third: konnect didn't say "only team ${TEAM}'s owner can do that": ${said(notOwner)}`);

  step('5. a revoked login: konnect says it has ended or was revoked, and to log in again');
  // peer's machine as it is now, then konnect logout (which revokes the login on Kolab), then the
  // machine put back as it was: konnect has the revoked login, as if it were revoked elsewhere.
  const kept = `${h.tmp}/peer-before-logout`;
  cpSync(peer.home, kept, { recursive: true });
  const out = await konnect(peer, ['logout']);
  check(out.code === 0, `peer's logout: ${said(out)}`);
  rmSync(peer.home, { recursive: true, force: true });
  cpSync(kept, peer.home, { recursive: true });
  const revoked = await k.afterRevoked(peer);
  check(revoked.code !== 0 && (k.signIn === null || revoked.code === k.signIn) && /has ended or was revoked/.test(revoked.err) && revoked.err.includes(k.relogin),
    `peer, with a revoked login: konnect didn't say it has ended or was revoked and to ${k.relogin}: ${said(revoked)}`);

  step('6. Kolab logged each konnect that connected, by name');
  const clients = logged.filter((l) => l.event === 'mcp_client');
  const v = version.out.trim();
  const says = atLeast(SAID_0_1_0_UNTIL, v) ? '0.1.0' : v;
  check(clients.some((l) => l.client_name === 'konnect' && l.client_version === says), `Kolab logged no mcp_client line for konnect ${says}: ${JSON.stringify(clients)}`);
  step(`  ${[...new Set(clients.map((l) => `${l.client_name} ${l.client_version}`))].join(', ')}`);
  step('passed');
}

h.main('konnect compat', main);
