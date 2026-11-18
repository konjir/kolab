/**
 * Asking a machine of your own that hosts (`konnect host run`, cmd-host.ts) to start or stop one of
 * your agents there:
 *
 *   konnect agent run --on <machine> [options] <name> <harness>
 *   konnect agent stop --on <machine> <name>
 *
 * A request goes through the service, which gives it only to that machine, and only from you: a
 * person's own login, never an agent's. It carries no command: it names agents of yours, one of the
 * harnesses konnect starts, and konnect's own options. What follows the harness on a command line
 * is not sent; what an agent may do on a machine is set on that machine.
 *
 * An agent that has no login on that machine yet is allowed here, in your browser, as any new
 * agent is; its login is sent sealed to a key only that machine holds (seal.ts), and revoked from
 * here if the machine doesn't keep it.
 */
import { revokeIssued } from '@konjir/login';
import { ACT_FOR, type ActFor } from './args.js';
import { HARNESSES, checkLabel, issueAgents, listenList, type Issued, type Tool } from './agents.js';
import { Refused, type Host, type HostRequest, type TeamClient } from './client.js';
import type { Ctx } from './context.js';
import { UsageError } from './errors.js';
import { printable } from './names.js';
import { SEALED, seal } from './seal.js';

/** A hosting machine's name, as the service takes one. */
export const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The most words of the person's own a request carries as an agent's system prompt. */
export const MAX_PROMPT = 16_000;
/** How often the asker looks for the answer, and how long it waits for one. */
const LOOK_EVERY_MS = 1_000, ANSWER_WAIT_MS = 150_000;

/** What sets an agent's system prompt: from the command line or, on a machine that hosts, from a request. */
export interface Said { actFor?: ActFor; wakeOn: string[]; systemPrompt?: string }

/** What a request to start agents carries. Nothing here is a command, a path or a harness's argument. */
export interface Start {
  v: 1; harness: Tool;
  agents: { name: string; login?: string }[];
  act_for?: ActFor; wake_on?: string[]; system_prompt?: string;
}
/** What the machine answers a start with. */
export interface Started {
  v: 1; in?: 'tmux' | 'screen'; folder?: string;
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

/** What a sealed login is for: it opens for this team, machine and agent alone. */
export const bound = (team: string, host: string, name: string) => `konnect host login v1\n${team}\n${host}\n${name}`;

const only = (o: Record<string, unknown>, keys: string[], what: string) => {
  const more = Object.keys(o).filter((k) => !keys.includes(k));
  if (more.length) throw new Error(`${what} holds ${printable(more.join(', '))}, which this konnect doesn't know: update konnect on this machine`);
};

/**
 * A start request's body, read on the machine that hosts: every part checked, and anything it
 * doesn't know refused, never ignored. Throws, saying why.
 */
export function readStart(body: string): Start {
  let b: Record<string, unknown>;
  try { b = JSON.parse(body) as Record<string, unknown>; } catch { throw new Error('the request isn\'t one konnect wrote'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('the request isn\'t one konnect wrote');
  if (b.v !== 1) throw new Error('the request is from a newer konnect than this machine\'s: update konnect on this machine');
  only(b, ['v', 'harness', 'agents', 'act_for', 'wake_on', 'system_prompt'], 'the request');
  if (typeof b.harness !== 'string' || !(HARNESSES as readonly string[]).includes(b.harness)) throw new Error('the request names no harness konnect starts: claude, codex or opencode');
  if (!Array.isArray(b.agents) || b.agents.length < 1 || b.agents.length > 10) throw new Error('the request names no agents, or more than 10');
  const agents = b.agents.map((a: unknown) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('the request names an agent konnect can\'t read');
    const { name, login } = a as { name?: unknown; login?: unknown };
    only(a as Record<string, unknown>, ['name', 'login'], 'an agent in the request');
    if (typeof name !== 'string') throw new Error('the request names an agent konnect can\'t read');
    checkLabel(name);
    if (login !== undefined && (typeof login !== 'string' || login.length > 16_000 || !SEALED.test(login))) throw new Error(`the login sent for ${name} isn't a sealed login`);
    return { name, ...(login !== undefined ? { login: login as string } : {}) };
  });
  if (new Set(agents.map((a) => a.name)).size !== agents.length) throw new Error('the request names an agent twice');
  if (b.act_for !== undefined && !ACT_FOR.includes(b.act_for as ActFor)) throw new Error('the request\'s act_for isn\'t nobody, me or team');
  let wakeOn: string[] | undefined;
  if (b.wake_on !== undefined) {
    if (!Array.isArray(b.wake_on) || b.wake_on.length > 20 || b.wake_on.some((c) => typeof c !== 'string' || c.includes(','))) throw new Error('the request\'s wake_on isn\'t a list of at most 20 channels');
    try { wakeOn = listenList(b.wake_on.join(',')); } catch { throw new Error('the request\'s wake_on names something that isn\'t a channel'); }
  }
  if (b.system_prompt !== undefined && (typeof b.system_prompt !== 'string' || b.system_prompt.length > MAX_PROMPT)) throw new Error(`the request's system prompt isn't text of at most ${MAX_PROMPT} characters`);
  return {
    v: 1, harness: b.harness as Tool, agents,
    ...(b.act_for !== undefined ? { act_for: b.act_for as ActFor } : {}),
    ...(wakeOn?.length ? { wake_on: wakeOn } : {}),
    ...(typeof b.system_prompt === 'string' && b.system_prompt.trim() ? { system_prompt: b.system_prompt } : {}),
  };
}

/** A stop request's body, read on the machine that hosts. */
export function readStop(body: string): { agent: string } {
  let b: Record<string, unknown>;
  try { b = JSON.parse(body) as Record<string, unknown>; } catch { throw new Error('the request isn\'t one konnect wrote'); }
  if (!b || typeof b !== 'object' || Array.isArray(b) || b.v !== 1 || typeof b.agent !== 'string') throw new Error('the request isn\'t one this konnect can read: update konnect on this machine');
  only(b, ['v', 'agent'], 'the request');
  return { agent: checkLabel(b.agent) };
}

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
    const yours = hosts.filter((x) => x.serving).map((x) => x.name);
    throw new Refused(`no machine of yours is hosting as ${name} in team ${team}${yours.length ? ` (${yours.join(', ')} ${yours.length === 1 ? 'is' : 'are'})` : ''}: on that machine, run konnect host run ${name}`);
  }
  if (!h.serving) throw new Refused(`${name} isn't hosting now (it was last seen ${ago(h.seen_at)}): on that machine, run konnect host run ${name}`);
  return h;
}

/**
 * Asks the machine and waits for its answer. Throws when the machine never took the request (it
 * lapses after a minute, and is never taken after), or took it and didn't answer in time.
 */
export async function askHost<T>(ctx: Ctx, client: TeamClient, host: string, kind: HostRequest['kind'], body: unknown): Promise<{ ok: boolean; result: T }> {
  const { request } = await client.askHost(host, kind, JSON.stringify(body));
  for (let waited = 0; waited < ANSWER_WAIT_MS; waited += LOOK_EVERY_MS) {
    await ctx.pause(LOOK_EVERY_MS);
    const r = await client.hostRequest(request);
    if (r.state === 'done') {
      let result: unknown = {};
      try { result = JSON.parse(r.result ?? '{}'); } catch { /* an answer konnect can't read says nothing */ }
      return { ok: r.ok === true, result: (result && typeof result === 'object' ? result : {}) as T };
    }
    if (r.state === 'expired') throw new Error(`${host} didn't take the request in time, so nothing was done there: check that konnect host run is still running on it`);
  }
  throw new Error(`${host} took the request and hasn't answered: look at konnect host run there, and at konnect agent list`);
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** `konnect agent run --on <machine> …`: the agents, started on that machine in the background. */
export async function runOn(ctx: Ctx, team: string, givens: { name: string; owner?: string }[], tool: Tool, said: Said, mine: (g: { name: string; owner?: string }, me: string) => void, command: string) {
  const hostName = checkHost(ctx.args.on);
  if (said.systemPrompt !== undefined && said.systemPrompt.length > MAX_PROMPT) throw new UsageError(`--system-prompt is at most ${MAX_PROMPT} characters when it is sent to another machine`);
  const names = givens.map((g) => g.name);
  const client = await ctx.openAsPerson(team);
  try {
    const me = client.me.actor;
    for (const g of givens) mine(g, me);
    const host = await hostingNow(client, team, hostName);
    const there = names.filter((n) => host.running.includes(n));
    if (there.length) throw new Refused(`your agent ${there[0]} is running on ${hostName} already: konnect agent stop --on ${hostName} ${there[0]} ends it`);

    // A login this run was issued and sent, until the machine says it kept it: whatever it didn't keep is revoked.
    const sent = new Map<string, { issued: Issued; tokens: Issued['agents'][number]['tokens'] }>();
    const made = new Map<string, boolean>();
    const revoke = async (labels: string[]) => {
      for (const l of labels) {
        const s = sent.get(l);
        if (!s) continue;
        sent.delete(l);
        await revokeIssued(ctx.url, s.issued.client, [s.tokens]);
      }
    };
    let need = names.filter((n) => !host.agents.includes(n));
    let answer: { ok: boolean; result: Partial<Started> } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (need.length) {
        ctx.needsTerminal(`konnect ${command}`);
        const issued = await issueAgents(team, ctx.url, need, { open: ctx.io.open, log: ctx.err }, `run konnect ${command} again`);
        for (const a of issued.agents) { sent.set(a.label, { issued, tokens: a.tokens }); made.set(a.label, a.made); }
      }
      let body: Start;
      try {
        body = {
          v: 1, harness: tool,
          agents: names.map((name) => {
            const s = need.includes(name) ? sent.get(name) : undefined;
            return { name, ...(s ? { login: seal(host.public_key, JSON.stringify({ client: s.issued.client, tokens: s.tokens, ...(s.issued.discovery ? { discovery: s.issued.discovery } : {}) }), bound(team, hostName, name)) } : {}) };
          }),
          ...(said.actFor && said.actFor !== 'nobody' ? { act_for: said.actFor } : {}),
          ...(said.wakeOn.length ? { wake_on: said.wakeOn } : {}),
          ...(said.systemPrompt?.trim() ? { system_prompt: said.systemPrompt } : {}),
        };
        answer = await askHost<Partial<Started>>(ctx, client, hostName, 'start', body);
      } catch (e) {
        // Nothing says the machine kept a login: none is left out there unaccounted for.
        await revoke([...sent.keys()]);
        throw e;
      }
      const kept = list(answer.result.kept);
      await revoke([...sent.keys()].filter((l) => !kept.includes(l)));
      for (const l of kept) sent.delete(l);
      need = list(answer.result.needs_login).filter((n) => names.includes(n));
      if (!need.length) break;
    }
    const r = answer!.result;
    const started = (Array.isArray(r.started) ? r.started : []).filter((s) => s && typeof s.name === 'string' && typeof s.session === 'string' && names.includes(s.name));
    const failed = (Array.isArray(r.failed) ? r.failed : []).filter((f) => f && typeof f.name === 'string' && typeof f.why === 'string');
    const running = started.length ? ` ${started.map((s) => s.name).join(', ')} ${started.length === 1 ? 'is' : 'are'} running there: konnect agent stop --on ${hostName} <name> ends one.` : '';
    if (need.length) throw new Error(`${hostName} has no working login for ${need.join(', ')}, and the one sent wasn't kept there: run the command again`);
    if (!answer!.ok || failed.length || started.length !== names.length) {
      const why = failed.length ? failed.map((f) => `${f.name}: ${printable(f.why)}`).join('; ') : 'it didn\'t say why';
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
  } finally { await client.close(); }
}

/** `konnect agent stop --on <machine> <name>`: ends the agent's background harness there. */
export async function stopOn(ctx: Ctx, team: string, given: { name: string; owner?: string }, mine: (g: { name: string; owner?: string }, me: string) => void) {
  const hostName = checkHost(ctx.args.on);
  const client = await ctx.openAsPerson(team);
  try {
    mine(given, client.me.actor);
    await hostingNow(client, team, hostName);
    const a = await askHost<{ stopped?: boolean; why?: string }>(ctx, client, hostName, 'stop', { v: 1, agent: given.name });
    if (!a.ok) throw new Refused(typeof a.result.why === 'string' ? `${hostName}: ${printable(a.result.why)}` : `${hostName} didn't stop ${given.name}, and didn't say why`);
    ctx.print({ team, on: hostName, agent: given.name, stopped: true }, () => `Stopped your agent ${given.name}'s harness on ${hostName}. It stays in team ${team}.`);
  } finally { await client.close(); }
}
