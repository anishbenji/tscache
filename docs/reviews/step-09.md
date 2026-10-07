# Step 09 — RPC protocol, handshake and dedicated worker

Branch: `feat/09-rpc` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 3 · Status: in review · Verdict after triage: blocked

Not an engine step: tests were written with the code (hybrid TDD).

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | `dispose` closed the port before its response was posted, so `await request("dispose")` never settled | accepted | Reproduced. Fixed in 67c3bd9: the response leaves first, the port is detached after; round-trip test |
| R1-2 | P1 | A failure to post `init` (an uncloneable fetcher context) threw inside the listener and left `connect()` pending with the port open | accepted | Reproduced. Fixed in 67c3bd9: the error rejects `connect()` and closes the port; test with a function in the context |
| R1-3 | P1 | Op lookup found inherited properties, so `op: "toString"` succeeded | accepted | Reproduced. Fixed in 67c3bd9: own-property check. The tests this row first claimed had not landed (a script edit silently missed); they exist since fa67988 (see R2-3) |

## Adversarial round 1 — focus: cache-owned buffers never transferred; mismatch handling; payload still valid for IndexedDB and SSR — reviewer verdict: merge after fixes

The reviewer's probes confirmed that transferred reads and segment payloads preserve cache-owned data and that the payload stays structured-cloneable with a byte-preserving HTML round trip.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| A1-1 | P1 | Disposal closes the port before acknowledging (same as R1-1) | accepted | fixed in 67c3bd9 |
| A1-2 | P1 | Failed init serialization leaves the connection pending (same as R1-2) | accepted | fixed in 67c3bd9 |
| A1-3 | P1 | The client accepted `init-ok` before `hello`, succeeding without a protocol check | accepted | Reproduced. Fixed in 67c3bd9: two-stage handshake state; an out-of-order message rejects `connect()`; test |
| A1-4 | P1 | Handler lookup accepts inherited operations (same as R1-3) | accepted | fixed in 67c3bd9 |
| A1-5 | P2 | The Fallow rule change (`unused-class-members` → warn) sat on the step branch, coupling a CI-policy change to the RPC review | accepted | Reverted here; moved to `chore/09-fallow-class-members` (own pull request). Until that merges, `bun run ci` on this branch reports the two members as gating dead code |

## Round 2 — reviewer verdict: merge after fixes

All runtime fixes from round 1 confirmed present; the Fallow change confirmed gone from the branch (it merged separately as #15).

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | A server-side detach left the client's pending and later requests unsettled | accepted | Reproduced. Fixed in fa67988: the client listens for the port's `close` event and shuts down, rejecting pending and later requests; test |
| R2-2 | P1 | A minified worker bundle renames constructors, so `error.name` no longer matched and `fromWireError` lost `PutError`'s fields | accepted | Reproduced in reasoning (the base class sets `name` from the constructor). Fixed in fa67988: the wire name is the stable class name chosen by `instanceof`; test overrides `name` and checks the rebuild |
| R2-3 | P1 | The inherited-op tests claimed in R1-3 were not in the suite | accepted | Correct: the edit had not applied. Added in fa67988 for `toString`, `constructor`, `__proto__`; the R1-3 record above is corrected |

## Round 3 (first attempt) — no verdict

The Codex session hit the one-hour limit while still probing and wrote no report. Its last probe showed a real defect, fixed before the rerun in d428e7e: a `cacheCleared` listener throwing a null-prototype object made `String()` throw inside the server's reply path, so the `clear` request never settled. Non-Error throws are now described with `show()`, a reply whose serialization fails falls back to a generic wire error, and an uncloneable result is answered with an error; regression test added.

## Round 3 — reviewer verdict: merge after fixes

Completed on the fourth attempt; three earlier sessions stalled mid-review (each ran its probes for 15–20 minutes, then went silent until the hour limit). Rounds 1–2 confirmed fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | An `Error` whose `message` is a function passes `toWireError` but fails to clone in `postMessage`, so the request never settles | accepted | Reproduced. Fixed in 4026523; test |
| R3-2 | P1 | A peer closing during the handshake left `connect()` pending (only messages were listened for) | accepted | Reproduced. Fixed in 4026523; test |
| R3-3 | P1 | A client that disposed itself stayed registered on the server (listener, port, broadcast work retained) | accepted | Reproduced. Fixed in 4026523; test via the new `connections` count |
| R3-4 | P1 | A request whose params cannot be cloned rejected but left its pending entry behind | accepted | Reproduced. Fixed in 4026523; test via the new `pendingCount` |

**Convergence rule.** Transport lifecycle drew findings in rounds 1, 2 and 3, so 4026523 reworks the area instead of patching: both sides subscribe to a port through one `listen()` helper that pairs the message and close listeners and returns the single function removing both; the server sends through one `#send` that falls back to a plain, always-cloneable error reply and drops a port that cannot take even that; the client's handshake and steady state share the same closure handling. The architecture doc (§4.7) is unchanged in substance; `listen` is an internal helper.

## Contract-test changes

None (no contract tests for this step).

## Decision concerns

None.
