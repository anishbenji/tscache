#!/usr/bin/env bash
# Runs test files many times to surface flakes (docs/testing.md).
#
#   scripts/flake-hunt.sh [-n RUNS] [--workers N] [--load] [--base REF | --all] [FILE...]
#
# FILEs ending in .test.ts run under Vitest, each run a fresh process, as
# CI runs them. FILEs ending in .spec.ts run under Playwright with
# --repeat-each RUNS and no retries, on one worker unless --workers says
# otherwise: each app's spec shares that app's mock backend and its clock,
# so copies of a test running side by side disturb each other. Without
# FILEs, the test files changed since REF (default main), or with --all
# every test file. --load keeps one busy loop per core running throughout,
# as a loaded machine or runner would. Logs go to FLAKE_HUNT_LOGS, or a new
# temporary directory.
#
# Every input is checked before anything runs, and a bad one exits 1
# naming it: RUNS and N must be positive integers, REF must resolve, and
# every FILE must exist and be a .test.ts or .spec.ts file. The hunt exits
# 1 if any test failed, and also if it executed no test at all, whatever
# the reason: a hunt that ran nothing has shown nothing.
#
# Playwright needs the package built first (bun run build). On a shared
# machine, run this as a heavy job (one at a time).
set -euo pipefail

usage() {
  echo "usage: scripts/flake-hunt.sh [-n RUNS] [--workers N] [--load] [--base REF | --all] [FILE...]" >&2
  exit 1
}
reject() {
  echo "flake-hunt: $1" >&2
  exit 1
}
positive() { [[ $1 =~ ^[1-9][0-9]*$ ]]; }

# 1. Parse. Every option that takes a value must have one.
runs=20
workers=1
load=false
base=""
all=false
files=()
while [[ $# -gt 0 ]]; do
  case $1 in
    -n | --workers | --base)
      [[ $# -ge 2 ]] || reject "$1 needs a value"
      case $1 in
        -n) runs=$2 ;;
        --workers) workers=$2 ;;
        --base) base=$2 ;;
      esac
      shift 2
      ;;
    --load) load=true; shift ;;
    --all) all=true; shift ;;
    -h | --help) usage ;;
    -*) reject "unknown option '$1'" ;;
    *) files+=("$1"); shift ;;
  esac
done

# 2. Validate every input before running anything.
positive "$runs" || reject "the run count must be a positive integer, not '$runs'"
positive "$workers" || reject "the worker count must be a positive integer, not '$workers'"
if [[ -n $base ]] && ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  reject "unknown base '$base'"
fi
if [[ ${#files[@]} -gt 0 ]] && { $all || [[ -n $base ]]; }; then
  reject "give files, --base or --all, not more than one"
fi
if $all && [[ -n $base ]]; then
  reject "give files, --base or --all, not more than one"
fi
for file in ${files[@]+"${files[@]}"}; do
  [[ -f $file ]] || reject "no such test file '$file'"
  case $file in
    *.test.ts | *.spec.ts) ;;
    *) reject "'$file' is not a test file of a known runner (.test.ts for Vitest, .spec.ts for Playwright)" ;;
  esac
done

# 3. The files to hunt in, listed by checked commands: a failure inside a
# process substitution would not stop the script.
if [[ ${#files[@]} -eq 0 ]]; then
  if $all; then
    listed=$(git ls-files -- '*.test.ts' '*.spec.ts')
  else
    base=${base:-main}
    git rev-parse --verify --quiet "$base^{commit}" >/dev/null || reject "unknown base '$base'"
    fork=$(git merge-base "$base" HEAD)
    listed=$(git diff --name-only "$fork" -- '*.test.ts' '*.spec.ts')
  fi
  while IFS= read -r file; do
    if [[ -n $file && -f $file ]]; then files+=("$file"); fi
  done <<<"$listed"
  [[ ${#files[@]} -gt 0 ]] || reject "nothing to hunt in: no test files changed since $base"
fi

vitest=()
playwright=()
for file in "${files[@]}"; do
  case $file in
    *.test.ts) vitest+=("$file") ;;
    *.spec.ts) playwright+=("$file") ;;
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
executed=0

# 4. Run.
if [[ ${#vitest[@]} -gt 0 ]]; then
  echo "flake-hunt: Vitest, $runs runs of ${vitest[*]}"
  for i in $(seq "$runs"); do
    bunx vitest run --reporter=json --outputFile="$out/vitest-$i.json" "${vitest[@]}" >"$out/vitest-$i.log" 2>&1 || status=1
  done
  # Failing tests across the runs, with their counts; a run that wrote no
  # report (a crash) fails the hunt. The last line is the number of tests
  # the runs executed, for the invariant at the end.
  summary=$(bun -e '
    const [dir, runs] = [process.argv[1], Number(process.argv[2])];
    const counts = new Map();
    let lost = 0;
    let executed = 0;
    for (let i = 1; i <= runs; i++) {
      const file = Bun.file(`${dir}/vitest-${i}.json`);
      if (!(await file.exists())) { lost++; continue; }
      const report = await file.json();
      executed += report.numPassedTests + report.numFailedTests;
      for (const suite of report.testResults) {
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
    console.log(executed);
    process.exit(lost > 0 ? 1 : 0);
  ' "$out" "$runs") || status=1
  sed '$d' <<<"$summary"
  executed=$((executed + $(tail -n 1 <<<"$summary")))
fi

if [[ ${#playwright[@]} -gt 0 ]]; then
  echo "flake-hunt: Playwright, each test $runs times on $workers worker(s): ${playwright[*]}"
  bunx playwright test "${playwright[@]}" --repeat-each "$runs" --workers "$workers" --retries 0 \
    --reporter=line >"$out/playwright.log" 2>&1 || status=1
  grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)' "$out/playwright.log" || true
  grep -E '^\s+\[[a-z]+\] › .*' "$out/playwright.log" | sort | uniq -c | sed 's/^/  failed: /' || true
  # The leading count of "  N passed (1.2m)", not the duration.
  for count in $(grep -E '^[[:space:]]+[0-9]+ (passed|failed|flaky)' "$out/playwright.log" | grep -oE '^[[:space:]]+[0-9]+' || true); do
    executed=$((executed + count))
  done
fi

echo "flake-hunt: $executed tests executed; logs in $out"
# 5. The invariant, however the inputs got here.
[[ $executed -gt 0 ]] || reject "the hunt executed no test, so it has shown nothing"
exit "$status"
