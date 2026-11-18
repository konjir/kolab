// What konnect's end-to-end tests share: a Kolab started here with a stub in GitHub's place, where
// Ann owns team hub (Bo writes there, Ann's agent ann-reviewer works there) and team side; each
// person's machine, with a config folder of its own; and the person's browser, played with fetch.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StubIdentity, startServer } from '@konjir/server';
import { closeAtEnd, openKolab, rejection, type TestKolab } from '@konjir/engine/testing';
import { exitStatus, main, type IO } from '../src/konnect.js';

/**
 * The person's browser: follows Kolab's redirects with its cookies, submits the page as `form`
 * says (the page's csrf, sign-in and `shown` with it), or, given a function, presses the button it
 * picks from the page's buttons (name=value), and lands on konnect's loopback callback.
 */
export async function browse(start: URL, form: Record<string, string> | ((buttons: string[], html: string) => Record<string, string>)): Promise<string> {
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
  const shown = /name="shown" value="([^"]+)"/.exec(html)?.[1];
  const fields = typeof form === 'function' ? form([...html.matchAll(/<button[^>]*name="([^"]+)" value="([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`), html) : { decision: 'allow', ...form };
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, sign_in: signIn ?? '', ...(shown ? { shown } : {}), ...fields }).toString(),
  });
  const back = done.headers.get('location');
  if (!back) throw new Error(`Kolab answered the page with ${done.status}: ${(await done.text()).slice(0, 300)}`);
  await (await fetch(new URL(back))).text();
  return html;
}

/** Presses the first button whose name=value starts with `prefix`. */
export const pressing = (prefix: string) => (buttons: string[]) => {
  const b = buttons.find((x) => x.startsWith(prefix));
  if (!b) throw new Error(`no ${prefix} button among ${buttons.join(', ')}`);
  const i = b.indexOf('=');
  return { [b.slice(0, i)]: b.slice(i + 1) };
};

/** The team page (`konnect login <team>`, `konnect team create <name>`): Allow. */
export const AS_SELF = (_team: string) => pressing('decision=allow');

/** What a command that fails says: the line konnect prints. */
export const fails = async (p: Promise<unknown>) => (await rejection(p)).replace(/^Error: /, '');

/** The status konnect exits with for what `p` does (main.ts): 0 when it succeeds. */
export const exitOf = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return exitStatus(e); } };

/** One person's machine: their own config folder and a folder to work in, and what konnect printed there. */
export function machine(url: string, name: string) {
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
export async function teams() {
  const kolab: TestKolab = await openKolab();
  // GitHub's accounts, as konnect team invite looks them up: Ann, Bo and Cy, who isn't in any team yet.
  const idp = new StubIdentity().account({ subject: '41', login: 'ann' }).account({ subject: '42', login: 'bo' }).account({ subject: '43', login: 'cy' });
  const server = await startServer({ adminToken: 'konnect-admin', kolab, identity: idp, webRoot: null });
  closeAtEnd(server);
  await kolab.signInWith({ provider: 'stub', subject: '41', login: 'ann' });
  await kolab.signInWith({ provider: 'stub', subject: '42', login: 'bo' });
  await kolab.createKolab('hub', { owner: 'ann' });
  await kolab.createKolab('side', { owner: 'ann' });
  await kolab.grant('hub', 'bo', 'write');
  await kolab.addActor('ann-reviewer', { owner: 'ann' });
  await kolab.grant('hub', 'ann-reviewer', 'write');
  /** `konnect login <team>`, as `login` on GitHub, pressing what `form` says on the page. */
  const signIn = async (m: ReturnType<typeof machine>, login: { subject: string; login: string }, team: string, form: Parameters<typeof browse>[1] = AS_SELF(team)) => {
    idp.next(login);
    return m.run(['login', team], { open: (u) => { void browse(u, form); } });
  };
  /** `konnect team create <name>`, as `login` on GitHub. */
  const create = async (m: ReturnType<typeof machine>, login: { subject: string; login: string }, team: string, form: Parameters<typeof browse>[1] = AS_SELF(team)) => {
    idp.next(login);
    return m.run(['team', 'create', team], { open: (u) => { void browse(u, form); } });
  };
  return { kolab, server, idp, signIn, create, ann: { subject: '41', login: 'ann' }, bo: { subject: '42', login: 'bo' } };
}

