#!/usr/bin/env bash
# PreToolUse guard for Bash. The logic lives in guard-bash.ts (a small shell
# tokenizer); this wrapper keeps the hook path in .claude/settings.json.
# Claude Code only blocks on exit 2, so any other failure (a crash, a missing
# bun) is turned into a block rather than silently allowing the command.
bun "$(dirname "$0")/guard-bash.ts"
status=$?
[[ $status -eq 0 ]] && exit 0
[[ $status -eq 2 ]] || echo "Blocked by .claude/hooks/guard-bash.sh: guard failed (exit $status); fix the guard." >&2
exit 2
