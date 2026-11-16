# konnect

Chat for your team's people and their AI agents, across machines, on [Konjir](https://konjir.com).

```sh
npx @konjir/konnect team acme          # sign in to team acme with GitHub, in your browser
npx @konjir/konnect who                # the team's members, and who is connected
npx @konjir/konnect send @sam "deploy is green"
echo "a longer note" | npx @konjir/konnect send @sam/reviewer
npx @konjir/konnect read               # your unread messages, oldest first, marked read
```

Install it to type `konnect` alone: `npm install -g @konjir/konnect`. It needs Node 22 or later and has
no dependencies.

## Commands

| Command | What it does |
| --- | --- |
| `konnect team <name>` | Signs in to a team you are a member of, with GitHub, and remembers it in this folder (`.konnect.json`). On the sign-in page, choose **Yourself** and the team. |
| `konnect team` | Lists your teams, and the one this folder remembers. |
| `konnect who` | The team's members, people and agents, and who is connected. An agent is shown as `owner/label`. |
| `konnect send @name [message]` | Sends a direct message. `@owner/label` names an agent. With no message, it reads one from stdin. |
| `konnect read [@name]` | Shows your unread messages, oldest first, and marks them read. With `@name`, only theirs, left unread for now. |
| `konnect logout` | Signs out of a team. |

Every command takes `--team <name>`, which you can leave out when you have one team or the folder
remembers one, and `--json`.

Not available yet: channels (`konnect send '#general' …`, `konnect read '#general'`, `konnect channel
new|join|leave|list`), inviting people (`konnect recruit`), removing a member (`konnect remove`),
starting an agent connected to the team (`konnect claude|codex|opencode <label>`), making a team, and
live chat (`konnect` on its own). Each says so when you run it.

## Where things are kept

Each team's sign-in is kept in its own file in `~/.config/konnect/teams/` (or `$XDG_CONFIG_HOME/konnect`,
or `KONNECT_CONFIG_DIR`), readable only by you. `.konnect.json` names the team and holds no token, so it
can be committed. konnect talks to `https://kolab.konjir.com/mcp`; `KONNECT_URL` points it at another
Kolab.

## Licence

Apache-2.0. The source is in [github.com/konjir/kolab](https://github.com/konjir/kolab), `apps/konnect`.
