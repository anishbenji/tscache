# Step 110 — the recorder waits for its launcher's whole stop

Branch: `fix/110-recorder-cleanup-races` · Reviewer: GPT-6.1 Sol · Rounds: 0 (the director runs the review) · Status: open

## Scope

Step 96's review round ran `bun run ci` on a comment-only change, and two recorder tests from step 89 in `e2e/demo/launcher.spec.ts` failed, each after about 50 s (`.reviews/step-96/round-1.ci.log` in step 96's worktree):

- `an interrupted recorder stops Chromium and the demo while it records`: `expect(await allFree([hub, ...apps])).toBe(true)` failed, so a demo port was still in use right after the recorder exited.
- `a recorder stopped while it converts leaves the media as they were and stops ffmpeg`: the test's cleanup threw `ENOTEMPTY: directory not empty, rmdir '…/tscache-record-tmp-*/node-compile-cache/v26.13.0-arm64-…'`, so a process was still writing into the test's temporary directory while the test removed it.

CI on `main` passes; both failures were intermittent. They have one cause, and it is a bug in the recorder, not in the tests.

| Commit (by subject)                                                        | What                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `fix(demo): let the recorder wait for the launcher's whole stop`           | `Processes` takes a grace; the recorder gives its launcher `LAUNCHER_GRACE_MS`; the test. |
| `docs(review): step 110, the recorder waits for its launcher's stop`       | This file.                                                                                |
| `fix(demo): test the sigkill after a custom grace and say when it is sent` | Pre-review findings P-1, P-3 and P-4 (below).                                             |
| `docs(review): step 110 pre-review triage`                                 | The pre-review section of this file.                                                      |

## The cause

The recorder (`scripts/demo/record.ts`) starts the demo launcher (`scripts/demo.ts`) through a `Processes` (`scripts/demo/processes.ts`), and on a stop releases it with `processes.stop()`: SIGTERM to the launcher's process group, then SIGKILL to whatever is left after `GRACE_MS` (3 s). The launcher does the same with its own app servers, each `vite preview` in a process group of its own: SIGTERM, up to 3 s, SIGKILL, up to 2 s more, and only then does it exit. So the launcher's stop takes up to 5 s, and the recorder gave it 3 s.

When the app servers take long to close (a loaded machine, as during `bun run ci`), the recorder's SIGKILL reaches the launcher while it is still stopping them. The SIGKILL reaches the launcher's group alone; the app servers, signalled but still closing, outlive both the launcher and the recorder. The recorder then exits with 130 or 143 as if everything had stopped, and:

- each app server still holds its port for a moment, so the one-shot `allFree` right after the exit fails (the first test);
- each app server is Node (`vite preview`), whose CLI enables Node's compile cache (`module.enableCompileCache()` in `vite/bin/vite.js`) under `os.tmpdir()`, which the tests point at their temporary directory with `TMPDIR`. Node writes the cache when the process exits, so the servers' exit writes files into `node-compile-cache/` while the test removes the directory (the second test).

The tests' one-shot checks are right as they stand. The recorder's contract (its header, and `shutdown` in `record.ts`) is that once it exits, the demo and everything the demo started have stopped; polling for the ports would have hidden the leftover servers instead of finding them.

## The fix

- `scripts/demo/processes.ts`: the constructor takes `{ graceMs }`, the time the groups get after SIGTERM before SIGKILL (default `GRACE_MS`, so the launcher is unchanged). `STOP_MS` names the longest a default stop takes (`GRACE_MS + KILL_MS`, 5 s), and `LAUNCHER_GRACE_MS` the grace for a launcher that stops its own groups that way: `STOP_MS` plus `GRACE_MS` again for the launcher to begin its stop and to exit (8 s). The poll sleeps on the global `setTimeout` instead of `node:timers/promises`, so Vitest's fake timers drive it.
- `scripts/demo/record.ts`: the recorder's `Processes` uses `LAUNCHER_GRACE_MS`. Its SIGKILL now comes only after the launcher's own stop would have ended, so in every ordinary stop the launcher has stopped its servers and exited first; the SIGKILL stays as the backstop for a launcher that hangs.

This orders two deadlines rather than widening one: the launcher's stop is bounded, and the recorder's grace now covers that bound. No test timeout, retry or assertion changed.

## Reproduction and tests

**Unit test, written first** (`scripts/demo/processes.test.ts`, "never sends SIGKILL to a launcher still within its own stop, and resolves once it and its groups are gone"). A stand-in launcher (a Bun script using `Processes`, as `scripts/demo.ts` does) starts a server group and begins its own stop only when the test sends SIGUSR2. The outer `Processes`, with `LAUNCHER_GRACE_MS`, runs on fake timers: the test calls `stop()`, advances `STOP_MS`, and asserts the launcher has had SIGTERM only and is still running; then it releases the launcher, which stops its server and exits 143, and asserts that `stop()` resolves within the grace with SIGTERM still the only signal and the server's group empty.

| `LAUNCHER_GRACE_MS`                   | Runs | Result                                                                      |
| ------------------------------------- | ---- | --------------------------------------------------------------------------- |
| `GRACE_MS` (the recorder's old grace) | 5    | 5 failed: `expected [ 'SIGTERM', 'SIGKILL' ] to deeply equal [ 'SIGTERM' ]` |
| `STOP_MS + GRACE_MS` (the fix)        | 3    | 3 passed (with the 7 other `Processes` tests)                               |

A first version of the test used real time and the real 3 s grace in the stand-in; with the old grace it failed 4 runs in 5, a race between two equal deadlines, so it was replaced by the fake-timer version, which fails on every run.

**End to end, forced** (a scratch script, not committed). The real recorder records the probe (`RECORD_PROBE=hold`) against a real demo of ten `vite preview` servers on ports 46100–46110, with `TMPDIR` pointing at a fresh directory. Once the probe holds, the script stops the launcher with SIGSTOP, standing in for a launcher whose stop runs late, sends SIGINT to the recorder's group as Ctrl-C does, and resumes the launcher with SIGCONT 4 s later. Right after the recorder exits it checks every port, the `vite preview` processes left (`pgrep -f "--port <port> --strictPort"`, two per app: `bun run` and Node), and then sends those a SIGTERM, as the launcher had in step 96's run, and lists the compile-cache files written after the recorder's exit.

| Recorder's grace for its launcher | Runs | Recorder exit         | Ports in use after the exit | Servers left | Compile-cache files written after the exit |
| --------------------------------- | ---- | --------------------- | --------------------------- | ------------ | ------------------------------------------ |
| 3 s (`GRACE_MS`, before)          | 3    | 130 after 3.15–3.19 s | all ten app ports, each run | 20, each run | 13, 310 and 363                            |
| 8 s (`LAUNCHER_GRACE_MS`, after)  | 3    | 130 after 4.11–4.18 s | none                        | 0            | none (no server left to write)             |

Before the fix every run reproduced both failures' preconditions: the ports the first test checks were in use when the recorder had exited, and the servers that outlived it wrote `node-compile-cache/v26.13.0-arm64-310b2ce3-501/*` into the recorder's `TMPDIR` as they exited, the directory the second test's cleanup failed to remove.

## Load hunt

The two tests, each 20 times on one worker with no retries and one busy loop per core (`scripts/flake-hunt.sh`'s method; the script itself takes whole files, so a scratch wrapper ran `bunx playwright test e2e/demo/launcher.spec.ts --project demo -g "<the two titles>" --repeat-each 20 --workers 1 --retries 0` with `E2E_EXAMPLES=demo`), through the heavy-job lock:

| Test                                                                                  | Runs | Passed | Failed |
| ------------------------------------------------------------------------------------- | ---- | ------ | ------ |
| `an interrupted recorder stops Chromium and the demo while it records`                | 20   | 20     | 0      |
| `a recorder stopped while it converts leaves the media as they were and stops ffmpeg` | 20   | 20     | 0      |

Playwright reported `40 passed (3.2m)`, with ten busy loops running throughout.

## Pre-review (Fable), not the gate

On head `7b423ef` (the director's merge of `origin/main` into this branch). The pre-review confirmed that the recorder cannot hang (`#stopAll` is bounded by the grace plus `KILL_MS`, about 10 s, and `stop()` returns even when a group never empties), that the launcher's default is unchanged (`scripts/demo.ts` and `scripts/demo-bench.ts` still use `new Processes()`), and that the 3 s margin covers the launcher's poll overshoot. It predicted merge after fixes.

| #   | Sev | Finding                                                                                                                | Decision | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --- | ---------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-1 | P1  | No test reaches the SIGKILL pass after a custom grace; dropping it would leave every test green                        | accepted | Validated: every child in `processes.test.ts` honoured SIGTERM, so no test reached the SIGKILL pass at all. New fake-timer test, written first: a group that ignores SIGTERM (it prints `ready` once its trap is set) under `LAUNCHER_GRACE_MS` has had SIGTERM only 1 ms before the grace ends and SIGTERM then SIGKILL at its end, and `stop()` resolves with `groups` empty. With the SIGKILL pass temporarily removed (undone with the Edit tool) it failed: `expected [ 'SIGTERM' ] to deeply equal [ 'SIGTERM', 'SIGKILL' ]`. |
| P-2 | P2  | The step-110 test leaks its `sleep 60` server if it fails where it guards: only the launcher's group is in `leftovers` | rejected | Validated against the code: `echoedPid` (`processes.test.ts`) pushes the pid it reads into `leftovers`, and `afterEach` sends SIGKILL to both `-pid` and `pid`. The pid it reads is the server's group id (the stand-in prints `server.group`), so the server's group is already killed after the test however it ends. A comment at the call now says so; a second push would only repeat it.                                                                                                                                      |
| P-3 | P2  | A backstop SIGKILL can leave app servers running while the recorder exits as if clean                                  | accepted | `Processes` logs one stderr line when its SIGKILL pass signals a live group (`demo: groups <ids> did not exit within <ms> ms of SIGTERM; sent SIGKILL`); the P-1 test asserts the line, once, naming the group, and its absence before the grace ends. The recorder's header and its registry's TSDoc call the backstop best-effort. Closing that case is left out of this step, as directed.                                                                                                                                       |
| P-4 | nit | The TSDoc on the recorder's `processes` constant says it starts the launcher                                           | accepted | Reworded to describe the registry the launcher is started in and its grace.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Contract-test changes

None.

## Decision concerns

None.
