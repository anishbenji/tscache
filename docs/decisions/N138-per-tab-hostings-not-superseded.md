# N138: Whether the dedicated-worker and in-process hostings take part beyond `clearAll`

Row N138 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 135 from the M5 design proposal (`docs/design/m5-deploy-skew.md`), which keeps the alternatives in full. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**No.** They persist nothing and run their own page's code, so there is nothing to stop: they neither announce nor listen, and they are never superseded. Their `clearAll` posts on the channel (N135). A pinned dedicated tab of an old deploy is not told of a newer one. Rejected: listening for `announce` and reporting `superseded` there too (a channel listener per tab, the only per-tab cost of the design). User decision 71, row F14 option (a), 2026-11-16 (§2.7, step 135)
