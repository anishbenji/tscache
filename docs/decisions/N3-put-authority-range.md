# N3: `put` authority range

Row N3 of the decision table in `docs/architecture.md` §8 (N1–N8 user-confirmed 2026-06-11). The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

`options.range` optional; **default = batch's own span `[t₀, tₙ]`** (safe, streaming-friendly). Explicit range (validated to contain all points) claims flank emptiness as confirmed real gaps. Orchestrated path passes the fetch's requested range automatically. Rejected: always-required range (ceremony)
