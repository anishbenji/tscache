# N77: Whether hydrate sends a change event

Row N77 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Yes: `hydrate` sends `cacheChanged` for its applied parts, and for the coverage its first watermark withdraws; it still sends no other event.** A part whose write fails is reported too, as for a failed put. A hydrate skipped for a version mismatch, an idempotent one, or one that only adopts a version or advances a watermark sends nothing. In a SharedWorker another tab may already show the range a seed filled. This amends the "No events" bullet of architecture §2.8 (N35, N36) for `cacheChanged` only: `hydrate` never clears, so it emits no `cacheCleared`, and it reports no `mergeWarning`. Rejected: no event, as §2.8 said of all events (a tab showing a range a seed filled would never learn of it). User decision 65, row D7 option (a), including the amendment to the locked §2.8 bullet, 2026-11-16 (§2.8, step 114)
