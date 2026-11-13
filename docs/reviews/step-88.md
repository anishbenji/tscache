# Step 88 — The cache property tests in smaller batches

Branch: `fix/88-property-test-batches` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled · Verdict after triage: merge

## Scope

Step 74 (#110) added `packages/tscache/test/cache-model-property.test.ts` and `cache-faults-property.test.ts`, each as eight batches of seeds. On the development machine under load, single batches crossed Vitest's 5 s default timeout. On `main`, `docs/reviews/step-86.md` records six such timeouts in the first full `bun run ci` of step 86, with no assertion failure, at a load average of about 17. The director also saw four in the round 4 CI run of step 65 (the whole Vitest run took 24 s instead of 4–7 s; one batch took 5.7 s against 0.3 s normally, another 9.5 s) and three in the first CI run of step 87; steps 65 and 87 are unmerged branches, so their review files are not on `main` yet. GitHub CI passes. `docs/testing.md` forbids raising timeouts, retries and timing assertions, so the fix is structural: the same work in more, shorter test cases, each with a wide margin under the default timeout.

Tests only: nothing under `packages/tscache/src` changes, and no dependency is added.

| Commit (by subject)                                          | What                                       |
| ------------------------------------------------------------ | ------------------------------------------ |
| `test: run the cache property tests in smaller batches`      | The two test tables.                       |
| `docs(review): step 88, smaller property-test batches`       | This file.                                 |
| `test: assert the property tests' reach once per seed start` | The reach assertion per seed start (PR-1). |
| `docs(review): step 88 pre-review triage`                    | The pre-review below.                      |

| File                            | Before                 | After                  | Seeds, operations per seed |
| ------------------------------- | ---------------------- | ---------------------- | -------------------------- |
| `cache-model-property.test.ts`  | 8 batches of 100 seeds | 32 batches of 25 seeds | 800 seeds, 120 operations  |
| `cache-faults-property.test.ts` | 8 batches of 80 seeds  | 64 batches of 10 seeds | 640 seeds, 60 operations   |

The seeds are the same: 200 from each of 1, 10 001, 0xc0ffee and 0xdeadbeef in the model test; 160 from each of 1 and 0xc0ffee (retrying each failed put) and of 10 001 and 0xdeadbeef (carrying on) in the fault test. The table is now generated from those four starts instead of written out, so that 32 or 64 rows stay readable; the test names still print each batch's first seed and count. Every case's configuration, operation generator and check is untouched, and the order in which the seeds run is the same.

The reach assertion (the 17 rules of the model test, the 11 outcomes of the fault test) covers each seed start, not each batch (PR-1). A start's batches add what they reach to one count kept for that start; its last batch asserts that all the start's batches ran (8 or 16) and that together they reached every rule or outcome. The tests of a file run in order, so the last batch runs after the others. Step 74's layout ran each start as two batches of 100 or 80 seeds and asked each half to reach everything; the assertion now asks it of the whole start, as the pre-review proposed, since a single small batch reaches some rules only a few times and a later change to the generator could leave one batch without a hit with no defect in the library. Every rule and outcome is still required of every start, by a wide margin. Counts per start on the committed seeds (events, so a seed can count several times):

| Model test rule                                   | Per start   | Fault test outcome                       | Per start |
| ------------------------------------------------- | ----------- | ---------------------------------------- | --------- |
| unranged put                                      | 6733–6973   | put succeeded                            | 3603–3949 |
| ranged put                                        | 8430–8807   | failed in validation, nothing changed    | 931–969   |
| ranged put holding no point                       | 3989–4200   | failed in the write with nothing changed | 251–712   |
| invalidate dropped coverage                       | 1608–1723   | failed part-way, points changed          | 1417–1518 |
| setFinalizedUntil moved back and dropped coverage | 1291–1360   | failed part-way, coverage withdrawn only | 332–487   |
| clear                                             | 412–430     | failed after a version clear             | 221–232   |
| N17 watermark advanced                            | 2026–2114   | failed replace removed a point           | 2963–5351 |
| N17 lower watermark ignored                       | 4058–4106   | failed between write runs                | 927–1069  |
| N18 first version adopted                         | 117–133     | fault in a field array                   | 2447–2711 |
| N18 version mismatch cleared                      | 1907–1988   | fault in a slot array                    | 342–411   |
| N19 claim clipped                                 | 26367–28789 | fault in a mask                          | 468–593   |
| N19 provisional point kept                        | 1866–2102   |                                          |           |
| volatile slot left uncovered                      | 25257–28414 |                                          |           |
| warning reported                                  | 1738–1826   |                                          |           |
| warning clipped at the volatile region            | 69–104      |                                          |           |
| warning in the volatile region dropped            | 655–733     |                                          |           |
| store split into several segments                 | 14760–15332 |                                          |           |

The lowest per-start counts are 69 (model test, warning clipped at the volatile region) and 221 (fault test, failed after a version clear), against 3 and 5 in the worst single batch.

The fault test's batches are smaller than the model test's because a fault seed costs about twice as much and its first batch carries most of the file's warm-up: with batches of 20 its first batch took 0.20 s at a load average of 7, with batches of 10 it took 0.10–0.16 s at a load average of 8 to 9 (two runs, before the measurements below).

The replay instructions in both headers now say to replace the `it.each` table with a one-row array, since the table is generated; both say that the reach assertion does not run for such a row, as one seed reaches fewer rules than a start. The headers state no timings.

## Verification

Batch durations are Vitest's per-test durations (`--reporter=json`), both files in one `bunx vitest run`, three runs per condition. Each run timed the old layout (step 74's files, copied beside the new ones for the measurement and deleted after) and the new one under the same conditions. Every run was taken under the heavy-job lock, and every test passed in every run. These timings were taken before PR-1, which changes where the reach assertion runs but not the work of a batch.

| Condition                                                                     | File       | Before: slowest batch | After: slowest batch | After: median batch |
| ----------------------------------------------------------------------------- | ---------- | --------------------- | -------------------- | ------------------- |
| Normal load, load average 5.1–5.4 (the machine's idle level)                  | model test | 0.34–0.39 s           | 0.10–0.16 s          | 0.08 s              |
|                                                                               | fault test | 0.51–0.57 s           | 0.10–0.13 s          | 0.05 s              |
| Spotlight indexing, load average 61–90                                        | model test | 0.83–1.63 s           | 0.24–0.49 s          | 0.17–0.21 s         |
|                                                                               | fault test | 1.18–2.33 s           | 0.20–0.36 s          | 0.10–0.14 s         |
| Spotlight indexing plus ten CPU-bound processes (`yes`), load average 132–198 | model test | 1.02–1.25 s           | 0.34–0.47 s          | 0.22–0.27 s         |
|                                                                               | fault test | 1.50–2.03 s           | 0.27–0.45 s          | 0.13–0.16 s         |

The timeout itself was not reproduced: no run here timed out, the old layout included (at most 2.3 s, under a load average of up to 198). The margin is therefore argued by ratio, not shown by a failing run that now passes. The target was a slowest batch of about 0.15 s at normal load, about 30 times under the 5 s default. Measured at normal load (load average 5.1–5.4): 0.16 s once (model test, second run) and at most 0.13 s otherwise. The slowest new batch is nearly always the first in its file, which carries the warm-up (module load and JIT compilation); a smaller batch cannot remove that fixed cost. The other batches run near the median, 0.05–0.08 s, a margin of 60 to 100 times. Under the heaviest load measured the slowest new batch took 0.47 s, a margin of ten, where the old layout took up to 2.0 s. The whole-file time is unchanged (model test 2.4–2.6 s, fault test 3.0–3.2 s at normal load), as the work is the same.

Against the incidents: the slowed batches of step 65 ran about 19 times (5.7 s) and 28 times (9.5 s against the slowest normal batch, 0.34 s) slower than normal. At those factors the first batch of the new layout, 0.10–0.16 s at normal load, would take 1.9–3.0 s and 2.8–4.5 s, under 5 s but with little room at the top of the range; a median batch would take 0.9–2.2 s. The old layout's slowest batch at those factors takes 6.5–16 s. A stall of several seconds, such as the process being descheduled or paged out, adds the same time to a batch of any size, and smaller batches do not help against it.

`bunx tsc -p packages/tscache`: no errors. `bunx biome check` on both test files and this file: clean. After PR-1: both files pass (96 of 96); a scratch rule that no seed reaches, added to the model test's list and undone with the Edit tool, failed exactly the four last batches (one per start); running a start's last batch alone (`-t`) fails with "batches of seed start 3735928559 run: expected 1 to be 16"; the 96 test names are unique.

## Pre-review (Fable), not the gate

One round on 2026-11-13, after the director rebased the branch onto `main` e887b1e. No P0 or P1: the seed sets and order are identical to step 74's, the 96 test names are unique, and the timings reproduced.

| #    | Sev | Finding                                                                                                                                                                                                                                                                           | Decision | Resolution                                                                                                                                                                         |
| ---- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | P2  | The per-batch reach assertion passes on as few as 3 hits in some batches (model test: "warning clipped at the volatile region" 3 in seeds 1–25; fault test: "failed after a version clear" 5 in one batch); a later generator change could zero one batch and fail with no defect | accepted | `test: assert the property tests' reach once per seed start`: the assertion covers each start's batches together, in its last batch, after checking all of them ran; counts above. |
| PR-2 | P2  | The scope cited only incidents whose review files are not on `main`                                                                                                                                                                                                               | accepted | The scope now cites the six timeouts of step 86 (`docs/reviews/step-86.md`) and says steps 65 and 87 are unmerged.                                                                 |
| PR-3 | P2  | The verification did not say the timeout was not reproduced, nor give the first batch's margin against the incident's slowdown                                                                                                                                                    | accepted | Verification now says so, gives the margin by ratio at 19 and 28 times, and notes that a multi-second stall is not helped by batch size.                                           |
| PR-4 | nit | The load behind the fault test's "0.10–0.16 s" was not named; the fault test header lacked the model header's one-seed-replay caveat                                                                                                                                              | accepted | Load named (8 to 9); both headers now carry the caveat.                                                                                                                            |

## Contract-test changes

None. Both files are implementer tests (their headers say so); no test or assertion was removed or weakened, and no timeout was raised.

## Decision concerns

None.

## Security lane (Claude), not the gate

run 1, head 48adc71: P0 0, P1 0, P2 0

## Round 1 — reviewer verdict: merge

No findings (2026-11-13). The reviewer confirmed the pre-review fixes and, in a read-only comparison, identical 800 model seeds and 640 fault seeds, including order and retry flags; `tsc` and `git diff --check` passed.
