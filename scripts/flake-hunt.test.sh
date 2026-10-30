#!/usr/bin/env bash
# Cases for scripts/flake-hunt.sh: every bad input is rejected before
# anything runs, naming the input, and a hunt that executes no test fails
# however it got there (chore 28 rounds 1 to 3). Only the last two cases
# start Vitest, for one run each. Run by scripts/ci.sh.
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
check() { # name expected-exit expected-output-pattern args...
  local name=$1 want=$2 pattern=$3
  shift 3
  local out got
  out=$(scripts/flake-hunt.sh "$@" 2>&1)
  got=$?
  if [[ $got == "$want" ]] && grep -qE -- "$pattern" <<<"$out"; then
    echo "ok   $name"
  else
    echo "FAIL $name: expected exit $want and /$pattern/, got exit $got: $out"
    fail=1
  fi
}
test=reference/shared/test/range.test.ts

# The run count.
check "a zero count fails" 1 "run count must be a positive integer, not '0'" -n 0 "$test"
check "a negative count fails" 1 "run count must be a positive integer, not '-1'" -n -1 "$test"
check "a non-numeric count fails" 1 "run count must be a positive integer, not 'abc'" -n abc "$test"
check "a count without a value fails" 1 "-n needs a value" "$test" -n
# The worker count.
check "a zero worker count fails" 1 "worker count must be a positive integer, not '0'" --workers 0 "$test"
check "a non-numeric worker count fails" 1 "worker count must be a positive integer, not 'two'" --workers two "$test"
# The base.
check "an unknown base fails" 1 "unknown base 'no-such-branch-x'" --base no-such-branch-x
check "a base and files together fail" 1 "not more than one" --base HEAD "$test"
check "--all and a base together fail" 1 "not more than one" --all --base HEAD
# The files.
check "a missing test file fails" 1 "no such test file 'packages/tscache/test/orchestrato.test.ts'" \
  packages/tscache/test/orchestrato.test.ts
check "a file that is not a test fails" 1 "'README.md' is not a test file of a known runner" README.md
check "an unknown option fails" 1 "unknown option '--runs'" --runs 3 "$test"
# Nothing to hunt in: the branch itself as the base.
check "no changed test files fails" 1 "nothing to hunt in: no test files changed since HEAD" --base HEAD

# The invariant: a test file Vitest does not run (outside its include
# globs) executes no test.
outside=$(mktemp -d)
printf 'import { it } from "vitest";\nit("runs", () => {});\n' >"$outside/stray.test.ts"
check "a hunt that executes no test fails" 1 "executed no test" -n 1 "$outside/stray.test.ts"
rm -rf "$outside"
# And a real one passes, counting what it ran.
check "a real test file passes" 0 "[1-9][0-9]* tests executed" -n 1 "$test"
exit "$fail"
