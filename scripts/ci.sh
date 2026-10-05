#!/usr/bin/env bash
# Full quality gate — superset of the lefthook pre-push hook. GitHub Actions
# runs this same script (.github/workflows/ci.yml), so a local pass and a CI
# pass mean the same thing.
set -euo pipefail

# The commit the branch is compared against. Actions sets CI_BASE, because a
# pull request checkout has no local `main`.
base="${CI_BASE:-main}"

bun install --frozen-lockfile
bash .claude/hooks/guard-bash.test.sh
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
bunx tsc -p packages/tscache
bunx knip
bun run fallow
bunx vitest run --passWithNoTests
bun run --filter tscache build   # includes publint + attw (esm-only profile)
(cd packages/tscache && npm pack --dry-run)
bunx playwright test --pass-with-no-tests
# bench smoke joins here with the first bench files (commit plan step ⑥+)
