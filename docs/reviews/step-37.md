# Step 37 — Native base64 for snapshots

Branch: `feat/37-native-base64` · Reviewer: not yet run (the director reviews) · Rounds: 0 · Status: implemented · Verdict after triage: pending review

Item 4 of the performance plan (`~/code/tscache-reports/perf-plan.md` §6), built by a child agent while the user was away. `encodeSnapshot` built a binary string with `String.fromCharCode` and passed it to `btoa`; `decodeSnapshot` copied `atob`'s characters into bytes one by one. Runtimes that ship `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64` (Chrome 140, Firefox 133, Safari 18.2, Bun, Node 25) do both natively.

## Scope

| Commit | What |
|---|---|
| 398d588 | `perf(snapshot)`: the codec moves to `src/base64.ts`, which takes the native methods once at load and uses them when the runtime has both, and the `btoa`/`atob` code otherwise. `snapshot.ts` calls it and maps any decode error to the same `TscacheError` as before. New `test/base64.test.ts` with its cases in `test/base64-cases.ts`. Docs: architecture §2.8 (encoding for HTML) |
| (the review commit) | `docs(review)`: this file |

## Decisions

- **Feature detection once, at load.** The module captures `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64` when it loads and keeps them; it never looks again, so a later change to the prototype cannot switch paths. Both must be present, or both directions use the fallback.
- **Same text, same accepted input.** Native encoding with the defaults (standard alphabet, padding) gives `btoa`'s text. Native decoding with its default `lastChunkHandling: "loose"` follows the same forgiving rules as `atob`: padding optional, ASCII whitespace skipped, non-zero padding bits ignored. The tests check 31 edge strings in both directions. A native `SyntaxError` and `atob`'s `DOMException` both become `TscacheError("invalid encoded snapshot: … is not valid base64")`, as before. Decoded buffers are exactly the decoded length, as before, so a field's `data` is still a whole `ArrayBuffer`.
- **How the native path is tested.** Vitest runs under Node 24, which has neither method, so in-process the tests prove the fallback path, the detection (the fallback is chosen exactly when the methods are missing) and a forced fallback with the module reloaded. A test then starts a Bun process, whose runtime has both, and checks there that the native path is chosen, that it agrees with the fallback on every case, and that a fresh instance loaded with the methods removed chooses the fallback. Bun is already required by the toolchain.
- **N38 (architecture §8) is unchanged.** Its row says the helpers use `btoa`/`atob` and no DOM. They still use them, as the fallback, the output is byte-identical, and there is still no DOM; the row is left as written, and §2.8 describes the native path. This reading is the implementer's: see "Decision concerns".
- **No runtime dependency, no public API change.** `src/base64.ts` is internal; the entries export what they did.

## Evidence

- Tests: `bunx vitest run packages/tscache/test/base64.test.ts`: 4 passed. Byte cases: empty, 1–5, 7, 8, 13, 255 and 1,000 bytes, the encoder's 32 KiB chunk edges (32,767, 32,768, 32,769 and 98,306 bytes), every byte value, NaN with infinities, signed zero and a subnormal, and an offset view. Snapshot case: a segment of seven slots (a one-byte mask, a u8 field of 7 bytes, i16 of 14, f64 of 56 with NaN) and an empty segment, through `JSON.stringify` and back. Before this commit the test file cannot load (`src/base64.ts` does not exist).
- Mutation checks, each failing the Bun test and restored afterwards: native encoding with the URL-safe alphabet, native encoding without padding, native decoding with `lastChunkHandling: "strict"`, and detection that never chooses native.
- `bunx vitest run` (all): 1,525 passed. Existing snapshot tests (`snapshot-codec.test.ts` and the rest) unmodified.
- `bunx tsc -p packages/tscache --noEmit`, `bunx knip`, `FALLOW_AUDIT_BASE=origin/main bun run fallow`: clean.
- Entry sizes (`bun scripts/size.ts`, brotli): `index` 13.83 → 13.89 kB (budget 14.25), `engine` 8.85 → 8.90 kB (budget 9.27); the other entries unchanged.

Paired benchmark, under the heavy-job lock (`bun scripts/bench.ts compare --base origin/main --only snapshot-roundtrip --runtime bun,chromium`, head `398d588` against `59b8da5`), run twice:

| Runtime | Run | Base | Head | Head/base | 95 % CI | A/A control |
|---|---|---:|---:|---:|---|---|
| Bun | 1 | 21.05 ms | 8.68 ms | 0.413 | 0.403–0.417 | 1.004 [0.990, 1.028] |
| Bun | 2 | 23.29 ms | 9.21 ms | 0.397 | 0.380–0.410 | 1.000 [0.997, 1.004] |
| Chromium | 1 | 27.67 ms | 5.60 ms | 0.201 | 0.196–0.205 | 0.997 [0.976, 1.010] |
| Chromium | 2 | 27.52 ms | 5.60 ms | 0.203 | 0.198–0.205 | 1.001 [0.988, 1.007] |

Every control is inside [0.95, 1.05]. The plan estimated a drop of about a tenth from the encoder's profile share (12 %); the measured drop is 60 % in Bun and 80 % in Chromium. The case encodes and decodes a month of six columns, and the binary-string encoder and the per-character decoder, which the profile split across `fromCharCode`, `btoa` and loop frames, were most of it.

Micro measurement (`/tmp/perf37/micro.ts`, not committed; one f64 column of 43,200 bars, 345,600 bytes; median of 60 runs after 10 warm-ups):

| | Bun, fallback | Bun, native | Chromium 153, fallback | Chromium 153, native |
|---|---:|---:|---:|---:|
| Encode | 2.47 ms | 0.035 ms | 4.6 ms | below 0.1 ms (the clock's resolution) |
| Decode | 0.223 ms | 0.031 ms | 0.5 ms | 0.1 ms |

## Not verified

- Firefox and Safari: not run. Their native methods follow the same specification; Bun shares Safari's engine (JSC) but is not Safari.
- Node 25 and later, which has the native methods: not installed here.
- The GitHub runner's timings (the `bench` job reports them on the pull request).
- No review round has run (child rules: the director reviews).

## Contract-test changes

None.

## Decision concerns

- **N38's wording.** The locked row names `btoa`/`atob`. This step treats that as the mechanism of its day rather than the decision (the decision being: the helpers ship from `.`, base64 for the buffers, no DOM, `NaN` survives), keeps `btoa`/`atob` as the fallback with byte-identical output, and leaves the row unchanged. If the user reads N38 as requiring `btoa`/`atob` everywhere, the fallback-only build is this commit without the native branch in `src/base64.ts`.

## User decision (2026-10-30)

The decision concern on N38 is settled by the user: keep the native path. The user reads N38's `btoa`/`atob` as naming the mechanism, not the decision, so N38's row stays unchanged.
