# Step 73 — One file per decision, and the starter prompt to docs/history/

Branch: `docs/73-decision-files` · Reviewer: GPT-6.1 Sol (high) · Rounds: pending · Status: pending · Verdict after triage: pending

## Scope

Agents read `docs/architecture.md` (450 KB on `main`) again and again to find one decision row; a usage review of the director thread counted 62,700 characters across 30 reads of it and recommended a one-line-per-decision index plus one file per decision. Most of that size was the padding of the §8 table: every one of its 69 rows was padded to the width of its longest, about 3.2 KB a line. This step only moves text; no decision is reworded, merged, shortened or corrected.

| Commit (by subject)                                                          | What                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs(decisions): one file per decision, architecture §7 and §8 as an index` | 77 files under `docs/decisions/`, one per row of §7 (1–8) and §8 (N1–N69); §7 and §8 become one-line indexes; the status line of `docs/architecture.md` says where the text went; `docs/INDEX.md` gets a `docs/decisions/` row and says how to read one decision; `AGENTS.md`, prompt A in `docs/workflow.md` and the review checklist point at the files. |
| `docs: move the starter prompt to docs/history/`                             | `git mv starter-prompt.md docs/history/starter-prompt.md`; the live references name the new path: `docs/INDEX.md`, prompt A in `docs/workflow.md`, `docs/review-checklist.md` and the review prompts in `scripts/codex-review.sh`.                                                                                                                         |
| `docs(review): step 73 scope and verification`                               | This file, and the review-file count and size in `docs/INDEX.md`.                                                                                                                                                                                                                                                                                          |

**The decision files.** Each file is named by the decision's number and a short slug: `01-name-scope-license.md` to `08-overlap-warning.md` for §7, `N1-range-endpoints.md` to `N69-snapshot-coverage-watermark.md` for §8. Each holds, in this order, a title line `# <number>: <title>` with the row's number and title as written, one sentence saying which table the row came from (and, for §7 and N1–N8, the confirmation date that their section heading carries rather than the row), a `## Resolution` heading, and the row's resolution cell, unchanged and on one line. The resolution cell already holds each row's date, rationale and rejected alternatives; no row has a sub-table or a note elsewhere in §8 that belongs to it alone.

**The index.** §7 and §8 keep their headings and numbering, so citations such as "architecture §8, N38" still resolve. §8 keeps its introduction, which records how several groups of rows were taken. Under each heading a table lists every decision on one line: its number, linked to its file; its title; and a summary taken from the first clause of the resolution. §6 (the locked register and its rejected-alternatives tables) is unchanged. `docs/architecture.md` is now 240.6 KB.

**The starter prompt.** It moved with `git mv`, so `git log --follow docs/history/starter-prompt.md` shows its history. §3, §8, §10 and §11 are still cited, by section, as "starter §N", and those citations need no change. Left as they are: the step files under `docs/reviews/` (records), `CHANGELOG.md` (history), the comment in `lefthook.yml` ("per starter prompt §4", which names the document, not a path) and the status line of `docs/architecture.md` ("starter-prompt §12 deliverable", likewise). No README, CONTRIBUTING page, site page or other script links to the starter prompt.

## Verification

| Table       | Rows on `main` | Decision files | Index lines | Text rebuilt from the files          |
| ----------- | -------------: | -------------: | ----------: | ------------------------------------ |
| §7 (1–8)    |              8 |              8 |           8 | byte-identical to the 10 table lines |
| §8 (N1–N69) |             69 |             69 |          69 | byte-identical to the 71 table lines |
| Total       |             77 |             77 |          77 | no lost or changed decision text     |

- **Byte-for-byte rebuild.** A script (kept out of the repository: it checks a one-time move) parsed every file under `docs/decisions/` back into number, title and resolution, rebuilt both tables of `main`'s `docs/architecture.md` with the header's column widths, and compared them line by line with the originals, header and separator included. Result: `§7: 8 rows in the old table, 8 files, rebuilt table identical (10 lines)`, `§8: 69 rows in the old table, 69 files, rebuilt table identical (71 lines)`, `77 files for 77 rows; no lost or changed text`. It also fails on a duplicate number, a file whose name does not match its number, a file with no row and a resolution that spans lines.
- **An independent check anyone can rerun**, with no script, comparing the rows with padding collapsed:

  ```sh
  git show main:docs/architecture.md | awk '/^## 7\. /,/^## 9\. /' | grep -E '^\| N?[0-9]+ ' \
    | sed -E 's/ +\|/ |/g' | sort > old-rows.txt
  for f in docs/decisions/*.md; do
    awk 'NR==1 { sub(/^# /, ""); i = index($0, ": "); id = substr($0, 1, i - 1); t = substr($0, i + 2) }
         /^## Resolution$/ { getline; getline; print "| " id " | " t " | " $0 " |" }' "$f"
  done | sort > new-rows.txt
  wc -l < old-rows.txt; wc -l < new-rows.txt; cmp old-rows.txt new-rows.txt && echo identical
  ```

  Result: `77`, `77`, `identical`. Every file is exactly seven lines (checked with `wc -l`).
- **The index links every file once.** The `decisions/…` link targets in §7–§8 of `docs/architecture.md`, sorted, equal `ls docs/decisions` (77 each, `diff` empty); §7 has 8 index lines and §8 has 69.
- **Citations still resolve.** Every decision number the review checklist cites (N1, N2, N3, N5, N6, N7, N8, N68) has a file, and so does every `N<number>` in `AGENTS.md`, `docs/*.md`, `site/`, `packages/tscache/src/` and `README.md` (a loop over `git grep -o "N[0-9]\+"` that printed nothing). Section citations of §7 and §8 resolve because both headings are unchanged. `git grep starter-prompt` outside `docs/reviews/` now finds only the new path and the status line noted above.
- **Formatting.** `bunx biome ci .` (Biome formats Markdown here): `Checked 732 files … No fixes applied. Found 1 warning.`; the warning is the existing `useDomNodeTextContent` lint in `e2e/examples/react-lwcharts.spec.ts`. The pre-commit hooks (Biome, gitleaks, commitlint) passed on each commit.
- **The review script.** `bash -n scripts/codex-review.sh` passes, and `bash scripts/review-watch.test.sh` passes; the change is only text inside the two prompts.
- **The gate.** `~/code/tscache-reports/bin/heavy-run.sh "73 child: ci" bun run ci` on the final head, which includes `bun run docs:check` (the anchor check of step 61 among it) and the site build's dead-link check; the result is in the child's report to the director.

Not verified: how the files and the index render on GitHub (Biome accepts their Markdown, and the index is an ordinary table with relative links); no repository check reads links in `docs/` outside the site, so the relative links were checked only by the `diff` above.

## Decisions

- **Naming: two digits for §7, the bare number for §8.** `N19-…` matches how decisions are cited ("N19"), and the hyphen keeps `docs/decisions/N1-*.md` from matching N10–N19. Two digits for §7 (`07-examples-mapping.md`, as the brief suggested) keep its rows apart from §8's and sort them first.
- **Hand-picked slugs.** Short, from the title (`N68-field-values.md`, as the brief suggested). The slug only helps a reader browsing the directory; the number finds the file.
- **The §8 introduction stays in §8.** It describes groups of rows (N34–N44, N45–N61, N62–N65, N68–N69); splitting it among the files would reword it. Each N9–N69 file says that the introduction records how its rows were taken.
- **Summaries.** The first clause by a fixed rule: the leading bold phrase when it is at most 110 characters, otherwise the text up to the first `; `, `—`, `. ` or ` (`, with bold markers and a trailing period removed. Four were trimmed by hand, using only words of the first clause: row 1 adds the row's own second sentence ("Scope superseded by N67") so the index does not show a superseded name alone; N52, N57 and N58 drop a long tail. A summary is a pointer, not the decision: the file is authoritative.
- **No `docs/decisions/README.md`.** Architecture §7 and §8 are the list, and `docs/INDEX.md` says how to read one decision; a third list would drift.
- **Sizes in `docs/INDEX.md`.** Only rows whose documents this step changes were re-measured (`AGENTS.md` stays 7.0 KB). The others keep their 2026-11-11 measurements.
- **The review prompt names `docs/decisions/`.** Besides the new path, the locked-decisions sentence of `scripts/codex-review.sh` says the decisions are one file each, so a reviewer reads one file rather than the architecture document.

## Contradictions found

Kept as they are; this step moves text and corrects nothing.

1. The §8 heading says "later rows dated in each row, to N67 on 2026-11-04", but the table runs to N69, decided on 2026-11-10 (the introduction says so). The heading is kept because the brief keeps §7's and §8's headings.
2. The status line of `docs/architecture.md` says the §8 decision points were "all resolved with the user on 2026-06-11"; only N1–N8 were, as the §8 heading says.
3. Sizes in `docs/INDEX.md` have drifted since their 2026-11-11 measurement: on `main`, `docs/review-checklist.md` is 7.9 KB against the 7.8 KB listed, and `docs/reviews/` holds 76 files against the 74 listed (steps 61 and 75 merged since).
4. The review prompts in `scripts/codex-review.sh` call every step "step NN of the commit plan in starter §11", but that plan ended at ⑭ and later steps are numbered outside it (`AGENTS.md`, Steps).
