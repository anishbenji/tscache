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

# `bun test` in command position only (start of a line or after a shell
# operator), so commit messages and docs that mention it pass.
nl=$'\n'
bun_test="(^|[;&|(${nl}])[[:space:]]*bun[[:space:]]+test([[:space:];&|)]|\$)"
if [[ $cmd =~ $bun_test ]]; then
  block "never run 'bun test' — Vitest runs under Node. Use 'bun run test' or 'bunx vitest run'."
fi

# Hook bypasses fail closed: match anywhere in the text, so wrappers such as
# sudo, env, absolute paths or `bash -c` cannot hide them. The one exemption
# is a command that never invokes git, e.g. grepping the docs for the rule.
# A git commit whose message mentions a bypass flag is blocked (strict side).
invokes_git="(^|[^[:alnum:]_.-])git([^[:alnum:]_-]|\$)"
lefthook_off="LEFTHOOK=(0|false)([^[:alnum:]_]|\$)"
commit_short_n="git[[:space:]]+commit[^;&|${nl}]*[[:space:]]-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|\$)"
if [[ $cmd =~ $lefthook_off || $cmd =~ $commit_short_n ]] ||
  [[ $cmd =~ $invokes_git && $cmd =~ --no-verify|core\.hooksPath ]]; then
  block "git hooks must not be bypassed. Fix the failing check instead."
fi

exit 0
