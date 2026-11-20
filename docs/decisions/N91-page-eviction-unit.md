# N91: What is evicted

Row N91 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A page.** A cache's page `p` is the slots `[p · cap, p · cap + cap − 1]` with `cap = segmentSlotCap`: the unit of the segment layout (N15) and of the persisted records (§4.10.2). Evicting it drops every segment on it and never splits one. Rejected: a segment (its boundaries move with the data, so the evicted unit and the persisted page would differ) and a whole cache (drops a whole series for one old month). User decision 67, row E6 option (a), 2026-11-16 (§2.9, §4.6, step 121)
