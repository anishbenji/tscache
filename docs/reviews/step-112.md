# Step 112 — raise the Fallow health floor from 90 to 95

Branch: `chore/112-fallow-floor-95` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled (round 1: no findings)

## Scope

User decision 62 item 3 (2026-11-16): raise the Fallow health floor to 95. Step 83 set the floor at 90 and planned 95 for later (`docs/reviews/step-83.md`); the refactors of steps 93, 106 and 109 brought the gated score to 97.9 (`docs/reviews/step-109.md`), which leaves the new floor 2.9 points of headroom.

| Commit (by subject)                                     | What                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `chore(fallow): raise the health floor from 90 to 95`   | `package.json`, `scripts/ci.sh` and `docs/workflow.md` state 95. |
| `docs(review): step 112, the fallow health floor at 95` | This file.                                                       |

## The change

- Root `package.json`: `"fallow:health": "fallow health --min-score 95"`. The pre-push hook (`lefthook.yml`) and `scripts/ci.sh` both run this script, so both now gate at 95.
- `scripts/ci.sh`: the comment above `bun run fallow:health` states the floor as 95 and drops the note that raising it was a later step.
- `docs/workflow.md` (setup item 3): the command and the sentence describing the floor state 95.

`git grep -n -e 'min-score' -e 'floor'` found no other current-state text giving the floor as 90: `lefthook.yml` says only "The health floor, as in scripts/ci.sh (step 83)", and `AGENTS.md`, `CLAUDE.md` and `README.md` name the script without a number. The historical review files (`docs/reviews/step-*.md`, `docs/reviews/2026-11-review.md`) are left as written. `docs/INDEX.md` needs no edit: the `docs/workflow.md` row's size is unchanged (18,499 bytes, 18.5 KB) and review files carry no row of their own.

## Verification

Measured on the branch, cut from `origin/main` at `781c378`:

| Command                                                              | Exit | What it showed                                                                  |
| -------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------- |
| `bunx fallow health --min-score 95`                                  | 0    | The project passes the new floor.                                               |
| `bunx fallow health --min-score 97.9`                                | 0    | The gated score is 97.9 (`--score` prints it rounded to 98 A; coupling −2.1).   |
| `bunx fallow health --min-score 97.901`                              | 1    | The score is not above 97.9.                                                    |
| `bun run fallow:health` (script at 95)                               | 0    | The script passes on the branch.                                                |
| `bun run fallow:health` with a temporary `--min-score 99`            | 1    | `Health score 97.9 (A) is below minimum threshold 99`: the floor bites. Undone. |
| `~/code/tscache-reports/bin/heavy-run.sh "112 child: ci" bun run ci` | 0    | Run on the final head, the commit that adds this file.                          |

## Contract-test changes

None.

## Round 1 (GPT-6.1 Sol, high) — reviewer verdict: merge

Run on head `f76d33b`. No findings. The reviewer checked that the floor reads 95 everywhere it is stated and that CI and
pre-push share the one script; the round's `bun run ci` exited 0. Raw output: `.reviews/step-112/round-1.md`. The
review has settled.

## Decision concerns

None.
