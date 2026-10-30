#!/usr/bin/env bash
# Runs test files many times to surface flakes (docs/testing.md).
#
#   scripts/flake-hunt.sh [-n RUNS] [--load] [--base REF | --all] [FILE...]
#
# FILEs ending in .test.ts run under Vitest, each run a fresh process, as
# CI runs them. FILEs ending in .spec.ts run under Playwright with
# --repeat-each RUNS, one worker and no retries: each app's spec shares
# that app's mock backend and its clock, so copies of a test running side
# by side would disturb each other. Without FILEs, the test files changed
# since REF (default main), or with --all every test file. --load keeps one
# busy loop per core running throughout, as a loaded machine or runner
# would. Prints each failing test with its count and exits 1 if any test
# failed. Logs go to FLAKE_HUNT_LOGS, or a new temporary directory.
#
# Playwright needs the package built first (bun run build). On a shared
# machine, run this as a heavy job (one at a time).
set -euo pipefail

runs=20
load=false
base=main
all=false
files=()
while [[ $# -gt 0 ]]; do
  case $1 in
    -n) runs=$2; shift 2 ;;
    --load) load=true; shift ;;
    --base) base=$2; shift 2 ;;
    --all) all=true; shift ;;
    *) files+=("$1"); shift ;;
  esac
done

if [[ ${#files[@]} -eq 0 ]] && $all; then
  while IFS= read -r file; do files+=("$file"); done < <(git ls-files -- '*.test.ts' '*.spec.ts')
elif [[ ${#files[@]} -eq 0 ]]; then
  # Resolved and listed by checked commands first: a failure inside the
  # process substitution below would not stop the script, and a mistyped
  # base would look like a branch with no test changes.
  if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
    echo "flake-hunt: unknown base '$base'" >&2
    exit 1
  fi
  fork=$(git merge-base "$base" HEAD)
  changed=$(git diff --name-only "$fork" -- '*.test.ts' '*.spec.ts')
  while IFS= read -r file; do
    [[ -n $file && -f $file ]] && files+=("$file")
  done <<<"$changed"
fi
if [[ ${#files[@]} -eq 0 ]]; then
  echo "flake-hunt: no test files changed since $base"
  exit 0
fi

vitest=()
playwright=()
for file in "${files[@]}"; do
  case $file in
    *.test.ts) vitest+=("$file") ;;
    *.spec.ts) playwright+=("$file") ;;
    *) echo "flake-hunt: skipping $file (not a .test.ts or .spec.ts)" >&2 ;;
  esac
done

busy=()
stop_load() { [[ ${#busy[@]} -eq 0 ]] || kill "${busy[@]}" 2>/dev/null || true; }
trap stop_load EXIT
if $load; then
  cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)
  for _ in $(seq "$cores"); do
    yes >/dev/null &
    busy+=($!)
  done
  echo "flake-hunt: $cores busy loops running"
fi

out=${FLAKE_HUNT_LOGS:-$(mktemp -d)}
mkdir -p "$out"
status=0

if [[ ${#vitest[@]} -gt 0 ]]; then
  echo "flake-hunt: Vitest, $runs runs of ${vitest[*]}"
  for i in $(seq "$runs"); do
    bunx vitest run --reporter=json --outputFile="$out/vitest-$i.json" "${vitest[@]}" >"$out/vitest-$i.log" 2>&1 || status=1
  done
  # Failing tests across the runs, with their counts; a run that wrote no
  # report (a crash) counts as a failure of the whole run.
  bun -e '
    const [dir, runs] = [process.argv[1], Number(process.argv[2])];
    const counts = new Map();
    let lost = 0;
    for (let i = 1; i <= runs; i++) {
      const file = Bun.file(`${dir}/vitest-${i}.json`);
      if (!(await file.exists())) { lost++; continue; }
      for (const suite of (await file.json()).testResults) {
        for (const t of suite.assertionResults) {
          if (t.status !== "failed") continue;
          const name = `${suite.name.replace(process.cwd() + "/", "")} > ${t.fullName}`;
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
    }
    for (const [name, n] of counts) console.log(`  ${n}/${runs} failed: ${name}`);
    if (lost > 0) console.log(`  ${lost}/${runs} runs wrote no report (see the logs)`);
    if (counts.size === 0 && lost === 0) console.log(`  0 failures in ${runs} runs`);
  ' "$out" "$runs"
fi

if [[ ${#playwright[@]} -gt 0 ]]; then
  echo "flake-hunt: Playwright, each test $runs times: ${playwright[*]}"
  bunx playwright test "${playwright[@]}" --repeat-each "$runs" --workers 1 --retries 0 \
    --reporter=line >"$out/playwright.log" 2>&1 || status=1
  grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)' "$out/playwright.log" || true
  grep -E '^\s+\[[a-z]+\] › .*' "$out/playwright.log" | sort | uniq -c | sed 's/^/  failed: /' || true
fi

echo "flake-hunt: logs in $out"
exit "$status"
