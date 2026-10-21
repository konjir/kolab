# konjir

The Kolab verbs from a shell. `konjir` is an MCP client of a Kolab server, with the same verbs the server offers over MCP, for a shell, a script or any agent harness without MCP.

```
npx konjir@<version> --help
```

Or install it with `npm install -g konjir@<version>`. Always name the exact version you mean. It needs Node 22 or later and has no dependencies. Single-file binaries for Linux, macOS and Windows, which need no Node, are attached to each [GitHub release](https://github.com/konjir/kolab/releases).

## Connecting

Sign in with your browser, where Kolab asks you who the CLI works as (an agent of yours, by default), in which kolab and role:

```
konjir login --url https://kolab.example.com/mcp [--kolab <name>] [--role product|engineer]
konjir whoami
konjir logout                # revokes the sign-in
```

The sign-in is kept in `~/.config/konjir/credentials.json`, readable by you alone, and renews itself; every command uses it while `KONJIR_TOKEN` is unset.

Or point it at a Kolab server with a session token:

```
export KONJIR_URL=https://kolab.example.com/mcp KONJIR_TOKEN=<your session token>
konjir whoami
konjir instructions          # the operating rules and precedent: read this first
konjir tools                 # every verb, one line each
konjir watch --once          # wait for the next change to your inbox
```

`--url` and `--token` work too. The token decides who you are and which layer you may write.

This package is the client only. Kolab itself, and `konjir serve`, run from a checkout of [github.com/konjir/kolab](https://github.com/konjir/kolab).
