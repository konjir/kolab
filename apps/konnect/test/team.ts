// What konnect's end-to-end tests share: a Kolab started here with a stub in GitHub's place, where
// Ann owns team hub (Bo writes there, Ann's agent ann-reviewer works there) and team side; each
// person's machine, with a config folder of its own; and the person's browser, played with fetch.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StubIdentity, startServer } from '@konjir/server';
import { closeAtEnd, openKolab, rejection, type TestKolab } from '@konjir/engine/testing';
import { main, type IO } from '../src/konnect.js';

/** The person's browser: follows Kolab's redirects with its cookies, submits the consent page as `form` says, and lands on konnect's loopback callback. */
export async function browse(start: URL, form: Record<string, string>): Promise<string> {
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

export const AS_SELF = (team: string) => ({ as: 'self', kolab: `kolab:${team}`, role: 'product' });

/** What a command that fails says: the line konnect prints. */
export const fails = async (p: Promise<unknown>) => (await rejection(p)).replace(/^Error: /, '');

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

