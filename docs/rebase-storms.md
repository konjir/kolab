# Rebase storms (W2.7, CAS8)

A record of measurements taken in October 2026, and taken again in November 2026, kept for the figures and the recommendation. The script that took them, `npm run rebase-storm`, prints its results rather than writing this file.

What one parent commit costs when many variants inherit from it, first measured on 16 October 2026 with [`rebase-storm.ts`](../libs/engine/scripts/rebase-storm.ts), in PR #16, which changed no engine code. This file records the numbers and a recommendation. The limit, if any, is Lee's ruling. Each note below says what has changed since, and November's grid and probe figures sit beside October's.

**Since this report:** W1.17 made each node's commit step serial, as recommended below, and closed bugs 1 and 2. `--races` now prints `SAFE` for all four races on both backends, and `libs/engine/test/concurrency.test.ts` runs them as tests. Race 2a now starts the human's commit at the storm's version-number read without awaiting it there, since that read now holds the variant's lock. October's measurements below were taken before W1.17.

**Since P6 (PR #40, D43):** the parent's commit no longer waits for the storm. It queues one `rebase` job per variant and returns, and the outbox worker rebases them level by level, one variant per job. The script now times both: `commitMs`, what the parent's author waits, and `ms`, the commit plus every rebase, with this process draining the outbox at once as a worker would. On 18 October 2026, on the same machine, PGlite, E = 20 and 100, K = 10, three runs each with the median shown. The load average was 5 to 6 while these ran, other agents' work included, so the figures are comparable with each other but not with the tables below. The pre-P6 column ran the engine as merged on main (5540d3d) over the same shapes, at a load average of 2 to 5, about half an hour later:

| E | W × D × B | Variants | P6 commitMs | P6 ms (per rebase) | pre-P6 ms (per rebase) | Statements per rebase, P6 / pre-P6 |
|---|---|---|---|---|---|---|
| 20 | 200 × 1 × 1 | 200 | 59 | 3,771 (18.9) | 3,142 (15.7) | 91 / 86 |
| 20 | 200 × 5 × 1 | 1,000 | 72 | 22,941 (22.9) | 19,737 (19.7) | 87 / 82 |
| 100 | 200 × 1 × 1 | 200 | 93 | 7,477 (37.4) | 7,256 (36.3) | 188 / 183 |
| 100 | 200 × 5 × 1 | 1,000 | 114 | 59,980 (60) | not run | 180 / not run |

The parent's commit now returns in 59 to 114 ms, against 3 to 60 s for the whole storm. The storm as a whole costs 3% to 20% more, which comes to 5 statements more per rebase. Those are the job's claim, its delete in a transaction of its own that checks for a rerun, the commit step's listing of the rebase's own variants and its delete of moot jobs, and the cascade's second listing. Each rebase also takes about one more transaction. A separate count of one 50-variant storm at E = 20, K = 1 gives 75.7 statements per rebase against 70.7, and at E = 100, 157.3 against 152.3. The longest transaction is unchanged, since a job never holds more than one rebase's. Postgres was not rerun for this note.

**Since one spec per kolab (KON1, KON9):** a kolab holds exactly one spec, so the script now builds each variant as a fork: the one spec of a kolab of its own, written by a person of its own (a person holds one hand-issued session at a time), who reads its parent's kolab. On 20 and 21 November 2026 it ran the whole grid again on PGlite, three runs per shape, on the same machine, with the script as PR #208 left it. [Results](#results) and [the full grid](#the-full-grid) give those figures, with October's beside them. The Postgres grid was not rerun: the PGlite grid alone took 2 hours 40 minutes on a busy machine. `--races` printed `SAFE` for every race on both backends, and `--probe` ran on both, with the change to when its storm ends that this file's update brings (see *Other writers during a storm*).

## What was measured

A parent spec `P` has E elements. W variant trees hang under it, each D levels deep with B children per variant per level, so there are V = W × (1 + B + … + B^(D−1)) variants. Each variant overrides 20% of the elements (F = 0.2), a different window each. `P` then commits a version that changes its first K elements, and the script times the storm: that `commit` call and the rebase of every variant (OVR3), each passing the structural gate (OVR10, VER12) and the three-way rule (CAS5). In October the call itself returned only once every variant was rebased. Since P6 it returns once `P` is committed, with the rebases queued, and the script drains the outbox at once, as a worker would, timing the call alone as `commitMs` and the call and the drain as `ms`.

For each storm the script counts:

- the versions rebased, in all and per depth
- the wall time of the storm, and of the parent's commit call within it
- the marks raised by reason, and the queries raised
- the SQL statements and transactions run, and the longest transaction
- the peak resident memory of the Node process

In October it ran on PGlite in process, and on Postgres 18 (`postgres:18-alpine` in Docker 28.4, through Testcontainers, as a non-superuser like the RDS master user), on an Apple M3 Max with 14 cores and 36 GB. The machine was shared with other work, so its load varied. A probe mode also runs other writers during a storm, and a races mode reproduces the races it found.

The grid is E ∈ {20, 100}, K ∈ {1, 10}, D ∈ {1, 3, 5} and W ∈ {1, 10, 50, 200} with B = 1, plus branching trees with B = 2 and D = 5. That makes 54 shapes per backend, up to 1,000 variants. Each backend first runs one throwaway warm-up storm. Each shape then runs three times, each on a fresh database, and the tables report the run with the median time. Three Postgres shapes were still noisy after that, all three runs slow while the machine was busy. They were rerun alone, five times each, and those medians are marked \* below. One earlier, single-run PGlite storm used 2,000 variants. In October no storm went over the 60 s budget, which the script holds a series' median to. The grid stops at 1,000 variants because building the families takes as long as the storms do. With three runs per shape, October's grid took 22 minutes on PGlite and 26 on Postgres. November's PGlite grid took 2 hours 40 minutes; two of its single runs went over 60 s, at 74 s and 141 s, while every median stayed under it (at most 46 s), so no series stopped early.

## Results

The figures below are from the grid run again on 20 and 21 November 2026, on PGlite, with each variant a fork in a kolab of its own (see *Since one spec per kolab* above). Each table also gives October's figures, for the same shapes, built in one kolab before KON1. Postgres was not rerun for the grid, so its October figures are the latest.

### Cost is linear in the number of variants, at about 21 to 48 ms each

With K = 10, so each run commits ten changed elements. Each figure is the median of three runs:

| E | W × D × B | Variants | Rebased, per depth | PGlite ms (ms per rebase) | Statements per rebase | Transactions per rebase | Longest transaction (ms) | Marks (all `override_stale`) = queries | October: PGlite / Postgres ms (ms per rebase), statements per rebase |
|---|---|---|---|---|---|---|---|---|---|
| 20 | 10 × 1 × 1 | 10 | 10 | 289 (28.9) | 131 | 9.6 | 20.8 | 22 | 140 (14) / 151 (15.1), 78 |
| 20 | 200 × 1 × 1 | 200 | 200 | 4,956 (24.8) | 119 | 9 | 30.2 | 400 | 2,205 (11) / 2,543 (12.7), 70 |
| 20 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 1,224 (24.5) | 116 | 8.5 | 22.9 | 70 | 526 (10.5) / 590 (11.8), 66 |
| 20 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 6,510 (26) | 114 | 8.4 | 32.8 | 350 | 2,613 (10.5) / 2,882 (11.5), 65 |
| 20 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 27,851 (27.9) | 114 | 8.4 | 200.1 | 1,400 | 11,202 (11.2) / 12,239 (12.2), 65 |
| 20 | 16 × 5 × 2 | 496 | 16/32/64/128/256 | 12,559 (25.3) | 112 | 8.1 | 61.9 | 550 | 4,951 (10) / 5,656 (11.4), 63 |
| 100 | 10 × 1 × 1 | 10 | 10 | 476 (47.6) | 228 | 8.7 | 61.9 | 13 | 286 (28.6) / 324 (32.4), 175 |
| 100 | 200 × 1 × 1 | 200 | 200 | 8,179 (40.9) | 215 | 9 | 73.3 | 400 | 4,904 (24.5) / 6,086 (30.4), 167 |
| 100 | 50 × 3 × 1 | 150 | 50/50/50 | 6,352 (42.3) | 209 | 8.1 | 75 | 167 | 3,464 (23.1) / 4,334 (28.9), 160 |
| 100 | 200 × 3 × 1 | 600 | 200/200/200 | 26,988 (45) | 208 | 8.1 | 97.5 | 680 | 14,592 (24.3) / 18,563 (30.9), 159 |
| 100 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 10,866 (43.5) | 207 | 8 | 80.8 | 237 | 5,635 (22.5) / 7,417 (29.7), 158 |
| 100 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 45,746 (45.7) | 207 | 8 | 194.1 | 960 | 27,135 (27.1) / 32,964 (33), 158 |
| 100 | 16 × 5 × 2 | 496 | 16/32/64/128/256 | 21,651 (43.7) | 207 | 7.9 | 88.4 | 466 | 11,492 (23.2) / 14,957 (30.2), 158 |

Every variant was rebased exactly once, and every rebase committed. The counts of marks and queries match October's in every shape of the grid. Only the times, statements and transactions changed. [The full grid](#the-full-grid), with every run's time, is at the end of this file.

- **Time is still linear in V, the total number of variants, and depth still only matters as a multiplier of V.** The cost per rebase stays flat from 10 variants to 1,000: 21 to 29 ms per rebase at E = 20, and 40 to 48 ms at E = 100. The exceptions are the single-variant rows, which include the parent's own commit, the trees of 3 to 5 variants (up to 70 ms), and one noisy shape, 10 variants at E = 100 and K = 1, at 128 ms per rebase, with a 251 ms transaction. A branching tree (B = 2) costs the same per variant as chains. To a good approximation, a storm now takes V × (20 + 0.25 × E) ms on PGlite. October's report gave V × (6 + 0.25 × E) for both backends.
- **Each rebase runs about 50 more statements than in October.** At K = 1 a rebase runs about 81 + 1.2 × E statements, against October's 31 + 1.2 × E: 105 to 115 at E = 20 (October: 55 to 60), and 201 to 219 at E = 100 (October: 151 to 164). The extra 50 is the same at both sizes, so it isn't per element. It comes from the forks, each in its own kolab with its own holder, and from what the engine has added since October (the outbox, P6's jobs, work packages, the autonomy policy). This run doesn't separate the two. A rebase on PGlite now costs 2.3 to 2.6 times what it did in October at E = 20, and about 1.8 times at E = 100, as a fixed extra cost per rebase would. With K = 10, that is 24 to 29 ms against 9.4 to 14.5 ms at E = 20, and 41 to 48 ms against 21.8 to 29.4 ms at E = 100.
- **The parent's commit call, and the longest transaction, now grow with the number of forks on the server.** The parent's commit returns in 31 to 150 ms in every shape up to 250 variants but the noisy one (278 ms). It takes 210 to 300 ms at 600 variants, and 450 to 530 ms at 1,000, although `P` has 200 children in each of the shapes with W = 200. The longest transaction is 14 to 81 ms in the same shapes, the noisy one aside, about 95 ms at 600 and about 200 ms at 1,000. Building a family slows down the same way: 15 to 28 s for 200 variants, but 6 to 8 minutes for 1,000. Each fork adds a kolab, a person, a grant and a session, so some step of a write seems to read more as those grow. The run doesn't say which, and a server with 1,000 kolabs is far beyond today's.
- **Every variant is re-minted, even when nothing it shows changed.** This is unchanged since October. With K = 1 a variant that overrides the changed element ends up with identical content, and it still gets a new version, which cascades to its own children. This is the "lockstep re-versioning" Prior Art warns about.
- **Marks flood the inbox.** Unchanged too: each dirty override on each variant opens one `override_stale` mark and one query. With E = 20 and K = 10, one parent commit put 1,400 marks and 1,400 queries into the variants' inboxes at 1,000 variants, and 400 at 200 variants. Each fork's marks are in its own kolab's inbox now, rather than all in one. No other reason appeared.
- **Memory is not a concern.** The run used `--expose-gc`. The resident set was 470 MB to 1.3 GB, mostly the WASM heap of this and earlier storms' databases, and grew by at most 190 MB during a storm, as in October.
- **The machine was busier than in October.** The load average was 20 to 26 for most of the run, other agents' work included, against 2 to 6 in October. That inflates every time here by an amount the run can't measure. The counts of statements, transactions, marks and queries don't depend on it.

### Transactions are short, and the committer no longer waits for the storm

- **A storm is not one transaction.** Each rebase writes in a few short transactions of its own: 7.1 to 9.6 per rebase in the grid's shapes of 10 or more variants, against October's 3.2 to 7.7. Transactions took 59% to 80% of the storm's wall time, all of it in short bursts. The longest stays short, apart from its growth with the number of forks (above). No lock is held across the storm, and no table or node is locked while it runs.
- **The parent's author waits only for the parent's own commit (P6, D43).** In October, before P6, `commit` returned only after the last descendant was rebased. With 1,000 variants and K = 10, that took 11 to 12 s at E = 20 (PGlite and Postgres) and 27 to 33 s at E = 100. Now it returns once `P` is committed and its variants' rebases are queued, in 31 to 531 ms here, and the outbox worker runs the storm. The same storms took 28 s at E = 20 and 46 s at E = 100 on PGlite.

### Other writers during a storm: no blocking, and, in October, two correctness bugs

On 21 November 2026, with W1.17 and P6 in place and each variant a fork, `--probe` lost no edit and raised no error on either backend, and left no variant behind its parent. Since P6 the storm it times is the parent's commit call and the outbox work that carries `P`'s new version to every variant, drained in batches of 25 jobs. It ends once each variant's live version descends from that version: the variant writer's own edits keep queueing rebases of their children, so the outbox would never empty while it runs. The check after each batch is one statement, and its time is taken off the storm's; on PGlite the writers still wait behind it. The storm gives up, as an error, if no further variant reaches the new version within `--budget` (60 s), or if no job is left in the outbox before every variant has. Then the probe stops the writers and drains the outbox before it counts variants behind their parent, so that count means a variant no queued work would catch up. One run each:

| Backend | Shape | Storm | Unrelated commit p50 / max, idle → during (ms) | Variant edit p50 / max, idle → during (ms) | Human edits committed / lost | Errors |
|---|---|---|---|---|---|---|
| PGlite | 150 variants, E = 20 | 20.3 s | 49 / 53 → 147 / 185 | 71 / 75 → 161 / 286 | 122 / 0 | none |
| PGlite | 250 variants, E = 100 | 103.3 s | 70 / 74 → 330 / 424 | 205 / 232 → 354 / 608 | 286 / 0 | none |
| Postgres | 150 variants, E = 20 | 8.0 s | 66 / 78 → 78 / 99 | 104 / 115 → 108 / 174 | 78 / 0 | none |
| Postgres | 250 variants, E = 100 | 31.1 s | 106 / 113 → 132 / 214 | 261 / 280 → 314 / 502 | 107 / 0 | none |

The storms take longer than October's because each rebase costs 2.3 to 2.6 times as much at E = 20 and about 1.8 times at E = 100 (see *Results*), because the variant writer's edits are rebased inside them, and because the PGlite run shared the machine at a load average of about 22. The rest of this section is October's, from before W1.17.

`--probe` runs two writers in a loop while the parent commits, with E = 20, W = 50, D = 3 (150 variants) and with E = 100, W = 50, D = 5 (250 variants). One writer commits to a node outside the family. The other commits human edits to the variants, in reverse creation order. The cascade's child query has no order, so this makes it likely, but not certain, that edits land on variants still waiting for their rebase. `--races`, described under bug 1, is the deterministic version. The probe's timings vary widely between runs, partly because the variant writer triggers extra catch-up rebases inside the timed storm: a review of PR #16 measured 50.6 s for the second PGlite storm below. Its results, from one run each:

| Backend | Shape | Storm | Unrelated commit p50 / max, idle → during (ms) | Variant edit p50 / max, idle → during (ms) | Human edits committed / lost | Errors |
|---|---|---|---|---|---|---|
| PGlite | 150 variants, E = 20 | 5.8 s | 6 / 7 → 29 / 44 | 20 / 28 → 62 / 216 | 75 / **14** | none |
| PGlite | 250 variants, E = 100 | 18.2 s | 7 / 7 → 69 / 121 | 71 / 129 → 200 / 767 | 84 / **10** | none |
| Postgres | 150 variants, E = 20 | 2.3 s | 6 / 7 → 12 / 25 | 22 / 33 → 27 / 94 | 71 / **13** | 1 unique violation on a variant edit |
| Postgres | 250 variants, E = 100 | 15.5 s | 7 / 8 → 19 / 297 | 89 / 149 → 123 / 3,213 | 59 / 0 | **the storm's own commit failed**, leaving 2 variants behind; 1 variant edit failed |

An earlier Postgres probe run failed the storm's commit in both shapes, leaving 3 and 2 variants behind their parent, and lost 1 human edit.

- **Other writers aren't blocked.** On Postgres, an unrelated commit slowed from about 7 ms to 12 to 19 ms at the median, competing for the pool and the server. On PGlite, which is one connection, every statement queues behind the storm's statements one at a time. Unrelated commits there slowed four to ten times, to a median of 29 to 69 ms, but they kept going: 191 to 392 of them ran during each storm.
- **Bug 1: a commit can silently discard another commit's edit.** The probe found it as a stale rebase. A review of PR #16 traced it to a wider class of lost updates with one root cause, and `--races` reproduces each case deterministically. Races 1a, 1b and 2a (under bug 2) gave identical results on PGlite and Postgres. Race 2b, two concurrent human commits, differs by backend: on PGlite they collided every time (bug 2), and on Postgres one edit was more often lost silently:
  - **1a, the stale child list.** Cascade step 4 lists the variant versions to rebase once, then rebases them one by one, depth first. If a person commits to a variant after the list was taken but before its turn, the person's version commits, and the catch-up in step 5 rebases it correctly. Then the storm rebases the old version it listed, which doesn't include the person's edit. That rebase commits with a higher sequence number and becomes the live version:

    ```
    V1 seq 1  product  the variant as created
    V1 seq 2  product  the human edit, adding element H
    V1 seq 3  system   the catch-up rebase of seq 2 (has H)
    V1 seq 4  system   the storm's rebase of seq 1 (no H), now live
    ```

    The loss reaches the variant's descendants too. Committing seq 4 runs step 4 for V1, which picks up V1's children that the catch-up had just rebased onto seq 3, with H. It rebases them onto seq 4, without H. In the reproduction, V1's child `V1.0` loses the inherited H as well.
  - **1b, review's check-then-act.** `review()` checks for newer committed versions, then waits for the reviewer, then sets `committed`. The window is the whole review, which with a semantic gate is seconds. If the parent commits while a person's draft of a variant is in review, the storm rebases the variant's old version and commits it. The person's review then returns `ok: true` and commits the draft underneath. The draft's catch-up is skipped, because the draft is no longer the highest sequence number.
  - **2b, two concurrent human commits to one node**, with no storm at all. Both drafts are built on the same live version. On Postgres, both calls succeeded and one edit was lost in 6 of 10 runs in this report's `--races` and 7 of 10 in the reviewer's.

  In every case the edit drops out of the live version with no mark, no query and no error. The probe saw it in 4 of its 6 runs. The longer the storm, the wider the window: with 1,000 variants, the last root is rebased about 30 s after the list was taken.
- **Bug 2: concurrent writes to one node race on its sequence number.** `nextSeq` reads `max(seq) + 1` in one statement, and the insert happens in a later one, so two writers to one node can pick the same number. Its effects:
  - **It happens on both backends.** On PGlite, the race comes from JavaScript interleaving between the two awaits, not from a second connection. Two concurrent commits to one node collided in 10 of 10 runs on PGlite.
  - **On Postgres it more often loses an edit silently than collides.** Out of 10 runs of two concurrent commits, 6 succeeded with one edit lost (bug 1), 3 collided, and 1 kept both edits.
  - **The losing caller gets a raw database error** (`duplicate key value violates unique constraint "version_node_id_seq_key"`), not a `GateError` or a retryable result.
  - **When the rebase loses, the storm stops.** The exception escapes the parent's `commit`. The parent version stays committed, but its caller gets an error and no version id. Every variant not yet rebased stays on the old parent, with no mark.
  - **A stranded variant recovers** on its own next commit, through the catch-up in step 5, or when the parent commits again. `--races` shows the first.

## Recommendation

**No cap on inheritance depth or variant count yet. Make each node's commit step serial first (W1.17). Then move rebasing off the commit call before any kolab has more than about 100 descendants under one node.** Lee to rule.

This is October's recommendation. W1.17 and P6 have since done items 2 and 3. November's run changes item 1's formula to V × (20 + 0.25 × E) ms, and adds one thing to watch: the parent's commit and the longest transaction grow with the number of forks on the server.

1. **No depth or count limit is needed now.** The cost is linear and doesn't grow worse with depth: a parent commit takes about V × (6 + 0.25 × E) ms. Today's kolabs, Kolab's own included, have a handful of variants. At 50 variants a storm takes 0.5 to 1.5 s (1.1 to 2.2 s in November, with each variant a fork), and nothing is locked for longer than one rebase. A depth cap would protect nothing, since depth costs only by adding variants. A count cap would refuse legitimate work to hide a latency problem that has a better fix (item 3).
2. **Both bugs need the fix at any scale, and it is one fix.** One concurrent write is enough to trigger either bug, and a limit closes neither. Both have the same root cause:
   - **Drafts don't record their base**, the live version they were built from.
   - **The staleness check isn't atomic.** It runs before the review, and nothing stops the node moving on before the commit.

   The fix is a commit step serialized per node, for example under `select … from node where id = $1 for update`. In one transaction, that step:
   - records the draft's base
   - allocates `seq`
   - checks that the node's live version is still that base, and otherwise folds (if only Kolab's own rebases intervened) or rejects
   - then sets `committed`

   Rebases go through the same step, so a stale listed child fails the base check and is skipped. This closes 1a, 1b, the lost update between two people, and bug 2 together. A storm should also carry on past one variant's failure, marking that variant rather than stranding the rest. This is now work package **W1.17**, outside PR #16. `npm run rebase-storm -- --races` gives it its starting tests: each race prints `RACE` today and should print `SAFE` after the fix. The test for 1a should check the grandchild as well as the variant.
3. **When kolabs grow, rebase asynchronously and in batches, but only after W1.17.** The trigger is any node with more than about 100 descendants, which is about 1 s for small specs and 3 s at 100 elements. The parent's commit would return once the parent is committed, with the number of rebases queued. A worker would rebase level by level, one variant per transaction as today, and it would resume after a restart. This keeps the commit latency bounded, which no cap can do without refusing work. But asynchronous rebasing widens the race window: once the parent's commit returns early, everyone carries on editing while the worker runs, so concurrent edits during a storm become the normal case. So it depends on W1.17's serialized step, and the worker must build each rebase on the version that is live when it runs, never on a list taken earlier.
4. **Cheaper rebases, if the numbers ever matter.**
   - Insert a version's elements in one multi-row statement. That would cut about E statements from each rebase (about 31 + 1.2 × E in October, 81 + 1.2 × E in November), and save most of the cost at E = 100.
   - Skip re-minting a variant whose materialized content and deltas are unchanged. It would only re-pin its base, and its children wouldn't be re-minted either. This answers Prior Art's lockstep warning directly.
   - Consider one mark and one query per variant per parent commit, listing its stale overrides, rather than one for each override. That would cut the inbox flood by up to a factor of the overlap (2 to 4 here).
   - The schema has no secondary indexes. The cost per rebase hadn't started to grow at 2,000 variants, so indexes are not needed yet. `invalidation(delta_id)`, `version(parent_version_id)` and `edge(target_version_id)` are the first to add if it does.

The CAS8 Today column can move from "not measured yet" to measured, with no limit set. The races found are W1.17's gap.

## How to rerun

```
npm run rebase-storm                            # the grid on PGlite, 3 runs per shape: 2 h 40 min in November, 22 min in October
npm run rebase-storm -- --postgres              # the grid on Postgres 18 in a container: 26 min in October, needs Docker
npm run rebase-storm -- --races [--postgres]    # deterministic reproductions of the races, in seconds; all SAFE since W1.17
npm run rebase-storm -- --probe [--postgres]    # other writers during a storm
npm run rebase-storm -- --E 100 --W 50 --D 3 --B 1 --K 10 --F 0.2   # one shape
npm run rebase-storm -- --repeat 1 --budget 30000   # one run per shape; stop a series once a storm takes over 30 s
```

Before measuring, each run does one throwaway warm-up storm. Each storm prints a JSON line as it finishes, and the run prints a table at the end. The npm scripts pass `--output-style=stream` to Nx, so `npm run rebase-storm > out.txt` captures everything. Without it, Nx drops a task's output when stdout isn't a terminal. They also run Node with `--expose-gc`, so the memory baseline is taken after a collection. Running the script some other way, without that flag, makes the growth figures upper bounds. `--postgres` starts its own container and stops it when the run ends.

## The full grid

F = 0.2 throughout. November's run, on PGlite, with each variant a fork in a kolab of its own. "ms" is the storm: the parent's commit and every rebase it queues, as the median of three runs; the runs column gives each run's time in ms. The longest transaction is from the median run. The last column gives October's figures for the same shape, built in one kolab, its times from before P6.

| E | K | W × D × B | V | Rebased per depth | PGlite ms (per rebase) | PGlite runs | Statements per rebase | Transactions per rebase | Longest tx (ms) | Marks = queries | October: PGlite / Postgres ms (per rebase), statements per rebase |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 20 | 1 | 1 × 1 × 1 | 1 | 1 | 55 (55.4) | 55/57/55 | 213 | 12 | 13.8 | 1 | 21 (21.4) / 26 (26), 116 |
| 20 | 1 | 10 × 1 × 1 | 10 | 10 | 242 (24.2) | 242/242/238 | 115 | 7.5 | 13.6 | 1 | 93 (9.3) / 120 (12), 60 |
| 20 | 1 | 50 × 1 × 1 | 50 | 50 | 1,071 (21.4) | 1077/1071/1067 | 107 | 7.3 | 13.9 | 9 | 423 (8.5) / 484 (9.7), 57 |
| 20 | 1 | 200 × 1 × 1 | 200 | 200 | 4,314 (21.6) | 4268/4429/4314 | 106 | 7.2 | 30.4 | 40 | 1,667 (8.3) / 1,860 (9.3), 56 |
| 20 | 1 | 1 × 3 × 1 | 3 | 1/1/1 | 97 (32.4) | 96/97/98 | 140 | 8.7 | 14.1 | 1 | 37 (12.4) / 44 (14.8), 75 |
| 20 | 1 | 10 × 3 × 1 | 30 | 10/10/10 | 656 (21.9) | 652/656/656 | 109 | 7.3 | 13.8 | 5 | 268 (8.9) / 286 (9.5), 57 |
| 20 | 1 | 50 × 3 × 1 | 150 | 50/50/50 | 3,218 (21.5) | 3395/3218/3183 | 106 | 7.2 | 16.8 | 29 | 1,255 (8.4) / 1,410 (9.4), 56 |
| 20 | 1 | 200 × 3 × 1 | 600 | 200/200/200 | 13,993 (23.3) | 13993/13590/14288 | 106 | 7.2 | 93.8 | 120 | 5,168 (8.6) / 5,745 (9.6), 56 |
| 20 | 1 | 1 × 5 × 1 | 5 | 1/1/1/1/1 | 147 (29.4) | 146/147/148 | 126 | 8 | 14.5 | 1 | 53 (10.6) / 99 (19.8), 66 |
| 20 | 1 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 1,161 (23.2) | 1115/1161/1163 | 107 | 7.2 | 15.3 | 7 | 411 (8.2) / 496 (9.9), 56 |
| 20 | 1 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 5,306 (21.2) | 5306/5234/5492 | 105 | 7.2 | 27.4 | 37 | 2,372 (9.5) / 2,364 (9.5), 55 |
| 20 | 1 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 24,780 (24.8) | 24780/26796/24730 | 105 | 7.2 | 199.3 | 150 | 9,624 (9.6) / 10,495 (10.5), 55 |
| 20 | 10 | 1 × 1 × 1 | 1 | 1 | 70 (70.5) | 70/70/73 | 243 | 15 | 21.8 | 4 | 32 (32.2) / 38 (37.8), 149 |
| 20 | 10 | 10 × 1 × 1 | 10 | 10 | 289 (28.9) | 289/287/292 | 131 | 9.6 | 20.8 | 22 | 140 (14) / 151 (15.1), 78 |
| 20 | 10 | 50 × 1 × 1 | 50 | 50 | 1,261 (25.2) | 1261/1326/1251 | 121 | 9.1 | 21.8 | 102 | 724 (14.5) / 647 (12.9), 72 |
| 20 | 10 | 200 × 1 × 1 | 200 | 200 | 4,956 (24.8) | 5133/4956/4931 | 119 | 9 | 30.2 | 400 | 2,205 (11) / 2,543 (12.7), 70 |
| 20 | 10 | 1 × 3 × 1 | 3 | 1/1/1 | 112 (37.5) | 112/111/157 | 157 | 10.7 | 20.1 | 7 | 48 (15.9) / 59 (19.8), 94 |
| 20 | 10 | 10 × 3 × 1 | 30 | 10/10/10 | 729 (24.3) | 729/726/766 | 122 | 9.2 | 20.5 | 62 | 331 (11) / 398 (13.3), 73 |
| 20 | 10 | 50 × 3 × 1 | 150 | 50/50/50 | 3,579 (23.9) | 3579/3525/3766 | 119 | 9 | 22.3 | 302 | 1,643 (11) / 1,928 (12.9), 71 |
| 20 | 10 | 200 × 3 × 1 | 600 | 200/200/200 | 15,971 (26.6) | 16666/15774/15971 | 118 | 9 | 94.9 | 1,200 | 6,926 (11.5) / 7,762 (12.9), 70 |
| 20 | 10 | 1 × 5 × 1 | 5 | 1/1/1/1/1 | 163 (32.7) | 163/165/163 | 137 | 9.4 | 21.4 | 8 | 72 (14.4) / 76 (15.2), 79 |
| 20 | 10 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 1,224 (24.5) | 1229/1215/1224 | 116 | 8.5 | 22.9 | 70 | 526 (10.5) / 590 (11.8), 66 |
| 20 | 10 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 6,510 (26) | 6510/5827/12115 | 114 | 8.4 | 32.8 | 350 | 2,613 (10.5) / 2,882 (11.5), 65 |
| 20 | 10 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 27,851 (27.9) | 27851/26194/74440 | 114 | 8.4 | 200.1 | 1,400 | 11,202 (11.2) / 12,239 (12.2), 65 |
| 100 | 1 | 1 × 1 × 1 | 1 | 1 | 194 (193.8) | 150/194/712 | 389 | 12 | 65.1 | 1 | 49 (48.5) / 65 (65.3), 292 |
| 100 | 1 | 10 × 1 × 1 | 10 | 10 | 1,285 (128.5) | 1293/1285/1075 | 219 | 7.5 | 250.7 | 1 | 226 (22.6) / 292 (29.2), 164 |
| 100 | 1 | 50 × 1 × 1 | 50 | 50 | 2,028 (40.6) | 2403/2000/2028 | 205 | 7.3 | 59.3 | 9 | 1,111 (22.2) / 1,347 (26.9), 154 |
| 100 | 1 | 200 × 1 × 1 | 200 | 200 | 8,031 (40.2) | 8031/7995/8207 | 202 | 7.2 | 69.8 | 40 | 4,222 (21.1) / 5,636 (28.2), 152 |
| 100 | 1 | 1 × 3 × 1 | 3 | 1/1/1 | 204 (67.9) | 204/195/228 | 263 | 8.7 | 58.6 | 1 | 87 (29.1) / 289 (96.3), 197 |
| 100 | 1 | 10 × 3 × 1 | 30 | 10/10/10 | 1,255 (41.8) | 1234/1257/1255 | 207 | 7.3 | 56.8 | 4 | 626 (20.9) / 891 (29.7), 156 |
| 100 | 1 | 50 × 3 × 1 | 150 | 50/50/50 | 6,058 (40.4) | 6003/6058/6421 | 202 | 7.1 | 63.8 | 17 | 3,126 (20.8) / 3,908 (26.1), 152 |
| 100 | 1 | 200 × 3 × 1 | 600 | 200/200/200 | 26,769 (44.6) | 26769/32671/25668 | 201 | 7.1 | 98.8 | 68 | 13,933 (23.2) / 16,661 (27.8), 151 |
| 100 | 1 | 1 × 5 × 1 | 5 | 1/1/1/1/1 | 275 (55.1) | 275/277/271 | 238 | 8 | 56.7 | 1 | 128 (25.6) / 161 (32.2), 178 |
| 100 | 1 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 2,117 (42.3) | 2025/2117/2127 | 204 | 7.2 | 59.6 | 4 | 1,034 (20.7) / 1,311 (26.2), 153 |
| 100 | 1 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 10,849 (43.4) | 10639/12397/10849 | 201 | 7.1 | 75.6 | 24 | 5,738 (23) / 6,586 (26.3), 151 |
| 100 | 1 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 41,505 (41.5) | 141267/41505/40524 | 201 | 7.1 | 197.6 | 100 | 24,368 (24.4) / 29,336 (29.3), 151 |
| 100 | 10 | 1 × 1 × 1 | 1 | 1 | 134 (134.3) | 134/133/134 | 461 | 21 | 62.2 | 10 | 62 (61.8) / 88 (87.5), 373 |
| 100 | 10 | 10 × 1 × 1 | 10 | 10 | 476 (47.6) | 475/476/477 | 228 | 8.7 | 61.9 | 13 | 286 (28.6) / 324 (32.4), 175 |
| 100 | 10 | 50 × 1 × 1 | 50 | 50 | 2,083 (41.7) | 2090/2081/2083 | 218 | 9 | 64.5 | 98 | 1,471 (29.4) / 1,474 (29.5), 169 |
| 100 | 10 | 200 × 1 × 1 | 200 | 200 | 8,179 (40.9) | 8174/8187/8179 | 215 | 9 | 73.3 | 400 | 4,904 (24.5) / 6,086 (30.4), 167 |
| 100 | 10 | 1 × 3 × 1 | 3 | 1/1/1 | 209 (69.6) | 209/209/209 | 287 | 11.7 | 61.2 | 10 | 104 (34.5) / 129 (43.1), 224 |
| 100 | 10 | 10 × 3 × 1 | 30 | 10/10/10 | 1,256 (41.9) | 1256/1248/1342 | 215 | 8.4 | 63.8 | 37 | 674 (22.5) / 893 (29.8), 165 |
| 100 | 10 | 50 × 3 × 1 | 150 | 50/50/50 | 6,352 (42.3) | 6352/6221/6753 | 209 | 8.1 | 75 | 167 | 3,464 (23.1) / 4,334 (28.9), 160 |
| 100 | 10 | 200 × 3 × 1 | 600 | 200/200/200 | 26,988 (45) | 27016/26988/26817 | 208 | 8.1 | 97.5 | 680 | 14,592 (24.3) / 18,563 (30.9), 159 |
| 100 | 10 | 1 × 5 × 1 | 5 | 1/1/1/1/1 | 303 (60.6) | 309/303/301 | 252 | 9.8 | 66.3 | 10 | 152 (30.5) / 217 (43.4), 195 |
| 100 | 10 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 2,220 (44.4) | 2220/2235/2191 | 210 | 8 | 71.5 | 45 | 1,316 (26.3) / 1,416 (28.3), 160 |
| 100 | 10 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 10,866 (43.5) | 10866/10836/10922 | 207 | 8 | 80.8 | 237 | 5,635 (22.5) / 7,417 (29.7), 158 |
| 100 | 10 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 45,746 (45.7) | 44586/47550/45746 | 207 | 8 | 194.1 | 960 | 27,135 (27.1) / 32,964 (33), 158 |
| 20 | 10 | 1 × 5 × 2 | 31 | 1/2/4/8/16 | 780 (25.2) | 772/782/780 | 114 | 8 | 20.8 | 28 | 291 (9.4) / 345 (11.1), 63 |
| 20 | 10 | 4 × 5 × 2 | 124 | 4/8/16/32/64 | 3,027 (24.4) | 3045/3027/3003 | 113 | 8.2 | 22.9 | 139 | 1,192 (9.6) / 1,545 (12.5), 63 |
| 20 | 10 | 16 × 5 × 2 | 496 | 16/32/64/128/256 | 12,559 (25.3) | 12535/12705/12559 | 112 | 8.1 | 61.9 | 550 | 4,951 (10) / 5,656 (11.4), 63 |
| 100 | 10 | 1 × 5 × 2 | 31 | 1/2/4/8/16 | 1,371 (44.2) | 1359/1383/1371 | 208 | 7.5 | 65.4 | 10 | 676 (21.8) / 845 (27.2), 157 |
| 100 | 10 | 4 × 5 × 2 | 124 | 4/8/16/32/64 | 5,342 (43.1) | 5395/5342/5326 | 208 | 8 | 70.4 | 123 | 2,707 (21.8) / 3,550 (28.6), 159 |
| 100 | 10 | 16 × 5 × 2 | 496 | 16/32/64/128/256 | 21,651 (43.7) | 21652/21651/21555 | 207 | 7.9 | 88.4 | 466 | 11,492 (23.2) / 14,957 (30.2), 158 |

With a single variant, the counts per rebase include the parent's own commit.
