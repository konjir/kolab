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
//   1. lead makes a team: konnect team <team>, Allow on Kolab's page
//   2. lead recruits peer by GitHub username: konnect recruit peer
//   3. peer runs konnect with no team: Kolab's page lists the invitation; peer accepts and lands in it
//   4. both talk in #general: konnect send and konnect read, each from their own position
//   5. lead sets up an agent: konnect claude helper --no-start (Kolab's setup page, Allow); its
//      .mcp.json entry names no token
//   6. the entry is started as Claude Code starts it (stdio MCP): four tools, the channel capability,
//      and when peer mentions @lead/helper in #general, a notifications/claude/channel event
//   7. konnect logout
//
// Exits nonzero, saying which check failed. The server and temp folders are removed either way
// (KEEP=1 keeps the folders, and prints where).
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const given = process.argv.indexOf('--konnect');
if (given < 0 || !process.argv[given + 1]) { console.error('--konnect <path to a published konnect>'); process.exit(2); }
const KONNECT = resolve(process.argv[given + 1]);
/** How konnect is run: a .mjs through node, anything else as it is. */
const konnectCmd = KONNECT.endsWith('.mjs') ? [process.execPath, KONNECT] : [KONNECT];
const TEAM = `konnect-${randomBytes(3).toString('hex')}`;
const PEOPLE = { lead: { subject: '501', login: 'lead' }, peer: { subject: '502', login: 'peer' } };
const started = Date.now();
const tmp = mkdtempSync(join(tmpdir(), 'konnect-e2e-'));
const bin = join(tmp, 'bin');
let server;
const live = new Set();

const step = (s) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${s}`);
class Failed extends Error {}
const fail = (why) => { throw new Failed(why); };
const check = (ok, why) => { if (!ok) fail(why); };

async function cleanup() {
  const running = [...live, server].filter((p) => p && p.exitCode === null && p.signalCode === null);
  const kill = (p, sig) => { try { process.kill(-p.pid, sig); } catch { /* gone */ } };
  await Promise.all(running.map((p) => new Promise((ok) => {
    const t = setTimeout(() => { kill(p, 'SIGKILL'); ok(); }, 5_000);
    p.once('exit', () => { clearTimeout(t); ok(); });
    kill(p, 'SIGTERM');
  })));
  if (process.env.KEEP) { console.error(`kept ${tmp}`); return; }
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.error(`couldn't remove ${tmp}: ${e.message}`); }
}
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(sig, () => { void cleanup().finally(() => process.exit(code)); });

/** One person's machine: a HOME, config, work folder and record of what the browser was sent to. */
function machine(name) {
  const home = join(tmp, name);
  const m = { name, home, work: join(home, 'work'), opened: join(home, 'opened.txt') };
  mkdirSync(m.work, { recursive: true });
  return m;
}

/** The environment a person's commands run in: their temp HOME and config, and no KONJIR_* or KONNECT_* of the runner's. */
function env(m, extra = {}) {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KONJIR_') && !k.startsWith('KONNECT_')));
  return { ...e, HOME: m.home, XDG_CONFIG_HOME: join(m.home, '.config'), PATH: `${bin}:${process.env.PATH}`, OPENED: m.opened, KONNECT_URL: MCP, ...extra };
}

/** Runs a command to its end: its exit code, stdout and stderr. */
function run(cmd, args, opts = {}, timeoutMs = 90_000) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { ...opts, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
    live.add(p);
    if (opts.input !== undefined) p.stdin.end(opts.input);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } err += `\n(killed after ${timeoutMs / 1000}s)`; }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); live.delete(p); ok({ code, out, err }); });
  });
}

let MCP;
const konnect = (m, args, opts = {}) => run(konnectCmd[0], [...konnectCmd.slice(1), ...args], { cwd: m.work, ...opts, env: env(m, opts.env) });

/** Tells the stub identity provider something (`next <subject> <login>`, `account …`), and waits for its ok. */
let say;
async function startKolab() {
  server = spawn('npx', ['tsx', '--conditions=@konjir/source', join(ROOT, 'apps/konnect/scripts/e2e-kolab.ts'), join(tmp, 'data')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let log = '', buffer = '';
  const waiting = [];
  server.stderr.on('data', (d) => { log += d; });
  const url = new Promise((ok, no) => {
    const t = setTimeout(() => no(new Failed(`Kolab didn't start in 90s:\n${log}`)), 90_000);
    server.stdout.on('data', (d) => {
      buffer += d;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line.startsWith('{')) { clearTimeout(t); ok(JSON.parse(line).url); } else if (line === 'ok') waiting.shift()?.();
        else log += `${line}\n`;
      }
    });
    server.on('exit', (code) => { clearTimeout(t); no(new Failed(`Kolab exited (${code}) before listening:\n${log}`)); });
  });
  say = (line) => new Promise((ok) => { waiting.push(ok); server.stdin.write(`${line}\n`); });
  return url;
}

async function waitOpened(m, timeoutMs = 60_000) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await new Promise((r) => setTimeout(r, 100))) {
    if (existsSync(m.opened)) { const u = readFileSync(m.opened, 'utf8').trim().split('\n').pop(); if (u) { rmSync(m.opened); return new URL(u); } }
  }
  fail(`${m.name}'s konnect opened no browser within 60s`);
}

/** The person's browser: from the URL konnect opened, follows Kolab's redirects with its cookies to its page, presses the button `prefix` names, and follows Kolab's answer to konnect's loopback listener. */
async function browser(start, prefix) {
  check(start.origin === new URL(MCP).origin && start.pathname === '/oauth/authorize', `konnect opened ${start}, not this Kolab's /oauth/authorize`);
  const jar = new Map();
  const go = async (url, init = {}) => {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  };
  let url = start;
  let res = await go(url);
  for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
    check(hops < 10, 'more than 10 redirects before Kolab\'s page');
    url = new URL(res.headers.get('location'), url);
    res = await go(url);
  }
  const html = await res.text();
  const field = (name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  const button = [...html.matchAll(/<button[^>]*name="([^"]+)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]).find(([n, v]) => `${n}=${v}`.startsWith(prefix));
  check(res.status === 200 && field('csrf') && button, `no ${prefix} button on Kolab's page at ${url.pathname}: ${res.status} ${html.slice(0, 400)}`);
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sign_in: field('sign_in') ?? '', csrf: field('csrf'), ...(field('shown') ? { shown: field('shown') } : {}), [button[0]]: button[1] }).toString(),
  });
  check(done.status === 303, `Kolab refused the page's ${prefix}: ${done.status} ${(await done.text()).slice(0, 400)}`);
  await (await fetch(new URL(done.headers.get('location')))).text();
  return html;
}

/** A konnect command that signs in through the browser: who signs in, and which button to press. */
async function signingIn(m, who, args, prefix) {
  await say(`next ${who.subject} ${who.login}`);
  const ran = konnect(m, args);
  const browsing = waitOpened(m).then((u) => browser(u, prefix));
  await Promise.race([browsing, ran.then((r) => (existsSync(m.opened) ? browsing : fail(`konnect ${args.join(' ')} ended (${r.code}) before opening a browser:\n${r.out}${r.err}`)))]);
  const r = await ran;
  check(r.code === 0, `konnect ${args.join(' ')} exited ${r.code}:\n${r.out}${r.err}`);
  return r;
}

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
    check(JSON.stringify(tools) === JSON.stringify(['konnect_channels', 'konnect_read', 'konnect_send', 'konnect_who']), `konnect mcp's tools: ${JSON.stringify(tools)}`);
    const who = (await request('tools/call', { name: 'konnect_who', arguments: {} })).result;
    check(!who?.isError && /lead\/helper \(you\)/.test(JSON.stringify(who)), `konnect_who as the agent: ${JSON.stringify(who).slice(0, 300)}\n${err}`);
    // Its subscription is open once it has said so on stderr.
    for (const end = Date.now() + 30_000; !/connected to Kolab/.test(err); await new Promise((r) => setTimeout(r, 100))) if (Date.now() > end) fail(`konnect mcp's waking stream never connected:\n${err}`);
    await act();
    for (const end = Date.now() + 30_000; !events.some(wanted); await new Promise((r) => setTimeout(r, 100))) if (Date.now() > end) fail(`no channel event woke the agent in 30s (events: ${JSON.stringify(events)}):\n${err}`);
    return events;
  } finally {
    p.stdin.end();
    const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } }, 5_000);
    await new Promise((ok) => (p.exitCode !== null ? ok() : p.once('exit', ok)));
    clearTimeout(t);
    live.delete(p);
  }
}

async function main() {
  mkdirSync(bin);
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$OPENED"\n');
    chmodSync(join(bin, name), 0o755);
  }
  const lead = machine('lead');
  const peer = machine('peer');
  step(`konnect: ${konnectCmd.join(' ')}`);
  MCP = 'http://127.0.0.1:9/mcp';
  const version = await konnect(lead, ['--version']);
  check(version.code === 0 && /^\d+\.\d+\.\d+/.test(version.out.trim()), `konnect --version: ${version.code} ${version.out}${version.err}`);
  step(`starting a local Kolab (stub identity) in ${tmp}`);
  MCP = await startKolab();
  for (const who of Object.values(PEOPLE)) await say(`account ${who.subject} ${who.login}`);
  step(`Kolab at ${MCP}`);

  step(`lead makes team ${TEAM}: konnect team ${TEAM}`);
  const made = await signingIn(lead, PEOPLE.lead, ['team', TEAM], 'decision=allow');
  check(made.out.includes(`Signed in to team ${TEAM} as lead.`), `konnect team said: ${made.out}`);
  check(JSON.parse(readFileSync(join(lead.work, '.konnect.json'), 'utf8')).team === TEAM, '.konnect.json doesn\'t name the team');
  check(!existsSync(join(lead.home, '.config', 'konjir')), 'konnect wrote into konjir\'s config folder');

  step('lead recruits peer: konnect recruit peer');
  const recruited = await konnect(lead, ['recruit', 'peer']);
  check(recruited.code === 0 && recruited.out.includes('Invited: peer.') && recruited.out.includes('npx @konjir/konnect'), `konnect recruit: ${recruited.code} ${recruited.out}${recruited.err}`);

  step('peer runs konnect with no team, and accepts the invitation on Kolab\'s page');
  const joined = await signingIn(peer, PEOPLE.peer, [], 'pick=accept:');
  check(joined.out.startsWith(`You're in team ${TEAM}, as peer.`) && /\blead\b/.test(joined.out), `konnect (joining): ${joined.out}${joined.err}`);

  step('both talk in #general');
  const hello = await konnect(peer, ['send', '#general', 'hello from peer']);
  check(hello.code === 0 && hello.out.trim() === 'Sent to #general.', `peer's konnect send: ${hello.code} ${hello.out}${hello.err}`);
  const leadRead = await konnect(lead, ['read', '#general']);
  check(leadRead.code === 0 && /@peer\n {2}hello from peer/.test(leadRead.out), `lead's konnect read: ${leadRead.out}${leadRead.err}`);
  const reply = await konnect(lead, ['send', '#general'], { input: 'welcome, @peer\n' });
  check(reply.code === 0 && reply.out.trim() === 'Sent to #general, mentioning @peer.', `lead's konnect send: ${reply.code} ${reply.out}${reply.err}`);
  const peerRead = await konnect(peer, ['read']);
  check(peerRead.code === 0 && /#general\n\S+ \S+ {2}@lead\n {2}welcome, @peer/.test(peerRead.out), `peer's konnect read: ${peerRead.out}${peerRead.err}`);

  step('lead sets up an agent: konnect claude helper --no-start');
  const setUp = await signingIn(lead, PEOPLE.lead, ['claude', 'helper', '--no-start'], 'decision=allow');
  check(/Your agent lead\/helper is made and signed in/.test(setUp.out) && setUp.out.includes('Start it with: claude --dangerously-load-development-channels server:konnect-helper'), `konnect claude --no-start: ${setUp.out}${setUp.err}`);
  const mcpJson = readFileSync(join(lead.work, '.mcp.json'), 'utf8');
  check(!/kj[rsa]_/.test(mcpJson), '.mcp.json holds a token');
  const entry = JSON.parse(mcpJson).mcpServers['konnect-helper'];
  check(entry?.env?.KONNECT_TEAM === TEAM && entry.env.KONNECT_AGENT === 'helper' && entry.args.at(-1) === 'mcp', `the .mcp.json entry: ${JSON.stringify(entry)}`);

  step('the entry, started as Claude Code starts it: a mention of @lead/helper in #general wakes it');
  const events = await claudeSession({ ...entry, env: { ...env(lead), ...entry.env } }, lead.work,
    async () => {
      const r = await konnect(peer, ['send', '#general', '@lead/helper please check the importer']);
      check(r.code === 0 && r.out.trim() === 'Sent to #general, mentioning @lead/helper.', `peer's mention: ${r.out}${r.err}`);
    },
    (e) => /@peer in #general, mentioning you/.test(e.content) && e.content.includes('please check the importer'));
  check(events.filter((e) => /please check the importer/.test(e.content)).length === 1, `the mention woke the agent more than once: ${JSON.stringify(events)}`);

  step('konnect logout');
  const out = await konnect(lead, ['logout']);
  check(out.code === 0 && out.out.trim() === `Signed out of team ${TEAM}.`, `konnect logout: ${out.code} ${out.out}${out.err}`);
  step('passed');
}

main().then(() => 0, (e) => {
  console.error(`konnect e2e FAILED: ${e instanceof Failed ? e.message : e?.stack ?? e}`);
  return 1;
}).then(async (code) => { await cleanup(); process.exit(code); });
