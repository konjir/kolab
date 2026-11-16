#!/usr/bin/env node
// A headless end-to-end check of a published konnect against a Kolab started from this checkout,
// with no person:
//
//   node apps/konnect/scripts/e2e.mjs --konnect <konnect: the bundle, apps/konnect/dist-npm/konnect.mjs,
//                                                 or an installed package's bin/konnect>
//
// It starts a local Kolab (`bin/konjir serve`, on PGlite in a temp folder, on a free 127.0.0.1 port)
// with the stub identity (KONJIR_STUB_IDENTITY=e2e), so whoever opens Kolab's sign-in is signed in
// as e2e with no GitHub, and a throwaway break-glass admin token. It never reaches any other Kolab.
// konnect's config and everything it writes land in a temp folder.
//
// With the admin token (the checkout's konjir), it registers a second person, peer, and a team of
// peer's. `konnect team <team>` then signs e2e in: the person's browser is a stand-in `open` (and
// `xdg-open`) on PATH that records the URL, and this script plays the browser with fetch, keeping
// cookies, up to Kolab's consent page (which signs e2e up), grants e2e write in the team, and
// allows the sign-in as e2e themselves. Then peer, with a session the admin token opens, and e2e,
// through konnect, exchange direct messages: konnect read shows peer's and marks it read, konnect
// send reaches peer, konnect who names both, and konnect logout signs out.
//
// Exits nonzero, saying which check failed. The server and temp folders are removed either way
// (KEEP=1 keeps the folders, and prints where).
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const KONJIR = join(ROOT, 'bin', 'konjir');
const given = process.argv.indexOf('--konnect');
if (given < 0 || !process.argv[given + 1]) { console.error('--konnect <path to a published konnect>'); process.exit(2); }
const KONNECT = resolve(process.argv[given + 1]);
/** How konnect is run: a .mjs through node, anything else as it is. */
const konnectCmd = KONNECT.endsWith('.mjs') ? [process.execPath, KONNECT] : [KONNECT];
const LOGIN = 'e2e';
const TEAM = `konnect-${randomBytes(3).toString('hex')}`;
const ADMIN = randomBytes(18).toString('hex');
const started = Date.now();
const tmp = mkdtempSync(join(tmpdir(), 'konnect-e2e-'));
const home = join(tmp, 'home');
const bin = join(tmp, 'bin');
const work = join(tmp, 'work');
const opened = join(tmp, 'opened.txt');
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

const freePort = () => new Promise((ok, no) => {
  const s = createServer().once('error', no).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

/** The environment every command runs in: the temp HOME and config, and no KONJIR_* or KONNECT_* of the person's. */
function env(extra = {}) {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KONJIR_') && !k.startsWith('KONNECT_')));
  return { ...e, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${bin}:${process.env.PATH}`, ...extra };
}

/** Runs a command to its end: its exit code, stdout and stderr. */
function run(cmd, args, opts = {}, timeoutMs = 90_000) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { cwd: work, ...opts, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
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
const konnect = (args, opts = {}) => run(konnectCmd[0], [...konnectCmd.slice(1), ...args], { ...opts, env: env({ KONNECT_URL: MCP }) });
/** The checkout's konjir, with a token: the admin's, or peer's session. */
const konjir = async (token, args) => {
  const r = await run(KONJIR, args, { env: env({ KONJIR_URL: MCP, KONJIR_TOKEN: token }) });
  check(r.code === 0, `konjir ${args[0]} exited ${r.code}:\n${r.out}${r.err}`);
  try { return JSON.parse(r.out); } catch { return r.out; }
};

async function startKolab() {
  const port = await freePort();
  server = spawn(KONJIR, ['serve', '--port', String(port), '--data', join(tmp, 'data'), '--admin-token', ADMIN, '--quiet'], {
    cwd: tmp, env: env({ KONJIR_STUB_IDENTITY: LOGIN }), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let log = '';
  return new Promise((ok, no) => {
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

async function waitOpened(timeoutMs = 60_000) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await new Promise((r) => setTimeout(r, 100))) {
    if (existsSync(opened)) { const u = readFileSync(opened, 'utf8').trim().split('\n').pop(); if (u) return new URL(u); }
  }
  fail('konnect opened no browser within 60s');
}

/**
 * The person's browser: follows Kolab's redirects with its cookies to the consent page, runs
 * `before` (the sign-up happened on the way), then allows the sign-in as the person themselves in
 * the team, and follows Kolab's answer to konnect's loopback listener.
 */
async function browser(start, before) {
  check(start.origin === new URL(MCP).origin && start.pathname === '/oauth/authorize', `konnect opened ${start}, not this Kolab's /oauth/authorize`);
  check(start.searchParams.get('scope') === `konjir kolab:${TEAM}`, `konnect's sign-in doesn't name kolab ${TEAM}: scope ${start.searchParams.get('scope')}`);
  const jar = new Map();
  const go = async (url, init = {}) => {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...init.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  };
  let url = start;
  let res = await go(url);
  for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
    check(hops < 10, 'more than 10 redirects before the consent page');
    url = new URL(res.headers.get('location'), url);
    res = await go(url);
  }
  const html = await res.text();
  const field = (name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  check(res.status === 200 && field('csrf'), `no consent page at ${url.pathname}: ${res.status} ${html.slice(0, 400)}`);
  await before();
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sign_in: field('sign_in') ?? '', csrf: field('csrf'), decision: 'allow', as: 'self', kolab: `kolab:${TEAM}`, role: 'product' }).toString(),
  });
  check(done.status === 303, `Kolab refused the sign-in: ${done.status} ${(await done.text()).slice(0, 400)}`);
  const back = new URL(done.headers.get('location'));
  check(back.hostname === '127.0.0.1', `Kolab sent the browser to ${back.origin}, not konnect's loopback listener`);
  await (await fetch(back)).text();
}

async function main() {
  mkdirSync(join(home, '.config'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(work);
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  step(`konnect: ${konnectCmd.join(' ')}`);
  const version = await konnect(['--version']);
  check(version.code === 0 && /^\d+\.\d+\.\d+/.test(version.out.trim()), `konnect --version: ${version.code} ${version.out}${version.err}`);
  step(`starting a local Kolab (stub identity: ${LOGIN}) in ${tmp}`);
  MCP = await startKolab();
  step(`Kolab at ${MCP}; team ${TEAM}, owned by peer`);
  await konjir(ADMIN, ['admin_add_actor', 'id=peer']);
  await konjir(ADMIN, ['admin_add_kolab', `name=${TEAM}`, 'owner=peer']);

  step(`konnect team ${TEAM}: e2e signs in as themselves`);
  const signing = konnect(['team', TEAM]);
  const browsing = waitOpened().then((u) => browser(u, () => konjir(ADMIN, ['admin_grant', `kolab=${TEAM}`, `to=${LOGIN}`, 'level=write'])));
  await Promise.race([browsing, signing.then((r) => (existsSync(opened) ? browsing : fail(`konnect team ended (${r.code}) before opening a browser:\n${r.out}${r.err}`)))]);
  const signed = await signing;
  check(signed.code === 0, `konnect team exited ${signed.code}:\n${signed.out}${signed.err}`);
  check(signed.out.includes(`Signed in to team ${TEAM} as ${LOGIN}.`), `konnect team said: ${signed.out}`);
  check(JSON.parse(readFileSync(join(work, '.konnect.json'), 'utf8')).team === TEAM, '.konnect.json doesn\'t name the team');
  check(existsSync(join(home, '.config', 'konnect', 'teams', `${TEAM}.json`)), 'konnect kept no sign-in in ~/.config/konnect/teams');
  check(!existsSync(join(home, '.config', 'konjir')), 'konnect wrote into konjir\'s config folder');

  step('peer messages e2e; konnect read shows it, oldest first, and marks it read');
  const peer = (await konjir(ADMIN, ['admin_open_session', 'actor=peer', 'role=product', `kolab=${TEAM}`])).token;
  await konjir(peer, ['send_message', `to=${LOGIN}`, 'message=the deploy is green']);
  const read = await konnect(['read']);
  check(read.code === 0 && /@peer\n {2}the deploy is green/.test(read.out), `konnect read: ${read.code}\n${read.out}${read.err}`);
  const again = await konnect(['read']);
  check(again.code === 0 && again.out.trim() === 'No unread messages.', `konnect read again: ${again.out}${again.err}`);

  step('konnect send @peer, from stdin; peer reads it');
  const sent = await konnect(['send', '@peer'], { input: 'thanks, shipping\n' });
  check(sent.code === 0 && sent.out.trim() === 'Sent to @peer.', `konnect send: ${sent.code}\n${sent.out}${sent.err}`);
  const got = await konjir(peer, ['read_messages']);
  check(got.messages?.length === 1 && got.messages[0].from === LOGIN && got.messages[0].message === 'thanks, shipping', `peer read: ${JSON.stringify(got)}`);

  step('konnect who');
  const who = await konnect(['who', '--json']);
  const members = JSON.parse(who.out || '[]');
  check(members.some((m) => m.actor === 'peer') && members.some((m) => m.actor === LOGIN && m.you), `konnect who: ${who.out}${who.err}`);

  step('a channel says it isn\'t available yet');
  const channel = await konnect(['send', '#general', 'hi']);
  check(channel.code !== 0 && channel.err.includes('isn\'t available yet'), `konnect send '#general': ${channel.code} ${channel.out}${channel.err}`);

  step('konnect logout');
  const out = await konnect(['logout']);
  check(out.code === 0 && out.out.trim() === `Signed out of team ${TEAM}.`, `konnect logout: ${out.code} ${out.out}${out.err}`);
  const after = await konnect(['who']);
  check(after.code !== 0 && after.err.includes(`run konnect team ${TEAM}`), `konnect who after logout: ${after.code} ${after.out}${after.err}`);
  step('passed');
}

main().then(() => 0, (e) => {
  console.error(`konnect e2e FAILED: ${e instanceof Failed ? e.message : e?.stack ?? e}`);
  return 1;
}).then(async (code) => { await cleanup(); process.exit(code); });
