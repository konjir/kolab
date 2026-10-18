# The M1 walkthrough

Milestone M1 is done when an outside team could put a real product spec on Kolab. This walkthrough shows a team doing that, end to end, in about 30 seconds: Acme's product manager and engineer each bring two agents. Together they write a small functional spec, bind it to a stack, review each other's work, ask and answer questions across the layers, change the spec and apply a ruling. A second company, Globex, then shows that it can't see any of it.

All the work goes through the `konjir` CLI, one agent session token per agent, exactly as a harness would use it. Every step prints the commands it runs, who runs them, and the addresses involved. It then checks what Kolab did and stops at the first surprise.

| File | What it is |
| --- | --- |
| `m1-walkthrough.mjs` | The walkthrough, plain Node 22+ with no dependencies. It needs a Kolab URL and its admin token. `cleanup <state file>` undoes a run. |
| `run-local.sh` | Starts a throwaway Kolab from this checkout, runs the walkthrough with a restart and the cleanup, then stops Kolab and removes it. |

## Running it

**Locally**, against a fresh Kolab that nothing else uses:

```
npm install
deploy/demo/run-local.sh              # embedded Postgres (PGlite) in a temporary directory
deploy/demo/run-local.sh --postgres   # Postgres 18 in a Docker container, removed afterwards
```

**Against a running Kolab**, such as the test server:

```
KONJIR_URL=https://kolab.konjir.com/mcp KONJIR_TOKEN=$(deploy/konjir-ops.sh admin-token) \
  node deploy/demo/m1-walkthrough.mjs
# afterwards, or with KONJIR_DEMO_CLEANUP=1 on the first command:
KONJIR_URL=https://kolab.konjir.com/mcp KONJIR_TOKEN=$(deploy/konjir-ops.sh admin-token) \
  node deploy/demo/m1-walkthrough.mjs cleanup ~/.konjir-demo/<run>.json
```

Every name the run creates ends in a fresh run id, for example `acme-demo-1017k3x9`, and the run stops before writing anything if one of its kolab names is taken. So it never touches an existing kolab, the mirror kolab `kolab` included. With the admin token, a run can't skip review on any node but its own: `admin_apply_ruling` is given the demo kolab's node by its full name.

No token is printed. The agents' tokens go to the state file (`~/.konjir-demo/<run>.json`, mode 600), so that `cleanup` can end their sessions. Kolab's refusals are scrubbed of tokens before they are shown.

| Setting | Default | What it does |
| --- | --- | --- |
| `KONJIR_URL` | `http://127.0.0.1:7420/mcp` | The Kolab |
| `KONJIR_TOKEN` or `KONJIR_ADMIN_TOKEN` | none | Its admin token |
| `KONJIR_BIN` | this checkout's `bin/konjir`, else `konjir` on PATH | The CLI to drive, for example `npx -y konjir` for the published client |
| `KONJIR_DEMO_RUN` | the date and 4 random characters | The suffix on every name |
| `KONJIR_DEMO_STATE` | `~/.konjir-demo/<run>.json` | The state file |
| `KONJIR_DEMO_RULING` | `D1` | The Decisions Log id the ruling step applies. It is Acme's own log, not Konjir's. |
| `KONJIR_DEMO_RESTART` | unset | A shell command that restarts Kolab, run while a version waits in review. `run-local.sh` sets it; against a shared server, leave it unset. |
| `KONJIR_DEMO_CLEANUP=1` | off | Clean up at the end of the run |
| `NO_COLOR=1` | off | Plain output (colour is used only on a terminal) |

### Cleanup, and what stays

`cleanup` removes only what its run created: it ends the run's sessions, revokes its grants and removes its memberships. **Kolabs, organizations and actors can't be deleted yet:** Kolab has no verb that removes or renames an account, a team or a kolab, and a kolab's history is never deleted. So after cleanup, each run leaves two kolabs (`acme-demo-<run>`, `globex-demo-<run>`), two organizations and seven actors, with no grants or memberships, which only the admin token can reach. On the test server that is permanent until such a verb exists, so run it there when it is worth it, not as a smoke test.

## What each step shows

The IDs are the requirements of *Kolab — Functional Spec* that each step demonstrates.

| # | Step | What the audience sees | Spec |
| --- | --- | --- | --- |
| 1 | Acme signs up | An organization owns a private kolab, `acme-demo-<run>`. Priya gets Write on the functional layer, Marco on the technical layer. | TEN2, TEN6, TEN7, TEN8, TEN10 |
| 2 | Two agents each | Each agent is an actor of its own, owned by a person. One writes and the other reviews. Kolab refuses to give Priya's agent the technical layer, since Priya herself can't write it. | TEN11, VER16 |
| 3 | Sessions | One kolab, one role, one token per agent. `whoami` shows the token alone fixes the kolab and the layer. | ROL1, DEL1, DEL2, DEL4 |
| 4 | Spec drafted and submitted | "Team invitations": two sections, six requirements, each with a stable ID. The version waits in review, with requests to Priya and her reviewer agent and none to Marco's agents. | KON1, VER1, VER2, VER5, ADR1 |
| 5 | Changes requested | The reviewer agent finds implementation in R3 (a cron job, a table) and requests changes with a `layer_leak` finding. The version goes back to its author as a draft, and the author's answers say why. | VER6, VER8, VER10, ROL3 |
| 6 | Redraft and approval | One approval from another agent of the same person commits `kj:acme-demo-<run>/invitations@2`. | VER2, VER16 |
| 7 | Roles enforced | A product session can't create a binding, and an engineer session can't edit the spec. Kolab refuses both, whatever the harness says. | ROL2, ROL5 |
| 8 | The binding | Five elements, each linked to the requirement it serves. b4 links to the quoted words "no longer valid" in R5. Marco's reviewer agent approves it. `lineage` from the spec sees all six links. | KON4, KON8, LNK1–LNK3, ADR5, ADR6, VER4 |
| 9 | Question and note | The engineer asks R5 a question from b4 and leaves a note on the words "7 days" in R3. Both land in product's queue, and product answers both. Only b4 gets a `query_answered` mark, since a reply to a note marks nothing. The engineer clears it, and `read_node` shows the thread beside R5. | Q1–Q6 |
| 10 | The spec changes | R3 goes from 7 to 14 days. Exactly one binding element is marked: b2, which serves R3. The other links re-pin silently, b4's quote included. | LNK3, LNK4, LNK5, ADR8 |
| 11 | The mark is resolved | The engineer revises b2. Revising the element settles its mark and re-pins its link. | LNK6, LNK7 |
| 12 | A ruling | The admin applies ruling D1, which raises the Free plan to 10 members, as Priya (`konjir_admin_apply_ruling`, D47). It commits on structural checks alone, its review note names the ruling, and `read_node` shows Priya, in the product role, as its author. An agent session is refused the verb. It cascades like any commit: b5 is marked and then revised. | CASE3, D47, ROL4 |
| 13 | A wait that survives a restart | Product rewords R2 and submits it. With `run-local.sh`, Kolab is restarted while the version waits in review. The request is still in the reviewer's inbox, and every token still works. After the approval, b1 is marked, and the engineer confirms it still holds with `clear_mark`. The outbox holds no dead job. | VER16, LNK6, REV3 (W1.8) |
| 14 | Isolation | Globex's agent, owned by the organization itself, writes a spec with the same name, `invitations`. It commits unreviewed, since no one else at Globex can write that layer, and the commit says so. Globex lists only its own node. Reading `acme-demo-<run>/invitations` is refused in the same words as a kolab that doesn't exist, and the refusal holds the other way round too. Kolab names are unique across Konjir. | TEN3, TEN4, TEN11, TEN12, ADR3, VER11 |
| 15 | Where things stand | The final spec and binding, with their full addresses and authors | ADR9 |

## Talking points

- **One statement of intent, many stacks (KON1, KON4).** The spec says what the person experiences. The binding says how one stack delivers it. In step 5 the reviewer agent throws implementation out of the spec: that is what keeps the spec portable.
- **Nothing commits without review, and review is by agents (VER2, VER6, VER16).** Kolab runs no model and holds no model credentials (VER7). Each reviewing agent works in its owner's harness, on its owner's account. Separation of duty is per agent, so one person's two agents can review each other.
- **Precision of the cascade (LNK3).** One requirement edit marks one binding element (step 10), not the whole binding. This is the measurement that decided element-level links: 4 dirty versions instead of 202.
- **Questions route to whoever owns the answer (Q1, Q2).** The engineer doesn't guess and doesn't edit the spec. The answer reaches the element that waited on it, even though the spec text never changed.
- **Rulings are approvals (D47, CASE3).** A decision that has already been made goes in without a second review, under the actor it is written as, and is recorded as a ruling. Only the admin token can do it.
- **Waits are durable (REV3).** A review request is a row, so it outlives a restart. The outbox finishes what each commit owes, exactly once.
- **Tenancy (TEN12).** Another company on the same Kolab learns nothing, not even whether a kolab exists.
- **The setup is one token (DEL2).** Every agent here is a shell with `KONJIR_URL` and `KONJIR_TOKEN`. Claude Code would add the same URL and token as an MCP server.

What an outside team will notice is missing today: tenancy is managed only through the admin token, since a kolab's own Admins can't grant access yet. Tokens are bearer tokens with no expiry or OAuth. Nothing imports another tool's spec files (FIL2), and there is no plan or work-package flow (PLN). Kolabs and accounts can't be removed.

## Rough edges it steers around

- **A link to a quoted span can be left with a mark nothing can settle.** If the quoted words change ("7 days" to "14 days"), the link's mark is `orphaned`, though the quote's prefix and suffix are intact. `clear_mark` refuses an orphaned mark. Revising the element, linking it again to the new words, or removing the element altogether all leave the mark open, carried onto each new version of the binding. The mark's next step says to "remove the dependency in a new draft", but no verb removes a link. So step 8 quotes words that the walkthrough never changes, and links b2 to R3 as a whole element.
- **An agent session calling an admin verb is refused with `Insufficient scope: required "agent admin"`**. That reads as if both scopes were needed, and it doesn't say that only the admin token may call the verb.
