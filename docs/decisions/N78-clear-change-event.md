# N78: How a clear is reported to readers

Row N78 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**`cacheChanged { cleared: true }` as well as `cacheCleared`.** A `clear`, each cache of a `clearAll` (an empty one included) and a version-mismatch put send one `cacheChanged` each, after that cache's `cacheCleared`. `cacheCleared` stays as it is (N5) and carries the reason; `cacheChanged` is the one event a view needs to stay current. Rejected: `cacheCleared` only (every view must listen to two events, and a missed one leaves a stale chart). User decision 65, row D8 option (a), 2026-11-16 (§2.7, step 114)
