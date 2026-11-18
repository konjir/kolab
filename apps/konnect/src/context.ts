/**
 * What every command shares: how its input and output reach the person, which service and team it
 * works in, and whom it acts as.
 *
 * The team is the first of: --team, KONNECT_TEAM, the one team logged in to on this machine.
 * A command acts as the person, unless --agent or KONNECT_AGENT names an agent of theirs; then it
 * uses that agent's own login (its file, or KONNECT_CREDENTIALS).
 */
import { safeUrl } from '@konjir/login';
import type { Args } from './args.js';
import { Refused, SignInError, TeamClient, type As } from './client.js';
import { NoTerminal, UsageError } from './errors.js';
import type { McpOptions } from './mcp.js';
import { printable } from './names.js';
import { HOSTED_URL, agentFile, allTeams, checkTeam, checkUrl, teamFile, teamsAt, wellFormedUrl } from './teams.js';

/** How a command's input and output reach the person: for tests. */
export interface IO {
  cwd?: string;
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Sends the person's browser to the login page; by default it is opened. */
  open?: (u: URL) => void | Promise<void>;
  /** The message, when `konnect send` is given none; by default, standard input. */
  stdin?: () => Promise<string>;
  /** Serves `konnect mcp`; by default over this process's stdio. */
  serve?: (opts: McpOptions) => Promise<void>;
  /** Starts an agent's harness (claude, codex, opencode); by default in this terminal. -1: it isn't installed. */
  start?: (c: { cmd: string; args: string[]; env: Record<string, string> }, cwd: string) => Promise<number>;
  /** How this konnect runs, for the agent's MCP entry; by default this process. */
  self?: () => { command: string; args: string[]; keep?: { from: string; to: string } };
  /** Waits between looks for a message (`--wait`); by default a timer. */
  pause?: (ms: number) => Promise<void>;
  /** Whether a person is at a terminal, so a browser may be opened; by default, whether one is. */
  terminal?: boolean;
}

export type Env = Record<string, string | undefined>;

/**
 * KONNECT_URL as konnect keeps it: http(s), no user name or password, no query or fragment, `/mcp`
 * for no path, and written as the URL reads back (host lowercased, and so on).
 */
export function normalUrl(given: string): string {
  let u: URL;
  try { u = new URL(given); } catch { throw new UsageError(`KONNECT_URL isn't a URL: give the service's MCP URL, such as ${HOSTED_URL}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UsageError(`KONNECT_URL is ${u.protocol.replace(/:$/, '')}: give the service's https URL, such as ${HOSTED_URL}`);
  if (u.username || u.password) throw new UsageError('KONNECT_URL holds a user name or password: give the URL without them; konnect logs in in the browser');
  if (u.search || u.hash || given.includes('?') || given.includes('#')) throw new UsageError('KONNECT_URL holds a query or a fragment: give the service\'s MCP URL alone');
  if (u.pathname === '/') u.pathname = '/mcp';
  const url = u.toString();
  if (!wellFormedUrl(url)) throw new UsageError(`KONNECT_URL isn't a URL konnect can keep: give the service's MCP URL, such as ${HOSTED_URL}`);
  return url;
}

/** The service konnect talks to: KONNECT_URL, else the hosted one. */
export function kolabUrl(env: Env): string {
  return env.KONNECT_URL ? checkUrl(normalUrl(env.KONNECT_URL), 'KONNECT_URL') : HOSTED_URL;
}

/**
 * The team a command works in: --team, else KONNECT_TEAM, else the one team konnect keeps a login
 * for at `url`. Said plainly what to do when none or several could be meant.
 */
export function chooseTeam(given: string | undefined, url: string, env: Env): string {
  if (given !== undefined) return checkTeam(given);
  if (env.KONNECT_TEAM) return checkTeam(env.KONNECT_TEAM);
  const teams = teamsAt(url, env);
  if (teams.length === 1) return teams[0];
  if (!teams.length) {
    const elsewhere = allTeams(env).filter((t) => !t.urls.includes(url));
    const hint = elsewhere.length ? ` (you are logged in to ${elsewhere.map((t) => `${t.team} at ${t.urls.map(safeUrl).join(', ')}`).join('; ')}: set KONNECT_URL to use it)` : '';
    throw new SignInError(`you aren't logged in to a team: run konnect login, or konnect team create <name>${hint}`);
  }
  throw new UsageError(`you're logged in to ${teams.length} teams (${teams.join(', ')}): say which with --team <name>, or set KONNECT_TEAM`);
}

/** The agent `--agent` or KONNECT_AGENT names, as `<name>` or `<owner>/<name>`; undefined for the person. */
export function actingAs(args: Args, env: Env): As {
  const given = args.agent ?? env.KONNECT_AGENT;
  if (!given) return { kind: 'person' };
  const slash = given.indexOf('/');
  const label = slash < 0 ? given : given.slice(slash + 1);
  const owner = slash < 0 ? undefined : given.slice(0, slash);
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(label) || (owner !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(owner))) {
    throw new UsageError(`${printable(given)} isn't an agent: give its name, or <owner>/<name>`);
  }
  return { kind: 'agent', label, ...(owner ? { owner } : {}) };
}

/** One command's run. */
export class Ctx {
  readonly env: Env;
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly url: string;
  readonly as: As;

  constructor(readonly args: Args, readonly io: IO) {
    this.env = io.env ?? process.env;
    this.cwd = io.cwd ?? process.cwd();
    this.out = io.out ?? ((l: string) => console.log(l));
    this.err = io.err ?? ((l: string) => console.error(l));
    this.url = kolabUrl(this.env);
    this.as = actingAs(args, this.env);
  }

  get json() { return this.args.json; }

  /** Prints `value` as JSON with --json, else the lines. */
  print(value: unknown, lines: () => string) { this.out(this.json ? JSON.stringify(value, null, 2) : lines()); }

  /** The team this command works in. */
  team(): string { return chooseTeam(this.args.team, this.url, this.env); }

  /** Refuses a command an agent has no tool for, when run as one. */
  personOnly(command: string) {
    if (this.as.kind === 'agent') {
      throw new Refused(`konnect ${command} is a person's to run, and this command line is acting as agent ${this.as.label} (${this.args.agent !== undefined ? '--agent' : 'KONNECT_AGENT'}): an agent can send, receive, read history and list channels and the team`);
    }
  }

  /** The login file of whoever this command acts as. */
  file(team: string): string {
    if (this.as.kind === 'agent') return this.env.KONNECT_CREDENTIALS || agentFile(team, this.as.label, this.env);
    return teamFile(team, this.env);
  }

  /** A session in `team`, as whoever this command acts as. */
  open(team: string = this.team()): Promise<TeamClient> {
    return TeamClient.open(team, this.url, this.file(team), this.as);
  }

  /** A session as the person, whoever the command line says to act as: for what only the person may ask. */
  openAsPerson(team: string = this.team()): Promise<TeamClient> {
    return TeamClient.open(team, this.url, teamFile(team, this.env));
  }

  /** Refuses to open a browser where no person is at a terminal to see it. */
  needsTerminal(why: string) {
    const terminal = this.io.terminal ?? (this.io.open !== undefined || !!process.stdin.isTTY || !!process.stderr.isTTY);
    if (!terminal) throw new NoTerminal(`${why} opens the browser, and this isn't run from a terminal: run it yourself, once`);
  }

  pause(ms: number): Promise<void> {
    return this.io.pause ? this.io.pause(ms) : new Promise((r) => setTimeout(r, ms));
  }
}
