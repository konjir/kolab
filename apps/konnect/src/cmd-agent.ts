/**
 * The commands about your agents in the team:
 *
 *   konnect agent list
 *   konnect agent add [options] <name>                         add it, and print its entry
 *   konnect agent run [options] <name> <harness> [<argument>...]   run it in claude, codex or opencode
 *   konnect agent attach <name> | stop <name>                  an agent running in the background here
 *   konnect agent remove <name>
 *
 * run and stop take --on <machine>: the same, on another machine of the person's that is hosting
 * (host-ask.ts). add and run take --act-for, --wake-on and --system-prompt, which set parts of the agent's system
 * prompt (system-prompt.ts). They travel in the entry's environment, to `konnect mcp`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { logout } from '@konjir/login';
import { HARNESSES, INSTALL, checkLabel, dropOldEntry, entryEnv, keepKonnect, konnectCommand, listenList, serverName, setUpAgents, shellLine, startTool, toolCommand, type Tool } from './agents.js';
import { NotYet, Refused, TeamClient } from './client.js';
import type { Ctx } from './context.js';
import { UsageError } from './errors.js';
import { helpFor } from './help.js';
import { runOn, stopOn, type Said } from './host-ask.js';
import { printable, shownName } from './names.js';
import { freePort, wakeOpenCode, withPort } from './opencode.js';
import { systemPrompt } from './system-prompt.js';
import { HOSTED_URL, agentFile, agentFileReady, configDir, dropIfEmpty } from './teams.js';

/** The channels --wake-on names (each given once, or 0.1.0's --listen '#a,#b'), checked. */
function wakeOn(ctx: Ctx): string[] {
  try { return listenList([...ctx.args.wakeOn, ...(ctx.args.listen !== undefined ? [ctx.args.listen] : [])].join(',') || undefined); } catch (e) {
    throw new UsageError(String((e as Error)?.message ?? e).replace('--listen names channels: \'#a,#b\'', '--wake-on names a channel'));
  }
}

/** What sets the agent's system prompt, from this command line. */
const saidHere = (ctx: Ctx): Said => ({ actFor: ctx.args.actFor, wakeOn: wakeOn(ctx), systemPrompt: ctx.args.systemPrompt });

/** The agent's own name, from `name`, `@you/name` or `you/name`; an owner given is kept, to be checked against the person. */
const label = (given: string | undefined, usage: string): { name: string; owner?: string } => {
  if (given === undefined) throw new UsageError(usage);
  const word = given.replace(/^@/, '');
  const slash = word.indexOf('/');
  try { return { name: checkLabel(slash < 0 ? word : word.slice(slash + 1)), ...(slash < 0 ? {} : { owner: word.slice(0, slash) }) }; } catch (e) { throw new UsageError(String((e as Error)?.message ?? e)); }
};

/** These commands are about your own agents: one named as someone else's is refused, never taken for yours of that name. */
const mine = (given: { name: string; owner?: string }, me: string) => {
  if (given.owner !== undefined && given.owner.toLowerCase() !== me.toLowerCase()) throw new Refused(`@${printable(given.owner)}/${given.name} is ${printable(given.owner)}'s agent, not yours: only its owner can add, run or remove it`);
};

/**
 * The agents, in the team and logged in on this machine: each made if it is new. An agent whose
 * login is kept here and still works needs no browser; the rest are allowed on one page of the
 * service's, together.
 */
async function ready(ctx: Ctx, team: string, givens: { name: string; owner?: string }[], command: string): Promise<{ owner: string; agents: { name: string; made: boolean }[] }> {
  // The person's own login to the team, checked first: the agents' setup page logs them in again, in the browser.
  const person = await ctx.openAsPerson(team);
  const owner = person.me.actor;
  await person.close();
  for (const g of givens) mine(g, owner);
  const names = givens.map((g) => g.name);
  if (new Set(names).size !== names.length) throw new UsageError(`konnect ${command}: an agent is named twice`);
  const made = new Map<string, boolean>();
  for (const name of names) {
    if (!existsSync(agentFile(team, name, ctx.env))) continue;
    try {
      const kept = await TeamClient.open(team, ctx.url, agentFile(team, name, ctx.env), { kind: 'agent', label: name, owner });
      await kept.close();
      made.set(name, false);
    } catch { /* set up afresh below */ }
  }
  const missing = names.filter((n) => !made.has(n));
  if (missing.length) {
    ctx.needsTerminal(`konnect ${command}`);
    for (const r of await setUpAgents(team, ctx.url, missing, { open: ctx.io.open, log: ctx.err, env: ctx.env }, `run konnect ${command} again`)) made.set(r.label, r.made);
  }
  return { owner, agents: names.map((name) => ({ name, made: made.get(name)! })) };
}

/** The background session an agent's harness runs in on this machine: one for each agent in each team. */
export const sessionName = (team: string, name: string) => `konnect-${team}-${name}`;

/** Runs a program, giving its exit status and what it printed; -1 when it isn't installed. */
export const exec = (ctx: Ctx) => ctx.io.exec ?? ((cmd: string, args: string[], cwd: string) => new Promise<{ code: number; out: string }>((resolve) => {
  let out = '';
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: ctx.env as NodeJS.ProcessEnv });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('error', (e) => resolve({ code: (e as { code?: string }).code === 'ENOENT' ? -1 : 1, out: String(e.message) }));
  child.on('close', (code) => resolve({ code: code ?? 1, out }));
}));

/** What keeps a background harness on this machine: tmux when it is installed, else screen, else nothing. */
export async function multiplexer(ctx: Ctx): Promise<'tmux' | 'screen' | undefined> {
  if ((await exec(ctx)('tmux', ['-V'], ctx.cwd)).code !== -1) return 'tmux';
  if ((await exec(ctx)('screen', ['-v'], ctx.cwd)).code !== -1) return 'screen';
  return undefined;
}

/** Whether the background session is there. */
export async function running(ctx: Ctx, kind: 'tmux' | 'screen', session: string): Promise<boolean> {
  if (kind === 'tmux') return (await exec(ctx)('tmux', ['has-session', '-t', `=${session}`], ctx.cwd)).code === 0;
  return new RegExp(`\\d+\\.${session}\\s`).test((await exec(ctx)('screen', ['-ls'], ctx.cwd)).out);
}

/** The entry that runs `konnect mcp` for the agent: no token, only what names it and sets its system prompt. */
function entryFor(ctx: Ctx, team: string, name: string, said: Said) {
  const self = (ctx.io.self ?? (() => konnectCommand(undefined, ctx.env)))();
  if (self.keep) keepKonnect(self.keep);
  return {
    command: self.command, args: [...self.args, 'mcp'],
    env: entryEnv({ team, label: name, wakeOn: said.wakeOn, actFor: said.actFor, systemPrompt: said.systemPrompt, ...(ctx.url !== HOSTED_URL ? { url: ctx.url } : {}) }),
  };
}

/** What a background session is to run: a program, its arguments, and environment to add. */
interface Kept { cmd: string; args: string[]; env: Record<string, string> }

/** How long after a background session is started konnect looks whether it is still there: one that ended at once started nothing. */
const START_LOOK_MS = 800;

/** The names every session of one multiplexer on this machine goes by. */
export async function sessions(ctx: Ctx, kind: 'tmux' | 'screen'): Promise<string[]> {
  if (kind === 'tmux') {
    const r = await exec(ctx)('tmux', ['list-sessions', '-F', '#{session_name}'], ctx.cwd);
    return r.code === 0 ? r.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  }
  return [...(await exec(ctx)('screen', ['-ls'], ctx.cwd)).out.matchAll(/\d+\.(\S+)/g)].map((m) => m[1]);
}

/**
 * A session as screen itself knows it, `<pid>.<name>`. screen takes a name as the start of one, so
 * a name alone could reach another session that begins with it (helper, helper-1); this names one.
 */
async function screenId(ctx: Ctx, session: string): Promise<string | undefined> {
  return new RegExp(`(\\d+\\.${session})\\s`).exec((await exec(ctx)('screen', ['-ls'], ctx.cwd)).out)?.[1];
}

/** Ends a background session: that one, and no other whose name begins with its name. */
export async function endSession(ctx: Ctx, kind: 'tmux' | 'screen', session: string): Promise<{ code: number; out: string }> {
  if (kind === 'tmux') return exec(ctx)('tmux', ['kill-session', '-t', `=${session}`], ctx.cwd);
  const id = await screenId(ctx, session);
  return id ? exec(ctx)('screen', ['-S', id, '-X', 'quit'], ctx.cwd) : { code: 1, out: 'there is no such session' };
}

/**
 * Starts `kept` in a background session of its own, in this folder. The multiplexer is given only
 * konnect's own plumbing, where konnect keeps its files, and a file's name; never the words to run,
 * and never the folder. tmux reads an argument that ends in ';' as the end of its command and runs
 * what follows as another of its own, and it runs `#(...)` in the folder it is told to start in: so
 * a system prompt, a folder's name, or anything else a person (or a request from another machine)
 * wrote, never goes on its command line. What is to run, and where, waits in a file of its own
 * (`<stem>.<random>.start.json`), the person's alone, which `konnect _start` reads once and removes.
 */
export async function inSession(ctx: Ctx, kind: 'tmux' | 'screen', session: string, stem: string, kept: Kept): Promise<{ code: number; out: string }> {
  const self = (ctx.io.self ?? (() => konnectCommand(undefined, ctx.env)))();
  if (self.keep) keepKonnect(self.keep);
  const file = `${resolve(stem)}.${randomBytes(6).toString('hex')}.start.json`;
  // tmux gives a session its own server's environment, not this command's: where konnect keeps its
  // files goes with the session, or `konnect _start` would look for the file somewhere else.
  const line = ['env', `KONNECT_CONFIG_DIR=${resolve(configDir(ctx.env))}`, self.command, ...self.args, '_start', file];
  const odd = line.find((w) => w.endsWith(';'));
  if (odd !== undefined) throw new Error(`konnect can't start a background session from a path that ends in ';' (${printable(odd)})`);
  writeFileSync(file, JSON.stringify({ ...kept, cwd: ctx.cwd }), { mode: 0o600, flag: 'wx' });
  const went = kind === 'tmux' ? await exec(ctx)('tmux', ['new-session', '-d', '-s', session, ...line], ctx.cwd) : await exec(ctx)('screen', ['-dmS', session, ...line], ctx.cwd);
  if (went.code !== 0) rmSync(file, { force: true });
  return went;
}

/**
 * `konnect _start <file>`: plumbing, run inside a background session. Runs what `inSession` kept in
 * the file, in the folder it names, in this terminal, and exits as it does. Only a file konnect
 * itself wrote is run: one in konnect's own config folder, the person's own, that no one else can
 * write.
 */
export async function startKept(ctx: Ctx, rest: string[]) {
  const [given] = rest;
  const plumbing = new Error('konnect _start is plumbing: konnect runs it inside a background session, with a file it wrote');
  if (given === undefined || rest.length !== 1) throw plumbing;
  const file = resolve(given);
  if (!file.startsWith(resolve(configDir(ctx.env)) + sep) || !basename(file).endsWith('.start.json')) throw plumbing;
  let kept: Kept & { cwd?: unknown };
  try {
    const st = lstatSync(file);
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o022)) throw plumbing;
    kept = JSON.parse(readFileSync(file, 'utf8')) as Kept & { cwd?: unknown };
  } catch { throw plumbing; } finally { rmSync(file, { force: true }); }
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!kept || typeof kept.cmd !== 'string' || !strings(kept.args) || !kept.env || typeof kept.env !== 'object' || !strings(Object.values(kept.env)) || typeof kept.cwd !== 'string' || !isAbsolute(kept.cwd)) throw plumbing;
  const code = await (ctx.io.start ?? ((c, dir) => startTool(c, dir, ctx.env)))({ cmd: kept.cmd, args: kept.args, env: kept.env }, kept.cwd);
  if (code === -1) throw new Error(`${printable(kept.cmd)} isn't installed here (it isn't on PATH), so nothing was started`);
  process.exitCode = code;
}

/**
 * Starts `tool` as the agent in a background session on this machine, in this folder: for
 * `konnect agent run --background`, and for a machine that hosts, when it is asked. The agent's
 * login is kept here already. Returns the session, and the file an old entry was taken out of.
 */
export async function startInBackground(ctx: Ctx, kind: 'tmux' | 'screen', a: { team: string; owner: string; name: string; tool: Tool; extra: string[]; said: Said }): Promise<{ session: string; dropped?: string }> {
  const { team, name, tool, said } = a;
  const entry = entryFor(ctx, team, name, said);
  const server = serverName(name);
  const prompt = systemPrompt({ team, name, owner: a.owner, actFor: said.actFor, wakeOn: said.wakeOn, own: said.systemPrompt });
  let run;
  try { run = toolCommand(tool, server, entry, a.extra, prompt); } catch (e) { throw new UsageError(String((e as Error)?.message ?? e)); }
  const session = sessionName(team, name);
  // Looked at now: allowing agents in the browser can take minutes, and another run may have started this one meanwhile.
  if (await running(ctx, kind, session)) throw new Refused(`your agent ${name} is running in the background here already, so it wasn't started again.`);
  const dropped = tool === 'claude' ? dropOldEntry(ctx.cwd, server, name) : undefined;
  // Where this konnect keeps its logins and which service it talks to go with the session, whatever the multiplexer's own environment says.
  const carried = Object.fromEntries(Object.entries({ KONNECT_URL: ctx.env.KONNECT_URL, KONNECT_CONFIG_DIR: ctx.env.KONNECT_CONFIG_DIR ? resolve(ctx.env.KONNECT_CONFIG_DIR) : undefined, XDG_CONFIG_HOME: ctx.env.XDG_CONFIG_HOME }).filter((e): e is [string, string] => !!e[1]));
  let kept: Kept;
  if (tool === 'opencode') {
    // OpenCode is woken by the konnect that started it, so in the background it is konnect that
    // runs there, with OpenCode in front of it; the others run by themselves.
    const self = (ctx.io.self ?? (() => konnectCommand(undefined, ctx.env)))();
    kept = { cmd: self.command, args: [...self.args, '--team', team, 'agent', 'run', ...(said.actFor ? ['--act-for', said.actFor] : []), ...said.wakeOn.flatMap((c) => ['--wake-on', c]), ...(said.systemPrompt !== undefined ? ['--system-prompt', said.systemPrompt] : []), name, tool, ...a.extra], env: carried };
  } else {
    // konnect commands run inside the harness act as the agent, never as the person; the hook that wakes it reads the same.
    kept = { cmd: run.cmd, args: run.args, env: { ...carried, ...run.env, ...entry.env } };
  }
  const went = await inSession(ctx, kind, session, join(dirname(agentFileReady(team, name, ctx.env)), name), kept);
  if (went.code !== 0) throw new Error(`${kind} couldn't start ${tool} in the background as ${name}: ${went.out.trim() || `it exited with ${went.code}`}.`);
  // A session that is gone a moment later started nothing: the harness isn't installed, or it refused its command line.
  await ctx.pause(START_LOOK_MS);
  if (!await running(ctx, kind, session)) throw new Error(`${tool} ended as soon as it was started in the background as ${name}: run konnect agent run ${name} ${tool} in a terminal here to see why.`);
  return { session, ...(dropped ? { dropped } : {}) };
}

export async function agent(ctx: Ctx, verb: string | undefined, rest: string[]) {
  if (verb === undefined) throw new UsageError(helpFor(['agent']));
  if (!['list', 'add', 'run', 'attach', 'stop', 'remove'].includes(verb)) throw new UsageError(`konnect agent has no ${printable(verb)}: it is list, add, run, attach, stop or remove`);
  ctx.personOnly(`agent ${verb}`);
  const team = ctx.team();

  if (verb === 'list') {
    if (rest.length) throw new UsageError(`konnect agent list: unknown ${printable(rest.join(' '))}`);
    const client = await ctx.open(team);
    try {
      const mine = (await client.members()).filter((m) => m.kind === 'agent' && m.owner === client.me.actor)
        .map((m) => { const full = shownName(m); const name = full.slice(full.indexOf('/') + 1); return { name, connected: m.here, set_up_here: existsSync(agentFile(team, name, ctx.env)), running_here: false, running_on: [] as string[] }; });
      const kind = mine.length ? await multiplexer(ctx) : undefined;
      if (kind) for (const a of mine) a.running_here = await running(ctx, kind, sessionName(team, a.name));
      // And on the person's other machines that are hosting now, as each last said.
      const hosting = mine.length ? (await client.hosts().catch(() => [])).filter((h) => h.serving) : [];
      for (const a of mine) a.running_on = hosting.filter((h) => h.running.includes(a.name)).map((h) => h.name);
      ctx.print(mine, () => {
        if (!mine.length) return `You have no agents in team ${team}. Add one with: konnect agent run <name> claude`;
        const width = Math.max(...mine.map((a) => a.name.length)) + 3;
        return mine.map((a) => `${printable(a.name).padEnd(width)}${(a.connected ? 'connected' : '').padEnd(12)}${(a.set_up_here ? 'set up here' : '').padEnd(14)}${[...(a.running_here ? ['running here, in the background'] : []), ...(a.running_on.length ? [`running on ${a.running_on.map(printable).join(', ')}`] : [])].join('; ')}`.trimEnd()).join('\n');
      });
    } finally { await client.close(); }
    return;
  }

  if (verb === 'add') {
    if (!rest.length) throw new UsageError('konnect agent add <name>...: name the agent, such as konnect agent add reviewer');
    // A harness's name after an agent's is someone meaning agent run, not an agent to be called claude.
    const harness = rest.slice(1).find((w) => (HARNESSES as readonly string[]).includes(w));
    if (harness) throw new UsageError(`konnect agent add <name>: unknown ${harness}. To start a harness with it: konnect agent run ${printable(rest[0])} ${harness}`);
    const givens = rest.map((w) => label(w, 'konnect agent add <name>...'));
    wakeOn(ctx); // checked before an agent is added: a wrong command line does nothing
    const r = await ready(ctx, team, givens, `agent add ${givens.map((g) => g.name).join(' ')}`);
    const entry = { mcpServers: Object.fromEntries(r.agents.map((a) => [serverName(a.name), { type: 'stdio', ...entryFor(ctx, team, a.name, saidHere(ctx)) }])) };
    const one = r.agents.length === 1;
    ctx.print({ team, ...(one ? { agent: `${r.owner}/${r.agents[0].name}`, added: r.agents[0].made } : { agents: r.agents.map((a) => ({ agent: `${r.owner}/${a.name}`, added: a.made })) }), entry }, () => [
      one
        ? `Your agent @${printable(r.owner)}/${r.agents[0].name} is ${r.agents[0].made ? 'added to' : 'in'} team ${team}, and logged in on this machine.`
        : `Your agents ${r.agents.map((a) => `@${printable(r.owner)}/${a.name}`).join(', ')} are in team ${team}, and logged in on this machine.`,
      one ? 'Put this entry in the harness it runs in (an MCP server):' : 'Put each entry in the harness that agent runs in (an MCP server):',
      '',
      JSON.stringify(entry, null, 2),
    ].join('\n'));
    return;
  }

  if (verb === 'run') {
    const given = label(rest[0], 'konnect agent run <name> <harness> [<argument>...]: name the agent, then claude, codex or opencode');
    const [, harness, ...extra] = rest;
    if (harness === undefined) throw new UsageError(`konnect agent run ${given.name} <harness>: say what to run it in: claude, codex or opencode`);
    if (!(HARNESSES as readonly string[]).includes(harness)) {
      throw new UsageError(`konnect agent run starts claude, codex or opencode, and ${printable(harness)} is none of them. For another harness: konnect agent add ${given.name}, and put the entry it prints there. For a script: konnect --agent ${given.name} send ...`);
    }
    const tool = harness as Tool;
    wakeOn(ctx); // checked before the agent is added: a wrong command line does nothing
    // --count: several agents at once, <name>-1 to <name>-<count>, each in the background; one page allows them all.
    const count = ctx.args.count;
    if (count !== undefined && !ctx.args.background && ctx.args.on === undefined) throw new UsageError('konnect agent run --count starts several harnesses, which one terminal can\'t hold: add --background');
    let givens = [given];
    if (count !== undefined) {
      try { givens = Array.from({ length: count }, (_, i) => ({ ...given, name: checkLabel(`${given.name}-${i + 1}`) })); } catch (e) { throw new UsageError(String((e as Error)?.message ?? e)); }
    }
    // --on: on another machine of yours that is hosting, in the background there. Nothing after the harness is sent.
    if (ctx.args.on !== undefined) {
      if (extra.length) throw new UsageError(`konnect agent run --on sends no arguments for the harness (${printable(extra.join(' '))}): what an agent may do on another machine is set on that machine. Leave them out`);
      return runOn(ctx, team, givens, tool, saidHere(ctx), mine, `agent run --on ${ctx.args.on}${count !== undefined ? ` --count ${count}` : ''} ${given.name} ${tool}`);
    }
    const kind = ctx.args.background ? await multiplexer(ctx) : undefined;
    if (ctx.args.background) {
      if (!kind) throw new Error('konnect agent run --background keeps the harness in tmux or screen, and neither is installed here: install tmux, or run it without --background');
      for (const g of givens) {
        if (await running(ctx, kind, sessionName(team, g.name))) throw new Refused(`your agent ${g.name} is running in the background here already: look in with konnect agent attach ${g.name}, or stop it with konnect agent stop ${g.name}`);
      }
    }
    const r = await ready(ctx, team, givens, `agent run${ctx.args.background ? ' --background' : ''}${count !== undefined ? ` --count ${count}` : ''} ${given.name} ${tool}`);
    const said: string[] = [];
    const started: { agent: string; session: string }[] = [];
    for (const a of r.agents) {
      const name = a.name;
      if (kind) {
        // In the background: in a terminal of its own that outlives this one, to look in on and to stop.
        try {
          const s = await startInBackground(ctx, kind, { team, owner: r.owner, name, tool, extra, said: saidHere(ctx) });
          if (s.dropped) said.push(`Took ${serverName(name)} out of ${printable(s.dropped)}, where an earlier konnect wrote it: Claude Code is given it on its command line now.`);
          started.push({ agent: `${r.owner}/${name}`, session: s.session });
        } catch (e) {
          // Those started before one that fails keep running: said, so none is left running unknown.
          if (started.length && e instanceof Error) e.message += ` ${started.map((s) => s.agent.slice(s.agent.indexOf('/') + 1)).join(', ')} ${started.length === 1 ? 'is' : 'are'} running in the background: konnect agent stop <name> ends one.`;
          throw e;
        }
        continue;
      }
      const entry = entryFor(ctx, team, name, saidHere(ctx));
      const server = serverName(name);
      const prompt = systemPrompt({ team, name, owner: r.owner, actFor: ctx.args.actFor, wakeOn: wakeOn(ctx), own: ctx.args.systemPrompt });
      let run;
      try { run = toolCommand(tool, server, entry, extra, prompt); } catch (e) { throw new UsageError(String((e as Error)?.message ?? e)); }
      // konnect commands run inside the harness act as the agent, never as the person; the hook that wakes it reads the same.
      const env = { ...run.env, ...entry.env };
      const dropped = tool === 'claude' ? dropOldEntry(ctx.cwd, server, name) : undefined;
      if (dropped) said.push(`Took ${server} out of ${printable(dropped)}, where an earlier konnect wrote it: Claude Code is given it on its command line now.`);
      ctx.err([
        `Your agent @${printable(r.owner)}/${name} is ${a.made ? 'added to' : 'in'} team ${team}.`,
        ...said,
        ...(tool === 'codex' ? ['Codex isn\'t woken by messages: the agent receives at the start of each turn.'] : []),
      ].join('\n'));
      // OpenCode is woken from here: it is started on a port of its own, and konnect stays beside it,
      // submitting the notice of new messages as a prompt.
      let stopWaking: (() => Promise<void>) | undefined;
      if (tool === 'opencode') {
        const settled = await withPort(run.args, ctx.io.port ?? freePort);
        run = { ...run, args: settled.args };
        // Nothing is written to the terminal from here on: it is OpenCode's.
        stopWaking = await (ctx.io.wakeOpenCode ?? wakeOpenCode)({ team, url: ctx.url, file: agentFile(team, name, ctx.env), label: name, owner: r.owner, port: settled.port, wakeOn: wakeOn(ctx).join(',') || undefined })
          .catch((e: unknown) => { ctx.err(`konnect can't wake ${name} in OpenCode (${(e as Error)?.message ?? e}): it receives at the start of each turn`); return undefined; });
      }
      let code: number;
      try { code = await (ctx.io.start ?? ((c, dir) => startTool(c, dir, ctx.env)))({ ...run, env }, ctx.cwd); } finally { await stopWaking?.(); }
      if (code === -1) throw new Error(`${tool} isn't installed here (no ${tool} on PATH). Install ${INSTALL[tool]}, then run this again. To start it yourself: ${shellLine([run.cmd, ...run.args])}`);
      process.exitCode = code;
      return;
    }
    const first = r.agents[0].name;
    const leave = kind === 'tmux' ? 'Ctrl-b d' : 'Ctrl-a d';
    ctx.print(count === undefined ? { team, agent: started[0].agent, harness: tool, session: started[0].session, in: kind } : { team, harness: tool, in: kind, agents: started }, () => [
      count === undefined
        ? `Your agent @${printable(r.owner)}/${first} is ${r.agents[0].made ? 'added to' : 'in'} team ${team}, and ${tool} is running as it in the background (${kind} session ${started[0].session}).`
        : `Your agents ${r.agents.map((a) => `@${printable(r.owner)}/${a.name}`).join(', ')} are in team ${team}, and ${tool} is running as each in the background (${kind} sessions ${started[0].session} to ${started.at(-1)!.session}).`,
      ...said.map((l) => l.replace(': Claude Code is given it on its command line now.', '.')),
      `  konnect agent attach ${first}     look in on it; ${leave} leaves it running`,
      `  konnect agent stop ${first}       end it`,
      ...(tool === 'claude' ? ['The first time in a folder, Claude Code asks whether to trust it: attach once and answer.'] : []),
    ].join('\n'));
    return;
  }

  if (verb === 'attach' || verb === 'stop') {
    const given = label(rest[0], `konnect agent ${verb} <name>: name the agent running in the background`);
    if (rest.length > 1) throw new UsageError(`konnect agent ${verb} <name>: unknown ${printable(rest.slice(1).join(' '))}`);
    if (ctx.args.on !== undefined) return stopOn(ctx, team, given, mine);
    const session = sessionName(team, given.name);
    const kind = await multiplexer(ctx);
    if (!kind || !await running(ctx, kind, session)) throw new Refused(`your agent ${given.name} isn't running in the background on this machine: konnect agent run --background ${given.name} <harness> starts it`);
    if (verb === 'stop') {
      const r = await endSession(ctx, kind, session);
      if (r.code !== 0) throw new Error(`${kind} couldn't end ${session}: ${r.out.trim() || `it exited with ${r.code}`}`);
      ctx.print({ team, agent: given.name, stopped: true }, () => `Stopped your agent ${given.name}'s harness here. It stays in team ${team}.`);
      return;
    }
    // The terminal is the harness's until it is left (tmux: Ctrl-b d; screen: Ctrl-a d).
    const attach = kind === 'tmux' ? { cmd: 'tmux', args: ['attach-session', '-t', `=${session}`], env: {} } : { cmd: 'screen', args: ['-r', await screenId(ctx, session) ?? session], env: {} };
    process.exitCode = await (ctx.io.start ?? ((c, dir) => startTool(c, dir, ctx.env)))(attach, ctx.cwd);
    return;
  }

  // remove
  const given = label(rest[0], 'konnect agent remove <name>: name one agent of yours');
  const name = given.name;
  if (rest.length > 1) throw new UsageError(`konnect agent remove <name>: unknown ${printable(rest.slice(1).join(' '))}`);
  const client = await ctx.open(team);
  let r;
  try {
    mine(given, client.me.actor);
    r = await client.removeAgent(name);
  } catch (e) {
    if (e instanceof NotYet) throw e;
    if (e instanceof Refused) throw new Refused(e.message.replace(/kolab (\S+)/g, 'team $1'));
    throw e;
  } finally { await client.close(); }
  // Its login is revoked: what konnect kept of it here goes too.
  await logout(ctx.url, { path: agentFileReady(team, name, ctx.env), forget: true }).catch(() => undefined);
  dropIfEmpty(agentFile(team, name, ctx.env));
  ctx.print(r, () => `Removed your agent ${name} from team ${team}: ${r.ended} session${r.ended === 1 ? '' : 's'} ended.`);
}

