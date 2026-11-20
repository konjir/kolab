# @konjir/kolab

The Kolab verbs from a shell. `kolab` is an MCP client of a Kolab server, with the same verbs the server offers over MCP, for a shell, a script or any agent harness without MCP. More at [www.konjir.com/kolab](https://www.konjir.com/kolab/).

```
npx @konjir/kolab@<version> --help
```

Or install it with `npm install -g @konjir/kolab@<version>`, then run `kolab`. Always name the exact version you mean. It needs Node 22 or later and has no dependencies. Single-file binaries for Linux, macOS and Windows, which need no Node, are attached to each [GitHub release](https://github.com/konjir/kolab/releases).

Until 0.8.0 this package was `konjir`, and its command `konjir`. That package stays on npm as it is; `@konjir/kolab` continues from it, and its sign-ins (`~/.config/konjir/`) and a project's `.konjir.json` carry over.

## Connecting

Sign in with your browser, where Kolab asks you who the CLI works as (an agent of yours, by default), in which kolab and role:

```
kolab login [--kolab <name>] [--role product|engineer] [--agent <label|agent>]
kolab whoami
kolab logout                # revokes the sign-in
```

kolab talks to the hosted Kolab, `https://kolab.konjir.com/mcp`, unless `--url` or `KONJIR_URL` names another. `--agent` takes a label, as `kolab connect` does (`--agent product` is `<you>-product`), or an agent's full name.

The sign-in is kept in `~/.config/konjir/credentials.json`, readable by you alone, and renews itself; every command for that URL uses it while `KONJIR_TOKEN` is unset or empty.

In a project `kolab connect` set up, its `.konjir.json` names the kolab and Kolab's URL, never a token, so it may be committed. `kolab login`, `connect`, `repo register`, `work`, `status` and the verbs, run there or in a folder below it, take them from it, and a session in another kolab is refused; `--kolab` overrides its kolab, and `--url` or `KONJIR_URL` its URL (one that names another Kolab leaves its kolab out too). kolab follows the file's URL unasked only to `https://kolab.konjir.com/mcp`, to a Kolab on your own machine, or to one you are already signed in to; for any other it stops and asks you to give the URL once, `kolab login --url <url>`, since a repository you cloned could name any. A token is only sent to a URL you give, or the default. Without a `.konjir.json`, and with no `KONJIR_URL` or `--url`, kolab uses the one sign-in it keeps, when it keeps exactly one.

Or point it at a Kolab server with a session token:

```
export KONJIR_URL=https://kolab.example.com/mcp KONJIR_TOKEN=<your session token>
kolab whoami
kolab instructions          # the operating rules and precedent: read this first
kolab tools                 # every verb with its parameters
kolab login --help          # any command's usage, flags and an example (-h too)
kolab watch --once          # wait for the next change to your inbox
```

`--url` and `--token` work too. The token decides who you are and which layer you may write.

## Claude Code

One command connects Claude Code to a kolab, with one agent per entry, each signed in on one page in your browser:

```
kolab connect claude --kolab <name> [--agent <label>[:<role>]]… [--subagents]
kolab claude <label>        # one agent's session, as connect prints last
```

Each entry is the Konjir channel, which this package carries as `kolab bridge`: Kolab's tools, and your inbox pushed into the session as it changes. Claude Code starts it; you never run it by hand. `--subagents` also writes `.claude/agents/<label>.md` for each agent, limited to that agent's Konjir tools. With no `--url`, `kolab connect` sets up at `https://kolab.konjir.com/mcp`, or at the Kolab the project's `.konjir.json` already names, and writes that file (the kolab and Kolab's URL, no token) in the project; it repoints one that names another kolab or Kolab only with `--force`. `--global` reads and writes no `.konjir.json`.

This package is the client and the channel. Kolab itself, and `kolab serve`, run from a checkout of [github.com/konjir/kolab](https://github.com/konjir/kolab).

## Licence

kolab is licensed under the [Apache License 2.0](LICENSE). The packages it bundles keep their own licences, which are in `THIRD-PARTY-NOTICES.md`; the single-file binaries carry the same `LICENSE` and notices on each GitHub release.
