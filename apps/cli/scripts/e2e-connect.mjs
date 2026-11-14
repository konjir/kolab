#!/usr/bin/env node
// A headless end-to-end check of `konjir connect claude` (one page, D105), with no person: so a
// change to setup or consent is tested in minutes, by an agent as well as by hand.
//
//   npm run e2e:connect        (or: node apps/cli/scripts/e2e-connect.mjs)
//   node apps/cli/scripts/e2e-connect.mjs --konjir <a published konjir: a binary, or an installed package's bin/konjir>
//
// With --konjir, that konjir connects, and its entries must run the bridge it carries, `konjir
// bridge` (W9.5, API29); without, the checkout's bin/konjir, whose entries run the checkout's own.
// Kolab itself always runs from this checkout.
//
// It starts a local Kolab from this checkout (`bin/konjir serve`, on PGlite in a temp folder, on a
// free 127.0.0.1 port) with the stub identity (KONJIR_STUB_IDENTITY), so whoever opens Kolab's
// sign-in is signed in with no GitHub. It never reaches any other Kolab. Everything konjir writes
// lands in a temp folder: a throwaway git repository, and a temp HOME and XDG_CONFIG_HOME, so the
// real ~/.config/konjir is never read or touched.
//
// The person's browser is a stand-in `open` (and `xdg-open`) on PATH that records the URL; this
// script then plays the browser with fetch, keeping cookies: it follows Kolab's redirects to the
// setup page, submits its form as the person clicking Allow (or Deny, on a page that can't be
// allowed), and follows Kolab's answer to the CLI's loopback listener. The server sees what a
// browser sends: the same pages, cookies and POST /oauth/consent.
//
// Checks: connect exits 0; .mcp.json has a channel entry per agent; each agent's credentials file
// is there, mode 600, and `konjir whoami` with it names that agent, its role and the kolab; the
// same command again passes and leaves .mcp.json as it was; a session started on an entry, as
// Claude Code starts it (the entry's command, arguments and environment, MCP over stdio), lists
// Kolab's tools and is pushed a channel message when another agent messages its agent; and an agent cap refusal (2 live
// agents + 9 new > 10) shows on the page, with Deny alone, and in the CLI, writing nothing.
// Exits nonzero, saying which check failed. The server and temp folders are removed either way
// (KEEP=1 keeps the folders, and prints where).
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHECKOUT = join(ROOT, 'bin', 'konjir');
const given = process.argv.indexOf('--konjir');
if (given >= 0 && !process.argv[given + 1]) { console.error('--konjir <path to a published konjir>'); process.exit(2); }
/** The konjir that connects: a published one when --konjir names it, else the checkout's. */
const KONJIR = given >= 0 ? resolve(process.argv[given + 1]) : CHECKOUT;
const PUBLISHED = given >= 0;
const LOGIN = 'e2e';
const started = Date.now();
const rand = Math.random().toString(36).slice(2, 8);
const KOLAB = `e2e-${rand}`;
const tmp = mkdtempSync(join(tmpdir(), 'konjir-e2e-connect-'));
const home = join(tmp, 'home');
const xdg = join(home, '.config');
const bin = join(tmp, 'bin');
const opened = join(tmp, 'opened.txt');
let server;
/** Every command run() has started and not yet seen end, each in its own process group. */
const live = new Set();

const step = (s) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${s}`);
class Failed extends Error {}
const fail = (why) => { throw new Failed(why); };
const check = (ok, why) => { if (!ok) fail(why); };

/** Stops the server and every command still running (their whole groups), waits for them, then removes the temp folder. */
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

/** A free port on 127.0.0.1. */
const freePort = () => new Promise((ok, no) => {
  const s = createServer().once('error', no).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

/**
 * The environment every command here runs in: the temp HOME, config and Claude config, and no
 * KONJIR_* of the person's, only those `extra` names.
 */
function env(extra = {}) {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KONJIR_')));
  return { ...e, HOME: home, XDG_CONFIG_HOME: xdg, CLAUDE_CONFIG_DIR: join(home, '.claude'), PATH: `${bin}:${process.env.PATH}`, ...extra };
}

/** Runs a command to its end: its exit code, stdout and stderr. */
function run(cmd, args, opts = {}, timeoutMs = 90_000) {
  return new Promise((ok) => {
    // Its own process group, so cleanup stops it and whatever it starts.
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    live.add(p);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } err += `\n(killed after ${timeoutMs / 1000}s)`; }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); live.delete(p); ok({ code, out, err }); });
  });
}

class PortTaken extends Failed {}

/** A local Kolab on a free port, tried again if another process takes the port first. */
async function startKolab() {
  for (let attempt = 1; ; attempt++) {
    try { return await startKolabOnce(); } catch (e) {
      if (!(e instanceof PortTaken) || attempt === 3) throw e;
      step('the port was taken before Kolab bound it; trying another');
    }
  }
}

async function startKolabOnce() {
  const port = await freePort();
  // Its own process group, so cleanup stops tsx and the node it starts.
  server = spawn(CHECKOUT, ['serve', '--port', String(port), '--data', join(tmp, 'data'), '--admin-token', 'off'], {
    cwd: tmp, env: env({ KONJIR_STUB_IDENTITY: LOGIN }), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let log = '';
  return await new Promise((ok, no) => {
    const t = setTimeout(() => no(new Failed(`Kolab didn't start in 60s:\n${log}`)), 60_000);
    const seen = (d) => {
      log += d;
      const m = /"event":"listening".*?"url":"([^"]+)"/.exec(log);
      if (m) { clearTimeout(t); ok(m[1].endsWith('/mcp') ? m[1] : `${m[1].replace(/\/$/, '')}/mcp`); }
    };
    server.stdout.on('data', seen);
    server.stderr.on('data', seen);
    server.on('exit', (code) => { clearTimeout(t); no(new (/EADDRINUSE/.test(log) ? PortTaken : Failed)(`Kolab exited (${code}) before listening:\n${log}`)); });
  });
}

/** The URL the stand-in `open` was given, once it has been. */
async function waitOpened(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(opened)) { const u = readFileSync(opened, 'utf8').trim().split('\n').pop(); if (u) return new URL(u); }
    await new Promise((r) => setTimeout(r, 100));
  }
  fail('konjir connect opened no browser within 60s');
}

/**
 * The person's browser: from the URL konjir opened, follows Kolab's redirects with its cookies to
 * the setup page, then clicks Allow (Deny when the page offers nothing else), and follows Kolab's
 * answer to the CLI's loopback listener. Returns the page as it arrived.
 */
async function browser(start, mcp) {
  check(start.origin === new URL(mcp).origin && start.pathname === '/oauth/authorize', `konjir opened ${start}, not this Kolab's /oauth/authorize`);
  const jar = new Map();
  const go = async (url, init = {}) => {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  };
  let url = start;
  let res = await go(url);
  for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
    check(hops < 10, 'more than 10 redirects before the setup page');
    url = new URL(res.headers.get('location'), url);
    check(url.origin === start.origin, `the sign-in left Kolab for ${url.origin} before the setup page`);
    res = await go(url);
  }
  const html = await res.text();
  check(res.status === 200 && /<form[^>]+action="\/oauth\/consent"/.test(html), `no setup page at ${url.pathname}: ${res.status} ${html.slice(0, 400)}`);
  const field = (name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  const decision = html.includes('value="allow"') ? 'allow' : 'deny';
  const form = { sign_in: field('sign_in') ?? '', csrf: field('csrf') ?? '', ...(field('shown') ? { shown: field('shown') } : {}), decision };
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
  });
  check(done.status === 303, `Kolab refused the ${decision}: ${done.status} ${(await done.text()).slice(0, 400)}`);
  const back = new URL(done.headers.get('location'));
  check(back.hostname === '127.0.0.1', `Kolab sent the browser to ${back.origin}, not the CLI's loopback listener`);
  await (await fetch(back)).text();
  return html;
}

/** `konjir connect claude …` in `cwd`, with the browser played: its result and the setup page it showed. */
async function connect(cwd, mcp, agents) {
  rmSync(opened, { force: true });
  const args = ['connect', 'claude', '--url', mcp, '--kolab', KOLAB, ...agents.flatMap((a) => ['--agent', a])];
  const ran = run(KONJIR, args, { cwd, env: env() });
  // konjir may end as soon as the browser has its answer: a failure only if it ended before
  // opening the browser at all.
  const browsing = waitOpened().then((u) => browser(u, mcp));
  const page = await Promise.race([
    browsing,
    ran.then((r) => (existsSync(opened) ? browsing : fail(`konjir connect ended (${r.code}) before opening a browser:\n${r.out}${r.err}`))),
  ]);
  return { ...(await ran), page };
}

/**
 * A session on one entry, as Claude Code starts it: the entry's command with its arguments and
 * environment, speaking MCP over stdio as a client that takes channel messages. It must list
 * Kolab's tools, and be pushed a channel message once `nudge` has made its agent's inbox change.
 */
async function session(name, entry, cwd, nudge) {
  const p = spawn(entry.command, entry.args, { cwd, env: env(entry.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  live.add(p);
  // One that can't start, or dies while it is written to, fails the check rather than this script.
  let broke;
  p.on('error', (e) => { broke ??= e; });
  p.stdin.on('error', (e) => { broke ??= e; });
  let err = '', buffer = '', nextId = 1, garbled;
  const waiting = new Map();
  const channel = [];
  p.stderr.on('data', (d) => { err += d; });
  p.stdout.on('data', (d) => {
    buffer += d;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { garbled ??= line; continue; }
      if (m.method === 'notifications/claude/channel') channel.push(m.params);
      else if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  const ended = new Promise((ok) => { p.once('exit', (code) => { live.delete(p); ok(code); }); p.once('error', () => { live.delete(p); ok(null); }); });
  const send = (m) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const request = (method, params = {}) => new Promise((ok, no) => {
    const id = nextId++;
    const t = setTimeout(() => no(new Failed(`${name} didn't answer ${method} in 30s:\n${err.slice(-2000)}`)), 30_000);
    waiting.set(id, (m) => { clearTimeout(t); ok(m); });
    send({ id, method, params });
  });
  const until = async (what, done, timeoutMs = 45_000) => {
    for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
      if (broke || p.exitCode !== null) fail(`${name} ${broke ? `broke (${broke.message})` : `exited (${p.exitCode})`} before ${what}:\n${err.slice(-2000)}`);
      const v = await done();
      if (v) return v;
    }
    fail(`${name}: ${what} didn't happen in ${timeoutMs / 1000}s:\n${err.slice(-2000)}`);
  };
  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-connect', version: '0' } });
    check(init.result?.capabilities?.experimental?.['claude/channel'], `${name} doesn't offer the claude/channel capability: ${JSON.stringify(init).slice(0, 400)}`);
    send({ method: 'notifications/initialized' });
    // Kolab's tools arrive once the bridge has signed in with its agent's kept sign-in.
    const tools = await until('listing Kolab\'s tools', async () => {
      const names = ((await request('tools/list')).result?.tools ?? []).map((t) => t.name);
      return names.includes('konjir_instructions') && names.includes('konjir_send_message') ? names : undefined;
    });
    const who = await request('tools/call', { name: 'konjir_whoami', arguments: {} });
    check(JSON.stringify(who.result ?? {}).includes(entry.env.KONJIR_AGENT), `${name}'s konjir_whoami doesn't name ${entry.env.KONJIR_AGENT}: ${JSON.stringify(who).slice(0, 400)}`);
    const before = channel.length;
    await nudge();
    const pushed = await until('a channel message', async () => channel.slice(before).find((c) => typeof c?.content === 'string'));
    // Stdout is the protocol's alone.
    check(garbled === undefined, `${name} wrote something other than MCP to stdout: ${String(garbled).slice(0, 300)}`);
    return { tools: tools.length, pushed: pushed.content };
  } finally {
    p.stdin.end();
    const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } }, 5_000);
    await ended;
    clearTimeout(t);
  }
}

async function project(name) {
  const dir = join(tmp, name);
  mkdirSync(dir);
  const g = await run('git', ['init', '-q'], { cwd: dir, env: env() });
  check(g.code === 0, `git init failed: ${g.err}`);
  return dir;
}

async function main() {
  mkdirSync(xdg, { recursive: true });
  mkdirSync(bin);
  // The stand-in browser: records the URL, opens nothing.
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  step(`starting a local Kolab (stub identity: ${LOGIN}) in ${tmp}`);
  const mcp = await startKolab();
  step(`Kolab at ${mcp}; kolab ${KOLAB}`);
  const agents = [['writer', 'product'], ['builder', 'engineer']];
  const dir = await project('repo');

  step('konjir connect claude: writer:product, builder:engineer');
  const first = await connect(dir, mcp, agents.map(([l, r]) => `${l}:${r}`));
  check(first.code === 0, `konjir connect exited ${first.code}:\n${first.out}${first.err}`);
  check(first.page.includes(`Set up 2 agents in <code>${KOLAB}</code>`) && first.page.includes('New: made now, private, yours'), `the setup page didn't offer a new kolab ${KOLAB} with 2 agents:\n${first.page}`);
  const last = first.out.trim().split('\n').slice(-2);
  // `konjir claude <label>`, or for a konjir run from a package runner's cache, the copy it keeps, never npx.
  const runsAgain = (label) => new RegExp(`^(konjir|\\S+ \\S+konjir-[0-9.]+\\.mjs) claude ${label}$`);
  check(runsAgain('writer').test(last[0]) && runsAgain('builder').test(last[1]) && !/npx/.test(last.join(' ')), `connect's last lines aren't one konjir claude command per agent: ${last.join(' / ')}`);

  const mcpJson = join(dir, '.mcp.json');
  check(existsSync(mcpJson), '.mcp.json was not written');
  const written = readFileSync(mcpJson, 'utf8');
  const servers = JSON.parse(written).mcpServers ?? {};
  for (const [label, role] of agents) {
    const e = servers[`konjir-${label}`];
    const agent = `${LOGIN}-${label}`;
    check(e?.type === 'stdio' && Array.isArray(e.args), `.mcp.json has no channel entry konjir-${label}: ${JSON.stringify(e)}`);
    // A published konjir's entry runs the bridge it carries; a checkout's, the checkout's own.
    if (PUBLISHED) check(e.args.at(-1) === 'bridge' && !JSON.stringify(e).includes('start.sh'), `konjir-${label} doesn't run konjir bridge: ${JSON.stringify(e)}`);
    else check(e.command === join(ROOT, 'apps/channel-bridge/scripts/start.sh') && e.args.length === 0, `konjir-${label} doesn't run this checkout's bridge: ${JSON.stringify(e)}`);
    check(e.env?.KONJIR_URL === mcp && e.env.KONJIR_AGENT === agent && e.env.KONJIR_TOKEN === '', `konjir-${label}'s env is wrong: ${JSON.stringify(e.env)}`);
    check(e.env.KONJIR_SCOPE === `konjir kolab:${KOLAB} role:${role} agent:${agent}`, `konjir-${label}'s scope is ${e.env.KONJIR_SCOPE}`);
  }

  // No agent's token in .mcp.json: each is kept in its own credentials file only.
  const tokens = (v) => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => (/_token$/.test(k) && typeof x === 'string' ? [x] : tokens(x))) : []);
  for (const [label] of agents) {
    const kept = tokens(JSON.parse(readFileSync(join(xdg, 'konjir', 'agents', `${LOGIN}-${label}.json`), 'utf8')));
    check(kept.length >= 2, `${LOGIN}-${label}'s credentials file holds no access and refresh token`);
    check(kept.every((t) => !written.includes(t)), `.mcp.json holds a token of ${LOGIN}-${label}'s`);
  }

  const whoami = async (label, role) => {
    const file = join(xdg, 'konjir', 'agents', `${LOGIN}-${label}.json`);
    check(existsSync(file), `no credentials file for ${LOGIN}-${label} at ${file}`);
    const mode = statSync(file).mode & 0o777;
    check(mode === 0o600, `${file} is mode ${mode.toString(8)}, not 600`);
    const w = await run(KONJIR, ['whoami', '--url', mcp], { cwd: dir, env: env({ KONJIR_CREDENTIALS: file }) });
    check(w.code === 0, `whoami as ${LOGIN}-${label} exited ${w.code}:\n${w.out}${w.err}`);
    const me = JSON.parse(w.out);
    check(me.actor === `${LOGIN}-${label}` && me.kind === 'agent' && me.role === role && me.kolab === KOLAB, `whoami with ${LOGIN}-${label}'s file says ${JSON.stringify({ actor: me.actor, kind: me.kind, role: me.role, kolab: me.kolab })}`);
  };
  step('whoami through each agent\'s credentials file');
  for (const [label, role] of agents) await whoami(label, role);

  step('the same command again: passes, reuses the kolab and agents, .mcp.json unchanged');
  const again = await connect(dir, mcp, agents.map(([l, r]) => `${l}:${r}`));
  check(again.code === 0, `konjir connect, run again, exited ${again.code}:\n${again.out}${again.err}`);
  check(!again.page.includes('New: made now'), `the second setup page made something new:\n${again.page}`);
  check(readFileSync(mcpJson, 'utf8') === written, '.mcp.json changed on the second run');
  for (const [label, role] of agents) await whoami(label, role);

  step(`a session on konjir-builder, as Claude Code starts it (${[servers['konjir-builder'].command, ...servers['konjir-builder'].args].join(' ')})`);
  // A project that ships packages the bridge looks for as it starts: none of them is ever run. These
  // are the ones the reviews of #144 found a binary or the npm package loading from the folder
  // Claude Code starts it in; a published konjir resolves nothing as it runs (scripts/bundle.mjs).
  const ran = join(tmp, 'planted-ran.txt');
  for (const [pkg, file] of [['@nestjs/websockets', 'socket-module.js'], ['@nestjs/microservices', 'microservices-module.js'], ['@nestjs/microservices', 'index.js'],
    ['class-transformer', 'index.js'], ['class-validator', 'index.js'], ['@konjir/server', 'index.js'], ['file-type', 'index.js'],
    // @nestjs/core/package.json as a folder of code: @onivoro/server-mcp looks it up from the working folder.
    ['@nestjs/core/package.json', 'index.js']]) {
    mkdirSync(join(dir, 'node_modules', pkg), { recursive: true });
    writeFileSync(join(dir, 'node_modules', pkg, file), `require('node:fs').appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(`${pkg}/${file}\n`)});\n`);
  }
  const said = `ping ${rand}`;
  const heard = await session('konjir-builder', servers['konjir-builder'], dir, async () => {
    // The other agent messages it, from the CLI on its own sign-in.
    const sent = await run(KONJIR, ['send_message', `to=${LOGIN}-builder`, `message=${said}`, '--url', mcp], { cwd: dir, env: env({ KONJIR_CREDENTIALS: join(xdg, 'konjir', 'agents', `${LOGIN}-writer.json`) }) });
    check(sent.code === 0, `${LOGIN}-writer couldn't message ${LOGIN}-builder (${sent.code}):\n${sent.out}${sent.err}`);
  });
  check(heard.pushed.includes(`${LOGIN}-writer`) || heard.pushed.includes(said), `the channel message doesn't tell of ${LOGIN}-writer's message: ${heard.pushed.slice(0, 400)}`);
  for (const cmd of ['help', '--version']) await run(KONJIR, [cmd], { cwd: dir, env: env() });
  check(!existsSync(ran), `konjir ran code the project planted in its node_modules: ${existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n').join(', ') : ''}`);
  step(`it listed ${heard.tools} of Kolab's tools and was pushed: ${heard.pushed.split('\n')[0].slice(0, 120)}`);

  step('the agent cap: 2 live agents and 9 more is refused, on the page and in the CLI');
  const capped = await project('capped');
  const many = Array.from({ length: 9 }, (_, i) => `extra${i + 1}:engineer`);
  const refused = await connect(capped, mcp, many);
  const cap = 'you have 2 live agents, and this would make 9 more: a person has at most 10 here';
  check(refused.page.includes('This setup can&#39;t be allowed') || refused.page.includes('This setup can\'t be allowed'), `the setup page didn't refuse:\n${refused.page}`);
  check(refused.page.includes(cap) && !refused.page.includes('value="allow"'), `the setup page doesn't show the cap with Deny alone:\n${refused.page}`);
  check(refused.code !== 0, 'konjir connect passed past the agent cap');
  check(`${refused.out}${refused.err}`.includes(cap), `konjir connect doesn't say why:\n${refused.out}${refused.err}`);
  check(!existsSync(join(capped, '.mcp.json')), 'a refused setup wrote .mcp.json');
  for (let i = 1; i <= 9; i++) check(!existsSync(join(xdg, 'konjir', 'agents', `${LOGIN}-extra${i}.json`)), 'a refused setup kept a sign-in');

  step('passed');
}

main().then(() => 0, (e) => {
  console.error(`e2e-connect FAILED: ${e instanceof Failed ? e.message : e?.stack ?? e}`);
  return 1;
}).then(async (code) => { await cleanup(); process.exit(code); });
