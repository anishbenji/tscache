#!/usr/bin/env bash
# Cases for commitlint.config.mjs: Dependabot's capitalised "Bump" subject
# is skipped, and nothing else is (chore/18). Run by scripts/ci.sh.
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
check() { # name expected-exit message
  printf '%s\n' "$3" | bunx commitlint >/dev/null 2>&1
  local got=$?
  if [[ $2 == "$got" ]]; then echo "ok   $1"; else echo "FAIL $1: expected exit $2, got $got"; fail=1; fi
}
signoff='Signed-off-by: dependabot[bot] <support@github.com>'

# Dependabot's own commits (subject and trailer as in #7) pass.
check "Dependabot's capitalised bump passes" 0 "chore: Bump typescript from 6.0.3 to 7.0.2

Bumps [typescript](https://github.com/microsoft/TypeScript) from 6.0.3 to 7.0.2.

$signoff"
check "Dependabot's capitalised actions bump passes" 0 "ci: Bump the actions group with 2 updates

$signoff"

# Everything else is still linted.
check "a capitalised bump without the trailer fails" 1 "chore: Bump typescript from 6.0.3 to 7.0.2"
check "a capitalised subject with the trailer fails" 1 "chore: Update the docs

$signoff"
check "a lowercase bump passes" 0 "chore: bump typescript from 6.0.3 to 7.0.2"

exit $fail
