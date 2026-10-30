# Step 33 — Reads copy each point once

Branch: `feat/33-read-single-copy` · Reviewer: Codex (high) · Rounds: 1 · Status: settled · Verdict after triage: merge

Item 1 of the performance plan of 2026-10-30 (experiment E1): a read across segments copied every point twice. `collect` sliced each overlapping segment into fresh arrays, then allocated the result and copied the slices into it. It now counts first, allocates each result array once, and has each segment write its points straight into it. Built by an implementation child while the user was away, under the user's grant of 2026-10-30; the experiment was measured on a scratch checkout first. No public API or contract change: `GetResult`, `collect` and `read` (architecture §4.4) are unchanged, and every existing test passes unmodified.

## Scope

| Commit | What |
|---|---|
| a0bfab0 | `perf(read)`: `Segment` gains `countIn(range)` and `sliceInto(range, out, at)` (architecture §4.2, internal). `collect` counts the points of every overlapping segment, allocates each result array once, and has each segment write into it at its offset; no slice per segment, no second copy. `sliceInto` checks its offset and the target's room before writing anything. `slice` keeps its contract and its `TypedArray.prototype.slice` fast path from step 22; its gather branch now shares `sliceInto`'s. Tests: `test/dense-segment-slice-into.test.ts` (49), written first. Docs: architecture §4.2 (both methods, the new programming errors, where they came from) |

## Decisions

- **Two methods on the internal `Segment` interface**, as the plan proposed, rather than an internal accessor to the segment's buffers: code outside `segment/` still depends only on the interface (§4.2), and the segment keeps its buffers to itself. `slice` stays for its other callers (the merge path, snapshots, the overlap warning).
- **`sliceInto` validates its target's room** (`at + count <= out.slots.length`) and its offset, though its only caller sizes the target itself. The check is one comparison per segment, and without it a short target would drop points silently (indexed writes past the end are ignored) or fail half-written (`set` throws after the slots are written). The field arrays are not checked one by one: `Columns` already says every field array has `slots.length` elements.
- **Not done: `DenseSegment.extent` without a copy.** The plan suggested it as part of item 1. The getter allocates a small object per call, against copying 1,500 points per read; returning the internal object would let any caller mutate the segment's extent (`SlotRange` fields are not read-only). Not worth the invariant risk without a measurement that shows it.
- **`docs/review-checklist.md` §4** lists the interface methods in a parenthesis that this step makes incomplete. It is a workflow file, so it is left for a `chore/` branch rather than changed here.

## Evidence

**Tests first.** Before the implementation, `bunx vitest run packages/tscache/test/dense-segment-slice-into.test.ts` failed 49 of 49 (`TypeError: segment.countIn is not a function`); after it, 49 passed. They cover:
- every fencepost of a fully present segment and of one with gaps: the whole extent, both flanks beyond it, ranges that end one slot before or start one slot after it, ranges touching its first or last slot, one-slot ranges, ranges that start and end inside gaps, exactly one gap, a single absent slot, and a fully present run between gaps (which takes the copy branch inside a segment with gaps);
- empty and emptied segments, offset zero, a target with no spare element, a segment made whole again;
- segments spanning exactly their slot cap (1, 8 and 32,768), fully present and with every other slot cleared;
- a target too short, a negative, fractional or NaN offset, and malformed ranges, each rejected with nothing written;
- random runs, ranges and offsets against a set of present slots (two seeds).

Every read is checked against `slice` and against sentinel values outside the written indices.

**Mutation checks.** Dropping the room check fails 1 test; writing a fully present span at index 0 instead of at its offset fails 27.

**Full suite.** `~/code/tscache-reports/bin/heavy-run.sh "perf child: vitest feat/33" bunx vitest run`: 72 files, 1,557 tests passed. `bunx tsc -p packages/tscache` and `bunx tsc -p .` clean, `bunx biome check .` clean, `FALLOW_AUDIT_BASE=origin/main bun run fallow` reports no issues in the changed files.

**Benchmarks.** Base `origin/main` at `6b18b57`, whose `packages/tscache/src` is identical to `a3926ca`, the branch's base (only documentation changed in between). Head `a0bfab0`. Apple Silicon Mac, Bun 1.4 and Chromium, each command run under the heavy-job lock:

```sh
~/code/tscache-reports/bin/heavy-run.sh "perf child: bench feat/33" bash -c '
  bun scripts/bench.ts compare --base origin/main > /tmp/perf33-compare.log 2>&1
  cp .bench-results/summary.md /tmp/perf33-summary.md
  bun scripts/bench.ts e2e --base origin/main --only read-viewport-shared > /tmp/perf33-e2e.log 2>&1
  cp .bench-results/e2e-summary.md /tmp/perf33-e2e-summary.md'
```

(Run as one line joined with `;`. `compare` times every case in Bun and Chromium, the default runtimes.)

Head/base median of 20 paired rounds, with the 95 % interval. A/A controls: Bun 1.038 [1.028, 1.048], Chromium 1.006 [0.988, 1.018], both inside [0.95, 1.05].

| Case | Bun base → head | Bun ratio | Chromium base → head | Chromium ratio |
|---|---|---|---|---|
| `read-viewport` | 10.1 → 7.3 µs | 0.715 [0.684, 0.730] | 14.4 → 8.9 µs | 0.620 [0.615, 0.628] |
| `read-viewport-sessions` | 3.6 → 2.5 µs | 0.711 [0.554, 0.754] | 6.1 → 3.6 µs | 0.598 [0.589, 0.606] |
| `read-year` | 2.57 → 2.16 ms | 0.839 [0.743, 0.923] | 3.37 → 2.41 ms | 0.721 [0.703, 0.734] |
| `read-transfer` | 15.7 → 12.7 µs | 0.803 [0.789, 0.825] | 20.2 → 14.9 µs | 0.750 [0.715, 0.770] |
| `put-live-bar` (reads back one bar) | 2.2 → 2.1 µs | 0.930 [0.917, 0.976] | 3.4 → 3.0 µs | 0.887 [0.875, 0.890] |
| `put-page` | 634 → 637 µs | 1.003 [0.998, 1.006] | 170 → 170 µs | 1.000 [0.993, 1.005] |
| `append-bars` | 55.9 → 53.0 ms | 0.931 [0.886, 1.005] | 80.1 → 80.8 ms | 1.009 [1.001, 1.021] |
| `fill-month` | 5.83 → 5.90 ms | 1.002 [0.972, 1.030] | 2.12 → 2.00 ms | 0.947 [0.929, 0.958] |
| `snapshot-roundtrip` | 22.0 → 21.1 ms | 0.965 [0.821, 0.985] | 27.7 → 27.3 ms | 0.986 [0.977, 0.991] |

End to end, Chromium (report-only): `read-viewport-shared` 24.3 → 22.7 µs, 0.926 [0.898, 0.948]. The engine's read is about half of that scenario (performance plan §3), so the gain is diluted by the port round trip.

The read cases match the scratch experiment (plan §4: `read-viewport` 0.707 Bun, 0.625 Chromium). The put cases do not move, as expected: this step leaves the put path alone. `append-bars` in Chromium at 1.009 [1.001, 1.021] is far below the gate's 1.10 and the 0.25 µs floor per operation, and the code it runs is unchanged.

## Not verified

- Timings on GitHub's runner (the `bench` job reports them on the pull request).
- Firefox and Safari themselves; Bun stands in for JSC.

## Contract-test changes

None.

## Decision concerns

None.

## Round 1 — reviewer verdict: merge

No findings, on the branch rebased onto `main` 59b8da5; `bun run ci` passed. Settled. Reviewed and settled by the director while the user was away.
