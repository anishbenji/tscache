# Step 102 — the review scripts accept step numbers of three digits

Branch: `chore/102-three-digit-steps` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: awaiting review

## Scope

Step 100's Codex round never ran. `scripts/review-watch.sh` printed its usage line and exited 2, because both it and `scripts/codex-review.sh` accepted only `^[0-9]{2}$` as the step number. Step numbers have reached 100, so no review round could run for a new step. Both scripts now accept two or more digits, `^[0-9]{2,}$`. One digit and anything that is not a number stay usage errors (exit 2).

`scripts/codex-review.sh` is on the protected-path list, so the user merges this pull request. A round runs the scripts from the branch under review, so this branch's own round uses the fixed scripts.

| Commit (by subject)                                                | What                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `fix(scripts): review scripts accept step numbers of three digits` | The pattern in both scripts, the regression cases in `scripts/review-watch.test.sh`, and the two doc notes. |
| `docs(review): step 102, review scripts accept three digits`       | This file and the `docs/INDEX.md` rows.                                                                     |

## Other uses of the step number

Every other use of the step number in the two scripts was checked for a two-digit assumption. None has one:

- The output folder `.reviews/step-$step/` and the triage file `docs/reviews/step-$step.md` are built from the argument as given, so step 100 uses `.reviews/step-100/` and `docs/reviews/step-100.md`.
- The round number counts the existing `round-*.md` or `adversarial-*.md` files in that folder; nothing sorts file names, so `round-9` and `round-10`, or `step-99` and `step-100`, are never compared lexically.
- The prompts insert the step number as text.
- The watchdog sums the bytes under `.reviews/step-$step/`, whatever the folder's name.

The director's round scripts outside the repository (`~/code/tscache-reports/bin/review-round.sh`, `review-chain.sh`) were read, not changed: they count `round-*.md` files and pick the newest by modification time (`ls -t`), and do not check the number's width.

In the documents, `NN` is a placeholder. `docs/workflow.md` (review loop) and `docs/reviews/README.md` now say that it is the step number, two or more digits. `AGENTS.md` and `CLAUDE.md` use the same placeholder and are the user's files; they are unchanged.

## Test

`scripts/review-watch.test.sh` (run by `scripts/ci.sh`) gains seven cases. Its scratch repository now also holds a copy of the real `scripts/codex-review.sh`, on an unborn branch `chore/100-scratch`, because the review script refuses to run on `main`. The cases run before the existing ones, which replace that copy with stand-ins:

- `review-watch.sh 100 --print-prompt` exits 0, its prompt names step 100, and it watched `.reviews/step-100/`. `--print-prompt` starts neither `bun run ci` nor Codex.
- `codex-review.sh 1234 --print-prompt` exits 0.
- `codex-review.sh 7`, `review-watch.sh 7` and `review-watch.sh 10x` exit 2.

Before the change the first four cases failed (exit 2) and the three rejections passed; after it all eleven cases pass. The cases were added to the existing test file rather than to a new `scripts/codex-review.test.sh`, which would also need a line in `scripts/ci.sh`, another protected path. `scripts/ci.sh`'s guard that the test never changes the real `scripts/codex-review.sh` still holds: the test copies it into the scratch repository and never writes outside it.

## Contract-test changes

None. The changed test is a tooling test of the review scripts, not a contract test.

## Decision concerns

None.
