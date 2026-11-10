# Step 76 — `f64` dtype wording

Branch: `docs/76-f64-dtype-wording` · Status: built

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
