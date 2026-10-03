#!/usr/bin/env bash
# PreToolUse guard for Bash. The logic lives in guard-bash.ts (a small shell
# tokenizer); this wrapper keeps the hook path in .claude/settings.json.
# Claude Code blocks only on exit 2. Any other failure (a crash, a missing
# bun) lets the command through with a warning: blocking every Bash call on a
# guard bug costs more than it protects, and `bun run ci` re-checks commits.
bun "$(dirname "$0")/guard-bash.ts"
status=$?
[[ $status -eq 0 || $status -eq 2 ]] && exit "$status"
echo "guard-bash: guard failed (exit $status); command allowed. Fix .claude/hooks/guard-bash.ts." >&2
exit 1
