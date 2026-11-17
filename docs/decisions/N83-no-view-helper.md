# N83: Whether the library ships a view helper

Row N83 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**No: the library ships the event and the read rule (N84); the integrations and reference clients own the view logic.** Each integration's series subscribes on mount, keeps its shown range, schedules at most one read per animation frame on an overlapping event (fetching or `cacheOnly` by N84), and unsubscribes on unmount, as framework-native code (the reference clients decision of 2026-10-22). The reference clients keep the Web Lock election for the feed and replace their `BroadcastChannel` redraw message with `cacheChanged` in the SharedWorker hosting; in the dedicated and in-process hostings the channel still carries the bars. Rejected: `cache.watch(range, fn)` re-reading by the rule (new public API whose range, scheduling and lifetime are view concerns the frameworks model differently). Revisit if users get N84 wrong in practice. User decision 65, row D13 option (a), 2026-11-16 (§2.7, step 114)
