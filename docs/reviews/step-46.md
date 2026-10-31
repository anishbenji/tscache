# Chore 46 — Current entry sizes in the benchmarking table

Branch: `chore/46-size-table` · Status: settled after round 1

The entry-size row of the measurement table in `docs/benchmarking.md` still showed the figures from before the perf work and N31 (`index` 14.30 kB, `engine` 8.76 kB). This chore replaces them with the sizes `bun scripts/size.ts` measures on `main` at `a212cba`. Budgets (`packages/tscache/bench/budgets.json`) are unchanged. Done by the director while the user was away.

## Scope

| Commit | What |
|---|---|
| (this commit) | The entry-size row in `docs/benchmarking.md`, and this file |

## Verification

`bun run --cwd packages/tscache build` then `bun scripts/size.ts` on `a212cba`, under the heavy-job lock:

| Entry | Brotli | Budget |
|---|---:|---:|
| `index` | 14.74 kB | 14.80 kB |
| `worker` | 11.81 kB | 12.28 kB |
| `engine` | 9.11 kB | 9.27 kB |
| `fetcher` | 0.14 kB | 0.64 kB |
| `vite` | 0.95 kB | 1.45 kB |

## Notes

The `index` entry has 60 B of headroom against its budget. The next change that grows it will fail CI and reset the budget by the documented rule (measured + max(512 B, 3 %)) in that change, where the growth is visible. The budget is not raised ahead of time.

## Review rounds

| Round | Verdict | Findings |
|---|---|---|
| 1 | merge | none |

## Contract-test changes

None.

## Decision concerns

None.
