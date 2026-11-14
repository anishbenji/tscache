# Step 111 — a clear-disk retry whose timer runs at the deadline

Branch: `chore/111-clear-disk-late-retry-test` · Reviewer: not yet run (the director starts the review) · Rounds: 0 · Status: open

## Scope

The Effect evaluation of 2026-11-15 (finding 4 of its slice) found a gap in `packages/tscache/test/persist-clear-disk.test.ts`: no case has a retry's timer run at or after the deadline, as it does when the thread was busy and the timer fired late. In `packages/tscache/src/persist/clear-disk.ts`, the check after the retry wait, `if (ended || !due()) return;` (line 83), is what keeps such a retry from starting a clear after the deadline (N61). Weakening it to `if (ended) return;` left all 14 tests passing.

This step adds one regression test against that existing logic. It is test-only: nothing under `packages/tscache/src` changes. Strict test-first applies to new engine logic; this step adds none.

| Commit (by subject)                                                             | What                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------- |
| `test(persist): pin that a late retry timer starts no clear after the deadline` | The new case in `persist-clear-disk.test.ts`. |
| `docs(review): step 111, a clear-disk retry whose timer runs at the deadline`   | This file.                                    |

## The test

"a retry whose timer runs at the deadline, before the deadline's timer, starts no clear", appended at the end of the file's `describe` block. It uses the file's own seams: Vitest's fake clock (`vi.useFakeTimers({ now: 0 })`), the `seeded()` MemoryStore with `store.fail("clearAll", Infinity)`, `tracked` and `clearCalls`.

Vitest's fake clock runs every timer at its set time, so a timer can never fire late on it, and `clearDisk` reads `performance.now()` directly, with no clock parameter. The test therefore spies on `performance.now` (the fake clock's, installed by `useFakeTimers`) and adds a lag to what it returns. The first attempt fails at 0 ms; at 999 ms the lag is set to 4000 ms, so the 1000 ms retry timer runs while the clock `clearDisk` reads shows 5000 ms, the deadline, and the deadline's own timer is still queued. The test asserts that the call has settled, that no second clear started, that the store was closed once, and, after 10 s more, that still only one clear ran and the records remain. The spy is restored with `onTestFinished`. `bun scripts/test-clocks.ts packages/tscache/test/persist-clear-disk.test.ts` reports the file clean: there is no wall-clock read, sleep or timing assertion.

The case goes at the end of the file, and its spy restore stays inside the test rather than in the shared `afterEach`. That way no existing test moves, and the test line numbers that `docs/benchmarks/mutation.md` row 20 cites (`:129`, `:170`) stay correct.

## Verification

The mutant, made as a temporary edit to `clear-disk.ts:83` (`if (ended || !due()) return;` to `if (ended) return;`) and undone with the same tool before the commit (`git diff main --stat -- packages/tscache/src` is empty):

| Command                                                            | Code    | Result                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bunx vitest run packages/tscache/test/persist-clear-disk.test.ts` | mutant  | `Tests  1 failed \| 14 passed (15)`; the failing test is the new one: `AssertionError: expected 2 to be 1 // Object.is equality` at `persist-clear-disk.test.ts:244:31` (`clearCalls`) |
| `bunx vitest run packages/tscache/test/persist-clear-disk.test.ts` | as main | `Tests  15 passed (15)`                                                                                                                                                                |

So the 14 earlier tests pass on the mutant and only the new test fails on it.

### Mutation check

`docs/benchmarks/mutation.md` (step 84, 2026-11-13) gives `persist/clear-disk.ts` a score of 86.0. Its row 20 lists survivors at `:81` (the check before a retry) and `:87` (the deadline timer). It does not list the `:83` mutants as survivors; it says that after the wait, `:83` returns once the deadline has passed. No stored Stryker report covers the file: the only `reports/mutation/` found (`~/.t3/worktrees/tscache/step-91-stryker-deps`) holds `coverage.ts` alone, and the main checkout has none.

One-file runs, each through the heavy-job lock: `heavy-run.sh "111 child: stryker …" bun run mutation --mutate packages/tscache/src/persist/clear-disk.ts` (Stryker 10.1.1, `stryker.config.json` unchanged, 16 s each). "Before" ran in a scratch worktree detached at `main` (`bdb4829`), since removed; "after" ran on this branch's head.

| Run    | Mutants | Killed | Timed out | Survived | No coverage | Score |
| ------ | ------: | -----: | --------: | -------: | ----------: | ----: |
| Before |      50 |     43 |         1 |        6 |           0 | 88.00 |
| After  |      50 |     45 |         1 |        4 |           0 | 92.00 |

The two mutants this step kills are both at `:83`: the ConditionalExpression `if (false) return;` and the LogicalOperator `ended && !due()`. Stryker credits both to the new test alone. The four that survive:

- `:81`, three mutants (the check dropped, `>=` to `>`, `+` to `-`). Row 20 already judges these equivalent: the check only spares a wait, and `:83` catches what it lets through.
- `:59`, `clearTimeout(timer)` removed from `end`. The deadline's timer then runs later and calls `end` again, which returns at once because `ended` is set. That is equivalent behaviour, apart from a timer left pending until the deadline.

The `:87` survivors of row 20 are already gone in the "before" run: step 94 killed them. The step-84 score of 86.0 was measured at that step's revision; today's 88.00 before this step reflects step 94.

`docs/benchmarks/mutation.md` is left unchanged, following step 94, which killed survivors and left the dated step-84 measurement as it was. This step makes nothing in the doc wrong: row 20's statements and its line references still hold, and the per-file score is the step-84 figure for that run.

### Checks

- `bunx vitest run packages/tscache/test/persist-clear-disk.test.ts`: 15 of 15 pass.
- `bun scripts/test-clocks.ts packages/tscache/test/persist-clear-disk.test.ts`: `test-clocks: 1 files clean`.
- `bun run ci` runs through the heavy-job lock on the branch head before it is handed to the director.

## Contract-test changes

None: no contract test was changed or removed. The new case is appended to `persist-clear-disk.test.ts`, an implementer test file (its header: "Implementer tests").

## Decision concerns

None.
