# Step 89 — The demo recorder, with a tested timeout and a launcher fix

Branch: `chore/89-demo-recorder-v2` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: built, not yet reviewed · Verdict after triage: pending

## Scope

Step 65 (#112) shipped the demo media without the script that recorded them. The recorder drew a finding in every review round of step 65, all in its interrupt and timing handling, and under the stop rule (pending decision 54, option A) it left that pull request after round 4 and returns here. Its history stays in `docs/reviews/step-65.md` and is not repeated: "The demo recordings" describes the recorder, its stage, its checks and the clips; the pre-review, Round 1 to Round 4 sections and the pre-reviews between them hold its findings (PR-1, PR-3, PR-4, PR2-1, PR2-2, R1-1, PR3-1, PR3-2, R2-1, PR4-1, PR4-2, PR5-1, R3-1, PR6-1 to PR6-3, R4-2) and the security lane's S4.1; "Round 4" lists what moved. The finding checks are in `~/code/tscache-reports/reviews/step-65/check-*.md` and the security lane's runs in `security-*.md` beside them.

This step brings the recorder back unchanged, then closes the two findings step 65 left open:

- **R4-2 (P1), round 4:** the backend-request timeout, accepted before round 4 as PR6-3, had no test.
- **S4.1 (P2), security lane run 4:** the demo launcher accepted an app once anything answered on its port, and printed the hub line even after its shutdown had begun, so a process that took an app's port during the build could be taken for the app and sent the recorder's controls.

Nothing under `packages/tscache/src/` changes, no dependency is added, and no media is recorded again: neither fix changes what the clips show.

| Commit (by subject)                                                 | What                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chore(demo): bring the demo recorder back from step 65`            | `scripts/demo/record.ts`, `scripts/demo/owned.ts` with `owned.test.ts`, the recorder's tests and helpers in `e2e/demo/launcher.spec.ts`, and its `.fallowrc.json` entry, each as at `da73154` (`git show da73154:<path> > <path>`). |
| `test(demo): time out the recorder's requests in one tested helper` | R4-2: `scripts/demo/request.ts`, its unit tests, and the recorder's four requests through it.                                                                                                                                       |
| `fix(demo): accept an app only once its own server says it listens` | S4.1: `scripts/demo.ts`, and its launcher test.                                                                                                                                                                                     |
| `docs: say how to re-record the demo media`                         | The Demo hub page (`site/guide/demo.md`), the README's Demos paragraph and the `docs/media/` row in `docs/INDEX.md` name `bun scripts/demo/record.ts` again.                                                                        |
| `docs(review): step 89 scope and verification`                      | This file, and the sizes in `docs/INDEX.md`.                                                                                                                                                                                        |

### The restore

`da73154` is the head of step 65's branch before the recorder was removed, and an ancestor of `main` (`git merge-base b2e1f06 da73154` is `da73154`). The only commit on `main` since then that touches `scripts/demo/`, `scripts/demo.ts`, `e2e/demo/launcher.spec.ts` or `.fallowrc.json` is the removal itself (`e336319`), so restoring the five paths from `da73154` puts back exactly the recorder and keeps every test `main` has. After the first commit, `git diff da73154 -- scripts e2e .fallowrc.json` is empty.

### R4-2: one request helper, tested with fake timers

Every HTTP request the recorder makes now goes through `request(url, init?, fetcher?)` in `scripts/demo/request.ts`, beside `owned.ts`: the backend's counters (`GET /api/stats`), its controls (`POST /api/control`, the clock's reset at shutdown included), the server-rendered page's warm-up (`GET /ssr`) and the hub's health check (`GET /healthz`). The stage page's own `fetch("/counters")` runs in Chromium, which shutdown closes, and is not one of them (as PR6-3 recorded).

- **The deadline.** An `AbortController` aborts the fetch with a `TimeoutError` (a `DOMException`, the name `AbortSignal.timeout` uses) from a `setTimeout` of `BACKEND_MS` (5 s, unchanged, now exported from the helper). Vitest's fake timers drive `setTimeout`; they do not drive `AbortSignal.timeout`, which is why the recorder's own timeout could not be tested.
- **The body is under the deadline too.** The helper reads the whole body before it clears the timer and returns a `Response` that holds it, so `response.json()` afterwards cannot wait on the server. With `AbortSignal.timeout`, the signal also covered the body; a helper that cleared its timer once the headers arrived would have dropped that.
- **One error.** Whatever the fetch rejects with once aborted, the helper rejects with the signal's reason, the `TimeoutError`.
- **The ownership gate is unchanged.** `counters` and `control` still refuse to send anything until `waitForHub` has accepted this run's own hub (`backendOwned`, round 3); the helper sits under that gate.

**Tests** (`scripts/demo/request.test.ts`, 4): a request whose fetch never answers, and settles only when its signal aborts, rejects with a `TimeoutError` after `vi.advanceTimersByTimeAsync(BACKEND_MS)`; it is still pending at `BACKEND_MS - 1` and settled one millisecond later; a response whose body never ends rejects the same way; and an answer in time returns its status and body, passes a signal to the fetch, and leaves no timer behind.

**Red first.** Against a helper without the abort (the fetch and the body read, nothing else), both never-answering tests failed at Vitest's 5 s timeout ("Test timed out in 5000ms", the hang detection `docs/testing.md` allows), the bound test failed (`expected false to be true`), and the in-time test failed on the missing signal. **Green** after: 4 of 4.

### S4.1: an app is the launcher's only once its own server says so

The security lane's window: after the recorder's port check (`demoPortsFree`) lets the ports go and while the launcher builds, a local process binds an app's port. The launcher's `ready()` polled the app's origin and accepted the first `ok`, which the foreign process gave; the app's `vite preview --strictPort` then failed and the launcher began its shutdown, but if every other app was up by then, `Promise.all` resolved, the hub started and the hub line printed. The recorder, which accepts its demo on that line, would then mark the backend as its own and send its first control (and the clock's reset at shutdown) to the foreign process.

Fixed in the launcher (`scripts/demo.ts`), as the security lane proposed:

- **The app's own server must say it listens.** `serve()` keeps each `vite preview`'s output (`capture: true`) and returns its handle. `ready(app, run)` sends nothing to the port until that output holds vite's `Local:` line for the app's origin, colours removed (`stripVTControlCharacters`; CI sets `CI`, which turns vite's colours on); only then does it fetch the page, as before. With `--strictPort` vite fails rather than share a taken port, so a foreign process on the port is never asked anything and never accepted.
- **A stopping launcher says nothing.** `start()` does not start the hub once shutdown has begun, and the hub line is printed only by a launcher that is not stopping; one that is awaits its shutdown, which exits.
- **The failure says why.** A `vite preview` that exits early now has its output in the launcher's message (`reference-vanilla: vite preview exited with 1`, then vite's "Port … is already in use"). Before, its stderr went straight to the terminal; now it is kept, and shown when it fails.

**Test first** (`e2e/demo/launcher.spec.ts`, "a launcher whose app port is taken during the build refuses that app, and the recorder sends it nothing"). The recorder runs without `--reuse-builds`, with `DEMO_BUILD_SCRIPT` standing in for every build. The package's build, which runs first, marks that it runs and waits; the test then binds the recorded app's port (`reference-vanilla`) with an HTTP server that answers every request and counts it, and releases the build. A stand-in whose directory the test's cleanup has removed exits, so a test that fails before it releases the build leaves no build running. It expects the recorder to exit 1 with the launcher's `reference-vanilla: vite preview exited` in its output and no `tscache demo hub:` line, the counting server to have received nothing, every other port to be free and the raw-video directory gone.

- **Red** on the old launcher: the counting server received `GET /`, the old `ready()`'s first poll, sent before `vite preview` had even started. The old launcher sends that request on every run, so the test is red on it by construction, not by a race.
- **Green** after the fix, in the repeated run under Verification.
- **Not tested on its own:** the guard on the hub line. It closes the window in which an app server fails after every `ready()` has resolved; no seam forces that order, and with the first fix a foreign process can no longer make a `ready()` resolve.

## Verification

On the final head:

- `bunx vitest run scripts/demo`: 3 files, 15 tests passed (`processes.test.ts`, `owned.test.ts`, `request.test.ts`).
- `bunx tsc -p .` and `bunx tsc -p e2e`: no errors. `bunx biome check scripts e2e`: no fixes (one existing warning in `e2e/examples/react-lwcharts.spec.ts`, untouched). `bun scripts/test-clocks.ts`: "168 files clean". `bun run knip` (after `bun run build`): exit 0. `bun run fallow`: exit 0. `bun run docs:check`: "doc-anchors: 246 anchors in 42 pages resolve".
- **Red runs.** `bunx vitest run scripts/demo/request.test.ts` against the helper without the abort: 4 failed, as described under R4-2. `~/code/tscache-reports/bin/heavy-run.sh "89 child: launcher red" bunx playwright test e2e/demo/launcher.spec.ts --project demo -g "taken during the build"` on the old launcher: 1 failed, at `expect(backend.requests()).toEqual([])`, received `["GET /"]`; its two assertions before that one (the launcher's `vite preview exited` message, no hub line) passed in that run.
- **The launcher spec, repeated.** `~/code/tscache-reports/bin/heavy-run.sh "89 child: launcher x5" bunx playwright test e2e/demo/launcher.spec.ts --project demo --repeat-each 5 --workers 1`: 75 passed (the spec's 15 tests, 5 times each) in 2.2 min, at a load average of about 5.6. The Playwright `demo` web server, which runs the fixed launcher (`bun scripts/demo.ts --reuse-builds`), came up for it. Repeated again after the stand-in's exit on a removed directory (a test-only change): see the last item.
- **The gate.** `~/code/tscache-reports/bin/heavy-run.sh "89 child: ci" bun run ci` on `b150d80`: exit 0, 130 Vitest files (2683 tests) and 186 Playwright tests passed, the bench smoke all `ok`, at a load average of about 6.
- **After the stand-in fix.** The launcher spec repeated 5 times with one worker and the gate again on the final head; the results are in the child's report to the director.

Not verified: a real recording. The recorder's scenarios, stage and conversion are as step 65 left them, and the fixes change neither what a clip shows nor the media, so nothing was recorded again; the four real scenarios last ran in step 65 (round 3, every claim passing).

## Decisions

- **The helper takes the fetch as a parameter and uses `setTimeout`,** both, as the finding check allowed either: the parameter lets a test hold a request open without a server, and `setTimeout` lets fake timers drive the deadline.
- **The helper buffers the body.** The recorder's responses are small (counters, a control's answer, one server-rendered page, a health check), and buffering keeps the body under the same deadline as the headers.
- **The launcher's fix, not the recorder's.** The security lane offered either; the launcher's covers every consumer of its hub line (the recorder, Playwright's `demo` web server, a person reading the terminal), and the recorder already requires that line from its own launcher.
