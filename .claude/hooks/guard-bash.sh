#!/usr/bin/env bash
# PreToolUse guard for Bash — enforces the toolchain rules in AGENTS.md.
# Exit 2 blocks the call and returns stderr to Claude.
# Regression cases: .claude/hooks/guard-bash.test.sh
#
# This is a tripwire against accidental violations, not a security boundary:
# regexes cannot fully parse shell (variables, eval, aliases and scripts on
# disk all evade it). The rules bind through AGENTS.md regardless.
set -euo pipefail

cmd=$(bun -e 'const j = await Bun.stdin.json(); process.stdout.write(j.tool_input?.command ?? "")')

block() {
  echo "Blocked by .claude/hooks/guard-bash.sh: $1" >&2
  exit 2
}

# Strip quotes and backslashes so spliced words (`"bun" test`,
# `--no-ver""ify`) match; lowercase for case-insensitive git config keys.
plain=$(printf '%s' "$cmd" | tr -d "\"'\\\\")
lower=$(printf '%s' "$plain" | tr '[:upper:]' '[:lower:]')
nl=$'\n'

# `bun test` in command position: start of a line, after a shell operator or
# backtick, or behind a wrapper (sudo, env, bash -c, ...). Plain mentions in
# commit messages and docs pass.
wrapper="(sudo|env|command|exec|time|nohup|xargs|-c)[[:space:]][^;&|${nl}]*"
bun_test="(^|[;&|(\`${nl}]|${wrapper})[[:space:]]*([^[:space:];&|]*/)?bun[[:space:]]+test([[:space:];&|)\`]|\$)"
if [[ $plain =~ $bun_test ]]; then
  block "never run 'bun test' — Vitest runs under Node. Use 'bun run test' or 'bunx vitest run'."
fi

# Hook bypasses fail closed: match anywhere, so wrappers cannot hide them.
# Git accepts unambiguous prefixes of long options, so `--no-v...` counts.
# The one exemption is a command that never invokes git, e.g. grepping the
# docs for the rule. A git commit whose message mentions a bypass flag is
# blocked (strict side).
invokes_git="(^|[^[:alnum:]_.-])git([^[:alnum:]_-]|\$)"
git_bypass="--no-v[a-z]*|core\.hookspath"
lefthook_off="lefthook=(0|false)([^[:alnum:]_]|\$)|lefthook_(exclude|skip)=|lefthook[[:space:]]+uninstall"
commit_short_n="git[[:space:]]+commit[^;&|${nl}]*[[:space:]]-[a-z]*n[a-z]*([[:space:]]|\$)"
if [[ $lower =~ $lefthook_off || $lower =~ $commit_short_n ]] ||
  [[ $lower =~ $invokes_git && $lower =~ $git_bypass ]]; then
  block "git hooks must not be bypassed. Fix the failing check instead."
fi

exit 0
