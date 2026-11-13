# Step 80 — What a failed put may leave behind (N70)

Branch: `docs/80-failed-write-row` · Reviewer: GPT-6.1 Sol (high) · Rounds: pending · Status: pending · Verdict after triage: pending

## Scope

Architecture §4.3 (allocation failure) said that each step of a `put` "either completes or changes nothing" and that "the batch goes in one run of points at a time (a run is a stretch of the batch that shares a segment)". That did not fix the order of the runs, what exactly a run is, or how a put's own watermark divides them, so the set of states a put may leave behind after failing part-way could not be written down. Step 74's fault tests need that set. The user decided (decision 42, option A, 2026-11-13) to record the reading the library already implements as a decision. This step is documentation only: no code or test changes.

| Commit (by subject)                                     | What                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs(decisions): n70, what a failed put leaves behind` | `docs/decisions/N70-failed-put-runs.md`; its index line in architecture §8, the §8 heading's last date and a sentence in the §8 introduction; §4.3 (heading and the allocation-failure rule) says what a run is, that runs go in ascending slot order, and how a put's own watermark splits them, and links N70; `docs/INDEX.md` counts N70 and the new file. |
| `docs(review): step 80 scope and verification`          | This file, and the review-file count and size and its own size in `docs/INDEX.md`.                                                                                                                                                                                                                                                                            |

**The decision.** After a put fails part-way, the runs it applied are an ascending prefix of its runs, each applied whole, and nothing of the rest is applied:

1. **Order.** Runs are applied in ascending slot order.
2. **What a run is.** A maximal stretch of consecutive batch points, each on the same page as the one before it with at most K slots between them, counting no stored point between them. It is not "the batch points that share a segment after the put".
3. **A put's own watermark.** Final and provisional points are written in two passes, so a stretch that crosses the put's own `finalizedUntil` slot is two runs, the lower one first.
4. **Atomic runs.** Each run applies completely or not at all.

N70 follows the shape of the decision files of step 73: a title line, one sentence on where the row lives, a `## Resolution` heading and the resolution on one line, with its reason, rejected alternatives and the user's decision. Its index line in §8 is padded to the table's column widths, and its summary is the resolution's first clause.

## Verification

**Each point against the code** (`main` at d95b405; the branch changes no code):

| Point              | Where the code does it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Ascending order | `packages/tscache/src/engine/merge.ts:124-137`: `#insertChunks` walks the batch's slots from index 0 upward and inserts each run as it closes, so run _n_ is written before run _n_ + 1. The slots are strictly ascending: `validateBatch` rejects a duplicate or descending timestamp (`engine/batch.ts:148`), and `assertPoints` throws before anything changes on any other caller (`segment/assert.ts:35-36`). In `put` (`merge.ts:105-121`) the replace step, `#carve`, runs before the first run; the re-split of a carved segment runs in `finally` after the runs, also after a failure.                    |
| 2. What a run is   | `merge.ts:194-196`: `#together(a, b)` is `b - a - 1 <= K && page(a) === page(b)` on two consecutive batch slots only; the store is not consulted. The doc comment says so: "Stored points between them can only narrow the gap." Stored segments within K slots of a run are joined to it by `#insert` (`merge.ts:238-261`), but they never decide where one run ends.                                                                                                                                                                                                                                              |
| 3. Own watermark   | `packages/tscache/src/engine/cache.ts:523-553`: with a watermark slot `limit`, `#write` splits the batch with `splitAt` (`cache.ts:107-111`) into the points below `limit` and the rest, and calls `SegmentStore.put` twice: first the final part with the authority clipped below `limit` (`cache.ts:530-533`), then the provisional part with no authority (`cache.ts:535`). Each call cuts its own runs, so a stretch that crosses `limit` becomes the last run of the first call and the first run of the second. Only the overlap warnings are rejoined across the split (`cache.ts:536-550`), not the writes. |
| 4. Atomic runs     | `merge.ts:238-261`: a run that touches no stored segment is merged into a new segment, which is spliced in only after the merge succeeds; a run that touches one stored segment is one `mergeFrom` on it; a run that touches several goes through `#join` (`merge.ts:270-290`), which gathers the others and the run in a scratch segment and then changes the stored target in a single `mergeFrom`, editing the list only after it. `DenseSegment.mergeFrom` allocates before its first mutation, so a failed merge changes nothing (`segment/dense.ts:211-236`, the comment at lines 228-229; §4.2, "Atomic").   |

On failure the engine subtracts coverage over the put's whole range, provisional slots included (`cache.ts:491-517`, `touched` at `cache.ts:293`), so whichever prefix was applied is refetched before it is trusted. The code agrees with all four points; nothing was stopped.

**The probe.** The brief reports a probe on step 74's branch that injected 9,898 failures, each at a different point of the write after validation, and always found the library in this state; under "one run across the put's own watermark" 11 failures leave a run half applied, and under runs counted with stored points 76 more. It was not rerun here, as the brief allows. Existing tests that pin parts of the reading: `packages/tscache/test/merge-failures.test.ts` (a failed join changes nothing) and `packages/tscache/test/cache-failures.test.ts`.

**Other documents.** Searched the tracked files outside `docs/reviews/` and `docs/history/` for "changes nothing", "run of points", "shares a segment", "half done" and allocation failures. Only §4.3 described the runs of a failed put. The site pages (`site/concepts/segments.md`, `site/how-it-works/data-model.md`, `site/how-it-works/code-tour.md`) describe the layout, which N70 does not change. §4.5 ("Order inside `put`") still says that the coverage the put would have recorded is subtracted; see below.

**Sizes in `docs/INDEX.md`.** Re-measured only the rows whose documents this step changes: `docs/architecture.md` 241.5 KB, `docs/decisions/` 84.1 KB (78 files), `docs/reviews/` 2,021.3 KB (78 files, this one included) and `docs/INDEX.md` 18.2 KB (listed as 13.3 KB, a drift from step 73).

**The gate.** `~/code/tscache-reports/bin/heavy-run.sh "80 child: ci" bun run ci` exits 0 on the branch head.

## Contradictions found

1. §4.5, "Order inside `put`", said that when `store.put` throws "the coverage the put would have recorded is subtracted". The engine subtracts more: the whole range the put touched, provisional slots included (`cache.ts:487-503`, whose comment says so). Fixed after the pre-review: §4.5 now says so.
2. Left as they are, because this step changes no code (decision 42 A: documentation only), and queued for a later code step: the comment on `#insertChunks` (`merge.ts:123`) calls a chunk "a run that shares a segment", and the comment at `merge.ts:233-235` says every stored segment within K slots belongs to the same run. The code implements N70's write run; only the comments use the older wording.

## Pre-review (Claude), not the gate

Before Codex round 1, a fresh-context Opus pre-review checked N70 against `merge.ts`, `cache.ts` and `dense.ts` with three scratch tests (a failure in run 2 keeps run 1 and drops run 3; a stored point between two batch points does not join them; a page boundary splits a run), all passing, and found:

1. (P1) N70 states behaviour no test in the repository checks (the order of write runs and where they split). Not fixed here, by the user's decision: decision 42 A makes this step documentation only, and step 74's round 3 builds its set-based fault check against N70. The probe's wording ("9,898 points") read as data points; it now says 9,898 injected failures.
2. (P2) N70 cited §4.5, which described a narrower withdrawal than the code performs. Fixed (Contradictions found, item 1).
3. (P2) Source comments in `merge.ts` still define a run the way N70 rejects. Recorded under Contradictions found, item 2; no code changes in this step.
4. (P2) "Run" meant two things in §4.3 (the overlap warning's run of differing points and the write run). Fixed: §4.3 and N70 say "write run" and tell the two apart.
5. (nit) §4.3 suggested `SegmentStore.put` takes a watermark. Fixed: the engine writes such a put as two `SegmentStore.put` calls.

Fixed in `docs: step 80 pre-review fixes`.

## Decision concerns

None.
