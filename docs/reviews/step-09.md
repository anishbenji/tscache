# Step 09 — RPC protocol, handshake and dedicated worker

Branch: `feat/09-rpc` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 1 · Status: in review · Verdict after triage: blocked

Not an engine step: tests were written with the code (hybrid TDD).

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | `dispose` closed the port before its response was posted, so `await request("dispose")` never settled | accepted | Reproduced. Fixed in 67c3bd9: the response leaves first, the port is detached after; round-trip test |
| R1-2 | P1 | A failure to post `init` (an uncloneable fetcher context) threw inside the listener and left `connect()` pending with the port open | accepted | Reproduced. Fixed in 67c3bd9: the error rejects `connect()` and closes the port; test with a function in the context |
| R1-3 | P1 | Op lookup found inherited properties, so `op: "toString"` succeeded | accepted | Reproduced. Fixed in 67c3bd9: own-property check; test for `toString`, `constructor`, `__proto__` |

## Adversarial round 1 — focus: cache-owned buffers never transferred; mismatch handling; payload still valid for IndexedDB and SSR — reviewer verdict: merge after fixes

The reviewer's probes confirmed that transferred reads and segment payloads preserve cache-owned data and that the payload stays structured-cloneable with a byte-preserving HTML round trip.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| A1-1 | P1 | Disposal closes the port before acknowledging (same as R1-1) | accepted | fixed in 67c3bd9 |
| A1-2 | P1 | Failed init serialization leaves the connection pending (same as R1-2) | accepted | fixed in 67c3bd9 |
| A1-3 | P1 | The client accepted `init-ok` before `hello`, succeeding without a protocol check | accepted | Reproduced. Fixed in 67c3bd9: two-stage handshake state; an out-of-order message rejects `connect()`; test |
| A1-4 | P1 | Handler lookup accepts inherited operations (same as R1-3) | accepted | fixed in 67c3bd9 |
| A1-5 | P2 | The Fallow rule change (`unused-class-members` → warn) sat on the step branch, coupling a CI-policy change to the RPC review | accepted | Reverted here; moved to `chore/09-fallow-class-members` (own pull request). Until that merges, `bun run ci` on this branch reports the two members as gating dead code |

## Contract-test changes

None (no contract tests for this step).

## Decision concerns

None.
