#!/usr/bin/env node
// A headless end-to-end check of `konjir connect claude` (one page, D105), with no person: so a
// change to setup or consent is tested in minutes, by an agent as well as by hand.
//
//   npm run e2e:connect        (or: node apps/cli/scripts/e2e-connect.mjs)
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
// same command again passes and leaves .mcp.json as it was; and an agent cap refusal (2 live
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
const KONJIR = join(ROOT, 'bin', 'konjir');
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

const step = (s) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${s}`);
class Failed extends Error {}
const fail = (why) => { throw new Failed(why); };
const check = (ok, why) => { if (!ok) fail(why); };

function cleanup() {
  if (server && server.exitCode === null) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ } }
  if (process.env.KEEP) console.error(`kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

/** A free port on 127.0.0.1. */
const freePort = () => new Promise((ok, no) => {
  const s = createServer().once('error', no).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

/** The environment every konjir here runs in: the temp HOME and config, no token, no URL of the person's. */
function env(extra = {}) {
  const e = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${bin}:${process.env.PATH}`, ...extra };
  for (const k of ['KONJIR_TOKEN', 'KONJIR_URL', 'KONJIR_CREDENTIALS', 'KONJIR_ADMIN_TOKEN', 'KONJIR_PUBLIC_HOST', 'KONJIR_GITHUB_CLIENT_ID', 'KONJIR_DATABASE_URL']) if (!(k in extra)) delete e[k];
  return e;
}

/** Runs a command to its end: its exit code, stdout and stderr. */
function run(cmd, args, opts = {}, timeoutMs = 90_000) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); err += `\n(killed after ${timeoutMs / 1000}s)`; }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); ok({ code, out, err }); });
  });
}

async function startKolab() {
  const port = await freePort();
  // Its own process group, so cleanup stops tsx and the node it starts.
  server = spawn(KONJIR, ['serve', '--port', String(port), '--data', join(tmp, 'data'), '--admin-token', 'off'], {
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
    server.on('exit', (code) => { clearTimeout(t); no(new Failed(`Kolab exited (${code}) before listening:\n${log}`)); });
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
  const page = await Promise.race([waitOpened().then((u) => browser(u, mcp)), ran.then((r) => fail(`konjir connect ended (${r.code}) before opening a browser:\n${r.out}${r.err}`))]);
  return { ...(await ran), page };
}

async function project(name) {
  const dir = join(tmp, name);
  mkdirSync(dir);
  const g = await run('git', ['init', '-q'], { cwd: dir });
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
  const last = first.out.trim().split('\n').pop();
  check(last.startsWith('claude --dangerously-load-development-channels server:konjir-writer'), `connect's last line isn't the claude command: ${last}`);

  const mcpJson = join(dir, '.mcp.json');
  check(existsSync(mcpJson), '.mcp.json was not written');
  const written = readFileSync(mcpJson, 'utf8');
  const servers = JSON.parse(written).mcpServers ?? {};
  for (const [label, role] of agents) {
    const e = servers[`konjir-${label}`];
    const agent = `${LOGIN}-${label}`;
    check(e?.type === 'stdio' && e.command.endsWith('apps/channel-bridge/scripts/start.sh'), `.mcp.json has no channel entry konjir-${label}: ${JSON.stringify(e)}`);
    check(e.env?.KONJIR_URL === mcp && e.env.KONJIR_AGENT === agent && e.env.KONJIR_TOKEN === '', `konjir-${label}'s env is wrong: ${JSON.stringify(e.env)}`);
    check(e.env.KONJIR_SCOPE === `konjir kolab:${KOLAB} role:${role} agent:${agent}`, `konjir-${label}'s scope is ${e.env.KONJIR_SCOPE}`);
  }
  check(!/kj[a-z]*_[A-Za-z0-9]{16,}/.test(written), '.mcp.json holds something like a token');

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

main().then(() => { cleanup(); process.exit(0); }, (e) => {
  console.error(`e2e-connect FAILED: ${e instanceof Failed ? e.message : e?.stack ?? e}`);
  cleanup();
  process.exit(1);
});
