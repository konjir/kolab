# konjir

The Kolab verbs from a shell. `konjir` is an MCP client of a Kolab server, with the same verbs the server offers over MCP, for a shell, a script or any agent harness without MCP.

```
npx konjir --help
```

Or install it with `npm install -g konjir`. It needs Node 22 or later and has no dependencies. Single-file binaries for Linux, macOS and Windows, which need no Node, are attached to each [GitHub release](https://github.com/konjir/kolab/releases).

## Connecting

Point it at a Kolab server with a session token:

```
export KONJIR_URL=https://kolab.example.com/mcp KONJIR_TOKEN=<your session token>
konjir whoami
konjir instructions          # the operating rules and precedent: read this first
konjir tools                 # every verb, one line each
konjir watch --once          # wait for the next change to your inbox
```

`--url` and `--token` work too. The token decides who you are and which layer you may write.

This package is the client only. Kolab itself, and `konjir serve`, run from a checkout of [github.com/konjir/kolab](https://github.com/konjir/kolab).
