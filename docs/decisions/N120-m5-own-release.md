# N120: Which release carries the deploy-skew design

Row N120 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 135 from the M5 design proposal (`docs/design/m5-deploy-skew.md`), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Its own minor release, once its contract tests pass.** It is independent of the change events and the memory budget. Which number that release takes is the user's call when it is cut. Rejected: one release together with M7 and M3 (waits for the largest of the three). User decision 71, row F15 option (a), 2026-11-16 (step 135)
