# N40: The Vite fetcher plugin

Row N40 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**A `@anishbenji/tscache/vite` subpath exporting `fetcherUrl()`**, with `vite` as an optional peer dependency, built as a Node-platform tsdown entry and tested by a programmatic Vite build (the fetcher chunk keeps its default export; a server build gets a file URL). The examples import it, so the Playwright `examples` project exercises it too. The supported Vite range is stated at step ⑯ (the environments API it uses is Vite 6 and later). Precedent: N6 added `./fetcher` for the same kind of ergonomics; starter §5 allows subpath exports with optional peers. Rejected: keeping the plugin in the guide (about forty-five lines of Vite internals that nothing outside the examples tests); a separate `@tscache/vite` package (starter §5 locks one published package); a second Rollup input with a manifest lookup (manual and brittle). User-confirmed 2026-10-23
