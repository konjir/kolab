/**
 * Asking a machine of your own that hosts (`konnect host run`, cmd-host.ts) to start or stop one of
 * your agents there:
 *
 *   konnect host pair <machine> [<code>]                     once, on each machine that may ask
 *   konnect agent run --on <machine> [options] <name> <harness>
 *   konnect agent stop --on <machine> <name>
 *
 * A request travels through the service, which gives it to that machine alone, and only from your
 * own login. The machine doesn't take the service's word for it: a request is sealed with a key
 * made from the machine's pairing code (seal.ts), which the service never sees, and the machine
 * carries out only what opens with it. Its answer comes back sealed the same way.
 *
 * A request carries no command: it names agents of yours, one of the harnesses konnect starts, and
 * konnect's own options. What follows the harness on a command line is not sent; what an agent may
 * do on a machine is set on that machine.
 *
 * An agent that has no login on that machine yet is allowed here, in your browser, as any new
 * agent is; its login travels inside the sealed request, and is revoked from here if the machine
 * doesn't keep it.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { revokeIssued } from '@konjir/login';
import { ACT_FOR, type ActFor } from './args.js';
import { HARNESSES, checkLabel, issueAgents, listenList, type Issued, type Tool } from './agents.js';
import { Refused, SignInError, type Host, type HostRequest, type TeamClient } from './client.js';
import type { Ctx } from './context.js';
import { UsageError } from './errors.js';
import { printable } from './names.js';
import { CODE, fingerprint, keyOf, seal, unseal } from './seal.js';
import { hostFile, pairFile, pairFileReady } from './teams.js';

/** A hosting machine's name, as the service takes one. */
export const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The most words of the person's own a request carries as an agent's system prompt. */
export const MAX_PROMPT = 16_000;
/** How far apart the two machines' clocks may be: a request older or newer than this is refused, so one kept and sent again later does nothing. */
export const REQUEST_FRESH_MS = 10 * 60_000;
/** How often the asker looks for the answer, how long it waits for one, and how many looks in a row may fail to reach the service. */
const LOOK_EVERY_MS = 1_000, ANSWER_WAIT_MS = 150_000, LOOKS_UNREACHED = 20;

/** What sets an agent's system prompt: from the command line or, on a machine that hosts, from a request. */
export interface Said { actFor?: ActFor; wakeOn: string[]; systemPrompt?: string }

/** A login as it travels in a request: the client it was issued to, and its tokens. Where to renew it is never part of it. */
export interface SentLogin { client: Record<string, unknown>; tokens: Record<string, unknown> }

/** What every request carries: when it was made, and a word of its own, so that none is carried out twice. */
export interface Asked { v: 1; at: number; id: string }

/** What a request to start agents carries. Nothing here is a command, a path or a harness's argument. */
export interface Start extends Asked {
  harness: Tool;
  agents: { name: string; login?: SentLogin }[];
  act_for?: ActFor; wake_on?: string[]; system_prompt?: string;
}
/** What the machine answers a start with. */
export interface Started {
  v: 1; ok: boolean; why?: string; in?: 'tmux' | 'screen'; folder?: string;
  started: { name: string; session: string }[];
  failed: { name: string; why: string }[];
  /** Agents whose login kept there no longer works, and none was sent: nothing was started. */
  needs_login: string[];
  /** Agents whose sent login the machine kept. A login sent and not named here was not kept. */
  kept: string[];
  /** Whether Claude Code has been run in the machine's folder: when it hasn't, it waits there at its question. */
  untrusted?: boolean;
}

export function checkHost(given: string | undefined, usage = 'name the machine, such as desktop'): string {
  if (given === undefined) throw new UsageError(usage);
  if (!HOST_NAME.test(given)) throw new UsageError(`${printable(given)} isn't a machine's name: lowercase letters, digits and -, at most 40 characters, such as desktop`);
  return given;
}

/** What a sealed request is: of one kind, for one machine in one team. */
export const requestBound = (kind: string, team: string, host: string) => `konnect host request v1\n${kind}\n${team}\n${host}`;
/** What a sealed answer is: the answer to one request (its own word), from one machine in one team. */
export const answerBound = (team: string, host: string, id: string) => `konnect host answer v1\n${team}\n${host}\n${id}`;

// ---- pairing: the code of a machine this one may ask ---------------------------------------------

/** The code this machine keeps for `host`: one it was paired with, or its own, when it is the machine that hosts under that name. */
export function pairedCode(team: string, host: string, env: Record<string, string | undefined>): string | undefined {
  for (const file of [pairFile(team, host, env), hostFile(team, host, env)]) {
    try {
      const code = (JSON.parse(readFileSync(file, 'utf8')) as { code?: unknown }).code;
      if (typeof code === 'string' && CODE.test(code)) return code;
    } catch { /* none kept there */ }
  }
  return undefined;
}

/** Keeps `host`'s code on this machine, the person's alone. */
export function keepPairing(team: string, host: string, code: string, env: Record<string, string | undefined>) {
  const file = pairFileReady(team, host, env);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ code }), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
}

/** The key this machine asks `host` with; Refused, saying how to pair, when it has none, or the machine's code has changed since. */
export function pairing(ctx: Ctx, team: string, host: Host): Buffer {
  const name = printable(host.name);
  const code = pairedCode(team, host.name, ctx.env);
  if (!code) throw new Refused(`this machine isn't paired with ${name}: pair it once with konnect host pair ${name} <code>, the code konnect host run shows on ${name}`);
  const key = keyOf(code, team, host.name);
  if (host.public_key !== fingerprint(key, team, host.name)) throw new Refused(`${name}'s code isn't the one this machine was paired with: pair again with konnect host pair ${name} <code>, the code konnect host run shows on ${name}`);
  return key;
}

// ---- what a request may hold, read on the machine that hosts --------------------------------------

const only = (o: Record<string, unknown>, keys: string[], what: string) => {
  const more = Object.keys(o).filter((k) => !keys.includes(k));
  if (more.length) throw new Error(`${what} holds ${printable(more.join(', ')).slice(0, 200)}, which this konnect doesn't know: update konnect on this machine`);
};

const NOT_OURS = 'the request isn\'t one konnect wrote';

/** A request, opened: an object that says when it was made and carries a word of its own. */
function asked(text: string): Record<string, unknown> & Asked {
  let b: Record<string, unknown>;
  try { b = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(NOT_OURS); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error(NOT_OURS);
  if (b.v !== 1) throw new Error('the request is from a newer konnect than this machine\'s: update konnect on this machine');
  if (typeof b.at !== 'number' || !Number.isFinite(b.at) || typeof b.id !== 'string' || !/^[a-f0-9]{32}$/.test(b.id)) throw new Error(NOT_OURS);
  return b as Record<string, unknown> & Asked;
}

/** What of a client or of tokens is kept: plain values and lists of words, by the names given. Nothing nested, so nothing that says where a login is renewed. */
const plain = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.flatMap((k) => {
  const v = Object.hasOwn(o, k) ? o[k] : undefined;
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || (Array.isArray(v) && v.every((x) => typeof x === 'string')) ? [[k, v]] : [];
}));

/** A login sent in a request, as the machine keeps it. Throws when it isn't one. */
function sentLogin(given: unknown, name: string): SentLogin {
  const l = given as { client?: Record<string, unknown>; tokens?: Record<string, unknown> };
  const bad = new Error(`the login sent for ${name} isn't a login`);
  if (!l || typeof l !== 'object' || Array.isArray(l) || !l.client || typeof l.client !== 'object' || !l.tokens || typeof l.tokens !== 'object') throw bad;
  const client = plain(l.client, ['client_id', 'client_secret', 'client_id_issued_at', 'client_secret_expires_at', 'client_name', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'scope', 'issuer']);
  const tokens = plain(l.tokens, ['access_token', 'refresh_token', 'token_type', 'expires_in', 'scope', 'issuer']);
  if (typeof client.client_id !== 'string' || typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') throw bad;
  return { client, tokens };
}

/**
 * A start request, opened and read on the machine that hosts: every part checked, and anything it
 * doesn't know refused, never ignored. Throws, saying why.
 */
export function readStart(text: string): Start {
  const b = asked(text);
  only(b, ['v', 'at', 'id', 'harness', 'agents', 'act_for', 'wake_on', 'system_prompt'], 'the request');
  if (typeof b.harness !== 'string' || !(HARNESSES as readonly string[]).includes(b.harness)) throw new Error('the request names no harness konnect starts: claude, codex or opencode');
  if (!Array.isArray(b.agents) || b.agents.length < 1 || b.agents.length > 10) throw new Error('the request names no agents, or more than 10');
  const agents = b.agents.map((a: unknown) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('the request names an agent konnect can\'t read');
    const { name, login } = a as { name?: unknown; login?: unknown };
    only(a as Record<string, unknown>, ['name', 'login'], 'an agent in the request');
    if (typeof name !== 'string') throw new Error('the request names an agent konnect can\'t read');
    checkLabel(name);
    return { name, ...(login !== undefined ? { login: sentLogin(login, name) } : {}) };
  });
  if (new Set(agents.map((a) => a.name)).size !== agents.length) throw new Error('the request names an agent twice');
  if (b.act_for !== undefined && !ACT_FOR.includes(b.act_for as ActFor)) throw new Error('the request\'s act_for isn\'t nobody, me or team');
  let wakeOn: string[] | undefined;
  if (b.wake_on !== undefined) {
    if (!Array.isArray(b.wake_on) || b.wake_on.length > 20 || b.wake_on.some((c) => typeof c !== 'string' || c.includes(','))) throw new Error('the request\'s wake_on isn\'t a list of at most 20 channels');
    try { wakeOn = listenList(b.wake_on.join(',')); } catch { throw new Error('the request\'s wake_on names something that isn\'t a channel'); }
  }
  // A command line and an environment can't carry a NUL, so a prompt holding one would start nothing.
  if (b.system_prompt !== undefined && (typeof b.system_prompt !== 'string' || b.system_prompt.length > MAX_PROMPT || b.system_prompt.includes('\0'))) throw new Error(`the request's system prompt isn't text of at most ${MAX_PROMPT} characters`);
  return {
    v: 1, at: b.at, id: b.id, harness: b.harness as Tool, agents,
    ...(b.act_for !== undefined ? { act_for: b.act_for as ActFor } : {}),
    ...(wakeOn?.length ? { wake_on: wakeOn } : {}),
    ...(typeof b.system_prompt === 'string' && b.system_prompt.trim() ? { system_prompt: b.system_prompt } : {}),
  };
}

/** A stop request, opened and read on the machine that hosts. */
export function readStop(text: string): Asked & { agent: string } {
  const b = asked(text);
  only(b, ['v', 'at', 'id', 'agent'], 'the request');
  if (typeof b.agent !== 'string') throw new Error(NOT_OURS);
  return { v: 1, at: b.at, id: b.id, agent: checkLabel(b.agent) };
}

/** A request to end hosting, opened and read on the machine that hosts. */
export function readEnd(text: string): Asked {
  const b = asked(text);
  only(b, ['v', 'at', 'id'], 'the request');
  return { v: 1, at: b.at, id: b.id };
}

// ---- asking ----------------------------------------------------------------------------------------

/** How long ago `at` was, in a few words. */
export function ago(at: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(s)) return 'some time ago';
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/** The machine named, which must be the person's and hosting now; Refused, saying what to do, when it isn't. */
export async function hostingNow(client: TeamClient, team: string, name: string): Promise<Host> {
  const hosts = await client.hosts();
  const h = hosts.find((x) => x.name === name);
  if (!h) {
    const yours = hosts.filter((x) => x.serving).map((x) => printable(x.name));
    throw new Refused(`no machine of yours is hosting as ${name} in team ${team}${yours.length ? ` (${yours.join(', ')} ${yours.length === 1 ? 'is' : 'are'})` : ''}: on that machine, run konnect host run ${name}`);
  }
  if (!h.serving) throw new Refused(`${name} isn't hosting now (it was last seen ${ago(h.seen_at)}): on that machine, run konnect host run ${name}`);
  return h;
}

/**
 * Asks the machine and waits for its answer, which only that machine could have written: it is
 * sealed with the pairing key, as the answer to this request and no other. Throws when the machine
 * never took the request (it lapses after a minute, and is never taken after), took it and didn't
 * answer in time, or answered with something the key doesn't open.
 */
export async function askHost<T extends { ok?: boolean }>(ctx: Ctx, client: TeamClient, team: string, host: string, key: Buffer, kind: HostRequest['kind'], inner: Record<string, unknown>): Promise<T> {
  const id = randomBytes(16).toString('hex');
  const { request } = await client.askHost(host, kind, seal(key, JSON.stringify({ v: 1, at: Date.now(), id, ...inner }), requestBound(kind, team, host)));
  const unknown = `it may have been carried out all the same: look at konnect agent list, and at konnect host run on ${host}`;
  let unreached = 0;
  for (let waited = 0; waited < ANSWER_WAIT_MS; waited += LOOK_EVERY_MS) {
    await ctx.pause(LOOK_EVERY_MS);
    let r;
    try { r = await client.hostRequest(request); unreached = 0; } catch (e) {
      // A look that didn't reach the service is tried again: the request is on its way all the same.
      if (e instanceof Refused || e instanceof SignInError || ++unreached >= LOOKS_UNREACHED) throw new Error(`${host}'s answer couldn't be read (${printable(String((e as Error)?.message ?? e))}): ${unknown}`);
      continue;
    }
    if (r.state === 'expired') throw new Error(`${host} didn't take the request in time, so nothing was done there: check that konnect host run is still running on it`);
    if (r.state !== 'done') continue;
    let said: string;
    try { said = unseal(key, r.result ?? '', answerBound(team, host, id)); } catch {
      // The one thing a machine says unsealed: that it couldn't open the request.
      let why: unknown;
      try { why = (JSON.parse(r.result ?? '{}') as { why?: unknown }).why; } catch { /* nothing readable */ }
      if (why === 'unpaired') throw new Refused(`${host} couldn't open the request: its code isn't the one this machine was paired with, so nothing was done there. Pair again with konnect host pair ${host} <code>`);
      throw new Error(`${host}'s answer wasn't sealed with its code, so it isn't taken as its own: ${unknown}`);
    }
    try { const a = JSON.parse(said) as T; if (a && typeof a === 'object' && !Array.isArray(a)) return a; } catch { /* said below */ }
    throw new Error(`${host}'s answer isn't one this konnect can read: update konnect on this machine`);
  }
  throw new Error(`${host} took the request and hasn't answered: ${unknown}`);
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** `konnect agent run --on <machine> …`: the agents, started on that machine in the background. */
export async function runOn(ctx: Ctx, team: string, givens: { name: string; owner?: string }[], tool: Tool, said: Said, mine: (g: { name: string; owner?: string }, me: string) => void, command: string) {
  const hostName = checkHost(ctx.args.on);
  if (said.systemPrompt !== undefined && (said.systemPrompt.length > MAX_PROMPT || said.systemPrompt.includes('\0'))) throw new UsageError(`--system-prompt is text of at most ${MAX_PROMPT} characters when it is sent to another machine`);
  const names = givens.map((g) => g.name);
  const client = await ctx.openAsPerson(team);
  // A login this run was issued and sent, until the machine says it kept it: whatever it didn't keep is revoked.
  const sent = new Map<string, { issued: Issued; tokens: Issued['agents'][number]['tokens'] }>();
  const revoke = async (labels: string[]) => {
    for (const l of labels) {
      const s = sent.get(l);
      if (!s) continue;
      sent.delete(l);
      await revokeIssued(ctx.url, s.issued.client, [s.tokens]);
    }
  };
  // Interrupted while it waits: nothing says the machine kept a login, so none is left out there.
  const interrupted = () => { void revoke([...sent.keys()]).finally(() => process.exit(130)); };
  process.on('SIGINT', interrupted);
  try {
    const me = client.me.actor;
    for (const g of givens) mine(g, me);
    const host = await hostingNow(client, team, hostName);
    const key = pairing(ctx, team, host);
    const there = names.filter((n) => host.running.includes(n));
    if (there.length) throw new Refused(`your agent ${there[0]} is running on ${hostName} already: konnect agent stop --on ${hostName} ${there[0]} ends it`);

    const made = new Map<string, boolean>();
    let need = names.filter((n) => !host.agents.includes(n));
    let answer: Partial<Started> = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      if (need.length) {
        ctx.needsTerminal(`konnect ${command}`);
        const issued = await issueAgents(team, ctx.url, need, { open: ctx.io.open, log: ctx.err }, `run konnect ${command} again`);
        for (const a of issued.agents) { sent.set(a.label, { issued, tokens: a.tokens }); made.set(a.label, a.made); }
      }
      try {
        answer = await askHost<Partial<Started>>(ctx, client, team, hostName, key, 'start', {
          harness: tool,
          agents: names.map((name) => {
            const s = need.includes(name) ? sent.get(name) : undefined;
            return { name, ...(s ? { login: { client: s.issued.client, tokens: s.tokens } } : {}) };
          }),
          ...(said.actFor && said.actFor !== 'nobody' ? { act_for: said.actFor } : {}),
          ...(said.wakeOn.length ? { wake_on: said.wakeOn } : {}),
          ...(said.systemPrompt?.trim() ? { system_prompt: said.systemPrompt } : {}),
        });
      } catch (e) {
        // Nothing says the machine kept a login: none is left out there unaccounted for.
        await revoke([...sent.keys()]);
        throw e;
      }
      const kept = list(answer.kept);
      await revoke([...sent.keys()].filter((l) => !kept.includes(l)));
      for (const l of kept) sent.delete(l);
      need = list(answer.needs_login).filter((n) => names.includes(n));
      if (!need.length) break;
    }
    const r = answer;
    const started = (Array.isArray(r.started) ? r.started : []).filter((s) => s && typeof s.name === 'string' && typeof s.session === 'string' && names.includes(s.name));
    const failed = (Array.isArray(r.failed) ? r.failed : []).filter((f) => f && typeof f.name === 'string' && typeof f.why === 'string' && names.includes(f.name));
    const running = started.length ? ` ${started.map((s) => s.name).join(', ')} ${started.length === 1 ? 'is' : 'are'} running there: konnect agent stop --on ${hostName} <name> ends one.` : '';
    if (need.length) throw new Error(`${hostName} has no working login for ${need.join(', ')}, and the one sent wasn't kept there: run the command again`);
    if (r.ok !== true || failed.length || started.length !== names.length) {
      const why = failed.length ? failed.map((f) => `${f.name}: ${printable(f.why)}`).join('; ') : typeof r.why === 'string' ? printable(r.why) : 'it didn\'t say why';
      throw new Refused(`${hostName} didn't start ${failed.length ? failed.map((f) => f.name).join(', ') : 'what was asked'} (${why}).${running}`);
    }
    const where = `${hostName}${typeof r.folder === 'string' ? `, in ${printable(r.folder)}` : ''}`;
    const one = names.length === 1;
    const agents = names.map((n) => `@${printable(me)}/${n}`);
    ctx.print({ team, on: hostName, harness: tool, ...(typeof r.folder === 'string' ? { folder: r.folder } : {}), ...(r.in ? { in: r.in } : {}), agents: started.map((s) => ({ agent: `${me}/${s.name}`, session: s.session })) }, () => [
      one
        ? `Your agent ${agents[0]} is ${made.get(names[0]) ? 'added to' : 'in'} team ${team}, and ${tool} is running as it on ${where}.`
        : `Your agents ${agents.join(', ')} are in team ${team}, and ${tool} is running as each on ${where}.`,
      `  konnect agent stop --on ${hostName} ${names[0]}     end it`,
      `To look in on it, on ${hostName}: konnect agent attach ${names[0]}`,
      ...(r.untrusted && tool === 'claude' ? [`Claude Code hasn't been run in that folder: it waits at its question whether to trust it, until you answer on ${hostName}.`] : []),
    ].join('\n'));
  } finally {
    process.off('SIGINT', interrupted);
    await client.close();
  }
}

/** `konnect agent stop --on <machine> <name>`: ends the agent's background harness there. */
export async function stopOn(ctx: Ctx, team: string, given: { name: string; owner?: string }, mine: (g: { name: string; owner?: string }, me: string) => void) {
  const hostName = checkHost(ctx.args.on);
  const client = await ctx.openAsPerson(team);
  try {
    mine(given, client.me.actor);
    const key = pairing(ctx, team, await hostingNow(client, team, hostName));
    const a = await askHost<{ ok?: boolean; stopped?: boolean; why?: string }>(ctx, client, team, hostName, key, 'stop', { agent: given.name });
    if (a.ok !== true) throw new Refused(typeof a.why === 'string' ? `${hostName}: ${printable(a.why)}` : `${hostName} didn't stop ${given.name}, and didn't say why`);
    ctx.print({ team, on: hostName, agent: given.name, stopped: true }, () => `Stopped your agent ${given.name}'s harness on ${hostName}. It stays in team ${team}.`);
  } finally { await client.close(); }
}
