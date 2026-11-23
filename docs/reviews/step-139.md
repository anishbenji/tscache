# Step 139 — mermaid 12 on the docs site, with the 11.x diagram look

Branch: `docs/139-mermaid-12` · Reviewer: Codex · Rounds: 1 · Status: settled · Verdict after triage: merge

## Scope

User decision 129 A (2026-11-21): take Dependabot #164, which moves `mermaid` in `site/package.json` from 11.17.2 to 12.3.0. Check #164 found that mermaid 12's new defaults change both flowcharts substantially (the package map three times taller, the startup flowchart's labels wrapped and cut off). This step lands the bump with settings that restore the 11.x look, and supersedes #164, which is to be closed once this merges.

The first commit (`28433416`) is #164's commit (`8a244496`) cherry-picked onto `main` at `8e47716a`. The patch is the same (`site/package.json` and `bun.lock` are identical; `git patch-id --stable` matches), but the tree is not, because `main` had since merged step 140. The subject became `chore(deps): bump mermaid from 11.17.2 to 12.3.0` (a `deps` scope added and the first word lowercased, since commitlint rejects the capitalised original), and a `Co-Authored-By` trailer was appended to Dependabot's otherwise unchanged body. `bun install --frozen-lockfile` printed no warning (`629 packages installed`).

## Version

`mermaid` 12.3.0, exactly as Dependabot's lockfile pins it. No other dependency changed.

## Settings

All in the `mermaid` block passed to `withMermaid` (`site/.vitepress/config.ts`), with the reason for each in the comment above it. They were found in mermaid 12.3.0's own config schema (`dist/config.type.d.ts`), its default config and its config resolver (`src/config.ts` in `dist/chunks/mermaid.core`), compared with 11.17.2's default config. Mermaid 12 adds per-diagram defaults for `theme`, `look` and `layout`; its resolver takes, for each of these keys, the first value found in frontmatter, then the site config, then the defaults, and within each layer a diagram's own section before the top level. A top-level site value therefore overrides the new per-diagram defaults.

| Setting                                   | Mermaid 12 default                                       | Why it is set                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `theme: "default"`                        | `flowchart.theme` and `sequence.theme` are `redux-color` | The plugin sets a theme only while the site is dark (`dark`); in light mode 12 fell back to `redux-color`. The plugin's `dark` still overrides this value.                                                                                                                                                                                                                                                                           |
| `look: "classic"`                         | `flowchart.look` and `sequence.look` are `neo`           | `neo` draws square black-bordered nodes, thick edges and drop shadows (the shadows were the sequence diagrams' only change in check #164).                                                                                                                                                                                                                                                                                           |
| `layout: "dagre"`                         | `layout` is `elk`                                        | ELK routes edges at right angles; it made the package map 874 px tall instead of 281 px.                                                                                                                                                                                                                                                                                                                                             |
| `flowchart.wrappingWidth: 200`            | 120 (11.17.2: 200)                                       | Labels such as `shared: SharedWorker` and `in-process: MessageChannel` wrapped onto two lines.                                                                                                                                                                                                                                                                                                                                       |
| `flowchart.minNodeWidth: 0`               | 120 (new in 12)                                          | Widened every short node to 120 px; the package map's nodes and subgraphs grew.                                                                                                                                                                                                                                                                                                                                                      |
| `themeCSS: "p { line-height: inherit; }"` | none                                                     | Mermaid sizes an HTML label's box at a line height of 1.5, but VitePress sets `line-height: 28px` on every `.vp-doc p`, so each label line grew 4 px past its box and the last line's descenders were cut off. This also happened on 11.17.2 (`rejects with the HostingError`, and 6 package-map labels by a few px); the rule is scoped to each diagram by Mermaid, so the label inherits the 1.5 line height it was measured with. |

Each setting was checked to be needed by dropping it alone and rebuilding (package-map, startup and auth pages): without `theme`, light-mode sizes changed (package map 291 px tall, auth 1370 px); without `look`, every diagram took the `neo` look; without `layout`, the package map was 874 px tall; without `themeCSS`, 6 package-map labels and 1 startup label were cut off; without `wrappingWidth`, the startup flowchart was 608×624; without `minNodeWidth`, the package map was 244 px tall. `securityLevel: "strict"` and the sequence settings are unchanged.

The startup diagram 1 labels that 12 cut off (`MessageChannel`, `HostingError`, `mode 'in-process'`) are whole again through these settings; the diagram's text is unchanged.

## Screenshot verification

Method as in check #164: `bun run docs:build`, then `bun run --cwd site preview`; Playwright 1.65.1 (chromium), 1280×900, deviceScaleFactor 1; light and dark contexts (`colorScheme` plus `vitepress-theme-appearance` in localStorage, the `.dark` class confirmed on every dark page). Each `.mermaid` container is screenshotted once its SVG exists and no diagram on the page shows "Syntax error" (the plugin's transient error box, below; a lasting error would have been recorded after a 10 s timeout, and none was). The throwaway script is outside the repository. The screenshots are in the director's reports folder: `reviews/step-139/after/`, side by side with check #164's `base/` (mermaid 11.17.2 at bcff32f7) in `reviews/step-139/diff/`. The tabs diagram changed on main since check #164 (step 140), so its base was re-shot at main 8e47716a with 11.17.2 (`reviews/step-139/base-8e47716a/`, all pages).

Labels are each diagram's SVG text (HTML labels and SVG `text`, without the embedded CSS). "Cut off" counts labels whose glyph boxes reach outside their `foreignObject`.

| Page        | Diagram | Type      | Base size (11.17.2) | After size (12.3.0) | Labels            | Cut off (base → after) | Light        | Dark         |
| ----------- | ------- | --------- | ------------------- | ------------------- | ----------------- | ---------------------- | ------------ | ------------ |
| auth        | 1       | sequence  | 765×1390            | 765×1390            | same (41)         | 0 → 0                  | same as base | same as base |
| fences      | 1       | sequence  | 1099×1284           | 1099×1284           | same (41)         | 0 → 0                  | same as base | same as base |
| fences      | 2       | sequence  | 764×867             | 764×867             | same (25)         | 0 → 0                  | same as base | same as base |
| live-feeds  | 1       | sequence  | 1090×1369           | 1090×1369           | same (36)         | 0 → 0                  | same as base | same as base |
| package-map | 1       | flowchart | 624×281             | 624×281             | same (28)         | 6 → 0                  | same as base | same as base |
| persistence | 1       | sequence  | 1090×1280           | 1090×1280           | same (45)         | 0 → 0                  | same as base | same as base |
| persistence | 2       | sequence  | 751×921             | 751×921             | same (30)         | 0 → 0                  | same as base | same as base |
| persistence | 3       | sequence  | 766×675             | 766×675             | same (23)         | 0 → 0                  | same as base | same as base |
| read        | 1       | sequence  | 1105×1504           | 1105×1504           | same (64)         | 0 → 0                  | same as base | same as base |
| startup     | 1       | flowchart | 624×511             | 624×510             | same (18)         | 1 → 0                  | same as base | same as base |
| startup     | 2       | sequence  | 790×1764            | 790×1764            | same (66)         | 0 → 0                  | same as base | same as base |
| tabs        | 1       | sequence  | 930×1802 (main)     | 930×1802            | same as main (54) | 0 → 0                  | same as base | same as base |

Sizes, labels and cut-off counts are identical in light and dark. "Same as base" means the side-by-side images show the same layout, node shapes, colours and edge routing; the sequence diagrams' drop shadows from check #164 are gone. Dark mode is still dark on every page (dark node fills, light text). The only visible differences: startup diagram 1 is 1 px shorter and its `rejects with the HostingError` label is no longer cut off; the package map's six two-line labels that 11.17.2 cut off by a few px are whole.

Console: no errors or warnings on any page, light or dark, on either side.

Not a regression: on 11.17.2 and 12.3.0 alike, `vitepress-plugin-mermaid` sometimes shows a "Syntax error in text" box (12: "No diagram type detected …") for a moment before it re-renders the diagram, as step 60 recorded. Ten loads of the startup page on this branch showed it on first render in eight and in none after the page settled. The capture waits for it to clear.

## The plugin and mermaid 12

- `vitepress-plugin-mermaid` 2.0.17 declares `"mermaid": "10 || 11"`. Bun printed no peer warning on `bun install --frozen-lockfile`.
- Its code path still works with 12: it calls `mermaid.initialize(config)` and `mermaid.render(id, code)`, both unchanged in 12. The build passes, every diagram renders, and the built site bundles only mermaid 12.3.0 (no `11.17.2` string in `site/.vitepress/dist/assets`). The plugin's own `mermaid` resolves to `mermaid@12.3.0` in `node_modules/.bun`.
- Dependabot's lockfile also records a nested `vitepress-plugin-mermaid/mermaid` entry at 11.17.2 (with its `katex` 0.16.47), because 12 is outside the plugin's peer range. Bun's isolated install (this repository's default) does not install it: `node_modules/.bun` holds only `mermaid@12.3.0` and `katex@0.18.11`.
- No newer plugin release exists: `npm view vitepress-plugin-mermaid versions peerDependencies --json` lists 2.0.17 as the latest, with the same `"mermaid": "10 || 11"`.
- Recommendation: no plugin bump or override is needed now; there is nothing newer to bump to, and an override would only silence a warning Bun does not print. Revisit when the plugin publishes a release that declares mermaid 12.
- `katex` (step 86's remaining low advisory, GHSA-238p-pmpm-9mq7): the installed `katex` is now 0.18.11, which is fixed. The lockfile's nested `vitepress-plugin-mermaid/mermaid` entry above still names 0.16.47, so `bun audit` still lists `katex@0.18.11, 0.16.47` under that advisory, as on main. The advisory stays in the audit count (6 in total) until the plugin accepts mermaid 12.

## Verification

- `bun run docs:build` passes (`build complete`), and `bun run docs:check` passes (`doc-anchors: 249 anchors in 42 pages resolve`), after `bun run build`.
- `bun scripts/test-clocks.ts`: `215 files clean`.
- The screenshot comparison above.
- `bun run ci` passes (Vitest 174 files, 3362 tests; Playwright 197; `docs:build`; gitleaks; bench smoke).

## Round 1 (Codex) — reviewer verdict: merge

One P2, on `c9f44a5f`; the reviewer found both accepted pre-review fixes present and compared the saved light and dark captures of all 12 diagrams.

| #    | Sev | Finding                                                                                                                                                                    | Decision | Resolution                                                                                                                                       |
| ---- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1-1 | P2  | The Scope section said the first commit has #164's tree and only a lowercased subject; the tree differs (newer `main`), the subject gained a scope and a trailer was added | accepted | Reworded in Scope: same patch (`git patch-id --stable` matches), cherry-picked onto `8e47716a`, subject scope and lowercasing, the added trailer |

## Finding check (Claude Fable 5.2), round 1

1 valid, 0 partly, 0 invalid, 0 decision.

## Pre-review (Claude), not the gate

- Pre-review 1 (Claude Opus 5.5), head a6a77434: no code findings. A P1 on the round setup (the local `main` ref was behind `origin/main`, so the round's diff would include merged work) is fixed by updating `main` before round 1. One nit, the `katex` wording above, is fixed.

## Security lane (Claude), not the gate

- run 1, head a6a77434: P0 0, P1 0, P2 0

## Never and Notify paths touched

None on either list. `site/package.json` and `bun.lock` change as a dependency edit (mermaid 11.17.2 → 12.3.0, a major version), so the user merges this pull request.

## Contract-test changes

None.

## Decision concerns

None.
