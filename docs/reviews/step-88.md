# Step 88 — The cache property tests in smaller batches

Branch: `fix/88-property-test-batches` · Reviewer: none yet (the director runs the review) · Status: built, not reviewed

## Scope

Step 74 (#110) added `packages/tscache/test/cache-model-property.test.ts` and `cache-faults-property.test.ts`, each as eight batches of seeds. On the development machine under load, single batches crossed Vitest's 5 s default timeout: four in the round 4 CI run of step 65 (the whole Vitest run took 24 s instead of 4–7 s; one batch took 5.7 s against 0.3 s normally, another 9.5 s) and three in the first CI run of step 87. GitHub CI passes. `docs/testing.md` forbids raising timeouts, retries and timing assertions, so the fix is structural: the same work in more, shorter test cases, each with a wide margin under the default timeout.

Tests only: nothing under `packages/tscache/src` changes, and no dependency is added.

| Commit (by subject)                                     | What                 |
| ------------------------------------------------------- | -------------------- |
| `test: run the cache property tests in smaller batches` | The two test tables. |
| `docs(review): step 88, smaller property-test batches`  | This file.           |

| File                            | Before                 | After                  | Seeds, operations per seed |
| ------------------------------- | ---------------------- | ---------------------- | -------------------------- |
| `cache-model-property.test.ts`  | 8 batches of 100 seeds | 32 batches of 25 seeds | 800 seeds, 120 operations  |
| `cache-faults-property.test.ts` | 8 batches of 80 seeds  | 64 batches of 10 seeds | 640 seeds, 60 operations   |

The seeds are the same: 200 from each of 1, 10 001, 0xc0ffee and 0xdeadbeef in the model test; 160 from each of 1 and 0xc0ffee (retrying each failed put) and of 10 001 and 0xdeadbeef (carrying on) in the fault test. The table is now generated from those four starts instead of written out, so that 32 or 64 rows stay readable; the test names still print each batch's first seed and count. Every case's configuration, operation generator and check is untouched, and the order in which the seeds run is the same.

Each batch keeps its own reach assertion (the 17 rules of the model test, the 11 outcomes of the fault test). Every one of the smaller batches reaches all of them by itself, on every run below, so the assertion did not have to move to a per-file aggregate, and it stays at least as strict as before: it now holds for every 25 or 10 seeds instead of every 100 or 80.

The fault test's batches are smaller than the model test's because a fault seed costs about twice as much and its first batch carries most of the file's warm-up: with batches of 20 its first batch took 0.20 s at a load average of 7, with batches of 10 it took 0.10–0.16 s.

The replay instructions in both headers now say to replace the `it.each` table with a one-row array, since the table is generated. The headers state no timings.

## Verification

Batch durations are Vitest's per-test durations (`--reporter=json`), both files in one `bunx vitest run`, three runs per condition. Each run timed the old layout (step 74's files, copied beside the new ones for the measurement and deleted after) and the new one under the same conditions. Every run was taken under the heavy-job lock, and every test passed in every run.

| Condition                                                                     | File       | Before: slowest batch | After: slowest batch | After: median batch |
| ----------------------------------------------------------------------------- | ---------- | --------------------- | -------------------- | ------------------- |
| Normal load, load average 5.1–5.4 (the machine's idle level)                  | model test | 0.34–0.39 s           | 0.10–0.16 s          | 0.08 s              |
|                                                                               | fault test | 0.51–0.57 s           | 0.10–0.13 s          | 0.05 s              |
| Spotlight indexing, load average 61–90                                        | model test | 0.83–1.63 s           | 0.24–0.49 s          | 0.17–0.21 s         |
|                                                                               | fault test | 1.18–2.33 s           | 0.20–0.36 s          | 0.10–0.14 s         |
| Spotlight indexing plus ten CPU-bound processes (`yes`), load average 132–198 | model test | 1.02–1.25 s           | 0.34–0.47 s          | 0.22–0.27 s         |
|                                                                               | fault test | 1.50–2.03 s           | 0.27–0.45 s          | 0.13–0.16 s         |

The target was a slowest batch of about 0.15 s at normal load, a margin of about 30 times under the 5 s default. Measured: 0.16 s once (model test, second run) and at most 0.13 s otherwise. The slowest new batch is nearly always the first in its file, which carries the warm-up (module load and JIT compilation); a smaller batch cannot remove that fixed cost, and the other batches run near the median, 0.05–0.08 s, a margin of 60 to 100 times. Under the heaviest load measured the slowest new batch took 0.47 s, a margin of ten, where the old layout took up to 2.0 s. The whole-file time is unchanged (model test 2.4–2.6 s, fault test 3.0–3.2 s at normal load), as the work is the same.

`bunx tsc -p packages/tscache` and `bunx tsc -p .`: no errors. `bunx biome check` on both files: clean.

## Contract-test changes

None. Both files are implementer tests (their headers say so); no test or assertion was removed or weakened, and no timeout was raised.

## Decision concerns

None.
