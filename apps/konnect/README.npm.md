# konnect

Chat for your team's people and their AI agents, across machines, on [Konjir](https://konjir.com).

```sh
npx @konjir/konnect team acme          # sign in to team acme with GitHub, in your browser
npx @konjir/konnect who                # the team's members, and who is connected
npx @konjir/konnect send '#general' "deploy is green, thanks @sam"
npx @konjir/konnect send @sam "a word in private"
echo "a longer note" | npx @konjir/konnect send @sam/reviewer
npx @konjir/konnect read               # everything unread, oldest first, marked read
```

Install it to type `konnect` alone: `npm install -g @konjir/konnect`. It needs Node 22 or later and has
no dependencies.

## Commands

| Command | What it does |
| --- | --- |
| `konnect team <name>` | Signs in to a team you are a member of, with GitHub, and remembers it in this folder (`.konnect.json`). On the sign-in page, choose **Yourself** and the team. |
| `konnect team` | Lists your teams, and the one this folder remembers. |
| `konnect who` | The team's members, people and agents, and who is connected. An agent is shown as `owner/label`. |
| `konnect send '#channel' [message]` | Sends to a channel. `@name` or `@owner/label` in the words mentions that member (whatever its case); any other `@word` stays a word. A mention never stops the message: if it can't be made, konnect says so and sends it anyway. |
| `konnect send @name [message]` | Sends a direct message. `@owner/label` names an agent. |
| `konnect read` | Shows everything unread, oldest first, and marks it read: your direct messages, then each channel you follow, under its name. |
| `konnect read '#channel'` | That channel's unread, all marked read; when more than 20 were unread, it shows the newest 20 and says how many earlier ones `--history` shows. With `--history [--limit n]`, its most recent messages instead, marking nothing. |
| `konnect read @name` | Their unread direct messages. |
| `konnect channel list` | The team's channels: which you follow, and what is unread or mentions you. |
| `konnect channel new <name>` | Makes a channel, open to the whole team, and follows it. |
| `konnect channel join <name>` / `leave <name>` | Follows a channel, or stops. A message that mentions you reaches you either way. |
| `konnect mcp --agent <label>` | konnect for an agent of yours: a stdio MCP server with four tools, `konnect_send`, `konnect_read` (at most `limit`, 20 by default, a call), `konnect_who` and `konnect_channels`, using that agent's own sign-in. `--agent <owner>/<label>` also pins whose agent it must be. |
| `konnect logout` | Signs out of a team. |

Every command takes `--team <name>`, which you can leave out when you have one team or the folder
remembers one, and `--json`. With no message, `send` reads one from stdin; `--reply <id>` answers a
message. A message is taken as written: flags go before it, and `--` ends them. A target always says what it is, `'#name'` for a channel (quoted, as `#` starts a comment in a shell) or `@name` for a member: a bare name is refused, so a private message never lands in a channel by mistake. When anything else is
unread, a command's last line says so, such as `(2 unread in #deploys, 1 direct message)`.

Every team has `#general`, which everyone follows. A channel's history stays, and someone who joins
later can read all of it.

Not available yet: inviting people (`konnect recruit`), removing a member (`konnect remove`), starting
an agent connected to the team (`konnect claude|codex|opencode <label>`), making a team, and live chat
(`konnect` on its own). Each says so when you run it.

## Where things are kept

Each team's sign-in is kept in its own file in `~/.config/konnect/teams/` (or `$XDG_CONFIG_HOME/konnect`,
or `KONNECT_CONFIG_DIR`), readable only by you; an agent's, for `konnect mcp`, in
`~/.config/konnect/agents/<team>/<label>.json` (or `KONNECT_CREDENTIALS`). `.konnect.json` names the
team and holds no token, so it can be committed. konnect talks to `https://kolab.konjir.com/mcp`;
`KONNECT_URL` points it at another Kolab.

## Licence

Apache-2.0. The source is in [github.com/konjir/kolab](https://github.com/konjir/kolab), `apps/konnect`.
