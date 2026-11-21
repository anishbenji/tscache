# N104: How a later removal over an evicted range reaches a view

Row N104 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 121 from the M3 design proposal (`docs/design/m3-memory.md`). Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**With a budget, each cache keeps the coverage it evicted, in a second coverage index.** A removal (`invalidate`, a watermark moved back or set for the first time) reports in `removed` what it withdrew plus the part of its range that is in that index, and drops that part from the index; a write drops what it touches from the index before it writes, since `written` reports it (so the withdrawal after a failed write finds none of it there); `clear`, `clearAll` and a version-mismatch clear empty it. A view still showing an evicted range therefore hears a later restatement, and no event names a range that was never cached. The index is kept also while nobody subscribes, and is computed into a report only for a subscriber. This qualifies N82: without a budget, `removed` is the coverage actually withdrawn. Rejected: reporting a removal's whole requested range with a budget (wakes views for ranges nobody cached) and not reporting it (a tab could show stale data indefinitely). User decision 67, row E21 option (a), 2026-11-16 (§2.7, §4.5, step 121)

## Amendment, 2026-11-21

User decision 96, option (B) (step 131): the pages a `restore` trims from its own cache stay out of that cache's evicted-coverage index. No reader has seen them: `cache()` resolves only after the load (§4.10.5), and the cache knew nothing before it. A later removal over them therefore lists only the coverage it withdrew, and no event names a range that no reader could have been shown. Another cache's pages evicted by the same enforcement still enter that cache's index. Rejected: indexing them as every other eviction (a spurious `removed`, the event E21 (a) was chosen to avoid). The change is one condition in `CacheState.evict` (§2.7, §4.5).
