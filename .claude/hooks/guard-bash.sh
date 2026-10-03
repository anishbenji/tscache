#!/usr/bin/env bash
# PreToolUse guard for Bash — enforces the toolchain rules in AGENTS.md.
# Exit 2 blocks the call and returns stderr to Claude.
set -euo pipefail

cmd=$(bun -e 'const j = await Bun.stdin.json(); process.stdout.write(j.tool_input?.command ?? "")')

block() {
  echo "Blocked by .claude/hooks/guard-bash.sh: $1" >&2
  exit 2
}

# `bun test` in command position only, so commit messages mentioning it pass.
bun_test='(^|[;&|(])[[:space:]]*bun[[:space:]]+test([[:space:];&|)]|$)'
if [[ $cmd =~ $bun_test ]]; then
  block "never run 'bun test' — Vitest runs under Node. Use 'bun run test' or 'bunx vitest run'."
fi

if [[ $cmd =~ --no-verify|LEFTHOOK=0 ]]; then
  block "git hooks must not be bypassed. Fix the failing check instead."
fi

exit 0
