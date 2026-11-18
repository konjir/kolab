/**
 * The commands about the machines of yours that start your agents when you ask from another one:
 *
 *   konnect host list
 *   konnect host run [--background] [<name>]     this machine hosts, in this folder, until it is ended
 *   konnect host stop [<name>]
 *
 * A machine hosts only while `konnect host run` runs on it, as you, in the folder you ran it in.
 * It then takes requests from the service every few seconds, and the service gives it only yours:
 * from your own login, never an agent's and never a teammate's. A request names agents of yours,
 * one of the harnesses konnect starts, and konnect's own options; it carries no command, no path
 * and no argument for the harness (host-ask.ts reads it, and refuses anything it doesn't know).
 * Each agent is started as `konnect agent run --background` starts one here, in this folder. What
 * that agent may then do on this machine is set here, in its harness, never by the request.
 *
 * `konnect agent run --on <name> …` and `konnect agent stop --on <name> …` ask (host-ask.ts).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { keepSignIn, logout } from '@konjir/login';
import { konnectCommand } from './agents.js';
import { NotYet, Refused, SignInError, TeamClient, type Host, type HostRequest } from './client.js';
import { exec, inSession, multiplexer, running, sessionName, sessions, startInBackground } from './cmd-agent.js';
import type { Ctx } from './context.js';
import { UsageError } from './errors.js';
import { helpFor } from './help.js';
import { HOST_NAME, ago, askHost, bound, checkHost, readStart, readStop, type Started } from './host-ask.js';
import { printable } from './names.js';
import { newKeys, unseal } from './seal.js';
import { agentFile, agentFileReady, dropIfEmpty, hostFileReady } from './teams.js';

/** How often a hosting machine tells the service it is there and takes what waits for it. */
const TICK_MS = 3_000;
/** While the service can't be reached, how long between tries, at most. */
const RETRY_MS = 30_000;

/** What a machine keeps of hosting under one name: who it is to the service, the key logins are sealed to, and whose turn it is. */
interface Kept { instance: string; publicKey: string; privateKey: string; claim?: string }

const read = (file: string): Kept | undefined => {
  try {
    const k = JSON.parse(readFileSync(file, 'utf8')) as Kept;
    return k && typeof k.instance === 'string' && /^[a-f0-9]{16,64}$/.test(k.instance) && typeof k.publicKey === 'string' && typeof k.privateKey === 'string' ? k : undefined;
  } catch { return undefined; }
};
const write = (file: string, kept: Kept) => {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
};

/** The name this machine hosts as unless one is given: its own, as a machine's name is written. */
export function thisMachine(given: string = hostname()): string | undefined {
  const name = given.split('.')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return HOST_NAME.test(name) ? name : undefined;
}

const named = (given: string | undefined, verb: string): string => {
  if (given !== undefined) return checkHost(given);
  const own = thisMachine();
  if (!own) throw new UsageError(`konnect host ${verb} <name>: this machine's own name can't be one, so give it one, such as desktop`);
  return own;
};

/** The folder, with the home folder written as ~: the person's user name isn't the service's to know. */
const shown = (dir: string, env: Record<string, string | undefined>): string => {
  const home = env.HOME || homedir();
  const said = home && (dir === home || dir.startsWith(`${home}/`)) ? `~${dir.slice(home.length)}` : dir;
  // eslint-disable-next-line no-control-regex
  return said.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 400);
};

/** The background session a machine hosts in: no agent's session is named so (an agent's holds no '_'). */
const hostSession = (team: string, name: string) => `konnect_host_${team}_${name}`;

/** The agents konnect keeps a login for on this machine, in the team. */
const loginsHere = (team: string, env: Record<string, string | undefined>): string[] => {
  try { return readdirSync(dirname(agentFile(team, 'x', env))).filter((f) => /^[a-z0-9][a-z0-9-]{0,23}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort().slice(0, 100); } catch { return []; }
};

/** Whether Claude Code has been run in the folder and told to trust it; undefined when that can't be read. */
function trusted(dir: string, env: Record<string, string | undefined>): boolean | undefined {
  try {
    const projects = (JSON.parse(readFileSync(join(env.HOME || homedir(), '.claude.json'), 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> }).projects;
    return projects && typeof projects === 'object' ? projects[dir]?.hasTrustDialogAccepted === true : undefined;
  } catch { return undefined; }
}

const brief = (e: unknown) => printable(String((e as Error)?.message ?? e)).replace(/\s+/g, ' ').slice(0, 500);

/** One line for each machine: its name, whether it hosts now, its folder, and the agents running there. */
export function formatHosts(hosts: Host[], now = Date.now()): string {
  const rows = hosts.map((h) => [printable(h.name), h.serving ? 'hosting' : `last seen ${ago(h.seen_at, now)}`, h.folder ? printable(h.folder) : '', h.serving && h.running.length ? `running: ${h.running.map(printable).join(', ')}` : '']);
  const w = [0, 1, 2].map((i) => Math.max(0, ...rows.map((r) => r[i].length)) + 3);
  return rows.map((r) => `${r[0].padEnd(w[0])}${r[1].padEnd(w[1])}${r[2].padEnd(w[2])}${r[3]}`.trimEnd()).join('\n');
}

export async function host(ctx: Ctx, verb: string | undefined, rest: string[]) {
  if (verb === undefined) throw new UsageError(helpFor(['host']));
  if (!['list', 'run', 'stop'].includes(verb)) throw new UsageError(`konnect host has no ${printable(verb)}: it is list, run or stop`);
  ctx.personOnly(`host ${verb}`);
  const team = ctx.team();

  if (verb === 'list') {
    if (rest.length) throw new UsageError(`konnect host list: unknown ${printable(rest.join(' '))}`);
    const client = await ctx.open(team);
    try {
      const hosts = await client.hosts();
      ctx.print(hosts.map(({ public_key: _, ...h }) => h), () => (hosts.length ? formatHosts(hosts) : `No machine of yours hosts in team ${team}. On one that should: konnect host run`));
    } finally { await client.close(); }
    return;
  }

  if (rest.length > 1) throw new UsageError(`konnect host ${verb} [<name>]: unknown ${printable(rest.slice(1).join(' '))}`);
  const name = named(rest[0], verb);
  const session = hostSession(team, name);

  if (verb === 'stop') {
    const kind = await multiplexer(ctx);
    const client = await ctx.open(team);
    try {
      if (kind && await running(ctx, kind, session)) {
        // Hosting in the background on this machine: its session is ended, and the service told.
        const r = kind === 'tmux' ? await exec(ctx)('tmux', ['kill-session', '-t', `=${session}`], ctx.cwd) : await exec(ctx)('screen', ['-S', session, '-X', 'quit'], ctx.cwd);
        if (r.code !== 0) throw new Error(`${kind} couldn't end ${session}: ${r.out.trim() || `it exited with ${r.code}`}`);
        await client.endHost(name).catch(() => undefined);
        ctx.print({ team, host: name, stopped: true }, () => `This machine no longer hosts as ${name} in team ${team}. Agents it started keep running: konnect agent stop <name> ends one.`);
        return;
      }
      const h = (await client.hosts()).find((x) => x.name === name);
      if (!h) throw new Refused(`no machine of yours hosts as ${name} in team ${team}: konnect host list shows yours`);
      if (h.serving) {
        // Hosting somewhere else (another machine, or another terminal here): it is asked to end itself.
        const a = await askHost<{ why?: string }>(ctx, client, name, 'end', { v: 1 });
        if (!a.ok) throw new Error(`${name} didn't stop hosting${typeof a.result.why === 'string' ? `: ${printable(a.result.why)}` : ''}`);
        ctx.print({ team, host: name, stopped: true }, () => `${name} no longer hosts in team ${team}. Agents it started keep running there.`);
        return;
      }
      await client.endHost(name);
      ctx.print({ team, host: name, stopped: false, forgotten: true }, () => `${name} wasn't hosting (it was last seen ${ago(h.seen_at)}): it is forgotten.`);
    } finally { await client.close(); }
    return;
  }

  // run
  const kind = await multiplexer(ctx);
  if (!kind) throw new Error('a machine that hosts keeps each harness it starts in tmux or screen, and neither is installed here: install tmux');
  const folder = shown(ctx.cwd, ctx.env);

  if (ctx.args.background) {
    if (await running(ctx, kind, session)) throw new Refused(`this machine hosts as ${name} in the background already: konnect host stop ${name} ends it`);
    // The login is tried here, where someone reads what it says, before a session nobody watches is started.
    const client = await ctx.open(team);
    await client.hosts().finally(() => client.close());
    const carried = Object.fromEntries(Object.entries({ KONNECT_URL: ctx.env.KONNECT_URL, KONNECT_CONFIG_DIR: ctx.env.KONNECT_CONFIG_DIR, XDG_CONFIG_HOME: ctx.env.XDG_CONFIG_HOME }).filter((e): e is [string, string] => !!e[1]));
    const me = (ctx.io.self ?? (() => konnectCommand(undefined, ctx.env)))();
    const went = await inSession(ctx, kind, session, `${hostFileReady(team, name, ctx.env).slice(0, -5)}.start.json`, { cmd: me.command, args: [...me.args, '--team', team, 'host', 'run', name], env: carried });
    if (went.code !== 0) throw new Error(`${kind} couldn't start hosting in the background: ${went.out.trim() || `it exited with ${went.code}`}`);
    ctx.print({ team, host: name, folder, session, in: kind }, () => [
      `This machine hosts for you in team ${team} as ${name}, in ${folder}, in the background (${kind} session ${session}).`,
      `  konnect agent run --on ${name} <name> claude     from any machine you are logged in on, start an agent here`,
      `  konnect host stop ${name}                        end it`,
    ].join('\n'));
    return;
  }

  const file = hostFileReady(team, name, ctx.env);
  let client = await ctx.open(team);
  const me = client.me.actor;
  let goodbye = true;
  try {
    // The newest konnect host run under a name on this machine hosts: an older one sees so and ends.
    const claim = randomBytes(12).toString('hex');
    const before = read(file);
    const kept: Kept = { ...(before ?? { instance: randomBytes(16).toString('hex'), ...newKeys() }), claim };
    write(file, kept);
    const mine = () => read(file)?.claim === claim;

    const beat = async () => client.serveHost({
      name, instance: kept.instance, public_key: kept.publicKey, folder,
      agents: loginsHere(team, ctx.env),
      running: await (async () => { const all = new Set(await sessions(ctx, kind)); return loginsHere(team, ctx.env).filter((l) => all.has(sessionName(team, l))); })(),
    });
    // Refused here when another machine, or another process, hosts under this name now.
    let waiting: HostRequest[];
    try { waiting = (await beat()).requests; } catch (e) {
      goodbye = false;
      if (e instanceof Refused) throw new Refused(e.message.replace(/kolab (\S+)/g, 'team $1'));
      throw e;
    }

    const say = (line: string) => ctx.err(`${new Date().toISOString().slice(11, 19)}  ${line}`);
    ctx.err([
      `This machine hosts for you (@${printable(me)}) in team ${team} as ${name}, in ${folder}.`,
      `From any machine you are logged in on: konnect agent run --on ${name} <name> claude`,
      'Only you can start an agent here, and only claude, codex or opencode with konnect\'s own options; what it may do here is set in its harness. Ctrl-C ends hosting.',
      ...(trusted(ctx.cwd, ctx.env) === false ? ['Claude Code hasn\'t been run in this folder: run claude here once and answer its question, or an agent started here waits at it.'] : []),
    ].join('\n'));

    let ended = false;
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((r) => { stop = r; });
    const end = () => { ended = true; stop(); };
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
    process.on('SIGHUP', end);
    (ctx.io.waking ?? (() => undefined))(end);

    const answer = async (req: HostRequest, ok: boolean, result: unknown) => {
      try { await client.answerHost(req.id, ok, JSON.stringify(result)); } catch (e) { say(`couldn't answer a request (${brief(e)})`); }
    };

    /** Whether the agent's login kept here works, as that agent of this person. */
    const works = async (label: string) => {
      const f = agentFile(team, label, ctx.env);
      if (!existsSync(f)) return false;
      try { await (await TeamClient.open(team, ctx.url, f, { kind: 'agent', label, owner: me })).close(); return true; } catch { return false; }
    };

    const start = async (req: HostRequest): Promise<[boolean, Started]> => {
      const r: Started = { v: 1, in: kind, folder, started: [], failed: [], needs_login: [], kept: [] };
      const asked = readStart(req.body);
      for (const a of asked.agents) {
        if (await running(ctx, kind, sessionName(team, a.name))) r.failed.push({ name: a.name, why: 'it is running there already' });
      }
      if (r.failed.length) return [false, r];
      // Each agent needs a login here: one kept here that works, else the one sent, sealed to this machine's key.
      for (const a of asked.agents) {
        if (await works(a.name)) continue;
        if (a.login === undefined) { r.needs_login.push(a.name); continue; }
        const f = agentFileReady(team, a.name, ctx.env);
        // What was kept here before is touched only once the login sent has been opened and read.
        let replaced = false;
        try {
          const o = JSON.parse(unseal(kept, a.login, bound(team, name, a.name))) as { client?: Record<string, unknown>; tokens?: Record<string, unknown> };
          const t = o?.tokens;
          if (!o || typeof o !== 'object' || !o.client || typeof o.client !== 'object' || typeof o.client.client_id !== 'string' || !t || typeof t !== 'object' || typeof t.access_token !== 'string' || typeof t.refresh_token !== 'string') throw new Error('not a login');
          // What is kept is the login alone, for this machine's own service: where to renew it is found
          // out here, never taken from the request.
          const tokens = Object.fromEntries(Object.entries({ access_token: t.access_token, refresh_token: t.refresh_token, token_type: typeof t.token_type === 'string' ? t.token_type : 'Bearer', expires_in: typeof t.expires_in === 'number' ? t.expires_in : undefined, scope: typeof t.scope === 'string' ? t.scope : undefined, issuer: typeof t.issuer === 'string' ? t.issuer : undefined }).filter(([, v]) => v !== undefined));
          replaced = true;
          await keepSignIn(ctx.url, f, { client: o.client as never, tokens: tokens as never });
          if (!await works(a.name)) throw new Error('not that agent\'s');
          r.kept.push(a.name);
        } catch {
          if (replaced) {
            await logout(ctx.url, { path: f, forget: true }).catch(() => undefined);
            dropIfEmpty(f);
          }
          r.failed.push({ name: a.name, why: 'the login sent for it couldn\'t be used there' });
        }
      }
      if (r.failed.length || r.needs_login.length) return [false, r];
      for (const a of asked.agents) {
        try {
          const s = await startInBackground(ctx, kind, { team, owner: me, name: a.name, tool: asked.harness, extra: [], said: { actFor: asked.act_for, wakeOn: asked.wake_on ?? [], systemPrompt: asked.system_prompt } });
          r.started.push({ name: a.name, session: s.session });
          say(`started ${a.name} in ${asked.harness} (${kind} session ${s.session})`);
        } catch (e) {
          r.failed.push({ name: a.name, why: brief(e) });
          say(`couldn't start ${a.name} in ${asked.harness}: ${brief(e)}`);
        }
      }
      if (asked.harness === 'claude' && trusted(ctx.cwd, ctx.env) === false) r.untrusted = true;
      return [r.failed.length === 0, r];
    };

    const handle = async (req: HostRequest) => {
      // The service gives a machine only its own person's requests; one from anyone else is never carried out.
      if (req.from !== me) { await answer(req, false, { v: 1, why: 'that request isn\'t from this machine\'s person' }); say('refused a request that wasn\'t yours'); return; }
      try {
        if (req.kind === 'start') { const [ok, r] = await start(req); await answer(req, ok, r); return; }
        if (req.kind === 'stop') {
          const { agent } = readStop(req.body);
          const s = sessionName(team, agent);
          if (!await running(ctx, kind, s)) { await answer(req, false, { v: 1, why: `your agent ${agent} isn't running in the background there` }); return; }
          const went = kind === 'tmux' ? await exec(ctx)('tmux', ['kill-session', '-t', `=${s}`], ctx.cwd) : await exec(ctx)('screen', ['-S', s, '-X', 'quit'], ctx.cwd);
          if (went.code !== 0) { await answer(req, false, { v: 1, why: `${kind} couldn't end ${s}` }); return; }
          say(`stopped ${agent}`);
          await answer(req, true, { v: 1, stopped: true });
          return;
        }
        if (req.kind === 'end') { await answer(req, true, { v: 1, ended: true }); say('asked to stop hosting'); end(); return; }
        await answer(req, false, { v: 1, why: 'this konnect doesn\'t know that kind of request: update konnect on that machine' });
      } catch (e) {
        await answer(req, false, { v: 1, why: brief(e), started: [], failed: [], needs_login: [], kept: [] });
        say(`refused a request: ${brief(e)}`);
      }
    };

    let unreached = 0;
    while (!ended) {
      for (const req of waiting) { if (ended) break; await handle(req); }
      waiting = [];
      if (ended) break;
      await Promise.race([ctx.pause(unreached ? Math.min(TICK_MS * 2 ** unreached, RETRY_MS) : TICK_MS), stopped]);
      if (ended) break;
      if (!mine()) { goodbye = false; say(`another konnect host run hosts as ${name} on this machine now: this one ends`); break; }
      try {
        waiting = (await beat()).requests;
        if (unreached) say('the service is reached again');
        unreached = 0;
      } catch (e) {
        // A login that has ended, or a name another machine took: nothing here mends it. Anything else is tried again.
        if (e instanceof SignInError || e instanceof Refused || e instanceof NotYet) { goodbye = false; throw e instanceof Refused ? new Refused(e.message.replace(/kolab (\S+)/g, 'team $1')) : e; }
        if (!unreached) say(`the service can't be reached (${brief(e)}): trying again`);
        unreached++;
        await client.close();
        try { client = await ctx.open(team); } catch (again) { if (again instanceof SignInError) { goodbye = false; throw again; } }
      }
    }
    process.off('SIGINT', end);
    process.off('SIGTERM', end);
    process.off('SIGHUP', end);
    if (goodbye) ctx.err(`This machine no longer hosts as ${name}. Agents it started keep running: konnect agent list shows them.`);
  } finally {
    // Said to the service, so the list doesn't show a machine that is gone; only while it is still this one.
    if (goodbye) { const k = read(file); if (k) await client.endHost(name, k.instance).catch(() => undefined); }
    await client.close();
  }
}
