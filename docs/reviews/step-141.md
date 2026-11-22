# Step 141 — a check that parses every mermaid diagram

Branch: `chore/141-mermaid-parse-check` · Reviewer: the director's review ladder (no rounds yet) · Rounds: 0 · Status: in review · Verdict after triage: pending

## Scope

User decision 129 D (2026-11-21): `bun run ci` should parse every mermaid diagram on the docs site and fail on a syntax error. It would have caught the tabs diagram that rendered as "Syntax error in text" on the live site (a `;` in a sequence message ends the statement; fixed in step 140, #170). No dependency is added: the check uses the Mermaid and VitePress already installed for `site/`.

## What changed

- `site/scripts/check-mermaid.ts` finds every `mermaid` fence with VitePress's Markdown renderer, as `check-doc-anchors.ts` reads pages, and runs `mermaid.parse` on each. A failure prints `file:line` (the fence's line) and Mermaid's own message, whose line numbers count within the diagram, then exits 1. On success it prints `mermaid: N diagrams in M pages parse`. With no arguments it checks every page Git lists under `site/`; given files or directories, it checks those pages.
- Outside a browser, Mermaid's DOMPurify has no window and leaves out `sanitize`, `addHook` and `removeHook`. The script fills them in as no-ops on the instance Mermaid imports, then loads Mermaid. Both packages are resolved with Node's resolver and their package `exports`, so no Mermaid version or path is hard-coded and the same code runs under Bun (`docs:check`) and under Node (Vitest). Step 140's throwaway script used `Bun.resolveSync`, which Node lacks.
- `docs:check` in the root `package.json` runs the script after `check-doc-anchors.ts`; nothing else in `scripts` changed.
- `site/scripts/check-mermaid.test.ts` covers: a sequence message holding a `;` fails naming the file and line; a valid flowchart and a valid sequence diagram pass; a page with no mermaid passes; fence lines after frontmatter and inside containers and lists; other languages and a mermaid fence shown as code are ignored; the message format; the git and no-page failures. The real-parse cases run in process under Node and once as a `bun site/scripts/check-mermaid.ts <dir>` subprocess, since the DOMPurify patch depends on the runtime's module loader. Fixtures are written to temporary directories.
- `site/README.md` and `site/contributing.md` describe the new check; the `site/` row of `docs/INDEX.md` is re-measured (283.7 KB to 284.4 KB; still 42 pages).

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

## Security lane (Claude), not the gate

- run 1, head dbf5536f: P0 0, P1 0, P2 0

## Never and Notify paths touched

- Never: root `package.json` (`scripts.docs:check` only).
- Notify: `site/scripts/` (`check-mermaid.ts`, `check-mermaid.test.ts`).

## Contract-test changes

None.

## Decision concerns

None.
