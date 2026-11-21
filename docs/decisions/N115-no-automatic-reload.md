# N115: Whether the library reloads a superseded tab

Row N115 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 135 from the M5 design proposal (`docs/design/m5-deploy-skew.md`), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Never; the guide recommends a prompt.** A page may hold unsaved state, which the library cannot know. An automatic reload is the application's choice, and the guide warns of the loop a page served stale can cause (N109). Rejected: an opt-in `ClientOptions.reloadWhenSuperseded` (that reload loop, inside the library). User decision 71, row F10 option (a), 2026-11-16 (§2.7, step 135)
