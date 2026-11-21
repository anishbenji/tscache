# Step 140 — fix the tabs diagram's syntax error

Branch: `docs/140-tabs-diagram` · Reviewer: none (one-line docs fix; GitHub runs ci on the pull request) · Rounds: 0 · Status: settled · Verdict after triage: merge

## Scope

User decision 129 (2026-11-21): the sequence diagram on the docs site's tabs page (`site/how-it-works/tabs.md`) rendered as "Syntax error in text". This step fixes that diagram only.

## Cause and fix

In a mermaid sequence message, `;` ends the statement. The message `W--xT2: res, to a port already closed; the server forgets the port` (introduced in c0ce1aee) therefore ended early, and the parser reported "Expecting … got 'NEWLINE'" on the following line. The message now reads `res, to a port already closed, so the server forgets the port`, which keeps its meaning without the `;`. No other prose changed.

## Verification

- A throwaway Bun script (outside the repository) extracts every fenced mermaid block from `site/**/*.md` and calls `mermaid.parse` on each, using the mermaid 11.17.2 already installed for `site`. Under Bun there is no DOM, so DOMPurify lacks `sanitize`, `addHook` and `removeHook`; the script patches those methods as no-ops on the ESM DOMPurify instance that mermaid imports (`purify.es.mjs`, resolved with `Bun.resolveSync` from mermaid's `dist`) before importing mermaid.
  - On `origin/main` (bcff32f7): `site/how-it-works/tabs.md #1 ERROR Parse error on line 25`; the other eleven blocks parse.
  - After the fix: all twelve blocks parse.
- `bun run docs:check` passes after `bun run build` (before the build it fails with TS2307, as expected in a fresh worktree).

## Never paths touched

None.

## Contract-test changes

None.

## Decision concerns

None.
