# N41: Scope of `@anishbenji/tscache/vite`

Row N41 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**`fetcherUrl()` only.** `ssrPage()` stays in the examples: it encodes example choices (the `index.html` placeholders, `/` only, `vite build --app`, `require()` of the server bundle in preview), and the library has no opinion on page rendering. webpack needs nothing: its users serve `dist/` and the fetcher as plain files. Rejected: shipping `ssrPage()` as well. User-confirmed 2026-10-23. **Amended 2026-11-10 (records approved behaviour):** since step 54 (PR #84), `fetcherUrl()` also warns once per client build when a browser environment builds workers with `worker.format: 'iife'`, which inlines the worker's persistence chunk. There is no option to turn the warning off (user decision #18, 2026-11-02, option A: no new public API), and its opening words, `[tscache] Vite builds workers as IIFE`, are a stable contract that an app's logger filter may match (step 56, PR #85). `fetcherUrl()` is still the entry's only export.
