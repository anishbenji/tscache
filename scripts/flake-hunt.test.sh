#!/usr/bin/env bash
# Cases for scripts/flake-hunt.sh that run no test: how it picks the files
# to hunt in. Run by scripts/ci.sh.
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
check() { # name expected-exit expected-output-pattern args...
  local name=$1 want=$2 pattern=$3
  shift 3
  local out got
  out=$(scripts/flake-hunt.sh "$@" 2>&1)
  got=$?
  if [[ $got == "$want" ]] && grep -qE "$pattern" <<<"$out"; then
    echo "ok   $name"
  else
    echo "FAIL $name: expected exit $want and /$pattern/, got exit $got: $out"
    fail=1
  fi
}

# A mistyped base hunts in nothing and must say so, not pass (chore 28 R1-3).
check "an unknown base fails" 1 "unknown base 'no-such-branch-x'" --base no-such-branch-x
# The branch itself as the base: nothing changed, nothing to run.
check "no changed test files passes" 0 "no test files changed since HEAD" --base HEAD
exit "$fail"
