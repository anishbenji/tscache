# N49: Durability (P5)

Row N49 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Relaxed for flushes**: a lost flush loses only what is not covered on disk either (measured 0.50 ms against 0.57 ms per page; Chrome reports 3–30× in real workloads). **Strict for every write that carries a removal** (`clearAll`, an `invalidate`, a `clear`, a watermark moved back, a stop's deletion), added by the design: a removal is acknowledged as durable (N58), and a relaxed commit can be lost to a power failure, which would let a withdrawn range or a logged-out user's data come back. Widened from `clearAll` only at review round 1. Rejected: strict everywhere (additions do not need it). Director, 2026-10-30
