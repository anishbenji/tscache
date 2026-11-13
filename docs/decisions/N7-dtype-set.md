# N7: Dtype set

Row N7 of the decision table in `docs/architecture.md` §8 (N1–N8 user-confirmed 2026-06-11). The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

`f64 f32 i32 u32 i16 u16 i8 u8`. Excluded: `i64/u64` (BigInt interop friction — roadmap if demanded), `f16` (patchy 2026 support). Self-describing format makes additions non-breaking
