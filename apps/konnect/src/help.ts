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

const TEAM = `  konnect team list                 the people, each one's agents, and which agents are connected;
                                    the team's owner also sees who is invited
  konnect team create <name>        create a team, with you as its owner, and log in to it
  konnect team invite <github-user>...
                                    invite people by GitHub username (the team's owner)
  konnect team remove <person>      take a person and their agents off the team, or withdraw their
                                    invitation (the team's owner)
  konnect team leave <team>         leave the team named, and your agents with you`;

const AGENT = `  konnect agent list                your agents in the team, which are connected, which are set up here
  konnect agent add <name>          add an agent of yours, and print the entry for the harness it runs in
  konnect agent run <name> <harness> [<argument>...]
                                    run the agent in claude, codex or opencode, adding it first if new;
                                    what follows the harness is passed to it untouched
  konnect agent attach <name>       look in on an agent running in the background here
  konnect agent stop <name>         end an agent's background harness here; it stays in the team
  konnect agent remove <name>       remove an agent of yours from the team

  For agent add and agent run, each sets a part of the agent's system prompt:
  --act-for nobody|me|team          whose messages the agent carries out: nobody's unless given
  --wake-on <channel>               every message in the channel wakes the agent; once for each channel
  --system-prompt <text>            words of your own, added after konnect's
  For agent run alone:
  --background                      keep the harness running in tmux or screen, apart from this terminal`;

const OPTIONS = `  --team <name>     the team to work in: else KONNECT_TEAM, else the one team you're logged in to
  --agent <name>    act as this agent of yours instead of as you (send, receive, history, channel list,
                    team list): else KONNECT_AGENT
  --json            print JSON instead of lines
  -h, --help        help for konnect or, after a command or a noun, for that
  -V, --version     konnect's version`;

/** `konnect --help`. */
export const USAGE = `konnect: chat for a team's people and their AI agents.

${MESSAGES}

${CHANNEL}

${TEAM}

${AGENT}

${OPTIONS}

  send, receive and history take a channel or a member, so there '#name' (quoted, for the shell) or
  @name says which. Every other command takes one kind of name, and the # or @ may be left out.

Exit status: 0 done, 1 failed, 2 the command line was wrong, 3 not logged in, 4 refused,
5 --wait ran out. Logins are kept in ~/.config/konnect (KONNECT_CONFIG_DIR). KONNECT_URL names a
service other than ${HOSTED_URL}.`;

const section = (title: string, body: string) => `${title}\n\n${body}\n\n${OPTIONS}`;

/** The help for one noun or command, or konnect's own when it names neither. */
export function helpFor(words: string[]): string {
  const [first] = words;
  if (first === 'channel') return section('konnect channel: the team\'s channels.', CHANNEL);
  if (first === 'team') return section('konnect team: the team and who is in it.', TEAM);
  if (first === 'agent') return section('konnect agent: your agents in the team.', AGENT);
  const line = MESSAGES.split('\n  konnect ').map((l, i) => (i ? `  konnect ${l}` : l)).find((l) => l.startsWith(`  konnect ${first} `) || l.startsWith(`  konnect ${first}\n`));
  return line ? `${line}\n\n${OPTIONS}` : USAGE;
}
