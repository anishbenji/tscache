# Step 53 — The examples build the worker as an ES module

Branch: `chore/53-examples-es-worker` · Status: awaiting review

The worker loads its persistence code (the persister and the IndexedDB adapter, `persist/lazy.ts`) with `import()` (§4.10.8). Vite builds workers as IIFE by default (`worker.format: 'iife'`), and an IIFE bundle cannot code-split, so Vite inlined that code into the worker file: every example and reference client downloaded it with the worker, whether a cache persisted or not. Step 38 recommended `worker: { format: "es" }` in the guides and left the examples on the default (I26 in `docs/reviews/step-38.md`). This step switches them. Implemented by a child agent of the director while the user was away; no package code changes.

## Scope

| Commit        | What                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| f13f172       | `chore(examples)`: `worker: { format: "es" }` in the nine Vite configs that bundle the tscache worker                                                                                                                            |
| ca1b7e8       | `docs(site)`: the `vite-config.ts` snippet (printed by the getting-started and Vite plugin guides) sets the format; the Vite guide says what it changes; `docs:run` checks the snippet sets it; the mock backend README notes it |
| (this commit) | this file                                                                                                                                                                                                                        |

### Configs

Changed: `examples/{react-lwcharts,react-ssr,solid-lwcharts,solid-ssr,solid-uplot,vanilla-uplot}/vite.config.ts` and `reference/{react,solid,vanilla}/vite.config.ts`. These are all the Vite configs in the repository outside the root `vitest.config.ts`, and each imports `tscache/worker?worker&url`.

- `site/`: a VitePress site, not an app; it bundles no worker. Its snippets run in `docs:run` under shims, with no worker. Only the `vite-config.ts` snippet, which shows users a config, changed.
- `integrations/`: framework adapters type-checked and tested under Vitest; no Vite config and no worker build. Nothing to change.
- `e2e/` serves the package's own `dist/` (`workerUrl = "/dist/worker.js"`), already ES modules with `lazy-*.js` a file of its own; unaffected.

### Docs

`docs/guides/worker-setup.md` and `site/guides/workers.md` already described the setting (step 38). The Vite plugin guide (`site/guides/vite.md`) and getting-started print the `vite-config.ts` snippet, which now includes it, and the Vite guide adds one paragraph: the setting is the worker's, not the plugin's, and applies to every worker the app builds, so a worker the app creates itself from a `?worker&url` import must be a module worker. The example READMEs do not show their configs; the mock backend README, which explains the examples' Vite setup, gained one sentence.

## Evidence

`examples/vanilla-uplot`, `bunx vite build --configLoader runner --outDir /tmp/es53-{before,after}` (Vite 8.3.4), before on `302cd65`, after with f13f172. Brotli at quality 11 and gzip at level 9 through Node's `zlib`.

| File                                                      | Raw      | gzip     | Brotli       |
| --------------------------------------------------------- | -------- | -------- | ------------ |
| before: `worker-DXbdgd01.js` (persistence inlined)        | 61,446 B | 19,152 B | 17,444 B     |
| after: `worker-AO6pw3BB.js`                               | 44,891 B | 14,362 B | **13,013 B** |
| after: `lazy-BIqNDVQU-fF9g4NDu.js`, the persistence chunk | 16,305 B | 5,710 B  | 5,254 B      |

A worker whose app persists nothing loads 4,431 B Brotli less (−25 %). A worker that persists loads 13,013 + 5,254 = 18,267 B in two requests, 823 B more than the inlined file, as two files compress separately.

After the change the worker loads the chunk with `import()` and the chunk imports the shared code back from the worker file:

```
worker-AO6pw3BB.js:        import(`./lazy-BIqNDVQU-fF9g4NDu.js`)
lazy-BIqNDVQU-fF9g4NDu.js: from"./worker-AO6pw3BB.js"
```

The only `indexedDB` left in the worker file is the feature check of `entries/worker.ts` (`"indexedDB" in globalThis`), before the `import()`. Building all nine apps with the change, each emits `worker-AO6pw3BB.js` and `lazy-BIqNDVQU-fF9g4NDu.js` (the SSR apps under `dist/client/assets/`), and each worker file holds the same `import()`.

The chunk importing the worker file by its URL is why the guides say to pass `workerUrl` exactly as Vite gives it: a query added to it would evaluate the worker's code a second time. No example or reference client adds one (each passes the imported `workerUrl` unchanged).

## Module workers

`client/hosting.ts` creates both workers as modules (§2.1): `new Ctor(url, { type: "module" })` for the SharedWorker (`openShared`, line 104) and for the dedicated worker (`openDedicated`, line 145). The examples pass `workerUrl` to `createClient` and create no worker of their own, so an ES-format worker file is what the client expects; with `'iife'` the file was a classic script that also runs as a module.

## The plugin question

Should `fetcherUrl()` (`packages/tscache/src/vite/fetcher-url.ts`) set `worker.format: 'es'`? It can: its `config` hook already returns `{ ssr: { noExternal: ["tscache"] } }`, and could return `{ worker: { format: "es" } }` when the user's config leaves `worker.format` unset (Vite merges a `config` hook's result over the user's config, so an unconditional value would override an explicit `'iife'`; the hook receives the user's config and can check first). Options:

| Option                                       | For                                                                                                   | Against                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Document only (this step)                 | No change to the plugin's scope (the fetcher module, N40/N41); never touches the user's other workers | Users who skip the guide pay for persistence up front, silently                                                                                                                                                                                           |
| B. Default it when unset                     | Right size without reading the guide; explicit choices win                                            | Changes the format of every worker the app builds, so an app's own classic worker created from `?worker&url` without `{ type: 'module' }` breaks in production builds only (dev serves module workers anyway); widens the plugin's job beyond the fetcher |
| C. Warn when the resolved format is `'iife'` | Visible to everyone; changes nothing                                                                  | One more message in the build output; needs a way to tell whether the app bundles `tscache/worker` to stay quiet otherwise                                                                                                                                |

**Recommendation: C**, with A in place now. It keeps the plugin from changing behaviour the app owns while making the cost visible; B is acceptable if the user prefers zero configuration, and should then say so in the guide. Either needs a package change and a review round, so this step changes no `packages/tscache/src`.

## Tests

Pragmatic tests, as for scaffolding. `docs:run` gains a check that the printed Vite config sets the format; flipping the snippet to `'iife'` makes it fail (`✗ vite-config.ts: the worker is not built as an ES module`), and it passes with `'es'`. The Playwright suite in `bun run ci` runs the examples and reference clients against their builds.

## Not verified

- No browser run of a persisting cache in an example build: the examples do not set `persist: true`, so the lazy chunk is fetched only by `e2e/persist.spec.ts`, which uses the package's `dist/` rather than a Vite build. `packages/tscache/test/vite-worker.test.ts` checks Vite's ES output for the split and for the absence of the preload helper.
- No measurement of start-up time; only file sizes.
- Behaviour with Vite versions other than 8.3.4.
