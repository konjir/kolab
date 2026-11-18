/**
 * konnect: chat for a team's people and their AI agents, across machines. A team is a kolab on
 * Kolab underneath, and konnect is an MCP client of Kolab, as konjir is.
 *
 * Every command names what it does:
 *
 *   send, receive, history       are about messages                         (cmd-messages.ts)
 *   status, login, logout        are about you                              (cmd-messages.ts, cmd-team.ts)
 *   channel …, team …, agent …, lease …, host …
 *                                start with what they are about, then say what to do with it
 *                                                    (cmd-team.ts, cmd-agent.ts, cmd-lease.ts, cmd-host.ts)
 *
 * A command line that names no action (konnect alone, or a noun alone) does nothing: it prints the
 * help and exits with status 2. `konnect mcp` is plumbing: the agent's tools, for a harness (mcp.ts).
 * The names 0.1.0 used are still read, for one release (fromOld).
 */
import { parseArgs, type ActFor, type Args, ACT_FOR } from './args.js';
import { listenList } from './agents.js';
import { agent, startKept } from './cmd-agent.js';
import { complete, completion } from './cmd-completion.js';
import { doctor } from './cmd-doctor.js';
import { host } from './cmd-host.js';
import { lease } from './cmd-lease.js';
import { history, receive, sendMessage, status } from './cmd-messages.js';
import { channel, logOut, login, team } from './cmd-team.js';
import { waitingNow, wake } from './cmd-wake.js';
import { watch } from './cmd-watch.js';
import { Ctx, actingAs, chooseTeam, type IO } from './context.js';
import { UsageError } from './errors.js';
import { USAGE, helpFor } from './help.js';
import { serveStdio } from './mcp.js';
import { printable } from './names.js';
import { agentFileReady } from './teams.js';

export { TeamClient, NotYet, Refused, SignInError, UNREAD_WAIT_MS } from './client.js';
export { counted, formatChannels, formatTeam, formatMessage, memberJson, mentionsIn, shownName, stateWord, storedName, unreadLine, type Channel, type ChannelMessage, type Member, type Message } from './names.js';
export { framed, serveMcp, sessionGone, type McpOptions } from './mcp.js';
export { describeWake, noticeFor, wakeDescriber, wakingIn, type Waking } from './wake.js';
export { readAll, send, targetOf, type Block } from './chat.js';
export { joinTeam, signInToTeam } from './sign-in.js';
export { agentSetupScope, entryEnv, konnectCommand, serverName, toolCommand, withSettings } from './agents.js';
export { HOSTED_URL, agentFile, agentFileReady, allTeams, configDir, teamFile, teamsAt } from './teams.js';
export { parseArgs, duration, type Args } from './args.js';
export { Ctx, chooseTeam, kolabUrl, normalUrl, type IO } from './context.js';
export { UsageError, WaitRanOut, Woke, exitStatus } from './errors.js';
export { unannounced, wakeFile } from './cmd-wake.js';
export { USAGE, helpFor } from './help.js';
export { fingerprint, keyOf, newCode, readCode, seal, unseal } from './seal.js';
export { answerBound, readStart, readStop, requestBound } from './host-ask.js';
export { thisMachine, formatHosts } from './cmd-host.js';
export { systemPrompt } from './system-prompt.js';

// The published build (scripts/bundle.mjs) defines this as the package's version.
declare const KONNECT_VERSION: string | undefined;

/**
 * The words of a 0.1.0 command line as 0.2.0 says them, or the words as they are. `say` is told
 * the new name once, so a person learns it; a script's standard output is untouched.
 */
function fromOld(a: Args, say: (old: string, now: string) => void, resolveTeam: () => string): string[] {
  const [cmd, ...rest] = a.words;
  const renamed = (now: string[], shown = now.join(' ')) => { say(`konnect ${cmd}`, `konnect ${shown}`); return now; };
  switch (cmd) {
    case 'read': return a.history ? renamed(['history', ...rest], 'history') : renamed(['receive', ...rest], 'receive');
    case 'who': return renamed(['team', 'list', ...rest], 'team list');
    case 'join': return renamed(['login', ...rest], 'login');
    case 'recruit':
      if (a.list) return renamed(['team', 'list'], 'team list');
      if (a.withdraw !== undefined) return renamed(['team', 'remove', a.withdraw], 'team remove');
      return renamed(['team', 'invite', ...rest], 'team invite');
    case 'remove': return renamed(['team', 'remove', ...rest], 'team remove');
    // Leaving can't be undone, so the team is named now, never taken from where the command stands.
    case 'leave': throw new UsageError(`konnect leave is now konnect team leave <team>: name the team to leave, such as konnect team leave ${(() => { try { return resolveTeam(); } catch { return '<team>'; } })()}`);
    case 'claude': case 'codex': case 'opencode': {
      const [name, ...extra] = rest;
      if (name === undefined) throw new UsageError(`konnect ${cmd} is now konnect agent run <name> ${cmd}: name the agent`);
      return a.noStart ? renamed(['agent', 'add', name], `agent add ${name}`) : renamed(['agent', 'run', name, cmd, ...extra], `agent run ${name} ${cmd}`);
    }
    case 'channel': {
      const verb = ({ new: 'create', join: 'follow', leave: 'unfollow' } as Record<string, string>)[rest[0] ?? ''];
      if (verb) { say(`konnect channel ${rest[0]}`, `konnect channel ${verb}`); return ['channel', verb, ...rest.slice(1)]; }
      return a.words;
    }
    default: return a.words;
  }
}

/** Refuses an option given to a command that doesn't take it. */
function checkOptions(a: Args, words: string[]) {
  const [cmd, verb] = words;
  const at = `konnect ${[cmd, ...(['channel', 'team', 'agent', 'lease', 'host'].includes(cmd) && verb ? [verb] : [])].join(' ')}`;
  const only = (given: boolean, option: string, ok: boolean, where: string) => { if (given && !ok) throw new UsageError(`${at} takes no ${option}: ${where}`); };
  only(a.limit !== undefined, '-n', cmd === 'receive' || cmd === 'history', 'konnect receive and konnect history do');
  const claims = cmd === 'lease' && (verb === 'claim' || verb === 'run');
  only(a.wait !== undefined, '--wait', cmd === 'receive' || claims, 'konnect receive, konnect lease claim and konnect lease run do');
  only(a.for !== undefined, '--for', claims, 'konnect lease claim and konnect lease run do');
  const starts = cmd === 'agent' && (verb === 'add' || verb === 'run');
  only(a.wakeOn.length > 0 || a.listen !== undefined, '--wake-on', starts, 'konnect agent add and konnect agent run do');
  only(a.actFor !== undefined, '--act-for', starts, 'konnect agent add and konnect agent run do');
  only(a.systemPrompt !== undefined, '--system-prompt', starts, 'konnect agent add and konnect agent run do');
  only(a.background, '--background', (cmd === 'agent' || cmd === 'host') && verb === 'run', 'konnect agent run and konnect host run do');
  only(a.on !== undefined, '--on', cmd === 'agent' && (verb === 'run' || verb === 'stop'), 'konnect agent run and konnect agent stop do');
  only(a.newCode, '--new-code', cmd === 'host' && verb === 'run', 'only konnect host run does');
  if (a.on !== undefined && a.background) throw new UsageError('konnect agent run --on starts the agent in the background on that machine already: leave --background out');
  only(a.count !== undefined, '--count', cmd === 'agent' && verb === 'run', 'only konnect agent run does');
  only(a.forget, '--forget', cmd === 'logout', 'only konnect logout does');
  only(a.reply !== undefined, '--reply', cmd === 'send', 'only konnect send does');
}

/** `konnect <argv…>`. */
export async function main(argv: string[], io: IO = {}) {
  const env = io.env ?? process.env;
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  const parsed = parseArgs(argv);

  if (parsed.version || parsed.words[0] === 'version') {
    out(typeof KONNECT_VERSION === 'string' ? KONNECT_VERSION : 'development (run from source)');
    return;
  }
  if (parsed.words[0] === 'help') { out(helpFor(parsed.words.slice(1))); return; }
  if (parsed.help) { out(helpFor(parsed.words)); return; }
  if (!parsed.words.length) throw new UsageError(USAGE);

  const ctx = new Ctx(parsed, io);

  if (parsed.words[0] === 'mcp') {
    // The agent's own tools over stdio: stdout is the protocol's alone from here.
    if (parsed.words.length > 1) throw new UsageError(`konnect mcp: unknown ${printable(parsed.words.slice(1).join(' '))}`);
    const as = actingAs(parsed, env);
    if (as.kind !== 'agent') throw new UsageError('konnect mcp needs the agent it runs as: KONNECT_AGENT (or --agent <name>), as the entry konnect agent add prints sets it');
    const mcpTeam = chooseTeam(parsed.team, ctx.url, env);
    const file = env.KONNECT_CREDENTIALS || agentFileReady(mcpTeam, as.label, env);
    const wakeOn = listenList(parsed.wakeOn.length ? parsed.wakeOn.join(',') : parsed.listen ?? env.KONNECT_WAKE_ON ?? env.KONNECT_LISTEN ?? undefined);
    const actFor = parsed.actFor ?? (ACT_FOR.includes(env.KONNECT_ACT_FOR as ActFor) ? env.KONNECT_ACT_FOR as ActFor : undefined);
    const own = parsed.systemPrompt ?? env.KONNECT_SYSTEM_PROMPT;
    await (io.serve ?? serveStdio)({ team: mcpTeam, url: ctx.url, file, label: as.label, ...(as.owner ? { owner: as.owner } : {}), ...(wakeOn.length ? { wakeOn } : {}), ...(actFor ? { actFor } : {}), ...(own ? { own } : {}), ...(env.KONNECT_WAKE === 'hook' || env.KONNECT_WAKE === 'beside' ? { wake: false } : {}), ...(env.KONNECT_WAKE === 'codex' ? { codex: true } : {}),
      // Claude Code's hook says when the harness waits; any other harness is only known to be running.
      ...(env.KONNECT_WAKE === 'hook' ? { state: () => (waitingNow(mcpTeam, as.label, env) ? 'idle' as const : 'working' as const) } : {}), log: err });
    return;
  }

  // Plumbing: the hook that wakes an agent's idle harness.
  if (parsed.words[0] === 'wake') return wake(ctx, parsed.words.slice(1));
  // Plumbing: what a background session runs, from the file konnect wrote for it.
  if (parsed.words[0] === '_start') return startKept(ctx, parsed.words.slice(1));
  // Plumbing: what the shell's completion asks. Its words are someone's half-typed command line, never run.
  if (parsed.words[0] === '_complete') {
    await complete(ctx, parsed.words.slice(1));
    // A Tab never waits on a connection left open: what was asked of the service and didn't come in time is dropped with the process.
    if (io.out === undefined) process.exit(0);
    return;
  }

  const said = new Set<string>();
  const words = fromOld(parsed, (old, now) => { if (!said.has(old)) { said.add(old); err(`(${old} is now ${now})`); } }, () => ctx.team());
  const [cmd, ...rest] = words;
  checkOptions(parsed, words);

  switch (cmd) {
    case 'status': return status(ctx, rest);
    case 'send': return sendMessage(ctx, rest);
    case 'receive': return receive(ctx, rest);
    case 'history': return history(ctx, rest);
    case 'watch': return watch(ctx, rest);
    case 'login': return login(ctx, rest);
    case 'logout': return logOut(ctx, rest);
    case 'channel': return channel(ctx, rest[0], rest.slice(1));
    case 'team': return team(ctx, rest[0], rest.slice(1));
    case 'agent': return agent(ctx, rest[0], rest.slice(1));
    case 'lease': return lease(ctx, rest[0], rest.slice(1));
    case 'host': return host(ctx, rest[0], rest.slice(1));
    case 'doctor': return doctor(ctx, rest);
    case 'completion': return completion(ctx, rest);
    default: throw new UsageError(`konnect has no command ${printable(cmd)}: run konnect --help`);
  }
}
