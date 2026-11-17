# N93: Whether the volatile region can be evicted

Row N93 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A page that holds a provisional point is pinned.** The forming tail is small, written constantly and never covered, so evicting it would withdraw no coverage and only drop the bar a live chart shows; with a pushed feed and no fetcher it may be the only copy. A watermark moved far back pins a large region; `pinnedBytes` reports it. Rejected: no pin (a busy feed could lose its forming bar between two puts). User decision 67, row E8 option (a), 2026-11-16 (§2.9, §4.6, step 121)
