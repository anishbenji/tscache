# N20: Scope of the `cache()` config conflict

Row N20 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Every resolved field except the dataset ones must match**: `interval`, `alignmentOffset`, `fields`, `gapSplitK`, `segmentSlotCap`, `warnOnOverlapDiff`, and `persist` since N45 (they shape the layout or cross-tab behaviour) → `ConfigError` on mismatch. `version` and `finalizedUntil` apply at creation only and are ignored by a joining tab, so a stale tab cannot clear or rewind the live cache. Rejected: grid and schema only, rest first-creator-wins (a tab asking for warnings would silently get none); everything must match (tabs started minutes apart with a moving `finalizedUntil` would reject each other). User-confirmed 2026-10-07
