// What scripts/e2e.mjs and scripts/compat.mjs share: a local Kolab started from this checkout
// (scripts/e2e-kolab.ts: the checkout's server, on PGlite in a temp folder, on a free 127.0.0.1
// port) with the stub identity provider in GitHub's place, told on its stdin who signs in next and
// which GitHub accounts exist; a machine per person, each with its own HOME and config in a temp
// folder; konnect run there against that Kolab; and the person's browser, played with fetch.
//
// The browser is a stand-in `open` (and `xdg-open`) on PATH that records the URL; browser() follows
// it with fetch, keeping cookies, and presses the page's button. Nothing here reaches any other
// Kolab, nor GitHub.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A check that failed: the run says why, and exits nonzero. */
export class Failed extends Error {}
export const fail = (why) => { throw new Failed(why); };
export const check = (ok, why) => { if (!ok) fail(why); };

/** The path after `--konnect` on the command line, or exits 2 saying what is missing. */
export function konnectArg(usage) {
  const given = process.argv.indexOf('--konnect');
  if (given < 0 || !process.argv[given + 1]) { console.error(usage); process.exit(2); }
  return resolve(process.argv[given + 1]);
}

/**
 * One run: its temp folder (`prefix` names it), the konnect it runs (a .mjs through node, anything
 * else as it is), the Kolab once started, and everything it started, stopped by cleanup().
 */
export function harness(konnectPath, prefix) {
  const konnectCmd = konnectPath.endsWith('.mjs') ? [process.execPath, konnectPath] : [konnectPath];
  const started = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const bin = join(tmp, 'bin');
  const live = new Set();
  let server;
  let say;

  const h = {
    tmp, konnectCmd, live,
    /** The Kolab's MCP URL, once started: until then, one nothing listens on. */
    url: 'http://127.0.0.1:9/mcp',

    step: (s) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${s}`),

    async cleanup() {
      const running = [...live, server].filter((p) => p && p.exitCode === null && p.signalCode === null);
      const kill = (p, sig) => { try { process.kill(-p.pid, sig); } catch { /* gone */ } };
      await Promise.all(running.map((p) => new Promise((ok) => {
        const t = setTimeout(() => { kill(p, 'SIGKILL'); ok(); }, 5_000);
        p.once('exit', () => { clearTimeout(t); ok(); });
        kill(p, 'SIGTERM');
      })));
      if (process.env.KEEP) { console.error(`kept ${tmp}`); return; }
      try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.error(`couldn't remove ${tmp}: ${e.message}`); }
    },

    /** One person's machine: a HOME, config, work folder and record of what the browser was sent to. */
    machine(name) {
      const home = join(tmp, name);
      const m = { name, home, work: join(home, 'work'), opened: join(home, 'opened.txt') };
      mkdirSync(m.work, { recursive: true });
      return m;
    },

    /** The environment a person's commands run in: their temp HOME and config, and no KONJIR_* or KONNECT_* of the runner's. */
    env(m, extra = {}) {
      const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KONJIR_') && !k.startsWith('KONNECT_')));
      return { ...e, HOME: m.home, XDG_CONFIG_HOME: join(m.home, '.config'), PATH: `${bin}:${process.env.PATH}`, OPENED: m.opened, KONNECT_URL: h.url, KONNECT_TERMINAL: '1', ...extra };
    },

    /** Runs a command to its end: its exit code, stdout and stderr. */
    run(cmd, args, opts = {}, timeoutMs = 90_000) {
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
    },

    /** konnect, run on a person's machine. */
    konnect: (m, args, opts = {}) => h.run(konnectCmd[0], [...konnectCmd.slice(1), ...args], { cwd: m.work, ...opts, env: h.env(m, opts.env) }),

    /** Puts the stand-in browser on PATH and starts the Kolab; resolves with its MCP URL, also kept as h.url. */
    async startKolab() {
      mkdirSync(bin, { recursive: true });
      for (const name of ['open', 'xdg-open']) {
        writeFileSync(join(bin, name), '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$OPENED"\n');
        chmodSync(join(bin, name), 0o755);
      }
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
            if (line.startsWith('{"url"')) { clearTimeout(t); ok(JSON.parse(line).url); } else if (line === 'ok') waiting.shift()?.();
            else { log += `${line}\n`; h.onLog?.(line); }
          }
        });
        server.on('exit', (code) => { clearTimeout(t); no(new Failed(`Kolab exited (${code}) before listening:\n${log}`)); });
      });
      say = (line) => new Promise((ok) => { waiting.push(ok); server.stdin.write(`${line}\n`); });
      h.url = await url;
      return h.url;
    },

    /** Tells the stub identity provider something (`next <subject> <login>`, `account …`), and waits for its ok. */
    say: (line) => say(line),

    async waitOpened(m, timeoutMs = 60_000) {
      for (const until = Date.now() + timeoutMs; Date.now() < until; await new Promise((r) => setTimeout(r, 100))) {
        if (existsSync(m.opened)) { const u = readFileSync(m.opened, 'utf8').trim().split('\n').pop(); if (u) { rmSync(m.opened); return new URL(u); } }
      }
      fail(`${m.name}'s konnect opened no browser within 60s`);
    },

    /** The person's browser: from the URL konnect opened, follows Kolab's redirects with its cookies to its page, presses the button `prefix` names, and follows Kolab's answer to konnect's loopback listener. */
    async browser(start, prefix) {
      check(start.origin === new URL(h.url).origin && start.pathname === '/oauth/authorize', `konnect opened ${start}, not this Kolab's /oauth/authorize`);
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
    },

    /** A konnect command that signs in through the browser: who signs in, and which button to press. */
    async signingIn(m, who, args, prefix) {
      await say(`next ${who.subject} ${who.login}`);
      const ran = h.konnect(m, args);
      const browsing = h.waitOpened(m).then((u) => h.browser(u, prefix));
      await Promise.race([browsing, ran.then((r) => (existsSync(m.opened) ? browsing : fail(`konnect ${args.join(' ')} ended (${r.code}) before opening a browser:\n${r.out}${r.err}`)))]);
      const r = await ran;
      check(r.code === 0, `konnect ${args.join(' ')} exited ${r.code}:\n${r.out}${r.err}`);
      return r;
    },

    /** Runs `main`, says whether it passed, cleans up, and exits 0 or 1. Signals clean up too. */
    main(name, main) {
      for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(sig, () => { void h.cleanup().finally(() => process.exit(code)); });
      main().then(() => 0, (e) => {
        console.error(`${name} FAILED: ${e instanceof Failed ? e.message : e?.stack ?? e}`);
        return 1;
      }).then(async (code) => { await h.cleanup(); process.exit(code); });
    },
  };
  return h;
}
