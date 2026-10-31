# Step 42 — Binary fetch format in the examples, reference backends and guide

Branch: `docs/42-binary-fetcher` · Reviewer: GPT-6.1 Sol (high) · Rounds: 5 · Status: settled after round 5

Item 5 of the performance plan (§6): a binary columnar response format for the examples' mock backend (which the reference clients also use), its fetchers and the Playwright fixture, documented in the site's fetcher guide. The library does not change. Implemented by Claude while the user was away, under the director's child rules of 2026-10-30.

## Scope

| Commit | What |
|---|---|
| 008e4e0 | `examples/mock-backend/src/columns.ts`: the format, `encodeColumns`, `decodeColumns`, `ColumnsError`. The mock backend answers series pages as a columns body when `Accept` names `application/vnd.tscache.columns` (JSON otherwise, `Vary: Accept` on both) and counts pages per format in `/api/stats`. The examples' fetcher asks for columns by default (`format: "json"` in its context asks for JSON), reads JSON from a backend that answers it, and returns a one-page range as views over the body |
| 9a1ef86 | The Playwright backend answers candles as columns on request; both e2e servers serve the columns module, types stripped, as `/columns.js`; the fixture fetcher asks for columns unless its context says JSON. `bun scripts/bench.ts e2e --fetchers base,head` chooses the fixture's format per side. The reference clients' spec checks that every series page came as columns |
| 646c545 | The fetcher guide's "Binary pages" section (why, the format, the decoder, Arrow IPC), its snippet `site/snippets/fetcher-columns.ts` run by `docs:run`, and a tip on the performance page |
| 3ec70e7 | This file |
| 2475fef | Round 1 fixes: `joinColumns`, `isColumnsType` and `acceptsColumns` in `columns.ts`, used by the snippet, the examples' fetcher, the e2e fixture and both backends |
| 946f5b7 | Round 1 triage |
| 984001e | Round 2 fixes: structural schema comparison in `joinColumns` and in the examples' fetcher; explicit aligned copy in `decodeColumns` |
| 48250a4 | Round 2 triage |
| c84feaa | Round 3: page joining restructured into normalize-then-join (`fromColumns`, `fromJson`, `joinPages`), used by the examples' fetcher and the guide's snippet |
| (this commit) | Round 4: `fromJson` checks each field's length against the page's timestamps, as `decodeColumns` does; round 4 triage |

## Decisions

- **No decode helper in `tscache/fetcher`.** As the plan recommends: the helper lives in `examples/mock-backend/src/columns.ts`, which the guide shows and tells readers to copy. Shipping it from the package would be new public API on the subpath N6 keeps tiny; that stays the user's call.
- **Selection by `Accept`, not a query parameter.** The mock backend already reads request headers, and `Accept` with `Vary` is what an HTTP cache understands. A wildcard or a missing `Accept` gets JSON, so every existing client keeps working.
- **Media type `application/vnd.tscache.columns`.** An unregistered vendor type; the guide presents the format as the examples' own, to rename or adapt.
- **A JSON header.** It carries count, field specs and the page's other members (`meta`, `next`) as the JSON form has them, at a few hundred bytes parsed once per page, with no second encoding for strings. The header is typed (`ColumnsHeader`) and validated on decode.
- **Every column on an 8-byte boundary,** not only the timestamps: a narrower column of odd length would otherwise leave the next one unaligned. The body ends with its last column; trailing bytes are rejected, as is any truncation.
- **Integer columns refuse `NaN` and out-of-range values** when encoding, rather than storing them as 0 or wrapped.
- **The fetcher picks the decoder by the response's `Content-Type`,** so it reads JSON from a backend that ignores `Accept`.
- **The e2e fixture imports the decoder itself** (`/columns.js`, transpiled from the example source at request time) rather than a copy, so the Playwright suites and the bench exercise the same decoder the guide shows.
- **The root TypeScript project maps `tscache` to `packages/tscache/src/types.ts`.** The Playwright backend now imports the columns module, which imports tscache's types; mapping to the full client source would pull in code that needs the DOM library, which the Bun scripts' project does not load.
- **The site's basic fetcher snippet stays JSON.** The guide introduces the contract with the simpler format and adds binary as a section.

## Tests

Written before the code where behaviour was new; each failed before its implementation and passes after.

| Test | Before | After |
|---|---|---|
| `examples/mock-backend/test/columns.test.ts` (18): every dtype round-trips in its typed array; header members kept; NaN through f64 and f32; integer columns refuse NaN, fractions and out-of-range values; length mismatch refused; empty page; timestamps-only page; alignment of every view across header lengths 1–9 mod 8 and odd counts; views share the body's buffer; a Uint8Array at an unaligned offset; `constructor` and `__proto__` field names; every truncation rejected; trailing bytes rejected; foreign body rejected; a hand-built body accepted; ten malformed headers rejected; header length past the end | suite failed: module missing | 18 passed |
| `backend.test.ts`: columns body on `Accept`, equal to the JSON page, `Vary: Accept`, per-format stats; `next` in the header; `*/*` gets JSON | 2 failed | passed |
| `fetcher.test.ts`: asks for columns, returns typed arrays equal to the JSON result across three pages; JSON on `format: "json"`; one-page range as views over one buffer; JSON from a backend that ignores `Accept`; a truncated body rejects with `ColumnsError` and a `failed` notice, not an auth error; pages whose column types differ are refused | 4 failed | passed |
| `docs:run`, `fetcher-columns.ts`: several pages equal the JSON fetcher's timestamps and fields, same version; a one-page range decodes into one buffer | new snippet | ok |
| `e2e/reference/clients.spec.ts`: after scrolling, `formats.columns > 0` and `formats.json === 0` | new assertion | see the CI run below |

## Bench proof (report-only)

The paired end-to-end scenarios on one engine: base and head are both `646c545`, and only the fixture fetcher's format differs. `handshake-first-read` and `two-tabs-one-fetch`, 30 rounds each, Chromium headless on the Apple Silicon Mac, under the heavy-job lock:

```sh
~/code/tscache-reports/bin/heavy-run.sh "binary child: e2e bench" bash -c 'for f in json,columns columns,columns json,columns; do bun scripts/bench.ts e2e --base HEAD --fetchers $f --only two-tabs-one-fetch,handshake-first-read --rounds 30; done'
```

| Run | Scenario | Base | Head | Head/base | 95 % CI |
|---|---|---:|---:|---:|---:|
| JSON (base) vs columns (head), first | `handshake-first-read` | 7.40 ms | 7.40 ms | 1.000 | 0.986–1.014 |
| | `two-tabs-one-fetch` | 410.9 µs | 361.7 µs | **0.859** | 0.834–0.886 |
| Columns vs columns (A/A control) | `handshake-first-read` | 7.70 ms | 7.65 ms | 1.012 | 1.000–1.024 |
| | `two-tabs-one-fetch` | 345.3 µs | 346.5 µs | 0.994 | 0.980–1.011 |
| JSON vs columns, repeated | `handshake-first-read` | 7.40 ms | 7.50 ms | 1.014 | 1.000–1.027 |
| | `two-tabs-one-fetch` | 403.9 µs | 354.3 µs | **0.864** | 0.848–0.897 |

Readings:

- **`two-tabs-one-fetch` is 14 % faster with columns,** in both paired runs, with intervals well clear of 1 and an A/A control at 0.994 [0.980, 1.011]. About 50 µs of a 405 µs operation is the JSON decode of a 1,500-bar page.
- **`handshake-first-read` shows no difference.** Its 7.4 ms is worker start, handshake and the fetcher module's import; the decode is under 1 % of it, below what 30 rounds resolve at Chromium's 100 µs clock.
- The fixture's page is small: 1,500 timestamps and nothing else on the wire (12 KB as columns), with `price` taken from the timestamps and `volume` built in the fetcher. An OHLCV page carries five columns more, so its JSON decode, and the saving, is larger, as the plan's micro-measurement shows (443 µs against 93 µs for 5,000 bars).

## Verification

- `bunx vitest run examples/mock-backend`: 83 passed (before the change, the new tests failed as listed above).
- `bun run typecheck`, `bunx biome check .`, `bunx knip`, `bun run fallow`: clean.
- `bun run build`, then `bun run docs:check` and `bun run docs:run`: every snippet ok, including `fetcher-columns.ts`.
- `bun run docs:build`: built; the guide's page carries the included regions.
- `~/code/tscache-reports/bin/heavy-run.sh "binary child: e2e smoke" bun scripts/bench.ts e2e --smoke`: all three scenarios ok with the columns fixture.
- `~/code/tscache-reports/bin/heavy-run.sh "binary child: ci" bun run ci` on the final commit: recorded in the director's report.

## Not verified

- A big-endian platform: both encoder and decoder refuse to run on one (`requireLittleEndian`), which no test can reach on this machine.
- The Arrow IPC paragraph is guidance only; no Arrow code runs in `docs:run`, since that would add `apache-arrow` as a dependency of the site.
- Firefox and Safari: the e2e and bench suites run Chromium only.

## Round 1 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | The guide's binary fetcher (`site/snippets/fetcher-columns.ts`) joins pages into the first page's typed array without comparing dtypes: `volume` as `u8 [1]` then `u16 [300]` returns `[1, 44]` | accepted | Reproduced: the snippet returned `Uint8Array [1,44]` for those two pages under one version. Fixed in 2475fef: joining moved into `joinColumns` (`examples/mock-backend/src/columns.ts`), which refuses pages whose columns differ in name, order or dtype with `ColumnsError`; the snippet uses it. Tests first: five `joinColumns` unit tests (red before), and a `docs:run` check that the snippet refuses a u8 page followed by a u16 one. With the dtype check disabled, `docs:run` failed with "pages of u8 then u16 volume gave 1,44, not a ColumnsError", and the unit tests failed too; with it restored, both pass. The examples' fetcher already refused differing constructors; a test of the exact u8 then u16 case now pins that |
| R1-2 | P1 | The examples' fetcher compares `Content-Type` exactly, so a columns body sent with `; charset=binary` goes to the JSON parser and throws `SyntaxError` | accepted | Reproduced: `SyntaxError: JSON Parse error: Unexpected identifier "TSC"`. Fixed in 2475fef: `isColumnsType` compares the media type before any `;`, trimmed and lowercased; the examples' fetcher and the e2e fixture fetcher use it. Tests first: `isColumnsType` unit tests over parameters, case, spacing and near misses, and a fetcher test that reads bodies typed `; charset=binary`, `Application/VND.tscache.Columns` and ` …columns ;v=1` (red before, green after) |

**Siblings checked for the same two classes** (all fixed in 2475fef):

| Where | Class | Finding | Resolution |
|---|---|---|---|
| `e2e/pages/fetcher.js` (the fixture the Playwright suites and the bench use) | decoder choice | Exact `===` on `Content-Type`, as R1-2 | Uses `isColumnsType` from `/columns.js` |
| `/columns.js` | both | Served from `columns.ts` with its types stripped | Carries the fixes; no code of its own |
| `examples/mock-backend/src/backend.ts` (the reference backend too) | `Accept` negotiation | Matched the type whatever its quality: `…columns;q=0, application/json` and `application/json, …columns;q=0.1` were both answered with columns. Reproduced | `acceptsColumns`: columns only when a range names the type, with a quality above 0 and no lower than that of the most specific range matching JSON (`application/json`, then `application/*`, then `*/*`); a malformed quality is ignored. Unit tests over 19 Accept values; a backend test for `q=0`, JSON preferred, and upper case |
| `scripts/e2e-backend.ts` | `Accept` negotiation | `accept.includes(type)`: ignored q-values as above, and missed `APPLICATION/VND.TSCACHE.COLUMNS`. Reproduced | Uses `acceptsColumns` |
| `examples/mock-backend/src/fetcher.ts` | page joining | Already refused columns of differing constructors (and differing names) | Unchanged; the new u8 then u16 test pins it |
| `site/snippets/fetcher-columns.ts` | decoder choice | Asks for columns only and decodes every answer; a JSON answer throws `ColumnsError` (not a columns body), a clean `'fetch-failed'` | Unchanged |
| reference clients (`reference/*`) | both | No fetcher or backend of their own: they load the examples' fetcher and mount the mock backend | Covered by the fixes above |

The guide's "Asking for it" section now shows the negotiation (`#negotiate` region) and states both rules; the README describes them.

## Round 2 — reviewer verdict: block

**Convergence check fired.** Page-join validation drew a P0 in rounds 1 and 2 (R1-1, then R2-1 re-raising it), so the area was redesigned rather than patched again: the schema signature string was removed and replaced by a structural comparison (`sameColumns`: equal column counts, then each name and dtype compared directly in place). No schema is encoded as a string anywhere any more.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P0 | R1-1 re-raised: `joinColumns`'s signature (`name:dtype` joined with NUL) is ambiguous for names holding its delimiters; `[("a","u8"), ("a:u8\0a","u16")]` and `[("a:u8\0a","u8"), ("a","u16")]` share one, and a u16 300 narrows to 44 | accepted | Reproduced under Bun and Node: `a: [1,44]`. Fixed in 984001e by the redesign above. Tests first, each red against the signature: R2-1's exact collision; a property test over 2,000 seeded schema pairs (mulberry32) whose names mix `:`, NUL, `"`, `\`, `,`, `{`, `}` and dtype names, drawn as unrelated pairs, equal pairs, one-change neighbours (a dtype, the order, a column) and R2-1's construction, asserting every differing pair is refused and every equal one joined, and that each kind occurred (over 800 refused, 300 collisions, 300 joined); and the collision in `docs:run` against the guide's fetcher. With the signature put back for one run, the unit collision and the property test failed (the property test on a generated pair, `[["{f64u8\\","u16"],[":{","u8"]]` against `[["{f64u8\\:u16\u0000:{","u8"]]`), and `docs:run` reported `a: [1,44]`; restored, all pass |
| R2-2 | P1 | A Node `Buffer` passes as a `Uint8Array`, but its `slice()` shares memory, so `Buffer.subarray(3)` keeps its unaligned offset and building the timestamp view throws `RangeError` | accepted | Reproduced under Bun and Node (`RangeError`). Fixed in 984001e: `decodeColumns` views any input as a plain `Uint8Array` over the same bytes and, when it is not 8-aligned, copies it explicitly (`new Uint8Array(length)` and `set`); `slice()` is no longer used on input. Tests first: Buffers at offsets 1, 3, 5 and 7 of a pool decode correctly into the decoder's own copy, and an aligned Buffer is still viewed in place, under Vitest (Node); the same unaligned Buffer under Bun in `docs:run`, which failed with `byteOffset modulo TypedArray.BYTES_PER_ELEMENT must be 0` when `slice()` was put back for one run |

**Every place that compares or keys on schemas**, checked for the same class:

| Where | Before | After |
|---|---|---|
| `joinColumns` (`columns.ts`), used by the guide's snippet | signature string (R2-1) | `sameColumns`, structural |
| `fetchRange`/`collect` in `examples/mock-backend/src/fetcher.ts` | field names joined with NUL: `["a\0b"]` and `["a","b"]` alike, then a `TypeError` on the missing column | names compared one by one after the counts; a fetcher test for that case, red before |
| `decodeColumns` duplicate-name check | `Set` of the raw names | unchanged: no encoding |
| column lookup by name (`decodeColumns`, `joinColumns`, the fetcher) | prototype-free records keyed by the raw name | unchanged |
| `e2e/pages/fetcher.js`, `/columns.js` | no comparison of its own; `/columns.js` is `columns.ts` with types stripped | carries the fix |

## Round 3 — reviewer verdict: merge after fixes

**Convergence check fired again.** Page joining drew a finding in all three rounds (R1-1, R2-1, R3-1), so no further special case was added: joining was restructured into normalize-then-join with an explicit widening table. Each page is normalized as it arrives, whatever its format (`fromColumns`, `fromJson`: every column a typed array of a known dtype, or a list of JSON numbers), and the normalized pages are joined by one rule (`joinPages`), which the examples' fetcher and the guide's snippet both use. The old per-format `join()` of the fetcher and `joinColumns` are gone.

The rule table, in `examples/mock-backend/src/columns.ts` (region `join`) and in the guide's "Joining pages":

| The pages hold | Joined as |
|---|---|
| one dtype throughout (columns bodies) | that dtype |
| JSON numbers throughout | `number[]` |
| anything else: columns and JSON, or columns of different dtypes | `Float64Array`, when every dtype involved is exact in float64; otherwise `ColumnsError` |

Nothing is narrowed or rounded. Names and their order are still compared one by one (R2-1).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | A range whose pages come in both formats (one columns, one JSON, as during a backend's rolling upgrade) fails as a whole: `join()` refuses columns whose constructors differ (`Float64Array`, `Array`), so pages with timestamps `[0]` and `[60000]` throw "the pages' columns differ in type" | accepted | Reproduced in both orders against the examples' fetcher. Fixed in c84feaa by the restructure above. Tests first; on the current `join()` the fetcher-level ones failed with that very error: the reviewer's `[0]`/`[60000]` pages in both orders; every dtype of the format joined with a JSON page holding 70,000.25, in both orders, at unit and fetcher level, each value kept exactly in a `Float64Array`; every ordered pair of distinct dtypes widened exactly; a u8 1 and a u16 300 widened to `[1, 300]`; JSON columns holding `null`, strings or no list refused (`null` is how JSON writes `NaN`, and a typed array would store it as 0); and the property test, now drawing each page's format at random as well as its names and dtypes, asserting that differing names are refused and that equal names join to exactly the pages' values, in the type the table gives (2,000 seeded pairs; over 300 of them mixed). `docs:run` checks the guide's fetcher against u8 then u16, columns then JSON, JSON then columns, and R2-1's collision. With the old rule restored in `joinPages` for one run (refuse when kinds or dtypes differ), six tests (three unit, the property test among them, and three at fetcher level) and `docs:run` failed; restored, all pass |

**No reject case can be tested.** Every dtype of the format (f64, f32, i32, u32, i16, u16, i8, u8) is exact in float64, and the format has no 64-bit integer dtype, so the "otherwise `ColumnsError`" row cannot be reached today. `EXACT_IN_FLOAT64` is typed `Record<Dtype, boolean>`, so a dtype added to tscache's `Dtype` fails the type check until it is marked; marked `false`, its mixed joins are refused. JSON numbers are float64 by the time they are parsed, so an integer above 2^53 in a JSON body is rounded by `JSON.parse` before the fetcher sees it; no fetcher can detect that.

**A round 1 behaviour changed, on the director's rule.** Round 1 made two binary dtypes in one column a refusal (R1-1). The rule table now widens them to float64, which keeps every value and so still prevents the narrowing R1-1 reported. The two tests that pinned the refusal (`fetcher.test.ts`: u8 then u16, f64 then f32; `columns.test.ts`: differing dtypes) now pin the exact widened values, which is the stronger check, and the `docs:run` case expects `Float64Array [1, 300]`. No contract test is involved.

**Every place pages are joined:** the examples' fetcher and the guide's snippet (both now `joinPages`; the snippet also reads JSON pages). The e2e fixture fetcher and the bench read one page per range and join nothing; `/columns.js` is `columns.ts` with types stripped.

## Round 4 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R4-1 | P0 | `fromJson` does not check a field's length against its own page's timestamps, so across joined pages a long page and a short one cancel out: JSON `timestamps:[0], v:[10,20]`, columns `timestamps:[60000], v:[30]`, JSON `timestamps:[120000], v:[]` join to three timestamps and three values, the engine accepts them and stores 20 at 60000 | accepted | Fixed by the director: `fromJson` now refuses a field whose length differs from the page's timestamp count, with the same message as `decodeColumns`, so every normalized page holds equal-length columns before any join. The gap also covered JSON-only ranges (two JSON pages cancel out the same way), which predate this step's mixed joins. Test first: the reviewer's pages refuse, alone and in the join (`columns.test.ts`, R4-1); with the check disabled for one run that test failed, restored it passes |

**Convergence check, director's call.** Page joining has drawn a finding in all four rounds. This one is not in the join rule: it is a missing per-page invariant at the normalize boundary (every column of a normal page has the timestamps' length), which `decodeColumns` already enforced for columns bodies and `fromJson` did not. The invariant is now enforced at both entry points of `NormalPage`, so no further special case is added to the join. One more round confirms. If round 5 finds page joining or normalizing again, the director escalates instead of patching; the fallback is to refuse mixed formats within one range and document one format per range.

## Round 5 — reviewer verdict: merge

No findings; every accepted finding of rounds 1–4 confirmed fixed. Settled.

## Contract-test changes

None.

## Decision concerns

None raised yet. Open for the user: whether `tscache/fetcher` should ever ship a decode helper (recommended no; see Decisions).
