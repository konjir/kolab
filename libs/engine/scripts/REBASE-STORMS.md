# Rebase storms (W2.7, CAS8)

What one parent commit costs when many variants inherit from it, measured on 16 October 2026 at commit `e38d9f2` with [`rebase-storm.ts`](rebase-storm.ts). This file records the numbers and a recommendation. The limit, if any, is Lee's ruling. The engine wasn't changed.

## What was measured

A parent spec `P` has E elements. W variant trees hang under it, each D levels deep with B children per variant per level, so there are V = W × (1 + B + … + B^(D−1)) variants. Each variant overrides 20% of the elements (F = 0.2), a different window each. `P` then commits a version that changes its first K elements, and the script times that one `commit` call. That call returns only when every variant has been rebased (OVR3), each rebase passing the structural gate (OVR10, VER12) and the three-way rule (CAS5).

For each storm the script counts:

- the versions rebased, in all and per depth
- the wall time of the parent's commit
- the marks raised by reason, and the queries raised
- the SQL statements and transactions run, and the longest transaction
- the peak resident memory of the Node process

It ran on PGlite in process, and on Postgres 18 (`postgres:18-alpine` in Docker 28.4, through Testcontainers, as a non-superuser like the RDS master user), on an Apple M3 Max with 14 cores and 36 GB. A probe mode also runs other writers during a storm.

The grid is E ∈ {20, 100}, K ∈ {1, 10}, D ∈ {1, 3, 5} and W ∈ {1, 10, 50, 200} with B = 1, plus branching trees with B = 2 and D = 5. That makes 54 storms per backend, up to 1,000 variants. One extra PGlite storm used 2,000 variants. No storm went over the 60 s budget. The grid stops at 1,000 variants because building the families takes as long as the storms do: the grid took 7.4 minutes on PGlite and 8.9 on Postgres.

## Results

### Cost is linear in the number of variants, at about 10 to 30 ms each

With K = 10, so each run commits ten changed elements:

| E | W × D × B | Variants | Rebased, per depth | PGlite ms (ms per rebase) | Postgres ms (ms per rebase) | Statements per rebase | Longest transaction, PGlite / Postgres (ms) | Marks (all `override_stale`) = queries |
|---|---|---|---|---|---|---|---|---|
| 20 | 10 × 1 × 1 | 10 | 10 | 122 (12.2) | 168 (16.8) | 78 | 5.5 / 8.4 | 22 |
| 20 | 200 × 1 × 1 | 200 | 200 | 2,163 (10.8) | 4,311 (21.6) | 70 | 5.5 / 46 | 400 |
| 20 | 10 × 5 × 1 | 50 | 10/10/10/10/10 | 543 (10.9) | 601 (12.0) | 66 | 6.2 / 6.9 | 70 |
| 20 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 2,609 (10.4) | 2,877 (11.5) | 65 | 6.3 / 6.2 | 350 |
| 20 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 11,475 (11.5) | 12,981 (13.0) | 65 | 12 / 16.9 | 1,400 |
| 20 | 16 × 5 × 2 | 496 | 16/32/64/128/256 | 7,078 (14.3) | 5,728 (11.5) | 63 | 71 / 6.3 | 550 |
| 100 | 10 × 1 × 1 | 10 | 10 | 280 (28.0) | 286 (28.6) | 175 | 25.6 / 25.8 | 13 |
| 100 | 200 × 1 × 1 | 200 | 200 | 4,895 (24.5) | 6,194 (31.0) | 167 | 24 / 31.2 | 400 |
| 100 | 50 × 3 × 1 | 150 | 50/50/50 | 3,538 (23.6) | 4,610 (30.7) | 160 | 22.9 / 37.8 | 167 |
| 100 | 200 × 3 × 1 | 600 | 200/200/200 | 18,034 (30.1) | 18,757 (31.3) | 159 | 146 / 44.8 | 680 |
| 100 | 50 × 5 × 1 | 250 | 50/50/50/50/50 | 6,088 (24.4) | 7,598 (30.4) | 158 | 21 / 27.9 | 237 |
| 100 | 200 × 5 × 1 | 1,000 | 200/200/200/200/200 | 27,040 (27.0) | 31,476 (31.5) | 158 | 22.1 / 44.5 | 960 |
| 100 | 16 × 5 × 2 | 496 | 16/32/64/128/256 | 11,843 (23.9) | 14,171 (28.6) | 158 | 25.2 / 31 | 466 |

Every variant was rebased exactly once, and every rebase committed. Marks and queries were identical on both backends. [The full grid](#the-full-grid) is at the end of this file.

- **Time is linear in V, the total number of variants, and depth only matters as a multiplier of V.** The cost per rebase stays flat from 10 variants to 1,000. With E = 20 it's 9 to 13 ms per rebase. The extra PGlite storm with 2,000 variants (E = 20, W = 400, D = 5, K = 1) took 20.8 s, or 10.4 ms per rebase. Ten roots five deep cost the same as fifty roots one deep. A deep chain is no worse per variant than a wide fan, and a branching tree (B = 2) costs the same per variant as chains. To a good approximation, the parent's commit takes V × (6 + 0.25 × E) ms.
- **Element count drives the cost per rebase.** A rebase runs about 55 + E statements, because `writeVersion` inserts every materialized element one row at a time, whether or not it changed. Going from 20 to 100 elements raises the cost from about 11 ms to about 28 ms per rebase. K changes it only a little: about 10 more statements per rebase, for the marks and queries.
- **Every variant is re-minted, even when nothing it shows changed.** With K = 1 a variant that overrides the changed element ends up with identical content, and it still gets a new version. That new version cascades to its own children. This is the "lockstep re-versioning" Prior Art warns about. Here it costs a version per descendant rather than a mark per dependent.
- **Marks flood the inbox.** Each dirty override on each variant opens one `override_stale` mark and one query. With E = 20 and K = 10, one parent commit put 1,400 marks and 1,400 queries into the functional inbox at 1,000 variants, and 400 at 200 variants. No other reason appeared, because the measured families have no dependency edges into the variants. With edges, each rebased version also re-checks its inbound edges (cascade steps 1 to 3), so marks would grow further.
- **Memory is not a concern.** On Postgres the Node process's resident set grew by at most 38 MB during a storm, and stayed between 100 and 330 MB. On PGlite the resident set is about 1 GB before any storm, mostly the WASM heap, and grew by at most 193 MB.
- **The Postgres warm-up rows aren't representative.** The first three Postgres storms, 1 to 50 variants with E = 20 and K = 1, ran at 33 to 1,061 ms per rebase while the container and pool warmed up. One storm, 1,000 variants with E = 20, D = 5 and K = 1, came in at 25.4 ms per rebase. Rerun alone, it took 13.2 ms per rebase, in line with the rest.

### Transactions are short, but the committer waits for the whole storm

- **A storm is not one transaction.** Each rebase writes in its own short transaction, for the version, elements and deltas, and then in a few more for review state, supersede, marks and queries. That makes 3 to 6 transactions per rebase: 4,923 for the largest storm. The longest was typically 5 to 45 ms. There were a few outliers between 70 and 470 ms, under GC or I/O pressure. Transactions took 48% to 83% of the storm's wall time, all of it in those short bursts. So no lock is held across the storm, and no table or node is locked while it runs.
- **The parent's author is blocked for the whole storm.** `commit`, and through it `konjir_commit` over MCP, returns only after the last descendant is rebased: 12 s for 1,000 small variants, and 31 s for 1,000 variants of 100 elements. Those times are already near common HTTP client timeouts. A timeout would leave the client unsure whether the commit happened. The parent version is in fact committed before the first rebase starts.

### Other writers during a storm: no blocking, but two correctness bugs

`--probe` runs two writers in a loop while the parent commits, with E = 20, W = 50, D = 3 (150 variants) and with E = 100, W = 50, D = 5 (250 variants). One writer commits to a node outside the family. The other commits human edits to the variants, starting with the last to be rebased:

| Backend | Shape | Storm | Unrelated commit p50 / max, idle → during (ms) | Variant edit p50 / max, idle → during (ms) | Human edits committed / lost | Errors |
|---|---|---|---|---|---|---|
| PGlite | 150 variants, E = 20 | 5.8 s | 6 / 7 → 29 / 44 | 20 / 28 → 62 / 216 | 75 / **14** | none |
| PGlite | 250 variants, E = 100 | 18.2 s | 7 / 7 → 69 / 121 | 71 / 129 → 200 / 767 | 84 / **10** | none |
| Postgres | 150 variants, E = 20 | 2.3 s | 6 / 7 → 12 / 25 | 22 / 33 → 27 / 94 | 71 / **13** | 1 unique violation on a variant edit |
| Postgres | 250 variants, E = 100 | 15.5 s | 7 / 8 → 19 / 297 | 89 / 149 → 123 / 3,213 | 59 / 0 | **the storm's own commit failed**, leaving 2 variants behind; 1 variant edit failed |

An earlier Postgres probe run failed the storm's commit in both shapes, leaving 3 and 2 variants behind their parent, and lost 1 human edit.

- **Other writers aren't blocked.** On Postgres, an unrelated commit slowed from about 7 ms to 12 to 19 ms at the median, competing for the pool and the server. On PGlite, which is one connection, every statement queues behind the storm's statements one at a time. Unrelated commits there slowed four to ten times, to a median of 29 to 69 ms, but they kept going: 191 to 392 of them ran during each storm.
- **Bug 1: a rebase can silently discard a human edit.** Cascade step 4 lists the variant versions to rebase once, then rebases them one by one, depth first. If a person commits to a variant after that list was taken but before its turn, the person's version commits, and the catch-up in step 5 rebases it correctly. Then the storm rebases the old version it listed, which no longer includes the person's edit. That rebase commits with a higher sequence number and becomes the live version. The person's edit drops out of the variant with no mark, no query and no error. It happened in four of the six probe runs, on both backends. A deterministic reproduction, which commits a human edit to `V1` just before its rebase runs, ends with these versions of `V1`:

  ```
  seq 1  product  the variant as created
  seq 2  product  the human edit, adding element H
  seq 3  system   the catch-up rebase of seq 2 (has H)
  seq 4  system   the storm's rebase of seq 1 (no H), now live
  ```

  The longer the storm, the wider the window. With 1,000 variants, the last root is rebased about 30 s after the list was taken.
- **Bug 2: concurrent writes to one node race on its sequence number.** `nextSeq` reads `max(seq) + 1` outside the transaction that inserts the version. On Postgres, a rebase and a human commit to the same variant can pick the same number, and one of them fails on `version_node_id_seq_key`. If the rebase loses, the exception escapes the parent's `commit`. The parent version stays committed, but every variant not yet rebased stays on the old parent, with no mark. Its author sees an error for a commit that happened. Kolab rebases those variants only when the parent commits again.

## Recommendation

**No cap on inheritance depth or variant count yet. Fix the two races first, and plan to move rebasing off the commit call before any kolab has more than about 100 descendants under one node.** Lee to rule.

1. **No depth or count limit is needed now.** The cost is linear and doesn't grow worse with depth: a parent commit takes about V × (6 + 0.25 × E) ms. Today's kolabs, Kolab's own included, have a handful of variants. At 50 variants a storm takes 0.5 to 1.5 s, and nothing is locked for longer than one rebase. A depth cap would protect nothing, since depth costs only by adding variants. A count cap would refuse legitimate work to hide a latency problem that has a better fix (item 3).
2. **The two races need fixing at any scale.** One concurrent write is enough to trigger either of them. Neither is a reason for a limit, since a limit doesn't close them. Proposed work, for the Plan and the engine:
   - In `rebase`, re-read the child's live version inside the writing transaction, and rebase that version. If the listed version is no longer live, skip it, because the catch-up has already handled the newer one.
   - Allocate `seq` inside the transaction that inserts the version, serialized per node, for example with `select … for update` on the node row or a per-node advisory lock. Also retry or carry on past one variant's failure, so a single variant can't abort the rest of the storm. A variant whose rebase fails should get a mark rather than be left behind silently.
3. **When kolabs grow, rebase asynchronously and in batches.** The trigger is any node with more than about 100 descendants, which is about 1 s for small specs and 3 s at 100 elements. The parent's commit would return once the parent is committed, with the number of rebases queued. A worker would rebase level by level, one variant per transaction as today, and it would resume after a restart. This keeps the commit latency bounded, which no cap can do without refusing work, and it narrows the window for bug 1 once that is fixed.
4. **Cheaper rebases, if the numbers ever matter.**
   - Insert a version's elements in one multi-row statement. That would cut the statements per rebase from about 55 + E to about 55, and save most of the cost at E = 100.
   - Skip re-minting a variant whose materialized content and deltas are unchanged. It would only re-pin its base, and its children wouldn't be re-minted either. This answers Prior Art's lockstep warning directly.
   - Consider one mark and one query per variant per parent commit, listing its stale overrides, rather than one for each override. That would cut the inbox flood by up to a factor of the overlap (2 to 4 here).
   - The schema has no secondary indexes. The cost per rebase hadn't started to grow at 2,000 variants, so indexes are not needed yet. `invalidation(delta_id)`, `version(parent_version_id)` and `edge(target_version_id)` are the first to add if it does.

The CAS8 Today column can move from "not measured yet" to measured, with no limit set, and with bugs 1 and 2 as gaps found.

## How to rerun

```
npm run rebase-storm                            # the grid on PGlite: about 7 minutes
npm run rebase-storm -- --postgres              # the grid on Postgres 18 in a container: about 9 minutes, needs Docker
npm run rebase-storm -- --probe [--postgres]    # other writers during a storm
npm run rebase-storm -- --E 100 --W 50 --D 3 --B 1 --K 10 --F 0.2   # one shape
npm run rebase-storm -- --budget 30000          # stop each series once a storm takes over 30 s
```

Nx buffers a task's output when stdout isn't a terminal. To see it live in a pipe, run the script directly: `cd libs/engine && npx tsx --conditions=@konjir/source scripts/rebase-storm.ts …`. Each storm prints a JSON line as it finishes, and a table at the end. `--postgres` starts its own container and stops it when the run ends.

## The full grid

F = 0.2 throughout. "ms" is the parent's commit call, which includes every rebase. The longest transaction is shown in ms.

| E | K | W × D × B | V | Rebased (per depth) | PGlite ms (per rebase) | Postgres ms (per rebase) | Statements per rebase | Longest tx, PGlite / Postgres | Marks = queries |
|---|---|---|---|---|---|---|---|---|---|
| 20 | 1 | 1 × 1 × 1 | 1 | 1 (1) | 27 (27.1) | 1,061 (1061.4) | 116 | 6.4 / 197.6 | 1 |
| 20 | 1 | 10 × 1 × 1 | 10 | 10 (10) | 107 (10.7) | 2,098 (209.8) | 60 | 5.3 / 116.5 | 1 |
| 20 | 1 | 50 × 1 × 1 | 50 | 50 (50) | 447 (8.9) | 1,645 (32.9) | 57 | 4.5 / 38.4 | 9 |
| 20 | 1 | 200 × 1 × 1 | 200 | 200 (200) | 1,742 (8.7) | 2,505 (12.5) | 56 | 4.3 / 22.4 | 40 |
| 20 | 1 | 1 × 3 × 1 | 3 | 3 (1/1/1) | 41 (13.8) | 42 (13.9) | 75 | 5 / 5.5 | 1 |
| 20 | 1 | 10 × 3 × 1 | 30 | 30 (10/10/10) | 254 (8.5) | 318 (10.6) | 57 | 3.9 / 5.5 | 5 |
| 20 | 1 | 50 × 3 × 1 | 150 | 150 (50/50/50) | 1,300 (8.7) | 1,506 (10) | 56 | 4.3 / 5.6 | 29 |
| 20 | 1 | 200 × 3 × 1 | 600 | 600 (200/200/200) | 5,381 (9) | 6,855 (11.4) | 56 | 10.7 / 22.7 | 120 |
| 20 | 1 | 1 × 5 × 1 | 5 | 5 (1/1/1/1/1) | 52 (10.5) | 62 (12.5) | 66 | 4 / 5.1 | 1 |
| 20 | 1 | 10 × 5 × 1 | 50 | 50 (10/10/10/10/10) | 426 (8.5) | 452 (9) | 56 | 3.9 / 4.7 | 7 |
| 20 | 1 | 50 × 5 × 1 | 250 | 250 (50/50/50/50/50) | 2,249 (9) | 2,294 (9.2) | 55 | 7.5 / 7 | 37 |
| 20 | 1 | 200 × 5 × 1 | 1000 | 1000 (200/200/200/200/200) | 9,069 (9.1) | 25,358 (25.4) | 55 | 13.9 / 327.4 | 150 |
| 20 | 10 | 1 × 1 × 1 | 1 | 1 (1) | 26 (26) | 40 (39.7) | 149 | 6 / 8 | 4 |
| 20 | 10 | 10 × 1 × 1 | 10 | 10 (10) | 122 (12.2) | 168 (16.8) | 78 | 5.5 / 8.4 | 22 |
| 20 | 10 | 50 × 1 × 1 | 50 | 50 (50) | 539 (10.8) | 1,246 (24.9) | 72 | 6.2 / 107 | 102 |
| 20 | 10 | 200 × 1 × 1 | 200 | 200 (200) | 2,163 (10.8) | 4,311 (21.6) | 70 | 5.5 / 46 | 400 |
| 20 | 10 | 1 × 3 × 1 | 3 | 3 (1/1/1) | 46 (15.4) | 56 (18.7) | 94 | 5.9 / 6.2 | 7 |
| 20 | 10 | 10 × 3 × 1 | 30 | 30 (10/10/10) | 331 (11) | 396 (13.2) | 73 | 5.5 / 6.4 | 62 |
| 20 | 10 | 50 × 3 × 1 | 150 | 150 (50/50/50) | 1,719 (11.5) | 1,930 (12.9) | 71 | 5.7 / 6.5 | 302 |
| 20 | 10 | 200 × 3 × 1 | 600 | 600 (200/200/200) | 7,007 (11.7) | 7,815 (13) | 70 | 11.8 / 16.8 | 1200 |
| 20 | 10 | 1 × 5 × 1 | 5 | 5 (1/1/1/1/1) | 66 (13.2) | 74 (14.9) | 79 | 6.2 / 7.5 | 8 |
| 20 | 10 | 10 × 5 × 1 | 50 | 50 (10/10/10/10/10) | 543 (10.9) | 601 (12) | 66 | 6.2 / 6.9 | 70 |
| 20 | 10 | 50 × 5 × 1 | 250 | 250 (50/50/50/50/50) | 2,609 (10.4) | 2,877 (11.5) | 65 | 6.3 / 6.2 | 350 |
| 20 | 10 | 200 × 5 × 1 | 1000 | 1000 (200/200/200/200/200) | 11,475 (11.5) | 12,981 (13) | 65 | 12 / 16.9 | 1400 |
| 100 | 1 | 1 × 1 × 1 | 1 | 1 (1) | 47 (47.2) | 58 (58) | 292 | 17.5 / 24.2 | 1 |
| 100 | 1 | 10 × 1 × 1 | 10 | 10 (10) | 245 (24.5) | 282 (28.2) | 164 | 17.4 / 26.3 | 1 |
| 100 | 1 | 50 × 1 × 1 | 50 | 50 (50) | 1,107 (22.1) | 1,291 (25.8) | 154 | 16.8 / 22.4 | 9 |
| 100 | 1 | 200 × 1 × 1 | 200 | 200 (200) | 4,431 (22.2) | 5,584 (27.9) | 152 | 22 / 38.4 | 40 |
| 100 | 1 | 1 × 3 × 1 | 3 | 3 (1/1/1) | 86 (28.7) | 108 (35.9) | 197 | 17 / 22.7 | 1 |
| 100 | 1 | 10 × 3 × 1 | 30 | 30 (10/10/10) | 641 (21.4) | 794 (26.5) | 156 | 16.5 / 22.8 | 4 |
| 100 | 1 | 50 × 3 × 1 | 150 | 150 (50/50/50) | 3,233 (21.6) | 4,819 (32.1) | 152 | 25.3 / 36.1 | 17 |
| 100 | 1 | 200 × 3 × 1 | 600 | 600 (200/200/200) | 14,384 (24) | 16,827 (28) | 151 | 19.4 / 31 | 68 |
| 100 | 1 | 1 × 5 × 1 | 5 | 5 (1/1/1/1/1) | 127 (25.3) | 162 (32.4) | 178 | 16.4 / 23.5 | 1 |
| 100 | 1 | 10 × 5 × 1 | 50 | 50 (10/10/10/10/10) | 1,055 (21.1) | 1,300 (26) | 153 | 16.7 / 26.5 | 4 |
| 100 | 1 | 50 × 5 × 1 | 250 | 250 (50/50/50/50/50) | 5,527 (22.1) | 7,406 (29.6) | 151 | 19.1 / 41 | 24 |
| 100 | 1 | 200 × 5 × 1 | 1000 | 1000 (200/200/200/200/200) | 35,062 (35.1) | 35,305 (35.3) | 151 | 471.5 / 61.3 | 100 |
| 100 | 10 | 1 × 1 × 1 | 1 | 1 (1) | 66 (66.3) | 79 (78.8) | 373 | 20.7 / 25 | 10 |
| 100 | 10 | 10 × 1 × 1 | 10 | 10 (10) | 280 (28) | 286 (28.6) | 175 | 25.6 / 25.8 | 13 |
| 100 | 10 | 50 × 1 × 1 | 50 | 50 (50) | 1,366 (27.3) | 1,467 (29.3) | 169 | 25.1 / 25.6 | 98 |
| 100 | 10 | 200 × 1 × 1 | 200 | 200 (200) | 4,895 (24.5) | 6,194 (31) | 167 | 24 / 31.2 | 400 |
| 100 | 10 | 1 × 3 × 1 | 3 | 3 (1/1/1) | 101 (33.8) | 120 (40.1) | 224 | 18.5 / 23.2 | 10 |
| 100 | 10 | 10 × 3 × 1 | 30 | 30 (10/10/10) | 681 (22.7) | 867 (28.9) | 165 | 18 / 28.1 | 37 |
| 100 | 10 | 50 × 3 × 1 | 150 | 150 (50/50/50) | 3,538 (23.6) | 4,610 (30.7) | 160 | 22.9 / 37.8 | 167 |
| 100 | 10 | 200 × 3 × 1 | 600 | 600 (200/200/200) | 18,034 (30.1) | 18,757 (31.3) | 159 | 146.2 / 44.8 | 680 |
| 100 | 10 | 1 × 5 × 1 | 5 | 5 (1/1/1/1/1) | 138 (27.5) | 175 (34.9) | 195 | 18.4 / 21.4 | 10 |
| 100 | 10 | 10 × 5 × 1 | 50 | 50 (10/10/10/10/10) | 1,096 (21.9) | 1,356 (27.1) | 160 | 18 / 24.1 | 45 |
| 100 | 10 | 50 × 5 × 1 | 250 | 250 (50/50/50/50/50) | 6,088 (24.4) | 7,598 (30.4) | 158 | 21 / 27.9 | 237 |
| 100 | 10 | 200 × 5 × 1 | 1000 | 1000 (200/200/200/200/200) | 27,040 (27) | 31,476 (31.5) | 158 | 22.1 / 44.5 | 960 |
| 20 | 10 | 1 × 5 × 2 | 31 | 31 (1/2/4/8/16) | 296 (9.5) | 339 (10.9) | 63 | 6.6 / 6.2 | 28 |
| 20 | 10 | 4 × 5 × 2 | 124 | 124 (4/8/16/32/64) | 1,286 (10.4) | 1,404 (11.3) | 63 | 6.3 / 6.6 | 139 |
| 20 | 10 | 16 × 5 × 2 | 496 | 496 (16/32/64/128/256) | 7,078 (14.3) | 5,728 (11.5) | 63 | 71 / 6.3 | 550 |
| 100 | 10 | 1 × 5 × 2 | 31 | 31 (1/2/4/8/16) | 856 (27.6) | 812 (26.2) | 157 | 30.8 / 23.5 | 10 |
| 100 | 10 | 4 × 5 × 2 | 124 | 124 (4/8/16/32/64) | 3,610 (29.1) | 3,405 (27.5) | 159 | 48.5 / 22.9 | 123 |
| 100 | 10 | 16 × 5 × 2 | 496 | 496 (16/32/64/128/256) | 11,843 (23.9) | 14,171 (28.6) | 158 | 25.2 / 31 | 466 |

With a single variant, the statements per rebase include the parent's own commit.
