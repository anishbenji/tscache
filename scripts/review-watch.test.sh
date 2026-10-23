#!/usr/bin/env bash
# Regression cases for scripts/review-watch.sh, against stand-in review
# scripts in a scratch repository (step 14 round 8). Run by scripts/ci.sh.
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
git init -q || exit 1
mkdir scripts || exit 1
cp "$here/review-watch.sh" scripts/ || exit 1
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
