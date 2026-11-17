/**
 * konnect: chat for a team's people and their AI agents, across machines. A team is a kolab on
 * Kolab underneath, and konnect is an MCP client of Kolab, as konjir is.
 *
 *   konnect team [<name>]              sign in to a team (GitHub, in the browser), or list your teams
 *   konnect who                        the team's members, and who is connected
 *   konnect send '#channel'|@name [message]  a channel or direct message; from stdin when left out
 *   konnect read ['#channel'|@name]    your unread messages, oldest first, marked read
 *   konnect channel list|new|join|leave
 *   konnect mcp --agent <label>        konnect's four tools for an agent, over stdio (mcp.ts)
 *   konnect logout                     sign out of a team
 *
 * Every command takes --team <name> (optional with one team, or in a folder whose .konnect.json
 * names one) and --json. KONNECT_URL points konnect at another Kolab than the hosted one.
 */
import { dirname } from 'node:path';
import { logout, safeUrl } from '@konjir/login';
import { Refused, TeamClient, said } from './client.js';
import { INSTALL, checkLabel, entryEnv, keepKonnect, konnectCommand, listenList, serverName, setUpAgent, shellLine, startTool, toolCommand, writeMcpJson, type Tool } from './agents.js';
import { joinTeam, signInToTeam } from './sign-in.js';
import { leftAfter, readAll, readOne, send, targetOf, type Block, type Sent, type Target } from './chat.js';
import { serveStdio, type McpOptions } from './mcp.js';
import { channelName, formatChannels, formatMembers, formatMessage, printable, shownActor, shownName, storedName, unreadLine, type Member } from './names.js';
import { HOSTED_URL, PROJECT_FILE, allTeams, agentFileReady, checkTeam, checkUrl, findProject, rememberTeam, teamFile, teamsAt, trustedUrl, wellFormedUrl, type Project } from './teams.js';

export { TeamClient, NotYet, Refused } from './client.js';
export { formatChannels, formatMembers, formatMessage, mentionsIn, shownName, storedName, unreadLine, type Channel, type ChannelMessage, type Member, type Message } from './names.js';
export { framed, serveMcp, sessionGone, type McpOptions } from './mcp.js';
export { describeWake, wakeDescriber } from './wake.js';
export { readAll, send, targetOf, type Block } from './chat.js';
export { SignInError, UNREAD_WAIT_MS } from './client.js';
export { joinTeam, signInToTeam } from './sign-in.js';
export { agentSetupScope, entryEnv, konnectCommand, mcpJsonText, serverName, toolCommand } from './agents.js';
export { HOSTED_URL, PROJECT_FILE, agentFile, agentFileReady, allTeams, configDir, findProject, readProject, rememberTeam, teamFile, teamsAt, trustedUrl } from './teams.js';

// The published build (scripts/bundle.mjs) defines this as the package's version.
declare const KONNECT_VERSION: string | undefined;

/** What `konnect help` says. */
export const USAGE = `konnect: chat for your team's people and AI agents, on Konjir.

  konnect                         with no team yet: sign in with GitHub and join a team you're
                                  invited to; with one, what is unread and what to run next
  konnect team <name>             sign in to a team, making it if the name is free, and remember it
                                  in this folder
  konnect team                    list your teams, and the one this folder remembers
  konnect join                    sign in and pick an invitation or a team in the browser
  konnect who                     the team's members, and who is connected
  konnect send '#channel' [message]
                                  send to a channel; @name or @owner/label in it mentions them
  konnect send @name [message]    send a direct message (@owner/label for an agent);
                                  with no message, either reads one from stdin; --reply <id> answers one
  konnect read                    everything unread, oldest first, marked read: direct messages,
                                  then each channel you follow
  konnect read '#channel'         a channel's unread; --history [--limit n] shows its recent
                                  messages instead, marking nothing
  konnect read @name              their unread direct messages
  konnect channel list            the channels, which you follow, and what is unread
  konnect channel new <name>      make a channel, and follow it
  konnect channel join|leave <name>
                                  follow a channel, or stop
  konnect recruit <github username>…
                                  invite people to your team (its owner); --list shows who is
                                  invited, --withdraw <username> takes one back
  konnect remove @name            remove a member from your team (its owner)
  konnect leave                   leave the team
  konnect claude <label> [-- claude's arguments]
                                  set up your agent <label> in the team and start Claude Code with it;
                                  a message for it wakes it. --no-start sets up only; --listen '#a,#b'
                                  wakes it on every message in those channels
  konnect codex|opencode <label>  the same in Codex or OpenCode, which aren't woken by messages yet
  konnect mcp --agent <label>     the four konnect tools for an agent of yours, as a stdio MCP server
  konnect logout                  sign out of a team

  --team <name>   the team to use; not needed with one team, or where .konnect.json names one
  --json          print JSON instead of lines
  A message is taken as written: flags go before it, and -- ends them. Say where it goes: '#name'
  for a channel (quoted, for the shell), @name for a member; a bare name is refused.

Not available yet: live chat (konnect, with a team).

Sign-ins are kept in ~/.config/konnect (KONNECT_CONFIG_DIR), one per team. KONNECT_URL points konnect
at another Kolab than ${HOSTED_URL}.`;


/** How a command's input and output reach the person: for tests. */
export interface IO {
  cwd?: string;
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Sends the person's browser to Kolab's sign-in; by default it is opened. */
  open?: (u: URL) => void | Promise<void>;
  /** The message, when `konnect send` is given none; by default, stdin. */
  stdin?: () => Promise<string>;
  /** Serves `konnect mcp`; by default over this process's stdio. */
  serve?: (opts: McpOptions) => Promise<void>;
  /** Starts an agent's tool (claude, codex, opencode); by default in this terminal. -1: it isn't installed. */
  start?: (c: { cmd: string; args: string[]; env: Record<string, string> }, cwd: string) => Promise<number>;
  /** How this konnect runs, for the agent's MCP entry; by default this process. */
  self?: () => { command: string; args: string[]; keep?: { from: string; to: string } };
}

/** A command line, read: konnect's flags, and the words that aren't flags, in order. */
export interface Args { json: boolean; team?: string; forget: boolean; words: string[]; history?: true; limit?: number; reply?: string; agent?: string; list?: true; withdraw?: string; noStart?: true; listen?: string }

/**
 * Reads konnect's flags (--json, --team <name>, --forget, --history, --limit <n>, --reply <id>,
 * --agent <label>) from `argv`, left to right. `--` ends them: everything after it is words. A
 * message is never read for flags: for `send`, everything after the recipient from the first word
 * that isn't one of konnect's flags is the message, as it is written, `--json` or `--team` in it
 * included.
 */
export function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, forget: false, words: [] };
  const value = (i: number, what: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i]} needs ${what}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (w === '--') { a.words.push(...argv.slice(i + 1)); break; }
    // `send <recipient> <message…>`: the message starts at its first word, and is all words from there.
    const inMessage = a.words[0] === 'send' && a.words.length >= 2;
    if (w === '--json') { a.json = true; continue; }
    if (w === '--forget') { a.forget = true; continue; }
    if (w === '--history') { a.history = true; continue; }
    if (w === '--list') { a.list = true; continue; }
    if (w === '--no-start') { a.noStart = true; continue; }
    if (w === '--withdraw') { a.withdraw = value(i, 'a GitHub username'); i++; continue; }
    if (w === '--listen') { a.listen = value(i, 'channels, as \'#a,#b\''); i++; continue; }
    if (w === '--team') { a.team = value(i, 'a team\'s name'); i++; continue; }
    if (w === '--reply') { a.reply = value(i, 'the id of the message it answers'); i++; continue; }
    if (w === '--agent') { a.agent = value(i, 'an agent\'s label'); i++; continue; }
    if (w === '--limit') {
      const n = Number(value(i, 'a number'));
      if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error('--limit is a whole number from 1 to 200');
      a.limit = n; i++; continue;
    }
    if (inMessage) { a.words.push(...argv.slice(i)); break; }
    a.words.push(w);
  }
  return a;
}

async function readStdin(): Promise<string> {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/**
 * The Kolab konnect talks to: KONNECT_URL, else the folder's .konnect.json's when konnect trusts it
 * (teams.ts), else the hosted one.
 */
export function kolabUrl(env: Record<string, string | undefined>, project: Project | undefined): string {
  if (env.KONNECT_URL) return checkUrl(normalUrl(env.KONNECT_URL), 'KONNECT_URL');
  if (project?.url !== undefined) {
    if (!trustedUrl(project.url, env)) {
      throw new Error(`${printable(project.path)} names Kolab at ${safeUrl(project.url)}, which you haven't given konnect yourself, so konnect won't use it. If it is the Kolab you mean, run once: KONNECT_URL=${safeUrl(project.url)} konnect team <name>`);
    }
    return checkUrl(project.url, printable(project.path));
  }
  return HOSTED_URL;
}

/**
 * The team a command works in: --team, else the folder's, else the one team konnect keeps a
 * sign-in for at `url`. Said plainly what to do when none or several could be meant.
 */
export function chooseTeam(given: string | undefined, project: Project | undefined, url: string, env: Record<string, string | undefined>): string {
  if (given !== undefined) return checkTeam(given);
  if (project?.team !== undefined) return project.team;
  const teams = teamsAt(url, env);
  if (teams.length === 1) return teams[0];
  if (!teams.length) throw new Error('you aren\'t signed in to a team: run konnect team <name>');
  throw new Error(`you're in ${teams.length} teams (${teams.join(', ')}): pass --team <name>, or run konnect team <name> here to remember one in this folder`);
}

/**
 * KONNECT_URL as konnect keeps and writes it: http(s), no user name or password, no query or
 * fragment, `/mcp` for no path, and written as the URL reads back (host lowercased, and so on), so
 * what .konnect.json holds is always what konnect reads back.
 */
export function normalUrl(given: string): string {
  let u: URL;
  try { u = new URL(given); } catch { throw new Error(`KONNECT_URL isn't a URL: give Kolab's MCP URL, such as ${HOSTED_URL}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`KONNECT_URL is ${u.protocol.replace(/:$/, '')}: give Kolab's https URL, such as ${HOSTED_URL}`);
  if (u.username || u.password) throw new Error('KONNECT_URL holds a user name or password: give Kolab\'s URL without them; konnect signs in in the browser');
  if (u.search || u.hash || given.includes('?') || given.includes('#')) throw new Error('KONNECT_URL holds a query or a fragment: give Kolab\'s MCP URL alone');
  if (u.pathname === '/') u.pathname = '/mcp';
  const url = u.toString();
  if (!wellFormedUrl(url)) throw new Error(`KONNECT_URL isn't a URL konnect can keep: give Kolab's MCP URL, such as ${HOSTED_URL}`);
  return url;
}

/** How many of a channel's messages one read shows a person; the rest are counted, not shown. */
export const SHOWN_AT_ONCE = 20;

/**
 * One block of `konnect read`, as lines: under its channel's name when `heading`; for a channel, the
 * newest SHOWN_AT_ONCE alone when more were read (all are marked read), with one line saying how many
 * earlier ones there are and how to see them; and when Kolab says more are unread still (a read
 * stops after a bound), a line saying so.
 */
export function blockLines(b: Block, show: (ms: { from: string; message: string; sent_at: string }[]) => string, channel: boolean, heading: boolean): string {
  const lines: string[] = [];
  if (b.kind === 'channel' && heading) lines.push(`#${b.channel}`);
  const hidden = b.kind === 'channel' && channel ? Math.max(0, b.messages.length - SHOWN_AT_ONCE) : 0;
  if (hidden && b.kind === 'channel') lines.push(`(${hidden} earlier unread message${hidden === 1 ? '' : 's'} not shown, now marked read: konnect read '#${b.channel}' --history --limit ${Math.min(200, b.messages.length)} shows them)`);
  lines.push(show(b.messages.slice(hidden)));
  if (b.more) lines.push(`(${b.more} more still unread${b.kind === 'channel' ? ` in #${b.channel}: run konnect read '#${b.channel}'` : ': run konnect read'} again)`);
  return lines.join('\n');
}

/** `konnect <argv…>`. */
export async function main(argv: string[], io: IO = {}) {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  const args = [...argv];

  if (args[0] === '--version' || args[0] === 'version') {
    out(typeof KONNECT_VERSION === 'string' ? KONNECT_VERSION : 'development (run from source)');
    return;
  }
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') { out(USAGE); return; }

  const parsed = parseArgs(args);
  const { json } = parsed;
  const teamFlag = parsed.team;
  const [cmd, ...rest] = parsed.words;
  const print = (value: unknown, lines: () => string) => out(json ? JSON.stringify(value, null, 2) : lines());
  if (cmd !== undefined && !['team', 'join', 'who', 'send', 'read', 'channel', 'recruit', 'remove', 'leave', 'claude', 'codex', 'opencode', 'mcp', 'logout'].includes(cmd)) {
    throw new Error(`konnect has no command ${printable(cmd)}: run konnect help`);
  }
  if (parsed.forget && cmd !== 'logout') throw new Error(`konnect ${cmd} takes no --forget: only konnect logout does`);

  const project = findProject(cwd);
  const url = kolabUrl(env, project);

  if (cmd === 'team') {
    if (rest.length > 1) throw new Error(`konnect team [<name>]: unknown ${printable(rest.slice(1).join(' '))}`);
    const name = rest[0] ?? teamFlag;
    if (name === undefined) {
      const teams = teamsAt(url, env);
      const elsewhere = allTeams(env).filter((t) => !t.urls.includes(url));
      const here = project?.team;
      print({ url, teams, folder: here ?? null, elsewhere }, () => {
        const lines = teams.length ? teams.map((t) => `${t}${t === here ? '  (this folder)' : ''}`) : ['You aren\'t signed in to a team: run konnect team <name>.'];
        if (here !== undefined && !teams.includes(here)) lines.push(`This folder's ${PROJECT_FILE} names team ${here}, which you aren't signed in to: run konnect team ${here}.`);
        for (const t of elsewhere) lines.push(`${t.team}  (at ${t.urls.map(safeUrl).join(', ')})`);
        return lines.join('\n');
      });
      return;
    }
    const team = checkTeam(name);
    const { me, fresh } = await signInToTeam(team, url, { open: io.open, log: err, env });
    // The folder's file where one was found (in a repository, it may be above this folder); else here.
    const dir = project ? dirname(project.path) : cwd;
    const path = rememberTeam(dir, team, url);
    print({ team, actor: me.actor, url, signedIn: fresh ? 'now' : 'already', folder: path }, () =>
      `${fresh ? 'Signed in to' : 'Using'} team ${team} as ${printable(me.actor)}. ${dir === cwd ? `This folder remembers it (${PROJECT_FILE}).` : `${printable(path)} remembers it.`}`);
    return;
  }

  // konnect join, and bare konnect with no team signed in here: sign in naming no team, and land in the one picked.
  if (cmd === 'join' || (cmd === undefined && !teamsAt(url, env).length && project?.team === undefined && teamFlag === undefined)) {
    if (rest.length) throw new Error(`konnect join: unknown ${printable(rest.join(' '))}`);
    const r = await joinTeam(url, { open: io.open, log: err, env });
    const dir = project ? dirname(project.path) : cwd;
    const path = rememberTeam(dir, r.team, url);
    const client = await TeamClient.open(r.team, url, teamFile(r.team, env));
    try {
      const members = await client.members().catch(() => [] as Member[]);
      print({ team: r.team, actor: r.actor, folder: path, members: members.map((m) => ({ ...m, name: shownName(m) })) }, () => [
        `You're in team ${r.team}, as ${printable(r.actor)}. ${dir === cwd ? `This folder remembers it (${PROJECT_FILE}).` : `${printable(path)} remembers it.`}`,
        ...(members.length ? ['', formatMembers(members), ''] : ['']),
        'Next:',
        `  konnect read                     what is waiting for you`,
        `  konnect send '#general' "hello"   say hello to the team`,
        `  konnect claude <label>           bring an agent of yours into the team`,
      ].join('\n'));
    } finally {
      await client.close();
    }
    return;
  }

  if (cmd === undefined) {
    // A team signed in here: no live chat yet; what is unread, and what to run.
    const lines = ['Live chat isn\'t available yet.'];
    let known: string | undefined;
    try {
      const team = chooseTeam(teamFlag, project, url, env);

  if (cmd === 'claude' || cmd === 'codex' || cmd === 'opencode') {
    const tool: Tool = cmd;
    const [labelWord, ...extra] = rest;
    const label = checkLabel(labelWord, tool);
    const listen = listenList(parsed.listen);
    if (listen.length && tool !== 'claude') throw new Error(`--listen wakes the agent on a channel's messages, and only Claude Code is woken in this release: konnect claude ${label} --listen …`);
    // The person's own sign-in to the team, checked first: the agent's setup page signs them in again, in the browser.
    const person = await TeamClient.open(team, url, teamFile(team, env));
    await person.close();
    const r = await setUpAgent(team, url, label, { open: io.open, log: err, env });
    const self = (io.self ?? (() => konnectCommand(undefined, env)))();
    if (self.keep) keepKonnect(self.keep);
    const name = serverName(label);
    const entry = { command: self.command, args: [...self.args, 'mcp'], env: entryEnv({ team, label, listen, ...(url !== HOSTED_URL ? { url } : {}) }) };
    const written = tool === 'claude' ? writeMcpJson(cwd, name, entry) : undefined;
    const run = toolCommand(tool, name, entry, extra);
    const said = [`Your agent ${shownName({ actor: r.agent, kind: 'agent', owner: r.agent.slice(0, r.agent.length - label.length - 1) })} is ${r.made ? 'made and ' : ''}signed in to team ${team}${written ? `; ${printable(written)} has its entry, ${name}` : ''}.`];
    if (tool !== 'claude') said.push(`${tool === 'codex' ? 'Codex' : 'OpenCode'} isn't woken by messages in this release: the agent checks for them (konnect_read) at the start of each turn.`);
    if (parsed.noStart) {
      said.push(`Start it with: ${shellLine([run.cmd, ...run.args])}`);
      print({ team, agent: r.agent, made: r.made, entry, file: written ?? null, command: [run.cmd, ...run.args], env: run.env }, () => said.join('\n'));
      return;
    }
    out(said.join('\n'));
    const code = await (io.start ?? ((c, dir) => startTool(c, dir, env)))(run, cwd);
    if (code === -1) {
      throw new Error(`${tool} isn't installed here (no ${tool} on PATH). Install ${INSTALL[tool]}, then run: ${shellLine([run.cmd, ...run.args])}${Object.keys(run.env).length ? ' (with OPENCODE_CONFIG_CONTENT as konnect opencode --no-start --json gives it)' : ''}`);
    }
    process.exitCode = code;
    return;
  }

  if (cmd === 'recruit' || cmd === 'remove' || cmd === 'leave') {
    if (cmd === 'recruit' && !parsed.list && parsed.withdraw === undefined && !rest.length) throw new Error('konnect recruit <github username>…: name who to invite (--list shows who is invited)');
    if (cmd === 'remove' && rest.length !== 1) throw new Error('konnect remove @name: name one member');
    if (cmd === 'leave' && rest.length) throw new Error(`konnect leave: unknown ${printable(rest.join(' '))}`);
    const client = await TeamClient.open(team, url, teamFile(team, env));
    const ownerOnly = (e: unknown) => {
      if (e instanceof Refused && /only the owner of kolab/.test(e.message)) return new Error(`only team ${team}'s owner can do that: ask them`);
      if (e instanceof Refused && /you own kolab \S+, so you can't leave it/.test(e.message)) return new Error(`you own team ${team}, so you can't leave it`);
      return e;
    };
    try {
      if (cmd === 'recruit' && parsed.list) {
        const list = await client.invitations().catch((e) => { throw ownerOnly(e); });
        print(list, () => (list.length ? list.map((i) => `${printable(i.account)}  invited by ${printable(i.invited_by)} on ${i.created_at.slice(0, 10)}`).join('\n') : `No invitations to team ${team} are waiting.`));
        return;
      }
      if (cmd === 'recruit' && parsed.withdraw !== undefined) {
        const who = parsed.withdraw.replace(/^@/, '').toLowerCase();
        const list = await client.invitations().catch((e) => { throw ownerOnly(e); });
        const it = list.find((i) => i.account.toLowerCase() === who);
        if (!it) throw new Error(`no invitation to team ${team} waits for ${printable(parsed.withdraw)}: konnect recruit --list shows who is invited`);
        const w = await client.withdraw(it.id);
        print(w, () => `Withdrew ${printable(it.account)}'s invitation to team ${team}.`);
        return;
      }
      if (cmd === 'recruit') {
        const r = await client.invite(rest).catch((e) => { throw ownerOnly(e); });
        print(r, () => [
          ...(r.invited.length ? [`Invited: ${r.invited.map((i) => printable(i.account)).join(', ')}.`] : []),
          ...(r.already_invited.length ? [`Already invited: ${r.already_invited.map((i) => printable(i.account)).join(', ')}.`] : []),
          ...(r.already_members.length ? [`Already in the team: ${r.already_members.map(printable).join(', ')}.`] : []),
          ...(r.declined_recently.length ? [`Declined in the last 30 days, so not asked again yet: ${r.declined_recently.map(printable).join(', ')}.`] : []),
          ...(r.invited.length || r.already_invited.length ? ['They join by running, with the GitHub account you named:', '  npx @konjir/konnect'] : []),
        ].join('\n'));
        return;
      }
      if (cmd === 'remove') {
        const r = await client.removeMember(storedName(rest[0].startsWith('@') ? rest[0] : `@${rest[0]}`)).catch((e) => { throw ownerOnly(e); });
        print(r, () => `Removed @${printable(r.removed)} from team ${team}${r.agents.length ? `, with their agents ${r.agents.map(printable).join(', ')}` : ''}: ${r.ended} session${r.ended === 1 ? '' : 's'} ended.`);
        return;
      }
      const r = await client.leave().catch((e) => { throw ownerOnly(e); });
      await logout(url, { path: teamFile(team, env), forget: true }).catch(() => undefined);
      print(r, () => `You left team ${team}${r.agents.length ? `, and your agents ${r.agents.map(printable).join(', ')} with you` : ''}. konnect forgot its sign-in here.`);
      return;
    } finally {
      await client.close();
    }
  }
      known = team;
      const client = await TeamClient.open(team, url, teamFile(team, env));
      try {
        const u = await client.unread().catch(() => undefined);
        const line = u ? unreadLine(u) : '';
        lines.push(line ? `Team ${team}: ${line}.` : `Team ${team}: nothing unread.`);
      } finally { await client.close(); }
    } catch (e) {
      lines.push(known ? `Team ${known}: ${(e as Error)?.message ?? e}.` : String((e as Error)?.message ?? e));
    }
    lines.push('', '  konnect read                     read what is waiting', '  konnect send \'#general\' "…"     say something to the team', '  konnect help                     every command');
    out(lines.join('\n'));
    return;
  }

  if (cmd === 'mcp') {
    // The agent's own tools over stdio: stdout is the protocol's alone from here.
    if (rest.length) throw new Error(`konnect mcp [--team <name>] --agent <label>: unknown ${printable(rest.join(' '))}`);
    // The agent, by its label, or as <owner>/<label> to pin whose agent it must be.
    const given = parsed.agent ?? env.KONNECT_AGENT;
    const mcpTeam = checkTeam(teamFlag ?? env.KONNECT_TEAM ?? project?.team ?? chooseTeam(undefined, project, url, env));
    if (!given) throw new Error('konnect mcp needs the agent it runs as: --agent <label> (or <owner>/<label>), or KONNECT_AGENT');
    const slash = given.indexOf('/');
    const agent = slash < 0 ? given : given.slice(slash + 1);
    const owner = slash < 0 ? undefined : given.slice(0, slash);
    if (owner !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(owner)) throw new Error(`${printable(given)} isn't an agent: give its label, or <owner>/<label>`);
    const file = env.KONNECT_CREDENTIALS || agentFileReady(mcpTeam, agent, env);
    const listen = listenList(parsed.listen ?? (env.KONNECT_LISTEN ? env.KONNECT_LISTEN : undefined));
    await (io.serve ?? serveStdio)({ team: mcpTeam, url, file, label: agent, ...(owner ? { owner } : {}), ...(listen.length ? { listen } : {}), log: err });
    return;
  }

  const team = chooseTeam(teamFlag, project, url, env);

  if (cmd === 'claude' || cmd === 'codex' || cmd === 'opencode') {
    const tool: Tool = cmd;
    const [labelWord, ...extra] = rest;
    const label = checkLabel(labelWord, tool);
    const listen = listenList(parsed.listen);
    if (listen.length && tool !== 'claude') throw new Error(`--listen wakes the agent on a channel's messages, and only Claude Code is woken in this release: konnect claude ${label} --listen …`);
    // The person's own sign-in to the team, checked first: the agent's setup page signs them in again, in the browser.
    const person = await TeamClient.open(team, url, teamFile(team, env));
    await person.close();
    const r = await setUpAgent(team, url, label, { open: io.open, log: err, env });
    const self = (io.self ?? (() => konnectCommand(undefined, env)))();
    if (self.keep) keepKonnect(self.keep);
    const name = serverName(label);
    const entry = { command: self.command, args: [...self.args, 'mcp'], env: entryEnv({ team, label, listen, ...(url !== HOSTED_URL ? { url } : {}) }) };
    const written = tool === 'claude' ? writeMcpJson(cwd, name, entry) : undefined;
    const run = toolCommand(tool, name, entry, extra);
    const said = [`Your agent ${shownName({ actor: r.agent, kind: 'agent', owner: r.agent.slice(0, r.agent.length - label.length - 1) })} is ${r.made ? 'made and ' : ''}signed in to team ${team}${written ? `; ${printable(written)} has its entry, ${name}` : ''}.`];
    if (tool !== 'claude') said.push(`${tool === 'codex' ? 'Codex' : 'OpenCode'} isn't woken by messages in this release: the agent checks for them (konnect_read) at the start of each turn.`);
    if (parsed.noStart) {
      said.push(`Start it with: ${shellLine([run.cmd, ...run.args])}`);
      print({ team, agent: r.agent, made: r.made, entry, file: written ?? null, command: [run.cmd, ...run.args], env: run.env }, () => said.join('\n'));
      return;
    }
    out(said.join('\n'));
    const code = await (io.start ?? ((c, dir) => startTool(c, dir, env)))(run, cwd);
    if (code === -1) {
      throw new Error(`${tool} isn't installed here (no ${tool} on PATH). Install ${INSTALL[tool]}, then run: ${shellLine([run.cmd, ...run.args])}${Object.keys(run.env).length ? ' (with OPENCODE_CONFIG_CONTENT as konnect opencode --no-start --json gives it)' : ''}`);
    }
    process.exitCode = code;
    return;
  }

  if (cmd === 'recruit' || cmd === 'remove' || cmd === 'leave') {
    if (cmd === 'recruit' && !parsed.list && parsed.withdraw === undefined && !rest.length) throw new Error('konnect recruit <github username>…: name who to invite (--list shows who is invited)');
    if (cmd === 'remove' && rest.length !== 1) throw new Error('konnect remove @name: name one member');
    if (cmd === 'leave' && rest.length) throw new Error(`konnect leave: unknown ${printable(rest.join(' '))}`);
    const client = await TeamClient.open(team, url, teamFile(team, env));
    const ownerOnly = (e: unknown) => {
      if (e instanceof Refused && /only the owner of kolab/.test(e.message)) return new Error(`only team ${team}'s owner can do that: ask them`);
      if (e instanceof Refused && /you own kolab \S+, so you can't leave it/.test(e.message)) return new Error(`you own team ${team}, so you can't leave it`);
      return e;
    };
    try {
      if (cmd === 'recruit' && parsed.list) {
        const list = await client.invitations().catch((e) => { throw ownerOnly(e); });
        print(list, () => (list.length ? list.map((i) => `${printable(i.account)}  invited by ${printable(i.invited_by)} on ${i.created_at.slice(0, 10)}`).join('\n') : `No invitations to team ${team} are waiting.`));
        return;
      }
      if (cmd === 'recruit' && parsed.withdraw !== undefined) {
        const who = parsed.withdraw.replace(/^@/, '').toLowerCase();
        const list = await client.invitations().catch((e) => { throw ownerOnly(e); });
        const it = list.find((i) => i.account.toLowerCase() === who);
        if (!it) throw new Error(`no invitation to team ${team} waits for ${printable(parsed.withdraw)}: konnect recruit --list shows who is invited`);
        const w = await client.withdraw(it.id);
        print(w, () => `Withdrew ${printable(it.account)}'s invitation to team ${team}.`);
        return;
      }
      if (cmd === 'recruit') {
        const r = await client.invite(rest).catch((e) => { throw ownerOnly(e); });
        print(r, () => [
          ...(r.invited.length ? [`Invited: ${r.invited.map((i) => printable(i.account)).join(', ')}.`] : []),
          ...(r.already_invited.length ? [`Already invited: ${r.already_invited.map((i) => printable(i.account)).join(', ')}.`] : []),
          ...(r.already_members.length ? [`Already in the team: ${r.already_members.map(printable).join(', ')}.`] : []),
          ...(r.declined_recently.length ? [`Declined in the last 30 days, so not asked again yet: ${r.declined_recently.map(printable).join(', ')}.`] : []),
          ...(r.invited.length || r.already_invited.length ? ['They join by running, with the GitHub account you named:', '  npx @konjir/konnect'] : []),
        ].join('\n'));
        return;
      }
      if (cmd === 'remove') {
        const r = await client.removeMember(storedName(rest[0].startsWith('@') ? rest[0] : `@${rest[0]}`)).catch((e) => { throw ownerOnly(e); });
        print(r, () => `Removed @${printable(r.removed)} from team ${team}${r.agents.length ? `, with their agents ${r.agents.map(printable).join(', ')}` : ''}: ${r.ended} session${r.ended === 1 ? '' : 's'} ended.`);
        return;
      }
      const r = await client.leave().catch((e) => { throw ownerOnly(e); });
      await logout(url, { path: teamFile(team, env), forget: true }).catch(() => undefined);
      print(r, () => `You left team ${team}${r.agents.length ? `, and your agents ${r.agents.map(printable).join(', ')} with you` : ''}. konnect forgot its sign-in here.`);
      return;
    } finally {
      await client.close();
    }
  }

  if (cmd === 'logout') {
    if (rest.length) throw new Error(`konnect logout [--team <name>] [--forget]: unknown ${printable(rest.join(' '))}`);
    const r = await logout(url, { path: teamFile(team, env), forget: parsed.forget }).catch((e: unknown) => { throw said(e, team, url); });
    print({ team, had: r.had, revoked: r.revoked }, () => (!r.had ? `You weren't signed in to team ${team}.`
      : r.revoked ? `Signed out of team ${team}.` : `Signed out of team ${team} here; Kolab couldn't be told, so the sign-in lapses within 30 days unused.`));
    return;
  }

  // What each command needs from the person comes first: nothing waits on the terminal with a session open.
  if (cmd === 'who' && rest.length) throw new Error(`konnect who: unknown ${printable(rest.join(' '))}`);
  if (cmd === 'read' && rest.length > 1) throw new Error(`konnect read [#channel | @name]: unknown ${printable(rest.slice(1).join(' '))}`);
  if ((parsed.history || parsed.limit !== undefined) && !(cmd === 'read' && rest[0] !== undefined && !rest[0].startsWith('@'))) {
    throw new Error('--history and --limit show a channel\'s recent messages: konnect read \'#channel\' --history [--limit n]');
  }
  if (parsed.reply !== undefined && cmd !== 'send') throw new Error('--reply answers a message as you send: konnect send … --reply <id> <message>');
  let target: Target | undefined;
  let message = '';
  if (cmd === 'send') {
    const [where, ...words] = rest;
    if (where === undefined) throw new Error('konnect send \'#channel\' | @name [message]: say where to send it');
    target = targetOf(where, (w) => `konnect send @${w} … for a member, or konnect send '#${w}' … for a channel`);
    message = words.join(' ');
    if (!words.length) {
      if (!io.stdin && process.stdin.isTTY) err('Type your message, then press Ctrl-D on a line of its own.');
      message = (await (io.stdin ?? readStdin)()).replace(/\r?\n$/, '');
    }
    if (!message.trim()) throw new Error('konnect send: the message is empty');
  }
  if (cmd === 'read' && rest[0] !== undefined) target = targetOf(rest[0], (w) => `konnect read @${w} for a member's messages, or konnect read '#${w}' for a channel`);
  let channelCmd: { verb: 'list' | 'new' | 'join' | 'leave'; name?: string } | undefined;
  if (cmd === 'channel') {
    const [verb, name, ...more] = rest;
    if (verb === 'list' || verb === undefined) {
      if (name !== undefined) throw new Error(`konnect channel list: unknown ${printable(rest.slice(1).join(' '))}`);
      channelCmd = { verb: 'list' };
    } else if (verb === 'new' || verb === 'join' || verb === 'leave') {
      if (name === undefined || more.length) throw new Error(`konnect channel ${verb} <name>: name one channel`);
      channelCmd = { verb, name: channelName(name) };
    } else {
      throw new Error(`konnect channel list|new|join|leave: no ${printable(verb)}`);
    }
  }

  const client = await TeamClient.open(team, url, teamFile(team, env));
  // The last line, when anything is unread elsewhere: from what the command has, else one read of the answers.
  const summary = async (known?: Parameters<typeof unreadLine>[0]) => {
    if (json) return;
    const u = known ?? await client.unread().catch(() => undefined);
    const line = u ? unreadLine(u) : '';
    if (line) out(`(${line})`);
  };
  try {
    if (cmd === 'who') {
      const members = await client.members();
      print(members.map((m) => ({ ...m, name: shownName(m) })), () => formatMembers(members));
      await summary();
      return;
    }

    if (cmd === 'send') {
      const to = target!;
      let r: Sent;
      try {
        r = await send(client, to, message, { replyTo: parsed.reply, warn: err });
      } catch (e) {
        if (e instanceof Refused && to.kind === 'direct' && /is not a member of kolab/.test(e.message)) throw new Error(`${printable(to.given)} isn't in team ${team}: konnect who lists who is`);
        throw e;
      }
      print(r.sent, () => {
        if (r.kind === 'direct') return `Sent to ${printable(to.kind === 'direct' ? to.given : '')}.`;
        const named = r.sent.mentions.map((m) => `@${printable(shownActor(m, r.members))}`);
        return `Sent to #${r.sent.channel}${named.length ? `, mentioning ${named.join(', ')}` : ''}.`;
      });
      await summary();
      return;
    }

    if (cmd === 'read') {
      // The names to show are looked up before anything is marked read, so a failure there loses
      // nothing; without them, messages show stored names. JSON gives stored names, so needs none.
      const members = json ? [] : await client.members().catch(() => [] as Member[]);
      const show = (ms: { from: string; message: string; sent_at: string }[]) => ms.map((m) => formatMessage(m, members)).join('\n\n');
      if (target?.kind === 'channel' && parsed.history) {
        const ms = (await client.channelHistory(target.channel, parsed.limit ?? 20)).reverse();
        print(ms, () => (ms.length ? `#${target!.kind === 'channel' ? target!.channel : ''}\n${show(ms)}` : `No messages in #${target!.kind === 'channel' ? target!.channel : ''} yet.`));
        await summary();
        return;
      }
      // Each block is printed as soon as it is read: reading marks it read, so a failure later
      // (or partway through this block) never loses what is already marked. JSON is printed once,
      // with what was read and, on a failure, why it stopped.
      const blocks: Block[] = [];
      let printed = 0;
      const onBlock = (b: Block) => {
        blocks.push(b);
        if (json || !b.messages.length) return;
        const text = blockLines(b, show, b.kind === 'channel' && (target === undefined || b.kind === 'channel'), target === undefined);
        out(`${printed++ ? '\n' : ''}${text}`);
      };
      const jsonOf = () => (target === undefined
        ? { direct: blocks.find((b) => b.kind === 'direct')?.messages ?? [], channels: blocks.filter((b): b is Extract<Block, { kind: 'channel' }> => b.kind === 'channel' && b.messages.length > 0).map((b) => ({ channel: b.channel, messages: b.messages })) }
        : blocks[0]?.messages ?? []);
      try {
        if (target === undefined) {
          const r = await readAll(client, onBlock);
          if (json) out(JSON.stringify(jsonOf(), null, 2));
          else if (!printed) out('No unread messages.');
          await summary(leftAfter(r.listed));
          return;
        }
        const b = await readOne(client, target);
        onBlock(b);
        if (b.error) throw b.error;
        if (json) out(JSON.stringify(jsonOf(), null, 2));
        else if (!printed) out(`No unread messages ${target.kind === 'channel' ? `in #${target.channel}` : `from ${printable(target.given)}`}.`);
        await summary();
        return;
      } catch (e) {
        if (json && blocks.some((b) => b.messages.length)) out(JSON.stringify({ read: jsonOf(), stopped: String((e as Error)?.message ?? e) }, null, 2));
        if (blocks.some((b) => b.messages.length)) throw new Error(`reading stopped early: ${(e as Error)?.message ?? e}. What is shown above was read and marked read`);
        throw e;
      }
    }

    if (cmd === 'channel') {
      const c = channelCmd!;
      if (c.verb === 'list') {
        const channels = await client.channels();
        print(channels, () => formatChannels(channels));
        await summary();
        return;
      }
      if (c.verb === 'new') {
        const made = await client.makeChannel(c.name!);
        print(made, () => `Made #${made.channel}. You follow it; anyone in the team can join it.`);
      } else if (c.verb === 'join') {
        const r = await client.follow(c.name!);
        print(r, () => `Following #${r.channel}: konnect read shows what is new there.`);
      } else {
        const r = await client.unfollow(c.name!);
        print(r, () => `Left #${r.channel}: you no longer follow it, though a message there that mentions you still reaches you.`);
      }
      await summary();
      return;
    }
  } finally {
    await client.close();
  }
}
