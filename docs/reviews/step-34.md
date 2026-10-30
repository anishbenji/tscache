# Step 34 — A leaner put path

Branch: `feat/34-put-overhead` · Reviewer: not yet reviewed · Rounds: 0 · Status: awaiting review · Verdict after triage: —

Item 2 of the performance plan of 2026-10-30 (experiment E2): a put of a few bars spent most of its time on bookkeeping, not data. Built by an implementation child while the user was away, under the user's grant of 2026-10-30; the experiment was measured on a scratch checkout first. No API, contract or error-message change; every existing test passes unmodified.

## Scope

| Commit | What |
|---|---|
| c928625 | `test(put)`: `test/put-path-checks.test.ts` (9 tests), written before the code it guards and passing on the base. They pin, on both `SegmentStore.put` and `DenseSegment.mergeFrom`, what the field-name check must still reject: a schema field hidden behind a non-enumerable property, one that is only inherited, one given only under a symbol key, the right count of names with one wrong (`toString`); with and without an authority, each leaving the store and the segment unchanged. They also pin that a put keeps no array of its batch: one chunk and several, views at a nonzero offset into larger buffers, and a batch already in the store's dtypes |
| a4ff0d3 | `perf(put)`: `SegmentStore` hands a chunk that is the whole batch to the segment as the batch's own arrays instead of building views (the segment copies what it is given, §4.2); `assertFields` checks the field names without building a `Set`: as many enumerable own names as the schema has, with every schema name among them (same rule, same messages); `assertAscending` loops by index instead of `for…of` |
| c0041b7 | `perf(segment)`: an indexed loop instead of `for…of` in `DenseSegment.#write`, and an indexed fill instead of `Float64Array.from` in `presentPoints` (payload decoding) |

## Decisions

- **Points are still checked twice per put**, once by `SegmentStore.put` and again by `DenseSegment.mergeFrom`. The plan suggested skipping the segment's check on the store's internal path. Not done: architecture §4.2 makes validation part of the `Segment` contract ("Atomic", "Programming errors"), and code outside `segment/` depends only on that interface, so a skip would need an unchecked merge method on it. With the `Set` gone the second check is one more scan of the batch's slots and a length check per field; the measured gain below came without the skip. A candidate for a later step if a profile shows the second scan.
- **The plan's "remaining `for…of` loops over typed arrays in `payload.ts` and `engine/snapshot.ts`":** at `a3926ca` neither file iterates a typed array with `for…of` (their loops run over field entries, schema entries and segment lists). The one implicit iteration in `payload.ts`, `Float64Array.from(indices, …)`, is replaced. The only other typed-array iteration on the snapshot path is the spread in `toBase64` (`src/snapshot.ts`), which item 4 of the plan (native base64) replaces; it is left to that step.

## Evidence

**Tests first.** `test/put-path-checks.test.ts` was written and run before the code changed, and passed on the base (9 of 9): it pins behaviour that must not change, so it cannot fail first. To show it would catch a leaner check that is wrong, two mutations of `assertFields` were tried: checking `Object.hasOwn` instead of enumerability fails 1 test (the non-enumerable field); checking `name in fields` fails the same one, and the inherited field is still rejected by `getOwn` (which is why the read stays behind `getOwn`, as `segment/own.ts` asks). The existing rejection tests (`merge-rejections.test.ts`, `segment-merge-edges.test.ts`, `dense-segment.test.ts`) run unmodified and cover duplicate, descending and non-integer slots and missing, extra, wrong, short and long fields on both paths.

**Full suite.** `~/code/tscache-reports/bin/heavy-run.sh "perf child: vitest feat/34" bunx vitest run`: 72 files, 1,517 tests passed (1,508 on the base plus these 9). `bunx tsc -p packages/tscache` and `bunx tsc -p .` clean, `bunx biome check .` clean, `FALLOW_AUDIT_BASE=origin/main bun run fallow` reports no issues in the changed files.

**Benchmarks.** Base `origin/main` at `59b8da5`, whose `packages/tscache/src` and `packages/tscache/bench` are identical to `a3926ca`, the branch's base (only documentation and e2e tooling changed in between). Head `c0041b7`. Apple Silicon Mac, Bun 1.4 and Chromium, under the heavy-job lock:

```sh
~/code/tscache-reports/bin/heavy-run.sh "perf child: bench feat/34" bash -c 'bun scripts/bench.ts compare --base origin/main > /tmp/perf34-compare.log 2>&1; echo compare=$?; cp .bench-results/summary.md /tmp/perf34-summary.md'
```

Head/base median of 20 paired rounds, with the 95 % interval. A/A controls: Bun 1.007 [0.995, 1.026], Chromium 0.989 [0.984, 0.998], both inside [0.95, 1.05].

| Case | Bun base → head | Bun ratio | Chromium base → head | Chromium ratio |
|---|---|---|---|---|
| `put-page` | 629 → 571 µs | 0.911 [0.899, 0.916] | 168 → 127 µs | 0.758 [0.754, 0.762] |
| `put-live-bar` | 2.1 → 1.4 µs | 0.660 [0.654, 0.666] | 3.4 → 2.6 µs | 0.758 [0.754, 0.762] |
| `append-bars` | 52.5 → 28.3 ms | 0.537 [0.501, 0.552] | 77.5 → 45.3 ms | 0.585 [0.580, 0.590] |
| `fill-month` | 5.75 → 5.25 ms | 0.916 [0.896, 0.939] | 2.06 → 1.68 ms | 0.816 [0.808, 0.823] |
| `snapshot-roundtrip` | 20.7 → 19.3 ms | 0.940 [0.918, 0.950] | 27.5 → 25.5 ms | 0.923 [0.920, 0.929] |
| `read-viewport` | 10.1 → 10.2 µs | 1.021 [0.995, 1.036] | 13.8 → 13.7 µs | 0.998 [0.979, 1.002] |
| `read-viewport-sessions` | 2.9 → 2.9 µs | 1.012 [1.001, 1.028] | 5.8 → 5.7 µs | 0.985 [0.973, 1.000] |
| `read-year` | 2.33 → 2.40 ms | 1.043 [0.991, 1.089] | 3.07 → 3.07 ms | 0.998 [0.994, 1.008] |
| `read-transfer` | 15.2 → 15.0 µs | 0.988 [0.980, 1.019] | 19.5 → 19.5 µs | 1.003 [0.978, 1.007] |

The put cases match the scratch experiment (plan §4: `append-bars` 0.538 Bun, 0.569 Chromium; `put-live-bar` 0.621 and 0.617, which also carried part of the read change of step 33). The read cases run code this step does not touch; the largest, Bun's `read-year` at 1.043, has an interval holding 1 and stays far below the gate's 1.10.

## Not verified

- Timings on GitHub's runner (the `bench` job reports them on the pull request).
- Firefox and Safari themselves; Bun stands in for JSC.

## Contract-test changes

None.

## Decision concerns

None.
