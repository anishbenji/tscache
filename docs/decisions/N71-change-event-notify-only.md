# N71: What a change event carries

Row N71 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Notify-only: `cacheChanged` names ranges, never values.** Each subscribed tab that shows an overlapping range reads it again (N84). Data in the event would be copied once per tab per change (a buffer can be transferred to one port only), would be stale by the time a slow tab handled it, and would duplicate what a `cacheOnly` read returns from the one state; with every tab subscribed, the worker would clone every merge once per tab. The cost is one extra request per redraw. Rejected: carrying the changed points. User decision 65, row D1 option (a), 2026-11-16 (§2.7, step 114)
