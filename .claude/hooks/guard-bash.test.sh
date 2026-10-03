#!/usr/bin/env bash
# Regression cases for guard-bash.sh. Run: bash .claude/hooks/guard-bash.test.sh
# The threat model is in the header of guard-bash.ts.
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

# ── Forbidden test runner, literal spellings ──
expect block "bun test"
expect block "bun test --help"
expect block "cd packages/tscache && bun test"
expect block "(bun test)"
expect block "{ bun test; }"
expect block $'echo ready\nbun test'
expect block "CI=1 bun test"
expect block "2>/dev/null bun test"
expect block "bun test 2>&1 | tail -5"
expect block "\"bun\" test"
expect block "b\\un test"
expect block "bun 'test'"
expect block "\$'b\\x75n' test"
expect block "/opt/homebrew/bin/bun test"
expect block "bun --cwd packages/tscache test"
expect block "bun -c bunfig.toml test"
expect block "bun --console-depth 5 test"
expect block "bun --smol test"
expect block "echo \`bun test\`"
expect block "echo \$(bun test)"
expect block "echo \"\$(bun test)\""
expect block $'cat <<EOF\n$(bun test)\nEOF'
expect block $'bash <<\'EOF\'\nbun test\nEOF'
expect block "sudo bun test"
expect block "env CI=1 bun test"
expect block "nice -n 5 bun test"
expect block "timeout -s KILL 5 bun test"
expect block "timeout --signal KILL 5 bun test"
expect block "time -p bun test"
expect block "builtin command bun test"
expect block "bash -c 'bun test'"
expect block "eval 'bun test'"
expect block "builtin eval 'bun test'"
expect block "env -S 'bun test'"
expect block "env -S'bun test'"
expect block "env -S 'bash -c' 'bun test'"
expect block "bun \$'test\\0ignored'"
expect block "bun test\$'\\0'"
expect block "coproc bun test"
expect block "coproc NAME { bun test; }"
expect block "for x in 1; do bun test; done"
expect block "case a in a) bun test;; esac"

# ── Hook bypasses, literal spellings ──
expect block "git commit $nv -m x"
expect block "git push $nv"
expect block "git commit --no-ver\"\"ify -m x"
expect block "git commit --no-verif -m x"
expect block "git commit --no-veri -m x"
expect block "git commit -n -m x"
expect block "git commit -anm x"
expect block "git -C packages/tscache commit -n -m x"
expect block "git -c user.name=x commit -n -m x"
expect block "2>/dev/null git commit $nv -m x"
expect block "git commit $nv -m x 2>&1"
expect block "sudo git commit $nv -m x"
expect block "env FOO=1 git push $nv"
expect block "/usr/bin/git commit $nv -m x"
expect block "nice -n 5 git commit -n -m x"
expect block "xargs -I {} git commit -n -m {}"
expect block "bash -c \"git commit $nv -m x\""
expect block "function f { git commit -n -m x; }; f"
expect block "diff <(git commit -n -m x) /dev/null"
expect block "git -c $hp=/dev/null commit -m x"
expect block "git -c Core.HooksPath=/dev/null commit -m x"
expect block "git config $hp /dev/null"
expect block "git config --global $hp /dev/null"
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
expect block "bunx --bun lefthook uninstall"
expect block "bun x lefthook uninstall"
expect block "bun run lefthook uninstall"
expect block "bun --cwd . x lefthook uninstall"
expect block "bun x git commit -n -m x"
expect block "git config $hp list"
expect block "git config $hp get"
expect block "git config --global $hp unset"
expect block "git config --file get $hp /dev/null"
expect block "git config -f list $hp /dev/null"
expect block "bun run --cwd x lefthook uninstall"
expect allow "git config get $hp"
expect allow "git config --file .git/config --get $hp"
expect allow "git config list"
expect allow "git config unset $hp"
expect allow "bun x vitest run"
expect allow "bun run ci"

# ── Ordinary commands that must pass ──
expect allow "bun run test"
expect allow "bunx vitest run"
expect allow "bun run test 2>&1 | tail -5"
expect allow "bun --cwd packages/tscache run test"
expect allow "bun run test --testNamePattern \"\$PATTERN\""
expect allow "bun run test --testNamePattern '{foo,bar}'"
expect allow "command -v bun test"
expect allow "echo bun test"
expect allow "cat <<< 'bun test'"
expect allow $'cat <<\'EOF\'\n$(bun test)\nEOF'
expect allow "diff <(echo a) <(echo b)"
expect allow "git commit -m 'never run bun test'"
expect allow "git commit -m 'docs: explain \`bun test\` prohibition'"
expect allow "git commit -m 'docs: explain (bun test) prohibition'"
expect allow "git commit -m 'fix -n handling'"
expect allow "git commit -m 'document the $nv ban'"
expect allow "git commit -m '$nv is forbidden'"
expect allow "git commit --message '$nv is forbidden'"
expect allow "git commit -m 'docs: $hp'"
expect allow "git commit -m 'docs: $nv' '{file,other}'"
expect allow "git commit -mn"
expect allow "git commit -m x 2>&1"
expect allow $'git commit -F - <<\'EOF\'\ndocs: forbid '"$nv"$'\nEOF'
expect allow $'git commit -m "$(cat <<\'EOF\'\nfix: stop lefthook from skipping bun test; see -n note\nEOF\n)"'
expect allow "git commit -m \"\$MSG\""
expect allow "git commit --message=\"\$(printf 'docs: $nv')\""
expect allow "git log -n 3"
expect allow "git log --oneline -n 5"
expect allow "git log --grep='$nv' \"\$REV\""
expect allow "git log \"\$REV\"; rg -- '$nv' AGENTS.md"
expect allow "git branch --no-verbose"
expect allow "git config --get $hp"
expect allow "git config --unset $hp"
expect allow "git push origin \"\$BRANCH\""
expect allow "git push -o ci.skip origin main"
expect allow "needle=$hp; rg \"\$needle\" AGENTS.md"
expect allow "rg -- \"$nv\" AGENTS.md"
expect allow "grep -n $lh docs/workflow.md"
expect allow "LEFTHOOK_VERBOSE=1 bunx lefthook run pre-push"
expect allow "echo \$HOME"

# ── Out of scope (run-time values, stdin, aliases, unparseable input) ──
# These pass by design; `bun run ci` re-checks every commit on the branch.
expect allow "F=$nv; git commit \$F -m x"
expect allow "git commit \$(echo $nv) -m x"
expect allow "echo test | xargs bun"
expect allow "\$GIT commit $nv -m x"
expect allow "{bun,test}"
expect allow "LEFTHOOK=\$(printf 0) git commit -m x"
expect allow "printf 'bun test\\n' | bash"
expect allow $'shopt -s expand_aliases\nalias bt=\'bun test\'\nbt'
expect allow $'git commit -n -m x\necho "'

# A crashing guard must let the command through (not exit 2).
echo '{not json' | bash "$guard" 2>/dev/null
if [[ $? -eq 2 ]]; then
  echo "FAIL: guard crash blocked the command" >&2
  failures=$((failures + 1))
fi

if [[ $failures -gt 0 ]]; then
  echo "$failures guard case(s) failed" >&2
  exit 1
fi
echo "guard-bash: all cases pass"
