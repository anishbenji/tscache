# Step 08 — Engine assembly

Branch: `feat/08-engine` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: in review · Verdict after triage: pending

## Contract-test changes

`engine-e2e.test.ts`, lifecycle test: the invalidate range `{ start: 12.5, end: 22.5 }` was changed to `{ start: 13, end: 22.5 }`. The test expected slots 13–23 to be forgotten and slot 3 to stay covered, but under N1/§4.1 an unaligned start floors outward, so 12.5 snaps to the grid point 3 and the expectation contradicted the locked rule. Starting at the aligned 13 produces exactly the states the author asserted for the rest of the scenario. No assertion was weakened or removed.

## Decision concerns

None. Three spec ambiguities raised by the contract-test author were settled by the implementer and recorded in architecture §4.6: `has()` answers `false` for an unknown id (the one exception to the `UnknownCacheError` rule); `cache()` returns the resolved config the cache was created with; the emitter rethrows the first listener error after all listeners ran.
