# Step 115 — Effect is not adopted (N85)

Branch: `docs/115-effect-decision` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: awaiting review

## Scope

On 2026-11-15 the user asked whether this repository should adopt Effect, and an evaluation was written as an architecture decision record outside version control (`docs/adr/0001-effect-adoption.md` in the main checkout, never committed). The user decided its six questions as user decision 75: question 1 on 2026-11-15 ("Let's not adopt it now"), questions 2 to 6 on 2026-11-16. Question 2 placed the record under `docs/decisions/` by the repository's convention, with a line in architecture §8 and a `docs/INDEX.md` entry. This step moves it there as N85 and records it. Documentation only: no code, test or configuration changes. The approved guardrails are applied by step 116 (the four Biome nursery rules and `noImplicitReturns`) and step 117 (the `AGENTS.md` line), each on its own branch.

The number is N85, not the N71 the record suggested: `main` ends at N70, and step 114 (finding M7, not merged yet) takes N71 to N84.

| Commit (by subject)                             | What                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs(decisions): n85, effect is not adopted`   | `docs/decisions/N85-effect-adoption.md`; its line in architecture §8, the §8 heading's last date and a sentence in the §8 introduction; in `docs/INDEX.md`, N85 counted in the `docs/decisions/` row (range, file count, size), a row for the file with its trigger, the range in "Reading one decision", and re-measured sizes. |
| `docs(review): step 115 scope and verification` | This file.                                                                                                                                                                                                                                                                                                                       |

## The decision file

**What changed from the record.** The record was copied whole, and only these parts were edited:

- **Title and opening.** `# N85: Effect is not adopted` and the opening sentence the other decision files use (row N85 of §8, recorded in step 115, decisions are locked), plus one sentence on where the file came from and what was edited.
- **Resolution.** A `## Resolution` section as in N69 and N70: the first clause in bold (which is also the §8 summary), the reason, the revisit rule and the user decision with its dates. The record's status bullet now reads "decided, 2026-11-16"; the decision-owner and scope bullets are kept.
- **Decisions.** The record's "Open questions for the user" section is replaced by "Decisions", one line per question with the user's answer and, for questions 3 to 5, the step that applies it. The pilot candidate the record named under question 1 is kept there.
- **Guardrails.** The introduction says all three were approved on 2026-11-16 and which step applies each; each heading names its step. The `AGENTS.md` line's path now points at `docs/decisions/N85-effect-adoption.md`, as question 5 asked, and because the path now points at the decision file, "and the ADR lists which" became "and the decision lists which" (decision 75, question 5; director instruction, 2026-11-16). The line now matches, word for word, the one step 117 adds to `AGENTS.md`; the rest of its approved wording is unchanged.
- **Adoption steps.** Each step now names the step that does it: 115 (this one), 116 and 117, and step 111, which already added the late-retry test the record asked for (`docs/reviews/step-111.md`).
- **Consequences.** The heading "If this proposal is accepted" now adds "(it was, 2026-11-15)".

Kept as written: the summary, context, measurements, decision for each layer, lighter alternatives, the rest of the consequences, "When to revisit" (question 6 kept the four conditions), risks, sources, the review record and the appendix. The file no longer names the old `docs/adr/` path anywhere.

**Size.** The file is 49.3 KB (`wc -c`: 49,279 bytes), far longer than any other decision file (the other 78 total 84.8 KB). It is kept whole, because the user asked for the record to move, not to be cut. Its `docs/INDEX.md` row tells a reader to start with the Resolution and Decisions, which together are about 2.2 KB.

**Index entries.** Architecture §8 lists every decision on one line in a padded table; the N85 line follows that format, and its summary is the resolution's first clause. `docs/INDEX.md` has no row per decision, but it does give some files inside a listed directory a row of their own (`docs/reviews/2026-11-review.md` beside `docs/reviews/`). N85 gets such a row, because no task would otherwise cite it: its trigger is the wording the record suggested ("When a task proposes or reopens adopting Effect or another runtime framework"). The `docs/decisions/` row's text was reworded within its old length ("full text" to "in full", "list them one line each" to "list each on one line", one serial comma dropped) so that the table's column widths, and so every other row, stay unchanged; this keeps conflicts with other steps that edit the index to the rows this step changes.

## Verification

- `bun run docs:check` (after `bun install --frozen-lockfile` and `bun run build` in the fresh worktree): exit 0, `doc-anchors: 246 anchors in 42 pages resolve`. Before the build it failed with `TS2307` on `@anishbenji/tscache` in `site/snippets/`, because the package was not yet built; unrelated to this step.
- **Sizes in `docs/INDEX.md`**, re-measured with `wc -c` after the last edit to each file: `docs/architecture.md` 243.1 KB (243,117 bytes), `docs/decisions/` 134.1 KB (134,073 bytes, 79 files), `docs/decisions/N85-effect-adoption.md` 49.3 KB (49,279 bytes). The `docs/reviews/` row and the index's own row carry no size (user decision 70 A).
- **Table shape.** Every line of the `docs/INDEX.md` table has the same length as on `main` (579 characters, now 33 lines); the §8 table line for N85 has the length of its neighbours (263 characters).
- `~/code/tscache-reports/bin/heavy-run.sh "115 child: ci" bun run ci` is run on the final head, after this file is committed; its result is reported with the head SHA.

Not verified: the record's measurements, sources and review findings were not re-run or re-checked; they are moved as written, as the brief asks. The record's own review record says its revised text has had no second review round; per decision 75 the director decides whether this step's review round serves as that second round.

## Contract-test changes

None.

## Decision concerns

None.
