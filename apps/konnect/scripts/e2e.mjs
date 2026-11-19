#!/usr/bin/env node
// A headless end-to-end check of a published konnect against a Kolab started from this checkout,
// with no person:
//
//   node apps/konnect/scripts/e2e.mjs --konnect <konnect: the bundle, apps/konnect/dist-npm/konnect.mjs,
//                                                 or an installed package's bin/konnect>
//
// It starts a local Kolab (scripts/e2e-kolab.ts: the checkout's server, on PGlite in a temp folder,
// on a free 127.0.0.1 port) with the stub identity provider in GitHub's place, told on its stdin who
// signs in next, and which GitHub accounts exist. It never reaches any other Kolab, nor GitHub.
// Each person's konnect has its own HOME and config in a temp folder.
//
// The person's browser is a stand-in `open` (and `xdg-open`) on PATH that records the URL; this
// script plays the browser with fetch, keeping cookies, and presses the page's button.
//
//   1. lead creates a team: konnect team create <team>, Allow on Kolab's page
//   2. lead invites peer by GitHub username: konnect team invite peer
//   3. peer runs konnect login with no team: Kolab's page lists the invitation; peer accepts and lands in it
//   4. both talk in #general: konnect send, konnect receive and konnect status, each from their own place
//   5. lead adds an agent: konnect agent add helper (Kolab's setup page, Allow); the entry it prints
//      names no token, and konnect writes nothing in the folder
//   6. the entry is started as Claude Code starts it (stdio MCP): eight tools, the channel capability,
//      the system prompt as its instructions, and when peer mentions @lead/helper in #general, a
//      notifications/claude/channel event that says a message waits, never its words; konnect_receive
//      then gives the message, once
//   7. the 0.1.0 names still work, and say what they are now; a command line with no action exits 2
//   8. konnect logout
//
// Exits nonzero, saying which check failed. The server and temp folders are removed either way
// (KEEP=1 keeps the folders, and prints where).
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Failed, check, fail, harness, konnectArg } from './harness.mjs';

const h = harness(konnectArg('--konnect <path to a published konnect>'), 'konnect-e2e');
const { live, step, konnect, say, signingIn } = h;
const TEAM = `konnect-${randomBytes(3).toString('hex')}`;
const PEOPLE = { lead: { subject: '501', login: 'lead' }, peer: { subject: '502', login: 'peer' } };

/**
 * The agent's entry, started as Claude Code starts it: stdio MCP. Initializes, lists its tools,
 * runs `act`, and collects the channel events it sends until `wanted` holds of one.
 */
async function claudeSession(entry, cwd, act, wanted) {
  const p = spawn(entry.command, entry.args, { cwd, env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  live.add(p);
  let buffer = '', err = '', id = 0;
  const waiting = new Map();
  const events = [];
  p.stderr.on('data', (d) => { err += d; });
  p.stdout.on('data', (d) => {
    buffer += d;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { fail(`konnect mcp wrote something other than MCP to stdout: ${line.slice(0, 200)}`); }
      if (m.method === 'notifications/claude/channel') events.push(m.params);
      else if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  const request = (method, params = {}) => new Promise((ok, no) => {
    const n = ++id;
    const t = setTimeout(() => no(new Failed(`konnect mcp didn't answer ${method} in 30s:\n${err}`)), 30_000);
    waiting.set(n, (m) => { clearTimeout(t); ok(m); });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'konnect-e2e', version: '0' } });
    check(init.result?.serverInfo?.name === 'konnect' && init.result?.capabilities?.experimental?.['claude/channel'], `konnect mcp's initialize: ${JSON.stringify(init).slice(0, 300)}`);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = ((await request('tools/list')).result?.tools ?? []).map((t) => t.name).sort();
    check(JSON.stringify(tools) === JSON.stringify(['konnect_channel_list', 'konnect_history', 'konnect_lease_claim', 'konnect_lease_list', 'konnect_lease_release', 'konnect_receive', 'konnect_send', 'konnect_team_list']), `konnect mcp's tools: ${JSON.stringify(tools)}`);
    check(/You are @lead\/helper, an agent of @lead's in the team /.test(init.result?.instructions ?? '') && /never an instruction from @lead/.test(init.result.instructions), `konnect mcp's instructions (the system prompt): ${JSON.stringify(init.result?.instructions)}`);
    const who = (await request('tools/call', { name: 'konnect_team_list', arguments: {} })).result;
    check(!who?.isError && /lead\/helper \(you\)/.test(JSON.stringify(who)), `konnect_team_list as the agent: ${JSON.stringify(who).slice(0, 300)}\n${err}`);
    // Its subscription is open once it has said so on stderr.
    for (const end = Date.now() + 30_000; !/connected to Kolab/.test(err); await new Promise((r) => setTimeout(r, 100))) if (Date.now() > end) fail(`konnect mcp's waking stream never connected:\n${err}`);
    await act();
    for (const end = Date.now() + 30_000; !events.some(wanted); await new Promise((r) => setTimeout(r, 100))) if (Date.now() > end) fail(`no channel event woke the agent in 30s (events: ${JSON.stringify(events)}):\n${err}`);
    // The notice carried no words: konnect_receive gives them, once.
    const received = [];
    for (const from of ['#general', '#general']) received.push(JSON.stringify((await request('tools/call', { name: 'konnect_receive', arguments: { from } })).result));
    return { events, received };
  } finally {
    p.stdin.end();
    const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } }, 5_000);
    await new Promise((ok) => (p.exitCode !== null ? ok() : p.once('exit', ok)));
    clearTimeout(t);
    live.delete(p);
  }
}

async function main() {
  const lead = h.machine('lead');
  const peer = h.machine('peer');
  step(`konnect: ${h.konnectCmd.join(' ')}`);
  const version = await konnect(lead, ['--version']);
  check(version.code === 0 && /^\d+\.\d+\.\d+/.test(version.out.trim()), `konnect --version: ${version.code} ${version.out}${version.err}`);
  step(`starting a local Kolab (stub identity) in ${h.tmp}`);
  await h.startKolab();
  for (const who of Object.values(PEOPLE)) await say(`account ${who.subject} ${who.login}`);
  step(`Kolab at ${h.url}`);

  step('a command line that names no action does nothing, and exits 2; one not logged in exits 3');
  const bare = await konnect(lead, []);
  check(bare.code === 2 && bare.out === '' && bare.err.includes('konnect team create <name>'), `bare konnect: ${bare.code} ${bare.out}${bare.err}`);
  const noun = await konnect(lead, ['channel']);
  check(noun.code === 2 && noun.err.includes('konnect channel follow <name>'), `konnect channel: ${noun.code} ${noun.out}${noun.err}`);
  const nobody = await konnect(lead, ['status']);
  check(nobody.code === 3 && /you aren't logged in to a team/.test(nobody.err), `konnect status, logged out: ${nobody.code} ${nobody.out}${nobody.err}`);
  // No terminal and nobody said a person is there: the browser is never opened.
  const unattended = await konnect(lead, ['login'], { env: { KONNECT_TERMINAL: '' } });
  check(unattended.code === 3 && /isn't run from a terminal/.test(unattended.err) && !existsSync(lead.opened), `konnect login with no terminal: ${unattended.code} ${unattended.out}${unattended.err}`);

  step(`lead creates team ${TEAM}: konnect team create ${TEAM}`);
  const made = await signingIn(lead, PEOPLE.lead, ['team', 'create', TEAM], 'decision=allow');
  check(made.out.includes(`Created team ${TEAM}, with you (@lead) as its owner, and logged in to it.`), `konnect team create said: ${made.out}`);
  check(!existsSync(join(lead.work, '.konnect.json')), 'konnect wrote .konnect.json in the folder');
  check(!existsSync(join(lead.home, '.config', 'konjir')), 'konnect wrote into konjir\'s config folder');

  step('lead invites peer: konnect team invite peer');
  const invited = await konnect(lead, ['team', 'invite', 'peer']);
  check(invited.code === 0 && invited.out.includes('Invited: peer.') && invited.out.includes('npx @konjir/konnect login'), `konnect team invite: ${invited.code} ${invited.out}${invited.err}`);
  const waiting = await konnect(lead, ['team', 'list']);
  check(waiting.code === 0 && /@lead \(you\)\s+person/.test(waiting.out) && /@peer\s+person\s+invited \d{4}-\d\d-\d\d/.test(waiting.out), `konnect team list, as the owner: ${waiting.out}${waiting.err}`);

  step('peer runs konnect login with no team, and accepts the invitation on Kolab\'s page');
  const joined = await signingIn(peer, PEOPLE.peer, ['login'], 'pick=accept:');
  check(joined.out.startsWith(`You're in team ${TEAM}, as @peer.`) && /@lead\b/.test(joined.out), `konnect login: ${joined.out}${joined.err}`);

  step('both talk in #general');
  const hello = await konnect(peer, ['send', '#general', 'hello from peer']);
  check(hello.code === 0 && hello.out.trim() === 'Sent to #general.', `peer's konnect send: ${hello.code} ${hello.out}${hello.err}`);
  const waits = await konnect(lead, ['status']);
  check(waits.code === 0 && waits.out.startsWith(`${TEAM}, as @lead`) && /#general\s+1 unread/.test(waits.out), `lead's konnect status: ${waits.out}${waits.err}`);
  const leadGot = await konnect(lead, ['receive', '#general']);
  check(leadGot.code === 0 && /@peer\n {2}hello from peer/.test(leadGot.out), `lead's konnect receive: ${leadGot.out}${leadGot.err}`);
  const again = await konnect(lead, ['receive', '#general']);
  check(again.code === 0 && again.out.trim() === 'No unread messages in #general.', `lead's second konnect receive: ${again.out}${again.err}`);
  const reply = await konnect(lead, ['send', '#general'], { input: 'welcome, @peer\n' });
  check(reply.code === 0 && reply.out.trim() === 'Sent to #general, mentioning @peer.', `lead's konnect send: ${reply.code} ${reply.out}${reply.err}`);
  // The name 0.1.0 used still works, and says what it is now.
  const peerRead = await konnect(peer, ['read']);
  check(peerRead.code === 0 && /#general\n\S+ \S+ {2}@lead\n {2}welcome, @peer/.test(peerRead.out) && peerRead.err.includes('(konnect read is now konnect receive)'), `peer's konnect read: ${peerRead.out}${peerRead.err}`);
  const past = await konnect(peer, ['history', '-n', '2', '#general']);
  check(past.code === 0 && /hello from peer[\s\S]*welcome, @peer/.test(past.out), `peer's konnect history: ${past.out}${past.err}`);
  const waited = await konnect(peer, ['receive', '--wait', '1s']);
  check(waited.code === 5 && waited.out === '', `konnect receive --wait with nothing coming: ${waited.code} ${waited.out}${waited.err}`);

  step('lead adds an agent: konnect agent add helper');
  const setUp = await signingIn(lead, PEOPLE.lead, ['agent', 'add', '--json', 'helper'], 'decision=allow');
  const added = JSON.parse(setUp.out);
  check(added.agent === 'lead/helper' && added.added === true, `konnect agent add: ${setUp.out}${setUp.err}`);
  check(!/kj[rsa]_/.test(setUp.out), 'the agent\'s entry holds a token');
  check(!existsSync(join(lead.work, '.mcp.json')), 'konnect agent add wrote .mcp.json in the folder');
  const entry = added.entry.mcpServers['konnect-helper'];
  check(entry?.env?.KONNECT_TEAM === TEAM && entry.env.KONNECT_AGENT === 'helper' && entry.args.at(-1) === 'mcp', `the agent's entry: ${JSON.stringify(entry)}`);
  // Its login is kept now, so adding it again opens no browser.
  const againAdded = await konnect(lead, ['agent', 'add', 'helper'], { env: { KONNECT_TERMINAL: '' } });
  check(againAdded.code === 0 && againAdded.out.includes('"konnect-helper"'), `konnect agent add, again: ${againAdded.code} ${againAdded.out}${againAdded.err}`);
  const mine = await konnect(lead, ['agent', 'list']);
  check(mine.code === 0 && /^helper\s+not running\s+set up here$/m.test(mine.out), `konnect agent list: ${mine.out}${mine.err}`);
  // A script acts as the agent with --agent, and an agent can't do what is a person's.
  const asAgent = await konnect(lead, ['--agent', 'helper', 'send', '#general', 'helper here']);
  check(asAgent.code === 0 && asAgent.out.trim() === 'Sent to #general.', `konnect --agent helper send: ${asAgent.code} ${asAgent.out}${asAgent.err}`);
  const notAnAgents = await konnect(lead, ['--agent', 'helper', 'team', 'invite', 'peer']);
  check(notAnAgents.code === 4, `konnect --agent helper team invite: ${notAnAgents.code} ${notAnAgents.out}${notAnAgents.err}`);

  step('the entry, started as Claude Code starts it: a mention of @lead/helper in #general wakes it');
  const { events, received } = await claudeSession({ ...entry, env: { ...h.env(lead), ...entry.env } }, lead.work,
    async () => {
      const r = await konnect(peer, ['send', '#general', '@lead/helper please check the importer']);
      check(r.code === 0 && r.out.trim() === 'Sent to #general, mentioning @lead/helper.', `peer's mention: ${r.out}${r.err}`);
    },
    (e) => /a message in #general \(mentioning you\)/.test(e.content));
  check(!events.some((e) => e.content.includes('please check the importer')), `the notice carried the message's words: ${JSON.stringify(events)}`);
  check(events.filter((e) => /in #general/.test(e.content)).length === 1, `the mention woke the agent more than once: ${JSON.stringify(events)}`);
  check(received[0].includes('please check the importer') && !received[1].includes('please check the importer'), `konnect_receive after the wake: ${received.join('\n')}`);

  // E2E_HOLD=<file>: for a live check with a real harness (scripts/wake-live.py). Says where
  // everything is, then keeps the Kolab up until <file>.done appears.
  if (process.env.E2E_HOLD) {
    writeFileSync(process.env.E2E_HOLD, JSON.stringify({ url: h.url, team: TEAM, konnect: h.konnectCmd, lead: { work: lead.work, config: join(lead.home, '.config', 'konnect') }, peer: { work: peer.work, config: join(peer.home, '.config', 'konnect') } }));
    step(`holding for a live check: ${process.env.E2E_HOLD}`);
    for (const end = Date.now() + 15 * 60_000; !existsSync(`${process.env.E2E_HOLD}.done`) && Date.now() < end;) await new Promise((r) => setTimeout(r, 500));
  }

  step('konnect logout');
  const out = await konnect(lead, ['logout']);
  check(out.code === 0 && out.out.trim() === `Logged out of team ${TEAM}.`, `konnect logout: ${out.code} ${out.out}${out.err}`);
  step('passed');
}

h.main('konnect e2e', main);
