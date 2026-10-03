#!/usr/bin/env bash
# PreToolUse guard for Bash — enforces the toolchain rules in AGENTS.md.
# Exit 2 blocks the call and returns stderr to Claude.
# Regression cases: .claude/hooks/guard-bash.test.sh
set -euo pipefail

cmd=$(bun -e 'const j = await Bun.stdin.json(); process.stdout.write(j.tool_input?.command ?? "")')

block() {
  echo "Blocked by .claude/hooks/guard-bash.sh: $1" >&2
  exit 2
}

# Patterns match in command position only (start of a line or after a shell
# operator), so text that merely mentions a command, such as a grep pattern
# or a heredoc commit message, passes. A git segment ends at an operator or
# newline; flags inside a quoted `-m` message still match (strict side).
nl=$'\n'
start="(^|[;&|(${nl}])[[:space:]]*"
git_segment="${start}git[[:space:]][^;&|${nl}]*"
bun_test="${start}bun[[:space:]]+test([[:space:];&|)]|\$)"
commit_short_n="${start}git[[:space:]]+commit[^;&|${nl}]*[[:space:]]-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|\$)"
lefthook_off="${start}((export|env)[[:space:]]+)?LEFTHOOK=(0|false)([[:space:]]|\$)"

if [[ $cmd =~ $bun_test ]]; then
  block "never run 'bun test' — Vitest runs under Node. Use 'bun run test' or 'bunx vitest run'."
fi

if [[ $cmd =~ ${git_segment}--no-verify || $cmd =~ ${git_segment}core\.hooksPath ||
  $cmd =~ $commit_short_n || $cmd =~ $lefthook_off ]]; then
  block "git hooks must not be bypassed. Fix the failing check instead."
fi

exit 0
