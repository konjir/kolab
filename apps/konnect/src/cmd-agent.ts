/**
 * The commands about your agents in the team:
 *
 *   konnect agent list
 *   konnect agent add [options] <name>                         add it, and print its entry
 *   konnect agent run [options] <name> <harness> [<argument>...]   run it in claude, codex or opencode
 *   konnect agent remove <name>
 *
 * add and run take --act-for, --wake-on and --system-prompt, which set parts of the agent's system
 * prompt (system-prompt.ts). They travel in the entry's environment, to `konnect mcp`.
 */
import { existsSync } from 'node:fs';
import { logout } from '@konjir/login';
import { HARNESSES, INSTALL, checkLabel, entryEnv, keepKonnect, konnectCommand, listenList, serverName, setUpAgent, shellLine, startTool, toolCommand, writeMcpJson, type Tool } from './agents.js';
import { NotYet, Refused, TeamClient } from './client.js';
import type { Ctx } from './context.js';
import { UsageError } from './errors.js';
import { helpFor } from './help.js';
import { printable, shownName } from './names.js';
import { HOSTED_URL, agentFile, agentFileReady, dropIfEmpty } from './teams.js';

/** The channels --wake-on names (each given once, or 0.1.0's --listen '#a,#b'), checked. */
function wakeOn(ctx: Ctx): string[] {
  try { return listenList([...ctx.args.wakeOn, ...(ctx.args.listen !== undefined ? [ctx.args.listen] : [])].join(',') || undefined); } catch (e) {
    throw new UsageError(String((e as Error)?.message ?? e).replace('--listen names channels: \'#a,#b\'', '--wake-on names a channel'));
  }
}

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
 * The agent, in the team and logged in on this machine: made if it is new. An agent whose login is
 * kept here and still works needs no browser; otherwise the person allows it on the service's page.
 */
async function ready(ctx: Ctx, team: string, given: { name: string; owner?: string }, command: string): Promise<{ agent: string; made: boolean; owner: string }> {
  const name = given.name;
  // The person's own login to the team, checked first: the agent's setup page logs them in again, in the browser.
  const person = await ctx.openAsPerson(team);
  const owner = person.me.actor;
  await person.close();
  mine(given, owner);
  if (existsSync(agentFile(team, name, ctx.env))) {
    try {
      const kept = await TeamClient.open(team, ctx.url, agentFile(team, name, ctx.env), { kind: 'agent', label: name, owner });
      const agent = kept.me.actor;
      await kept.close();
      return { agent, made: false, owner };
    } catch { /* set up afresh below */ }
  }
  ctx.needsTerminal(`konnect ${command}`);
  const r = await setUpAgent(team, ctx.url, name, { open: ctx.io.open, log: ctx.err, env: ctx.env }, `run konnect ${command} again`);
  return { agent: r.agent, made: r.made, owner };
}

/** The entry that runs `konnect mcp` for the agent: no token, only what names it and sets its system prompt. */
function entryFor(ctx: Ctx, team: string, name: string) {
  const self = (ctx.io.self ?? (() => konnectCommand(undefined, ctx.env)))();
  if (self.keep) keepKonnect(self.keep);
  return {
    command: self.command, args: [...self.args, 'mcp'],
    env: entryEnv({ team, label: name, wakeOn: wakeOn(ctx), actFor: ctx.args.actFor, systemPrompt: ctx.args.systemPrompt, ...(ctx.url !== HOSTED_URL ? { url: ctx.url } : {}) }),
  };
}

export async function agent(ctx: Ctx, verb: string | undefined, rest: string[]) {
  if (verb === undefined) throw new UsageError(helpFor(['agent']));
  if (!['list', 'add', 'run', 'remove'].includes(verb)) throw new UsageError(`konnect agent has no ${printable(verb)}: it is list, add, run or remove`);
  ctx.personOnly(`agent ${verb}`);
  const team = ctx.team();

  if (verb === 'list') {
    if (rest.length) throw new UsageError(`konnect agent list: unknown ${printable(rest.join(' '))}`);
    const client = await ctx.open(team);
    try {
      const mine = (await client.members()).filter((m) => m.kind === 'agent' && m.owner === client.me.actor)
        .map((m) => { const full = shownName(m); const name = full.slice(full.indexOf('/') + 1); return { name, connected: m.here, set_up_here: existsSync(agentFile(team, name, ctx.env)) }; });
      ctx.print(mine, () => {
        if (!mine.length) return `You have no agents in team ${team}. Add one with: konnect agent run <name> claude`;
        const width = Math.max(...mine.map((a) => a.name.length)) + 3;
        return mine.map((a) => `${printable(a.name).padEnd(width)}${(a.connected ? 'connected' : '').padEnd(12)}${a.set_up_here ? 'set up here' : ''}`.trimEnd()).join('\n');
      });
    } finally { await client.close(); }
    return;
  }

  if (verb === 'add') {
    const given = label(rest[0], 'konnect agent add <name>: name the agent, such as konnect agent add reviewer');
    const name = given.name;
    if (rest.length > 1) throw new UsageError(`konnect agent add <name>: unknown ${printable(rest.slice(1).join(' '))}. To start a harness with it: konnect agent run ${name} ${printable(rest[1])}`);
    wakeOn(ctx); // checked before the agent is added: a wrong command line does nothing
    const r = await ready(ctx, team, given, `agent add ${name}`);
    const entry = { mcpServers: { [serverName(name)]: { type: 'stdio', ...entryFor(ctx, team, name) } } };
    ctx.print({ team, agent: `${r.owner}/${name}`, added: r.made, entry }, () => [
      `Your agent @${printable(r.owner)}/${name} is ${r.made ? 'added to' : 'in'} team ${team}, and logged in on this machine.`,
      'Put this entry in the harness it runs in (an MCP server):',
      '',
      JSON.stringify(entry, null, 2),
    ].join('\n'));
    return;
  }

  if (verb === 'run') {
    const given = label(rest[0], 'konnect agent run <name> <harness> [<argument>...]: name the agent, then claude, codex or opencode');
    const name = given.name;
    const [, harness, ...extra] = rest;
    if (harness === undefined) throw new UsageError(`konnect agent run ${name} <harness>: say what to run it in: claude, codex or opencode`);
    if (!(HARNESSES as readonly string[]).includes(harness)) {
      throw new UsageError(`konnect agent run starts claude, codex or opencode, and ${printable(harness)} is none of them. For another harness: konnect agent add ${name}, and put the entry it prints there. For a script: konnect --agent ${name} send ...`);
    }
    const tool = harness as Tool;
    wakeOn(ctx); // checked before the agent is added: a wrong command line does nothing
    const r = await ready(ctx, team, given, `agent run ${name} ${tool}`);
    const entry = entryFor(ctx, team, name);
    const server = serverName(name);
    const written = tool === 'claude' ? writeMcpJson(ctx.cwd, server, entry) : undefined;
    const run = toolCommand(tool, server, entry, extra);
    // konnect commands run inside the harness act as the agent, never as the person.
    const env = { ...run.env, KONNECT_TEAM: team, KONNECT_AGENT: name, ...(ctx.url !== HOSTED_URL ? { KONNECT_URL: ctx.url } : {}) };
    ctx.err([
      `Your agent @${printable(r.owner)}/${name} is ${r.made ? 'added to' : 'in'} team ${team}${written ? `; ${printable(written)} has its entry, ${server}` : ''}.`,
      ...(tool !== 'claude' ? [`${tool === 'codex' ? 'Codex' : 'OpenCode'} isn't woken by messages: the agent receives at the start of each turn.`] : []),
    ].join('\n'));
    const code = await (ctx.io.start ?? ((c, dir) => startTool(c, dir, ctx.env)))({ ...run, env }, ctx.cwd);
    if (code === -1) throw new Error(`${tool} isn't installed here (no ${tool} on PATH). Install ${INSTALL[tool]}, then run this again. To start it yourself: ${shellLine([run.cmd, ...run.args])}`);
    process.exitCode = code;
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

