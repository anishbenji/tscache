# N131: How the superseded stop is reported

Row N131 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 135 from the M5 design proposal (`docs/design/m5-deploy-skew.md`), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A new `persistStopped` reason, `'superseded'`.** An application can tell it from a storage failure. Once a worker is superseded the reason is kept: a `clearAll` that fails afterwards does not replace the reason later opens stop with. A union member is additive at runtime but can fail an application's exhaustive `switch` at compile time; the release notes say so. Rejected: the existing `'unavailable'` with `error.name` `'SupersededError'` (reads as a storage failure). User decision 71, row F7 option (a), 2026-11-16 (§2.7, §4.10.6, step 135)
