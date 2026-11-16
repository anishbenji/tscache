# Step 117 — the AGENTS.md line recording the Effect decision

Branch: `chore/117-agents-effect-line` · Reviewer: pending · Rounds: 0 · Status: awaiting review

## Scope

User decision 75 (2026-11-16): add the `AGENTS.md` line worded in the Effect ADR, with its path pointing at the decision file under `docs/decisions/`, on its own `chore/` branch.

- `AGENTS.md`, "Toolchain hard rules": one new bullet, the ADR's wording with two changes. The path names `docs/decisions/N85-effect-adoption.md`, and "the ADR lists which" becomes "the decision lists which", so the sentence names the file it points at.
- `docs/INDEX.md`: the `AGENTS.md` row's size goes from 7.2 KB to 7.6 KB (`wc -c AGENTS.md` is 7,583 bytes).
- This file.

`docs/decisions/N85-effect-adoption.md` is not on `main` when this branch is cut; step 115 adds it. The line points at that path as decided, so the reference resolves once step 115 merges. No check in the repository validates paths named in `AGENTS.md`, so nothing fails in the meantime.

`AGENTS.md` is the user's merge (`docs/INDEX.md`, owner column).

## Verification

| Command                                      | Result                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run docs:check` (after `bun run build`) | Exit 0; `doc-anchors: 246 anchors in 42 pages resolve`. Before the build it failed on site snippets importing the unbuilt package only |
| `heavy-run.sh "117 child: ci" bun run ci`    | See the final report for the result on the final head                                                                                  |

## Contract-test changes

None.

## Decision concerns

None.
