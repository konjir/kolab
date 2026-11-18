/**
 * The commands about the machines of yours that start your agents when you ask from another one:
 *
 *   konnect host list
 *   konnect host run [--background] [<name>]     this machine hosts, in this folder, until it is ended
 *   konnect host pair <name> [<code>]            once, on a machine that may ask <name>
 *   konnect host stop [<name>]
 *
 * A machine hosts only while `konnect host run` runs on it, as you, in the folder you ran it in.
 * It then takes requests from the service every few seconds. It carries out only a request that is
 * sealed with its pairing code (seal.ts), which it made itself and showed you, and which you gave
 * to each machine that may ask: the service never has it, so a request can't come from the
 * service, from a teammate, or from a copy of your login alone. (The code is in konnect's files on
 * the hosting and the paired machines: what runs there as the person, an agent with a shell among
 * it, can read it.) A request is carried out once, with a word this machine has just given for it
 * (a `hello`), so one kept and sent again later does nothing. A request names agents of yours, one of the harnesses konnect starts, and konnect's own
 * options; it carries no command, no path and no argument for the harness (host-ask.ts reads it,
 * and refuses anything it doesn't know). Each agent is started as `konnect agent run --background`
 * starts one here, in this folder. What that agent may then do on this machine is set here, in its
 * harness, never by the request.
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
import { earlierSessionName, endSession, inSession, multiplexer, running, sessionOf, sessionName, sessions, startInBackground } from './cmd-agent.js';
import type { Ctx } from './context.js';
import { UsageError } from './errors.js';
import { helpFor } from './help.js';
import { HOST_NAME, WORD_FRESH_MS, ago, answerBound, askHost, checkHost, keepPairing, pairing, readEnd, readHello, readStart, readStop, requestBound, type Asked, type Started } from './host-ask.js';
import { printable } from './names.js';
import { CODE, fingerprint, keyOf, newCode, readCode, seal, unseal } from './seal.js';
import { agentFile, agentFileReady, dropIfEmpty, hostFile, hostFileReady } from './teams.js';

/** How often a hosting machine tells the service it is there and takes what waits for it. */
const TICK_MS = 3_000;
/** While the service can't be reached, how long between tries, at most. */
const RETRY_MS = 30_000;

/** What a machine keeps of hosting under one name: who it is to the service, its pairing code, and whose turn it is. */
interface Kept { instance: string; code: string; claim?: string }

const read = (file: string): Kept | undefined => {
  try {
    const k = JSON.parse(readFileSync(file, 'utf8')) as Kept;
    return k && typeof k.instance === 'string' && /^[a-f0-9]{16,64}$/.test(k.instance) && typeof k.code === 'string' && CODE.test(k.code) ? k : undefined;
  } catch { return undefined; }
};
const write = (file: string, kept: Kept) => {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
};

/**
 * What this machine keeps of hosting as `name`, made now if it kept nothing: the code is made once,
 * and stays until `fresh` asks for a new one (konnect host run --new-code), after which every
 * machine paired with the old one must pair again.
 */
function keptHere(team: string, name: string, env: Record<string, string | undefined>, fresh = false): { file: string; kept: Kept; renewed: boolean } {
  const file = hostFileReady(team, name, env);
  const before = read(file);
  if (before && !fresh) return { file, kept: before, renewed: false };
  const made: Kept = { instance: before?.instance ?? randomBytes(16).toString('hex'), code: newCode() };
  write(file, made);
  return { file, kept: made, renewed: !!before };
}

/** Said with a code that has just replaced another. */
const RENEWED = 'This is a new code: a machine paired with the old one is refused until it is paired again.';

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

/** How another machine is paired with this one: said where hosting starts, and in the list, on the machine that hosts. */
const pairLine = (name: string, code: string) => `  konnect host pair ${name} ${code}`;

/** One line for each machine: its name, whether it hosts now, its folder, and the agents running there. */
export function formatHosts(hosts: Host[], now = Date.now()): string {
  const rows = hosts.map((h) => [printable(h.name), h.serving ? 'hosting' : `last seen ${ago(h.seen_at, now)}`, h.folder ? printable(h.folder) : '', h.serving && h.running.length ? `running: ${h.running.map(printable).join(', ')}` : '']);
  const w = [0, 1, 2].map((i) => Math.max(0, ...rows.map((r) => r[i].length)) + 3);
  return rows.map((r) => `${r[0].padEnd(w[0])}${r[1].padEnd(w[1])}${r[2].padEnd(w[2])}${r[3]}`.trimEnd()).join('\n');
}

export async function host(ctx: Ctx, verb: string | undefined, rest: string[]) {
  if (verb === undefined) throw new UsageError(helpFor(['host']));
  if (!['list', 'run', 'pair', 'stop'].includes(verb)) throw new UsageError(`konnect host has no ${printable(verb)}: it is list, run, pair or stop`);
  ctx.personOnly(`host ${verb}`);
  const team = ctx.team();

  if (verb === 'list') {
    if (rest.length) throw new UsageError(`konnect host list: unknown ${printable(rest.join(' '))}`);
    const client = await ctx.open(team);
    try {
      const hosts = await client.hosts();
      // On the machine that hosts, its code is said again, for pairing another machine with it.
      const here = hosts.flatMap((h) => { const k = HOST_NAME.test(h.name) ? read(hostFile(team, h.name, ctx.env)) : undefined; return k && h.public_key === fingerprint(keyOf(k.code, team, h.name), team, h.name) ? [pairLine(h.name, k.code)] : []; });
      ctx.print(hosts.map(({ public_key: _, ...h }) => h), () => (hosts.length
        ? [formatHosts(hosts), ...(here.length ? ['', 'To ask this machine from another machine of yours, pair that machine once, there:', ...here] : [])].join('\n')
        : `No machine of yours hosts in team ${team}. On one that should: konnect host run`));
    } finally { await client.close(); }
    return;
  }

  if (verb === 'pair') {
    const name = checkHost(rest[0], 'konnect host pair <name> [<code>]: name the machine, then the code konnect host run shows on it');
    if (rest.length > 2) throw new UsageError(`konnect host pair <name> [<code>]: unknown ${printable(rest.slice(2).join(' '))}`);
    // The code, or with none given, a line of standard input: so it needn't be left in the shell's history.
    const given = rest[1] ?? (await (ctx.io.stdin ?? (async () => { let t = ''; for await (const c of process.stdin) t += c; return t; }))()).trim();
    const code = readCode(given);
    if (!code) throw new UsageError(`that isn't a pairing code: it is six groups of four letters and digits, as konnect host run shows on ${name}`);
    const client = await ctx.open(team);
    try {
      const h = (await client.hosts()).find((x) => x.name === name);
      if (!h) throw new Refused(`no machine of yours hosts as ${name} in team ${team}: on that machine, run konnect host run ${name}`);
      // Checked against what the machine published, so a mistyped code is said now, not at the first request.
      if (h.public_key !== fingerprint(keyOf(code, team, name), team, name)) throw new Refused(`that isn't ${name}'s code: it is the one konnect host run shows on ${name}, or konnect host list there`);
      keepPairing(team, name, code, ctx.env);
      ctx.print({ team, host: name, paired: true }, () => `Paired with ${name}. From this machine: konnect agent run --on ${name} <name> claude`);
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
        const r = await endSession(ctx, kind, session);
        if (r.code !== 0) throw new Error(`${kind} couldn't end ${session}: ${r.out.trim() || `it exited with ${r.code}`}`);
        // Told once the session's last word to the service, if one was on its way, has landed: or that word would list it as hosting again.
        await ctx.pause(1_500);
        await client.endHost(name).catch(() => undefined);
        ctx.print({ team, host: name, stopped: true }, () => `This machine no longer hosts as ${name} in team ${team}. Agents it started keep running: konnect agent stop <name> ends one.`);
        return;
      }
      const h = (await client.hosts()).find((x) => x.name === name);
      if (!h) throw new Refused(`no machine of yours hosts as ${name} in team ${team}: konnect host list shows yours`);
      if (h.serving) {
        // Hosting somewhere else (another machine, or another terminal here): it is asked to end itself.
        const key = pairing(ctx, team, h);
        let a: { ok?: boolean; why?: string };
        let confirmed = true;
        try { a = await askHost<{ ok?: boolean; why?: string }>(ctx, client, team, name, key, 'end', {}); } catch (e) {
          // A machine that ends says so to the service, and its requests go with it, its answer among
          // them. One no longer listed as hosting has most likely ended; but that is the service's
          // word, not the machine's own, and it is said as that.
          if ((await client.hosts()).some((x) => x.name === name && x.serving)) throw e;
          a = { ok: true };
          confirmed = false;
        }
        if (a.ok !== true) throw new Error(`${name} didn't stop hosting${typeof a.why === 'string' ? `: ${printable(a.why)}` : ''}`);
        ctx.print({ team, host: name, stopped: true, confirmed }, () => (confirmed
          ? `${name} no longer hosts in team ${team}. Agents it started keep running there.`
          : `${name} is no longer listed as hosting in team ${team}, though its own answer didn't arrive: konnect host list shows whether it comes back. Agents it started keep running there.`));
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
    const carried = Object.fromEntries(Object.entries({ KONNECT_URL: ctx.env.KONNECT_URL, XDG_CONFIG_HOME: ctx.env.XDG_CONFIG_HOME }).filter((e): e is [string, string] => !!e[1]));
    const me = (ctx.io.self ?? (() => konnectCommand(undefined, ctx.env)))();
    const mine = keptHere(team, name, ctx.env, ctx.args.newCode);
    const went = await inSession(ctx, kind, session, mine.file.slice(0, -5), { cmd: me.command, args: [...me.args, '--team', team, 'host', 'run', name], env: carried });
    if (went.code !== 0) throw new Error(`${kind} couldn't start hosting in the background: ${went.out.trim() || `it exited with ${went.code}`}`);
    // A session that is gone a moment later hosts nothing.
    await ctx.pause(800);
    if (!await running(ctx, kind, session)) throw new Error(`hosting ended as soon as it was started in the background: run konnect host run ${name} in a terminal here to see why`);
    ctx.print({ team, host: name, folder, session, in: kind }, () => [
      `This machine hosts for you in team ${team} as ${name}, in ${folder}, in the background (${kind} session ${session}).`,
      'To ask it from another machine of yours, pair that machine once, there:',
      pairLine(name, mine.kept.code),
      ...(mine.renewed ? [RENEWED] : []),
      `Then, from it: konnect agent run --on ${name} <name> claude`,
      `To end hosting: konnect host stop ${name}`,
    ].join('\n'));
    return;
  }

  let client = await ctx.open(team);
  const me = client.me.actor;
  const { file, kept: before, renewed } = keptHere(team, name, ctx.env, ctx.args.newCode);
  // The newest konnect host run under a name on this machine hosts: an older one sees so and ends.
  const claim = randomBytes(12).toString('hex');
  const mine: Kept = { ...before, claim };
  write(file, mine);
  const stillMine = () => read(file)?.claim === claim;
  const key = keyOf(mine.code, team, name);
  let goodbye = true;
  try {
    const beat = async (): Promise<HostRequest[]> => {
      const all = new Set(await sessions(ctx, kind));
      const logins = loginsHere(team, ctx.env);
      const r = await client.serveHost({ name, instance: mine.instance, public_key: fingerprint(key, team, name), folder, agents: logins, running: logins.filter((l) => all.has(sessionName(team, l)) || all.has(earlierSessionName(team, l))) });
      // Whatever the service gives in place of requests, only what could be one is looked at.
      return (Array.isArray(r?.requests) ? r.requests : []).filter((q) => !!q && typeof q === 'object' && typeof q.id === 'string' && typeof q.body === 'string' && typeof q.kind === 'string');
    };
    // Refused here when another machine, or another process, hosts under this name now.
    let waiting: HostRequest[];
    try { waiting = await beat(); } catch (e) {
      goodbye = false;
      if (e instanceof Refused) throw new Refused(e.message.replace(/kolab (\S+)/g, 'team $1'));
      throw e;
    }

    const say = (line: string) => ctx.err(`${new Date().toISOString().slice(11, 19)}  ${line}`);
    ctx.err([
      `This machine hosts for you (@${printable(me)}) in team ${team} as ${name}, in ${folder}.`,
      'To ask it from another machine of yours, pair that machine once, there:',
      pairLine(name, mine.code),
      ...(renewed ? [RENEWED] : []),
      `Then, from it: konnect agent run --on ${name} <name> claude`,
      'It starts claude, codex or opencode as an agent of yours, with konnect\'s own options, and only for a machine paired with it; what the agent may do here is set in its harness. Ctrl-C ends hosting.',
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

    /**
     * The words this machine has given out and not yet taken, each with when it lapses. A request
     * is carried out only with one of them, once: so a request kept and sent again later, or sent
     * twice, or to a later run of this command, does nothing, whatever anyone's clock says.
     */
    const words = new Map<string, number>();
    const word = () => {
      const now = Date.now();
      for (const [w, until] of words) if (until < now) words.delete(w);
      // A hundred at once is more than anyone asks: the oldest goes, so memory stays small whatever is sent.
      if (words.size >= 100) words.delete(words.keys().next().value!);
      const w = randomBytes(16).toString('hex');
      words.set(w, now + WORD_FRESH_MS);
      return w;
    };
    /** Takes the request's word, once; refuses a request whose word this run never gave, has taken, or gave too long ago. */
    const fresh = (a: Asked) => {
      const until = words.get(a.word);
      words.delete(a.word);
      if (until === undefined || until < Date.now()) throw new Error('that request is no longer fresh: it was carried out already, or made too long ago, so nothing was done. Ask again');
    };
    /** What was answered of late, by the request's own name: a request delivered twice is answered the same twice, and carried out once. */
    const answered = new Map<string, string>();

    /** Whether the agent's login kept here works, as that agent of this person: no when there is none or it has ended, unknown when the service couldn't say. */
    const works = async (label: string): Promise<'yes' | 'no' | 'unknown'> => {
      const f = agentFile(team, label, ctx.env);
      if (!existsSync(f)) return 'no';
      try { await (await TeamClient.open(team, ctx.url, f, { kind: 'agent', label, owner: me })).close(); return 'yes'; } catch (e) { return e instanceof SignInError ? 'no' : 'unknown'; }
    };

    const start = async (text: string): Promise<Started & { id: string }> => {
      const asked = readStart(text);
      fresh(asked);
      const r: Started & { id: string } = { v: 1, id: asked.id, ok: false, in: kind, folder, started: [], failed: [], needs_login: [], kept: [] };
      for (const a of asked.agents) {
        if (await sessionOf(ctx, kind, team, a.name)) r.failed.push({ name: a.name, why: 'it is running there already' });
      }
      if (r.failed.length) return r;
      // Each agent needs a login here: one kept here that works, else the one sent.
      for (const a of asked.agents) {
        const has = await works(a.name);
        if (has === 'yes') continue;
        // The service couldn't say just now: what is kept here is left exactly as it is.
        if (has === 'unknown') { r.failed.push({ name: a.name, why: 'its login there couldn\'t be checked just now: try again' }); continue; }
        if (a.login === undefined) { r.needs_login.push(a.name); continue; }
        let f: string | undefined;
        try {
          f = agentFileReady(team, a.name, ctx.env);
          // Kept for this machine's own service: where to renew it is found out here, never taken from the request.
          await keepSignIn(ctx.url, f, { client: a.login.client as never, tokens: a.login.tokens as never });
          const now = await works(a.name);
          if (now === 'no') throw new Error('not that agent\'s');
          // Kept, and said to be: whoever sent it must not revoke a login this machine holds.
          r.kept.push(a.name);
          if (now === 'unknown') r.failed.push({ name: a.name, why: 'the login sent for it is kept there, but couldn\'t be checked just now: try again' });
        } catch {
          // What was there before had ended (the service said so); what was sent isn't this agent's login: neither is kept.
          if (f !== undefined) {
            await logout(ctx.url, { path: f, forget: true }).catch(() => undefined);
            dropIfEmpty(f);
          }
          r.failed.push({ name: a.name, why: 'the login sent for it couldn\'t be used there' });
        }
      }
      if (r.failed.length || r.needs_login.length) return r;
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
      r.ok = r.failed.length === 0;
      return r;
    };

    const handle = async (req: HostRequest) => {
      const answer = async (result: string) => { try { await client.answerHost(req.id, true, result); } catch (e) { say(`couldn't answer a request (${brief(e)})`); } };
      // Only what opens with this machine's code is read at all. Anything else is answered with one
      // word, unsealed, so a machine paired with an earlier code is told to pair again.
      let text: string;
      try { text = unseal(key, req.body, requestBound(req.kind, team, name)); } catch {
        say('refused a request that wasn\'t sealed with this machine\'s code');
        await answer(JSON.stringify({ v: 1, why: 'unpaired' }));
        return;
      }
      // Its answer is sealed too, as the answer to this request alone.
      let id = '';
      try { const b = JSON.parse(text) as { id?: unknown }; if (typeof b?.id === 'string' && /^[a-f0-9]{32}$/.test(b.id)) id = b.id; } catch { /* answered below, to no request's name */ }
      // The same request again (the service may deliver one twice): the same answer, and nothing done twice.
      const before = id ? answered.get(id) : undefined;
      if (before !== undefined) { await answer(before); return; }
      const sealed = async (a: object) => {
        const said = seal(key, JSON.stringify(a), answerBound(team, name, id));
        if (id) {
          if (answered.size >= 200) answered.delete(answered.keys().next().value!);
          answered.set(id, said);
        }
        await answer(said);
      };
      try {
        if (req.kind === 'hello') { readHello(text); await sealed({ v: 1, ok: true, word: word() }); return; }
        if (req.kind === 'start') { await sealed(await start(text)); return; }
        if (req.kind === 'stop') {
          const asked = readStop(text);
          fresh(asked);
          const s = await sessionOf(ctx, kind, team, asked.agent);
          if (!s) { await sealed({ v: 1, ok: false, why: `your agent ${asked.agent} isn't running in the background there` }); return; }
          const went = await endSession(ctx, kind, s);
          if (went.code !== 0) { await sealed({ v: 1, ok: false, why: `${kind} couldn't end ${s}` }); return; }
          say(`stopped ${asked.agent}`);
          await sealed({ v: 1, ok: true, stopped: true });
          return;
        }
        if (req.kind === 'end') {
          fresh(readEnd(text));
          await sealed({ v: 1, ok: true, ended: true });
          say('asked to stop hosting');
          // A moment for the asker to read the answer, before this machine's goodbye takes its requests with it.
          await ctx.pause(1_500);
          end();
          return;
        }
        await sealed({ v: 1, ok: false, why: 'this konnect doesn\'t know that kind of request: update konnect on that machine' });
      } catch (e) {
        await sealed({ v: 1, ok: false, why: brief(e), started: [], failed: [], needs_login: [], kept: [] });
        say(`refused a request: ${brief(e)}`);
      }
    };

    let unreached = 0;
    while (!ended) {
      for (const req of waiting) { if (ended) break; await handle(req).catch((e: unknown) => say(`a request couldn't be handled: ${brief(e)}`)); }
      waiting = [];
      if (ended) break;
      await Promise.race([ctx.pause(unreached ? Math.min(TICK_MS * 2 ** unreached, RETRY_MS) : TICK_MS), stopped]);
      if (!stillMine()) { goodbye = false; say(`another konnect host run hosts as ${name} on this machine now: this one ends`); break; }
      if (ended) break;
      try {
        waiting = await beat();
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
    // Said to the service, so the list doesn't show a machine that is gone; only while this run is still the one hosting here.
    if (goodbye && stillMine()) await client.endHost(name, mine.instance).catch(() => undefined);
    await client.close();
  }
}
