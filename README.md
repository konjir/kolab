# Kolab

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/konjir-wordmark-on-dark.svg">
    <img alt="Konjir" src="brand/konjir-wordmark-on-light.svg" width="280">
  </picture>
</h1>

<p align="center"><strong>Name it true.</strong><br>Where intent is spoken once, and agents answer.</p>

> Konjir's requirements, design and decisions live in the Konjir artifacts on claude.ai, starting with the [Decisions Log](https://claude.ai/code/artifact/ef4df29b-5618-43d5-bc42-d36a24c3962c). [`CLAUDE.md`](CLAUDE.md) lists all of them and gives the rules. This README describes the code as it is today. Where it disagrees with the artifacts, the artifacts are the intent. For example, the Bedrock reviewer described below has been decided out (D4) but not yet removed.

Prototype of Konjir's engine and its delivery rails:

- **Kolab:** versioned specs with stable element IDs, the invalidation cascade, child-spec overrides with the three-way rule, the review gate, and role enforcement. It implements the three decisions in *Konjir — Open Design Decisions*.
- **An MCP server:** stateless Streamable HTTP, MCP spec 2026-07-28, with the SDK's fallback for 2025-era clients. It's a NestJS app; each verb is an `@McpTool` method, and the inboxes and the operating-instructions prompt are `@McpResource` and `@McpPrompt` methods.
- **A `konjir` CLI:** the same verbs for a shell or any harness without MCP. It is an MCP client of Kolab, so there is one backend.

TypeScript on Postgres, through [Kysely](https://kysely.dev). Give `konjir serve` a `--database-url` (or `KONJIR_DATABASE_URL`) for a Postgres server. Without one, Kolab runs on embedded Postgres ([PGlite](https://pglite.dev), Postgres in WASM), so local development needs no server.

```
npm install
npm test                  # builds every project, then 206 unit, scenario, regression, migration, concurrency, agent, channel, review, push and end-to-end tests on Jest through Nx
npm run test:postgres     # the same tests on Postgres 18 in a container, as a non-superuser like RDS's (needs Docker)
npm run typecheck         # every project
npm run build             # every project, to its dist/
npm run measure -- 10 40  # fan-out of one spec edit under four addressing modes
npm run rebase-storm      # one parent commit rebasing many variants (W2.7); results in libs/engine/scripts/REBASE-STORMS.md
```

CI (`.github/workflows/ci.yml`) runs three checks on every pull request into main and every push to main. Test on PGlite and Test on Postgres run the equivalents of `npm test` (with typecheck and build) and `npm run test:postgres`. Each runs only the Nx projects affected since the base: main for a pull request, the last passing commit for main. Both run as production does: on arm64, with the Node version that `deploy/terraform/modules/kolab/main.tf` installs (`node_version`). Check Terraform runs `terraform fmt -check -recursive`, then `terraform init -backend=false` and `terraform validate`, on `deploy/terraform`, with no AWS credentials. It runs on every change, so main can require it.

A test file tears down in one order: its servers and clients, then its Kolabs, then its databases. `jest.setup.js` runs `closeOpened` from `@konjir/engine/testing` after each file, which does that. So a test registers each server, client or child process it starts with `closeAtEnd`, and opens Kolabs with `openKolab` or `setup`, rather than closing them in an `afterAll` of its own: Jest runs `jest.setup.js`'s `afterAll` before the file's own.

The repository is an [Nx](https://nx.dev) workspace of npm workspaces. Run one project's target with `npx nx run <project>:<target>`, for example `npx nx run @konjir/engine:test`.

| Project | Folder | What it holds |
| --- | --- | --- |
| `konjir` | `apps/cli` | The CLI, an MCP client of Kolab. `konjir serve` also starts the server. |
| `@konjir/channel-bridge` | `apps/channel-bridge` | The Konjir channel: a Claude Code plugin whose stdio server forwards Kolab inbox changes into the session |
| `@konjir/server` | `apps/server` | The MCP server: a NestJS app serving `/mcp` through [`@onivoro/server-mcp`](https://www.npmjs.com/package/@onivoro/server-mcp), and `/healthz`. Also the Bedrock reviewer, until W1.7 removes it. |
| `@konjir/engine` | `libs/engine` | Versions, links, marks, the cascade, rebases and roles. `@konjir/engine/testing` has the test helpers. |
| `@konjir/address` | `libs/address` | `kj:` addresses, fingerprints and quote re-anchoring, on [diff-match-patch](https://github.com/antfu/diff-match-patch-es) |
| `@konjir/db` | `libs/db` | The schema, as versioned SQL migrations, and the connection |
| `@konjir/types` | `libs/types` | Types and constants shared by the server, CLI and engine |

Each package's `exports` give two entry points. The `@konjir/source` condition points at its TypeScript source, which development uses: `bin/konjir` runs it through `tsx`, Jest resolves it, and type-checking follows it. The default points at the compiled `dist/`, which production runs on plain `node`, and which other projects build against through its declarations. `tsx` is a development dependency only.

Each release carries its own `deploy/release/install.sh` and `start.sh`; the instance's boot script only calls them, so changing either ships with a plain `terraform apply`. The release ships source, not `dist/`. `install.sh` builds it on the instance: a full `npm ci --ignore-scripts`, then every project's Nx `build` target (tsc), then `npm ci --omit=dev`, so the release keeps its `dist/` but no build tools. `start.sh` runs `node apps/cli/dist/main.js serve`.

## Changing the schema

The schema is the SQL files in `libs/db/src/migrations`, applied in order (DAT2). `0001_schema.sql` is the core schema; each later file changes it. When Kolab opens a database, it applies the files it hasn't recorded yet, in one transaction under an advisory lock. It records each one in the `kj_migration` table, with the sha256 of the file's text. A second Kolab process opening the same database waits for the first, then finds nothing left to do. A migration that fails rolls the whole open back, and the error names its file. Kolab refuses to open a database in two cases:

- it's recorded at a migration this release doesn't have
- a recorded file's text has changed since it was applied

The error names the file.

A database made before migrations began has Kolab's tables but no `kj_migration` table. Those are PGlite data directories from release 0.5 on, and the test server's first RDS database. Kolab runs `baseline.sql` on it once, which brings it to 0001 with idempotent statements. It then records 0001 as baselined, with 0001's checksum.

To change the schema:

1. Add `libs/db/src/migrations/NNNN_what_it_does.sql`, numbered one past the last file. The name must be four digits, an underscore, then lowercase letters, digits and underscores. Any other `.sql` file in the folder stops Kolab loading, so a misnamed migration can't be skipped.
2. Never edit a file that has shipped, not even a comment, and never edit `baseline.sql`. An edited file would never reach databases that already ran it, so Kolab refuses them instead. `libs/db/src/migrations/checksums.json` pins the sha256 of every `.sql` file in the folder. Kolab refuses to load if any file differs from its pin, has no pin, or is pinned but missing. The release zips the working tree, untracked files included, so this check is what keeps a draft migration from shipping. Add the new file's checksum there (`shasum -a 256 <file>`) when it's ready to ship, and never change an existing one.
3. Write plain SQL that runs once. It doesn't need to be idempotent. Every file runs inside the runner's one transaction, so a file may not contain `begin`, `commit`, `rollback`, `end`, `abort`, `start transaction`, `savepoint`, `release` or `prepare transaction`. Kolab rejects such a file when it loads. The same words are fine inside comments, string literals (including `E'…'` strings), quoted identifiers, and dollar-quoted bodies: `do $$ … $$` blocks and `as $$ … $$` functions. Write a function's body dollar-quoted, not as a SQL-standard `begin atomic … end` body, whose `end` the check can't tell apart. Avoid statements that can't run in a transaction, such as `create index concurrently`. Statements that create roles must guard against another database on the same cluster creating them first, as `0001_schema.sql` does.
4. **A new table** gets no rights by itself. The engine writes as `kj_agent` or `kj_system` through `set local role`, so grant each what it needs explicitly. If the table holds kolab data, enable row-level security and add policies like those in 0001. Grants on all tables are fine: Kolab revokes everything on `kj_migration` from `kj_agent`, `kj_system` and `public` after every migration.
5. **Value lists.** `MARK_REASONS`, `QUERY_KINDS` and `ACTOR_KINDS` in `@konjir/types` are also written out in the database's `invalidation_reason_check`, `query_kind_check` and `actor_kind_check`. A change to any of them needs a migration that drops the check and adds it again with the whole new list. The test "the database's value lists are @konjir/types' MARK_REASONS, QUERY_KINDS and ACTOR_KINDS" fails until there is one. Before removing a value, the migration must deal with the rows that use it.
6. Run `npm test` and `npm run test:postgres`.

The files ship as they are: the release runs `libs/db/src`, and `npm run build` copies them to `libs/db/dist/migrations`, so they are found from either.

## Running it with agents

```
# 1. Start Kolab. It persists to ./.konjir and prints an admin token.
bin/konjir serve --port 7420

# 2. Register a person and the agents they own, and give each agent a session (one actor, one active role).
export KONJIR_URL=http://127.0.0.1:7420/mcp KONJIR_TOKEN=<admin token>
bin/konjir admin_add_actor id=lee
bin/konjir admin_add_actor id=lee-pm owner=lee
bin/konjir admin_add_actor id=lee-eng owner=lee
bin/konjir admin_open_session actor=lee-pm role=product        # prints the agent's token
bin/konjir admin_open_session actor=lee-eng role=engineer
bin/konjir admin_list_actors owner=lee                         # a person's agents
```

Then point each harness at Kolab with its own token. The token decides who the agent is and which layer it may write. Tool arguments never carry identity.

An actor is a person, or an agent owned by a person. Each agent is an actor of its own: it holds its own session, so one person's agents can each hold one at the same time, and it is the author of what it writes. `whoami` names the agent and its `owner`, and `read_node` gives each version's `author`, with the agent, its owner and its role. An actor's kind and owner never change once it's added, so past authorship stays as it was written. An id is letters, digits, `.`, `_`, `-` and `@`, and `kolab` is reserved for Kolab's own work. An agent's owner must be a person; agents owned by an organization, and the grants an agent may not exceed, come with accounts and grants (W1.3). Until then any actor may activate either role.

- **Claude Code:** `claude mcp add --transport http konjir http://127.0.0.1:7420/mcp --header "Authorization: Bearer <token>"`
- **Any MCP client:** an HTTP server entry with an `Authorization: Bearer <token>` header.
- **Anything with a shell** (Codex, opencode, a person): `export KONJIR_URL=… KONJIR_TOKEN=<token>`, then `bin/konjir instructions`.

That one connection is the only static setup a harness needs. The rules come down the protocol, as server instructions and the `konjir_operating_instructions` prompt (`konjir instructions` in a shell). The served text includes answered questions and override precedent, so settled questions aren't re-asked.

### Pushing the inbox into a Claude Code session

Kolab signals inbox changes over `subscriptions/listen`, but Claude Code doesn't hand those notifications to the model. The Konjir channel does: `apps/channel-bridge` is a Claude Code plugin whose stdio server listens to Kolab with the session's token and forwards each change to its inbox (`konjir://inbox/{layer}`) or its answers (`konjir://answers/{actor}`) as a [channel](https://code.claude.com/docs/en/channels-reference) message. Each message says what changed and how to read it. It serves only the 2025-era protocol, because Claude Code doesn't register a channel server that negotiates 2026-07-28, and it reconnects when Kolab restarts.

It runs in place from a Kolab checkout, so run `npm install` there first, and install it only from that checkout's local path. A marketplace added from GitHub copies the plugin into Claude Code's cache, away from the workspace's packages, and the bridge won't start. Channels are a research preview and this one isn't on Anthropic's allowlist, so it loads with the development flag, in an interactive session (`-p` ignores the flag). Start Claude Code with the agent's own session token, the one its Konjir MCP server uses. Never give it the admin token that step 2 exports: set both variables on the `claude` command itself, as below, or start from a fresh shell. If the bridge gets a token that isn't an agent session token, it tells the session so once, and waits.

```
# For one session, straight from the checkout:
KONJIR_URL=http://127.0.0.1:7420/mcp KONJIR_TOKEN=<the agent's session token> \
  claude --plugin-dir ~/github.com/konjir/kolab/apps/channel-bridge \
  --dangerously-load-development-channels plugin:konjir-channel@inline

# Or install it from the checkout's marketplace (local path only), then start sessions with the plugin:
claude plugin marketplace add ~/github.com/konjir/kolab
claude plugin install konjir-channel@konjir
KONJIR_URL=http://127.0.0.1:7420/mcp KONJIR_TOKEN=<the agent's session token> \
  claude --dangerously-load-development-channels plugin:konjir-channel@konjir
```

Choose **I am using this for local development** at the warning. Work already waiting arrives first, as one `← konjir: Your functional inbox already holds …` message. Each new question, note, mark or answer after that arrives as `← konjir: Your functional inbox changed: …`. Items leaving the inbox, such as the agent's own answers and clears, send nothing. The plugin loads in place from a marketplace added from a local path, so it keeps using this checkout's `node_modules`. On Team and Enterprise plans an admin must enable channels first.

## Deploying to AWS for testing

Everything is provisioned by Terraform, so `terraform destroy` removes all of it. The one exception is the bucket that holds Terraform's own state, which a script creates once.

You need:

- Terraform 1.15 or later
- AWS CLI v2 with a profile named `icedlee337` for the account that owns the `konjir.com` hosted zone
- `npm install` run once in this folder (the `konjir` CLI runs locally)

```
deploy/bootstrap-state.sh          # once: creates s3://konjir-terraform (versioned, encrypted, TLS-only)
cd deploy/terraform
terraform init
terraform apply                    # ~5–10 min the first time; ends when the code is installed
cd ../..
deploy/konjir-ops.sh connect lee product     # prints Lee's token and the Claude Code command
deploy/konjir-ops.sh connect eng-1 engineer
deploy/konjir-ops.sh connect lee-pm product lee   # an agent of Lee's, with its own token
```

The backend (`deploy/terraform/backend.tf`) stores state at `s3://konjir-terraform/konjir/test/terraform.tfstate` in `us-east-1`, using the `icedlee337` profile. It locks with S3's native lock file, so no DynamoDB table is needed.

| Module | What it creates |
| --- | --- |
| `network` | A VPC with one public subnet, and two private subnets for the database. Inbound is 443, plus 80 for certificate issuance; there is no SSH. |
| `storage` | The release bucket (emptied on destroy), the encrypted data volume, and daily snapshots kept 7 days |
| `database` | Postgres 18 on RDS (`db.t4g.micro`, 20 GB, encrypted, 7 days of backups), reachable only from Kolab over verified TLS. Its URL is an SSM SecureString |
| `secrets` | A generated admin token, stored as an SSM SecureString |
| `iam` | The instance role: Session Manager access, read its releases, token and database URL, call Bedrock for the review gate |
| `kolab` | A `t4g.small` running Amazon Linux 2023, with Caddy for automatic HTTPS, an Elastic IP and the Route 53 record for `kolab.konjir.com` |
| `release` | Zips this repo, uploads it, and installs it on Kolab through Systems Manager. `terraform apply` is the deploy |

Kolab listens on localhost only, behind Caddy. Its database is on RDS, apart from the instance, so replacing the instance is safe. A change to the boot script replaces it automatically. The data volume still holds the PGlite database Kolab used before RDS. The rough cost is $30–35 a month at list price.

Day to day:

- **Ship code:** `terraform apply`. A code change alters the release hash, and Terraform reinstalls and waits for success.
- **Turn on semantic review:** `terraform apply -var review_mode=bedrock`. Enable the model under *Model access* in the Bedrock console first.
- **Inspect:** `deploy/konjir-ops.sh status`, `logs` or `bootstrap-log`. `shell` opens a session; it needs the Session Manager plugin.
- **OS refresh:** `terraform apply -replace=module.kolab.aws_instance.kolab`. The AMI is pinned when the instance is created.
- **Tear down:** `terraform destroy`. Final snapshots of the data volume and the database are kept by default. For a teardown that leaves nothing, run `terraform apply -var final_snapshot_on_destroy=false` first, then `terraform destroy -var final_snapshot_on_destroy=false`. The apply is needed because destroy reads the database's snapshot setting from state. Daily volume snapshots made before the teardown remain until you delete them. The state bucket stays until you remove it.

The admin token is generated by Terraform, so it is also in the state file. That is why the state bucket is private, encrypted and TLS-only.

**Testing only.** This is one instance with no failover. Tokens are bearer tokens with no expiry or single sign-on: hand them out privately, and revoke them with `admin_end_session`. Before real use, replace them with OAuth.

## Who pays for which model calls

Konjir splits model usage along one line: the server does a small, bounded check, and all the real work happens in collaborators' own harnesses.

| Work | Runs where | Paid by |
| --- | --- | --- |
| Authoring specs, bindings, plans; implementing; answering questions | Each collaborator's harness (Claude Code, Codex, opencode, …) | That collaborator's own subscription or API account |
| The review gate's semantic check | The Konjir server | The operator's AWS account, via Amazon Bedrock |
| Cascade, addressing, rebase, roles | The Konjir server | No model at all |

The server is built so it can't drift across that line:

- **It never asks for, stores, or relays a collaborator's model credentials.** A collaborator's token identifies them to Konjir and nothing else.
- **It never borrows a client's model.** It doesn't use MCP sampling or any other way to make a collaborator's harness run inference on the server's behalf. When the server needs judgment beyond its gate, it raises a question to a person, who answers from their own harness, by their own choice.
- **Each collaborator's model use stays inside their own harness and account.** Konjir doesn't pool, share or proxy anyone's access. Whether a given plan permits a given use (for example, connecting an MCP server, or how much automated work a subscription may drive) is set by that provider's terms. Each collaborator should confirm their own plan covers how they use it.

### Turning on semantic review

```
export AWS_REGION=us-east-1            # plus AWS credentials: role, profile, or env vars
export KONJIR_REVIEW=bedrock
export KONJIR_REVIEW_MODEL=anthropic.claude-haiku-5-5   # the default
bin/konjir serve
```

Any Bedrock model with tool use works. Claude IDs (`anthropic.*`) go through Bedrock's Messages API; everything else goes through the Converse API with the same prompt and tool. List prices per million tokens as of October 2026:

| Model | `KONJIR_REVIEW_MODEL` | Input | Output |
| --- | --- | --- | --- |
| Claude Haiku 5.5 (default) | `anthropic.claude-haiku-5-5` | $0.10 | $0.50 |
| Kimi K2.5 | `moonshotai.kimi-k2.5` (in-region only) | $0.60 | $3.00 |
| Kimi K3 | `global.moonshotai.kimi-k3` | $3.00 | $15.00 |

Haiku 5.5's price rises to $0.50 / $2.50 above 100k input tokens per request. Review prompts stay well under that, since the gate rejects anything over 120k characters. Prices change, so check the Bedrock pricing page for your region before switching.

The account needs access to the model in Amazon Bedrock (check *Model access* in the console). Each review is one forced tool call, `report_review`, with `max_tokens` 1500. The input is the version's elements plus the text of the requirements they link to.

- **Free checks run first.** Structural failures (empty, duplicated, malformed) are rejected without a model call.
- **Repeats are cached.** A rebase that produces content the gate has already seen is a cache hit.
- **Usage is logged.** The server logs tokens per review and running totals to stderr.
- **What the reviewer reports:**
  - *Contradiction:* rejects the version and names the elements involved.
  - *Layer leak:* commits, then raises a `role_boundary` mark and a question to the layer that owns the answer. Implementation detail in a spec goes back to its author; a binding that changes behavior goes to the spec it links to. Answering the question clears the mark.
  - *Model unavailable* (outage, throttling, missing credentials): the draft is left intact and the agent is told to resubmit. Nothing commits unreviewed.
- **Spec text is treated as data.** It is escaped and fenced in the prompt, so it can't pose as instructions to the reviewer.

The semantic reviewer is tested against a scripted model and stubbed Bedrock clients for both APIs. It has not yet run against live Bedrock. Run one review with your chosen model on a real account before relying on it; Kimi in particular has only been checked for the request shape, not for how well it follows the review instructions.

## Verbs

| Verb | Does |
| --- | --- |
| `whoami` | Your actor, its kind (`person` or `agent`), the person who owns it, your role and layer |
| `list_nodes`, `read_node`, `resolve` | Read current state; `resolve` takes any address. `read_node` says who wrote the version |
| `lineage` | What a node depends on (upstream) or what depends on it (downstream) |
| `list_stale` | Open marks on your layer: what is dirty, why, and the next step |
| `list_queries` | Questions and notes your layer owns; `mine=true` for the ones you raised, with answers |
| `create_node`, `draft`, `submit_for_review` | Author. `draft` takes deltas or full elements, plus `links` |
| `link` | Declare that one of your elements relies on an address |
| `clear_mark`, `resolve_override` | Settle a mark |
| `ask`, `annotate`, `answer_query` | The question tier. Questions and notes route to the layer that owns the answer; see below |
| `admin_add_actor`, `admin_list_actors`, `admin_open_session`, `admin_end_session` | Admin token only. `admin_add_actor owner=<person>` adds an agent of that person |

In a shell, `konjir help <verb>` gives a verb's parameters, and `konjir <verb> key=value …` calls it. `konjir watch` streams your inbox (see below).

## Questions, notes and push

An engineer writing a binding talks to the spec through two verbs:

- **`ask`** is for a decision the engineer needs before they can proceed. Pass `from=<binding element>` to name the element that waits on it. When product answers, that element gets a `query_answered` mark carrying the question and the answer. Editing the element, or `clear_mark`, settles it. The answer reaches the binding even if the spec text never changes.
- **`annotate`** leaves a note: an interpretation the engineer is going ahead with, an assumption, a risk, or something they couldn't check. It blocks nothing, but it waits in product's queue until product replies, so product can object. A reply to a note marks nothing.

Both can target an element or a quoted span (`kj:orders#R13~q({"exact":"50 meters"})`). `read_node` shows them beside the element they're about, open and answered, including ones asked on earlier versions of the spec. Either layer can use them in either direction.

**Push.** Each layer has an inbox resource, `konjir://inbox/functional` and `konjir://inbox/technical`, holding its open questions, notes and marks. Each actor has `konjir://answers/<actor>`, which holds what they raised, with replies. `whoami` lists the two for the session. Kolab declares `resources.subscribe` and signals a resource whenever it changes, over MCP 2026-07-28 `subscriptions/listen`. A client that listens gets `notifications/resources/updated` and re-reads the resource. Only the URI is pushed, never the content, and reading `answers` is limited to its own actor. Ending a session closes its open listen streams at once, as the server closing the subscription, and nothing more is signalled to them. Each change is also checked against the session before it is signalled, so a session ended any other way closes its stream on the next change instead. Its token is then refused (401), so a client that reconnects with it learns it was revoked. A listen stream whose session ends while it is opening is refused in-band instead: HTTP 200 with the JSON-RPC error `-32003` and `data.reason` `session_ended`, which the channel bridge and `konjir watch` treat as the token revoked, as they do a 401. The session is checked as each stream opens, so if that check fails (the database is unreachable, say) the stream is refused as `gate_failed`, or `gate_timeout` after 10 seconds, rather than opened and checked at the next change; the bridge retries those with backoff, and `konjir watch` says to run it again. [`@onivoro/server-mcp`](https://www.npmjs.com/package/@onivoro/server-mcp) tracks, gates and closes the streams (`McpHttpService.closeListenStreams` and the auth strategy's `acceptListenStream`); Kolab says which to close. Other sessions' streams, including those of the same person's other agents, are untouched.

**Push across processes.** Several Kolab processes can serve one Postgres database, and an agent listening on any of them hears a change made through any other (API5). Each engine event is sent with Postgres `NOTIFY` inside the transaction that commits its change, so it is delivered only if the change commits, and never on a rollback. Each process `LISTEN`s on the `konjir_events` channel over one connection of its own, apart from its pool, through [`@onivoro/server-pg-notify`](https://www.npmjs.com/package/@onivoro/server-pg-notify)'s `NotificationListener` (its Nest-free `/listener` entry), which reconnects with backoff (1 s, doubling to 30 s, without limit) when the connection drops, and stops when the process closes. A process tells its own listeners once the transaction commits, and skips its own notification when it hears it back, so nothing is signalled twice. The payload is the event (a layer, an actor, or an ended session's sessionKey), not the content; an event too long for `NOTIFY` is sent as a signal to re-read every inbox. Anyone who can connect to the database can NOTIFY on the channel, so a process drops anything that isn't exactly an event Kolab sends, including a payload that isn't JSON at all, which costs no reconnect. It counts and logs each one it drops, never the payload. A process that can't LISTEN at boot doesn't start. The listening connection notices a silent drop too (a failover or a NAT drop, with no FIN or RST): it is checked every 10 seconds, a check unanswered in 5 seconds counts as a loss, TCP keepalive starts after 10 seconds idle, and a reconnect that hangs gives up after 10 seconds. When the connection is lost after boot, changes committed meanwhile aren't heard, so once the LISTEN is back the process resyncs: it signals every inbox, and the answers of every actor with an open session, and each subscriber re-reads. The resync reads those actors before signalling anything, and if that fails it is retried with backoff (1 s, doubling to 30 s) until it succeeds or the connection is lost again. The process logs at error level as soon as the connection is lost, at error level for each failed resync, and at warn level once it is back and every inbox has been signalled. On PGlite there is one process, and events go only to its own listeners.

Claude Code doesn't yet turn these notifications into a turn for the model. Until it does, an agent waiting on answers can run `konjir watch --once` as a background command, which exits with the change as soon as the inbox has one. `konjir watch` without `--once` prints the inbox, then one JSON line per change, for a harness that tails output.

## How each decision is implemented

**1. Addressing.** An address is `kj:<node>[@<version>][#<element>][~q(<selector>)]`. Every edge stores the fingerprint of the content it addressed when it was created. On an upstream commit, Kolab re-resolves each address against the new version:

- **Same fingerprint:** the edge is re-pinned. This is a pointer bump, not a mark.
- **Different content:** the dependent gets a `changed` mark.
- **A span that changed:** a `fuzzy_reanchor` mark. That is a near match (edited wording), or the exact words without the prefix or suffix they were quoted with, such as a copy in another statement (D42). The exact words with that context still around them, anywhere in the element, re-pin cleanly.
- **Gone:** `orphaned` mark.

An element address covers that element's subtree, so addressing a section means addressing its requirements too.

A span's context is its prefix and suffix. It agrees when more than half of the words on one side still sit next to the quote, and either at least two of them do, or both sides agree. One word or punctuation alone is too little. `link` accepts only a target that resolves exactly, and quotes of at most 1,000 characters. When it refuses one, it suggests the current words with several words of context either side.

**2. Overrides.** Every delta records its base: the parent version and fingerprint it was written against. When a parent commits, each live child is rebased:

- Untouched elements are inherited.
- An override whose parent text now matches the child's text is retired as converged.
- A changed override goes `dirty` but keeps applying.
- A deleted one goes `orphaned` but keeps applying.

The rebased child must pass the review gate. Resolving a dirty override records precedent, and the same `(base, parent, child)` triple then resolves itself on the next rebase.

**3. Roles.** A session activates exactly one role, and an actor has at most one open session (NIST dynamic separation of duty). Each agent is an actor of its own, so the rule holds per agent, and one person's agents can each hold a session at once. Kolab rejects writes outside the session's layer. Row-level security repeats the check in the database: agents may only *draft* (never commit), only in their session's layer, and only on a node of that layer, and they may only declare edges from their own layer. They write only as their session's own actor and role: a version, element, delta or question can't be authored as anyone else, an agent's owner included.

## What the prototype found

**Element addressing has to be on both ends of an edge.** The measurement, at N = 100 requirements with one edited:

| Addressing | Dirty versions |
| --- | --- |
| Version scope everywhere | 202 of 202 (lockstep) |
| Element *targets*, whole-version sources | 202 of 202 |
| Element targets **and** element sources | **4**, at every N |
| Same, but the WBS derives from the whole binding | 202 of 202 |

Pointing at the changed requirement isn't enough. The edge must also say *which part of the dependent* relies on it, or the dirt spreads to the whole dependent version and everything downstream. One whole-version hop anywhere in a lineage collapses back to lockstep.

**Concurrency needs an explicit rule.** Each version records its base: the node's live version when it was drafted, which it was built on. It commits only while that is still the node's live version. Each node's commit step checks this and sets the version committed in one transaction that holds a lock on the node's row, and every write of a new version takes its number under the same lock. So two commits to one node can't both build on one version, and version numbers never collide. A draft can be overtaken while it's open, or while the reviewer runs:

- **Overtaken only by Kolab's own rebases:** the draft is folded into a fresh rebase, keeping its author and declared edges.
- **Overtaken only by Kolab's own rebases:** the fold is built on the newest of the versions just judged, so a commit that lands while it is being made overtakes the fold in turn.
- **Overtaken by another person's commit:** the draft is rejected as stale, to be redrafted. `commit` throws a `GateError`, and `konjir_submit_for_review` returns `stale: true` and says to re-read and redraft. The caller never gets a raw database error for losing a race.
- **A rebase of Kolab's own that was overtaken** is dropped, and the variant's live version is caught up onto the parent's latest version on the spot.

A parent's commit rebases each variant's live version as it is when its turn comes, never the version it listed. A rebase that fails for the variant's own reasons (its review rejects it or can't run, or the reviewer throws) marks the variant `rebase_failed`, with a question, and the parent's commit carries on to the rest (D44), so an inbox tells a failed rebase from a rejected review. A variant holds at most one such mark: a later failure re-points it at the newer parent. The mark and its question settle once the variant's live version sits on the parent's latest version, whether through a rebase that passes or the variant's own commit with `parent` set to that version. Migration 0004 renames every `review_failed` mark of earlier releases to `rebase_failed`, since all of them came from failed rebases. On each variant it keeps open only the mark naming the newest parent, which is also the mark the engine re-points, and moves it to the live version. It settles the mark if the variant already sits on its parent's latest version, and asks the question where none was written. Any other failure, such as a lost connection, or a failure in the cascade of a version that did commit, stops the cascade: the caller gets a `CascadeError` saying which version committed and what didn't finish, never a success over variants left behind. What it hadn't reached catches up on the parent's or the variant's next commit. A draft left open across the upgrade to migration 0003 has no recorded base, so it is rejected as stale on review if its node has any committed version, and must be redrafted. `libs/engine/test/concurrency.test.ts` drives each race that `npm run rebase-storm -- --races` reproduces, on PGlite and Postgres.

**Agents can use it unaided.** Two separate agents were given only a token and the `konjir` command, with no access to the source. The product agent wrote and committed a password-reset spec. The engineer agent bound it to a Node/Postgres/Redis stack and linked each of its 11 elements to the requirements it serves. It then found two real ambiguities (which sessions survive a reset, and whether earlier reset links die) and asked them instead of deciding. The product owner ruled, and the product agent answered and amended the spec. Exactly the three binding elements tied to the amended requirements went dirty. The engineer revised them and cleared all three marks.

Their feedback drove these changes:

- per-verb help
- `key=value` on every verb
- links declared inside a draft
- partial edits by delta
- `mine=true` on questions
- a gate that says what it checked
- plain errors when Kolab is down or a token is refused
- editing a marked element counts as addressing its mark

## Deliberate simplifications

- **Semantic review is opt-in** (`KONJIR_REVIEW=bedrock`). Without it the gate is structural only, and it says so on every commit.
- **Session tokens are bearer tokens** with no expiry or OAuth. They're fine on one machine or a trusted network, but not on the open internet.
- **Identity of derivation is relaxed:** a content-identical upstream commit re-pins edges instead of minting new downstream versions.
- **Precedent applies on a child's next rebase**, not immediately to other open marks.
- **The cascade isn't durable.** A commit's cascade runs after it commits, in the calling process. If that process stops part way, or the cascade stops on a `CascadeError`, variants it hadn't reached stay on the old parent, with no mark, until the parent or the variant commits again.
- **Case files, positions and rulings** exist in the schema but have no verbs yet. Queries cover the common case. A ruling's case file is optional (migration 0005, DAT9): a ruling given directly, as the Decisions Log's are (D16), has no case file and no verdict, since a verdict sustains or overrules a case file's position. A ruling has a verdict exactly when it has a case file. Rulings don't record their date yet (CASE4).
- **Push is a signal, not a message.** Kolab signals an inbox over `subscriptions/listen`, and the agent reads what changed. Under the 2025 protocol, which has no listen stream, agents still poll `list_stale` and `list_queries`. Claude Code needs `konjir watch --once` (see *Questions, notes and push*). A Claude Code channel would need a local stdio bridge, because channels don't work over HTTP.
