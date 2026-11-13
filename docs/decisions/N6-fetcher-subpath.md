# N6: `./fetcher` subpath

Row N6 of the decision table in `docs/architecture.md` §8 (N1–N8 user-confirmed 2026-06-11). The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Added** to the export list. Tiny module (AuthInvalidError + fetcher types, zero other imports) — lean fetcher bundles, no DOM-code-in-worker hazard. Auth-error detection is marker-based (`error.code === 'tscache:auth-invalid'`), never `instanceof` (separate bundles duplicate class identity)
