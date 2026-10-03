#!/usr/bin/env bash
# Regression cases for guard-bash.sh. Run: bash .claude/hooks/guard-bash.test.sh
set -uo pipefail

guard="$(dirname "$0")/guard-bash.sh"
failures=0

# expect <block|allow> <command>
expect() {
  local want=$1 cmd=$2 got
  if CMD="$cmd" bun -e 'process.stdout.write(JSON.stringify({ tool_input: { command: process.env.CMD } }))' |
    bash "$guard" 2>/dev/null; then
    got=allow
  else
    got=block
  fi
  if [[ $got != "$want" ]]; then
    echo "FAIL: expected $want, got $got: $(printf '%q' "$cmd")" >&2
    failures=$((failures + 1))
  fi
}

nv="--no-""verify" # split so this file's own text never trips the guard
lh="LEFTHOOK""=0"

expect block "bun test"
expect block "bun test --help"
expect block "cd packages/tscache && bun test"
expect block "(bun test)"
expect block $'echo ready\nbun test'
expect allow "bun run test"
expect allow "bunx vitest run"
expect allow "git commit -m 'never run bun test'"

expect block "git commit $nv -m x"
expect block "git push $nv"
expect block "git commit -n -m x"
expect block "git commit -anm x"
expect block "$lh git commit -m x"
expect block "export $lh"
expect block $'echo hi\nexport '"$lh"
expect block "git -c core.hooksPath=/dev/null commit -m x"
expect block "sudo git commit $nv -m x"
expect block "env FOO=1 git push $nv"
expect block "/usr/bin/git commit $nv -m x"
expect block "bash -c \"git commit $nv -m x\""
expect block "$lh bun run release"
expect block "bash -c '$lh git commit -m x'"
expect block "LEFTHOOK""=false git commit -m x"
expect block "sudo git commit -n -m x"
expect block $'git commit -F - <<\'EOF\'\ndocs: forbid '"$nv"$'\nEOF'
expect block "git commit --no-ver\"\"ify -m x"
expect block "git commit --no-verif\\y -m x"
expect block "git commit --no-verif -m x"
expect block "git push --no-v"
expect block "git config core.hookspath /dev/null"
expect block "git -c Core.HooksPath=/dev/null commit -m x"
expect block "LEFTHOOK='0' git commit -m x"
expect block "LEFTHOOK=\"false\" git commit -m x"
expect block "LEFTHOOK_EXCLUDE""=tests git push"
expect block "bunx lefthook uninstall"
expect block "sudo bun test"
expect block "env CI=1 bun test"
expect block "bash -c 'bun test'"
expect block "\"bun\" test"
expect block "/opt/homebrew/bin/bun test"
expect block "echo \`bun test\`"
expect allow "rg -- \"$nv\" AGENTS.md"
expect allow "git commit -m 'document the bun test ban'"
expect allow "git log --oneline -n 5"
expect allow "git log -n 3"
expect allow "git commit -m 'add digit check'"
expect allow "LEFTHOOK_VERBOSE=1 bunx lefthook run pre-push"

if [[ $failures -gt 0 ]]; then
  echo "$failures guard case(s) failed" >&2
  exit 1
fi
echo "guard-bash: all cases pass"
