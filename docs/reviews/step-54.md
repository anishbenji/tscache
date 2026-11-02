# Step 54 — The Vite plugin warns about an IIFE worker build

Branch: `feat/54-vite-iife-warning` · Status: awaiting review

Vite builds workers as IIFE by default (`worker.format: 'iife'`). An IIFE bundle cannot code-split, so the tscache worker's `import()` of its persistence chunk (§4.10.8) is inlined into the worker file and every app downloads that code, whether a cache persists or not (step 53 measured 4,431 B Brotli on `examples/vanilla-uplot`). Step 53 documented `worker: { format: "es" }` and left open whether `fetcherUrl()` should act on it (options A, B and C in `docs/reviews/step-53.md`, "The plugin question"). The director chose option C under the standing grant: the plugin warns at build time. Implemented by a child agent of the director while the user was away.

## Scope

| Commit        | What                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 27a86b0       | `feat(vite)`: `fetcherUrl()`'s `configResolved` hook logs one warning through `config.logger.warn` when the command is `build` and the resolved `worker.format` is `'iife'`; `packages/tscache/test/vite-iife-warning.test.ts`                                      |
| 44d206a       | `docs(vite)`: the Vite plugin guide (`site/guides/vite.md`), the workers guide (`site/guides/workers.md`), the worker setup guide (`docs/guides/worker-setup.md`) and the module layout in `docs/architecture.md` say the plugin warns and never changes the format |
| (this commit) | this file                                                                                                                                                                                                                                                           |

The package has no README of its own (`packages/tscache/` holds none), so there was no subpath README to update.

## Decisions

- **Option C, as the director chose:** warn, never change the config. Option B (default the format when unset) was rejected because the format applies to every worker the app builds, so an app's own classic worker would change format in production builds only.
- **Where:** `configResolved`, which already reads `command` and `base`. It runs once per resolved config; a `warned` flag in the plugin instance keeps the warning to one per build even if the hook runs again. `config.logger.warn` prints through Vite's logger, so the message appears in the normal build output and honours `logLevel` and `customLogger`.
- **When:** only for `command === "build"`; the dev server never warns (it serves module workers whatever the format). No warning for `'es'`.
- **Unconditional on whether the app bundles `tscache/worker`.** Step 53 noted option C "needs a way to tell whether the app bundles `tscache/worker` to stay quiet otherwise". `configResolved` runs before any module is resolved, so it cannot know; a later hook could, at the cost of inspecting the bundle. I did not add that: an app that installs `fetcherUrl()` hosts a tscache client, and the only app that would see a needless warning is one that never gives `createClient` a `workerUrl` (in-process only), for which `worker: { format: "es" }` is harmless. Recorded for the reviewer.
- **The message** names the fix and links the guide paragraph from step 53 on GitHub, since the site has no published URL:

  > [tscache] Vite builds workers as IIFE ('iife', its default), which cannot code-split: the tscache worker's persistence code is inlined into the worker file, so every app downloads it, persisting or not. Set worker: { format: 'es' } in vite.config.ts to make it a chunk the worker loads only when a cache persists. See https://github.com/anishbenji/tscache/blob/main/site/guides/vite.md

- **API:** `fetcherUrl()` and its export are unchanged. The `FetcherUrlPlugin` interface's `configResolved` parameter now also declares `worker.format` and `logger.warn`, the two parts of Vite's `ResolvedConfig` the hook reads; the shape is inline in the signature (a named interface made TypeDoc fail `docs:build` with an undocumented-reference warning). The examples' type check of their `vite.config.ts` (`tsc -p examples/vanilla-uplot`, `react-ssr`, `solid-ssr`) confirms the plugin still fits Vite 8's `Plugin`.
- **Locked decisions:** none changed. N41 (`fetcherUrl()` only) still holds: the warning is part of `fetcherUrl()`, not a new export. Architecture §8 is unchanged; the module layout (§4, `vite/fetcher-url.ts`) gained the note.

## Tests

Test-first, pragmatic (plugin wiring, not engine logic). `packages/tscache/test/vite-iife-warning.test.ts`, eight tests: six call `configResolved` with a stub config whose logger records warnings (build/iife warns once with the fix and the link; a second resolve does not warn again; build/es, serve/iife and serve/es stay quiet; the config's format is left `'iife'` and `config()` returns no `worker` key), and two run a real Vite build with a recording `customLogger` and `build.write: false` (Vite's default format warns once; `worker: { format: "es" }` stays quiet), which checks that Vite's real `ResolvedConfig` carries the fields the hook reads.

Red, before the implementation (`bunx vitest run packages/tscache/test/vite-iife-warning.test.ts`):

```
 Test Files  1 failed (1)
      Tests  3 failed | 5 passed (8)
```

The three failures were the warning cases (unit warn-once, unit warn-only-once, real build with the default format). The five quiet cases pass before and after, as they should.

Green, after (`bunx vitest run packages/tscache/test/vite-iife-warning.test.ts packages/tscache/test/vite-fetcher-url.test.ts`): `Test Files 2 passed (2) · Tests 25 passed (25)`.

Also run: `bun run typecheck` (exit 0), `bunx biome check packages/tscache` (no findings), `bun run docs:build` (pass after the inline-shape fix), `bun run docs:check` (exit 0), `bun run docs:run` (pass), and the full `bun run ci` below.

## Sizes

`bun scripts/size.ts`, all rows ok. The `vite` entry, Brotli: 0.95 kB before (970 B, recorded in earlier step reviews) → 1.16 kB after, against a budget of 1.45 kB (1,488 B). The message is most of the growth. The budget fits, so it is not raised. Every browser entry is unchanged: the plugin is the Node-platform `./vite` entry only.

| Entry    | Minified | Gzip     | Brotli   | Budget   |
| -------- | -------- | -------- | -------- | -------- |
| `vite`   | 2.42 kB  | 1.33 kB  | 1.16 kB  | 1.45 kB  |
| `worker` | 45.00 kB | 14.47 kB | 13.01 kB | 13.41 kB |

## CI

`~/code/tscache-reports/bin/heavy-run.sh "child: ci 54" bun run ci` on the branch with this file: exit 0. Vitest: 110 files, 2,120 tests passed. Playwright: 162 passed (1.9 min); the `[WebServer] … SIGTERM` lines are the preview servers being stopped at teardown. Size and bench smoke rows ok. A first run exited 1 only because Biome formats Markdown and this file's scope table was not yet formatted; `bunx biome check --write docs/reviews/step-54.md` fixed it before the second run.

## Not verified

- The warning's appearance in a terminal through Vite's default logger (colour, prefix): the real-build test uses a custom logger.
- A separate `vite build --ssr` server build warns as well, since its resolved config also has a worker format; with `vite build --app` (the SSR examples) the config resolves once. Not exercised by a test.
- Vite versions other than the one installed (8.x); `worker.format` and `logger` have been on `ResolvedConfig` since Vite 2.
- Builds of the examples were not inspected for the warning's absence beyond CI's Playwright run; all nine set `worker: { format: "es" }` since step 53.
