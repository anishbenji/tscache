# Step 75 — Input validation: field values (N68) and snapshot coverage (N69)

Branch: `feat/75-input-validation` · Reviewer: — · Rounds: 0 · Status: implemented, awaiting review · Verdict after triage: —

## Scope

Two input-validation gaps found by the November 2026 review, closed in three phases, following the engine-logic rule of `AGENTS.md` (TDD and Roles):

1. **Specification** (this commit, Claude): `docs/architecture.md` states the two rules as decision rows N68 and N69 and in the sections they touch. No code and no test change.
2. **Contract tests** (Codex): failing tests written from the specification, using the list at the end of this file. Codex also updates the existing tests that the new rules contradict (listed below), recording each change.
3. **Implementation** (Claude): `engine/batch.ts`, `engine/snapshot.ts`, `errors.ts` and `rpc/protocol.ts` changed to pass the contract tests; the user-facing documentation (`site/`, `docs/guides/`) and the changelog updated with the code; then the review loop.

## User decisions

- **Decision 29, option A** (2026-11-10, `tscache-reports/decisions-resolved.md` entry 29, from review finding H5 and §3i): "reject `null`, non-numbers and out-of-range integers with `PutError` (`'field-mismatch'`); `NaN` stays legal for float fields." Recorded as N68.
- **Decision 30, option A** (2026-11-10, entry 30, from review finding L1 and §2.1 F1): "reject a snapshot whose coverage reaches past its own `finalizedUntil`", in snapshot validation. Recorded as N69.

## Director decisions under the grant

Settled by the director under the user's standing grant; the user may veto any of them.

- N68.2: the error is `PutError` `'field-mismatch'`, naming the first offender's field, index, timestamp, value (as `show()` prints it) and what was expected, in `offenderIndex`, `offenderTimestamp`, `expected` and a new `offenderField` (see open point 2).
- N68.3: a value that is not of type `number` (`null`, `undefined`, a sparse-array hole, a string, a boolean, a bigint, an object) is rejected in every field, with no coercion.
- N68.4: float fields accept every number, `NaN` and `±Infinity` included; `f32` stores the nearest float32, as today.
- N68.5: integer fields reject `NaN` and `±Infinity`, truncate a finite value toward zero, and reject it when the truncation lies outside the dtype's range.
- N68.6: a typed array of the field's own dtype is accepted without a scan; every other typed array and every `number[]` is checked by the rules above.
- N69.1: a snapshot whose `finalizedUntil` is set and whose coverage reaches a slot at or after it is rejected by snapshot validation with `TscacheError` (`invalid snapshot: …`); points there, outside its coverage, stay legal.
- N69.2: the check runs in the engine's snapshot validation (§4.5 step (4)), so `hydrate` throws before anything changes, as for every malformed snapshot.

Spec choices made while writing (also open to veto):

- Value checks run after the structural, timestamp and range checks (step (5) of §4.3), so a value offender always has a valid timestamp to report.
- "First offender" means first in schema order, then in index order: one pass per field, no cross-field minimum.
- The message names the value's `typeof` when it is neither a number nor `null`, because `show("1")` prints `1`.

## Open points

1. **Should a fractional value for an integer field be rejected too?** Decision 29 names only non-numbers and out-of-range values, so N68 keeps the documented truncation (`1.5` for an `i32` field is stored as `1`). For rejecting: a fraction in an integer field usually means a schema mistake (a price or a fractional crypto volume in an `i32` column), and truncation silently loses data; the integer fields are scanned anyway, so the extra check costs almost nothing; tightening after 0.1.0 is a breaking change, as decision 29 noted for the rest. For keeping: truncation is documented and invents no value (unlike `null` stored as `0`); the consumer chose the dtype; a backend that sends `10.0` as `10.000000001` after a float round trip would start failing. Lean: keep truncation, but decide before 0.1.0.
2. **`PutError.offenderField`** is a new optional public property (§2.6) and travels in the RPC error data (§4.7; additive, `PROTOCOL_VERSION` stays 1). No existing property fits: `offenderIndex` and `offenderTimestamp` locate the point, not the column. The alternative is to name the field only in the message. Recommended: add it, since an app can then report the column without parsing text. Its contract test should be a test of its own, so it can be dropped if the user vetoes the property.
3. **Stored records (§4.10) and N69.** Page snapshots never carry `finalizedUntil` (§4.10.2), and a page snapshot with one is already invalid (§4.10.5 step 5), so the new rule changes no load. The analogous case on load, a page whose coverage reaches past the cache record's watermark, is already clipped with `rewrite: true` (§4.10.5 step 6), which never makes a provisional slot authoritative. Whether such a page should instead be skipped whole is not specified here, since it would change persistence behaviour; recommended: leave it as it is.
4. **User-facing documentation** to change in phase 3: `site/concepts/grid.md` (the truncation sentence), `site/concepts/segments.md` and `docs/guides/patterns.md` (missing values: a JSON backend's `null` must be mapped to `NaN` in the fetcher, or the response is rejected), and the changelog entry, which is a breaking change for any caller that relied on the coercion.

## Director answers (phase 3)

- Open point 1 (fractional values for integer fields) is parked with the user as decision 38; the implementation truncates, as specified.
- Open point 2: `offenderField` is added as specified (a director decision under the grant; the user may veto it).
- Open point 3: no persistence change, as specified.

## Existing tests the new rules contradict

Read from the test files, not run. Phase 2 updates them; each change is recorded here.

- `packages/tscache/test/batch.test.ts`, "converts all eight schema dtypes by typed-array assignment": it puts `65 537.9`, `4 294 967 297.9` and `NaN` into integer fields and expects wrapped values; under N68 that batch rejects.
- `packages/tscache/test/hostile-values.test.ts`, "as a field value → stored as a number, or PutError": a function value is currently stored as `NaN`, and a value that cannot be converted rejects with `offenderIndex: -1`; under N68 every non-number rejects with `offenderIndex: 0`.
- Other tests, examples, benchmarks and fixtures that put `null` or out-of-range integers may exist; `bun run ci` in phase 3 finds them.

## For the contract-test author

References: `docs/architecture.md` §2.4 "Field values (N68)", §2.6 (`PutError`), §4.3 "Rules for `validateBatch`" (the order of checks, "Values (N68)" and "Cost of the value check"), §4.7 (`toWireError` data), §2.8 "Applying a snapshot" (first rule), §4.5 "Hydrate: validation (N35)" step (4) and the paragraph after it, §4.10.5 steps 5 and 6, and rows N68 and N69 in §8 (with N19, N35, N17 for context). Import paths as in §4.

Behaviours that need a test (N68, through `validateBatch` and through `CacheState.put` or `Engine.put`):

- `null` in an `f64` `number[]` rejects with `code: 'field-mismatch'`, the element's `offenderIndex`, its `offenderTimestamp`, `offenderField` and `expected: "a number"`.
- Each of `undefined`, a sparse-array hole, `"1"`, `true`, `1n`, `{}`, `[]`, a symbol, a null-prototype object and a function rejects the same way, in a float field and in an integer field.
- `NaN`, `Infinity`, `-Infinity` and `-0` are accepted in `f64` and `f32` and read back unchanged (`NaN` as `NaN`).
- `f32` stores `Math.fround(v)`; `1e300` in an `f32` field is stored as `Infinity`.
- For each integer dtype: its minimum and maximum are accepted; minimum − 1 and maximum + 1 reject with `expected` naming that range; `NaN`, `Infinity` and `-Infinity` reject.
- Truncation: `1.9` → `1`, `-1.9` → `-1`, `-0.5` in `u8` → `0`, `255.9` in `u8` → `255`; `256` and `-1` in `u8`, `-1` in `u32` and `2 ** 31` in `i32` reject; `-(2 ** 31)` in `i32` is accepted.
- A typed array of the field's own dtype is accepted (`Float64Array` with `NaN` in `f64`, `Uint8Array [0, 255]` in `u8`).
- A typed array of another type is checked: `Float64Array [NaN]` in `i32`, `Int32Array [300]` in `u8` and `Uint32Array [2 ** 31]` in `i32` reject; `Uint8ClampedArray` in `u8` is accepted; `Float64Array [0.1]` in `f32` is stored rounded; `Int32Array [16 777 217]` in `f32` is stored as `16 777 216`.
- First offender: with offenders in the first schema field at index 3 and in the second at index 0, the first field's is reported; within a field the lowest index is.
- Order against other checks: a length mismatch, a misaligned, unsorted or duplicate timestamp, and a timestamp outside `options.range` are each reported instead of a value offender in the same batch; a value offender is reported instead of an invalid `meta`.
- Atomicity: a rejected batch changes nothing, coverage, points, version and watermark included; a batch with a differing `meta.version` and an invalid value does not clear the cache and calls no `onVersionClear`.
- The message contains the field name in double quotes, the value as `show()` prints it, `(string)` for the string `"1"`, the index and the timestamp; a symbol and a null-prototype object still produce `PutError`.
- An empty batch is unaffected; timestamps are unaffected (a `null` timestamp is still `'misaligned'`).
- A fetcher response holding `null` fails as a rejected response does (`'fetch-failed'` for the gets that awaited it, with the `PutError`'s name and message), and nothing is cached.
- A `PutError` from a value crosses the RPC layer with `offenderField` intact (`toWireError`, `fromWireError`).

Behaviours that need a test (N69, through `CacheState.hydrate` and `Engine.hydrate`):

- Grid interval 10, offset 0: a snapshot with `finalizedUntil: 30` and coverage `[{ start: 0, end: 20 }]` is accepted; with coverage ending at `30` it throws `TscacheError` whose message starts with `invalid snapshot:`, and the cache is unchanged (points, coverage, version, watermark).
- Unaligned watermark, offset 3: `finalizedUntil: 33.25` makes slot 43 the first volatile one; coverage ending at `33` is accepted, coverage ending at `43` rejects.
- Only a later coverage range reaching the watermark (`coverage[1]`) also rejects, and the message names it.
- A snapshot with `finalizedUntil` and points (in `segments`) at or after it but outside its coverage is accepted, and those points are not applied.
- A snapshot without `finalizedUntil` is not bound by the rule.
- The rejection happens before the version precondition: a snapshot of another version that also breaks the rule throws rather than returning `skipped: 'version-mismatch'`.
- A snapshot taken from any cache state (`get` with `snapshot: true`, `Engine.snapshot`) still passes validation (the round-trip property (a) of §4.5 keeps holding).
- Restore is unchanged: a page snapshot that carries `finalizedUntil` is skipped with `rewrite: true`, as before (§4.10.5 property (d)).

## Implementation (phase 3)

Codex's four contract test files (`put-field-values`, `put-field-error-wire`, `fetch-field-values`, `snapshot-own-watermark`) failed 139 and passed 84 before the implementation; afterwards all 223 pass, unchanged.

- `engine/batch.ts`: step (5) of `validateBatch`. A typed array of the field's own dtype (by constructor, or by its tag for one from another realm), and any numeric typed array for a float field, is copied with `set` inline in the field loop and never scanned. Every other array goes to `scanInto`, which checks and copies in one pass, so each value is read once. An integer dtype's range is computed from its element size only on that path. The optional skip for a narrower integer typed array (§4.3 "may skip") is not taken; such an array is scanned and passes.
- `engine/snapshot.ts`: the N69 bound in step (4), in the coverage loop after that range's earlier checks.
- `errors.ts`, `rpc/protocol.ts`: `PutError.offenderField`, carried in the wire error data.
- Measurements (working tree against `main` 8aa6486, Bun, `bun scripts/bench.ts compare --base main --runtime bun --only put-page,put-live-bar,append-bars,fill-month`, under the heavy-job lock): `put-page` 1.021, `put-live-bar` 1.005, `append-bars` 1.062, `fill-month` 1.022 (head/base medians), all `ok`; A/A control quiet. A first version ran `append-bars` at 1.159 (an array allocated per field for the range, and the scan function on the hot path); computing the range only when scanning and keeping the fast path inline fixed it. Entry sizes (`bun scripts/size.ts`, brotli): `index (lazy)` 12 442 B against a budget of 12 464 B (main 11.90 kB), `worker` 13 603 B of 13 728 B, `engine` 10 022 B of 10 272 B; no budget changed. Fallow reports one complexity warning, `scanInto` (cyclomatic 10), which does not fail the check.
- Message wording: the value message ends with `expected …` instead of a separate reason (`field "x" (u8) value 300 at index 2, t = 20: expected a finite number whose truncation is in [0, 255]`), which saves bytes; §4.3's examples are updated to match.

## Contract-test changes

Existing tests whose assertions pinned the coercion that decisions 29 and 30 removed; the specification changed, so their assertions follow it.

- `packages/tscache/test/batch.test.ts`, "converts all eight schema dtypes by typed-array assignment" (decision 29, N68). Old: the values `[1.1, -1.9, 65 537.9, 4 294 967 297.9, NaN]` went into all eight fields and were expected wrapped (`new Int32Array(values)` and so on). New: the float fields keep those values; the integer fields get `[1.1, 1.9, 0, 127.9, 0.5]`, inside every integer dtype's range, and are expected truncated (`new Int32Array(integers)` and so on). The rejected values are covered by `put-field-values.test.ts`.
- `packages/tscache/test/hostile-values.test.ts`, "as a field value → stored as a number, or PutError", renamed "as a field value → PutError naming the value (N68)" (decision 29). Old: either stored as `NaN` (a function) or `PutError` with `code: 'field-mismatch', offenderIndex: -1`. New: always `PutError` with `code: 'field-mismatch', offenderIndex: 0, offenderTimestamp: 0, offenderField: 'x', expected: 'a number'`.
- `packages/tscache/test/cache-hydrate-rejections.test.ts`, V07 "checks every payload before applying even the first valid part or metadata" (decision 30, N69; approved by the director). Old: the fixture's `finalizedUntil: 63` with a second coverage range `{ start: 63, end: 73 }`, which N69 now rejects in step (4) before the malformed payload is decoded. New: `s.finalizedUntil = 83`, so that coverage is legal and V07 still pins the `invalid segment payload:` error it exists for; a comment names N69.
- `packages/tscache/test/merge-property.test.ts`, "random upsert/replace puts match a Map after every operation" (decision 29, N68; approved by the director). Old: `i16` volumes drawn as `next(-100_000, 100_000) + 0.75`, modelled with typed-array wrapping. New: `next(-32_768, 32_767) + 0.75`, inside the range, so the property still checks truncation and new-wins; out-of-range values are covered by `put-field-values.test.ts`, which a comment names.
- `site/scripts/run-snippets.ts`, `checkConversions` (the `docs:run` check of the "Batches" table in `site/concepts/grid.md`, added by step 71; decisions 29 and 30, N68; approved by the director). Old: one put of `[null, undefined, NaN, 1.5, 300, -1, 1e40]` into an `f64`, `f32`, `i32` and `u8` field, expecting the coerced values (`null` as `0`, `300` in `u8` as `44`, `-1` as `255`). New: one put per value and field, checked against the new table: `null`, `undefined` and `"1"` reject with `'field-mismatch'` in every field; `NaN` and `±Infinity` are stored in `f64` and `f32`, and `1e40` in `f32` reads `Infinity`; `NaN`, `300` and `-1` reject in `u8`; `1.5` in `i32` and `u8` reads `1`. It stays a check of the documented table: a deliberately wrong expectation (`300` in `u8` expected as `44`) made `docs:run` fail with `byte given 300: rejected, the docs say 44`, and was then undone.
