# N10: Segment internals

Row N10 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**`Segment` interface in slot terms** (`extent`, `size`, `lookup`, `slice`, `mergeFrom`, `transferPayload`) with `DenseSegment` and `segmentFromPayload`; contract in §4.2. The segment enforces the slot cap; split policy stays in the merge path. An invalid payload throws plain **`TscacheError`** (rejected: a new `PayloadError` class, which would add to §2.6). Field data is **little-endian, documented, no byte swapping** (rejected: explicit conversion on every transfer for platforms that do not exist in practice). User-confirmed 2026-10-04
