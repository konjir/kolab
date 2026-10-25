# Write a spec, then build it with a team of agents

In about an hour you put a small product on Konjir and build it with three AI agents: one writes the functional spec, one reviews it, and one binds it to a stack and writes the code. Then you change one requirement and watch Konjir mark exactly the part of the binding that relied on it.

The product is **Linkly**, a link shortener whose links expire. Every command and prompt here is meant to be pasted as it is. Each step says what you should see. The agents' wording will differ from run to run, but what Konjir does won't.

## Before you start

You need:

- a GitHub account, to sign up
- [Claude Code](https://code.claude.com), signed in with a claude.ai account (channels, which push each agent's inbox into its session, don't work with an API key; everything else does)
- Node.js 22.13 or later (the code uses `node:sqlite`, which earlier releases of Node 22 keep behind a flag), git, and `jq`

Get the `konjir` CLI from a checkout of Kolab. `konjir connect claude` sets Claude Code up with the Konjir channel, which runs from a checkout:

```sh
git clone https://github.com/konjir/kolab ~/kolab
(cd ~/kolab && npm ci)
```

The CLI is also on npm (`npx konjir@0.5.0`). That build runs every verb, `konjir login` and `konjir logout`, but it has no channel, so for this tutorial use the checkout.

## 1. Sign up and make a private kolab

A kolab holds one project: its spec, the bindings built on it, and the questions between them.

1. Open [kolab.konjir.com](https://kolab.konjir.com) and choose **Sign in with GitHub**.
2. Kolab's page says “you are `ada` here”: that is your Konjir name, usually your GitHub login, lowercased. Under **In the kolab**, choose **A new private kolab of your own**. Name it `linkly-` and your GitHub login, for example `linkly-ada`; names are unique across Konjir. Give it the title `Linkly: short links that expire`. Under **As**, leave **Product**.
3. Choose **Allow**.

You land in your empty kolab, signed in as yourself, with Admin.

Now make the code repository, and a small file that sets up each terminal you'll use: your names, Kolab's URL, the `konjir` command, and the `agent` command that starts an agent's session (step 2):

```sh
mkdir ~/linkly && cd ~/linkly && git init
cat > konjir.sh <<'EOF'
# Source this in each terminal: . ~/linkly/konjir.sh
export ME=ada              # your Konjir name
export KOLAB=linkly-ada    # your kolab
export KONJIR_URL=https://kolab.konjir.com/mcp
konjir() { ~/kolab/bin/konjir "$@"; }
# agent <label>: Claude Code with only that agent's Konjir server, and its channel
agent() {
  cd ~/linkly || return
  mkdir -p .claude
  jq --arg s "konjir-$1" '{mcpServers: {($s): .mcpServers[$s]}}' .mcp.json > ".claude/konjir-$1.json"
  claude --strict-mcp-config --mcp-config ".claude/konjir-$1.json" \
    --dangerously-load-development-channels "server:konjir-$1"
}
EOF
printf 'konjir.sh\n.mcp.json\n.claude/\n' > .gitignore
```

Open `konjir.sh` and put your own Konjir name and kolab in place of `ada` and `linkly-ada`. Then load it:

```sh
. ~/linkly/konjir.sh
```

## 2. Connect three agents

Each agent is an actor of its own, owned by you. It gets no more access than you hold, and it works in one role: product agents write the functional layer, engineer agents the technical layer.

| Agent | Role | Does |
| --- | --- | --- |
| `<you>-spec-writer` | product | drafts the functional spec |
| `<you>-spec-reviewer` | product | reviews the spec |
| `<you>-builder` | engineer | binds the spec to a stack and writes the code |

Connect all three to the repository:

```sh
cd ~/linkly
konjir connect claude --url https://kolab.konjir.com/mcp --kolab $KOLAB \
  --agent spec-writer:product --agent spec-reviewer:product --agent builder:engineer
```

Your browser opens four times, and the terminal asks one question:

1. **As yourself, once.** `konjir connect` needs you to make the agents. Under **Work as**, the page starts on **A new agent of yours**: change it to **Yourself** by hand (it is never chosen for you), then **Allow**. If you allow the default, Kolab makes an agent you don't need and `konjir connect` stops; see [Troubleshooting](#troubleshooting). konjir keeps none of this sign-in and revokes it once the agents are made.
2. **In the terminal**, konjir shows the `.mcp.json` it will write and asks `Make these agents and write /Users/ada/linkly/.mcp.json? [y/N]`. Answer `y`. Anything else writes nothing and makes no agent.
3. **Once for each agent.** The page arrives with the agent, your kolab and its role chosen. Check them, then **Allow**.

You should see:

```output
konjir connect claude: 3 entries for kolab linkly-ada at https://kolab.konjir.com/mcp, one agent each:
  konjir-spec-writer  as ada-spec-writer, product
  konjir-spec-reviewer  as ada-spec-reviewer, product
  konjir-builder  as ada-builder, engineer

--- /dev/null
+++ /Users/ada/linkly/.mcp.json
...
Make these agents and write /Users/ada/linkly/.mcp.json? [y/N] y
Made your agent ada-spec-writer.
Made your agent ada-spec-reviewer.
Made your agent ada-builder.
Revoked the sign-in as you.
Wrote /Users/ada/linkly/.mcp.json. It holds no token: each entry signs in by itself.
...
konjir-builder is signed in as ada-builder.
```

`.mcp.json` now holds one Konjir server per agent, each the Konjir channel bridge with its own sign-in. It names your checkout's absolute path, which is why `.gitignore` keeps it out of git. Signing in as yourself ended your session in the web page; sign in there again when a step needs it.

### Run each agent in its own session

Open three new terminals. In each, load `konjir.sh` and start one agent with the `agent` command it defines, which runs Claude Code in `~/linkly` with only that agent's server, and its channel:

```sh
. ~/linkly/konjir.sh && agent spec-writer       # first terminal
. ~/linkly/konjir.sh && agent spec-reviewer     # second
. ~/linkly/konjir.sh && agent builder           # third
```

At the warning about development channels, choose **I am using this for local development**. Ask each one:

```text
Call konjir_whoami and tell me which actor, role and kolab you are.
```

Each should name its own agent, its role, and your kolab. Work that waits for an agent arrives in its session as a message beginning `← konjir:`.

### Or: one session, three subagents

If you'd rather drive everything from one Claude Code session, make each agent a subagent that can use only its own server's tools. Create `.claude/agents/spec-writer.md`:

```file
---
name: spec-writer
description: Linkly's product writer in Konjir.
tools: mcp__konjir-spec-writer__*
---
You are the product writer for Linkly. You work in Konjir only through your konjir-spec-writer tools.
```

Make `spec-reviewer.md` the same way with `mcp__konjir-spec-reviewer__*`, and `builder.md` with `mcp__konjir-builder__*, Read, Write, Edit, Bash`. Start one session with all three servers and approve them when Claude Code asks:

```sh
claude --dangerously-load-development-channels \
  server:konjir-spec-writer server:konjir-spec-reviewer server:konjir-builder
```

Then give each prompt below to its subagent: `Use the spec-writer subagent: <the prompt>`.

## 3. Write the spec, review it, approve it

In the **spec-writer** session:

```text
You are the product writer for Linkly, a link shortener. You work in Konjir through your konjir tools. Call konjir_instructions first and follow it.

Create a functional spec node named short-links, titled "Short links that expire", and write it from the product notes below. Group the notes into sections (S1, S2, ...) and write one requirement per note, with stable IDs R1, R2, ... nested under their section. Keep each note's meaning and wording, and add no requirements of your own. Submit it for review, then tell me its version and who was asked to review it.

Notes:
- Anyone can shorten a URL that starts with http:// or https://, and gets back a short link with a 7-character code.
- Shortening any other URL is refused, with a message saying why.
- When shortening, the person chooses how long the link lasts: 1 hour, 1 day or 7 days. If they don't choose, it lasts 7 days.
- Opening a short link before it expires takes the visitor to the original URL.
- Opening an expired short link shows a page saying the link has expired. It never redirects.
- Opening a code that was never issued shows a "not found" page.
- Each visit that redirects adds one to the link's visit count.
- With the short link, the person gets a private stats link that shows the link's visit count and when it expires.
- Codes are generated with crypto.randomBytes and stored in a SQLite table named links.
```

It answers that `short-links` version 1 is in review, waiting on `ada` or `ada-spec-reviewer`. Nothing is truth until a review commits it. The last note is implementation, not behavior, on purpose.

In the **spec-reviewer** session:

```text
You are the product reviewer for Linkly. You work in Konjir through your konjir tools. Call konjir_instructions which=reviewer first and follow it. Our team's rule: implementation never goes into the spec, so request changes for a layer leak rather than approving with one.

Review every version that waits for you (konjir_list_reviews). Read each with konjir_read_node and give your own verdict with konjir_review: approve it, or request changes with a note and findings that cite element IDs. Then tell me each verdict and why.
```

It requests changes: the requirement about `crypto.randomBytes` and SQLite prescribes implementation, a `layer_leak`, which belongs in the binding. The version goes back to its author as a draft.

Back in the **spec-writer** session:

```text
You are the product writer for Linkly. You work in Konjir through your konjir tools. Call konjir_instructions first and follow it.

Your spec short-links came back with changes requested. Read the reviewer's note and findings (konjir_list_reviews), then fix what they found: draft a new version that keeps the spec to what people experience, abandon the version that came back, and submit the new one for review. Tell me what you changed.
```

It abandons version 1 and submits version 2, with the implementation note dropped or rewritten as behavior. Give the reviewer's prompt to the **spec-reviewer** again. If it finds something else (in one of our runs it asked for a requirement to be split in two), run the writer's prompt and the reviewer's again. When it approves, the version commits, and each requirement has an address such as `kj:short-links@2#R3`.

## 4. Bind it

In the **builder** session:

```text
You are the engineer for Linkly. You work in Konjir through your konjir tools. Call konjir_instructions first and follow it.

Bind the committed spec short-links to our stack. Create a technical binding node named short-links-binding, titled "Linkly on Node.js", for this stack: Node.js 22 or later with no npm dependencies, node:http for the server, node:sqlite for storage, node:test for the tests. Write one element per implementation decision (b1, b2, ...). Link each element (source_element) to exactly the requirements it serves and no others; don't link a stack-wide choice to every requirement. Every requirement must be served by at least one element. Add no behavior the spec doesn't state. Submit the binding for review, then tell me its version and each element with the requirements it links to.
```

It lists the elements, `b1` to `b8` in our run, each linked to the requirement it serves, and says version 1 waits on your approval. Each link is pinned to the version of the requirement it was written against.

The reviewer is you: you hold Write on the technical layer as the kolab's owner, and no other agent works as an engineer. In [kolab.konjir.com](https://kolab.konjir.com), sign in with GitHub and choose your kolab. Next to **Working as**, switch to **engineer**. Open **Reviews**, then `short-links-binding` under **Waiting for your review**, read it, and choose **Approve**. It commits.

## 5. Ask product a question

An engineer who finds the spec silent asks, instead of guessing. In the **builder** session:

```text
You are the engineer for Linkly. You work in Konjir through your konjir tools. Call konjir_instructions first and follow it.

Before building, settle one question with product instead of guessing: when the same visitor opens the same short link again, does that visit count too, or only the first visit from each visitor? Ask it with konjir_ask on the short-links requirement about the visit count, from the short-links-binding element that counts visits, so the answer comes back to that element. Then tell me the question's id, the requirement it's on and the element that waits on it.
```

It reports a question on the visit-count requirement, waiting on the element that counts visits: in our run, `kj:short-links#R7` and `kj:short-links-binding#b7`. The question goes to the functional layer's inbox, so the spec-writer's session gets a `← konjir:` message about it. In the **spec-writer** session:

```text
You are the product writer for Linkly. You work in Konjir through your konjir tools. Call konjir_instructions first and follow it.

Engineering asked a question about the spec short-links (konjir_list_queries). Our product answer: every visit that redirects counts, repeat visits from the same visitor included; the visit-count requirement already says so, so the spec doesn't change. Answer the question with that, in your own words, and leave the spec as it is. Tell me what you answered.
```

The answer comes back to the element that waited on it, as a `query_answered` mark, even though the spec text didn't change. The builder's `konjir_list_stale` now shows, in our run:

```output
"reason": "query_answered",
"dirty": "kj:short-links-binding@1#b7",
"next": "A question this element was waiting on has been answered. Revise the element to match (editing it clears the mark), or konjir_clear_mark if it already holds."
```

## 6. Build it

In the **builder** session:

```text
You are the engineer for Linkly. You work in Konjir through your konjir tools, and in this repository. Call konjir_instructions first and follow it.

First run konjir_list_stale and settle every mark on your layer: if the element still holds, konjir_clear_mark it; if not, revise the binding and submit it.

Then build Linkly in this repository exactly as the committed short-links-binding says: read it with konjir_read_node, and implement each element. Put the server in server.js and the tests in test/linkly.test.js, with a package.json whose "test" script runs node --test. Above the code that implements each element, write a one-line comment naming its address, for example // kj:short-links-binding#b3. Don't copy spec or binding text into the repository. Run npm test until it passes, then commit with git. Before you finish, run konjir_list_stale again. Tell me what you built and the test result.
```

Approve its file edits and commands as it asks. It clears the `query_answered` mark (the binding already counts every visit), writes `server.js`, `package.json` and the tests, runs `npm test` until it passes, and commits. The code points at the binding by address, never by copying it:

```sh
grep -n "kj:" server.js
```

## 7. Change the spec

Product decides that a link with no chosen duration lasts 1 day, not 7. In the **spec-writer** session:

```text
You are the product writer for Linkly. You work in Konjir through your konjir tools. Call konjir_instructions first and follow it.

Product decision: a link the person doesn't choose a duration for now lasts 1 day, not 7 days. Change only the requirement that says how long links last, with a delta that keeps its ID, and submit the new version of short-links for review. Tell me the version.
```

Give the **spec-reviewer** its review prompt from step 3. When it approves, the new version commits, and Kolab checks every link into the spec against it. The builder's session gets, in our run:

```output
← konjir: Your technical inbox in linkly-ada changed: 0 open questions and notes, 1 open mark.
New mark on your work:
- mark … on kj:short-links-binding@1#b3 (changed): kj:short-links#R3 changed in version 3. Next: …
```

Only the element linked to the requirement that changed is marked. Every other link re-pinned to the new version without a mark. In the web page, as engineer, the mark sits beside its element with the requirement's text before and after.

## 8. Resolve the mark

In the **builder** session:

```text
You are the engineer for Linkly. You work in Konjir through your konjir tools, and in this repository. Call konjir_instructions first and follow it.

The spec changed. Run konjir_list_stale and settle every mark on your layer: read what changed with konjir_read_node; where a binding element still holds, konjir_clear_mark it; where it doesn't, revise the element with a delta that keeps its ID, and submit the new version of short-links-binding for review. Then change the code and tests to match the binding, run npm test until it passes, and commit. Tell me, for each mark, whether you cleared it or revised the element, and why.
```

The marked element said the default was 7 days, so it revises that element, keeping its ID, submits `short-links-binding` version 2, changes the default in the code and its test, and commits. In the web page, approve version 2 under **Reviews**. The mark settles as it commits; ask the builder to run `konjir_list_stale`, and it finds none.

That's the loop: intent stated once, a binding pinned to it, questions routed to whoever owns the answer, and a change that reaches exactly what depends on it.

## Troubleshooting

- **The browser didn't open.** konjir prints the sign-in URL; open it yourself.
- **`konjir connect` stopped after the first sign-in: `you chose ada-agent, not Yourself`.** You allowed the page's default, **A new agent of yours**, so Kolab made the agent `<you>-agent`. It counts toward the limit of 3 new agents in 10 minutes, so wait 10 minutes, then run `konjir connect` again and choose **Yourself**. Archive the stray agent when you clean up (`konjir archive_agent label=agent`).
- **`you made 3 agents in the last 10 minutes`.** A person makes at most 3 agents in 10 minutes and holds at most 10. Wait 10 minutes, then run `konjir connect` again: it reuses the agents it already made.
- **`Nothing written, and no agent made.`** You answered something other than `y` to `konjir connect`'s question. Run it again and answer `y`.
- **The web page signed you out.** Signing in as yourself anywhere else (`konjir connect`, or `konjir login` as yourself) ends your other session. Sign in again.
- **`a product session may not write the technical layer` when you approve the binding.** Switch to **engineer** next to **Working as**, then approve.
- **A version waits and nobody is asked.** A review request reaches only those who work in the layer's role. “Nobody else can review the functional layer yet” means no other product agent is signed in: connect one, or review it yourself in that role.
- **An agent says its channel has no sign-in.** It names the command that signs it in, `KONJIR_CREDENTIALS=… konjir login --url https://kolab.konjir.com/mcp --agent <agent>`. Run it in another terminal; the channel picks the sign-in up by itself.
- **Agents keep signing each other out.** An agent holds one session at a time. Don't also add Kolab's HTTP server (`claude mcp add … /mcp`) as the same agent, and don't run `konjir login` as an agent that a session uses.
- **No `← konjir:` messages arrive.** Channels need Claude Code signed in with a claude.ai account, the development-channels flag, and an interactive session; on Team and Enterprise plans an admin enables channels first. The tools work without them: ask the agent to check its inbox with `konjir_list_reviews`, `konjir_list_queries` and `konjir_list_stale`.
- **`konjir connect` says it has no bridge.** It runs the channel from a checkout. Use `~/kolab/bin/konjir`, or add `--http` for plain HTTP entries that each sign in through `/mcp` in Claude Code, without a channel.

## Clean up

First quit the three Claude Code sessions (`/exit` in each), so no channel is left waiting for a sign-in you're about to revoke. Then, in one terminal, sign each agent out. Its sign-in is kept in the `agents` folder beside konjir's own (`${XDG_CONFIG_HOME:-$HOME/.config}/konjir`, unless you set `KONJIR_CREDENTIALS`), in a file named after the agent:

```sh
. ~/linkly/konjir.sh && cd ~/linkly
for a in spec-writer spec-reviewer builder; do
  KONJIR_CREDENTIALS="${XDG_CONFIG_HOME:-$HOME/.config}/konjir/agents/$ME-$a.json" konjir logout
done
```

Each prints `the sign-in is revoked and forgotten`. Then archive the agents, which frees their places among your 10. Sign in as yourself (choose **Yourself** on Kolab's page), archive them, and sign out. If `konjir connect` made a stray `<you>-agent`, add `agent` to the list.

```sh
konjir login --kolab $KOLAB
for a in spec-writer spec-reviewer builder; do konjir archive_agent label=$a; done
konjir logout
rm -rf .mcp.json .claude
```

The last line removes the Konjir entries and, if you took the subagent route, `.claude/agents/`.

An archived agent's name stays yours, and what it wrote stays in the kolab under its name. You can't archive the kolab yourself yet; only a Konjir admin can. It stays private to you, and you can reuse it. A person owns at most 10 kolabs.
