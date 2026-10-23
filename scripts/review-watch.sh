#!/usr/bin/env bash
# Runs scripts/codex-review.sh under a silence watchdog (docs/workflow.md).
#
#   scripts/review-watch.sh <NN> [codex-review.sh args...]
#
# Headless Codex sessions sometimes stall without output. When nothing
# under .reviews/step-NN/ grows for REVIEW_SILENCE_SECONDS (default 600),
# the review's process group (the review script and its `codex exec`, and
# nothing else) is killed and this script exits 124, so the caller can
# retry. Otherwise it exits with the review's own status. stdin is closed:
# `codex exec` otherwise waits on it for the whole timeout.
# REVIEW_POLL_SECONDS (default 30) sets how often output is checked.
set -u

[[ $# -ge 1 && $1 =~ ^[0-9]{2}$ ]] || {
  echo "usage: $0 <NN> [codex-review.sh args...]" >&2
  exit 2
}
step=$1
shift
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
dir=".reviews/step-$step"
mkdir -p "$dir"
limit=${REVIEW_SILENCE_SECONDS:-600}
poll=${REVIEW_POLL_SECONDS:-30}

# Total bytes under the review directory (portable: no stat flags).
size() {
  find "$dir" -type f -exec wc -c {} + 2>/dev/null |
    awk '$2 != "total" { s += $1 } END { print s + 0 }'
}

# Job control gives the review its own process group, so a timeout kills
# exactly that group: never another checkout's review.
set -m
scripts/codex-review.sh "$step" "$@" </dev/null &
pid=$!
last=$(size)
quiet=0
while :; do
  sleep "$poll"
  # Finished during the sleep: report its status, never a timeout.
  kill -0 "$pid" 2>/dev/null || break
  now=$(size)
  if [[ $now != "$last" ]]; then
    last=$now
    quiet=0
  else
    quiet=$((quiet + poll))
  fi
  if ((quiet >= limit)); then
    echo "review-watch: no output for ${quiet}s; killing the review" >&2
    kill -TERM -- -"$pid" 2>/dev/null
    sleep 5
    kill -KILL -- -"$pid" 2>/dev/null
    exit 124
  fi
done
wait "$pid"
