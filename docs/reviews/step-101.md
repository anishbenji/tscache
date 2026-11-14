# Step 101 — a fetcher-only deploy keeps the worker URL (docs correction)

Branch: `docs/101-fetcher-only-deploy` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: awaiting review

## Scope

Step 100 (the deploy-skew proposal, finding M5) found, and its pre-review confirmed on Vite 8.3.8, that a deploy which changes only the fetcher module keeps the hashed worker file name. After such a deploy a new tab joins the old SharedWorker, and `createClient` rejects with `ConfigError` until the old tabs close. The documentation said a hashed worker URL gives each deploy a SharedWorker of its own. This step corrects every statement that said or implied so, and documents the workaround the code supports today.

Documentation only: no code, no tests, nothing under `packages/` changes.

| Commit (by subject)                                       | What                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `docs: a fetcher-only deploy keeps the hashed worker url` | The corrections below; this file; the `docs/INDEX.md` sizes and the `docs/reviews/` file count |

## The mechanism, confirmed from the code

- **The worker bundle names no fetcher.** In a client build, `fetcherUrl()` emits the fetcher as a chunk of the page's build and gives the importing module its URL (`packages/tscache/src/vite/fetcher-url.ts:172-178`, `emitFile({ type: "chunk" })` and `import.meta.ROLLUP_FILE_URL_…`). The page imports that URL; the worker entry (`@anishbenji/tscache/worker?worker&url`) is tscache's own code and imports nothing of the app.
- **The client sends the fetcher's URL at connect.** `createClient` turns `fetcher.module` into a string (`packages/tscache/src/client/client.ts:100`) and sends it in the `init` message (`packages/tscache/src/rpc/protocol.ts:62`).
- **A worker runs one fetcher module.** `Orchestrator.load` refuses a different module on a later connection with `ConfigError("this worker already runs fetcher …; cannot also load …")` (`packages/tscache/src/orchestrator/orchestrator.ts:298-302`). The client rebuilds it as a `ConfigError` (`packages/tscache/src/rpc/protocol.ts:242`), and the fallback chain steps down only on `HostingError` (`packages/tscache/src/client/client.ts:144`), so `createClient` rejects.

So the worker file's hash depends on tscache's worker code, the worker format and the build tool's output, not on the fetcher.

**Probe (2026-11-14, Vite 8.3.5, Node 26.13).** After `bun run --filter '@anishbenji/tscache' build`, `examples/vanilla-uplot` was built twice with `vite build --configLoader runner` into the session's scratch directory: once with its own config, once with a scratch config (untracked, deleted after the run) that added a plugin appending `console.debug("probe-101");` to `examples/mock-backend/src/fetcher.ts`.

| Build            | Worker file          | Fetcher file          |
| ---------------- | -------------------- | --------------------- |
| unchanged        | `worker-_aG70VYQ.js` | `fetcher-DgZf2Phu.js` |
| fetcher modified | `worker-_aG70VYQ.js` | `fetcher-CzkDDj4Y.js` |

`cmp` found the two worker files identical byte for byte, and of the second build's assets only the page chunk `session-pFclZYBh.js` contains the fetcher's file name. This agrees with step 100's measurement on Vite 8.3.8 (`worker-_aG70VYQ.js`, es, unchanged while `fetcher-DfwwfM5A.js` became `fetcher-CfjmFMXx.js`); the iife format was not re-run here.

## What changed

| File                                    | Statement before                                                                                                                                | Now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site/guides/workers.md`, Stale scripts | "A hashed worker URL … gives each deploy a SharedWorker of its own"; skew detected "only as a protocol mismatch"                                | The worker URL changes when the worker bundle changes (tscache version, worker format, build output), not when only the fetcher does, with the reason and the probe. Three cases: hashed URL and a worker change (the old text), hashed URL and a fetcher-only change (`ConfigError` in new tabs until the old tabs close), fixed URL. Skew is detected when the worker refuses a connection, for a protocol mismatch or a second fetcher module. The workaround and the pointer to the M5 proposal |
| `site/index.md`, known limits           | "With a hashed worker URL, old and new tabs run separate SharedWorkers"; the `ConfigError` only "with a fixed URL"                              | Separate workers only for a deploy that changes the worker; a fetcher-only deploy rejects `createClient` with `ConfigError` until the old tabs close                                                                                                                                                                                                                                                                                                                                                |
| `site/troubleshooting.md`               | `this worker already runs fetcher` happens "usually … when the worker URL is fixed and the fetcher's is hashed"; the fix is a fixed fetcher URL | It happens with Vite's hashed names on any deploy that changes the fetcher but not the worker, and on every fetcher change with a fixed worker URL; the page can create its client again with `mode: 'dedicated'`                                                                                                                                                                                                                                                                                   |
| `docs/guides/patterns.md`, known limits | "with hashed worker URLs two deploys run two SharedWorkers side by side"                                                                        | Two SharedWorkers for deploys that change the worker; a fetcher-only deploy keeps the URL and new tabs get `ConfigError`; cites `fetcher-url.ts` and `Orchestrator.load`; points to the M5 proposal                                                                                                                                                                                                                                                                                                 |
| `docs/architecture.md` §4.10.7          | "Tabs of two deploys load different worker URLs, so each deploy has its own SharedWorker until the older tabs are gone."                        | Two worker URLs give two SharedWorkers; a hashed URL changes only with the worker bundle; after a fetcher-only deploy new tabs join the old worker and `createClient` rejects with `ConfigError`, one writer then. Marked "(Corrected 2026-11-14, step 101: …)". No design change                                                                                                                                                                                                                   |

Checked and left unchanged, since they state nothing wrong: architecture §4.10.1 "One writer" (two SharedWorkers write "during a deploy skew (two worker URLs)", which stays true), the rest of §4.10.7 (the fixed-URL case and the `extendedLifetime` note), `site/guides/persistence.md` ("a still-running worker of another deploy"), both READMEs (name deploy skew as a limit only), `docs/design/m7-change-events.md` (a design proposal; its skew cases stay accurate) and `site/usage/errors.md` (its `ConfigError` row lists invalid options and does not mention the fetcher refusal; adding it is outside this correction). `docs/reviews/2026-11-review.md` §3d and M5 say "each deploy gets its own SharedWorker" for hashed URLs; that file is historical and kept as written (`docs/INDEX.md`), and `docs/reviews/2026-11-review-update.md` belongs to the director.

## The workaround today

- **`mode: 'dedicated'` after the `ConfigError`.** The page is the newer side: it names the new fetcher. A dedicated worker is a new `Worker` on the same URL (`packages/tscache/src/client/hosting.ts`, `openDedicated`) with an orchestrator of its own, so it loads the new fetcher; the tab gets a cache of its own that persists nothing, as for a newer page's `ProtocolMismatchError`, until it is reloaded after the old tabs have closed. The guides already give this step for that error; the corrections extend it to this one. The other `ConfigError`s of `createClient` come from option validation (`packages/tscache/src/client/client.ts:83`, `:91`, `:108`) and are thrown before any worker starts.
- **No deploy-specific name.** The brief asked whether a SharedWorker `name` holding a deploy id could separate the workers. tscache passes none: `openShared` constructs `new SharedWorker(url, { type: "module", extendedLifetime: true })` (`packages/tscache/src/client/hosting.ts:120`), and `ClientOptions` has no option for it. A query string with a deploy id on `workerUrl` is not offered either: the workers guide already says that with Vite the worker's chunks import the worker file by its URL, so a query loads the worker twice (`site/guides/workers.md:86`).
- **The recovery** is designed by the deploy-skew proposal (finding M5, step 100), which had not merged into `main` when this step was cut, so the text names it without a link.

## Verification

| Command                                                              | Result                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `bun run docs:check`                                                 | Exit 0; `doc-anchors: 246 anchors in 42 pages resolve`                    |
| `~/code/tscache-reports/bin/heavy-run.sh "101 child: ci" bun run ci` | Run on the final head; the result is in the step's report to the director |

## Contract-test changes

None.

## Decision concerns

None.
