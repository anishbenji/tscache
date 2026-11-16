# N75: Whether the writing tab hears its own change

Row N75 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Yes: every subscriber hears every change, the writer's own connection included, with `requestId`.** A view redraws on `cacheChanged` whoever wrote. A put's event arrives before the put resolves; an orchestrated fetch's event arrives before the `get` that issued it resolves. `requestId` names the call: the client's own put, invalidate, clear, `clearAll`, hydrate or `setFinalizedUntil`, or for a fetch the `get` that issued it (as `mergeWarning` does, N21; joined gets are not named). The server carries the id with an op that persistence defers (N58), so every change the server applies has one. No public way to tell a tab's own events apart is added (no `client.id`, no `own` flag). Rejected: skipping the originating connection (a view must then also hook its own puts and fetches); adding `own` or a public `client.id` (new public API; revisit if applications need to skip their own changes). User decision 65, row D5 option (a), 2026-11-16 (§2.7, step 114)
