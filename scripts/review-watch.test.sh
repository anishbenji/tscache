#!/usr/bin/env bash
# Regression cases for scripts/review-watch.sh, against stand-in review
# scripts in a scratch repository (step 14 round 8), and for the step
# numbers both review scripts accept (step 102). Run by scripts/ci.sh.
set -u
here=$(cd "$(dirname "$0")" && pwd)
fail=0
check() { # name expected actual
  if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: expected $2, got $3"; fail=1; fi
}

# Every case writes scripts/codex-review.sh, so it must never run outside
# a fresh scratch repository: any setup failure stops here.
scratch=$(mktemp -d) || { echo "cannot create a scratch directory" >&2; exit 1; }
[[ -n $scratch && -d $scratch ]] || { echo "no scratch directory" >&2; exit 1; }
trap 'rm -rf "$scratch"' EXIT
cd "$scratch" || exit 1
# A git hook or `git rebase -x` exports GIT_DIR and friends; left set, they
# would point the git commands below at the caller's repository.
unset $(git rev-parse --local-env-vars)
git init -q || exit 1
[[ $(git rev-parse --show-toplevel) == "$(pwd -P)" ]] || { echo "git is not in the scratch directory" >&2; exit 1; }
mkdir scripts || exit 1
cp "$here/review-watch.sh" "$here/codex-review.sh" scripts/ || exit 1
# codex-review.sh refuses to run on main; an unborn branch is enough.
git symbolic-ref HEAD refs/heads/chore/100-scratch || exit 1
# A step number the scripts wrongly accept must not start CI or a Codex
# review (step 102): these stand-ins come first on PATH and fail loudly.
mkdir stubs || exit 1
for tool in codex bun; do
  printf '#!/bin/sh\necho "review-watch.test.sh: %s must not run" >&2\nexit 97\n' "$tool" >"stubs/$tool"
  chmod +x "stubs/$tool" || exit 1
done
PATH="$scratch/stubs:$PATH"
# Step numbers have two or more digits: step 100 and later run, through
# the watchdog into the real review script; one digit, non-numbers and a
# zero-padded number above 99 (0102 would name .reviews/step-0102 and miss
# step-102's triage file) are usage errors. Every call passes
# --print-prompt, which starts neither CI nor Codex, so a wrongly accepted
# number only prints a prompt.
export REVIEW_POLL_SECONDS=1
scripts/review-watch.sh 100 --print-prompt >prompt.txt 2>/dev/null
check "three-digit step runs through the watchdog" 0 $?
/usr/bin/grep -q 'step 100 of' prompt.txt; check "prompt names step 100" 0 $?
[[ -d .reviews/step-100 ]]; check "watchdog watches .reviews/step-100" 0 $?
scripts/codex-review.sh 1234 --print-prompt >/dev/null 2>&1; check "four-digit step accepted" 0 $?
scripts/codex-review.sh 7 --print-prompt >/dev/null 2>&1; check "one-digit step rejected" 2 $?
scripts/review-watch.sh 7 --print-prompt >/dev/null 2>&1; check "watchdog rejects one digit" 2 $?
scripts/review-watch.sh 10x --print-prompt >/dev/null 2>&1; check "watchdog rejects a non-number" 2 $?
scripts/codex-review.sh 0102 --print-prompt >/dev/null 2>&1; check "zero-padded step rejected" 2 $?
scripts/review-watch.sh 0102 --print-prompt >/dev/null 2>&1
check "watchdog rejects a zero-padded step" 2 $?

stand_in() { printf '#!/usr/bin/env bash\n%s\n' "$1" > scripts/codex-review.sh; chmod +x scripts/codex-review.sh; }
export REVIEW_POLL_SECONDS=1 REVIEW_SILENCE_SECONDS=3

# A silent review is killed and reported as 124.
stand_in 'sleep 60'
scripts/review-watch.sh 01 2>/dev/null; check "silent review times out" 124 $?

# A review that writes output and finishes keeps its own status.
stand_in 'mkdir -p .reviews/step-01; for i in 1 2 3 4 5; do echo x >> .reviews/step-01/r.log; sleep 1; done; exit 7'
scripts/review-watch.sh 01 2>/dev/null; check "busy review keeps its status" 7 $?

# A review that finishes silently within one poll is not a timeout.
stand_in 'sleep 0.5; exit 0'
REVIEW_SILENCE_SECONDS=1 scripts/review-watch.sh 01 2>/dev/null
check "quick silent review exits 0" 0 $?

# A timeout kills only its own review: another process named like a
# review's codex session survives.
bash -c 'exec -a "codex exec -s read-only stand-in" sleep 30' &
other=$!
stand_in 'sleep 60'
scripts/review-watch.sh 01 2>/dev/null
kill -0 "$other" 2>/dev/null; check "other sessions survive a timeout" 0 $?
kill "$other" 2>/dev/null

exit $fail
