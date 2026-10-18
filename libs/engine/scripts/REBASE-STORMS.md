# Rebase storms (W2.7, CAS8)

What one parent commit costs when many variants inherit from it, measured on 16 October 2026 with [`rebase-storm.ts`](rebase-storm.ts). This file records the numbers and a recommendation. The limit, if any, is Lee's ruling. The engine wasn't changed.

**Since this report:** W1.17 made each node's commit step serial, as recommended below, and closed bugs 1 and 2. `--races` now prints `SAFE` for all four races on both backends, and `libs/engine/test/concurrency.test.ts` runs them as tests. Race 2a now starts the human's commit at the storm's version-number read without awaiting it there, since that read now holds the variant's lock. The measurements below were taken before W1.17.

**Since P6 (PR #40, D43):** the parent's commit no longer waits for the storm. It queues one `rebase` job per variant and returns, and the outbox worker rebases them level by level, one variant per job. The script now times both: `commitMs`, what the parent's author waits, and `ms`, the commit plus every rebase, with this process draining the outbox at once as a worker would. On 18 October 2026, on the same machine, PGlite, E = 20 and 100, K = 10, three runs each with the median shown. The load average was 5 to 6 while these ran, other agents' work included, so the figures are comparable with each other but not with the tables below. The pre-P6 column ran the engine as merged on main (5540d3d) over the same shapes, at a load average of 2 to 5, about half an hour later:

| E | W × D × B | Variants | P6 commitMs | P6 ms (per rebase) | pre-P6 ms (per rebase) | Statements per rebase, P6 / pre-P6 |
|---|---|---|---|---|---|---|
| 20 | 200 × 1 × 1 | 200 | 59 | 3,771 (18.9) | 3,142 (15.7) | 91 / 86 |
| 20 | 200 × 5 × 1 | 1,000 | 72 | 22,941 (22.9) | 19,737 (19.7) | 87 / 82 |
| 100 | 200 × 1 × 1 | 200 | 93 | 7,477 (37.4) | 7,256 (36.3) | 188 / 183 |
| 100 | 200 × 5 × 1 | 1,000 | 114 | 59,980 (60) | not run | 180 / not run |

The parent's commit now returns in 59 to 114 ms, against 3 to 60 s for the whole storm. The storm as a whole costs 3% to 20% more, which comes to 5 statements more per rebase. Those are the job's claim, its delete in a transaction of its own that checks for a rerun, the commit step's listing of the rebase's own variants and its delete of moot jobs, and the cascade's second listing. Each rebase also takes about one more transaction. A separate count of one 50-variant storm at E = 20, K = 1 gives 75.7 statements per rebase against 70.7, and at E = 100, 157.3 against 152.3. The longest transaction is unchanged, since a job never holds more than one rebase's. Postgres was not rerun for this note.

## What was measured

A parent spec `P` has E elements. W variant trees hang under it, each D levels deep with B children per variant per level, so there are V = W × (1 + B + … + B^(D−1)) variants. Each variant overrides 20% of the elements (F = 0.2), a different window each. `P` then commits a version that changes its first K elements, and the script times that one `commit` call. That call returns only when every variant has been rebased (OVR3), each rebase passing the structural gate (OVR10, VER12) and the three-way rule (CAS5).

For each storm the script counts:

- the versions rebased, in all and per depth
- the wall time of the parent's commit
- the marks raised by reason, and the queries raised
- the SQL statements and transactions run, and the longest transaction
- the peak resident memory of the Node process

It ran on PGlite in process, and on Postgres 18 (`postgres:18-alpine` in Docker 28.4, through Testcontainers, as a non-superuser like the RDS master user), on an Apple M3 Max with 14 cores and 36 GB. The machine was shared with other work, so its load varied. A probe mode also runs other writers during a storm, and a races mode reproduces the races it found.

The grid is E ∈ {20, 100}, K ∈ {1, 10}, D ∈ {1, 3, 5} and W ∈ {1, 10, 50, 200} with B = 1, plus branching trees with B = 2 and D = 5. That makes 54 shapes per backend, up to 1,000 variants. Each backend first runs one throwaway warm-up storm. Each shape then runs three times, each on a fresh database, and the tables report the run with the median time. Three Postgres shapes were still noisy after that, all three runs slow while the machine was busy. They were rerun alone, five times each, and those medians are marked \* below. One earlier, single-run PGlite storm used 2,000 variants. No storm went over the 60 s budget. The grid stops at 1,000 variants because building the families takes as long as the storms do. With three runs per shape, the grid took 22 minutes on PGlite and 26 on Postgres.

## Results

### Cost is linear in the number of variants, at about 10 to 33 ms each

With K = 10, so each run commits ten changed elements. Each figure is the median of three runs:

| E | W × D × B | Variants | Rebased, per depth | PGlite ms (ms per rebase) | Postgres ms (ms per rebase) | Statements per rebase | Transactions per rebase | Longest transaction, PGlite / Postgres (ms) | Marks (all `override_stale`) = queries |
|---|---|---|---|---|---|---|---|---|---|
| 20 | 10 × 1 × 1 | 10 | 10 | 140 (14) | 151 (15.1) | 78 | 7.7 | 8 / 9.5 | 22 |
| 20 | 200 × 1 × 1 | 200 | 200 | 2,205 (11) | 2,543 (12.7) | 70 | 7 | 7.4 / 9.9 | 400 |
| 20 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 526 (10.5) | 590 (11.8) | 66 | 5.9 | 6.9 / 9.8 | 70 |
| 20 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 2,613 (10.5) | 2,882 (11.5) | 65 | 5.8 | 6.8 / 9.6 | 350 |
| 20 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 11,202 (11.2) | 12,239 (12.2) | 65 | 5.8 | 10.4 / 11.2 | 1,400 |
| 20 | 16 × 5 × 2 | 496 | 16/32/64/128/256 | 4,951 (10) | 5,656 (11.4) | 63 | 5.2 | 7 / 10.9 | 550 |
| 100 | 10 × 1 × 1 | 10 | 10 | 286 (28.6) | 324 (32.4) | 175 | 5.9 | 22.9 / 32 | 13 |
| 100 | 200 × 1 × 1 | 200 | 200 | 4,904 (24.5) | 6,086 (30.4) | 167 | 7 | 25.7 / 37.2 | 400 |
| 100 | 50 × 3 × 1 | 150 | 50/50/50 | 3,464 (23.1) | 4,334 (28.9) | 160 | 5.2 | 22.2 / 62.1 | 167 |
| 100 | 200 × 3 × 1 | 600 | 200/200/200 | 14,592 (24.3) | 18,563 (30.9) | 159 | 5.3 | 24.7 / 58.2 | 680 |
| 100 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 5,635 (22.5) | 7,417 (29.7) | 158 | 4.9 | 22.6 / 35 | 237 |
| 100 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 27,135 (27.1) | 32,964 (33) | 158 | 4.9 | 23.5 / 53.9 | 960 |
| 100 | 16 × 5 × 2 | 496 | 16/32/64/128/256 | 11,492 (23.2) | 14,957 (30.2) | 158 | 4.9 | 25 / 38.6 | 466 |

Every variant was rebased exactly once, and every rebase committed. The counts of statements, transactions, marks and queries were identical on both backends and across repeated runs. Only the times vary. [The full grid](#the-full-grid), with every run's time, is at the end of this file.

- **Time is linear in V, the total number of variants, and depth only matters as a multiplier of V.** The cost per rebase stays flat from 10 variants to 1,000. With E = 20 and at least 10 variants, it's 8 to 15 ms per rebase on both backends. Trees of 3 or 5 variants cost a little more per rebase, up to 15.9 ms on PGlite and 19.8 ms on Postgres, and the single-variant rows include the parent's own commit. The single PGlite storm with 2,000 variants (E = 20, W = 400, D = 5, K = 1) took 20.8 s, or 10.4 ms per rebase. Ten roots five deep cost the same as fifty roots one deep. A deep chain is no worse per variant than a wide fan, and a branching tree (B = 2) costs the same per variant as chains. To a good approximation, the parent's commit takes V × (6 + 0.25 × E) ms.
- **Element count drives the cost per rebase.** A rebase runs about 55 + E statements, because `writeVersion` inserts every materialized element one row at a time, whether or not it changed. Going from 20 to 100 elements raises the cost from about 11 ms to about 21 to 29 ms per rebase on PGlite, and 26 to 33 ms on Postgres. K changes it only a little: about 10 more statements per rebase, for the marks and queries.
- **Postgres is usually slower than PGlite** at the same shape: 8% to 32% in the table above, and 6% to 43% in 49 of the full grid's 54 shapes. Writing shapes as E/K/W × D × B, the other five are: 20/10/50 × 1 × 1, 11% faster on Postgres; 20/1/50 × 5 × 1 and 100/10/50 × 1 × 1, the same on both; and two small shapes, 20/1/1 × 5 × 1 and 100/1/1 × 3 × 1, 87% and 232% slower. PGlite's runs spread widely in the first three, and the last one's Postgres runs ranged from 265 to 519 ms. The gap tends to grow with E, since each statement is a round trip to the container rather than a call into the same process. An earlier version of this report used one run per shape. In it the Postgres 200 × 1 × 1 row above took 4,311 ms, which made Postgres look twice as slow; as a median of three it takes 2,543 ms.
- **Every variant is re-minted, even when nothing it shows changed.** With K = 1 a variant that overrides the changed element ends up with identical content, and it still gets a new version. That new version cascades to its own children. This is the "lockstep re-versioning" Prior Art warns about. Here it costs a version per descendant rather than a mark per dependent.
- **Marks flood the inbox.** Each dirty override on each variant opens one `override_stale` mark and one query. With E = 20 and K = 10, one parent commit put 1,400 marks and 1,400 queries into the functional inbox at 1,000 variants, and 400 at 200 variants. No other reason appeared, because the measured families have no dependency edges into the variants. With edges, each rebased version also re-checks its inbound edges (cascade steps 1 to 3), so marks would grow further.
- **Memory is not a concern.** The runs used `--expose-gc`, so each baseline was taken after a collection. On Postgres the Node process's resident set grew by at most 4 MB during a storm, and stayed between 200 and 240 MB. On PGlite the resident set is 350 MB to 1.2 GB before a storm, mostly the WASM heap of this and earlier storms' databases, and grew by at most 190 MB. Resident-set growth is still an upper bound on what the storm itself needs, since collection can lag.

### Transactions are short, but the committer waits for the whole storm

- **A storm is not one transaction.** Each rebase writes in its own short transaction, for the version, elements and deltas, and then in a few more for review state, supersede, marks and queries. That makes about 3 transactions per rebase, plus 2 for each dirty override (a mark and its query): 3.2 to 7.7 per rebase in the grid's shapes of 10 or more variants, up to 10.7 in its trees of 3 to 5 variants, and 3,200 to 5,800 for its storms of 1,000 variants, the most at E = 20 and K = 10. In the median runs the longest was 4.5 to 30 ms on PGlite and 6 to 62 ms on Postgres, except for one PGlite outlier of 41 ms, in 100/10/50 × 1 × 1, whose runs spread from 1,369 to 2,248 ms, and one Postgres outlier of 93 ms, in the noisy 100/1/1 × 3 × 1. The busy Postgres grid runs that were rerun for the rows marked \* reached 147 and 217 ms. Transactions took 48% to 89% of the storm's wall time, all of it in those short bursts. So no lock is held across the storm, and no table or node is locked while it runs.
- **The parent's author is blocked for the whole storm.** `commit`, and through it `konjir_commit` over MCP, returns only after the last descendant is rebased: 11 to 12 s for 1,000 small variants, and 27 to 33 s for 1,000 variants of 100 elements. Those times are already near common HTTP client timeouts. A timeout would leave the client unsure whether the commit happened. The parent version is in fact committed before the first rebase starts.

### Other writers during a storm: no blocking, but two correctness bugs

`--probe` runs two writers in a loop while the parent commits, with E = 20, W = 50, D = 3 (150 variants) and with E = 100, W = 50, D = 5 (250 variants). One writer commits to a node outside the family. The other commits human edits to the variants, in reverse creation order. The cascade's child query has no order, so this makes it likely, but not certain, that edits land on variants still waiting for their rebase. `--races`, described under bug 1, is the deterministic version. The probe's timings vary widely between runs, partly because the variant writer triggers extra catch-up rebases inside the timed storm: a review of this PR measured 50.6 s for the second PGlite storm below. Its results, from one run each:

| Backend | Shape | Storm | Unrelated commit p50 / max, idle → during (ms) | Variant edit p50 / max, idle → during (ms) | Human edits committed / lost | Errors |
|---|---|---|---|---|---|---|
| PGlite | 150 variants, E = 20 | 5.8 s | 6 / 7 → 29 / 44 | 20 / 28 → 62 / 216 | 75 / **14** | none |
| PGlite | 250 variants, E = 100 | 18.2 s | 7 / 7 → 69 / 121 | 71 / 129 → 200 / 767 | 84 / **10** | none |
| Postgres | 150 variants, E = 20 | 2.3 s | 6 / 7 → 12 / 25 | 22 / 33 → 27 / 94 | 71 / **13** | 1 unique violation on a variant edit |
| Postgres | 250 variants, E = 100 | 15.5 s | 7 / 8 → 19 / 297 | 89 / 149 → 123 / 3,213 | 59 / 0 | **the storm's own commit failed**, leaving 2 variants behind; 1 variant edit failed |

An earlier Postgres probe run failed the storm's commit in both shapes, leaving 3 and 2 variants behind their parent, and lost 1 human edit.

- **Other writers aren't blocked.** On Postgres, an unrelated commit slowed from about 7 ms to 12 to 19 ms at the median, competing for the pool and the server. On PGlite, which is one connection, every statement queues behind the storm's statements one at a time. Unrelated commits there slowed four to ten times, to a median of 29 to 69 ms, but they kept going: 191 to 392 of them ran during each storm.
- **Bug 1: a commit can silently discard another commit's edit.** The probe found it as a stale rebase. A review of this PR traced it to a wider class of lost updates with one root cause, and `--races` reproduces each case deterministically. Races 1a, 1b and 2a (under bug 2) gave identical results on PGlite and Postgres. Race 2b, two concurrent human commits, differs by backend: on PGlite they collided every time (bug 2), and on Postgres one edit was more often lost silently:
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

1. **No depth or count limit is needed now.** The cost is linear and doesn't grow worse with depth: a parent commit takes about V × (6 + 0.25 × E) ms. Today's kolabs, Kolab's own included, have a handful of variants. At 50 variants a storm takes 0.5 to 1.5 s, and nothing is locked for longer than one rebase. A depth cap would protect nothing, since depth costs only by adding variants. A count cap would refuse legitimate work to hide a latency problem that has a better fix (item 3).
2. **Both bugs need the fix at any scale, and it is one fix.** One concurrent write is enough to trigger either bug, and a limit closes neither. Both have the same root cause:
   - **Drafts don't record their base**, the live version they were built from.
   - **The staleness check isn't atomic.** It runs before the review, and nothing stops the node moving on before the commit.

   The fix is a commit step serialized per node, for example under `select … from node where id = $1 for update`. In one transaction, that step:
   - records the draft's base
   - allocates `seq`
   - checks that the node's live version is still that base, and otherwise folds (if only Kolab's own rebases intervened) or rejects
   - then sets `committed`

   Rebases go through the same step, so a stale listed child fails the base check and is skipped. This closes 1a, 1b, the lost update between two people, and bug 2 together. A storm should also carry on past one variant's failure, marking that variant rather than stranding the rest. This is now work package **W1.17**, outside this PR. `npm run rebase-storm -- --races` gives it its starting tests: each race prints `RACE` today and should print `SAFE` after the fix. The test for 1a should check the grandchild as well as the variant.
3. **When kolabs grow, rebase asynchronously and in batches, but only after W1.17.** The trigger is any node with more than about 100 descendants, which is about 1 s for small specs and 3 s at 100 elements. The parent's commit would return once the parent is committed, with the number of rebases queued. A worker would rebase level by level, one variant per transaction as today, and it would resume after a restart. This keeps the commit latency bounded, which no cap can do without refusing work. But asynchronous rebasing widens the race window: once the parent's commit returns early, everyone carries on editing while the worker runs, so concurrent edits during a storm become the normal case. So it depends on W1.17's serialized step, and the worker must build each rebase on the version that is live when it runs, never on a list taken earlier.
4. **Cheaper rebases, if the numbers ever matter.**
   - Insert a version's elements in one multi-row statement. That would cut the statements per rebase from about 55 + E to about 55, and save most of the cost at E = 100.
   - Skip re-minting a variant whose materialized content and deltas are unchanged. It would only re-pin its base, and its children wouldn't be re-minted either. This answers Prior Art's lockstep warning directly.
   - Consider one mark and one query per variant per parent commit, listing its stale overrides, rather than one for each override. That would cut the inbox flood by up to a factor of the overlap (2 to 4 here).
   - The schema has no secondary indexes. The cost per rebase hadn't started to grow at 2,000 variants, so indexes are not needed yet. `invalidation(delta_id)`, `version(parent_version_id)` and `edge(target_version_id)` are the first to add if it does.

The CAS8 Today column can move from "not measured yet" to measured, with no limit set. The races found are W1.17's gap.

## How to rerun

```
npm run rebase-storm                            # the grid on PGlite, 3 runs per shape: about 22 minutes
npm run rebase-storm -- --postgres              # the grid on Postgres 18 in a container: about 26 minutes, needs Docker
npm run rebase-storm -- --races [--postgres]    # deterministic reproductions of the races, in seconds; all SAFE since W1.17
npm run rebase-storm -- --probe [--postgres]    # other writers during a storm
npm run rebase-storm -- --E 100 --W 50 --D 3 --B 1 --K 10 --F 0.2   # one shape
npm run rebase-storm -- --repeat 1 --budget 30000   # one run per shape; stop a series once a storm takes over 30 s
```

Before measuring, each run does one throwaway warm-up storm. Each storm prints a JSON line as it finishes, and the run prints a table at the end. The npm scripts pass `--output-style=stream` to Nx, so `npm run rebase-storm > out.txt` captures everything. Without it, Nx drops a task's output when stdout isn't a terminal. They also run Node with `--expose-gc`, so the memory baseline is taken after a collection. Running the script some other way, without that flag, makes the growth figures upper bounds. `--postgres` starts its own container and stops it when the run ends.

## The full grid

F = 0.2 throughout. "ms" is the parent's commit call, which includes every rebase, as the median of three runs; the runs columns give each run's time in ms. The longest transaction is shown in ms, from the median run. Rows marked \* were rerun alone, five times, after their grid runs were all slow while the machine was busy.

| E | K | W × D × B | V | Rebased per depth | PGlite ms (per rebase) | Postgres ms (per rebase) | PGlite runs | Postgres runs | Statements per rebase | Transactions per rebase | Longest tx, PGlite / Postgres | Marks = queries |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20 | 1 | 1 × 1 × 1 | 1 | 1 | 21 (21.4) | 26 (26) | 21/22/21 | 24/26/33 | 116 | 8 | 4.9 / 5.9 | 1 |
| 20 | 1 | 10 × 1 × 1 | 10 | 10 | 93 (9.3) | 120 (12) | 92/94/93 | 151/120/113 | 60 | 3.5 | 4.5 / 6.6 | 1 |
| 20 | 1 | 50 × 1 × 1 | 50 | 50 | 423 (8.5) | 484 (9.7) | 426/423/418 | 496/469/484 | 57 | 3.4 | 5.4 / 6 | 9 |
| 20 | 1 | 200 × 1 × 1 | 200 | 200 | 1,667 (8.3) | 1,860 (9.3) | 1681/1667/1662 | 1867/1860/1851 | 56 | 3.4 | 4.8 / 6.7 | 40 |
| 20 | 1 | 1 × 3 × 1 | 3 | 1/1/1 | 37 (12.4) | 44 (14.8) | 37/40/37 | 44/41/55 | 75 | 4.7 | 5 / 5.6 | 1 |
| 20 | 1 | 10 × 3 × 1 | 30 | 10/10/10 | 268 (8.9) | 286 (9.5) | 261/271/268 | 300/283/286 | 57 | 3.4 | 4.8 / 6.4 | 5 |
| 20 | 1 | 50 × 3 × 1 | 150 | 50/50/50 | 1,255 (8.4) | 1,410 (9.4) | 1290/1254/1255 | 1410/1410/1439 | 56 | 3.4 | 4.7 / 7.1 | 29 |
| 20 | 1 | 200 × 3 × 1 | 600 | 200/200/200 | 5,168 (8.6) | 5,745 (9.6) | 5168/5186/5165 | 5745/5736/7280 | 56 | 3.4 | 11.7 / 7.5 | 120 |
| 20 | 1 | 1 × 5 × 1 | 5 | 1/1/1/1/1 | 53 (10.6) | 99 (19.8) | 53/53/55 | 80/99/100 | 66 | 4 | 5.1 / 9.2 | 1 |
| 20 | 1 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 411 (8.2) | 496 (9.9)\* | 429/409/411 | 528/523/490/496/485\* (grid: 1485/1618/1746) | 56 | 3.3 | 4.6 / 7.6 | 7 |
| 20 | 1 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 2,372 (9.5) | 2,364 (9.5) | 2038/2372/2587 | 2463/2364/2362 | 55 | 3.3 | 11.7 / 9 | 37 |
| 20 | 1 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 9,624 (9.6) | 10,495 (10.5) | 9286/9624/14186 | 12435/10263/10495 | 55 | 3.3 | 14.8 / 13.8 | 150 |
| 20 | 10 | 1 × 1 × 1 | 1 | 1 | 32 (32.2) | 38 (37.8) | 119/32/29 | 38/33/44 | 149 | 14 | 8.9 / 8.7 | 4 |
| 20 | 10 | 10 × 1 × 1 | 10 | 10 | 140 (14) | 151 (15.1) | 145/140/136 | 169/151/142 | 78 | 7.7 | 8 / 9.5 | 22 |
| 20 | 10 | 50 × 1 × 1 | 50 | 50 | 724 (14.5) | 647 (12.9) | 617/724/835 | 631/661/647 | 72 | 7.1 | 17 / 9.6 | 102 |
| 20 | 10 | 200 × 1 × 1 | 200 | 200 | 2,205 (11) | 2,543 (12.7) | 2298/2205/2185 | 2660/2528/2543 | 70 | 7 | 7.4 / 9.9 | 400 |
| 20 | 10 | 1 × 3 × 1 | 3 | 1/1/1 | 48 (15.9) | 59 (19.8) | 48/48/47 | 54/59/64 | 94 | 8.7 | 7.1 / 9.3 | 7 |
| 20 | 10 | 10 × 3 × 1 | 30 | 10/10/10 | 331 (11) | 398 (13.3) | 331/326/333 | 407/398/394 | 73 | 7.2 | 7 / 9.3 | 62 |
| 20 | 10 | 50 × 3 × 1 | 150 | 50/50/50 | 1,643 (11) | 1,928 (12.9) | 1578/1663/1643 | 1928/1894/1929 | 71 | 7 | 6.6 / 9.8 | 302 |
| 20 | 10 | 200 × 3 × 1 | 600 | 200/200/200 | 6,926 (11.5) | 7,762 (12.9) | 6609/6926/9269 | 7762/8387/7693 | 70 | 7 | 8.9 / 9.9 | 1,200 |
| 20 | 10 | 1 × 5 × 1 | 5 | 1/1/1/1/1 | 72 (14.4) | 76 (15.2) | 72/72/74 | 75/76/80 | 79 | 6.8 | 9 / 9.3 | 8 |
| 20 | 10 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 526 (10.5) | 590 (11.8) | 548/526/520 | 590/588/595 | 66 | 5.9 | 6.9 / 9.8 | 70 |
| 20 | 10 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 2,613 (10.5) | 2,882 (11.5) | 2558/2613/2847 | 2964/2820/2882 | 65 | 5.8 | 6.8 / 9.6 | 350 |
| 20 | 10 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 11,202 (11.2) | 12,239 (12.2) | 13055/11202/10966 | 12165/12239/12258 | 65 | 5.8 | 10.4 / 11.2 | 1,400 |
| 100 | 1 | 1 × 1 × 1 | 1 | 1 | 49 (48.5) | 65 (65.3) | 47/52/49 | 65/64/74 | 292 | 8 | 19.5 / 28.4 | 1 |
| 100 | 1 | 10 × 1 × 1 | 10 | 10 | 226 (22.6) | 292 (29.2) | 224/226/257 | 292/293/292 | 164 | 3.5 | 18.7 / 25.1 | 1 |
| 100 | 1 | 50 × 1 × 1 | 50 | 50 | 1,111 (22.2) | 1,347 (26.9) | 1243/1111/1053 | 1459/1344/1347 | 154 | 3.4 | 19.9 / 32.8 | 9 |
| 100 | 1 | 200 × 1 × 1 | 200 | 200 | 4,222 (21.1) | 5,636 (28.2)\* | 4252/4222/4218 | 5728/5471/5423/5702/5636\* (grid: 5436/14179/7952) | 152 | 3.4 | 18.9 / 34.1 | 40 |
| 100 | 1 | 1 × 3 × 1 | 3 | 1/1/1 | 87 (29.1) | 289 (96.3) | 87/91/87 | 265/519/289 | 197 | 4.7 | 18.7 / 93.3 | 1 |
| 100 | 1 | 10 × 3 × 1 | 30 | 10/10/10 | 626 (20.9) | 891 (29.7)\* | 626/656/621 | 1012/891/876/917/862\* (grid: 1278/994/800) | 156 | 3.4 | 18.7 / 32.2 | 4 |
| 100 | 1 | 50 × 3 × 1 | 150 | 50/50/50 | 3,126 (20.8) | 3,908 (26.1) | 3832/3126/3115 | 3892/3933/3908 | 152 | 3.2 | 21.9 / 30 | 17 |
| 100 | 1 | 200 × 3 × 1 | 600 | 200/200/200 | 13,933 (23.2) | 16,661 (27.8) | 14335/13465/13933 | 16617/16661/16784 | 151 | 3.2 | 26.1 / 52.3 | 68 |
| 100 | 1 | 1 × 5 × 1 | 5 | 1/1/1/1/1 | 128 (25.6) | 161 (32.2) | 138/126/128 | 161/154/167 | 178 | 4 | 19 / 28.8 | 1 |
| 100 | 1 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 1,034 (20.7) | 1,311 (26.2) | 1135/1034/1029 | 1320/1311/1307 | 153 | 3.2 | 19.4 / 28 | 4 |
| 100 | 1 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 5,738 (23) | 6,586 (26.3) | 5232/6526/5738 | 6586/6651/6536 | 151 | 3.2 | 30.2 / 36.7 | 24 |
| 100 | 1 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 24,368 (24.4) | 29,336 (29.3) | 24422/24145/24368 | 29336/29161/31070 | 151 | 3.2 | 19.8 / 56.9 | 100 |
| 100 | 10 | 1 × 1 × 1 | 1 | 1 | 62 (61.8) | 88 (87.5) | 61/62/66 | 84/88/97 | 373 | 26 | 21.3 / 30.3 | 10 |
| 100 | 10 | 10 × 1 × 1 | 10 | 10 | 286 (28.6) | 324 (32.4) | 263/286/353 | 341/324/324 | 175 | 5.9 | 22.9 / 32 | 13 |
| 100 | 10 | 50 × 1 × 1 | 50 | 50 | 1,471 (29.4) | 1,474 (29.5) | 2248/1369/1471 | 1455/1487/1474 | 169 | 7 | 41.2 / 34 | 98 |
| 100 | 10 | 200 × 1 × 1 | 200 | 200 | 4,904 (24.5) | 6,086 (30.4) | 4896/4930/4904 | 6066/6210/6086 | 167 | 7 | 25.7 / 37.2 | 400 |
| 100 | 10 | 1 × 3 × 1 | 3 | 1/1/1 | 104 (34.5) | 129 (43.1) | 105/104/102 | 133/129/128 | 224 | 10.7 | 20.7 / 29.7 | 10 |
| 100 | 10 | 10 × 3 × 1 | 30 | 10/10/10 | 674 (22.5) | 893 (29.8) | 678/674/672 | 853/893/898 | 165 | 5.6 | 20.8 / 30.8 | 37 |
| 100 | 10 | 50 × 3 × 1 | 150 | 50/50/50 | 3,464 (23.1) | 4,334 (28.9) | 3353/3465/3464 | 4316/4560/4334 | 160 | 5.2 | 22.2 / 62.1 | 167 |
| 100 | 10 | 200 × 3 × 1 | 600 | 200/200/200 | 14,592 (24.3) | 18,563 (30.9) | 14592/17527/14486 | 18563/18176/19398 | 159 | 5.3 | 24.7 / 58.2 | 680 |
| 100 | 10 | 1 × 5 × 1 | 5 | 1/1/1/1/1 | 152 (30.5) | 217 (43.4) | 152/153/144 | 226/217/199 | 195 | 7.6 | 23.1 / 33.9 | 10 |
| 100 | 10 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 1,316 (26.3) | 1,416 (28.3) | 1083/1316/1577 | 1419/1408/1416 | 160 | 4.9 | 24.4 / 34.5 | 45 |
| 100 | 10 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 5,635 (22.5) | 7,417 (29.7) | 6257/5561/5635 | 7417/7478/7195 | 158 | 4.9 | 22.6 / 35 | 237 |
| 100 | 10 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 27,135 (27.1) | 32,964 (33) | 27135/28528/25521 | 32964/32393/33452 | 158 | 4.9 | 23.5 / 53.9 | 960 |
| 20 | 10 | 1 × 5 × 2 | 31 | 1/2/4/8/16 | 291 (9.4) | 345 (11.1) | 289/294/291 | 353/345/340 | 63 | 4.9 | 6.8 / 9.2 | 28 |
| 20 | 10 | 4 × 5 × 2 | 124 | 4/8/16/32/64 | 1,192 (9.6) | 1,545 (12.5) | 1195/1180/1192 | 1474/1545/1588 | 63 | 5.3 | 6.6 / 12.3 | 139 |
| 20 | 10 | 16 × 5 × 2 | 496 | 16/32/64/128/256 | 4,951 (10) | 5,656 (11.4) | 4951/5406/4827 | 5924/5656/5450 | 63 | 5.2 | 7 / 10.9 | 550 |
| 100 | 10 | 1 × 5 × 2 | 31 | 1/2/4/8/16 | 676 (21.8) | 845 (27.2) | 687/676/662 | 845/831/848 | 157 | 3.7 | 20.8 / 36.6 | 10 |
| 100 | 10 | 4 × 5 × 2 | 124 | 4/8/16/32/64 | 2,707 (21.8) | 3,550 (28.6) | 2713/2707/2704 | 3577/3400/3550 | 159 | 5 | 20.6 / 34.9 | 123 |
| 100 | 10 | 16 × 5 × 2 | 496 | 16/32/64/128/256 | 11,492 (23.2) | 14,957 (30.2) | 13464/11492/11413 | 15040/14957/14452 | 158 | 4.9 | 25 / 38.6 | 466 |

With a single variant, the counts per rebase include the parent's own commit.
