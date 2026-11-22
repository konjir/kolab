/**
 * A throwaway Kolab on this machine for a dev build of konnect to talk to, as the phase 0 spikes do
 * (app/dev/mcp.tsx, app/dev/oauth.tsx). It never reaches any other Kolab, nor GitHub.
 *
 *   npx nx run @konjir/konnect-mobile:local-kolab
 *
 * - Kolab from this checkout, in memory, on http://127.0.0.1:7432/mcp (KONNECT_LOCAL_PORT), with
 *   the stub identity provider in GitHub's place.
 * - Ann owns team `hub`, where Bo writes. Each is signed in as konnect signs a person in (OAuth
 *   with PKCE, a loopback client, the `team:hub intent:join` scope), with this script playing the
 *   browser, and their sign-ins are kept in .konjir-dev/ (0600, gitignored).
 * - http://127.0.0.1:7433/spike (the port after) hands a dev build the MCP URL and both people's
 *   access tokens, fresh each time it is asked. It listens on loopback only, which an iOS
 *   simulator shares with this machine.
 * - Anyone else who signs in at this Kolab's own page, such as the OAuth spike's auth session, is Ann.
 *
 * Ctrl-C stops it, and everything goes with it.
 */
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kolab } from '@konjir/engine';
import { StubIdentity, startServer } from '@konjir/server';
import { StoredLogin, signInToTeam } from '@konjir/login';
import { ADMIN_DOER } from '@konjir/types';

const port = Number(process.env.KONNECT_LOCAL_PORT ?? 7432);
const here = join(dirname(fileURLToPath(import.meta.url)), '..', '.konjir-dev');
const by = { by: ADMIN_DOER };
const PEOPLE = { ann: { subject: '41', login: 'ann' }, bo: { subject: '42', login: 'bo' } } as const;

/** The person's browser: follows Kolab's redirects with its cookies and presses Allow on its page. */
async function allow(start: URL) {
  const jar = new Map<string, string>();
  const go = async (url: URL, init: RequestInit = {}) => {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]!; jar.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)); }
    return res;
  };
  let url = start;
  let res = await go(url);
  while (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get('location')!, url); res = await go(url); }
  const html = await res.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  const csrf = field('csrf');
  if (!csrf) throw new Error(`no consent page at ${url.pathname}: ${res.status}`);
  const shown = field('shown');
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, sign_in: field('sign_in') ?? '', ...(shown ? { shown } : {}), decision: 'allow' }).toString(),
  });
  const back = done.headers.get('location');
  if (!back) throw new Error(`Kolab answered the consent page with ${done.status}`);
  await (await fetch(new URL(back))).text();
}

rmSync(here, { recursive: true, force: true });
mkdirSync(here, { recursive: true, mode: 0o700 });

const idp = new StubIdentity();
idp.as = PEOPLE.ann;
// GitHub accounts an invitation can find: Cy, who is in no team yet.
idp.account({ subject: '43', login: 'cy' });
const kolab = await Kolab.open({});
for (const p of Object.values(PEOPLE)) await kolab.signInWith({ provider: 'stub', ...p });
await kolab.createKolab('hub', { owner: 'ann', ...by });
await kolab.grant('hub', 'bo', 'write', by);
const server = await startServer({ host: '127.0.0.1', port, kolab, adminToken: null, identity: idp, webRoot: null });
const url = `${new URL(server.url).origin}/mcp`;

const files: Record<string, string> = {};
for (const [name, who] of Object.entries(PEOPLE)) {
  files[name] = join(here, `${name}.json`);
  idp.next(who);
  await signInToTeam(url, 'hub', { path: files[name], intent: 'join', clientName: 'konnect mobile local', open: allow, log: () => undefined });
}

// Something to look at: two more channels, a few messages for Ann (unread, one mentioning her),
// and an agent of Ann's that has spoken, past nobody's cap. Written as Bo and the agent, through
// the engine, as their own sessions would.
if (process.env.KONNECT_LOCAL_SEED !== '0') {
  await kolab.addActor('ann-reviewer', { owner: 'ann', ...by });
  await kolab.grant('hub', 'ann-reviewer', 'write', by);
  const bo = await kolab.openSession('bo', 'engineer', { kolab: 'hub', ...by });
  const agent = await kolab.openSession('ann-reviewer', 'engineer', { kolab: 'hub', ...by });
  for (const c of ['design', 'releases']) await kolab.makeChannel(bo, c);
  const hello = await kolab.sendChannelMessage(bo, 'general', 'Morning all. The phone app signs in now: try it on the simulator.');
  await kolab.sendChannelMessage(agent, 'general', '**Review done** for `apps/konnect-mobile`:\n\n- sign-in: PKCE and a per-team client\n- refresh: one at a time per team\n\nNothing blocking.', { replyTo: hello.id });
  await kolab.sendChannelMessage(bo, 'general', '@ann can you look at the composer next?', { mentions: ['ann'] });
  await kolab.sendChannelMessage(bo, 'design', 'Daybreak and Predawn both read well on the sign-in screen.');
  await kolab.sendMessage(bo, 'ann', 'Hi Ann, a DM from Bo. Reply from the phone?');
  await kolab.sendMessage(bo, 'ann', 'And a second one, so there are two unread.');
  await kolab.sendMessage(agent, 'ann', 'I finished the review. Want the details in #general or here?');
  await kolab.endSession(bo, { signingOut: true });
  await kolab.endSession(agent, { signingOut: true });
}

/** A person's access token, refreshed by the MCP SDK's rules when it is near its end. */
const token = async (name: string) => {
  const login = new StoredLogin(url, { path: files[name] });
  const t = await login.tokens();
  if (!t?.access_token) throw new Error(`${name} has no sign-in kept`);
  return t.access_token;
};

const handoff = createServer((req, res) => {
  if (req.url !== '/spike') { res.writeHead(404).end(); return; }
  Promise.all([token('ann'), token('bo')]).then(([ann, bo]) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify({ url, listener: { actor: 'ann', token: ann }, sender: { actor: 'bo', token: bo } }));
  }, (e: Error) => { res.writeHead(500).end(e.message); });
});
await new Promise<void>((resolve) => handoff.listen(port + 1, '127.0.0.1', resolve));

console.log(`Kolab on ${url}: team hub, with ann and bo signed in (kept in ${here}), and ann's agent ann-reviewer.`);
console.log('Sign in from the app as Ann: Kolab\'s stub sign-in is Ann\'s, and "Sign in to hub" on its page.');
console.log(`A dev build reads the URL and their tokens from http://127.0.0.1:${port + 1}/spike. Ctrl-C stops it.`);

const stop = async () => { handoff.close(); await server.close(); await kolab.close(); rmSync(here, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
