# N82: What a removed range reports

Row N82 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 114 from the M7 design proposal (`docs/design/m7-change-events.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**The coverage actually withdrawn, never slots that were not covered.** It is computed with one `CoverageIndex.covered` lookup before each subtraction, only while a reader listens: for `invalidate`, a watermark withdrawal (a first watermark, or `setFinalizedUntil` moved back), and the withdrawal after a failed write. An `invalidate` over nothing covered therefore sends nothing, and a watermark withdrawal is finite. Rejected: the requested range, covered or not, as the persistence hook reports it (spurious fetching re-reads, and a watermark withdrawal reaches `Number.MAX_SAFE_INTEGER` slots, which is no valid ms range). User decision 65, row D12 option (a), 2026-11-16 (§4.5, step 114)

## Qualification, 2026-11-16

User decision 67, M3 row E21 option (a) (`docs/design/m3-memory.md`): a cache with a memory budget keeps an index of the coverage it evicted, and a removal from such a cache also reports in `removed` the part of its range that is in that index, so a later removal reaches views still showing evicted data. Memory budgets do not exist until M3 is built; without a budget this decision is unchanged. Eviction itself will be reported as a separate `evicted` list that needs no re-read (M3 row E16, option a), added by M3 as an optional field (architecture §2.7).
