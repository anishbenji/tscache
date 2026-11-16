# Step 117 — the AGENTS.md line recording the Effect decision

Branch: `chore/117-agents-effect-line` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: settled (round 1: no findings)

## Scope

User decision 75 (2026-11-16): add the `AGENTS.md` line worded in the Effect ADR, with its path pointing at the decision file under `docs/decisions/`, on its own `chore/` branch.

- `AGENTS.md`, "Toolchain hard rules": one new bullet, the ADR's wording with two changes. The path names `docs/decisions/N85-effect-adoption.md`, and "the ADR lists which" becomes "the decision lists which", so the sentence names the file it points at.
- `docs/INDEX.md`: the `AGENTS.md` row's size goes from 7.2 KB to 7.6 KB (`wc -c AGENTS.md` is 7,583 bytes).
- This file.

`docs/decisions/N85-effect-adoption.md` is not on `main` when this branch is cut; step 115 adds it. The line points at that path as decided, so the reference resolves once step 115 merges. No check in the repository validates paths named in `AGENTS.md`, so nothing fails in the meantime.

`AGENTS.md` is the user's merge (`docs/INDEX.md`, owner column). Merge it after step 115, which adds `docs/decisions/N85-effect-adoption.md`, the file the line points at. The line says "the decision lists which" where the approved wording says "the ADR lists which", because it now names the decision file; step 115 uses the same words in N85's Guardrails section.

## Verification

| Command                                      | Result                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run docs:check` (after `bun run build`) | Exit 0; `doc-anchors: 246 anchors in 42 pages resolve`. Before the build it failed on site snippets importing the unbuilt package only |
| `heavy-run.sh "117 child: ci" bun run ci`    | Exit 0 on `3cb5773` plus the review commit (`e87e271`); bench smoke and e2e checks `ok`                                                |

## Pre-review (Claude), not the gate

Claude Opus 5.5 on `e87e271`: two P2 and a nit, all accepted.

- PR-1 (P2): the line's "the decision lists which" differs from the approved "the ADR lists which". Accepted: step 115 now writes the same words into N85's Guardrails section, and Scope says why.
- PR-2 (P2): the line points at a file that is not on `main` until step 115 merges. Accepted: Scope and the pull request name the merge order (115 first).
- PR-3 (nit): the CI row had no result. Fixed: it now gives the exit code and head.

## Round 1 (GPT-6.1 Sol, high) — reviewer verdict: merge

Run on head `c0a2987`. No new findings; the reviewer confirmed the pre-review fixes and that the line matches step
115's wording, and noted that step 115 must merge first, as documented. The round's `bun run ci` exited 0. Raw
output: `.reviews/step-117/round-1.md`. The review has settled.

## Contract-test changes

None.

## Decision concerns

None.
