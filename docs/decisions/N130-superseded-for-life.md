# N130: Whether a superseded worker can become current again

Row N130 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 135 from the M5 design proposal (`docs/design/m5-deploy-skew.md`), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**No, for its life.** As after a failed `clearAll`, a persistence stop stays for the worker's life (N59): one rule, no flapping. An old tab that outlives the newer ones persists nothing until it reloads, and after a fetcher rollback new tabs rejoin the superseded worker and persist nothing until it ends. Rejected: becoming current again when every higher-ranked worker's lifetime lock is released (a state machine for a rare case; its full rewrite would delete the newer generation's pages; restarting a stopped cache amends N59). User decision 71, row F6 option (a), 2026-11-16 (§4.10.6, step 135)
