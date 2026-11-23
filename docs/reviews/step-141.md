# Step 141 — a check that parses every mermaid diagram

Branch: `chore/141-mermaid-parse-check` · Reviewer: the director's review ladder · Rounds: 1 · Status: in review · Verdict after triage: pending

## Scope

User decision 129 D (2026-11-21): `bun run ci` should parse every mermaid diagram on the docs site and fail on a syntax error. It would have caught the tabs diagram that rendered as "Syntax error in text" on the live site (a `;` in a sequence message ends the statement; fixed in step 140, #170). No dependency is added: the check uses the Mermaid and VitePress already installed for `site/`.

## What changed

- `site/scripts/check-mermaid.ts` finds every `mermaid` fence with VitePress's Markdown renderer, as `check-doc-anchors.ts` reads pages, and runs `mermaid.parse` on each. Each page is first rendered as the site renders it, with its real path, so its `<!-- @include -->` directives are expanded (inside fences too), and the expanded text is searched (R1-1). A failure prints `file:line` (the fence's line) and Mermaid's own message, whose line numbers count within the diagram, then exits 1; a fence that an include brought in is named by its line on the expanded page. On success it prints `mermaid: N diagrams in M pages parse`. With no arguments it checks every page Git lists under `site/` (`git ls-files -z`, so a non-ASCII name is read as it is) and the generated `site/api/` pages, which Git ignores but the site publishes (R1-3); given files or directories, it checks those pages.
- Outside a browser, Mermaid's DOMPurify has no window and leaves out `sanitize`, `addHook` and `removeHook`. The script fills them in as no-ops on the instance Mermaid imports, then loads Mermaid. The sequence parser also reads `window?.CSS` to check a `box` colour, so each parse runs with a stand-in `window`, removed when the parse settles (R1-2). Both packages are resolved with Node's resolver and their package `exports`, so no Mermaid version or path is hard-coded and the same code runs under Bun (`docs:check`) and under Node (Vitest). Step 140's throwaway script used `Bun.resolveSync`, which Node lacks.
- `docs:check` in the root `package.json` runs the script after `check-doc-anchors.ts`; nothing else in `scripts` changed.
- `site/scripts/check-mermaid.test.ts` covers: a sequence message holding a `;` fails naming the file and line, also when an include puts the `;` there; a valid flowchart and a valid sequence diagram pass, and so do sequence diagrams with a coloured and an uncoloured `box`, leaving no `window` behind; a page with no mermaid passes; fence lines after frontmatter, inside containers and lists, and around includes; other languages and a mermaid fence shown as code are ignored; the message formats; a listed page with a non-ASCII name and a broken diagram in the generated `site/api/` are checked; the git and no-page failures. The real-parse cases run in process under Node and once as a `bun site/scripts/check-mermaid.ts <dir>` subprocess, since the DOMPurify patch depends on the runtime's module loader. Fixtures are written to temporary directories.
- `site/README.md` and `site/contributing.md` describe the new check and which pages it reads (the tracked pages and the generated `site/api/` pages, after includes); the `site/` row of `docs/INDEX.md` is re-measured (283.7 KB to 284.7 KB; still 42 tracked pages).

## Verification

- `bun run docs:check` on 8e47716a plus this branch: `mermaid: 12 diagrams in 42 pages parse`.
- With the `;` put back in `site/how-it-works/tabs.md:32` (`res, to a port already closed; the server forgets the port`), the check exits 1 with `site/how-it-works/tabs.md:7: Parse error on line 25:` followed by Mermaid's message (diagram line 25 is page line 32 here, as the diagram has no comments, directives or frontmatter). The edit was reverted with the Edit tool before committing.
- Removing the `addHook` no-op makes the three real-parse tests fail with `DOMPurify.addHook is not a function` under both Node and Bun; restored before committing.
- The check adds about 0.25 s to `docs:check` (three warm runs of `bun site/scripts/check-mermaid.ts`: 0.26 s, 0.25 s, 0.24 s; the first, cold run took 0.65 s).

## Pre-review (Claude), not the gate

The director's Opus pre-review of 9409a3d8. All four findings were valid and are fixed in d0670667.

| #    | Sev | Finding                                                                                                                                                                                                | Decision | Resolution                                                                                                                                                              |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1 | P2  | The "(page line N)" added to a parse error is wrong when a diagram has `%%` comments, its own `---` frontmatter, a `%%{init}%%` directive or leading blank lines, which Mermaid strips before counting | accepted | fixed in d0670667: the annotation is dropped; a failure prints the fence's line and Mermaid's diagram-relative message, and the test of the made-up message is replaced |
| PR-2 | nit | The Bun subprocess test's `spawnSync` has no timeout, so a hung child blocks the run                                                                                                                   | accepted | fixed in d0670667: a 60 s `timeout`, used only to end a hung child, and an assertion that `out.error` is undefined                                                      |
| PR-3 | nit | The no-argument test depends on the real `site/index.md` holding no diagram                                                                                                                            | accepted | fixed in d0670667: it asserts only the exit code, one log line and the page count                                                                                       |
| PR-4 | nit | `importEntry` takes `import`, then `default`, unlike Node's and Bun's condition order, without saying so                                                                                               | accepted | fixed in d0670667: its TSDoc states the order and how a mismatch fails (loudly, caught by the flowchart test)                                                           |

## Round 1 (Codex) — reviewer verdict: merge after fixes

The director's finding check (Fable 5.2) found all three findings valid; none triggers on a current page. All three are fixed in 3332f8ae, each test written first and seen failing before the fix.

| #    | Sev | Finding                                                           | Decision | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | --- | ----------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | P1  | Mermaid syntax introduced by VitePress includes escapes the check | accepted | VitePress 2.0.0-alpha.21 expands includes only in `renderAsync`, given `env.path`, and leaves the expanded text in `env.src`. The reader now renders each page with its real path and parses `env.src`. A fence before the first include or after the last keeps its page line; one between, or brought in by an include, is printed as `file, line N of the page with its includes expanded`. The script's header says so. Tests: an include that puts a `;` in a sequence message makes `run` return 1 naming the fence's page line; the expanded text and both kinds of line; the expanded-line message format |
| R1-2 | P1  | Valid sequence diagrams with coloured boxes fail CI               | accepted | Broader than reported: any `box`, coloured or not, threw `window is not defined` at `window?.CSS`. Each parse now runs with a stand-in `window` (`CSS.supports` accepts every colour), defined only while the parse runs and only where there is no `window`. Tests: a sequence diagram with `box Aqua Client … end` and an uncoloured `box` passes in process (and `window` is gone after) and in the Bun subprocess; the broken `;` sequence still fails                                                                                                                                                        |
| R1-3 | P1  | Git-based discovery skips published Markdown pages                | accepted | `git ls-files -z`, split on NUL, so `site/guides/café.md` is not quoted and dropped. With no arguments the generated `site/api/` pages are checked when the directory exists. VitePress's resolved page list was not used: the site's config imports the generated `typedoc-sidebar.json` and fails without `site/api/`. `run` takes the repository root as its one new seam. Tests: a listing whose only page has a non-ASCII name is checked; a broken fence in the generated pages returns 1                                                                                                                   |

Test changes: `lines` and the reader's other callers now await it, as the reader is async (R1-1). The two existing tests of no-argument mode take a fixture root, since the real root now adds the generated `site/api/` pages; the Git-listing test's assertion is stricter (exactly `1 diagrams in 1 pages`), and their stubs print NUL-ended names. No assertion was removed or loosened.

Follow-up, outside this step: `site/scripts/check-doc-anchors.ts:448` on `main` lists pages the same way (`git ls-files` without `-z`, split on newlines), so it would drop a non-ASCII page name too.

`docs:check` now takes about 0.96 s for the mermaid check (four warm runs of `bun site/scripts/check-mermaid.ts`: 0.97, 0.96, 0.96, 0.96 s), up from about 0.25 s: each page is rendered to expand its includes, and there are 105 pages (42 tracked, 63 generated) instead of 42. The run prints `mermaid: 12 diagrams in 105 pages parse`.

## Security lane (Claude), not the gate

- run 1, head dbf5536f: P0 0, P1 0, P2 0

## Never and Notify paths touched

- Never: root `package.json` (`scripts.docs:check` only).
- Notify: `site/scripts/` (`check-mermaid.ts`, `check-mermaid.test.ts`).

## Contract-test changes

None.

## Decision concerns

None.
