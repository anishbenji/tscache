# Chore 30 — Local demo hub

Branch: `chore/30-demo-hub` · Reviewer: Codex (high) · Rounds: 4 · Status: fixes in, awaiting round 5 · Verdict after triage: merge after round 5

One command that shows and launches every sample app: `bun run demo`. Requested by the director while the user was away, under the user's grant of 2026-10-30; built by a Claude Opus 5.5 subagent. Tooling, not a commit-plan step: no package, example or reference-client code changes.

## Scope

| Commit | What |
|---|---|
| 6fa7d2a | `chore(demo)`: `scripts/demo.ts` builds the package and the nine apps of `e2e/examples/apps.ts` (`--reuse-builds`: only those without a `dist/`), runs each app's own `vite preview` (its mock backend included) on `DEMO_PORT + 1` to `+ 9`, waits until each answers, then serves the hub with `Bun.serve` on `DEMO_PORT` (default 5400), 127.0.0.1 only. `scripts/demo/catalog.ts` lists every page with a description, "what to look for" and the probes the spec checks; `scripts/demo/hub.ts` renders the hub page, streams each backend's `/api/stats` once a second as Server-Sent Events (`/stats`), and forwards three controls (`expireAccess`, `dropStreams`, `bumpVersion`) to an app's `/api/control` (`POST /control/<app>`). `bun run demo` in `package.json`; a "Demo hub" section in `README.md` |
| daca034 | `test(e2e)`: `e2e/demo/hub.spec.ts` in a new `demo` Playwright project (`retries: 0`): the hub links exactly the catalog's pages and the catalog covers every app in `apps`; each of the 23 pages opens from its hub link and shows its ready status, a positive data count and a chart canvas, and the panel shows a positive fetch count for its backend; the panel's Expire token makes an open `react-lwcharts` page rotate its token once. The demo's web server comes last in `playwright.config.ts`. After rebasing onto chore 25 (#47), the demo's server gets `DEMO_PORT = 5400 + offset` (the checkout's offset, exported from `e2e/examples/apps.ts`) unless `DEMO_PORT` is set |
| 3e3f897 | `fix(demo)`: R1-1, R1-2 |
| cda83a7 | `test(e2e)`: R1-3 |
| 43cc3d1 | `test(e2e)`: the launcher test spawns `scripts/demo.ts` by its absolute path; Knip read the relative argument as an import from `e2e/demo/` and failed `bun run ci` |
| fc5c11b | `fix(demo)`: R2-1, R2-2 (the lifecycle redesign below) |
| 4b5b4cd | `test(e2e)`: the Expire token test waited until the page's next poll for `ok`; reverted by 5ad16b7 (D10) |
| 5ad16b7 | `revert`: 4b5b4cd |
| 313435a | `test(e2e)`: the tests on demo apps with shared backend state run one at a time in a `demo-shared` project (D10) |
| 4356e7b | `test(e2e)`: R3-1 |
| a74f64d | `docs(demo)`: R3-2 |
| aa91fcc | `docs(site)`: a Demo hub page in the documentation site (`site/guide/demo.md`, in the Introduction sidebar), and the hub links the site (`bun run docs:dev`) |
| eab3eb7 | `fix(demo)`: R4-1 |

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

## Round 2 — reviewer verdict: merge after fixes

The convergence check (`docs/workflow.md`, step 7) fired: process cleanup in the launcher drew P1s in rounds 1 and 2, so the lifecycle was redesigned instead of patching another exit path. `scripts/demo/processes.ts` registers every subprocess, builds and app servers alike, each in a process group of its own. One `shutdown()` in `scripts/demo.ts`, which every way out takes (a failed build or server, the hub's port in use, SIGINT, SIGTERM, SIGHUP), sends SIGTERM to every group, then SIGKILL to what remains after 3 s, and exits only once every group is gone.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | In the reviewer's host `bun run ci` the launcher test exceeded 120 s; cause unknown | Accept. Reproduced in the full suite under CPU load (one `yes` per core): the same 2.0 m timeout. Instrumented, the launcher had exited with code 1 after 1.2 s and every app port was free; the test then hung in `finally` on `close(taken)`. `lsof` showed an established connection to the held hub port from the T3 Code app (it probes new local listeners and keeps the connection), and `net.Server.close()` waits for every connection to end. The test's failed assertion never surfaced because that wait came first. Not the launcher | fc5c11b: the spec's listeners destroy their open sockets on close. A second cause turned up in the repeat runs: ports picked by asking the system for port 0 come from the ephemeral range, where outgoing connections take their local ports, so a run found free was taken a moment later. Ports now come in a block per worker above the suite's own demo port (which carries the checkout's offset) and below the ephemeral range, each run checked free |
| R2-2 | P1 | Parallel builds are not tracked, so a failed build leaves its siblings writing `dist/` after the launcher exits | Accept. Confirmed by reading: `build()` spawned untracked processes, and `stop()` killed only the servers | fc5c11b: builds go through the same registry and shutdown. New test: `DEMO_BUILD_SCRIPT` (a test-only stand-in for every build) fails `solid-uplot`'s build once the eight other builds run, each with a child process of its own; the launcher exits 1, none of the 18 processes survives, and every port is free. With the group kill disabled (signalling the leader only), the test fails with 11 processes still running |

New tests besides R2-2's: SIGTERM to a running demo exits 143 and frees the hub's and every app's port. Every launcher test kills whatever it leaves (the launcher's group, recorded pids, any server on its ports) however it ends.

Decisions in this round:

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D8 | Playwright stops the demo with `gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 }` | Its default, SIGKILL to the launcher's process group, would miss the servers' own groups; on SIGTERM the launcher stops them and waits | Keeping the servers in the launcher's group (then a group kill from outside reaches them, but the launcher cannot kill a child's children without killing itself) |
| D9 | `DEMO_BUILD_SCRIPT`, a test-only environment variable that replaces every build command | A failed parallel build must be testable inside the Playwright suite without rewriting a `dist/` the example servers are serving | Failing a real build (rewrites shared `dist/`, slow) |
| D10 | The tests on apps whose backend state every browser context shares run in a `demo-shared` Playwright project with `workers: 1` (`e2e/demo/shared.spec.ts`): the Expire token and Restate history tests, and the launch tests of those two apps (`react-lwcharts`, `solid-uplot`), whose open pages take part. Every other demo test stays parallel; the assertions and their waits are as before. Replaces a widened wait (4b5b4cd, reverted at the director's ruling, child-rules item 6) | The race is in shared state, not the assertion: `react-lwcharts`'s backend holds one token pair for every context, so when parallel runs expire it, the first context to refresh makes the others' refresh tokens stale (`reused`), and their sessions end (`auth` reads `pending`, which also stands for `lost`). An assertion on the page's own refresh (option b) would fail the same way, since that refresh is what gets refused. Shown with `--repeat-each 6 --workers 6` on the Expire token test: the old placement failed 5 of 6; `demo-shared` passed 6 of 6 on one worker | A session key in the mock backend (option a: its tokens are global across login, refresh, series and the socket path, all shared by the examples); a cross-worker file lock (tried: its wait counted against each test's timeout, and a fixture's teardown order released it before the page closed) |
| D11 | `pgrep` in Knip's `ignoreBinaries` | The spec uses the system tool to find leftover servers | Listing processes by hand |

## Round 3 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | The launcher spec's fallback cleanup calls `pgrep -f "--port N --strictPort"`; pgrep reads the pattern as an option and exits 2, and the catch hides it, so servers a launcher left behind keep their ports | Accept. Reproduced: `pgrep -f "--port 1 --strictPort"` prints `illegal option -- -` and exits 2. A new test failed before the fix with all nine servers still running (killed by hand afterwards) | 4356e7b: the pattern follows `--`, and any pgrep exit but 1 (no match) fails the test. New test: the launcher is killed with SIGKILL alone, so its shutdown never runs; the servers outlive it, and the cleanup must stop them and free every port. Passes after the fix |
| R3-2 | P2 | The worker-loss guidance says to close the tab that created the worker; the SharedWorker survives a close, so no `workerLost` fires | Accept. Confirmed against `examples/react-lwcharts/README.md` ("Losing the worker") | a74f64d: crash that tab (`chrome://crash`), and closing it is described as losing nothing |

The documentation site landed on `main` while this round was open: aa91fcc adds its Demo hub page and a link to it from the hub. `docs:check`, `docs:run` and `docs:build` pass.

## Round 4 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R4-1 | P1 | A build's process group stays registered after the build exits, so stopping the demo could signal that id after an unrelated group has taken it | Accept. Confirmed by reading: `#groups` only ever grew. With retirement disabled, the new unit tests for it fail (2 of 6) | eab3eb7: a group is registered only while it has a member. The leader's exit probes the group (`kill(-pgid, 0)`) and retires it at once if empty; a group whose leader left children behind is probed every 250 ms until empty. Stopping signals only registered groups that still have members and retires each as soon as it empties. Unit tests (`scripts/demo/processes.test.ts`, Vitest, now in its `include`) with a recording `kill` |

Launcher cleanup has drawn a finding in every round (R1-1, R2-1, R2-2, R3-1, R4-1), so the whole of `scripts/demo/processes.ts` was re-read for any other way a stale id could be signalled or a group missed:

| Path | What happens now |
|---|---|
| A spawn that fails (no pid) | Never registered, so never signalled |
| A leader that exits, with or without a signal, while its group is empty | Retired in the exit handler, before anything else can run; never signalled |
| A leader that exits while children remain | A pid is never handed to a new process while a process group with that id exists, so the id still names our group; probed every 250 ms and retired once empty. Residual window: between the last member's exit and the next probe (at most 250 ms; 50 ms during a stop) the id is free but registered, so a reuse would need the pid counter to wrap within that window |
| Shutdown | Probes every registered group before each signal and signals only those with members; an error from the signal (the group emptied in between) retires it |
| The SIGKILL pass | Goes only to groups still registered after the grace period, each probed again first; groups that emptied after SIGTERM were retired during the wait |
| A probe answering EPERM | The id now names another user's process: retired, never signalled (previously counted as alive) |
| `start()` during or after a stop | Throws, so no group appears that the stop did not see |
| `stop()` called twice | Returns the same promise; one SIGTERM and at most one SIGKILL pass |
| The sweep timer | Unreferenced, so it never keeps the launcher alive; cleared once no group awaits its children |
| The launcher killed with SIGKILL | Nothing in the process can run; Playwright stops it with SIGTERM (D8), and the launcher spec's fallback cleanup covers its own runs (R3-1) |

## Verification

- `bun run demo` by hand: all builds succeeded, the hub answered 200 at `http://127.0.0.1:5400/`, every app page (`5401/`, `5401/events.html`, `5402/`–`5406/`, `5407/`, `5407/ssr`, `5408/ssr`, `5409/ssr`) answered 200, and `/stats` streamed every app's counters (the SSR apps already showed the server's fetches). SIGINT to the demo process left no listener on 5400–5409.
- `E2E_EXAMPLES=demo bunx playwright test --project=demo`: 24 passed in 18.2 s.
- `bunx tsc -p .`, `bunx tsc -p e2e`, `bunx knip`, `bun run fallow`, `bunx biome check`: clean.
- Round 1: `E2E_EXAMPLES=demo bunx playwright test --project=demo`: 28 passed in 18.4 s.
- Round 2: `E2E_EXAMPLES=demo bunx playwright test --project=demo --repeat-each 3`: 90 passed in 32.8 s; the launcher spec `--repeat-each 5` under CPU load: 15 passed; no `vite preview` left afterwards. By hand: SIGINT to a running demo exits 130 with no listener or server left, each server leading its own process group.
- D10: `--repeat-each 6 --workers 6` on the Expire token test: in the parallel project (the original placement and assertion) 5 failed with `auth` `pending`; in `demo-shared`, 6 passed on one worker.
