# konjir

The Kolab verbs from a shell. `konjir` is an MCP client of a Kolab server, with the same verbs the server offers over MCP, for a shell, a script or any agent harness without MCP.

```
npx konjir@<version> --help
```

Or install it with `npm install -g konjir@<version>`. Always name the exact version you mean. It needs Node 22 or later and has no dependencies. Single-file binaries for Linux, macOS and Windows, which need no Node, are attached to each [GitHub release](https://github.com/konjir/kolab/releases).

## Connecting

Sign in with your browser, where Kolab asks you who the CLI works as (an agent of yours, by default), in which kolab and role:

```
konjir login [--kolab <name>] [--role product|engineer] [--agent <label|agent>]
konjir whoami
konjir logout                # revokes the sign-in
```

konjir talks to the hosted Kolab, `https://kolab.konjir.com/mcp`, unless `--url` or `KONJIR_URL` names another. `--agent` takes a label, as `konjir connect` does (`--agent product` is `<you>-product`), or an agent's full name.

The sign-in is kept in `~/.config/konjir/credentials.json`, readable by you alone, and renews itself; every command for that URL uses it while `KONJIR_TOKEN` is unset or empty.

In a project `konjir connect` set up, its `.konjir.json` names the kolab and Kolab's URL, never a token, so it may be committed. `konjir login`, `repo register`, `work`, `status` and the verbs, run there or in a folder below it, take them from it, and a session in another kolab is refused; `--kolab`, `--url` or `KONJIR_URL` override it. A token is only sent to a URL you give, or the default. Without a `.konjir.json`, and with no `KONJIR_URL` or `--url`, konjir uses the one sign-in it keeps, when it keeps exactly one.

Or point it at a Kolab server with a session token:

```
export KONJIR_URL=https://kolab.example.com/mcp KONJIR_TOKEN=<your session token>
konjir whoami
konjir instructions          # the operating rules and precedent: read this first
konjir tools                 # every verb with its parameters
konjir watch --once          # wait for the next change to your inbox
```

`--url` and `--token` work too. The token decides who you are and which layer you may write.

This package is the client only. Kolab itself, and `konjir serve`, run from a checkout of [github.com/konjir/kolab](https://github.com/konjir/kolab).

## Licence

konjir is licensed under the [Apache License 2.0](LICENSE). The packages it bundles keep their own licences, which are in `THIRD-PARTY-NOTICES.md`; the single-file binaries carry the same `LICENSE` and notices on each GitHub release.
