# Step 83 — A Fallow health floor in CI and pre-push

Branch: `chore/83-health-gate` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled · Verdict after triage: merge

## Scope

The user asked (2026-11-13) for `fallow health` to become a gate. This step adds a floor of 90; raising it to 95 is a later refactoring step, planned from the targets below.

| Commit (by subject)                                                | What                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `chore(ci): gate the fallow health score at 90 in ci and pre-push` | The `fallow:health` script, its calls in `scripts/ci.sh` and Lefthook, `docs/workflow.md`. |
| `docs(review): step 83, the fallow health floor`                   | This file.                                                                                 |

- `package.json` gains `"fallow:health": "fallow health --min-score 90"`, so the floor is written in one place. `--min-score` is Fallow's documented CI gate (`fallow health --help`, Fallow 3.37.0): with it, complexity findings become informational and the exit code depends only on the score.
- `scripts/ci.sh` runs `bun run fallow:health` straight after `bun run fallow` (the audit).
- `lefthook.yml` runs it in the pre-push hook as its own job, `fallow-health`, next to the `fallow` job. The pre-push jobs run in parallel, and the score does not read the build, so it needs no place in the piped `built` group.
- `docs/workflow.md` (Toolchain) describes the floor and how to see the score and the targets. `CONTRIBUTING.md` lists only the top-level commands, which are unchanged. `AGENTS.md` (Toolchain hard rules, Hook staging) names Knip and Fallow among the pre-push checks; "Fallow" there already covers both Fallow commands, so it needs no new line, though the user may want "Fallow (audit and health floor)" for precision.
- The score does not use git history: `fallow health --score` (which `--min-score` implies) reports hotspots as not applicable, so the gate gives the same result on a shallow clone (GitHub Actions) as locally. Plain `fallow health` without `--score` does read the churn: it deducts hotspots (−10.0) and reports 82 B today. The gated number is the one the user named on 2026-11-13 ("92 A; unit size −5.5, coupling −2.5"), so the floor is on the `--score` form.
- Nothing under `packages/tscache/src` changes; no dependency is added.

### The score on `main` (b2e1f06)

`bunx fallow health --score`:

```
● Health score: 92 A
  Deductions: unit size -5.5 · coupling -2.5
  N/A: hotspots (enable the corresponding analysis flags)

✓ 6 above threshold · 1556 analyzed (0.01s)
```

Every deduction: unit size −5.5 and coupling −2.5 (92.0 in all). Fallow also prints two configuration warnings on every run, unchanged by this step: the hidden `.claude` directory is not traversed, and the entry glob `scripts/*.ts` no longer matches four files in subdirectories of `scripts/`.

### The plan for 95: `bunx fallow health --targets`

```
■ Metrics: 19,008 LOC · dead files 0.0% · dead exports 0.0% · avg cyclomatic 2.0 · p90 cyclomatic 4 · maintainability 91.0 (good) · 3 churn hotspots
  Cyclomatic units: functions 1556, module scopes 11, templates 0
  Module scope: max cyclomatic 7; included in metrics, not function findings

  Parameters:    92% low · 7% medium · 1% high · 0% very high  (0-2 / 3-4 / 5-6 / >=7 params)

● Refactoring targets (4)
  1 low effort · 3 medium
    score = quick-win ROI (higher = better) · pri = absolute priority

   17.1  pri:34.1    packages/tscache/src/rpc/server.ts
         hidden coupling · effort:medium · confidence:medium  Changes with port-client.ts in 8 commits (50% coupling) without an import, make the dependency explicit or move the shared logic into one module
         importers: packages/tscache/src/client/in-process.ts (RpcServer); packages/tscache/src/entries/worker.ts (RpcServer); packages/tscache/src/persist/clear-only.ts (Persistence); packages/tscache/src/persist/hosted.ts (Persistence); packages/tscache/test/client-lazy-hosting.test.ts (RpcServer)

   14.5  pri:28.9    packages/tscache/src/rpc/port-client.ts
         hidden coupling · effort:medium · confidence:medium  Changes with server.ts in 8 commits (50% coupling) without an import, make the dependency explicit or move the shared logic into one module
         importers: packages/tscache/src/client/cache.ts (PortClient); packages/tscache/src/client/client.ts (PortClient); packages/tscache/src/client/hosting.ts (PortClient); packages/tscache/src/client/in-process.ts (PortClient); packages/tscache/test/hosting.test.ts (PortClient)

    5.6  pri:5.6    e2e/pages/auth-refresh.js
         hidden coupling · effort:low · confidence:medium  Changes with auth.spec.ts in 6 commits (92% coupling) without an import, make the dependency explicit or move the shared logic into one module
         importers: e2e/pages/refresh-harness.js (refreshOnAuthInvalid)

    3.0  pri:5.9    e2e/auth.spec.ts
         hidden coupling · effort:medium · confidence:medium  Changes with auth-refresh.js in 6 commits (92% coupling) without an import, make the dependency explicit or move the shared logic into one module
```

All four targets are hidden coupling (files that change together without an import). They are advisory and do not enter the `--score` value: a one-commit clone reports no targets and still deducts coupling −2.5, so that deduction is static (fan-in and fan-out, `bunx fallow health --file-scores`), not the co-change behind these targets. The larger deduction, unit size (−5.5), comes from the functions above Fallow's size thresholds (`bunx fallow health --complexity --sort lines` lists them); a 95 step needs to shorten those as well, since the coupling deduction alone cannot close the three points.

## Verification

| Check                                                                              | Result                                                                                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bun run fallow:health` on `main` plus this change                                 | Exit 0, score 92 (A); 0.24 s wall time                                                                     |
| Scratch edit: drop `"packages/*/test/**"` from `health.ignore` in `.fallowrc.json` | Score 87.7 (A); deductions unit size −10.0, coupling −2.3                                                  |
| With the scratch edit, `bunx lefthook run pre-push --force --job fallow-health`    | Exit 1: `Health score 87.7 (A) is below minimum threshold 90`, `script "fallow:health" exited with code 1` |
| With the scratch edit, `heavy-run.sh "83 child: ci scratch" bash scripts/ci.sh`    | Exit 1 at the same step with the same message, after every earlier check passed                            |
| Scratch edit undone with the Edit tool                                             | `git status` clean apart from this step's files                                                            |
| `heavy-run.sh "83 child: ci" bun run ci` on the final head                         | exit 0; Vitest 2,674, Playwright 175, health 92                                                            |

Earlier scratch attempts added code instead: a new file under `packages/tscache/src` with one 62-line function brought the score to 89.7, and two 44-line functions appended to `grid.ts` only to 90.0, which passes. Both were removed before the config edit above. They show that Fallow prints the score rounded (`90 A`) while the gate compares the unrounded value, so a score of 89.7 prints as `90` and fails; the failure line gives the exact value.

## Pre-review (Fable), not the gate

No P0 or P1. Four P2s: the workflow doc named plain `fallow health` (82 B with hotspots) as showing the gated score; the 95 plan tied advisory targets to the static coupling deduction; stale `docs/INDEX.md` sizes; and `AGENTS.md`'s hook-staging line does not name the new job. The first three are fixed in `docs: the health floor's score, after the pre-review`; `AGENTS.md` is user-owned, so the line is proposed to the user, not changed here. The pre-review's decision concern (which score the user meant) is settled by the user's own figures, which match the `--score` form.

## Security lane (Claude), not the gate

run 1, head 0592191: P0 0, P1 0, P2 0

## Round 1 — reviewer verdict: merge

No findings (2026-11-13). The reviewer confirmed the pre-review fixes; `git diff --check` and `bash -n scripts/ci.sh` passed.
