#!/usr/bin/env bash
# Full quality gate — superset of the lefthook pre-push hook. Written so the
# body can become a GitHub Actions workflow verbatim once a remote exists.
set -euo pipefail

bun install --frozen-lockfile
bash .claude/hooks/guard-bash.test.sh
# Backstop for skipped git hooks: re-run the commit-time checks over every
# commit on the branch, however a hook was bypassed.
gitleaks git --log-opts="main..HEAD" --redact --no-banner .
bunx commitlint --from main --to HEAD
bunx biome ci .
bunx tsc -p packages/tscache
bunx knip
bun run fallow
bunx vitest run --passWithNoTests
bun run --filter tscache build   # includes publint + attw (esm-only profile)
(cd packages/tscache && npm pack --dry-run)
bunx playwright test --pass-with-no-tests
# bench smoke joins here with the first bench files (commit plan step ⑥+)
