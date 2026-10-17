# Kolab

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/konjir-wordmark-on-dark.svg">
    <img alt="Konjir" src="brand/konjir-wordmark-on-light.svg" width="280">
  </picture>
</h1>

<p align="center"><strong>Name it true.</strong><br>Where intent is spoken once, and agents answer.</p>

> Konjir's requirements, design and decisions live in the Konjir artifacts on claude.ai, starting with the [Decisions Log](https://claude.ai/code/artifact/ef4df29b-5618-43d5-bc42-d36a24c3962c). [`CLAUDE.md`](CLAUDE.md) lists all of them and gives the rules. This README describes the code as it is today. Where it disagrees with the artifacts, the artifacts are the intent.

Prototype of Konjir's engine and its delivery rails:

- **Kolab:** versioned specs with stable element IDs, the invalidation cascade, child-spec overrides with the three-way rule, the review gate, and role enforcement. It implements the three decisions in *Konjir — Open Design Decisions*.
- **An MCP server:** stateless Streamable HTTP, MCP spec 2026-07-28, with the SDK's fallback for 2025-era clients. It's a NestJS app; each verb is an `@McpTool` method, the inboxes are `@McpResource` methods, and the operating instructions and the reviewer's instructions are `@McpPrompt` methods.
- **A `konjir` CLI:** the same verbs for a shell or any harness without MCP. It is an MCP client of Kolab, so there is one backend.

TypeScript on Postgres, through [Kysely](https://kysely.dev). Give `konjir serve` a `--database-url` (or `KONJIR_DATABASE_URL`) for a Postgres server. Without one, Kolab runs on embedded Postgres ([PGlite](https://pglite.dev), Postgres in WASM), so local development needs no server.

```
npm install
npm test                  # builds every project, then 278 unit, scenario, property, regression, migration, concurrency, agent, tenancy, channel, review, push and end-to-end tests on Jest through Nx
npm run test:postgres     # the same tests on Postgres 18 in a container, as a non-superuser like RDS's (needs Docker)
npm run typecheck         # every project
npm run build             # every project, to its dist/
npm run measure -- 10 40  # fan-out of one spec edit under four addressing modes
npm run rebase-storm      # one parent commit rebasing many variants (W2.7); results in libs/engine/scripts/REBASE-STORMS.md
```

CI (`.github/workflows/ci.yml`) runs three checks on every pull request into main and every push to main. Test on PGlite and Test on Postgres run the equivalents of `npm test` (with typecheck and build) and `npm run test:postgres`. Each runs only the Nx projects affected since the base: main for a pull request, the last passing commit for main. Both run as production does: on arm64, with the Node version that `deploy/terraform/modules/kolab/main.tf` installs (`node_version`). Check Terraform runs `terraform fmt -check -recursive`, then `terraform init -backend=false` and `terraform validate`, on `deploy/terraform`, with no AWS credentials. It runs on every change, so main can require it.

A second workflow, `.github/workflows/cli.yml`, runs "Build konjir CLI" on the same events when a change touches the CLI, `libs/types`, the manifests, `nx.json` or the workflow itself. It builds the published CLI, the npm package and the binaries: on a pull request only the linux-arm64 binary, which the runner can run, and on main all five. It starts a Kolab from the checkout, checks that both reach the Kolab, and uploads them as the run's artifacts. It publishes nothing and main doesn't require it. `.github/workflows/release-cli.yml` publishes; see [Releasing the CLI](#releasing-the-cli).

A test file tears down in one order: its servers and clients, then its Kolabs, then its databases. `jest.setup.js` runs `closeOpened` from `@konjir/engine/testing` after each file, which does that. So a test registers each server, client or child process it starts with `closeAtEnd`, and opens Kolabs with `openKolab` or `setup`, rather than closing them in an `afterAll` of its own: Jest runs `jest.setup.js`'s `afterAll` before the file's own.

The repository is an [Nx](https://nx.dev) workspace of npm workspaces. Run one project's target with `npx nx run <project>:<target>`, for example `npx nx run @konjir/engine:test`.

| Project | Folder | What it holds |
| --- | --- | --- |
| `konjir` | `apps/cli` | The CLI, an MCP client of Kolab. `konjir serve` also starts the server. Published to npm as `konjir`, and as single-file binaries, both the client alone (see [Installing the konjir CLI](#installing-the-konjir-cli)). |
| `@konjir/channel-bridge` | `apps/channel-bridge` | The Konjir channel: a Claude Code plugin whose stdio server forwards Kolab inbox changes into the session |
| `@konjir/server` | `apps/server` | The MCP server: a NestJS app serving `/mcp` through [`@onivoro/server-mcp`](https://www.npmjs.com/package/@onivoro/server-mcp), and `/healthz`. It makes no model calls and has no model SDK (REV5). |
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
4. **A new table** gets no rights by itself. The engine writes as `kj_agent` or `kj_system` through `set local role`, so grant each what it needs explicitly. If the table holds kolab data, give it a `kolab_id` that references `kolab`, not null, set from its parent by the `kolab_of_parent` trigger (`kj_kolab_of_parent`, from 0006) or by Kolab, and enable row-level security with policies like 0006's: `kolab_read` for `kj_agent` (`kolab_id = kj_session_kolab()`), `system_all` for `kj_system`, and for anything an agent inserts, an `agent_layer` policy plus a restrictive `kolab_write`. Grants on all tables are fine: Kolab revokes everything on `kj_migration` from `kj_agent`, `kj_system` and `public` after every migration.
5. **Value lists.** `MARK_REASONS`, `QUERY_KINDS`, `ACTOR_KINDS`, `ACCOUNT_KINDS`, `ORG_ROLES`, `ACCESS_LEVELS`, `VISIBILITIES`, `VERSION_STATES` and `REVIEW_REQUEST_STATES` in `@konjir/types` are also written out in the database's `invalidation_reason_check`, `query_kind_check`, `actor_kind_check`, `account_kind_check`, `org_member_role_check`, `kolab_grant_level_check` and `kolab_base_permission_check` (both `ACCESS_LEVELS`), `kolab_visibility_check`, `version_state_check` and `review_request_state_check`. A change to any of them needs a migration that drops the check and adds it again with the whole new list. The test "the database's value lists are @konjir/types' …" fails until there is one. Before removing a value, the migration must deal with the rows that use it.
6. Run `npm test` and `npm run test:postgres`.

The files ship as they are: the release runs `libs/db/src`, and `npm run build` copies them to `libs/db/dist/migrations`, so they are found from either.

## Running it with agents

```
# 1. Start Kolab. It persists to ./.konjir and prints an admin token.
bin/konjir serve --port 7420

# 2. Register a person, a kolab they own, and the agents they own, each granted access to it.
export KONJIR_URL=http://127.0.0.1:7420/mcp KONJIR_TOKEN=<admin token>
bin/konjir admin_add_actor id=lee
bin/konjir admin_add_kolab name=checkout owner=lee              # Lee owns it: Admin
bin/konjir admin_add_actor id=lee-pm owner=lee
bin/konjir admin_add_actor id=lee-eng owner=lee
bin/konjir admin_grant kolab=checkout to=lee-pm level=write layers='["functional"]'
bin/konjir admin_grant kolab=checkout to=lee-eng level=write layers='["technical"]'

# 3. Give each agent a session in the kolab (one actor, one kolab, one active role).
bin/konjir admin_open_session actor=lee-pm role=product kolab=checkout   # prints the agent's token
bin/konjir admin_open_session actor=lee-eng role=engineer                # kolab defaults to the one it can reach
bin/konjir admin_list_actors owner=lee                                   # an account's agents
```

Then point each harness at Kolab with its own token. The token decides who the agent is, which kolab it works in and which layer it may write. Tool arguments never carry identity.

An actor is a person, or an agent owned by an account: a person or an organization. Each agent is an actor of its own: it holds its own session, so one person's agents can each hold one at the same time, and it is the author of what it writes. `whoami` names the agent and its `owner`, its kolab and its access there, and `read_node` gives each version's `author`, with the agent, its owner and its role. An actor's kind and owner never change once it's added, so past authorship stays as it was written. An id is letters, digits, `.`, `_`, `-` and `@`, and `kolab` is reserved for Kolab's own work. Two actors with Write on one layer of a kolab review each other's versions there (see *Review*): two product agents of Lee's with Write on the functional layer each wait for the other's approval.

### Accounts, kolabs and access

Kolab follows GitHub's model (D3). An **account** is a user or an organization, in one namespace: each person is a user, by the same id. An organization has **members**, some of them **owners**, and **teams**, which can nest and hold no konstructs. A **kolab** belongs to one account. Its name is unique across the whole database (`kolab.id`, its primary key, lowercase letters, digits and `-`), so a name another account has taken is refused (D7, D12). It is `private` by default, or `public` (anyone may read it) or `internal` (the owning organization's members may), and an organization's kolab may have a **base permission** that every member holds.

Access to a kolab is one of five levels, `read`, `triage`, `write`, `maintain` and `admin`. A `write` grant names the layers it covers, `functional`, `technical` or both; `maintain` and `admin` cover both, and `read` and `triage` write neither. A person's access is the most that any of these gives them: owning the kolab or being an owner of the organization that owns it (Admin), the base permission, a grant to them (a member or an outside collaborator), or a grant to a team they are in or to a parent of one. Teams are granted access only to their own organization's kolabs, and `kj_access` counts a team's grant only on a kolab its organization owns. Kolab alone refuses a base permission on a person's kolab, where it would give nothing anyway: it counts only for members of the owning organization. A session may write its role's layer only while its access covers that layer; with less, it can still read and ask.

**An agent never holds more access than its owner (TEN11, D30).** Its access is its own grant on the kolab, cut down to what its owner holds there: the lower level, and only the layers both may write. An organization holds all of its own kolabs and nothing in anyone else's, so its agents work only in its kolabs. Kolab enforces this in several ways:

- `admin_grant` refuses an agent a grant its owner lacks: a higher level, or a layer its owner can't write.
- A session's access is computed when it opens and on every use, from the grants as they stand. So an agent's session opens with no more than its owner holds, and it narrows the moment its owner's access does. An agent whose owner holds nothing in the kolab can't open a session there at all.
- Every change to grants, memberships or teams ends, in the same transaction, each open session that can no longer reach its kolab, and tells its listen streams so they close (D41). A narrowed session stays open. Those changes and sessions opening take one advisory lock, so a session can't open on access a concurrent change is removing. A session found with no access when it is used (after a change made outside Kolab's verbs) is ended then, and its streams are told.
- A draft commits only while its author may still write its layer: one whose author lost Write since drafting is rejected, whoever submits it. And submitting needs Write on the draft's layer: Read can't decide when someone's draft becomes truth.

Every row of Konjir data carries its kolab: nodes, sessions, versions, elements, deltas, edges, marks and their causes, questions, case files, positions, rulings and precedent. A child row takes its parent's kolab when it is inserted, whatever its writer gave. A session works in one kolab, and everything an agent writes or works on (a node it drafts, a mark, a question, a link's source and target, a variant's parent) must be in it. Reading is wider: a full address, `kj:<kolab>/<node>…`, resolves in any kolab the session's actor holds Read on (see *Addresses* below). Anything else in another kolab is refused as if it didn't exist. Row-level security repeats this in the database. As `kj_agent`, a session reads the rows of its own kolab only while its actor can still reach it (`kj_session_kolab()`). In another kolab it reads only the nodes, the committed versions and their elements and questions, and only where its actor holds Read now (`kj_session_readable_kolabs()`, 0008). It writes only its own kolab, and only its layer while its access covers it (`kj_session_layer()`). The reads Kolab does for a session's addresses run as `kj_agent`, so this binds them too; see *Addresses* for the one read across kolabs that doesn't. How access is computed lives in one place, the database's `kj_access(actor, kolab)`, which the engine calls too.

The database also keeps tenants apart for every role, not only `kj_agent`:

- **No row references another kolab's row.** Each reference is a foreign key on the pair of the referenced id and the row's own kolab: a version's node, parent and base, an element's or delta's version, a delta's base, an edge's source and target, a mark's version, trigger, edge and delta, a mark cause's two marks, a question's version, asker's version and mark, a case file's version, and a position's or ruling's case file or version.
- **A row's kolab never changes** once written (`kolab_fixed`), and those keys stop a row being re-parented into another kolab.
- **`kj_agent` reads no sessions**, whose ids are bearer tokens, **and no actors**. Only Kolab can run `kj_access` (and `kj_system`, which re-checks an author as a draft commits).
- **No shadowing.** Every security definer function searches `pg_catalog, public, pg_temp`, with temporary tables last. Only the database's owner may create temporary tables (0006 revokes `TEMPORARY` from `public`), so `kj_agent` can't plant a table that a helper would read in place of `session`.
- **Precedent is per kolab**, keyed by the kolab and the fingerprint triple, and a rebase matches only its own kolab's.
- **The served instructions** (`konjir_operating_instructions`) carry only the session's kolab's precedent and answered questions; the admin token gets the rules alone.

Row-level security's session helpers sit in subqueries, so Postgres evaluates them once per statement, and the tables they filter are indexed by kolab. A 400-element draft takes about 320 ms on PGlite, down from about 450 ms before that change.

| Verb | Does |
| --- | --- |
| `admin_add_organization id=<org>` | An organization account |
| `admin_add_member org=<org> user=<person> [role=owner]` | Adds a person to an organization, or changes their role |
| `admin_add_team org=<org> name=<team> [parent=<team>]` | A team, `<org>/<team>`, nested under a parent if given |
| `admin_add_team_member team=<org>/<team> user=<person>` | Adds a member of the organization to the team |
| `admin_remove_member org=<org> user=<person>`, `admin_remove_team_member team=<org>/<team> user=<person>` | Removes a membership (leaving an organization leaves its teams too). Says how many sessions it ended |
| `admin_add_kolab name=<name> owner=<account> [visibility=…] [base=<level>]` | A kolab. Refused if the name is taken |
| `admin_list_kolabs [owner=<account>]` | Kolabs, with their owner, visibility and base permission |
| `admin_grant kolab=<name> to=<person, agent or org/team> level=<level> [layers=[…]]` | Replaces the grantee's grant. Says how many sessions it ended |
| `admin_revoke kolab=<name> to=<grantee>` | Removes a grant. Says how many sessions it ended |
| `admin_access actor=<actor> kolab=<name>` | An actor's level and writable layers there, as Kolab computes them |

Migration 0006 keeps what the database holds. If it has any actor or node, its data becomes the kolab `kolab`, owned by the organization `konjir`; each person becomes a user and a member of `konjir`, and each person and agent gets Write on both layers of `kolab`, which is what any actor could do before. Open sessions work in `kolab`. A fresh database gets none of this. An existing actor named `konjir`, person or agent, stops the migration, since the organization needs that id: rename the actor first.

**Take a database snapshot before deploying any release with a new migration**, such as 0006, 0007 (the review flow), 0008 (node names per kolab) or 0009 (which drops `version.findings`, W1.7). Once one is applied, an earlier release refuses the database ("recorded at a migration this release doesn't have"), so going back means restoring from that snapshot, which loses whatever was written since: after 0007, for example, versions in review and their review requests.

### Addresses

An address names its kolab: `kj:<kolab>/<node>[@<version>][#<element>][~q(<selector>)]` (ADR3, D8, DAT11). Inside a kolab the short form, `kj:<node>…`, is enough. `@konjir/address` parses and prints both, and nothing else does: the kolab segment is a kolab name (lowercase letters, digits and `-`), and a node's name is anything without `/`, `@`, `#`, `~` or whitespace, so the first `/` always ends the kolab.

- **A node's name is unique within its kolab**, not across Konjir, so two kolabs may each have a `checkout` and neither learns of the other. A name taken in the session's own kolab is refused, naming only that kolab. Migration 0008 adds `node.name`, unique per kolab (`node_kolab_name_key`); each existing node's name is its id.
- **The id is Kolab's own.** A node keeps the id every version refers to. A new node's id is its name, unless another kolab's node already holds that id, and then it is `~` and a ULID, which no name can be, since a name has no `~` (`node_id_name_check`). The id says nothing of the kolab, so renaming a kolab, if that ever comes, needn't touch it. Neither id nor name changes once written (`node_name_fixed`). Every verb takes a node's name, every address and message Kolab gives names the node by its name, and no verb shows an id.
- **The short form** is the node of that name in the session's kolab. Every read names its reader: `{ session }`, or `{ system: <kolab> }` for Kolab's own reads, which check nothing and may never stand in for a session.
- **The full form resolves from anywhere** its reader can read. In the session's own kolab it is the same as the short form. In another kolab, `konjir_resolve` and `konjir_read_node` (`node=<kolab>/<node>`) need the actor to hold Read there, as `kj_access` computes it: so an agent needs a grant of its own, never more than its owner's (D30), and a person may read a public kolab. Without it, the address is refused exactly as one naming a node or kolab that isn't there. `read_node` across kolabs prints full addresses, its own kolab's short ones.
- **Across kolabs, only committed work shows.** A reader outside a node's kolab sees its committed versions only: a pinned draft or rejected version (`kj:billing/checkout@3`) resolves as an orphan, and `read_node` says there is no such version, as for one that doesn't exist. Inside its own kolab a session reads drafts as before (ADR9). This reading is put to Lee.
- **Enforced twice.** Kolab checks Read first, then runs the read as `kj_agent` in the session, so row-level security returns nothing it shouldn't, even to code that skips Kolab's check. The one exception is `read_node`'s author: `kj_agent` reads no actors, so Kolab's login looks up who wrote the version, after the version itself was read under row-level security.
- **Writing stays in the session's kolab.** A link, a variant's parent, a question or a draft naming another kolab is refused from the address alone, saying it isn't supported across kolabs yet, without looking at what is there. Links across kolabs with the lost-access mark (LNK8) and forks across kolabs (KON) wait on a binding decision, so the composite keys that hold every reference inside one kolab stay as 0006 made them.

- **Claude Code:** `claude mcp add --transport http konjir http://127.0.0.1:7420/mcp --header "Authorization: Bearer <token>"`
- **Any MCP client:** an HTTP server entry with an `Authorization: Bearer <token>` header.
- **Anything with a shell** (Codex, opencode, a person): `export KONJIR_URL=… KONJIR_TOKEN=<token>`, then `bin/konjir instructions`.

That one connection is the only static setup a harness needs. The rules come down the protocol, as server instructions and the `konjir_operating_instructions` prompt (`konjir instructions` in a shell). How to review a version comes the same way, as the `konjir_reviewer_instructions` prompt (`konjir instructions reviewer`); see *Review*. The served text includes the answered questions and override precedent of the session's own kolab, so settled questions aren't re-asked.

### Installing the konjir CLI

Outside a checkout, `konjir` is the client alone: every verb, `instructions`, `watch` and `--version`, but no `serve`, which runs Kolab and needs a checkout. It needs only a Kolab's URL and a token.

```
npx konjir --help                       # Node 22 or later; the package has no dependencies
npm install -g konjir                   # or keep it installed

# or a single-file binary, which needs no Node, from the GitHub release:
#   konjir-linux-x64, konjir-linux-arm64, konjir-darwin-arm64, konjir-darwin-x64, konjir-windows-x64.exe
curl -fLo konjir https://github.com/konjir/kolab/releases/download/konjir%40<version>/konjir-darwin-arm64
chmod +x konjir                         # each release also carries SHA256SUMS
xattr -d com.apple.quarantine konjir    # macOS: the binaries aren't signed

KONJIR_URL=https://kolab.example.com/mcp KONJIR_TOKEN=<token> konjir whoami
```

`apps/cli/scripts/package.mjs` builds both from `apps/cli/src` with [Bun](https://bun.sh). `apps/cli/bun-runtimes.json` pins Bun's version and the sha256 of each Bun release zip used. Each build checks that the `bun` on your PATH is that version, and `node apps/cli/scripts/package.mjs bun <dir>` installs a checked one. `npx nx run konjir:bundle` writes the npm package to `apps/cli/dist-npm`: the CLI and the MCP client SDK bundled into one `konjir.mjs`, a `package.json` that declares nothing else, and `THIRD-PARTY-NOTICES.md`, the bundled packages' licences, taken from Bun's metafile. `npx nx run konjir:compile` writes the binaries and the same notices, plus the Bun runtime's, to `apps/cli/dist-bin`. It compiles each binary with `bun build --compile` on a Bun runtime downloaded from Bun's release and checked against its pinned hash (`node apps/cli/scripts/package.mjs binaries darwin-arm64` builds one). Both builds leave out `@konjir/server`, so `konjir serve` from them says to use a checkout. Neither target is part of `build`, so the release Kolab runs, which `install.sh` builds with tsc, doesn't need Bun.

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

Choose **I am using this for local development** at the warning. Work already waiting arrives first, as one `← konjir: Your functional inbox already holds …` message. Each new question, note, mark, answer or review request after that arrives as `← konjir: Your functional inbox changed: …`, and a verdict on a version the session submitted as `← konjir: A version you submitted has been reviewed: …`. Items leaving the inbox, such as the agent's own answers and clears, send nothing. The plugin loads in place from a marketplace added from a local path, so it keeps using this checkout's `node_modules`. On Team and Enterprise plans an admin must enable channels first.

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

`connect` works in the kolab `kolab` unless `KONJIR_KOLAB` names another. An actor it adds is granted Write on both layers there; one that exists keeps the access it has. An agent's grant is refused if its owner holds less.

The backend (`deploy/terraform/backend.tf`) stores state at `s3://konjir-terraform/konjir/test/terraform.tfstate` in `us-east-1`, using the `icedlee337` profile. It locks with S3's native lock file, so no DynamoDB table is needed.

| Module | What it creates |
| --- | --- |
| `network` | A VPC with one public subnet, and two private subnets for the database. Inbound is 443, plus 80 for certificate issuance; there is no SSH. |
| `storage` | The release bucket (emptied on destroy), the encrypted data volume, and daily snapshots kept 7 days |
| `database` | Postgres 18 on RDS (`db.t4g.micro`, 20 GB, encrypted, 7 days of backups), reachable only from Kolab over verified TLS. Its URL is an SSM SecureString |
| `secrets` | A generated admin token, stored as an SSM SecureString |
| `iam` | The instance role: Session Manager access, read its releases, token and database URL. No Bedrock or other model access (REV5) |
| `kolab` | A `t4g.small` running Amazon Linux 2023, with Caddy for automatic HTTPS, an Elastic IP and the Route 53 record for `kolab.konjir.com` |
| `release` | Zips this repo, uploads it, and installs it on Kolab through Systems Manager. `terraform apply` is the deploy |

Kolab listens on localhost only, behind Caddy. Its database is on RDS, apart from the instance, so replacing the instance is safe. A change to the boot script replaces it automatically. The boot script still writes `KONJIR_REVIEW=structural` and `KONJIR_REVIEW_MODEL` into `/etc/konjir/env`, which Kolab ignores since W1.7: `modules/kolab` passes them as constants so that the script renders unchanged and W1.7 doesn't replace the instance. They go with the next boot-script change. The data volume still holds the PGlite database Kolab used before RDS. The rough cost is $30–35 a month at list price.

Day to day:

- **Ship code:** `terraform apply`. A code change alters the release hash, and Terraform reinstalls and waits for success.
- **Inspect:** `deploy/konjir-ops.sh status`, `logs` or `bootstrap-log`. `shell` opens a session; it needs the Session Manager plugin.
- **OS refresh:** `terraform apply -replace=module.kolab.aws_instance.kolab`. The AMI is pinned when the instance is created.
- **Tear down:** `terraform destroy`. Final snapshots of the data volume and the database are kept by default. For a teardown that leaves nothing, run `terraform apply -var final_snapshot_on_destroy=false` first, then `terraform destroy -var final_snapshot_on_destroy=false`. The apply is needed because destroy reads the database's snapshot setting from state. Daily volume snapshots made before the teardown remain until you delete them. The state bucket stays until you remove it.

The admin token is generated by Terraform, so it is also in the state file. That is why the state bucket is private, encrypted and TLS-only.

**Testing only.** This is one instance with no failover. Tokens are bearer tokens with no expiry or single sign-on: hand them out privately, and revoke them with `admin_end_session`. Before real use, replace them with OAuth.

## Releasing the CLI

`nx release` versions `konjir` (D23), configured in `nx.json`'s `release`: the `konjir` project only, tagged `konjir@<version>`. The current version is the newest such tag, or `apps/cli/package.json`'s before the first release. Bumps are plain semver, so `minor` from 0.5.0 is 0.6.0. The commits here aren't conventional commits, so the version is given, not inferred, and nx release writes no changelog. `apps/cli/scripts/version-actions.cjs` writes the version, in place of `@nx/js`'s, so the workspace doesn't install `@nx/js`. Installing it would add Babel to every install, the instance's included, and turn on Nx's source-file analysis, which needs TypeScript 5's JavaScript API. Publishing isn't nx release's: the workflow below publishes the tarball it tested with `npm publish`.

```
npx nx release version 0.6.0 --first-release --dry-run   # preview the version the workflow would set
```

Publishing runs only in GitHub Actions, by hand: **Actions › Release CLI › Run workflow** on main, with a version (`patch`, `minor`, `major` or an exact `X.Y.Z`; no prereleases) and dry run on (the default) or off. The workflow, `.github/workflows/release-cli.yml`, has four jobs, each with only the permissions it needs:

1. **Build konjir release** (read-only) sets the version in the runner and commits nothing. It refuses a version that already has a tag or is on npm. It builds the tarball and the binaries, checks both against a Kolab it starts from the checkout, runs `npm publish --dry-run`, and uploads the files with `SHA256SUMS`. A dry run stops here.
2. **Draft GitHub release** attests the files' build provenance (`gh attestation verify <file> --repo konjir/kolab` checks a download). It creates the release `konjir@<version>` as a draft, with the files and notes generated from the merged pull requests.
3. **Publish konjir to npm** runs in the `npm-release` environment, with no checkout and no dependencies. It publishes the tested tarball, with provenance, through npm 11.
4. **Publish GitHub release** takes the draft out of draft. That creates the tag on the built commit, and the next release reads its version from that tag.

Before the first release, Lee sets up:

- **A GitHub environment** named `npm-release` (Settings › Environments), with deployment branches limited to `main`, and a required reviewer if wanted. A copy of the workflow on another branch then can't reach the npm credentials.
- **npm trusted publishing**, preferred. On npmjs.com, konjir's settings › Trusted publishing › GitHub Actions: repository `konjir/kolab`, workflow `release-cli.yml`, environment `npm-release`. No secret is needed. A package must exist before trusted publishing can be configured on npm, so the first publish may need the fallback.
- **Or the fallback:** an `NPM_TOKEN` secret in the `npm-release` environment, a granular npm token with write access to `konjir`. npm caps such tokens at 90 days, so it needs rotating.

If a run fails, what to do depends on how far it got. Before *Publish konjir to npm*, nothing is published: delete the draft release if there is one (`gh release delete konjir@<version>`), then run again. If npm has the version but *Publish GitHub release* failed, re-run that job, or run `gh release edit konjir@<version> --draft=false`. A new run for a version npm already has stops in its first job.

The published package declares the licence `ISC`, as the root `package.json` does, but the repository has no `LICENSE` file yet.

## Who pays for which model calls

Kolab makes no model calls (REV5, VER7). It has no model SDK among its dependencies, holds no model credentials, and its instance role has no Bedrock access. All the work that takes judgment happens in collaborators' own harnesses.

| Work | Runs where | Paid by |
| --- | --- | --- |
| Authoring specs, bindings, plans; implementing; answering questions | Each collaborator's harness (Claude Code, Codex, opencode, …) | That collaborator's own subscription or API account |
| Reviewing a version: contradictions, layer leaks, one testable intent per element | The reviewing agent's own harness, through `konjir_review` (see *Review*) | The reviewer's own subscription or API account |
| Structural checks, cascade, addressing, rebase, roles | The Konjir server | No model at all |

The server is built so it can't drift across that line:

- **It never asks for, stores, or relays a collaborator's model credentials.** A collaborator's token identifies them to Konjir and nothing else.
- **It never borrows a client's model.** It doesn't use MCP sampling or any other way to make a collaborator's harness run inference on the server's behalf. When the server needs judgment beyond its structural checks, it asks for a review or raises a question, which an agent or a person answers from their own harness, by their own choice.
- **Each collaborator's model use stays inside their own harness and account.** Konjir doesn't pool, share or proxy anyone's access. Whether a given plan permits a given use (for example, connecting an MCP server, or how much automated work a subscription may drive) is set by that provider's terms. Each collaborator should confirm their own plan covers how they use it.

`apps/server/test/no-model.test.ts` fails if any package of the workspace declares a model SDK. Until W1.7 the server could call Amazon Bedrock as a semantic review gate (`KONJIR_REVIEW=bedrock`); that reviewer, its AWS SDK packages, its settings, its Terraform variables and its IAM permissions are gone. `konjir serve` ignores `KONJIR_REVIEW` and `--review`, and warns when they ask for anything but `structural`.

## Verbs

| Verb | Does |
| --- | --- |
| `whoami` | Your actor, its kind (`person` or `agent`), the account that owns it, your role and layer, your kolab and your access there |
| `list_nodes`, `read_node`, `resolve` | Read current state in your kolab; `resolve` takes any address, and with `kj:<kolab>/…`, and `read_node` with `node=<kolab>/<node>`, read any kolab you hold Read on. `read_node` says who wrote the version |
| `lineage` | What a node depends on (upstream) or what depends on it (downstream) |
| `list_stale` | Open marks on your layer: what is dirty, why, and the next step |
| `list_queries` | Questions and notes your layer owns; `mine=true` for the ones you raised, with answers |
| `create_node`, `draft`, `submit_for_review` | Author. `draft` takes deltas or full elements, plus `links`. `submit_for_review` runs Kolab's checks and puts the version in review (see *Review*) |
| `review`, `list_reviews`, `abandon` | Review. `review` approves a version in review, or requests changes, with findings; `list_reviews` shows the requests waiting for you and your own submissions; `abandon` drops your draft or version in review |
| `link` | Declare that one of your elements relies on an address |
| `clear_mark`, `resolve_override` | Settle a mark |
| `ask`, `annotate`, `answer_query` | The question tier. Questions and notes route to the layer that owns the answer; see below |
| `admin_add_actor`, `admin_list_actors`, `admin_open_session`, `admin_end_session`, `admin_apply_ruling` | Admin token only. `admin_add_actor owner=<account>` adds an agent of that person or organization; `admin_open_session kolab=<name>` opens the session in that kolab. `admin_apply_ruling` applies one of Lee's rulings to a node (D47; see *Review*) |
| `admin_add_organization`, `admin_add_member`, `admin_remove_member`, `admin_add_team`, `admin_add_team_member`, `admin_remove_team_member`, `admin_add_kolab`, `admin_list_kolabs`, `admin_grant`, `admin_revoke`, `admin_access` | Admin token only: accounts, kolabs, teams and grants (see *Accounts, kolabs and access*) |

In a shell, `konjir help <verb>` gives a verb's parameters, and `konjir <verb> key=value …` calls it. `konjir watch` streams your inbox (see below).

## Questions, notes and push

An engineer writing a binding talks to the spec through two verbs:

- **`ask`** is for a decision the engineer needs before they can proceed. Pass `from=<binding element>` to name the element that waits on it. When product answers, that element gets a `query_answered` mark carrying the question and the answer. Editing the element, or `clear_mark`, settles it. The answer reaches the binding even if the spec text never changes.
- **`annotate`** leaves a note: an interpretation the engineer is going ahead with, an assumption, a risk, or something they couldn't check. It blocks nothing, but it waits in product's queue until product replies, so product can object. A reply to a note marks nothing.

Both can target an element or a quoted span (`kj:orders#R13~q({"exact":"50 meters"})`). `read_node` shows them beside the element they're about, open and answered, including ones asked on earlier versions of the spec. Either layer can use them in either direction.

**Push.** Each layer has an inbox resource, `konjir://inbox/functional` and `konjir://inbox/technical`, holding its open questions, notes and marks, and, for the reader, the review requests waiting for them on that layer. Each actor has `konjir://answers/<actor>`, which holds what they raised, with replies, and the versions they submitted for review, with the verdicts. `whoami` lists the two for the session. Kolab declares `resources.subscribe` and signals a resource whenever it changes, over MCP 2026-07-28 `subscriptions/listen`. A client that listens gets `notifications/resources/updated` and re-reads the resource. Only the URI is pushed, never the content, and reading `answers` is limited to its own actor. Ending a session closes its open listen streams at once, as the server closing the subscription, and nothing more is signalled to them. Each change is also checked against the session before it is signalled, so a session ended any other way closes its stream on the next change instead. Its token is then refused (401), so a client that reconnects with it learns it was revoked. A listen stream whose session ends while it is opening is refused in-band instead: HTTP 200 with the JSON-RPC error `-32003` and `data.reason` `session_ended`, which the channel bridge and `konjir watch` treat as the token revoked, as they do a 401. The session is checked as each stream opens, so if that check fails (the database is unreachable, say) the stream is refused as `gate_failed`, or `gate_timeout` after 10 seconds, rather than opened and checked at the next change; the bridge retries those with backoff, and `konjir watch` says to run it again. [`@onivoro/server-mcp`](https://www.npmjs.com/package/@onivoro/server-mcp) tracks, gates and closes the streams (`McpHttpService.closeListenStreams` and the auth strategy's `acceptListenStream`); Kolab says which to close. Other sessions' streams, including those of the same person's other agents, are untouched.

**Push across processes.** Several Kolab processes can serve one Postgres database, and an agent listening on any of them hears a change made through any other (API5). Each engine event is sent with Postgres `NOTIFY` inside the transaction that commits its change, so it is delivered only if the change commits, and never on a rollback. Each process `LISTEN`s on the `konjir_events` channel over one connection of its own, apart from its pool, through [`@onivoro/server-pg-notify`](https://www.npmjs.com/package/@onivoro/server-pg-notify)'s `NotificationListener` (its Nest-free `/listener` entry), which reconnects with backoff (1 s, doubling to 30 s, without limit) when the connection drops, and stops when the process closes. A process tells its own listeners once the transaction commits, and skips its own notification when it hears it back, so nothing is signalled twice. The payload is the event (a layer, an actor, or an ended session's sessionKey), not the content; an event too long for `NOTIFY` is sent as a signal to re-read every inbox. Anyone who can connect to the database can NOTIFY on the channel, so a process drops anything that isn't exactly an event Kolab sends, including a payload that isn't JSON at all, which costs no reconnect. It counts and logs each one it drops, never the payload. A process that can't LISTEN at boot doesn't start. The listening connection notices a silent drop too (a failover or a NAT drop, with no FIN or RST): it is checked every 10 seconds, a check unanswered in 5 seconds counts as a loss, TCP keepalive starts after 10 seconds idle, and a reconnect that hangs gives up after 10 seconds. When the connection is lost after boot, changes committed meanwhile aren't heard, so once the LISTEN is back the process resyncs: it signals every inbox, and the answers of every actor with an open session, and each subscriber re-reads. The resync reads those actors before signalling anything, and if that fails it is retried with backoff (1 s, doubling to 30 s) until it succeeds or the connection is lost again. The process logs at error level as soon as the connection is lost, at error level for each failed resync, and at warn level once it is back and every inbox has been signalled. On PGlite there is one process, and events go only to its own listeners.

Claude Code doesn't yet turn these notifications into a turn for the model. Until it does, an agent waiting on answers can run `konjir watch --once` as a background command, which exits with the change as soon as the inbox has one. `konjir watch` without `--once` prints the inbox, then one JSON line per change, for a harness that tails output.

## How each decision is implemented

**1. Addressing.** An address is `kj:[<kolab>/]<node>[@<version>][#<element>][~q(<selector>)]` (see *Addresses*). Every edge stores the fingerprint of the content it addressed when it was created. On an upstream commit, Kolab re-resolves each address against the new version:

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

The rebased child commits after Kolab's structural checks alone, without review (VER12, D19): no person wrote it, so there is no author to review against. A conflicting override is still marked and asks its question. Resolving a dirty override records precedent, and the same `(base, parent, child)` triple then resolves itself on the next rebase; a resolution that waits in review records it, and settles its mark, when it commits.

**3. Roles.** A session activates exactly one role, and an actor has at most one open session (NIST dynamic separation of duty). Each agent is an actor of its own, so the rule holds per agent, and one person's agents can each hold a session at once. Kolab rejects writes outside the session's layer. Row-level security repeats the check in the database: agents may only *draft* (never commit), only in their session's layer, and only on a node of that layer, and they may only declare edges from their own layer. They write only as their session's own actor and role: a version, element, delta or question can't be authored as anyone else, an agent's owner included. And they read and write only in their session's kolab, and write only the layers their access covers (see *Accounts, kolabs and access*).

## Review

A version moves from drafted, to in review, to committed (VER2, REV2). `konjir_submit_for_review` runs Kolab's checks, which are structural only: no empty element, no element repeating another word for word, no element nested under one that doesn't exist (REV1). Kolab runs no model and reports no findings itself (REV5); whether a version contradicts itself or leaks across layers is for its reviewers. A version that fails the checks stays drafted, with the reason in its review note and the result, for its author to fix or resubmit. One that passes goes into review: it is `in_review`, and each other actor holding Write on its layer gets a review request in its inbox, connected or not (VER16). Holding Write means the actor's access in the version's kolab includes Write on that layer, as `kj_access` computes it from grants, teams and organizations, an agent's cut down to its owner's (W1.3); sessions don't count, so a reader with a session isn't a reviewer, and a writer with no session, or one in the other role, is. A reviewer gives its verdict from a session in the layer's role. The request names its subject, a version, and says how to review it. The `konjir_reviewer_instructions` prompt (`konjir instructions reviewer` in a shell) gives a reviewing agent the full checklist: the layer rules, one testable intent per element, what a `contradiction` and a `layer_leak` are and what each does, and how to approve or request changes. It holds the rules alone, no kolab's content, so every session and the admin token get the same text.

- **Who reviews (D19, D25, D33):** any actor other than the author with Write on the layer. Separation of duty is per agent, so another agent of the author's person counts, and so does the person. Only the version's own layer reviews it.
- **`konjir_review verdict=approve`:** one approval commits the version, through the same per-node commit step as any other commit, and the other requests are withdrawn. A `layer_leak` finding can come with an approval: the version commits and the finding becomes a `role_boundary` mark and a question to the layer that owns the answer: implementation in a spec goes back to its author, and a binding that changes behavior goes to the spec it links to. Answering the question clears the mark. A `contradiction` can't: it stops the commit (VER9), so it comes only with a request for changes.
- **`konjir_review verdict=request_changes`:** needs a note, and may carry findings. The version returns to drafted, and every request for it is withdrawn. Its author resubmits it unchanged, or drafts a new version and abandons this one.
- **`konjir_abandon`:** the author rejects their own draft or version in review, under the node's lock, so it can't land on a version an approval has just committed; it says so instead. A person's version is rejected only this way, or as stale, or when Kolab folds it into a fresh rebase (VER2, D33, D38). Kolab's own rebases are rejected when they fail their checks.
- **Plan versions (VER3, PLN2):** a `wbs` or `work_package` version commits after structural checks, without review, whoever else holds Write on the technical layer.
- **Reviewers gone:** resubmitting a version that waits in review asks whoever can review it now, adding requests for new reviewers and withdrawing those of actors who no longer can (their Write was revoked, say). If no one can, the checks alone commit it, unreviewed. An author who lost Write meanwhile can't get it committed: entering review and committing both re-check the author, under the node's lock, and reject the version instead.
- **No reviewer (VER11):** when no one else holds Write on the layer, Kolab's checks alone commit the version, and its review note says it committed unreviewed. A solo project works as it did before review existed.
- **Kolab's own rebases (VER12):** commit after structural checks only, with no review request.
- **A ruling applied to the mirror (D47):** `konjir_admin_apply_ruling ruling=D46 actor=mirror-product node=kolab/kolab-binding elements=…` (or `deltas=…`, and `parent=` for a variant in the node's kolab) writes a version as that actor (who must hold Write on the node's layer in its kolab), in the role of that layer, and commits it after structural checks only, with no review request: the ruling is already the approval. Its review note records the ruling and that it came through the admin token. The admin token works in no kolab, so `node` is `<kolab>/<node>`, or a name alone only when no other kolab has a node of that name (otherwise it is refused, naming the kolabs that do), and `committed` is the full address. It goes through the same per-node commit step as any commit, so it is rejected as stale if the node moved on, and it makes anything waiting in review on the node stale. Only the admin token reaches it; an agent session is refused, so no agent can use it to skip review.
- **While a version waits in review**, the W1.17 rules hold. A commit by anyone else to the node rejects it as stale at once, and its requests leave the inboxes. A rebase of Kolab's own doesn't: at approval, the approved version is folded onto the rebase, and the fold commits on structural checks, since its edit was reviewed. In the same transaction, under the node's lock, the version it folds is settled as `folded into` the fold, and its approval is copied onto the fold, so the author's answers show the fold committed with it; if the author abandoned the version meanwhile, the fold doesn't commit. A fold carries the version's override resolution too. A draft overtaken by Kolab's rebases before it was submitted is folded at submission, and the fold goes into review itself.
- **Inboxes:** a review request in the reviewer's layer inbox signals that inbox, and each verdict signals the author's answers, with the same events as questions and marks. The Konjir channel turns a new request, or a verdict on the session's own submission, into a message.

## What the prototype found

**Element addressing has to be on both ends of an edge.** The measurement, at N = 100 requirements with one edited:

| Addressing | Dirty versions |
| --- | --- |
| Version scope everywhere | 202 of 202 (lockstep) |
| Element *targets*, whole-version sources | 202 of 202 |
| Element targets **and** element sources | **4**, at every N |
| Same, but the WBS derives from the whole binding | 202 of 202 |

Pointing at the changed requirement isn't enough. The edge must also say *which part of the dependent* relies on it, or the dirt spreads to the whole dependent version and everything downstream. One whole-version hop anywhere in a lineage collapses back to lockstep.

**Concurrency needs an explicit rule.** Each version records its base: the node's live version when it was drafted, which it was built on. It commits only while that is still the node's live version. Each node's commit step checks this and sets the version committed in one transaction that holds a lock on the node's row, and every write of a new version takes its number under the same lock. So two commits to one node can't both build on one version, and version numbers never collide. A draft can be overtaken while it's open, while Kolab's checks run, or while it waits in review:

- **Overtaken only by Kolab's own rebases:** the draft is folded into a fresh rebase, keeping its author and declared edges.
- **Overtaken only by Kolab's own rebases:** the fold is built on the newest of the versions just judged, so a commit that lands while it is being made overtakes the fold in turn.
- **Overtaken by another person's commit:** the draft is rejected as stale, to be redrafted. `commit` throws a `GateError`, and `konjir_submit_for_review` returns `stale: true` and says to re-read and redraft. The caller never gets a raw database error for losing a race.
- **A rebase of Kolab's own that was overtaken** is dropped, and the variant's live version is caught up onto the parent's latest version on the spot.

A parent's commit rebases each variant's live version as it is when its turn comes, never the version it listed. A rebase that fails for the variant's own reasons (its checks refuse it, or throw) marks the variant `rebase_failed`, with a question, and the parent's commit carries on to the rest (D44), so an inbox tells a failed rebase from a rejected review. A variant holds at most one such mark: a later failure re-points it at the newer parent. The mark and its question settle once the variant's live version sits on the parent's latest version, whether through a rebase that passes or the variant's own commit with `parent` set to that version. Migration 0004 renames every `review_failed` mark of earlier releases to `rebase_failed`, since all of them came from failed rebases. On each variant it keeps open only the mark naming the newest parent, which is also the mark the engine re-points, and moves it to the live version. It settles the mark if the variant already sits on its parent's latest version, and asks the question where none was written. Any other failure, such as a lost connection, or a failure in the cascade of a version that did commit, stops the cascade: the caller gets a `CascadeError` saying which version committed and what didn't finish, never a success over variants left behind. What it hadn't reached catches up on the parent's or the variant's next commit. A draft left open across the upgrade to migration 0003 has no recorded base, so it is rejected as stale on review if its node has any committed version, and must be redrafted. `libs/engine/test/concurrency.test.ts` drives each race that `npm run rebase-storm -- --races` reproduces, on PGlite and Postgres.

**Property tests check the cascade and rebases (W2.5).** `libs/engine/test/properties.test.ts` uses [fast-check](https://fast-check.dev) to generate a spec family and a sequence of edits to it. The family has:

- a parent with a nested element
- a variant of it, and a variant of that variant, which itself depends on the binding
- a binding linked into all three, including a cycle with the nested variant
- a WBS linked into the binding, and a work package linked into the WBS

The edits are parent commits that change, delete and restore elements, variant overrides, edits of marked elements, clears and override resolutions. A stand-in for review, the test's own submission checks, rejects some of them.

After each step the test compares Kolab with a reference model (`libs/engine/test/cascade-model.ts`), written from the spec rather than the engine. It checks:

- every element's text
- every override's state: clean, retired, dirty or orphaned
- exactly which marks are open, each on its node's live version, and that a mark carried forward keeps its id rather than being raised again
- one open question per dirty or orphaned override and no other, and a resolved question answered with the ruling by whoever made it
- every link: either pinned to its target's live version with a matching fingerprint, or carrying an open mark

The seed is fixed, so CI runs the same sequences every time: 25 on PGlite and 60 on Postgres, which runs them about twice as fast. Three environment variables change that: `KONJIR_PROPERTY_SEED` changes the seed and `KONJIR_PROPERTY_RUNS` the number of runs, to replay a failure or search harder; `KONJIR_PROPERTY_SHRINK=0` stops at the first failure instead of shrinking it.

The model makes three readings of the spec on purpose:

- **A link that already carries an open mark isn't re-checked by later commits.** CAS1's "each live link" is read as each link not already marked. Its owner settles the mark (LNK6), even if the target goes back to the pinned text, or is deleted after it changed.
- **A link whose target is gone can't re-pin.** Revising its element doesn't settle the mark (CAS4 says "clears that mark and re-pins its link"), and clearing it is refused: the owner re-links instead.
- **When two rulings share a (base, parent, child) triple, the first stands.**

The tests found six bugs, now fixed, each with a regression in `libs/engine/test/property-regressions.test.ts`:

- **A mark didn't spread through a link that carried a mark of its own.** Such a link stays pinned to an older version. Clearing the link's mark then left its element clean while what it relied on was dirty. The walk now follows live links into any version of the node it reaches. (A follow-up, once the migrations in flight have landed, adds an index on `edge(target_version_id)` for it.)
- **A self-settled override left its question open.** When a dirty or orphaned override came out clean on its own (its parent went back to the text it was written against, converged on it, or the variant overrode it again), its mark cleared but its question stayed open, where nothing could answer it. Kolab now answers it as `kolab`.
- **An override moving between orphaned and dirty kept its first wording.** It kept the mark and question it was first raised with. Both are now reworded.
- **A resolution's precedent was recorded after its own cascade.** So a variant of the resolved variant, rebased by that cascade with the same (base, parent, child) triple, was asked again. The ruling is now recorded in the transaction that commits the resolution, before its cascade: the precedent, and the mark closed with its question answered by the ruling and its author. Nothing is visible while the resolution is in review, however long that takes: the ruling waits on the resolution's version (`version.resolves`, W1.6), and a fold of the resolution carries it. Of two resolutions of one mark, only the one that commits records anything.
- **A variant's commit settled marks on overrides it only carried forward.** It counted every element with a delta as revised. Only elements whose text or place in the tree changed from the node's previous version count now.
- **Revising an element didn't settle its upstream_dirty marks**, though LNK6 and CAS4 say revising a marked element settles its mark. It now does, as a clear would.

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

- **Semantic review is only as good as the reviewers.** Kolab's own checks are structural, and they say so; contradictions and layer leaks are caught only if a reviewing agent reports them. A version with no other writer on its layer commits on the structural checks alone, unreviewed (VER11).
- **Review waits aren't durable yet** (W1.8). A review request and its verdict are rows, so a restart keeps them, but nothing retries a commit or cascade an approval started if the process stops part way, and a version whose only reviewers lose Write waits until its author resubmits it (which commits it unreviewed) or abandons it.
- **The reviewers are those of the moment** the version is submitted or resubmitted; one who gains Write later can still review it, and its request is added on resubmission.
- **Review requests are readable by every session in their kolab**, like versions and questions there: their notes and findings included. Product review of bindings (VER13), editorial commits (VER14) and reviews of work packages (VER17, PLN16) aren't built.
- **Session tokens are bearer tokens** with no expiry or OAuth. They're fine on one machine or a trusted network, but not on the open internet.
- **Identity of derivation is relaxed:** a content-identical upstream commit re-pins edges instead of minting new downstream versions.
- **Precedent applies on a child's next rebase**, not immediately to other open marks.
- **The cascade isn't durable.** A commit's cascade runs after it commits, in the calling process. If that process stops part way, or the cascade stops on a `CascadeError`, variants it hadn't reached stay on the old parent, with no mark, until the parent or the variant commits again.
- **Case files, positions and rulings** exist in the schema but have no verbs yet. Queries cover the common case. A ruling's case file is optional (migration 0005, DAT9). A ruling given directly, as the Decisions Log's are (D16), names the version it rules on, and optionally an element in it, instead of a case file; it has exactly one of the two. Its body is `text`, which is what the Decisions Log calls an entry's verdict, and `replaces` says in words what it overrules. The `verdict` column is the sustained or overruled outcome on a case file. CASE2 gives that outcome to each position, so `position.verdict` holds it; `ruling.verdict` is optional, null on a direct ruling, and kept only for the rulings already stored. Rulings don't record their date yet (CASE4). A ruling's kolab is its case file's or, given directly, its version's (0006).
- **Tenancy is partial (W1.3, W1.4).** Addresses carry the kolab and node names are unique per kolab (W1.4), but a session can only read across kolabs: it can't link to, fork from or ask about another kolab, and there is no mark for lost access (LNK8), since those wait on a binding decision. Nodes can't be renamed, so there are no aliases yet (ADR11). Push signals name a layer or an actor, not a kolab, so a change in one kolab signals every subscriber to that layer's inbox, each of whom re-reads only its own kolab's: nothing crosses but the fact that something changed. Session ids are stored as they are, not hashed. A session works in exactly one kolab, and an actor still holds at most one open session, so an agent works in one kolab at a time; its token is its session, scoped to that kolab and its role, and its level comes from its grant. Kolabs can't yet be transferred (TEN5), visibility and base permission are set only when a kolab is made, and accounts, teams and kolabs can't be removed or renamed. Only the admin token manages tenancy: a kolab's own Admins can't yet grant access through Kolab.
- **Push is a signal, not a message.** Kolab signals an inbox over `subscriptions/listen`, and the agent reads what changed. Under the 2025 protocol, which has no listen stream, agents still poll `list_stale` and `list_queries`. Claude Code needs `konjir watch --once` (see *Questions, notes and push*). A Claude Code channel would need a local stdio bridge, because channels don't work over HTTP.
