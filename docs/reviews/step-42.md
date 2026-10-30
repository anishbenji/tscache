# Step 42 — Binary fetch format in the examples, reference backends and guide

Branch: `docs/42-binary-fetcher` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: round 1 triaged, awaiting round 2

Item 5 of the performance plan (§6): a binary columnar response format for the examples' mock backend (which the reference clients also use), its fetchers and the Playwright fixture, documented in the site's fetcher guide. The library does not change. Implemented by Claude while the user was away, under the director's child rules of 2026-10-30.

## Scope

| Commit | What |
|---|---|
| 008e4e0 | `examples/mock-backend/src/columns.ts`: the format, `encodeColumns`, `decodeColumns`, `ColumnsError`. The mock backend answers series pages as a columns body when `Accept` names `application/vnd.tscache.columns` (JSON otherwise, `Vary: Accept` on both) and counts pages per format in `/api/stats`. The examples' fetcher asks for columns by default (`format: "json"` in its context asks for JSON), reads JSON from a backend that answers it, and returns a one-page range as views over the body |
| 9a1ef86 | The Playwright backend answers candles as columns on request; both e2e servers serve the columns module, types stripped, as `/columns.js`; the fixture fetcher asks for columns unless its context says JSON. `bun scripts/bench.ts e2e --fetchers base,head` chooses the fixture's format per side. The reference clients' spec checks that every series page came as columns |
| 646c545 | The fetcher guide's "Binary pages" section (why, the format, the decoder, Arrow IPC), its snippet `site/snippets/fetcher-columns.ts` run by `docs:run`, and a tip on the performance page |
| 3ec70e7 | This file |
| 2475fef | Round 1 fixes: `joinColumns`, `isColumnsType` and `acceptsColumns` in `columns.ts`, used by the snippet, the examples' fetcher, the e2e fixture and both backends |

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

## Contract-test changes

None.

## Decision concerns

None raised yet. Open for the user: whether `tscache/fetcher` should ever ship a decode helper (recommended no; see Decisions).
