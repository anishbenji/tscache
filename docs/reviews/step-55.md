# Step 55 — Slot-cap read test close to its timeout

Branch: `chore/55-slot-cap-test-time` · Status: implemented, awaiting review

`packages/tscache/test/dense-segment-slice-into.test.ts`, case "reads a segment spanning exactly its slot cap of 32768", crossed the 5 s Vitest timeout twice in full `bun run ci` runs on 2026-11-02 while the machine was busy. Run alone it took 0.6 s, 5.3 s and 1.0 s. The timeout stays at 5 s (a user decision, `vitest.config.ts`); the fix removes the work that made the case slow.

## Scope

| Commit  | What                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9ad4ccc | `test`: `expectRead` compares typed arrays with a helper that checks what `toEqual` checks for them, instead of Vitest's deep equality. Every assertion and the 32 768 case stay. No change under `src/` |
| (this)  | `docs(review)`: this file                                                                                                                                                                                |

## Root cause: Vitest's deep equality over typed arrays, not the library

A V8 CPU profile of the case alone (`bunx vitest run packages/tscache/test/dense-segment-slice-into.test.ts -t "slot cap of 32768" --execArgv=--cpu-prof`), with each sample attributed to the innermost frame in the library, the test file or Vitest's matchers:

| Where the time went                                            | Time    | Share |
| -------------------------------------------------------------- | ------- | ----- |
| Vitest matchers (`toEqual` → `equals` → `iterableEquality`)    | 1824 ms | 77 %  |
| Runner, module loading, garbage collection, idle               | 510 ms  | 21 %  |
| Library (`src/`: `mergeFrom`, `countIn`, `sliceInto`, `slice`) | 29 ms   | 1 %   |
| Test helpers (`span`, `points`, `target`, `expected`)          | 16 ms   | 1 %   |

The hottest functions by self time were Vitest's `keys` (712 ms), `eq` (430 ms), `iterableEquality` (214 ms), garbage collection (211 ms), `iterableEqualityWithStack` (136 ms) and `hasKey` (126 ms). The library's own frames (`#write`, `#gatherInto`, `#has`) took 4 to 6 ms each.

`toEqual` treats a typed array as a generic iterable (`iterableEquality` in Vitest 5.0.5, `vitest/dist/chunks/index.*.js`). It compares the two arrays element by element, calling the full `equals` with a freshly built tester list for every element, and then compares `Object.entries(a)` with `Object.entries(b)`: an array of 32 768 two-element arrays per side, each compared through `equals` and `keys`. `expectRead` made four such comparisons per read over a target of up to 32 773 elements (one over a whole `Columns` with three arrays, three over a `slots`, `price` and `volume` subarray), and the case makes three reads. The library is linear in the span and was never the problem.

### The fix

`expectSameArray(actual, wanted)` asserts what `toEqual` asserts for two typed arrays: the same constructor (`toEqual` returns false when `a.constructor !== b.constructor`), the same length, and every element the same by `Object.is`, the comparison `toEqual` uses for numbers (so `NaN` equals `NaN` and `-0` differs from `0`). `expectSameColumns` adds the check that both column sets have the same keys and the same field names. On a mismatch the failure names the first differing index and both values.

Before committing, temporary `it.fails` probes (removed again) confirmed that the helper fails on a different constructor, a different length, a difference in the last element of a 32 768-element array, `-0` against `0`, one side undefined, an extra field and a missing field, and passes on `NaN` against `NaN`; `toEqual` was checked to agree on the `-0` and constructor cases. A deliberate fault in `#copySpanInto` (slot `start + k + 1` at `k = 32 000`, reverted) made the 32 768 case fail with `expected { index: 32003, actual: 31994, … } to be undefined`.

## Timings of the case alone

Each run is one `bunx vitest run … -t "slot cap of 32768"` in a fresh process, duration of the case from Vitest's JSON reporter. "Before" ran a copy of the file at `main` (60bd435), alternated with the fixed file, run by run, on the shared machine (load average 13 to 15 during the runs).

| Run | Before  | After  |
| --- | ------- | ------ |
| 1   | 990 ms  | 30 ms  |
| 2   | 2176 ms | 105 ms |
| 3   | 2392 ms | 34 ms  |
| 4   | 748 ms  | 28 ms  |
| 5   | 704 ms  | 34 ms  |

Three earlier runs of the unchanged case alone took 4153 ms, 4026 ms and 1371 ms. In the full package suite (`bunx vitest run packages/tscache/test`, 282 files, 1874 tests) the fixed case took 19 ms.

## Other slow tests in `packages/tscache/test/`

The full package suite under the heavy-job lock, with the JSON reporter, listed six tests over about 1 s. Each was profiled and then timed alone over five runs:

| Test                                                                                 | In the suite | Alone (5 runs)     | Where the time goes                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `merge-failures`: replace that splits one segment into very many                     | 1751 ms      | 266–293 ms         | Library work proportional to the 133 334 segments the replace creates (`mergeFrom`, `#gather`, `setOwn`); matchers 9 ms |
| `merge-property`: random upsert/replace puts match a Map (three seeds)               | 1628 ms      | 86–252 ms per seed | Many small assertions (Chai's `flag`, `setState`); no large deep equality                                               |
| `perf/gate`: not voided by a merge whose only conflict is outside the source         | 1461 ms      | 179–236 ms         | `spawnSync` of `git` (73 %)                                                                                             |
| `perf/gate`: voided when merging the base resolves a source conflict by hand         | 1177 ms      | 373–468 ms         | `spawnSync` of `git`                                                                                                    |
| `perf/persist`: stored bytes per bar stays within 37.25 B for a year of dropout bars | 1444 ms      | 285–501 ms         | Fixture generation (`batchOf`, `series`) and `structuredClone`                                                          |
| `cache-failures`: very many warnings                                                 | 1047 ms      | 129–149 ms         | Library work over 300 000 points (`overlapWarnings`, batch validation); matchers 10 ms                                  |

None has the pattern of this step, and none takes more than about 0.5 s alone; their suite times reflect the suite's parallel load. None was changed.

## Not verified

- No full `bun run ci` under load was repeated many times to show the case no longer approaches the timeout; the evidence is the profile and the timings above. `scripts/flake-hunt.sh` was not run.
- The tests outside `packages/tscache/test/` (examples, integrations, reference, scripts) were not scanned.
- Timings come from a shared, loaded machine; they show the order of magnitude, not a benchmark.
