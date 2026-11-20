# Step 128 — The 2026-11 review update catches up, and the findings that need no decision

Branch: `docs/128-review-update-catch-up` · Reviewer: GPT-6.1 Sol (high) · Rounds: pending · Status: pending · Verdict after triage: pending

## Scope

`docs/reviews/2026-11-review-update.md` tracks what happened to each finding of the review of 2026-11-10. Its status table still described 2026-11-11: M3, M5 and M7 parked on decision 46, H5 and L1 waiting for #98. This step brings the table and the counts line up to date from evidence on `main` (`6716b4d`, the merge of #151), and fixes the findings still `open` or `partly` that need no user decision. The original review, `docs/reviews/2026-11-review.md`, is unchanged. No library code changes.

The director added two fact fixes to the step: the roadmap's description of the bench timing gate, and stale comments in config files.

| Commit (by subject)                                                   | What                                                                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `docs(readme): explain attw's node10 result for the esm-only package` | L6: a paragraph under Install in `packages/tscache/README.md`.                                                                          |
| `docs(site): state the range gapSplitK accepts`                       | L10: `site/usage/cache.md` and `site/concepts/segments.md` say `gapSplitK` is a positive integer with no upper bound.                   |
| `docs(roadmap): the eight gated bun timing cases block ci`            | `docs/roadmap.md`, "Performance measurement and gate": timing is no longer called report-only.                                          |
| `chore(config): correct three stale config comments`                  | Two comments in `vitest.config.ts`, one in `.fallowrc.json`.                                                                            |
| `docs(review): bring the 2026-11 review update up to 2026-11-21`      | The status table, the counts line and a dated note in `docs/reviews/2026-11-review-update.md`; this file; the sizes in `docs/INDEX.md`. |

## Changes and evidence

### The status table

Each changed row names the pull request and its merge commit from `git log --first-parent --merges main`, or the user decision (the director's `decisions-resolved.md`). Counts of the 32 findings: 24 fixed, 7 partly, 1 open, 0 parked on a decision (on 2026-11-11: 12 fixed, 9 partly, 4 open, 7 parked). L6 counts as fixed by this branch.

| Finding | Was                  | Now    | Evidence                                                                                                                                                |
| ------- | -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H5, L1  | parked on a decision | fixed  | #98 `3ff6157`, merged by the user 2026-11-12 (decision 43)                                                                                              |
| M2      | partly               | fixed  | #102 `af68568` (step 77), #127 `20ec765` (step 95); scheduled flake hunt run 43870066983 on 2026-11-16 passed (`gh run list --workflow flake-hunt.yml`) |
| M3      | parked on a decision | fixed  | #125 `09210ef` (design), decision 67, #150 `4507d6a` (step 121); merged after the `v0.2.0` tag, so 0.2.0 does not have it                               |
| M4      | partly               | partly | #147 `8c27a63` (step 118, design); decision 83, resolved 2026-11-21 after the brief was written, took every recommendation; not built                   |
| M5      | parked on a decision | partly | #136 `004513e` (step 100, design), #129 `7b1d163` (step 101), decision 71; limits stated in #109 `cb51ea9`; not built                                   |
| M7      | parked on a decision | fixed  | #122 `8ec84b2` (design), decision 65, #146 `8cbb162` (step 114), released in 0.2.0 (#149 `43393f3`)                                                     |
| M10     | partly               | fixed  | #106 `d95b405` (step 73): `docs/decisions/`; N70–N105 each have a file (checked with `ls docs/decisions/N{70..105}-*.md`)                               |
| M11     | fixed                | fixed  | The remaining `ci.yml` comment corrected in #107 `682ef73` (step 81, decision 45 A)                                                                     |
| M12     | partly               | fixed  | Handover to a fresh director thread on 2026-11-13 (decision 44, `handover-2026-11-13.md`); children build and review                                    |
| M13     | partly               | fixed  | `~/code/project-dashboard`: `entries.json` through #151 and `direction.json` for 0.2.0, both 2026-11-20 (`git log` of those files)                      |
| M15     | parked on a decision | fixed  | #110 `fa9e5e4` (step 74); N70 in #108 `2dc86e7` (step 80, decisions 42 A and 52)                                                                        |
| M16     | open                 | open   | Re-checked below ("Toolchain watch"); a watch list, nothing to fix without a decision                                                                   |
| L3      | partly               | fixed  | #106 `d95b405` moved the starter prompt to `docs/history/`; decision 62 dropped its stale rows                                                          |
| L6      | open                 | fixed  | This branch                                                                                                                                             |
| L7      | partly               | partly | #131 `7c2e35d` (step 104), #137 `781c378` (step 108); sizes measured on this branch with `bun scripts/size.ts`; a decision below                        |
| L8      | partly               | fixed  | #112 `f6798bf` (step 65): `https://anishbenji.github.io/tscache/` answers 200; root README has "Status: 0.x" and an Install section                     |
| L9      | parked on a decision | partly | #110 `fa9e5e4` added an outcome-based fault test; `merge-failures.test.ts` unchanged since 2026-10-05; a decision below                                 |
| L4, L10 | partly, open         | partly | L10's two fact fixes on this branch; the rest are decisions below                                                                                       |

The other sections of the update file (summary, recommended actions, decisions, still to do) are kept as the record of 2026-11-11; a note above the table says so. No user decision is open (`pending-user-decisions.md`, "Open: none").

### L6: attw's `node10` result

`bunx attw --pack .` in `packages/tscache` (attw 0.18.5, after `bun run --filter @anishbenji/tscache build`) prints "Resolution failed" under `node10` and "ESM (dynamic import only)" under `node16 (from CJS)` for all five entries, and passes `node16 (from ESM)` and `bundler`. The build runs attw with the `esm-only` profile (`packages/tscache/tsdown.config.ts:7`), which ignores those two columns, so `bun run ci` reports "No problems found". The README now says the package is ESM-only with an `exports` map and no `main`, that `bundler`, `node16` and `nodenext` find its types, that `node` (`node10`) does not read `exports`, and that CommonJS code loads it with `import()`.

### L10: the small items

- **`gapSplitK` bound (fixed).** `requirePositiveSafeInteger` (`packages/tscache/src/engine/validate.ts:17-22`) rejects 0, negatives and non-integers, and sets no upper bound; `validate.test.ts:145` pins the rejection of 0. The site now says so, and that a K of `segmentSlotCap` or more splits segments only at page edges: two points on one page have at most `segmentSlotCap` − 2 empty slots between them. The TSDoc in `packages/tscache/src/types.ts` is not changed, because that file is a Never path since 0.1.0 and would take this documentation step out of auto-merge; the same sentence can go there with the next change to that file.
- **"tsup is EOL" (proposed, not changed).** tsup 9.0.0 is npm's `latest` (published 2026-10-14), not deprecated, and its README says "This project is not actively maintained anymore" and points to tsdown. The only live occurrence is `AGENTS.md:36`; `docs/INDEX.md` says agents propose `AGENTS.md` changes on a `chore/` branch, so this branch does not change it. Proposed wording: `**tsup is no longer maintained (its README points to tsdown) — do not use.**`
- **The Biome warning, Knip's two hints and the empty folder** need a choice: see "Decisions for the user".

### The roadmap's bench gate

`docs/roadmap.md` said hot-path timing was "report-only for now" and listed the calibration as next. `docs/benchmarking.md`, "The gate", says the Bun cases in `packages/tscache/bench/gated.json` fail the `bench` job on a confirmed regression no trailer allows, and every other case and all of Chromium report. `scripts/bench.ts` reads `gated.json` (lines 77-78) and, with `--gate`, fails only listed cases. `gated.json` lists eight Bun cases and no Chromium case (chore 43's calibration; chore 45 kept Chromium report-only). The roadmap now says that, and moves the calibration to "Done". `gated.json` is not edited.

### Config comments

Every comment in the listed files was read. Fixed, because they stated something false:

| File and line            | Said                                                                                            | Fact                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest.config.ts:9-11`  | "Engine unit tests cover ~90% of logic; browser-mode and Playwright suites arrive at steps ⑨–⑫" | The Playwright suites exist (`playwright.config.ts`); no Vitest browser mode is configured (no `@vitest/browser` in any manifest); the 90 % figure has no source |
| `vitest.config.ts:13-15` | "`bun run ci` runs Vitest before the build"                                                     | `scripts/ci.sh` builds at line 53 and runs Vitest at line 67; the alias still matters for `bun run test` without, or with a stale, `dist/`                       |
| `.fallowrc.json:31-32`   | "`bun run ci` runs Fallow before the build"                                                     | `scripts/ci.sh` builds before Fallow (line 63); the pre-push hook runs Fallow in parallel with the build (`lefthook.yml`, `parallel: true`)                      |

Read and correct, not changed: `vitest.mutation.config.ts`, `playwright.config.ts` (the demo launcher starts the ten apps of `e2e/examples/apps.ts`, as it says), `knip.jsonc`, `stryker.config.json` (no workflow, hook or `ci.sh` line runs Stryker: `grep -i stryker .github/workflows/*.yml`), and the rest of `.fallowrc.json`. The root and package `package.json` files have no comment fields. `.fallowrc.json:107-108` still says members "used only by tests or by a later commit-plan step" are reported; the commit plan is complete, so the second case no longer arises, but the sentence is not false and is left.

Found in protected paths, not changed (listed for the director):

- `scripts/ci.sh:82-85`: "The timings run in the separate bench job, which reports and does not gate yet." False since chore 43: the job gates the eight Bun cases in `gated.json` (`.github/workflows/ci.yml:89-95` says so correctly). Suggested: "The timings run in the separate bench job, which gates the cases in packages/tscache/bench/gated.json and reports the rest."
- `lefthook.yml:1`: "Hook staging per starter prompt §4" still holds; the starter is now at `docs/history/starter-prompt.md`, and §4 is marked historical in `docs/INDEX.md`. Not false.
- `.github/`: the `bench` job comment in `ci.yml` and the `ci` job comment in `release.yml:151-152` are correct.
- `biome.json` and `packages/tscache/tsdown.config.ts`: `biome.json` has no comments; the two comments in `tsdown.config.ts` are correct.

### Toolchain watch (M16)

Versions on 2026-11-21: from the repository's manifests and `node_modules`, and from `npm view <package> dist-tags` and `gh api repos/gitleaks/gitleaks/releases/latest`. Nothing upgraded.

| Tool       | In the repository                                                                | Newest release                                                                | Newer?                                 |
| ---------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| VitePress  | `2.0.0-alpha.21` (`site/package.json`)                                           | `next` 2.0.0-alpha.21 (2026-10-25); `latest` 1.6.4 (2025-08-05, needs Vite 5) | No; still no stable release for Vite 8 |
| Node floor | root `engines.node` `>=22.12`; package `^20.19.0 \|\| >=22.12.0` (decision 27 A) | tsdown 0.23.7 requires `^22.18.0 \|\| ^24.11.0 \|\| >=26.0.0`                 | The floor is still below tsdown's      |
| gitleaks   | 8.30.1 (`ci.yml` pinned with SHA-256; Homebrew 8.30.1 locally)                   | 8.30.1 (2026-03-21); README: "feature complete", "security patches only"      | No                                     |
| tsdown     | `^0.23.4`, lockfile 0.23.4                                                       | 0.23.7 (2026-11-06)                                                           | Yes, a patch within the declared range |
| TypeDoc    | 0.28.20 with TypeScript 6.0.3 under an alias (`site/package.json`)               | 0.28.20 (2026-07-05); issue #3098 (TypeScript 7 support) still open           | No                                     |

## Decisions for the user

Each is a choice, so none was acted on.

1. **L10, the Biome warning.** `e2e/examples/react-lwcharts.spec.ts:37` calls Playwright's `Locator.innerText()`, which Biome's `useDomNodeTextContent` mistakes for the DOM property. Options: (a) turn the rule off for `e2e/**` in `biome.json`: no test changes, but the rule then also misses a real DOM `innerText` in a page script under `e2e/`; (b) a `biome-ignore` comment on the line: narrowest, one comment per occurrence; (c) call `textContent()` instead: no suppression, but it reads hidden text and ignores CSS line breaks, so the assertion could read different text. Recommendation: (a). The director already noted it and queued it as step 130.
2. **L10, Knip's two configuration hints.** Knip reports `.svelte` and `.vue` as "Compiled extension excluded by project (imports not followed)" for `integrations`. Options: (a) leave them: the snippets are type-checked by `bun run check:integrations` and are entries anyway; (b) configure Knip compilers for the two extensions, which could add Svelte and Vue compiler dev dependencies. Recommendation: (a), and record the hints as expected.
3. **L10, the empty `~/code/tscache-vitewarn54/` folder.** It is still there and empty. It is outside the repository and this step did not create it, so deleting it needs your OK. Recommendation: delete it.
4. **M8, snapshot embedding.** Options: (a) export an escaping helper for embedding `encodeSnapshot`'s output in a `<script>` tag, and check host byte order (fail on a big-endian host, or swap); (b) keep the documentation only. Both parts of (a) change the public API or `snapshot.ts`, Never paths since 0.1.0. Recommendation: (b) for the byte order, since the platforms browsers run on today are little-endian, and (a)'s helper only if consumers ask; then close M8 as "won't fix".
5. **L7, budget headroom.** On this branch `worker (lazy)` is 5.39 of 5.69 kB (5.3 % headroom), `index (lazy)` 14.25 of 14.75 kB (3.4 %), `worker` 15.50 of 15.97 kB (2.9 %) and `engine` 11.57 of 12.06 kB (4.1 %). The budget rule is measured size plus max(512 B, 3 %) (`scripts/size.ts:21`), and since step 108 the measurement no longer moves with chunk hashes or comments. Options: (a) close L7 as by design: a deliberate change raises its budget in its own pull request (`docs/benchmarking.md`); (b) give every budget at least 6 % headroom. Recommendation: (a).
6. **L9, `merge-failures.test.ts`.** It injects an allocation failure at the Nth call of a `DenseSegment` method and checks that the cache is unchanged and still usable. The call counts only choose where the failure lands; the assertions are on outcomes. The fault-injection property test of step 74 covers the same guarantee from outside. Options: (a) keep the test and close L9; (b) rewrite it to inject failures without counting calls. Recommendation: (a): it pins the step-by-step atomicity that N70 describes.
7. **L4, the missing review files.** PRs #29 and #32–#37 (chores and a docs step numbered 17–23 the second time) and steps 49–50 (#74 and #75, two dependency bumps) have no review file. Options: (a) close L4 with one line in `docs/reviews/README.md` naming them as merged before the rule; (b) write review files after the fact from the pull requests. Recommendation: (a): a review file written now would only restate the pull request.
8. **M16, the Node floor for development.** The root `engines.node` (`>=22.12`) is below tsdown's (`^22.18.0 || ^24.11.0 || >=26.0.0`), so a contributor on Node 22.12–22.17 meets tsdown's engine check, not the repository's. Options: (a) raise the root `engines.node` to tsdown's range; the published package's `engines` stays as decision 27 A set it; (b) leave it. Recommendation: (a). It touches root `package.json`, a Notify path, and is not a dependency change.

## Verification

| Command                                    | Result                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `bunx attw --pack .` in `packages/tscache` | The table above: `node10` "Resolution failed" on all five entries                                 |
| `bun scripts/size.ts`                      | Every entry `ok`; sizes as in decision 5                                                          |
| `bunx biome ci .`                          | One warning (decision 1), no error                                                                |
| `bunx knip`                                | Exit 0; two configuration hints (decision 2)                                                      |
| `bun run docs:check`                       | Exit 0; `doc-anchors: 246 anchors in 42 pages resolve`                                            |
| `heavy-run.sh "128 child: ci" bun run ci`  | Exit 0 on `c2a7e21`: Vitest 3,058 passed in 156 files; Playwright, bench smoke and e2e smoke `ok` |

## Contract-test changes

None.

## Decision concerns

None. No locked decision is touched.
