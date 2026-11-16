# N82: What a removed range reports

Row N82 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The coverage actually withdrawn, never slots that were not covered.** It is computed with one `CoverageIndex.covered` lookup before each subtraction, only while a reader listens: for `invalidate`, a watermark withdrawal (a first watermark, or `setFinalizedUntil` moved back), and the withdrawal after a failed write. An `invalidate` over nothing covered therefore sends nothing, and a watermark withdrawal is finite. Rejected: the requested range, covered or not, as the persistence hook reports it (spurious fetching re-reads, and a watermark withdrawal reaches `Number.MAX_SAFE_INTEGER` slots, which is no valid ms range). User decision 65, row D12 option (a), 2026-11-16 (§4.5, step 114)
