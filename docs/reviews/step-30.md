# Chore 30 — Local demo hub

Branch: `chore/30-demo-hub` · Reviewer: Codex (high) · Rounds: 1 · Status: fixes in, awaiting round 2 · Verdict after triage: merge after round 2

One command that shows and launches every sample app: `bun run demo`. Requested by the director while the user was away, under the user's grant of 2026-10-30; built by a Claude Opus 5.5 subagent. Tooling, not a commit-plan step: no package, example or reference-client code changes.

## Scope

| Commit | What |
|---|---|
| 6fa7d2a | `chore(demo)`: `scripts/demo.ts` builds the package and the nine apps of `e2e/examples/apps.ts` (`--reuse-builds`: only those without a `dist/`), runs each app's own `vite preview` (its mock backend included) on `DEMO_PORT + 1` to `+ 9`, waits until each answers, then serves the hub with `Bun.serve` on `DEMO_PORT` (default 5400), 127.0.0.1 only. `scripts/demo/catalog.ts` lists every page with a description, "what to look for" and the probes the spec checks; `scripts/demo/hub.ts` renders the hub page, streams each backend's `/api/stats` once a second as Server-Sent Events (`/stats`), and forwards three controls (`expireAccess`, `dropStreams`, `bumpVersion`) to an app's `/api/control` (`POST /control/<app>`). `bun run demo` in `package.json`; a "Demo hub" section in `README.md` |
| daca034 | `test(e2e)`: `e2e/demo/hub.spec.ts` in a new `demo` Playwright project (`retries: 0`): the hub links exactly the catalog's pages and the catalog covers every app in `apps`; each of the 23 pages opens from its hub link and shows its ready status, a positive data count and a chart canvas, and the panel shows a positive fetch count for its backend; the panel's Expire token makes an open `react-lwcharts` page rotate its token once. The demo's web server comes last in `playwright.config.ts`. After rebasing onto chore 25 (#47), the demo's server gets `DEMO_PORT = 5400 + offset` (the checkout's offset, exported from `e2e/examples/apps.ts`) unless `DEMO_PORT` is set |
| 3e3f897 | `fix(demo)`: R1-1, R1-2 |
| cda83a7 | `test(e2e)`: R1-3 |

## Decisions made in the step

Taken by the subagent under the grant (logged for the user).

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | Reuse each app's `vite preview` and its built-in mock backend, as the example specs do; the hub is a Bun server that only links, reads and forwards | Nothing duplicated: the SSR pages and the backends' sockets already run inside `vite preview`. The hub reads and forwards server-side, so the apps need no CORS | One Bun server serving every `dist/` and the backend (would re-implement the SSR rendering and the WebSocket upgrade) |
| D2 | One port knob, `DEMO_PORT` (default 5400); apps on the next nine ports in the order of `apps` | Distinct from the example specs' ports (51xx, 52xx), so the demo and the suite run side by side; under chore 25's per-checkout offsets the Playwright run passes `5400 + offset` as `DEMO_PORT` (done in the rebase) | An offset from each app's spec port |
| D3 | Playwright starts the demo last with `--reuse-builds` | Playwright sets its web servers up one after another (`TaskRunner` runs its tasks in sequence), so the example servers have built every app by then; a rebuild would empty a `dist/` another server is serving. Apps left out by `E2E_EXAMPLES` are built by the demo, whose servers are then the only ones | Building into a separate output directory (the SSR plugin fixes `dist/client` and `dist/server`) |
| D4 | The live panel shows backend counters (fetches, refused, refreshes, open streams, data version), not cache events | Cache events stay inside each page's origin and worker; the hub is another origin and the apps were not to change. The fetch count is what shows a shared cache saving fetches | Changing every app to publish its events to the hub |
| D5 | Panel buttons for the backend's controls | The reference clients have no expire button; the controls make credential refresh and feed recovery demonstrable from the hub | Leaving those scenarios to the specs |
| D6 | The backend's stats fields declared in `scripts/demo/hub.ts` instead of importing `BackendStats` | The root TypeScript project has no path mapping to the package's source, and the backend module's graph imports `tscache`, unbuilt when `bun run ci` type-checks | A `paths` entry in the root `tsconfig.json` |
| D7 | Each page in its own test, opened from the hub in the hub's context | The spec proves the hub's links work; one test per page keeps a failure specific | One test walking all pages |

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | With `DEMO_PORT` in use, `Bun.serve()` throws after the nine previews have started and nothing stops them, so they keep their ports and a retry cannot bind | Accept. Reproduced by hand: with port 5900 held, the launcher exited and nine `vite preview` servers stayed on 5901–5909. The new test failed on the old launcher too (it never ended; 2-minute timeout) | 3e3f897: startup runs in `start()`, whose failure goes through `stop()`, which kills every child. `e2e/demo/launcher.spec.ts` holds a hub port 100 above the suite's demo, runs the launcher, and expects a non-zero exit, `EADDRINUSE` on stderr and all nine app ports free again. Passes after the fix |
| R1-2 | P1 | Subprocess `cwd` comes from a URL's `pathname`, so a checkout path with a space reaches the subprocess percent-encoded | Accept. Confirmed by reading: `new URL("file:///a b/").pathname` is `/a%20b/` | 3e3f897: `fileURLToPath(root)` for both subprocess directories. No test: it would need a checkout under a path with a space |
| R1-3 | P1 | Only `expireAccess` is tested; broken forwarding of `dropStreams` or `bumpVersion`, or acceptance of an unknown app or control, would pass | Accept. Confirmed by reading the spec | cda83a7: Restate history moves `solid-uplot`'s backend from `vN` to `vN+1` in the panel; Drop streams makes an open `reference-vanilla` page reopen its feed and fetch to mend it, counted from that page's own fetch notices; `POST /control/no-such-app` and an unknown control (`resetClock`) answer 400 |

## Verification

- `bun run demo` by hand: all builds succeeded, the hub answered 200 at `http://127.0.0.1:5400/`, every app page (`5401/`, `5401/events.html`, `5402/`–`5406/`, `5407/`, `5407/ssr`, `5408/ssr`, `5409/ssr`) answered 200, and `/stats` streamed every app's counters (the SSR apps already showed the server's fetches). SIGINT to the demo process left no listener on 5400–5409.
- `E2E_EXAMPLES=demo bunx playwright test --project=demo`: 24 passed in 18.2 s.
- `bunx tsc -p .`, `bunx tsc -p e2e`, `bunx knip`, `bun run fallow`, `bunx biome check`: clean.
- Round 1: `E2E_EXAMPLES=demo bunx playwright test --project=demo`: 28 passed in 18.4 s.
