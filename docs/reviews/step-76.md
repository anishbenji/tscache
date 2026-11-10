# Step 76 — `f64` dtype wording

Branch: `docs/76-f64-dtype-wording` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled · Verdict after triage: merge

## Scope

The documents said "`f64` default", but the signed-off API requires every field to name its dtype (`fields: Record<string, Dtype>`), and `engine/validate.ts` rejects a field without one; no default exists. This step makes the documents say that every field names its dtype and that `f64` is the usual choice. No code changes.

## Decision

User decision 37, option A (user, 2026-11-10). It was escalated from step 71: see `docs/reviews/step-71.md`, row PR-7 and its "Not changed" list.

## Edits

| File                   | Old text                                                               | New text                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starter-prompt.md` §3 | "`f64` default; `f32`, `i32`, `u32`, etc. supported." (kept unchanged) | Same sentence, followed by "[Correction, 2026-11-10: every field names its dtype; `f64` is the usual choice; no default exists (user decision 37, 2026-11-10).]" |
| `docs/architecture.md` | `/** Field name → dtype. 'f64' is the documented default dtype. */`    | `/** Field name → dtype. Every field names its dtype; 'f64' is the usual choice. */`                                                                             |

A search of `docs/`, `site/` and `packages/tscache/src` found no other claim of a default dtype.

## Verification

- `bunx biome check .` and `bun run docs:build` pass.
- `bun run ci`, run 1: exit 1. `e2e/reference/clients.spec.ts:283` (reference-vanilla, uPlot scroll-back) made one history fetch where it expected none; 143 passed, 1 failed, 19 did not run. This branch changes two documentation sentences, so the failure is not caused by it: it is a flake candidate on `main`, queued for a root-cause fix on its own branch.
- `bun run ci`, run 2: exit 0 (Playwright 163 passed). The rerun is diagnostic; it does not clear the flake.

## Round 1 — reviewer verdict: merge

No findings (2026-11-10). The reviewer confirmed the wording matches the required-dtype API and that decision 37 authorises the correction to the locked starter sentence.

## Contract-test changes

None.
