# N86: Whether tscache bounds the memory its caches hold

Row N86 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A byte budget, enforced by evicting pages, and a stats call.** An application may set a memory budget; above it the engine evicts the least recently used pages that nothing pins, and `memoryStats()` reports what the caches hold. Rejected: a stats call only, with the application calling `clear` itself (a tab sees only its own caches, cannot know other tabs' ranges, and can only clear whole caches, so it cannot bound a SharedWorker that every tab shares and that outlives them). User decision 67, row E1 option (a), 2026-11-16 (§2.9, step 121)
