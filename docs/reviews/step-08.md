# Step 08 — Engine assembly

Branch: `feat/08-engine` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: in review · Verdict after triage: blocked

## Round 1 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | `src/entries/engine.ts` still exported nothing, so `import { Engine } from "tscache/engine"` failed; `dist/engine.js` was empty | accepted | Confirmed from the build output. Fixed in 26b917c: the entry exports `Engine`, `EngineEvents` and the public types and errors a Node consumer needs; a test imports the entry and runs a cache through it (`dist/engine.js` is now 52.8 kB) |
| R1-2 | P0 | A listener that throws for one cache interrupted `clearAll`, leaving later caches uncleared and unnotified (N22) | accepted | Reproduced. Fixed in 26b917c: every cache is cleared and notified, the first listener error is rethrown at the end; regression test added |
| R1-3 | P1 | `has("missing")` was left unpinned by the contract tests | accepted | Pinned to `false` in 26b917c (replacing the author's clarification comment; recorded below) |

## Contract-test changes

`engine-e2e.test.ts`, lifecycle test: the invalidate range `{ start: 12.5, end: 22.5 }` was changed to `{ start: 13, end: 22.5 }`. The test expected slots 13–23 to be forgotten and slot 3 to stay covered, but under N1/§4.1 an unaligned start floors outward, so 12.5 snaps to the grid point 3 and the expectation contradicted the locked rule. Starting at the aligned 13 produces exactly the states the author asserted for the rest of the scenario. No assertion was weakened or removed.

`engine-cache.test.ts`: the author's "has(unknownId) unpinned" comment was replaced by a test asserting `false`, per the settled §4.6 rule.

## Decision concerns

None. Three spec ambiguities raised by the contract-test author were settled by the implementer and recorded in architecture §4.6: `has()` answers `false` for an unknown id (the one exception to the `UnknownCacheError` rule); `cache()` returns the resolved config the cache was created with; the emitter rethrows the first listener error after all listeners ran.
