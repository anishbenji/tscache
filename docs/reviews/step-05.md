# Step 05 — Merge / put path

Branch: `feat/05-merge-put` · Reviewer: GPT-6.1 Sol (high; xhigh for adversarial) · Rounds: 5 (cap of four passed with the user's authorization) · Status: settled · Verdict after triage: merge

## Round 1 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | A replace that splits one segment into very many parts overflows the stack in `splice(...parts)` after the segment was cut back, losing the points after the authority | accepted | Reproduced with a regression test (400 002 slots, K = 1). Fixed in dded03f: the new segments and the new list are built before the old segment is cut back, with no argument spread |
| R1-2 | P0 | An allocation failure part-way through a join leaves overlapping, unordered segments | accepted | Reproduced with fault injection on `slice` for a target on the left, in the middle and on the right. Fixed in dded03f: neighbours are absorbed nearest first and leave the list as they are copied |

## Adversarial round 1 — focus: atomic reject, new-wins across boundaries, K-split and slot-cap edges, warning cost when off — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| A1-1 | P0 | Large replacement deletes points outside its authority (same defect as R1-1) | accepted | fixed in dded03f |
| A1-2 | P0 | Allocation failure during a join leaves overlapping, unsorted segments (same defect as R1-2) | accepted | fixed in dded03f |

Found while validating, not raised by the reviewer: a replace whose insert failed skipped the split of the segment it had cleared, leaving a gap wider than K inside one segment. Fixed in dded03f (the split now runs in a `finally`), with a regression test.

## Round 2 — reviewer verdict: block

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P0 | A failed join leaves a gap wider than K inside one segment (follows R1-2) | accepted | Reproduced. Second round running on the join, so per the convergence rule it was redesigned instead of patched, in 8563e57: the other segments and the chunk are gathered in a scratch segment, the stored segment then changes in one atomic `mergeFrom`, and the list is edited only afterwards. A failed join now changes nothing; the fault-injection test fails every `slice` and `mergeFrom` call in turn and compares the whole store before and after. Architecture §4.3 states the resulting guarantee |
| R2-2 | P1 | `instanceof` checks reject typed arrays from another realm and accept foreign BigInt arrays and DataViews | accepted | Reproduced with `node:vm`. Fixed in 8563e57: array kind is read from the `%TypedArray%` tag getter, which works across realms; regression tests added |

## Round 3 — reviewer verdict: merge after fixes

The reviewer confirmed every accepted finding from rounds 1–2 as fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | A symbol passed as the batch throws `TypeError` from the message interpolation instead of `PutError` `'field-mismatch'` | accepted | Reproduced. Fixed in 4565638 with `String(batch)`; the other messages in `batch.ts` were checked and interpolate only numbers and schema names. Regression tests cover a symbol as the batch, as a field, as `timestamps` and as one timestamp |

## Round 4 — reviewer verdict: merge after fixes

The reviewer confirmed every accepted finding from rounds 1–3 as fixed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R4-1 | P1 | A timestamp whose string conversion throws (`Object.create(null)`) raises `TypeError` from `String(t)` instead of `PutError` `'misaligned'` (same class as R3-1) | accepted | Reproduced. Second round running on message building, so per the convergence rule the class was removed instead of the instance, in 0bd9ded: every message for an untrusted value in `src/` (batch, grid, config validation, payload decoding) now goes through one `show()` helper that never calls the value's own conversion. `test/hostile-values.test.ts` passes five hostile values through every batch, range and config position. Validating this also found that a field element that cannot be converted to a number threw `TypeError` from the typed-array copy; it now rejects as `'field-mismatch'` (architecture §4.3 updated) |

Round 4 is the cap (docs/workflow.md, review loop step 8) and it raised a P1, so the loop was escalated. The user authorized further rounds until settled (2026-10-06).

## Round 5 — reviewer verdict: merge

No findings. The reviewer confirmed every accepted finding from rounds 1–4 as fixed.

## Contract-test changes

None.

## Decision concerns

None.

## Merge request

**Scope.** Step ⑤ of the commit plan: the put path. `snapIn` in `grid.ts` (N13), `validateBatch` in `engine/batch.ts`, `SegmentStore` in `engine/merge.ts` with the overlap warning in `engine/overlap.ts`, the programming-error checks shared with `DenseSegment` in `segment/assert.ts`, and the `show()` message helper in `errors.ts`. Architecture doc: §4.3 (new), `snapIn` in §4.1, N11 confirmed as final, N13–N15 registered, module layout updated. Nothing is exported from a package entry yet; `put` reaches consumers at step ⑧.

**Decisions taken on this branch.** N11 final; N13 put range snaps inward; N14 K counts absent slots; N15 fixed pages (all user-confirmed 2026-10-05). Settled by the implementer and recorded in §4.3: a non-number timestamp is reported by index without `offenderTimestamp`; `snapIn` has no overflow rejection; a field element that cannot be converted to a number is `'field-mismatch'`; error messages never call an untrusted value's own conversion.

**Review outcome.** Five rounds plus the scheduled adversarial pass. Rounds 1–2 found two real P0 defects in failure handling (a huge split overflowed the stack after the segment was cut back, losing a point outside the authority; a failed join left the list unordered) and a P1 (typed arrays from another realm rejected). The join was redesigned to be atomic after the convergence rule fired. Rounds 3–4 each found one hostile-input P1 in message building; after the second the whole class was removed with `show()`. Round 5: no findings. All contract tests unchanged.

**Confidence: high.** Every finding was reproduced with a test before the fix, and the reviewer confirmed each fix in the following round. The property test compares the store against a `Map` model under random upsert and replace sequences and checks that the layout is independent of arrival order. Fault-injection tests fail every `slice` and `mergeFrom` call of a join in turn and check the store is unchanged.

**Blast radius: small.** New modules plus three edits to existing code: `DenseSegment` now calls the shared assertions (same checks, moved); `grid.ts` gained `snapIn` and a shared range check; `String()` became `show()` in `validate.ts` and `payload.ts` messages (step ② and ④ code, touched because the hostile-value fix applies to them too; primitives print exactly as before, so existing tests were unaffected). No consumer-visible API changes beyond the documented `PutError` details.

**Known limits, by design.** A `put` that cannot allocate may be left half done, in steps that are each atomic; the engine must withdraw coverage for the range when `put` throws (step ⑦, recorded in §4.3). The opt-in overlap warning allocates per batch point; it is off by default and O(overlap) as documented. The large-split regression test takes about three seconds.

**Test coverage.** 658 tests pass (`bun run ci`): 198 contract tests across eight files from Codex, plus implementer tests for allocation failure, cross-realm arrays and hostile values.

## Follow-up: dev dependency bumps (`chore/06-dev-deps`)

Dependabot's grouped proposal (#3) bundled eight patch/minor bumps with three major ones and failed CI on the new Biome's formatting. It was closed and split (user decision 2026-10-06): this branch takes the eight small bumps; TypeScript 7, Vitest 5 and tsdown 0.23 follow one pull request each.

### Round 1 — reviewer verdict: merge

No findings. The reviewer confirmed the test changes are formatting only.

### Contract-test changes

Fifteen test files, eight of them Codex contract tests, were reflowed by Biome 2.5.15 (line breaks only, verified with a whitespace-insensitive diff). No assertion changed.

## Merge request: `chore/06-dev-deps` → `main`

**Scope.** Biome 2.4.16 → 2.5.15, commitlint 21.0.2 → 21.2.3, Playwright 1.60.0 → 1.63.0, git-cliff 2.13.1 → 2.14.2, Knip 6.16.1 → 6.39.0, Lefthook 2.1.9 → 2.1.16, publint 0.3.21 → 0.3.25, attw 0.18.3 → 0.18.5. `biome.json` points at the 2.5.15 schema and uses `rules.preset` (the `recommended` flag is deprecated). `.github/dependabot.yml` groups only minor and patch bumps, so a major arrives on its own.

**Confidence: high.** `bun run ci` passes with the new tools (658 tests); the only source change is formatting. Blast radius: tooling only, no `src/` change. The one behaviour change to watch is Biome's formatter, which now reflows some constructs; the pre-commit hook formats staged files, so later commits follow the new style automatically.

**Not included.** TypeScript 6 → 7 (no programmatic API in 7.0, so tooling on the compiler API needs care), Vitest 4 → 5, tsdown 0.22 → 0.23 (drops the `types` export field it emits and several deprecated options). Each comes separately with its changelog summary.

## Follow-up: tsdown 0.23 (`chore/06-tsdown`)

Major-feeling bump of a pre-1.0 tool. Breaking changes checked against `packages/tscache/tsdown.config.ts`: the `types`/`typesVersions` emission it drops is unused (exports-only package), the attw profile was already `esm-only`, none of the removed options (`bundle`, `outExtension`, `publicDir`, `dts.cjsReexport`, `skipNodeModulesBundle`, `deps.onlyAllowBundle`) is set, and Node ^22.18 / ^24.11 holds locally and in CI. Build, publint and attw pass unchanged.

### Round 1 — reviewer verdict: merge

No findings.

## Merge request: `chore/06-tsdown` → `main`

One dependency, `tsdown` 0.22.2 → 0.23.0. `bun run ci` passes (658 tests, build output identical in size). Confidence high; blast radius is the build step only.
## Follow-up: Vitest 5 (`chore/06-vitest`)

Breaking changes from the migration guide checked against the repo: Node ≥ 22.12 and Vite ≥ 6.4 are met; `clearMocks` now defaults to true, which the suites tolerate because each restores its own mocks; unawaited async assertions now fail the test (none exist); `toThrow("")` semantics changed (not used); the bench API was rewritten (no bench files yet; the step ⑥+ bench smoke will use the new context-based API); config files are no longer searched in parent directories (Vitest runs from the repository root, where `vitest.config.ts` lives). The whole suite passes unchanged, with no deprecation output.

### Round 1 — reviewer verdict: merge

No findings; the reviewer checked the usage against the migration guide.

## Merge request: `chore/06-vitest` → `main`

One dependency, `vitest` 4.1.8 → 5.0.3. `bun run ci` passes (658 tests). Confidence high; blast radius is the test runner only. Vitest still runs under Node, per the toolchain rule in `AGENTS.md`.

## Follow-up: TypeScript 7 and Dependabot's commit subjects (`chore/18-typescript-7`)

**Decisions (user, 2026-10-23).** Adopt TypeScript 7.0.2 as the authoritative type check, replacing TypeScript 6 and the optional tsgo check; starter §4 (row and hook staging) and the `AGENTS.md` toolchain line say so. Make commitlint skip Dependabot's capitalised bump commits instead of redoing each bump by hand. This branch replaces Dependabot's #7, whose CI never got past commitlint: its subject is `chore: Bump typescript …`, and Dependabot capitalises "Bump" only sometimes (#3, #6 and #8 were lowercase).

**TypeScript 7, checked against the repo.** No tsconfig uses an option 7.0 removed or changed (all use `moduleResolution: "bundler"`, `module: "ESNext"`, `target: "ES2022"`, `strict`). No code here imports the TypeScript API, which the 7.0 package does not ship (nor `tsserver`): attw bundles its own TypeScript 5.6, tsdown emits declarations through Oxc (`isolatedDeclarations`), the commitlint config is plain `.mjs`, and Fallow already ran on 7.0.2. Evidence: the full `bun run ci` passes (1444 Node tests, 48 browser specs, build with declarations, publint and attw, Knip, Fallow, `check:integrations`); a planted type error is reported in the package and in all eight integration projects; the examples, which CI does not type-check, report no errors under either version. The checks take about a third of the time (package 0.95 s → 0.35 s, integrations 3.1 s → 1.0 s). A future tool that needs the API, such as TypeDoc, gets TypeScript 6 under an npm alias.

**Commitlint.** `commitlint.config.mjs` ignores a commit only when its subject starts with `chore: Bump ` or `ci: Bump ` and it carries Dependabot's sign-off trailer. `scripts/commitlint-config.test.sh` (run by `scripts/ci.sh`) checks #7's real message and an actions-group bump pass, and that a capitalised bump without the trailer, a capitalised non-bump subject with the trailer, and a lowercase bump are linted as before. It failed before the rule, and each broadening mutant (subject only, trailer only) fails it.

### Round 8 — reviewer verdict: merge

No findings. The reviewer ran the type check and the commitlint cases itself; `bun run ci` passed (1444 Node tests, 48 browser specs).

## Merge request: `chore/18-typescript-7` → `main`

Two changes, each its own commit. `typescript` 6.0.3 → 7.0.2, with starter §4 and `AGENTS.md` updated to make TypeScript 7 the authoritative type check; blast radius is the type check and nothing that imports the compiler, since nothing here does. Commitlint skips Dependabot's capitalised bump commits only, with a shell test in `scripts/ci.sh`. Replaces #7, which can be closed. Not verified locally: this branch was cut before #31 merged, so the GitHub run on the merge ref is the first type check of #31's code under TypeScript 7.

## Follow-up: Vitest's test timeout (`chore/19-test-timeout`)

**Problem.** Pre-push failed twice while `chore/18` was pushed: Vitest's 5 s default timed out `keeps the points outside the authority` (merge-failures, 7.8 s and 6.8 s) and a seeded upsert/replace property (merge-property, 6.0 s). At idle they take 373 ms and 146 ms, and the whole suite 2.2 s; the machine was at load 20–28 from other processes. The same flake was seen once at step ⑯.

**What was ruled out.** Building the package before the parallel pre-push checks (the `knip` job builds since #28) made no measurable difference: the build takes 0.4 s, and with ten CPU burners (load up to 90) both hook configurations passed three times out of three, Vitest taking about 4.5 s either way. Plain CPU contention therefore slows the suite about twofold, not the twenty- to fortyfold seen; the real cause is outside the repository and was not identified.

**Decision (user, 2026-10-23).** Raise the global `testTimeout` to 20 s in `vitest.config.ts`, a 2.5× margin over the worst run seen, rather than per-test timeouts on the contract tests or the lefthook change. Assertions and contract tests are unchanged; the cost is that a hung test fails after 20 s instead of 5 s. A temporary test that busy-waits 6 s failed under the old configuration and passed under the new one, then was deleted.

**Not Codex-reviewed.** Codex was at 89 % of its five-hour window, over the 85 % pause line; the user chose to open the pull request without a round (2026-10-23). `bun run ci` passed: 1446 Node tests, 48 browser specs.

## Merge request: `chore/19-test-timeout` → `main`

One line in `vitest.config.ts`, `testTimeout: 20_000`, with its reason. Blast radius: how long Vitest waits before failing a slow or hung test; no assertion changes. The cause of the 20–40× slowdowns stays unknown; if a heavy test crosses 20 s, that is a signal worth investigating rather than another raise.

## Follow-up: type-checking e2e, scripts and tool configs (`chore/20-typecheck-e2e-scripts`)

**Problem.** `bun run typecheck` (pre-push) and `scripts/ci.sh` checked only `packages/tscache`. Twenty-four tracked TypeScript files belonged to no checked project: the Playwright specs and helpers under `e2e/`, the Bun-run e2e server and backend in `scripts/`, `playwright.config.ts`, `vitest.config.ts`, `packages/tscache/tsdown.config.ts` and the mock backend's tests. The e2e helpers import library types, so a change to those types could break them unnoticed (found at step ⑫).

**Decision (user, 2026-10-26).** Add `@types/bun` 1.4.4 as a devDependency, so the e2e server's use of `Bun.serve`, `Bun.file` and `process.env` is checked against Bun's real types rather than skipped or declared by hand.

**Change.** A root `tsconfig.json` covers `scripts/` and the tool configs with `types: ["bun"]`; `e2e/tsconfig.json` covers the specs with DOM types, since their `page.evaluate` callbacks run in the browser. `bun run typecheck` runs these two and the mock backend's existing project after the library's, and `scripts/ci.sh` now calls `bun run typecheck`, so pre-push and CI check the same files. TypeScript 7 loads only the types a project names, so Bun's and Node's globals stay out of the library: a planted `Bun.version` and `process.env` in `packages/tscache/src` are still errors, and no other project's file list includes Bun's types. Knip reads the root `tsconfig.json`, so it counts `@types/bun` as used.

**Evidence.** The new projects pass with no code changes. A planted type error in each of `scripts/e2e-server.ts`, `scripts/e2e-backend.ts`, `playwright.config.ts`, `vitest.config.ts`, `packages/tscache/tsdown.config.ts`, `e2e/support.ts`, `e2e/examples/support.ts` and `examples/mock-backend/test/backend.test.ts` fails `bun run typecheck` naming that file, as does a call to a nonexistent `Bun` member. Comparing every project's file list with `git ls-files '*.ts' '*.tsx'` now leaves one file unchecked: `.claude/hooks/guard-bash.ts`, the frozen Bash guard, which stays out of scope.

### Round 9 — reviewer verdict: merge

No findings. The reviewer ran `bun run typecheck` itself and read the compiler's file lists, which confirm the added coverage and that the library project loads no Bun types. `bun run ci` passed: 1446 Node tests, 48 browser specs.

### GitHub CI, first run — failed, fixed

The `e2e` and mock backend projects import `tscache`, whose exports point into `dist/`. `scripts/ci.sh` type-checks before it builds, so on GitHub's fresh checkout the import did not resolve (`TS2307: Cannot find module 'tscache'`). Local runs passed only because an earlier build had left `dist/` in place. Pre-push had a related race: it type-checks in parallel with the `knip` job, which rebuilds `dist/`. Both tsconfigs now map `tscache` and `tscache/*` to `packages/tscache/src/entries/`, as Vitest's alias does. Moving `dist/` aside reproduced the failure before the fix; after it, `bun run typecheck` passes without `dist/`, planted errors in `e2e/support.ts` and the mock backend's tests are still reported, and Knip does not flag the backend's `tscache` dependency. Not re-reviewed by Codex: the fix is the two `paths` entries, checked as above.

## Merge request: `chore/20-typecheck-e2e-scripts` → `main`

A root `tsconfig.json` and `e2e/tsconfig.json`, and `bun run typecheck` running them with the mock backend's project; `scripts/ci.sh` calls the same script. One new devDependency, `@types/bun` 1.4.4 (user-approved). Blast radius: the type check only. No source, test or assertion changes, and the library's own check is unchanged. Not checked: `.claude/hooks/guard-bash.ts`, which stays frozen.

## Follow-up: local CI starts without the built package (`chore/21-ci-clean-dist`)

**Problem.** A local `bun run ci`, including the one `scripts/codex-review.sh` runs before every review round, started with whatever `packages/tscache/dist/` an earlier build had left. GitHub's checkout has none. A check that runs before the build and needs the package therefore passed locally and failed on GitHub: #34's first run (`TS2307`), after the same kind of miss at #22 and #28.

**Decision (user, 2026-10-26).** `scripts/ci.sh` deletes `packages/tscache/dist` before anything else. A local run now always rebuilds the package; the build takes about 0.4 s. The examples' `dist/` directories are left alone, because nothing reads them before Playwright rebuilds each app.

**Evidence.** Replayed on #34's commit before its fix (7b9933a), in a scratch worktree with a fresh build in `dist/`: the old script passed there (round 9's CI log, same tsconfigs), and the new one fails at the type check with `TS2307: Cannot find module 'tscache'`, as GitHub did. The worktree was removed afterwards.

### Round 10 — reviewer verdict: merge

No findings. The reviewer checked the script's syntax and the library's type check itself. `bun run ci` passed with the new first step: 1446 Node tests, 48 browser specs, and `dist/` rebuilt from nothing.

## Merge request: `chore/21-ci-clean-dist` → `main`

One line in `scripts/ci.sh`, with its reason: delete `packages/tscache/dist` before anything else, so a local run starts where GitHub's checkout does. Blast radius: local CI runs, which always rebuild the package (about 0.4 s); on GitHub the directory does not exist and the line does nothing. No check, test or assertion changes.
