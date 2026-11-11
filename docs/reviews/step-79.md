# Step 79 — Two README gaps the release rehearsal found

Branch: `docs/79-readme-first-run` · Reviewer: GPT-6.1 Sol · Rounds: — · Status: awaiting review · Verdict after triage: —

## Scope

The 0.1.0 release rehearsal of 2026-11-11 installed the packed package into a fresh `npm create vite` vanilla-ts app and followed only `packages/tscache/README.md`. Its findings 3 and 4 are two gaps in the README's quick start that tripped a first-time user. This step closes both in the README. No library code changes.

| Commit (by subject)                                                         | What                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `docs(readme): show the ?fetcher declaration and what finalizedUntil means` | The quick start shows the `?fetcher` declaration and glosses `meta.finalizedUntil`; the README's size in `docs/INDEX.md`. |
| `docs(review): step 79, two README gaps the release rehearsal found`        | This file, and the review-file count and size in `docs/INDEX.md`.                                                         |

**The `?fetcher` declaration (finding 3).** The quick start imported `./fetcher.ts?fetcher` and left its type declaration to a link, so `tsc`, and with it `npm run build` in the vanilla-ts template, failed with `TS2307: Cannot find module './fetcher.ts?fetcher'`. The README now shows the declaration between the fetcher and the page code, copied from the `*?fetcher` block of `site/snippets/env.d.ts`, which the getting-started guide includes. It shows only that block: the vanilla-ts template's `tsconfig.json` loads Vite's client types, which already declare `?worker&url`, and the rehearsal failed only on `?fetcher`. The README says so in one parenthesis. The closing paragraph no longer lists the declarations among what the guide covers.

**What `finalizedUntil` means (finding 4).** The fetcher's comment showed `meta: { version, finalizedUntil }` with no gloss, and the rehearsal sent the range's end, which leaves the last point provisional and refetched by every read. The comment now gives the definition from `site/guides/fetcher.md` ("the first timestamp that is not final yet"), the effect of the watermark from `site/concepts/freshness.md` (points at or after it are fetched again), and what omitting it does: every point and every gap in the response is final and never fetched again. The last clause follows `site/concepts/freshness.md` ("Otherwise a slot returned without a point becomes a confirmed gap and is never fetched again") and the code: `meta` and both of its fields are optional in `FetchResponse` (`packages/tscache/src/types.ts`), and a cache whose watermark is undefined treats no point as provisional (`packages/tscache/src/engine/cache.ts`, the `finalizedUntil` getter; `#putValid` moves the watermark only when the response carries one).

**The site.** The getting-started guide (`site/guide/getting-started.md`) already shows the declaration (`<<< @/snippets/env.d.ts`) next to the Vite config, and its fetcher snippet (`site/snippets/fetcher.ts`) documents `finalizedUntil` as "The first timestamp that is not final yet." Neither gap exists there, so the site is unchanged.

## Verification

- **The README's code type-checks, and the declaration is what makes it.** Nothing in the repository type-checks the package README's code blocks: `docs:check` covers `site/` and `site/scripts/`, `docs:run` runs `site/snippets/`, and `check:integrations` covers `integrations/`. I checked them by hand. After `bun install --frozen-lockfile` and `bun run --cwd packages/tscache build`, I extracted the README's four `ts` blocks into a temporary directory inside `examples/vanilla-uplot/` (so that `vite` and the workspace package resolve) as `vite.config.ts`, `fetcher.ts`, `env.d.ts` and `main.ts`, with a `tsconfig.json` modelled on the vanilla-ts template (`target` ES2022, `module` ESNext, `moduleResolution` bundler, `types: ["vite/client"]`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `strict`, `noEmit`, and `skipLibCheck: false`). The template's `noUnusedLocals` and `noUnusedParameters` were left off, since the quick start ends on a `result` it only describes.
  - `node_modules/.bin/tsc -p .` (TypeScript 7.0.2): exit 0.
  - The same with `env.d.ts` moved aside: exit 1, `main.ts(3,27): error TS2307: Cannot find module './fetcher.ts?fetcher' or its corresponding type declarations.`, the rehearsal's error.
  - The temporary directory was deleted afterwards.
- **The gate.** `~/code/tscache-reports/bin/heavy-run.sh "79 child: ci" bun run ci` on the final head; the result is in the child's report to the director.

Not verified: a fresh `npm create vite` app installing the packed tarball (the rehearsal's own procedure), and the README as npm renders it.

## Decisions

- **Numbered 79, not 78.** The brief named this step 78, but step 78 is already the merged review of 2026-11-10 (`docs/78-review-2026-11`, `docs/reviews/step-78.md`), and `AGENTS.md` (Process, Steps) numbers later work after the highest existing step, never reusing one. No branch used 79, so the branch is `docs/79-readme-first-run` and this file is `step-79.md`.
- **Only the `?fetcher` declaration in the README.** The site's `env.d.ts` declares both `?worker&url` and `?fetcher`; the README shows only the second, because Vite's client types, which the vanilla-ts template loads, declare the first. Showing both would duplicate Vite's own declaration in the common case.
- **State what omitting `finalizedUntil` does.** The rehearsal's question was what to send for history that never changes. The gloss answers it with the consequence (every point and gap is final) rather than a rule ("omit it"), so a reader whose backend publishes late sees why they need it.

## Contradictions found

None between the code and the docs on these two points.

## Review rounds

Left for the director.
