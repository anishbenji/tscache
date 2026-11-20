# N88: Which budget holds when clients disagree

Row N88 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The first budget an engine receives holds for its life.** A later client with another value joins without error; its value is ignored, a development build prints one `console.warn` naming both values, and `memoryStats()` reports the budget in force. This is N20's rule for the dataset fields: a stale tab can neither shrink nor lift the budget of the tabs already running. Rejected: the last value received (a stale tab could lift it), the smallest (one tab could shrink every tab's cache) and a rejecting `createClient` (breaks tabs during a deploy skew). A new deploy's value waits for the worker to restart (finding M5). User decision 67, row E3 option (a), 2026-11-16 (§2.9, step 121)
