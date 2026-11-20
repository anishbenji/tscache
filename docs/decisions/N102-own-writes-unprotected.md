# N102: Whether a call's own writes are protected from its own enforcement

Row N102 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**No.** A call's own writes are the most recent pages, so its enforcement takes them last; when one call writes more than the budget holds, its own oldest pages go at the end of the call, `restore` included, and the bytes are back under the budget when the call ends. A fetch's put is protected by its get's pin instead (N94). Rejected: protecting them until the next enforcement (a cache would stay over budget until another write, which a tab that only reads never makes). User decision 67, row E19 option (a), 2026-11-16 (§4.6, step 121)
