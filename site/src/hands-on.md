# Write a spec, then build it with a team of agents

In about an hour you put a small product on Konjir and build it with three AI agents: one writes the functional spec, one reviews it, and one binds it to a stack, plans the work and builds it. Then you change one requirement and watch Konjir mark exactly the part of the binding, and the finished work, that relied on it.

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

## 1. Make the repository

A kolab holds one project: its one spec, the bindings built on it, each holding its decisions and the work packages that build it, and the questions between them. You don't make yours on the web: step 2 makes it, with your agents, on one page. Choose its name now: `linkly-` and your GitHub login, for example `linkly-ada`. Names are unique across Konjir.

Make the code repository, and a small file that sets up each terminal you'll use: your names, Kolab's URL, the `konjir` command (for you, and for the agents' shells), and the `agent` command that starts an agent's session (step 2):

```sh
mkdir ~/linkly && cd ~/linkly && git init
cat > konjir.sh <<'EOF'
# Source this in each terminal: . ~/linkly/konjir.sh
export ME=ada              # your Konjir name
export KOLAB=linkly-ada    # your kolab
export KONJIR_URL=https://kolab.konjir.com/mcp
export PATH="$HOME/kolab/bin:$PATH"   # konjir, here and in the agents' shells
# Where konjir connect keeps each agent's sign-in, one file per agent
export KJ_AGENTS="${XDG_CONFIG_HOME:-$HOME/.config}/konjir/agents"
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

Open `konjir.sh` and put your own Konjir name and kolab in place of `ada` and `linkly-ada`. Your Konjir name is your GitHub login, lowercased; step 2 shows it, so you can check. Then load it:

```sh
. ~/linkly/konjir.sh
```

## 2. Make your kolab and connect three agents

Each agent is an actor of its own, owned by you. It gets no more access than you hold, and it works in one role: product agents write the functional layer, engineer agents the technical layer.

| Agent | Role | Does |
| --- | --- | --- |
| `<you>-spec-writer` | product | drafts the functional spec |
| `<you>-spec-reviewer` | product | reviews the spec |
| `<you>-builder` | engineer | binds the spec to a stack and writes the code |

One command makes your kolab and the three agents, and connects them to the repository:

```sh
cd ~/linkly
konjir connect claude --url https://kolab.konjir.com/mcp --kolab $KOLAB \
  --agent spec-writer:product --agent spec-reviewer:product --agent builder:engineer
```

konjir prints what it will do, then opens your browser once. Nothing is asked in the terminal.

1. **Sign in with GitHub**, if this browser isn't signed in already. The first time, that signs you up to Konjir.
2. **Kolab's setup page**, “Set up 3 agents in linkly-ada”, names everything konjir asked for, with nothing to choose: the kolab, marked **New: made now, private, yours**, and each agent with its role, marked **New: made now**. Check them, then choose **Allow**.

You should see:

```output
konjir connect claude: kolab linkly-ada at https://kolab.konjir.com/mcp, 3 agents, one entry each (<you> is the name you sign in to Kolab as):
  konjir-spec-writer  as <you>-spec-writer, product
  konjir-spec-reviewer  as <you>-spec-reviewer, product
  konjir-builder  as <you>-builder, engineer

Will write /Users/ada/linkly/.mcp.json: 3 entries, konjir-spec-writer, konjir-spec-reviewer, konjir-builder.

Opening your browser at Kolab's setup page: sign in, check it names kolab linkly-ada and these 3 agents, then Allow. If it doesn't open, go to:
  https://kolab.konjir.com/oauth/authorize?…
Set up for ada: kolab linkly-ada (made now, private, yours); ada-spec-writer (made now), ada-spec-reviewer (made now), ada-builder (made now).
Wrote /Users/ada/linkly/.mcp.json. It holds no token.
Each agent is signed in, in its own file under /Users/ada/.config/konjir/agents.
...
claude --dangerously-load-development-channels server:konjir-spec-writer server:konjir-spec-reviewer server:konjir-builder
```

`Set up for ada` names you: if it isn't the name you put in `konjir.sh`, put this one there and load it again. `.mcp.json` now holds one Konjir server per agent, each the Konjir channel bridge, already signed in as its agent: no more pages open when you start them. It names your checkout's absolute path, which is why `.gitignore` keeps it out of git. Running the same command again is safe: it reuses the kolab and the agents, and signs them in afresh.

To see the kolab in the web page, open [kolab.konjir.com](https://kolab.konjir.com) and choose **Sign in with GitHub**: you own it, with Admin.

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
. ~/linkly/konjir.sh && cd ~/linkly && claude --dangerously-load-development-channels \
  server:konjir-spec-writer server:konjir-spec-reviewer server:konjir-builder
```

Then give each prompt below to its subagent: `Use the spec-writer subagent: <the prompt>`.

## 3. Write the spec, review it, approve it

In the **spec-writer** session:

```text
You are the product writer for Linkly, a link shortener. You work in Konjir through your konjir tools. Call konjir_instructions first and follow it.

Create the kolab's spec (a node of kind spec) named short-links, titled "Short links that expire", and write it from the product notes below. Group the notes into sections (S1, S2, ...) and write one requirement per note, with stable IDs R1, R2, ... nested under their section. Keep each note's meaning and wording, and add no requirements of your own. Submit it for review, then tell me its version and who was asked to review it.

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

Your spec short-links came back with changes requested. Read the reviewer's note and findings (konjir_list_reviews), then fix what they found: draft a new version that keeps the spec to what people experience, abandon the version that came back, and submit the new one for review. Nothing of short-links has committed yet, and deltas apply only to a committed version, so send the full element list. Tell me what you changed.
```

It abandons version 1 and submits version 2, with the implementation note dropped or rewritten as behavior. Give the reviewer's prompt to the **spec-reviewer** again. If it finds something else (in one of our runs it asked for a requirement to be split in two), run the writer's prompt and the reviewer's again. When it approves, the version commits, and each requirement has an address such as `kj:short-links@2#R3`.

## 4. Bind it

In the **builder** session:

```text
You are the engineer for Linkly. You work in Konjir through your konjir tools. Call konjir_instructions first and follow it.

Bind the committed spec short-links to our stack. Create a binding node (kind binding; it binds the kolab's one spec) named short-links-binding, titled "Linkly on Node.js", for this stack: Node.js 22 or later with no npm dependencies, node:http for the server, node:sqlite for storage, node:test for the tests. Write one element per implementation decision (b1, b2, ...). Link each element (source_element) to exactly the requirements it serves and no others; don't link a stack-wide choice to every requirement. Every requirement must be served by at least one element. Add no behavior the spec doesn't state.

Plan the build in the same binding, as one work package: an element W1, "Build Linkly as this binding says", with a work field whose done_when is "server.js and test/linkly.test.js implement every requirement as this binding says, and npm test passes", and whose size is M. Link W1 to every requirement of short-links, since it builds them all. Submit the binding for review, then tell me its version and each element with the requirements it links to.
```

It lists the decisions, `b1` to `b8` in our run, each linked to the requirement it serves, and the work package `W1`, linked to every requirement, and says version 1 waits on your approval. Each link is pinned to the version of the requirement it was written against. A binding's elements are its decisions and its work packages: an element with a work field is work to do, which an agent pulls and builds; a decision never is.

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

Work is built in a git repository that the kolab knows. Kolab never reads git: you register the repository, pinned by its first commit, and `konjir work deliver` refuses to deliver from any other checkout. Only a person registers one, never an agent. In your own terminal:

```sh
. ~/linkly/konjir.sh && cd ~/linkly
git add .gitignore && git commit -m "Start Linkly"
git remote add origin https://github.com/$ME/linkly.git
konjir login --kolab $KOLAB --role engineer
konjir repo register --binding short-links-binding
```

On Kolab's page, under **Work as**, choose **Yourself**, then **Allow**. A person holds one session at a time, so this sign-in in your terminal ends the one in your browser: the web page signs you out. That's expected; you sign in there again to review the work, below. The remote needn't exist on GitHub, and nothing is pushed to it: `konjir work deliver` checks only that your checkout tracks the URL you registered. If your Konjir name isn't your GitHub login, put your login in the URL. `konjir repo register` answers with the repository, `"binding": "short-links-binding"` and `"confirmed": false`.

In the **builder** session:

```text
You are the engineer for Linkly. You work in Konjir through your konjir tools, and in this repository. Call konjir_instructions first and follow it.

First run konjir_list_stale and settle every mark on your layer: if the element still holds, konjir_clear_mark it; if not, revise the binding and submit it.

Then build the next work package, following the build loop in the instructions: pull it with konjir_pull_work and read it with konjir_read_work. Build Linkly in this repository exactly as the committed short-links-binding says: put the server in server.js and the tests in test/linkly.test.js, with a package.json whose "test" script runs node --test. Above the code that implements each element, write a one-line comment naming its address, for example // kj:short-links-binding#b3. Don't copy spec or binding text into the repository. Run npm test until it passes, then commit on a new branch, with the package's trailer. This repository has nowhere to push to, so don't push. Deliver and submit it with konjir work deliver --submit and a --test for the test run, running konjir as yourself: put KONJIR_CREDENTIALS="$KJ_AGENTS/$ME-builder.json" before the command. Before you finish, run konjir_list_stale again. Tell me what you built, the test result and the work package's state.
```

Approve its file edits and commands as it asks. It clears the `query_answered` mark (the binding already counts every visit), pulls `W1`, writes `server.js`, `package.json` and the tests, runs `npm test` until it passes, and commits on the branch it names, with the trailer that ties the commit to the package, `Konjir-Work: kj:linkly-ada/short-links-binding#W1` in our run. `konjir work deliver` then finds the commits that carry it, checks that this checkout is the registered repository, records them as the package's evidence and submits it. `W1` is In review, waiting on you. The code points at the binding by address, never by copying it:

```sh
grep -n "kj:" server.js
git log -1 --format='%h %s%n%(trailers:key=Konjir-Work)'
```

Review it as an engineer would: read the change and run the tests:

```sh
git show
npm test
```

Then give your verdict on Kolab's page. Your terminal's `konjir login` signed the page out, so in [kolab.konjir.com](https://kolab.konjir.com) sign in again with GitHub and choose your kolab. This in turn ends your terminal's session as yourself; the rest of the tutorial doesn't need it, and the agents keep their own. Next to **Working as**, switch to **engineer** if the page isn't already, and open **Reviews**. `W1` waits under **Waiting for your review**, with what it must do (its done-when), who built it, when, and the evidence it was submitted with: the commit, by its SHA, and the test run. Check them against the done-when, then choose **Approve**. To send it back instead, choose **Request changes** and say what must change: it returns to the builder, In progress.

`W1` is Done. The page says the repository is unconfirmed, and it stays so, because you registered it: an approval by someone other than its registrant and the package's builder confirms it.

## 7. Change the spec

Product decides that a link with no chosen duration lasts 1 day, not 7. In the **spec-writer** session:

```text
You are the product writer for Linkly. You work in Konjir through your konjir tools. Call konjir_instructions first and follow it.

Product decision: a link the person doesn't choose a duration for now lasts 1 day, not 7 days. Change only the requirement that says how long links last, with a delta that keeps its ID, and submit the new version of short-links for review. Tell me the version.
```

Give the **spec-reviewer** its review prompt from step 3. When it approves, the new version commits, and Kolab checks every link into the spec against it. The builder's session gets, in our run:

```output
← konjir: Your technical inbox in linkly-ada changed: 0 open questions and notes, 3 open marks.
New marks on your work:
- mark … on kj:short-links-binding@1#b5 (changed): kj:short-links#R3 changed in version 3. Next: …
- mark … on kj:short-links-binding@1#b6 (changed): kj:short-links#R3 changed in version 3. Next: …
- mark … on kj:short-links-binding@1#W1 (changed): kj:short-links#R3 changed in version 3. Next: kj:short-links-binding#W1 is Done, and at risk (PLN10): …
```

Only what links to the requirement that changed is marked: the decisions that serve it, and the work package that built it. Every other link re-pinned to the new version without a mark. `W1` stays Done, but at risk, and its mark carries a revisit: the repository, the commits and the files its work touched, so whoever picks it up knows where to look. In the web page, as engineer, each mark sits beside its element with the requirement's text before and after.

## 8. Resolve the marks

In the **builder** session:

```text
You are the engineer for Linkly. You work in Konjir through your konjir tools, and in this repository. Call konjir_instructions first and follow it.

The spec changed. Run konjir_list_stale and settle every mark on your layer. For a binding element, read what changed with konjir_read_node; where it still holds, konjir_clear_mark it; where it doesn't, revise it with a delta that keeps its ID, and submit the new version of short-links-binding for review. For a work package that is Done and at risk, look at the files its revisit names: if the code still holds, clear its mark; if it doesn't, reopen it with konjir_reopen_work, and don't rebuild it until the binding it builds is committed. Tell me, for each mark, what you did and why.
```

A marked decision that still holds (in our run, the one about storage) has its mark cleared. The one that said the default was 7 days is revised, keeping its ID, and `short-links-binding` version 2 goes into review. The code no longer holds either, so it reopens `W1`, which settles its mark and puts it back to To do. Approve version 2 on Kolab's page, where you are still signed in as **engineer**: open **Reviews**, then `short-links-binding` version 2 under **Waiting for your review**, read what changed, and choose **Approve**. If the page signed you out (you ran `konjir login` as yourself again, say), sign in again and switch to **engineer** first.

Then, in the **builder** session:

```text
You are the engineer for Linkly. You work in Konjir through your konjir tools, and in this repository. Call konjir_instructions first and follow it.

short-links-binding version 2 is committed. Build the work package you reopened, following the build loop: pull it first with konjir_pull_work, then change the code and tests to match the binding, run npm test until it passes, commit with its trailer, and deliver it with konjir work deliver --submit as before, with KONJIR_CREDENTIALS="$KJ_AGENTS/$ME-builder.json" before the command. Then run konjir_list_stale. Tell me what you changed and the work package's state.
```

It pulls `W1` again, changes the default and its test, commits with the same trailer and delivers it: `W1` is In review again, and its stale list is empty. Check the change as in step 6, then approve it under **Reviews**, as before.

That's the loop: intent stated once, a binding pinned to it, work packages built and delivered with their commits, questions routed to whoever owns the answer, and a change that reaches exactly what depends on it, finished work included.

## Troubleshooting

- **The browser didn't open.** konjir prints the sign-in URL; open it yourself.
- **`--kolab …: a kolab's name is lowercase letters, digits and '-'`.** konjir refuses a name no kolab can have before it opens anything. Use lowercase letters, digits and `-`, starting with a letter or digit, at most 40 for a new kolab.
- **The setup page says `This setup can't be allowed`, with only Deny.** It says why, and so does `konjir connect` once you choose **Deny**; nothing is made or written. The usual one: `a kolab named linkly-ada already exists, and you can't reach it`. Kolab names are unique across Konjir, so someone has it. The page lists the kolabs you do reach, and if one of yours has that name as its title, it says so: use that kolab's name instead. Otherwise choose another name, put it in `konjir.sh` as `KOLAB`, and run `konjir connect` again.
- **`you denied the setup on Kolab's page`.** You chose **Deny**. Nothing was made or written; run `konjir connect` again and choose **Allow**.
- **`you have … live agents, and this would make … more`.** A person holds at most 10 live agents. The message names yours, least recently used first, with the day each last used Kolab; `konjir list_agents` lists them too, with their kolabs and whether one is signed in now. Archive ones you no longer use (`konjir archive_agent label=<label>`, signed in as yourself), or name fewer.
- **Kolab's sign-in page says `It asks for the kolab …, and you can't reach a kolab of that name`.** `--kolab` takes a kolab's name, not its title. If one of yours has that title, the page asks `Did you mean …?`: choose that kolab on the page, or deny and run `konjir login --kolab <its name>` again.
- **`you ran 3 setups that made agents in the last 10 minutes`.** One setup makes as many agents as you name, but at most 3 setups that make agents run in 10 minutes. Wait, then run it again: it reuses what it already made.
- **The web page signed you out.** Signing in as yourself anywhere else (`konjir login` as yourself, say) ends your other session. Sign in again.
- **`a product session may not write the technical layer` when you approve the binding.** Switch to **engineer** next to **Working as**, then approve.
- **A version waits and nobody is asked.** A review request reaches only those who work in the layer's role. “Nobody else can review the functional layer yet” means no other product agent is signed in: connect one, or review it yourself in that role.
- **An agent says its channel has no sign-in.** It names the command that signs it in, `KONJIR_CREDENTIALS=… konjir login --url https://kolab.konjir.com/mcp --agent <agent>`. Run it in another terminal; the channel picks the sign-in up by itself.
- **Agents keep signing each other out.** An agent holds one session at a time. Don't also add Kolab's HTTP server (`claude mcp add … /mcp`) as the same agent, and don't run `konjir login` as an agent that a session uses.
- **No `← konjir:` messages arrive.** Channels need Claude Code signed in with a claude.ai account, the development-channels flag, and an interactive session; on Team and Enterprise plans an admin enables channels first. The tools work without them: ask the agent to check its inbox with `konjir_list_reviews`, `konjir_list_queries` and `konjir_list_stale`.
- **`this checkout tracks …, not …` or `is no repository registered in this kolab`.** `konjir work deliver` runs only in a checkout whose first commit and `origin` are the registered repository's. Check `git remote -v` shows the URL you registered in step 6, and that the builder ran it in `~/linkly`.
- **`no commit reachable from HEAD … carries the trailer`.** The builder committed without the package's trailer, or deliver ran on another branch. Ask it to commit with `git commit --trailer "Konjir-Work: …"`, the trailer `konjir_read_work` gives, and deliver from that branch.
- **The builder's `konjir work deliver` opens a browser, or works as you.** It ran without `KONJIR_CREDENTIALS="$KJ_AGENTS/$ME-builder.json"` before it, so konjir used your own sign-in, or none. Ask it to run it again with that in front.
- **`a person with Maintain or Admin registers it` when an agent tries.** Registering a repository is always a person's act. Run `konjir repo register` yourself, signed in as yourself (step 6).
- **`konjir repo register` or `konjir set_work_lease` acts on the wrong kolab.** A sign-in works in one kolab, and these act in that one. To act in another, sign in there first, as yourself: `konjir login --kolab <its name>`, then run the step. That sign-in replaces your other one as yourself, so sign back in to `$KOLAB` afterwards.
- **A deltas draft says `cannot override …: not in parent`.** Deltas apply to the node's latest committed version. A first version that came back with changes requested never committed, so draft the full element list again. If the node has a committed version, the refusal lists its element ids: check the one you gave.
- **`konjir login` says the sign-in took too long.** It waits 20 minutes for your browser, as long as Kolab's sign-in page lasts. Run it again.
- **The builder asks you a question about the spec instead of building.** The instructions tell it to ask in Konjir, with `konjir_ask`, so the question reaches the spec-writer's inbox as in step 5. Answer it there, and an open question blocks pulling the work that serves its requirement until it is answered.
- **`konjir connect` says it has no bridge.** It runs the channel from a checkout. Use `~/kolab/bin/konjir`, or add `--http` for plain HTTP entries that each sign in through `/mcp` in Claude Code, without a channel.

## Clean up

First quit the three Claude Code sessions (`/exit` in each), so no channel is left waiting for a sign-in you're about to revoke. Then, in one terminal, sign each agent out. Its sign-in is kept in the `agents` folder beside konjir's own (`${XDG_CONFIG_HOME:-$HOME/.config}/konjir`, unless you set `KONJIR_CREDENTIALS`), in a file named after the agent:

```sh
. ~/linkly/konjir.sh && cd ~/linkly
for a in spec-writer spec-reviewer builder; do
  KONJIR_CREDENTIALS="$KJ_AGENTS/$ME-$a.json" konjir logout
done
```

Each prints `the sign-in is revoked and forgotten`. Then archive the agents, which frees their places among your 10. Sign in as yourself (choose **Yourself** on Kolab's page), archive them, and sign out.

```sh
konjir login --kolab $KOLAB
for a in spec-writer spec-reviewer builder; do konjir archive_agent label=$a; done
konjir logout
rm -rf .mcp.json .claude
```

The last line removes the Konjir entries and, if you took the subagent route, `.claude/agents/`.

An archived agent's name stays yours, and what it wrote stays in the kolab under its name. You can't archive the kolab yourself yet; only a Konjir admin can. It stays private to you, and you can reuse it. A person owns at most 10 kolabs.
