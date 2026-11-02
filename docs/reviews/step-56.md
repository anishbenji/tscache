# Step 56 — Silencing the IIFE worker warning with a logger filter

Branch: `docs/56-vite-logger-filter` · Status: awaiting review

Step 54 made `fetcherUrl()` warn once when a browser environment builds with `worker.format: 'iife'`. The user chose (decision #18, option A for step 54 as built) to keep the plugin as it is and document how an app that keeps `'iife'` on purpose silences that one warning: a `customLogger` built from Vite's `createLogger()` whose `warn` drops messages that start with the warning's opening words. Those words become a stable contract. No new `fetcherUrl()` option (N41). Implemented by a child agent of the director.

## Scope

| Commit        | What                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7a15b1c       | `docs(site)`: the filter snippet `site/snippets/vite-logger.ts` (`#region filter`), the usage region `#iife` in `site/snippets/vite-config.ts`, its run in `site/scripts/run-snippets.ts`, four tests in `packages/tscache/test/vite-iife-warning.test.ts`, and the stable-contract comment next to the message in `packages/tscache/src/vite/fetcher-url.ts`           |
| 25d5ca5       | `docs(vite)`: the guide (`site/guides/vite.md`) gains "Keeping IIFE workers", which includes both regions, says the filter replaces `warn` on the same logger (Vite keeps `hasWarned` on it), matches with `startsWith`, passes every other message with its options, and states that the opening words are a stable contract; the paragraph on the warning links to it |
| (this commit) | this file                                                                                                                                                                                                                                                                                                                                                               |

The message text in `fetcher-url.ts` is unchanged; only a comment was added above it.

## Decisions

- **The filter** (`withoutTscacheIifeWarning(logger: Logger): Logger`) is the snippet's only export, named and explicitly typed, with only `import type { Logger } from "vite"`, so loading it pulls in no Vite. It keeps the original `warn`, assigns a new `warn` on the same object, and calls the original with `call(logger, message, options)` for every message that does not start with `[tscache] Vite builds workers as IIFE`. It does not wrap `warnOnce`: tscache warns through `warn`, and Vite's own `warnOnce` does not route through `warn`.
- **The usage region** `#iife` sits in `site/snippets/vite-config.ts`, after `#config`, as the spec asks. A module cannot have two default exports or import `defineConfig` twice, so the region is a named export, `iifeConfig`, that imports only what it adds (`createLogger` and the filter); its header comment says the imports of the config above are needed too and that the config is the default export in an app. Biome's import organizer requires a blank line before the second import group, which leaves a blank line before `// #endregion config`; the built guide (`bun run docs:build`, inspected in `site/.vitepress/dist/guides/vite.html`) renders the `config` block without it, so the existing getting-started and Vite guide blocks are unchanged.
- **"Breaking change" wording:** the package is at 0.0.0, so the guide says tscache treats a change to the opening words as a breaking change, without naming a major version. The code comment says the same. Neither commit is marked `!`: this step does not change the words, it makes them a contract.
- **Locked decisions:** none changed. N41 holds: no new option or export of `tscache/vite`.

## Tests

`packages/tscache/test/vite-iife-warning.test.ts`, new `describe` "the IIFE warning's opening words are a stable contract (step 56)", four tests. Each builds a temporary app with `vite.build({ worker: { format: 'iife' }, build: { write: false } })`, `fetcherUrl()`, and a second plugin that warns `"another warning"` with `{ timestamp: true }` through `this.environment.config.logger`, the logger tscache's warning goes through. The snippet is loaded through the file's `load()` helper from a URL computed at runtime, never a static import, so neither Vite's types nor Node's enter the package's type check; `docs:check` type-checks the snippet.

1. `without a filter, the warning reaches customLogger.warn and starts with "[tscache] Vite builds workers as IIFE"`: exactly one tscache message, through `warn`, starting with those words.
2. `with the guide's filter, the build logs no IIFE warning and passes another warning through unchanged`: no recorded `warn` or `warnOnce` call mentions IIFE, and the other warning's call is deep-equal to the one the same logger receives in an unfiltered build. Vite's environment logger adds its own `environment: "(client)"` option to a plugin's options, so "unchanged" is checked against the unfiltered call, which is itself checked to carry `{ timestamp: true }`.
3. `the filter drops only messages that start with the opening words`: a message that quotes the words after other text is logged, with its options (startsWith, not includes).
4. `the filter returns the logger it was given, not a copy`.

Red, before the snippet existed (`bunx vitest run packages/tscache/test/vite-iife-warning.test.ts`, tests 1, 2 and 4 written; test 3 was added after):

```
 ❯ the IIFE warning's opening words are a stable contract (step 56) (3)
   × with the guide's filter, the build logs no IIFE warning and passes another warning through unchanged
   × the filter returns the logger it was given, not a copy
Error: Cannot find module 'file:///…/site/snippets/vite-logger.ts'
      Tests  2 failed | 12 passed (14)
```

Test 1 passes before and after, as it should: it pins the existing message.

Green, after: `Tests 15 passed (15)` (eleven from step 54, four new).

Mutation checks on the snippet, each undone afterwards: `startsWith` replaced by `includes` fails test 3 (`1 failed | 14 passed`); a filter that drops nothing fails tests 2 and 3 (`2 failed | 13 passed`).

`docs:run` gains the run "vite-config.ts, vite-logger.ts": the `iifeConfig` logger, a real `createLogger()` writing to the console, drops a message starting with the opening words, logs another one, and sets `hasWarned`. Also run: `bunx tsc --noEmit -p packages/tscache` (exit 0), `bun run docs:check` (exit 0; a first version failed TS2367 on a narrowed `logs.length` comparison in `run-snippets.ts`, fixed), `bun run docs:run` (all ok, `ok vite-config.ts, vite-logger.ts`), `bun run docs:build` (pass), `bunx biome check site packages/tscache/src/vite packages/tscache/test/vite-iife-warning.test.ts` (no findings).

## CI

`~/code/tscache-reports/bin/heavy-run.sh "child: ci 56" bun run ci` on c730e82: exit 0. Vitest: 110 files, 2,127 tests passed. Playwright: 162 passed (2.0 min). `docs:run` reports `ok vite-config.ts, vite-logger.ts`; size and bench smoke rows ok. The package's code is unchanged apart from a comment, so the entry sizes are unchanged.

## Not verified

- The filter against Vite versions other than the installed Vite 8.
- An app's real `vite build` from the command line with the filter; the tests use Vite's JavaScript API (`build()`) with an inline config, and `docs:run` calls the configured logger directly.
- A watch build or `vite build --app` with the filter (the step 54 tests cover the warning itself in those modes).
