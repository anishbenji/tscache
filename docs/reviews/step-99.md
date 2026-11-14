# Step 99 — the demo process tests wait for a reaped child

Branch: `fix/99-demo-process-reap` · Reviewer: GPT-6.1 Sol · Rounds: 0 · Status: awaiting review

## Scope

`scripts/demo/processes.test.ts` (step 89, #120) failed twice in a pre-push hook on 2026-11-14 while a bench and a Codex round ran alongside, and passed 8 of 8 runs alone. Both failures were a one-shot `expect(running(child)).toBe(false)` read right after the child's process group was found empty:

- "retires a build whose child outlives it only once the child exits", after `expect.poll(() => processes.groups.has(group))` turned false;
- "stops a build's surviving child when shutdown comes first", after `await processes.stop()`.

`running(pid)` is `process.kill(pid, 0)`. This step makes both assertions wait for the child to be gone, as `docs/testing.md` ("Waiting") requires. `scripts/demo/processes.ts` is unchanged: the registry is correct, and only the tests read a state that is still settling.

| Commit (by subject)                                    | What                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `test(demo): wait for the orphaned child to be reaped` | Both assertions poll, each with a comment on the zombie gap. |
| `docs(review): step 99, the demo process tests wait`   | This file and its `docs/INDEX.md` row.                       |

## The cause, confirmed

The leader `sh` exits first, so its background child is orphaned and reparented to launchd. When the child exits it becomes a zombie until launchd reaps it. On macOS a zombie no longer answers the group probe `kill(-group, 0)`, which fails with ESRCH, but its own pid still answers `kill(pid, 0)` until the reap. The registry retires a group on the failed group probe (`#live` in `processes.ts`), which is correct: the group has no member that can run or be signalled. A test that then reads `kill(child, 0)` once can land inside the gap between the child's exit and launchd's reap, and that gap grows when the machine is loaded.

The gap was shown with a standalone Node 26.13 script (not committed). Each run starts `sh -c "sleep 0.2 & echo $!"` detached, waits for the leader to exit and for the child's pid, spins on `kill(-group, 0)` until it throws, then reads `kill(child, 0)` and times how long it keeps succeeding:

| Runs | Child pid still answers after the group probe failed | Gap (idle machine): min / median / max |
| ---- | ---------------------------------------------------- | -------------------------------------- |
| 50   | 50                                                   | 75 µs / 175 µs / 1.6 ms                |

A `ps -p <child>` started as soon as the pid was seen still answering found it gone in all 50 runs, with nothing of ours signalling or waiting on it: the pid answered only until launchd reaped it. A process that had not yet exited would have answered the group probe too, so what answered was the exited child as a zombie.

In the tests the window is usually missed because the group is found empty by a periodic check (the 250 ms sweep, or the 50 ms poll in `stop()`), which on an idle machine comes long after launchd's reap. Under load the reap is delayed and the one-shot read can fail.

## The change

Both assertions become `await expect.poll(() => running(child), { timeout: 5000 }).toBe(false)`. Each still asserts the same final state: the child is gone. No retry was added.

The polls first used Vitest's default timeout of 1 s; the pre-review (below) asked for 5 s, and that is what they use. This is a new wait for an effect, not a raised bound on an existing one. The effect is launchd's reap, whose latency the test does not control and which grows only under load, the one condition in which the flake appears. As `docs/testing.md` ("Waiting") says, the timeout only detects a hang, a child that never goes; a passing run returns as soon as the pid stops answering, so the longer limit costs nothing. 5 s matches the neighbouring `groups.has(group)` poll in the same test.

The other one-shot `running(...)` and `groups` assertions in `scripts/demo/*.test.ts` were checked; only `processes.test.ts` has any:

- `groups.has(group)` false right after `await started.exited` ("retires a build that exits"): the exit handler probes and retires the group before it resolves `exited`, and `sh -c "exit 0"` leaves no child, so the group is gone when the probe runs. No race.
- `groups.size` 0 after `await processes.stop()`: `stop()` resolves only after every group is retired, or logs and gives up after the SIGKILL grace; the assertion reads the registry, not the kernel. No race.
- `running(child)` true and `groups.has(group)` true while `sleep 1` still runs ("retires a build whose child outlives it"): these read a state that holds until the one-second sleep ends, not one that is settling. They are not the zombie race. They do depend on the test reaching them within that second; step 95 removes that margin (below), so this step leaves them as they are.

## Load run

`bunx vitest run scripts/demo/processes.test.ts` 20 times in a row while `~/code/tscache-reports/bin/heavy-run.sh "99 child: ci" bun run ci` ran on this branch: **20 of 20 passed**, 7 of 7 tests each. CI took the lock at 16:16:34Z; the 20 runs went from 16:16:58Z to 16:17:32Z, and CI was still running when they ended (it went on through Vitest and Playwright). The runs were not timed against CI's individual stages.

## Step 95 and this step

Step 95 (`fix/95-flakes`) also changes "retires a build whose child outlives it only once the child exits", for a different race: the `sleep 1` child could end on its own before the test checked that it was still running. That step makes the child `sleep 30`, waits for two group probes (a `probesOf` helper) before those checks, and then ends the child itself with `process.kill(child, "SIGTERM")`. It does not change the one-shot `running(child)` reads after the group is gone or after `stop()`, which are this step's.

The two changes are kept apart so that `scripts/demo/processes.test.ts` merges cleanly: this step changes only the two assertion lines and the comment above each, and leaves the rest of that test as it is on `main`. The `docs/reviews/` row in `docs/INDEX.md` does conflict between the two branches (both re-measure it); whichever branch merges second resolves that row and re-measures it with `wc -c`. After both merge, the child that step 95's test ends with SIGTERM is still an orphan reaped by launchd, so the same zombie gap applies and this step's poll still covers it. Whichever step merges second merges `main` into its branch and keeps both changes.

## Pre-review (Fable), not the gate

On head 224b7bc (the director's merge of `origin/main` at 03c7b20 into this branch). It reproduced the cause independently, 28 of 30 runs with a gap of at most 3.1 ms, and noted that Linux CI is unaffected, because there a zombie still answers the group probe. It checked that the change does not weaken the tests: a mutant `#stopAll` that returns early still fails 15 of 15. No P0 or P1; predicted verdict merge.

| #    | Sev | Finding                                                                            | Decision | Resolution                                                                                                                                                               |
| ---- | --- | ---------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR-1 | P2  | The two new polls use the 1 s default, while the flake appears only under load     | accepted | Validated: Vitest's `expect.poll` default is 1 s, and the reap is launchd's work under load. Both polls pass `{ timeout: 5000 }`, as hang detection only ("The change"). |
| PR-2 | nit | "Step 95 and this step" says the branches merge cleanly; `docs/INDEX.md` conflicts | accepted | Reproduced by the pre-review. The sentence now covers only the test file, and names who resolves the INDEX row.                                                          |

## Contract-test changes

None. The changed tests are tooling tests of the demo launcher, not contract tests.

## Decision concerns

None.
