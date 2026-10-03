#!/usr/bin/env bash
# Full quality gate — superset of the lefthook pre-push hook. Written so the
# body can become a GitHub Actions workflow verbatim once a remote exists.
set -euo pipefail

bun install --frozen-lockfile
bunx biome ci .
bunx tsc -p packages/tscache
bunx knip
bun run fallow
bunx vitest run --passWithNoTests
bun run --filter tscache build   # includes publint + attw (esm-only profile)
(cd packages/tscache && npm pack --dry-run)
bunx playwright test --pass-with-no-tests
# bench smoke joins here with the first bench files (commit plan step ⑥+)
