#!/usr/bin/env bash
# Full quality gate — superset of the lefthook pre-push hook. GitHub Actions
# runs this same script (.github/workflows/ci.yml), so a local pass and a CI
# pass mean the same thing.
set -euo pipefail

# The commit the branch is compared against. Actions sets CI_BASE, because a
# pull request checkout has no local `main`.
base="${CI_BASE:-main}"
# Fallow's audit compares against the same base. Left unset, it compares a
# pushed branch against its upstream and audits only unpushed commits.
export FALLOW_AUDIT_BASE="${FALLOW_AUDIT_BASE:-$base}"

bun install --frozen-lockfile
bash .claude/hooks/guard-bash.test.sh
bash scripts/commitlint-config.test.sh
bash scripts/review-watch.test.sh
# With no usable scratch directory the test must stop, never touch the
# real review script (step 14 R9-1).
before=$(git hash-object scripts/codex-review.sh)
nomktemp=$(mktemp -d)
printf '#!/bin/sh\nexit 1\n' >"$nomktemp/mktemp"
chmod +x "$nomktemp/mktemp"
if PATH="$nomktemp:$PATH" bash scripts/review-watch.test.sh >/dev/null 2>&1; then
  echo "review-watch.test.sh ran without a scratch directory" >&2
  exit 1
fi
[ "$(git hash-object scripts/codex-review.sh)" = "$before" ] || {
  echo "review-watch.test.sh changed scripts/codex-review.sh" >&2
  exit 1
}
rm -rf "$nomktemp"
# Backstop for skipped git hooks: re-run the commit-time checks over every
# commit on the branch, however a hook was bypassed. `-m` includes merge
# diffs, so a secret added while resolving a merge is scanned too. Skipped
# when HEAD is the base itself (a run on main): the range holds no commits,
# and commitlint rejects an empty one.
if [ "$(git rev-parse "$base")" != "$(git rev-parse HEAD)" ]; then
  gitleaks git --log-opts="-m ${base}..HEAD" --redact --no-banner .
  bunx commitlint --from "$base" --to HEAD
fi
bunx biome ci .
bun run typecheck
# Built before Knip: the examples' Vite configs import tscache/vite from
# dist/, and Knip loads them; a fresh checkout has no dist/ yet.
bun run --filter tscache build   # includes publint + attw (esm-only profile)
bunx knip
bun run fallow
bunx vitest run --passWithNoTests
(cd packages/tscache && npm pack --dry-run)
# The integration snippets type-check against the built package, as an
# app would see it (starter §5, §7).
bun run check:integrations
bunx playwright test --pass-with-no-tests
# bench smoke joins here with the first bench files (commit plan step ⑥+)
