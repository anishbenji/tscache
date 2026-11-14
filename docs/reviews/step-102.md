# Step 102 — the review scripts accept step numbers of three digits

Branch: `chore/102-three-digit-steps` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled

## Scope

Step 100's Codex round never ran. `scripts/review-watch.sh` printed its usage line and exited 2, because both it and `scripts/codex-review.sh` accepted only `^[0-9]{2}$` as the step number. Step numbers have reached 100, so no review round could run for a new step. Both scripts now accept `^([0-9]{2}|[1-9][0-9]{2,})$`: two digits, or three or more without a leading zero. One digit, anything that is not a number, and a zero-padded number above 99 such as `0102` are usage errors (exit 2).

`scripts/codex-review.sh` is on the protected-path list, so the user merges this pull request. A round runs the scripts from the branch under review, so this branch's own round uses the fixed scripts.

| Commit (by subject)                                                        | What                                                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `fix(scripts): review scripts accept step numbers of three digits`         | The pattern in both scripts, the regression cases in `scripts/review-watch.test.sh`, and the two doc notes. |
| `docs(review): step 102, review scripts accept three digits`               | This file and the `docs/INDEX.md` rows.                                                                     |
| `fix(scripts): reject zero-padded steps and isolate the review-watch test` | Pre-review findings PR-1 and PR-2 (below).                                                                  |
| `docs(review): step 102 pre-review triage`                                 | The pre-review section and the `docs/INDEX.md` row.                                                         |

## Other uses of the step number

Every other use of the step number in the two scripts was checked for a two-digit assumption. None has one:

- The output folder `.reviews/step-$step/` and the triage file `docs/reviews/step-$step.md` are built from the argument as given, so step 100 uses `.reviews/step-100/` and `docs/reviews/step-100.md`.
- The round number counts the existing `round-*.md` or `adversarial-*.md` files in that folder; nothing sorts file names, so `round-9` and `round-10`, or `step-99` and `step-100`, are never compared lexically.
- The prompts insert the step number as text.
- The watchdog sums the bytes under `.reviews/step-$step/`, whatever the folder's name.

The director's round scripts outside the repository (`~/code/tscache-reports/bin/review-round.sh`, `review-chain.sh`) were read, not changed: they count `round-*.md` files and pick the newest by modification time (`ls -t`), and do not check the number's width.

In the documents, `NN` is a placeholder. `docs/workflow.md` (review loop) and `docs/reviews/README.md` now say that it is the step number: two digits, or three or more without a leading zero. `AGENTS.md` and `CLAUDE.md` use the same placeholder and are the user's files; they are unchanged.

## Test

`scripts/review-watch.test.sh` (run by `scripts/ci.sh`) gains nine cases. Its scratch repository now also holds a copy of the real `scripts/codex-review.sh`, on an unborn branch `chore/100-scratch`, because the review script refuses to run on `main`. The cases run before the existing ones, which replace that copy with stand-ins:

- `review-watch.sh 100 --print-prompt` exits 0, its prompt names step 100, and it watched `.reviews/step-100/`.
- `codex-review.sh 1234 --print-prompt` exits 0.
- `codex-review.sh 7`, `review-watch.sh 7`, `review-watch.sh 10x`, `codex-review.sh 0102` and `review-watch.sh 0102` exit 2.

Every one of these calls passes `--print-prompt`, which starts neither `bun run ci` nor Codex, so a step number the scripts wrongly accept only prints a prompt. As a second guard, stub `codex` and `bun` commands come first on the test's `PATH` and fail with exit 97 (see PR-2 below for why).

The first commit's four "accepts" cases failed before its change (exit 2), and the two zero-padded rejections failed before the second fix commit (exit 0); all thirteen cases of the file pass on the final head. The cases were added to the existing test file rather than to a new `scripts/codex-review.test.sh`, which would also need a line in `scripts/ci.sh`, another protected path. `scripts/ci.sh`'s guard that the test never changes the real `scripts/codex-review.sh` still holds: the test copies it into the scratch repository and never writes outside it.

## Pre-review (Fable), not the gate

On head 2f189cd. No P0 or P1; predicted verdict merge. It confirmed that all eleven cases then in the file pass and that the `docs/INDEX.md` sizes and file count match.

| #    | Sev           | Finding                                                                                                                                                                                                                                                                                                                                               | Decision | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | P2, suspected | `scripts/review-watch.test.sh` runs `git init` and `git symbolic-ref HEAD refs/heads/chore/100-scratch` without checking that git resolves to the scratch repository; with `GIT_DIR` exported (a git hook, `git rebase -x`) they act on the caller's repository and leave it on an unborn branch, which `scripts/ci.sh`'s hash guard would not notice | accepted | Reproduced: a throwaway repository on `main` holding copies of the three scripts, with the test run as `GIT_DIR=<repo>/.git bash <repo>/scripts/review-watch.test.sh`, ended on `refs/heads/chore/100-scratch`. The test now unsets every variable `git rev-parse --local-env-vars` lists before `git init`, and stops unless `git rev-parse --show-toplevel` is the scratch directory. The same run (with `GIT_WORK_TREE` and `GIT_INDEX_FILE` exported too) now leaves that repository on `main`, clean, and passes all thirteen cases. |
| PR-2 | nit           | `^[0-9]{2,}$` accepts a zero-padded `0102`, which uses `.reviews/step-0102/`, misses `docs/reviews/step-102.md` and silently counts as round 1; before this step it was a usage error                                                                                                                                                                 | accepted | Both scripts now use `^([0-9]{2}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [1-9][0-9]{2,})$`. Two rejection cases (`codex-review.sh 0102`, `review-watch.sh 0102`) failed first (exit 0) and pass after. |

While fixing PR-2, the test-first run started two real Codex sessions. The new case `review-watch.sh 0102`, written first without `--print-prompt`, was accepted by the old pattern, so the watchdog ran the real `codex-review.sh` in the scratch repository: `bun run ci` failed there, and `codex exec` then ran in a read-only sandbox in that throwaway directory (about 147,000 and 111,000 tokens by the sessions' own counts) before the test was stopped. Nothing outside the scratch directory changed, and its exit trap removed it. The cases now always pass `--print-prompt`, and the stub `codex` and `bun` commands on the test's `PATH` make any such slip fail at once with exit 97; a check run of `codex-review.sh 55` without `--print-prompt`, in a scratch repository behind the same stubs, exited 97: both `bun run ci` and `codex exec` reached the stubs, not the real tools.

## Contract-test changes

None. The changed test is a tooling test of the review scripts, not a contract test.

## Decision concerns

None.

## Security lane (Claude), not the gate

run 1, head 47826e1: P0 0, P1 0, P2 0

## Round 1 (GPT-6.1 Sol, high), head e6f6bb4

No findings; verdict merge. The round ran on this branch's own scripts, the first with a three-digit step number.
The pre-review fixes PR-1 and PR-2 were checked as fixed. `bun run ci` exit 0 on that head (run by the round). Settled.
