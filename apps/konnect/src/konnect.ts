/**
 * konnect: chat for a team's people and their AI agents, across machines. A team is a kolab on
 * Kolab underneath, and konnect is an MCP client of Kolab, as konjir is.
 *
 *   konnect team [<name>]              sign in to a team (GitHub, in the browser), or list your teams
 *   konnect who                        the team's members, and who is connected
 *   konnect send @name [message]       a direct message; the message from stdin when it is left out
 *   konnect read [@name]               your unread messages, oldest first, marked read
 *   konnect logout                     sign out of a team
 *
 * Every command takes --team <name> (optional with one team, or in a folder whose .konnect.json
 * names one) and --json. KONNECT_URL points konnect at another Kolab than the hosted one.
 */
import { login, logout, safeUrl } from '@konjir/login';
import { CLIENT_NAME, NotYet, Refused, TeamClient, said } from './client.js';
import { formatMembers, formatMessage, printable, shownName, storedName, type Member, type Message } from './names.js';
import { HOSTED_URL, PROJECT_FILE, allTeams, checkTeam, checkUrl, findProject, rememberTeam, teamFile, teamFileReady, teamsAt, trustedUrl, type Project } from './teams.js';

export { TeamClient, NotYet, Refused } from './client.js';
export { formatMembers, formatMessage, shownName, storedName, type Member, type Message } from './names.js';
export { HOSTED_URL, PROJECT_FILE, allTeams, configDir, findProject, readProject, rememberTeam, teamFile, teamsAt, trustedUrl } from './teams.js';

// The published build (scripts/bundle.mjs) defines this as the package's version.
declare const KONNECT_VERSION: string | undefined;

/** What `konnect help` says. */
export const USAGE = `konnect: chat for your team's people and AI agents, on Konjir.

  konnect team <name>             sign in to a team with GitHub, and remember it in this folder
  konnect team                    list your teams, and the one this folder remembers
  konnect who                     the team's members, and who is connected
  konnect send @name [message]    send a direct message (@owner/label for an agent);
                                  with no message, it reads one from stdin
  konnect read [@name]            your unread messages, oldest first, and marks them read
  konnect logout                  sign out of a team

  --team <name>   the team to use; not needed with one team, or where .konnect.json names one
  --json          print JSON instead of lines

Not available yet:
  konnect send '#channel' …       channel messages
  konnect read '#channel'
  konnect channel new|join|leave|list
  konnect recruit <github login>… invite people to your team
  konnect remove @name            remove a member, or leave
  konnect claude|codex|opencode <label>
                                  start an agent connected to the team
  konnect                         live chat

Sign-ins are kept in ~/.config/konnect (KONNECT_CONFIG_DIR), one per team. KONNECT_URL points konnect
at another Kolab than ${HOSTED_URL}.`;

/** What a command that the server can't serve yet says. */
const notYet = (what: string) => new NotYet(`${what} isn't available yet.`);

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
}

/** Takes `--name <value>` out of `args`. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  args.splice(i, 2);
  return v;
}

/** Takes `--name` out of `args`; whether it was there. */
function on(args: string[], name: string): boolean {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
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
  if (env.KONNECT_URL) return checkUrl(env.KONNECT_URL, 'KONNECT_URL');
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

/** The scope konnect's sign-in asks for: the team's kolab preselected on Kolab's page. */
export const signInScope = (team: string) => `konjir kolab:${team}`;

/**
 * `konnect team <name>`: signs in to an existing team the person is a member of, as themselves,
 * and keeps the sign-in in the team's own file. A sign-in kept already that still works is used
 * as it is. One that comes back as anyone but the person, or in another kolab, is revoked and
 * forgotten, never kept.
 *
 * Making a team whose name is free, and joining one by invitation, are the invitations track's: they
 * belong here, before the browser opens, once Kolab can do them.
 */
export async function signInToTeam(team: string, url: string, io: { open?: (u: URL) => void | Promise<void>; log: (l: string) => void; env: Record<string, string | undefined> }): Promise<{ me: { actor: string; kolab: string }; fresh: boolean }> {
  const file = teamFileReady(team, io.env);
  // Already signed in, and it still works: nothing to do.
  if (teamsAt(url, io.env).includes(team)) {
    try {
      const client = await TeamClient.open(team, url, file);
      try {
        const me = await client.whoami();
        if (me.kind === 'person' && me.kolab === team) return { me, fresh: false };
      } finally { await client.close(); }
    } catch { /* signed in afresh below */ }
  }
  let me;
  try {
    me = await login(url, {
      path: file, scope: signInScope(team), clientName: CLIENT_NAME, open: io.open, log: io.log,
      opening: `Opening your browser to sign in to team ${team} with GitHub. On Kolab's page, choose Yourself (not an agent) and kolab ${team}, then Allow.`,
      again: `run konnect team ${team} again`,
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/^Kolab didn't sign you in: the person declined$/.test(msg)) throw new Error(`you cancelled the sign-in to team ${team}: nothing was kept`);
    throw said(e, team, url);
  }
  if (me.kind !== 'person' || me.kolab !== team) {
    const r = await logout(url, { path: file, forget: true }).catch(() => ({ revoked: false }));
    const as = me.kind === 'person' ? `in kolab ${me.kolab}` : `as ${me.actor}, an agent`;
    throw new Error(`you signed in ${as}, not as yourself in team ${team}, so konnect kept nothing${r.revoked ? '' : ' (that sign-in lapses within 30 days unused)'}. Run konnect team ${team} again, and on Kolab's page choose Yourself and kolab ${team}. `
      + `If you aren't a member of ${team}, ask its owner to add you: konnect can't make a team or take an invitation yet.`);
  }
  return { me, fresh: true };
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
  if (!args.length) throw notYet('Live chat (konnect with no command)');

  const json = on(args, 'json');
  const teamFlag = flag(args, 'team');
  const [cmd, ...rest] = args;
  const print = (value: unknown, lines: () => string) => out(json ? JSON.stringify(value, null, 2) : lines());

  // Commands the server can't serve yet: said before anything is read or sent.
  if (cmd === 'channel') throw notYet('Channels (konnect channel)');
  if (cmd === 'recruit') throw notYet('Inviting people (konnect recruit)');
  if (cmd === 'remove') throw notYet('Removing a member (konnect remove)');
  if (['claude', 'codex', 'opencode'].includes(cmd)) throw notYet(`Starting an agent (konnect ${cmd})`);
  if ((cmd === 'send' || cmd === 'read') && rest[0]?.startsWith('#')) throw notYet(`Channel messages (konnect ${cmd} '${printable(rest[0])}')`);
  if (!['team', 'who', 'send', 'read', 'logout'].includes(cmd)) throw new Error(`konnect has no command ${printable(cmd)}: run konnect help`);

  const project = findProject(cwd);
  const url = kolabUrl(env, project);

  if (cmd === 'team') {
    if (rest.length > 1) throw new Error(`konnect team [<name>]: unknown ${rest.slice(1).join(' ')}`);
    const name = rest[0] ?? teamFlag;
    if (name === undefined) {
      const teams = teamsAt(url, env);
      const elsewhere = allTeams(env).filter((t) => !t.urls.includes(url));
      const here = project?.team;
      print({ url, teams, folder: here ?? null, elsewhere }, () => {
        const lines = teams.length ? teams.map((t) => `${t}${t === here ? '  (this folder)' : ''}`) : ['You aren\'t signed in to a team: run konnect team <name>.'];
        if (here !== undefined && !teams.includes(here)) lines.push(`This folder's ${printable(project!.path.split('/').pop()!)} names team ${here}, which you aren't signed in to: run konnect team ${here}.`);
        for (const t of elsewhere) lines.push(`${t.team}  (at ${t.urls.map(safeUrl).join(', ')})`);
        return lines.join('\n');
      });
      return;
    }
    const team = checkTeam(name);
    const { me, fresh } = await signInToTeam(team, url, { open: io.open, log: err, env });
    const path = rememberTeam(cwd, team, url);
    print({ team, actor: me.actor, url, signedIn: fresh ? 'now' : 'already', folder: path }, () =>
      `${fresh ? 'Signed in to' : 'Using'} team ${team} as ${me.actor}. This folder remembers it (${PROJECT_FILE}).`);
    return;
  }

  const team = chooseTeam(teamFlag, project, url, env);

  if (cmd === 'logout') {
    const forget = on(rest, 'forget');
    if (rest.length) throw new Error(`konnect logout [--team <name>] [--forget]: unknown ${rest.join(' ')}`);
    const r = await logout(url, { path: teamFile(team, env), forget }).catch((e: unknown) => { throw said(e, team, url); });
    print({ team, had: r.had, revoked: r.revoked }, () => (!r.had ? `You weren't signed in to team ${team}.`
      : r.revoked ? `Signed out of team ${team}.` : `Signed out of team ${team} here; Kolab couldn't be told, so the sign-in lapses within 30 days unused.`));
    return;
  }

  const client = await TeamClient.open(team, url, teamFile(team, env));
  try {
    if (cmd === 'who') {
      if (rest.length) throw new Error(`konnect who: unknown ${rest.join(' ')}`);
      const members = await client.members();
      print(members.map((m) => ({ ...m, name: shownName(m) })), () => formatMembers(members));
      return;
    }

    if (cmd === 'send') {
      const [who, ...words] = rest;
      if (who === undefined) throw new Error('konnect send @name [message]: say who to send it to');
      const to = storedName(who);
      let message = words.join(' ');
      if (!words.length) {
        if (!io.stdin && process.stdin.isTTY) err('Type your message, then press Ctrl-D on a line of its own.');
        message = (await (io.stdin ?? readStdin)()).replace(/\r?\n$/, '');
      }
      if (!message.trim()) throw new Error('konnect send: the message is empty');
      let sent: Message;
      try {
        sent = await client.sendDirect(to, message);
      } catch (e) {
        if (e instanceof Refused && /is not a member of kolab/.test(e.message)) throw new Error(`${printable(who)} isn't in team ${team}: konnect who lists who is`);
        throw e;
      }
      print(sent, () => `Sent to ${printable(who.startsWith('@') ? who : `@${who}`)}.`);
      return;
    }

    if (cmd === 'read') {
      if (rest.length > 1) throw new Error(`konnect read [@name]: unknown ${rest.slice(1).join(' ')}`);
      const from = rest[0] !== undefined ? storedName(rest[0]) : undefined;
      const messages = from === undefined ? await client.readDirect() : await client.unreadFrom(from);
      const members = messages.length ? await client.members() : [];
      print(messages, () => (messages.length ? messages.map((m) => formatMessage(m, members)).join('\n\n') : `No unread messages${from ? ` from ${printable(rest[0])}` : ''}.`));
      // Kolab marks one person's messages read only with all of yours (konjir_read_messages).
      if (from !== undefined && messages.length && !json) err('These stay unread for now: konnect read, with no name, reads and marks all of them.');
      return;
    }
  } finally {
    await client.close();
  }
}
