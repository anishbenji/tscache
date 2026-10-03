#!/usr/bin/env bash
# Automated Codex review of the current step branch (docs/workflow.md).
#
#   scripts/codex-review.sh <NN>                         review (prompt C)
#   scripts/codex-review.sh <NN> --adversarial "<focus>" adversarial review (prompt D)
#   scripts/codex-review.sh <NN> [...] --print-prompt    print the prompt only
#
# Codex runs headless in a read-only sandbox, which cannot run `bun run ci`
# (installs and builds need to write), so CI runs here first and its result
# is handed to the reviewer. Each run is a fresh Codex session; later rounds
# see earlier triage through docs/reviews/step-NN.md. Raw output lands in
# .reviews/step-NN/ (gitignored); the committed record is the triage file.
set -euo pipefail

usage() {
  echo "usage: $0 <NN> [--adversarial <focus>] [--print-prompt]" >&2
  exit 2
}

[[ $# -ge 1 && $1 =~ ^[0-9]{2}$ ]] || usage
step=$1
shift
focus=""
print_only=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --adversarial) [[ $# -ge 2 ]] || usage; focus=$2; shift 2 ;;
    --print-prompt) print_only=true; shift ;;
    *) usage ;;
  esac
done

root=$(git rev-parse --show-toplevel)
cd "$root"
branch=$(git branch --show-current)
[[ -n $branch && $branch != main ]] || { echo "check out the step branch first" >&2; exit 2; }

triage="docs/reviews/step-$step.md"
out_dir=".reviews/step-$step"
kind=$([[ -n $focus ]] && echo adversarial || echo round)
shopt -s nullglob
previous=("$out_dir/$kind"-*.md)
round=$((${#previous[@]} + 1))
out="$out_dir/$kind-$round.md"

ci_report="(not run: --print-prompt)"
if ! $print_only; then
  mkdir -p "$out_dir"
  echo "running bun run ci ..." >&2
  set +e
  bun run ci >"$out_dir/$kind-$round.ci.log" 2>&1
  ci_exit=$?
  set -e
  ci_status=$([[ $ci_exit -eq 0 ]] && echo PASS || echo FAIL)
  ci_report="$ci_status (exit $ci_exit). Last lines:
$(tail -n 30 "$out_dir/$kind-$round.ci.log")"
fi

history=""
if [[ -f $triage ]]; then
  history="This is $kind $round. Earlier rounds are triaged in $triage. Check that every accepted finding is actually fixed and re-raise it if not. Re-raise a rejected finding only if the rejection reason is wrong, and say why. Then report anything new."
fi

if [[ -n $focus ]]; then
  prompt="Adversarial read-only review. Do not edit, create, stage or commit anything.
Review \`git diff main...$branch\` and \`git log main..$branch\` — step $step of the commit plan in starter-prompt.md §11.
Challenge the approach, not just the code: hidden assumptions, failure modes, and whether a simpler design within the locked decisions would be safer. Focus: $focus.
Locked decisions (starter-prompt.md §3, docs/architecture.md §7–§8) are not findings. If you think one is wrong, put it under \"Decision concerns\".
$history
Use the output format in docs/review-checklist.md."
  effort=xhigh
else
  prompt="Read-only code review. Do not edit, create, stage or commit anything.
Review \`git diff main...$branch\` and \`git log main..$branch\` — step $step of the commit plan in starter-prompt.md §11.
Check the diff against docs/review-checklist.md, docs/architecture.md and AGENTS.md.
$history
Report findings in the checklist's output format, most severe first, then the verdict. Only report issues tied to a line and a concrete failure scenario."
  effort=high
fi
prompt="$prompt

Your sandbox is read-only and cannot run \`bun run ci\`. The implementer ran it on the host immediately before this review; treat a FAIL as a finding. You may run read-only checks yourself (\`bunx vitest run\`, \`bunx tsc -p packages/tscache\`).
bun run ci: $ci_report"

if $print_only; then
  printf '%s\n' "$prompt"
  exit 0
fi

echo "codex $kind $round (effort $effort) → $out" >&2
codex exec -s read-only -C "$root" -c "model_reasoning_effort=\"$effort\"" \
  -o "$out" - <<<"$prompt" >"$out_dir/$kind-$round.log" 2>&1
grep -m1 '^session id:' "$out_dir/$kind-$round.log" >&2 || true
echo "$out"
