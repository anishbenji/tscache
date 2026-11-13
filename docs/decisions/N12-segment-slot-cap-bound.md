# N12: Upper bound on `segmentSlotCap`

Row N12 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**At most 2^31 − 1**; a larger value is rejected with `ConfigError`. The presence mask is indexed with 32-bit integer arithmetic, which is exact only below 2^31 slots, and a segment that large (over 2 GB per field) could not be used anyway. Rejected: a lower practical limit such as 2^24 (an arbitrary number to defend); no limit with division-based indexing (slower on the hottest loops and not testable without a 2 GB allocation). User-confirmed 2026-10-04
