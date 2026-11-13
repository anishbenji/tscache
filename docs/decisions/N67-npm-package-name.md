# N67: npm package name

Row N67 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**`@anishbenji/tscache`, public, under the author's npm user scope** (supersedes §7 #1's unscoped `tscache`). npm refuses the unscoped name: it strips punctuation before comparing names, so `tscache` collides with the existing `ts-cache`. Only the import specifier changes. The library is still called tscache in prose, its log messages keep their unscoped prefixes (`[tscache] ` from the Vite plugin, `tscache: ` from the development warnings), its IndexedDB database stays `tscache` (N51), and the auth marker stays `tscache:auth-invalid` (N8), so no stored data or fetcher bundle changes. An organisation scope may replace the user scope later; that is a republish under the new name plus a deprecation notice on this one. Rejected: an unscoped new name such as `seriescache` (loses the project's name, and every later project of the author needs a free unscoped name of its own); an organisation scope now (its name, domain and namespaces are still open). User decision, 2026-11-04
