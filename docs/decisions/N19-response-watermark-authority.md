# N19: Authority of a response with its own watermark

Row N19 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Clipped to its own watermark**: a put carrying `meta.finalizedUntil` replaces and covers only slots below it; points at or beyond are upserted. Raised by the step ⑦ adversarial review: a late empty response reporting an older watermark would otherwise delete a provisional point and record it as a confirmed gap. Rejected: discard responses with an older watermark (throws away valid final data and can loop against a backend whose watermark lags); apply as is (weakest). Companion decision for step ⑪: the orchestrator stamps requests with the cache's version generation and drops responses from before the last version change, so a late old-version response cannot clear fresh data. User-confirmed 2026-10-06
