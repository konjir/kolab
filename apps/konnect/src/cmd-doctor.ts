/**
 * `konnect doctor`: checks this machine and says, line by line, what works and what to do about
 * what doesn't: konnect itself, the service, each login kept here (yours and your agents'), which
 * team a command would work in, and the harnesses konnect starts.
 *
 * It changes nothing, and exits with status 1 when anything needs doing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeUrl } from '@konjir/login';
import { serverName } from './agents.js';
import { TeamClient } from './client.js';
import { exec, multiplexer } from './cmd-agent.js';
import { chooseTeam, type Ctx } from './context.js';
import { UsageError } from './errors.js';
import { printable } from './names.js';
import { agentFile, teamFile, teamsAt } from './teams.js';

// The published build (scripts/bundle.mjs) defines this as the package's version.
declare const KONNECT_VERSION: string | undefined;

/** The Claude Code that wakes an idle session from a hook. */
const CLAUDE_MIN = [2, 1, 318];

type Line = { ok: boolean | 'note'; what: string; fix?: string };

const version = (text: string) => /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number);
const older = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

/** The newest konnect on npm, or undefined when npm can't be asked in a moment. */
async function newest(): Promise<string | undefined> {
  try {
    const r = await fetch('https://registry.npmjs.org/@konjir%2fkonnect/latest', { signal: AbortSignal.timeout(3_000) });
    return r.ok ? String(((await r.json()) as { version?: unknown }).version ?? '') || undefined : undefined;
  } catch { return undefined; }
}

export async function doctor(ctx: Ctx, rest: string[]) {
  if (rest.length) throw new UsageError(`konnect doctor: unknown ${printable(rest.join(' '))}`);
  const lines: Line[] = [];
  const say = (ok: Line['ok'], what: string, fix?: string) => lines.push({ ok, what, ...(fix ? { fix } : {}) });

  // konnect itself.
  const mine = typeof KONNECT_VERSION === 'string' ? KONNECT_VERSION : undefined;
  const latest = await (ctx.io.latest ?? newest)();
  if (!mine) say('note', 'konnect is running from source');
  else if (latest && older(version(mine) ?? [0, 0, 0], version(latest) ?? [0, 0, 0])) say(false, `konnect ${mine} is installed, and ${latest} is the newest`, 'npm install -g @konjir/konnect');
  else say(true, `konnect ${mine}${latest ? ' is the newest' : ' (npm couldn\'t be asked for the newest)'}`);
  const node = version(process.version) ?? [0, 0, 0];
  say(node[0] >= 22, `Node.js ${process.version.replace(/^v/, '')}`, node[0] >= 22 ? undefined : 'konnect needs Node.js 22 or later');

  // Whom this command line acts as, and where.
  if (ctx.as.kind === 'agent') say('note', `this shell acts as your agent ${ctx.as.label} (${ctx.args.agent !== undefined ? '--agent' : 'KONNECT_AGENT'}), not as you`);
  if (ctx.env.KONNECT_URL) say('note', `KONNECT_URL points konnect at ${safeUrl(ctx.url)}`);

  // The logins kept here, each tried.
  const teams = teamsAt(ctx.url, ctx.env);
  if (!teams.length) say(false, `you aren't logged in to a team at ${safeUrl(ctx.url)}`, 'konnect login, or konnect team create <name>');
  let reached = false;
  const owners = new Map<string, string>();
  for (const team of teams) {
    try {
      const c = await TeamClient.open(team, ctx.url, teamFile(team, ctx.env));
      owners.set(team, c.me.actor);
      await c.close();
      reached = true;
      say(true, `logged in to team ${team} as @${printable(owners.get(team)!)}`);
    } catch (e) {
      say(false, `team ${team}: ${printable(String((e as Error)?.message ?? e))}`);
    }
  }
  if (teams.length > 1) {
    try { say(true, `commands work in team ${chooseTeam(ctx.args.team, ctx.url, ctx.env)} (${ctx.args.team !== undefined ? '--team' : 'KONNECT_TEAM'})`); } catch {
      say(false, `you're logged in to ${teams.length} teams, and nothing says which a command works in`, `pass --team <name>, or set KONNECT_TEAM (one of: ${teams.join(', ')})`);
    }
  }
  // Your agents set up on this machine.
  for (const team of teams) {
    let labels: string[] = [];
    try { labels = readdirSync(dirname(agentFile(team, 'x', ctx.env))).filter((f) => /^[a-z0-9][a-z0-9-]{0,23}\.json$/.test(f)).map((f) => f.slice(0, -5)); } catch { /* none set up */ }
    for (const label of labels) {
      try {
        const c = await TeamClient.open(team, ctx.url, agentFile(team, label, ctx.env), { kind: 'agent', label, ...(owners.has(team) ? { owner: owners.get(team)! } : {}) });
        await c.close();
        reached = true;
        say(true, `agent ${label} is set up here for team ${team}`);
      } catch (e) {
        say(false, `agent ${label} (team ${team}): ${printable(String((e as Error)?.message ?? e))}`, `konnect${teams.length > 1 ? ` --team ${team}` : ''} agent add ${label}`);
      }
    }
  }
  if (teams.length && !reached) say(false, `nothing reached the service at ${safeUrl(ctx.url)}`, 'check your connection');

  // The harnesses konnect starts.
  const claude = await exec(ctx)('claude', ['--version'], ctx.cwd);
  if (claude.code === -1) say('note', 'Claude Code isn\'t installed: konnect agent run <name> claude needs it');
  else {
    const v = version(claude.out);
    const wakes = !!v && !older(v, CLAUDE_MIN);
    say(wakes, `Claude Code ${v ? v.join('.') : 'of an unknown version'}${wakes ? ': messages wake an idle session' : ' is too old to be woken by messages'}`, wakes ? undefined : `update Claude Code to ${CLAUDE_MIN.join('.')} or later`);
  }
  const opencode = await exec(ctx)('opencode', ['--version'], ctx.cwd);
  if (opencode.code !== -1) say(true, `OpenCode ${version(opencode.out)?.join('.') ?? ''}: messages wake an idle session`.replace('  ', ' '));
  const codex = await exec(ctx)('codex', ['--version'], ctx.cwd);
  if (codex.code !== -1) say('note', `Codex ${version(codex.out)?.join('.') ?? ''} is installed: it isn't woken by messages, and receives at each turn`.replace('  ', ' '));
  const mux = await multiplexer(ctx);
  say(mux ? true : 'note', mux ? `${mux} is installed: konnect agent run --background works` : 'neither tmux nor screen is installed: konnect agent run --background needs one');

  // What an earlier konnect left in this folder.
  try {
    const servers = (JSON.parse(readFileSync(join(ctx.cwd, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, { args?: unknown; env?: Record<string, unknown> }> }).mcpServers ?? {};
    const old = Object.entries(servers).filter(([n, e]) => n.startsWith('konnect-') && Array.isArray(e?.args) && e.args.at(-1) === 'mcp' && typeof e.env?.KONNECT_AGENT === 'string' && n === serverName(e.env.KONNECT_AGENT));
    if (old.length) say('note', `this folder's .mcp.json holds ${old.map(([n]) => n).join(', ')}, written by an earlier konnect: konnect agent run <name> claude takes it out`);
  } catch { /* no .mcp.json, or not one konnect can read */ }
  if (existsSync(join(ctx.cwd, '.konnect.json'))) say('note', 'this folder holds a .konnect.json, which konnect no longer reads: it can be deleted');

  const wrong = lines.filter((l) => l.ok === false).length;
  ctx.print({ ok: !wrong, checks: lines }, () => [
    ...lines.map((l) => `${l.ok === true ? 'ok  ' : l.ok === 'note' ? '--  ' : '!!  '}${l.what}${l.fix ? `\n      ${l.fix}` : ''}`),
    '',
    wrong ? `${wrong} thing${wrong === 1 ? ' needs' : 's need'} doing.` : 'Nothing needs doing.',
  ].join('\n'));
  if (wrong) process.exitCode = 1;
}
