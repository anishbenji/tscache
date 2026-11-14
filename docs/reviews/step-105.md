# Step 105 — Two `AGENTS.md` lines

Branch: `docs/105-agents-lines` · Reviewer: not yet run · Rounds: 0 · Status: open · Verdict after triage: pending

## Scope

User decision 63 (b) (2026-11-15) approved two one-line additions to `AGENTS.md`, proposed by the reviews of steps 83 and 91. Both go into "Toolchain hard rules"; nothing else in the file changes.

1. **Hook staging.** The pre-push hook runs the Fallow health floor since step 83 (`lefthook.yml`, job `fallow-health`, `bun run fallow:health`, which is `fallow health --min-score 90`). The hook-staging line now names it after the Fallow audit: "Fallow (`bun run fallow`) and the health floor (`bun run fallow:health`)".
2. **Heavy jobs.** A mutation run (`bun run mutation`, about 40 minutes for all areas, `docs/benchmarks/mutation.md` on step 91's branch) is a heavy job. The "one heavy job at a time" list now names it.

Documentation only: no code, no tests, no configuration changes.

`CLAUDE.md` and `docs/workflow.md` do not repeat either list: `CLAUDE.md` imports `AGENTS.md`, and `docs/workflow.md` (Toolchain, item 3) already describes the health floor in the pre-push hook. Neither needed a change.

**Ordering with step 91.** The `mutation` script arrives with step 91 (`chore/91-stryker-deps`), not yet on `main` when this branch was cut. Until step 91 merges, the heavy-job line names a script that does not exist yet; the line is still correct as a rule, and the user merges both.

| Commit (by subject)                                       | What                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| `docs: name the health floor and mutation runs in agents` | The two `AGENTS.md` lines; this file; `docs/INDEX.md` sizes |

## Verification

- `bun run docs:check`: passes.
- `~/code/tscache-reports/bin/heavy-run.sh "105 child: ci" bun run ci`: exits 0 on the final head.

## Contract-test changes

None.

## Decision concerns

None.
