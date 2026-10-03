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

# Split so this file's own text never trips the guard when edited via Bash.
nv="--no-""verify"
lh="LEFTHOOK""=0"
hp="core.hooks""Path"

# Forbidden test runner, in every command position.
expect block "bun test"
expect block "bun test --help"
expect block "cd packages/tscache && bun test"
expect block "(bun test)"
expect block "{ bun test; }"
expect block $'echo ready\nbun test'
expect block "CI=1 bun test"
expect block "sudo bun test"
expect block "env CI=1 bun test"
expect block "bash -c 'bun test'"
expect block "eval 'bun test'"
expect block "\"bun\" test"
expect block "b\\un test"
expect block "/opt/homebrew/bin/bun test"
expect block "echo \`bun test\`"
expect block "echo \"\`bun test\`\""
expect block "echo \$(bun test)"
expect block $'cat <<EOF\n$(bun test)\nEOF'
expect block "2>/dev/null bun test"
expect block ">/dev/null bun test"
expect block "bun test 2>&1 | tail -5"
expect block "\$'b\\x75n' test"
expect block "\$'\\x62un' test"
expect block "\$'\\142un' test"
expect block "bun --cwd packages/tscache test"
expect block "bun -c bunfig.toml test"
expect block "bun --smol test"
expect allow "bun run test"
expect allow "bun run test 2>&1 | tail -5"
expect allow "bun --cwd packages/tscache run test"
expect allow "cat <<< 'bun test'"
expect allow "diff <(echo a) <(echo b)"
expect allow "bunx vitest run"
expect allow "echo bun test"
expect allow "git commit -m 'never run bun test'"
expect allow "git commit -m 'docs: explain \`bun test\` prohibition'"
expect allow "git commit -m 'docs: explain (bun test) prohibition'"
expect allow $'cat <<\'EOF\'\n$(bun test)\nEOF'

# Hook bypasses, through flags, wrappers, global options and the environment.
expect block "git commit $nv -m x"
expect block "git push $nv"
expect block "git commit --no-ver\"\"ify -m x"
expect block "git commit --no-verif\\y -m x"
expect block "git commit --no-verif -m x"
expect block "git push --no-v"
expect block "git commit -n -m x"
expect block "git commit -anm x"
expect block "git -C packages/tscache commit -n -m x"
expect block "git -c user.name=x commit -n -m x"
expect block "sudo git commit $nv -m x"
expect block "env FOO=1 git push $nv"
expect block "/usr/bin/git commit $nv -m x"
expect block "bash -c \"git commit $nv -m x\""
expect block "git -c $hp=/dev/null commit -m x"
expect block "git -c Core.HooksPath=/dev/null commit -m x"
expect block "git config $hp /dev/null"
expect block "GIT_CONFIG_VALUE_0=x GIT_CONFIG_KEY_0=$hp git commit -m x"
expect block "$lh git commit -m x"
expect block "$lh bun run release"
expect block "LEFTHOOK='0' git commit -m x"
expect block "LEFTHOOK=\"false\" git commit -m x"
expect block "export $lh"
expect block $'echo hi\nexport '"$lh"
expect block "bash -c '$lh git commit -m x'"
expect block "LEFTHOOK_EXCLUDE""=tests git push"
expect block "bunx lefthook uninstall"
expect block "2>/dev/null git commit $nv -m x"
expect block "git commit $nv -m x 2>&1"
expect block "git commit -nm x"
expect block "git config --global $hp /dev/null"
expect block "diff <(git commit -n -m x) /dev/null"
expect allow "rg -- \"$nv\" AGENTS.md"
expect allow "git commit -m '$nv is forbidden'"
expect allow "git commit -m 'docs: $hp'"
expect allow "git commit --message '$nv is forbidden'"
expect allow "git commit -mn"
expect allow "git commit -m x 2>&1"
expect allow "git push -o ci.skip origin main"
expect allow "grep -n $lh docs/workflow.md"
expect allow "git log -n 3"
expect allow "git log --oneline -n 5"
expect allow "git commit -m 'add digit check'"
expect allow "git commit -m 'fix -n handling'"
expect allow "git commit -m 'document the $nv ban'"
expect allow $'git commit -F - <<\'EOF\'\ndocs: forbid '"$nv"$'\nEOF'
expect allow "LEFTHOOK_VERBOSE=1 bunx lefthook run pre-push"

# Dynamic input: values the guard cannot resolve statically fail closed
# when the command text contains a trigger.
expect block "git commit \$(echo $nv) -m x"
expect block "F=$nv; git commit \$F -m x"
expect block "F=$nv; git commit \"\$F\" -m x"
expect block "F=-n; git commit \$F -m x"
expect block "RUNNER=bun; \$RUNNER test"
expect block "echo $nv | xargs git commit -m x"
expect block "\$GIT commit $nv -m x"
expect block "git\${IFS}commit\${IFS}$nv"
expect block "{bun,test}"
expect block "X=$hp=/dev/null; git -c \"\$X\" commit -m x"
expect block "printf -v X %s $hp=/dev/null; git -c \"\$X\" commit -m x"
expect block "CMD='bun test'; sh -c \"\$CMD\""
expect block "CMD='git commit -n -m x'; eval \"\$CMD\""
expect block "CMD='bun test'; env -S \"\$CMD\""
expect block "echo test | xargs bun"
expect block "X=test; bun \$X"
expect block "\$(echo test) | xargs bun"
expect block $'lefthook run pre-commit --no-tty\necho "'
expect allow "git commit -m \"\$MSG\""
expect allow $'git commit -m "$(cat <<\'EOF\'\nfix: stop lefthook from skipping bun test; see -n note\nEOF\n)"'
expect allow "git push origin \"\$BRANCH\""
# Out of scope: the trigger was set in an earlier call, so no text shows it.
expect allow "git commit \"\$F\" -m x"
expect allow "\$RUNNER test"
expect allow "git log --since \"\$(date)\""
expect allow "bun run \$SCRIPT"
expect allow "echo \$HOME"

# Unparseable input falls back to text triggers, so an earlier complete
# line cannot slip through.
expect block $'git commit -n -m x\necho "'
expect block $'bun test\necho $(('
expect allow $'echo "unterminated'

# Wrapper options that take a value, and shell keyword forms.
expect block "nice -n 5 git commit -n -m x"
expect block "nice -n 5 bun test"
expect block "xargs -I {} git commit -n -m {}"
expect block "timeout -s KILL 5 bun test"
expect block "timeout --signal KILL 5 bun test"
expect block "time -p bun test"
expect block "env -S 'bun test'"
expect block "function f { git commit -n -m x; }; f"
expect block "coproc bun test"
expect block "coproc NAME { bun test; }"

# A crashing guard must block, not allow (Claude Code only blocks on exit 2).
echo '{not json' | bash "$guard" 2>/dev/null
if [[ $? -ne 2 ]]; then
  echo "FAIL: guard crash did not exit 2" >&2
  failures=$((failures + 1))
fi

if [[ $failures -gt 0 ]]; then
  echo "$failures guard case(s) failed" >&2
  exit 1
fi
echo "guard-bash: all cases pass"
