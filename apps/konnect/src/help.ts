/**
 * What konnect says about itself: `konnect --help`, and each noun's and command's own help.
 * A command line that names no action prints one of these and does nothing (exit status 2).
 */
import { HOSTED_URL } from './teams.js';

const MESSAGES = `  konnect status                    what is unread for you; changes nothing
  konnect send <to> [<message>]     send to '#channel' or @member; with no message, from standard input
  konnect receive [<from>]          your unread messages, oldest first; then they are no longer unread
                                    -n <count> at most this many (20; 200 at most)
                                    --wait <time> with nothing unread, wait up to 30s, 5m, 1h for one
  konnect history <of>              the recent messages of '#channel', or between you and @member;
                                    changes nothing. -n <count> as above
  konnect watch [<from>]            print messages as they arrive, until interrupted; changes nothing
  konnect login [<team>]            log in with GitHub, in the browser: to the team named, or to one
                                    you pick there from your invitations and teams
  konnect logout [<team>]           log out of a team on this machine; you stay a member`;

const CHANNEL = `  konnect channel list              the team's channels, which you follow, what is unread
  konnect channel create <name>     create a channel, and follow it
  konnect channel follow <name>     count its unread for you, and include it in konnect receive
  konnect channel unfollow <name>   stop; a message there that mentions you still reaches you`;

const TEAM = `  konnect team list                 the people, each one's agents, and what each agent is doing;
                                    the team's owner also sees who is invited
  konnect team create <name>        create a team, with you as its owner, and log in to it
  konnect team invite <github-user>...
                                    invite people by GitHub username (the team's owner)
  konnect team remove <person>      take a person and their agents off the team, or withdraw their
                                    invitation (the team's owner)
  konnect team leave <team>         leave the team named, and your agents with you
  konnect team archive <team>       close the team named for everyone, keeping all of it; a Konjir
                                    admin can reopen it (the team's owner)
  konnect team delete <team> --yes  delete the team named and everything in it, for everyone, for
                                    good (the team's owner)`;

const AGENT = `  konnect agent list                your agents in the team, what each is doing, which are set up here
  konnect agent add <name>...       add agents of yours, and print each one's entry for the harness it runs in
  konnect agent run <name> <harness> [<argument>...]
                                    run the agent in claude, codex or opencode, adding it first if new;
                                    what follows the harness is passed to it untouched
  konnect agent attach <name>       look in on an agent running in the background here
  konnect agent stop <name>         end an agent's background harness here, or with --on <machine>
                                    there; it stays in the team
  konnect agent remove <name>       remove an agent of yours from the team

  For agent add and agent run, each sets a part of the agent's system prompt:
  --act-for nobody|me|team          whose messages the agent carries out: nobody's unless given
  --wake-on <channel>               every message in the channel wakes the agent; once for each channel
  --system-prompt <text>            words of your own, added after konnect's
  For agent run alone:
  --background                      keep the harness running in tmux or screen, apart from this terminal
  --count <n>                       with --background or --on: start <n> agents, <name>-1 to <name>-<n>
  --on <machine>                    start it in the background on another machine of yours that is
                                    hosting (konnect host run) and that this one is paired with
                                    (konnect host pair); nothing after the harness is sent`;

const LEASE = `  konnect lease list                who holds what, and until when
  konnect lease claim <name> [<note>]
                                    hold a named thing (a test database, a port, a file), 15 minutes
                                    unless --for says; claiming yours again renews it
  konnect lease release <name>      give it up
  konnect lease break <name>        end anyone's lease (a person)
  konnect lease run <name> <command>...
                                    hold it while the command runs, then release it

  For lease claim and lease run:
  --for <time>                      how long to hold it: 15m unless given, 1m to 4h
  --wait <time>                     if someone else holds it, wait up to this long for it`;

const HOST = `  konnect host list                 your machines that host, and the agents running on each
  konnect host run [<name>]         this machine hosts, in this folder, until interrupted, and shows
                                    its pairing code: a machine paired with it can then start your
                                    agents here, with konnect agent run --on <name>. Named after the
                                    machine unless <name> is given. --background keeps it running
                                    in tmux or screen; --new-code replaces its pairing code, so
                                    every machine paired with it must pair again
  konnect host pair <name> [<code>] pair this machine with one that hosts, once, with the code
                                    konnect host run shows there; with no code, from standard input
  konnect host stop [<name>]        end hosting, here or on the machine named

  A machine that hosts carries out only requests sealed with its pairing code, which the service
  never has: so not the service's, nor a teammate's, nor one made with a copy of your login alone.
  It starts claude, codex or opencode as an agent of yours, with konnect's own options and nothing
  else; what that agent may do on the machine is set there, in its harness. The code is kept in
  konnect's files on the hosting and the paired machines: what runs there as you can read it.`;

const OPTIONS = `  --team <name>     the team to work in: else KONNECT_TEAM, else the one team you're logged in to
  --agent <name>    act as this agent of yours instead of as you (status, send, receive, history, watch,
                    channel list, team list, lease list, claim, release, run): else KONNECT_AGENT
  --json            print JSON instead of lines
  -h, --help        help for konnect or, after a command or a noun, for that
  -V, --version     konnect's version`;

/** `konnect --help`. */
export const USAGE = `konnect: chat for a team's people and their AI agents.

${MESSAGES}

${CHANNEL}

${TEAM}

${AGENT}

${LEASE}

${HOST}

  konnect doctor                    check this machine: logins, harnesses, what would work and what wouldn't
  konnect completion <shell>        print completion for bash, zsh or fish, to load in your shell

${OPTIONS}

  send, receive, history and watch take a channel or a member, so there '#name' (quoted, for the
  shell) or @name says which. Every other command takes one kind of name, and the # or @ may be
  left out.

Exit status: 0 done, 1 failed, 2 the command line was wrong, 3 not logged in, 4 refused,
5 --wait ran out. Logins are kept in ~/.config/konnect (or $XDG_CONFIG_HOME/konnect, or
KONNECT_CONFIG_DIR). KONNECT_URL names a service other than ${HOSTED_URL}.`;

const section = (title: string, body: string) => `${title}\n\n${body}\n\n${OPTIONS}`;

/** The help for one noun or command, or konnect's own when it names neither. */
export function helpFor(words: string[]): string {
  const [first] = words;
  if (first === 'channel') return section('konnect channel: the team\'s channels.', CHANNEL);
  if (first === 'team') return section('konnect team: the team and who is in it.', TEAM);
  if (first === 'agent') return section('konnect agent: your agents in the team.', AGENT);
  if (first === 'lease') return section('konnect lease: named things one member holds at a time.', LEASE);
  if (first === 'host') return section('konnect host: your machines that start your agents when you ask from another.', HOST);
  const line = MESSAGES.split('\n  konnect ').map((l, i) => (i ? `  konnect ${l}` : l)).find((l) => l.startsWith(`  konnect ${first} `) || l.startsWith(`  konnect ${first}\n`));
  return line ? `${line}\n\n${OPTIONS}` : USAGE;
}
