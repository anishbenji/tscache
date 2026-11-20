# Step 130 — Biome rule off for e2e, and a Dependabot cooldown

Branch: `chore/130-e2e-lint-and-dependabot-cooldown` · Status: built, awaiting review · It touches two protected paths, `.github/dependabot.yml` and `scripts/ci.sh` (`biome.json` is on the notify list), so the user merges this step.

## Scope

- `biome.json`: a new `overrides` entry turns `lint/performance/useDomNodeTextContent` off for `e2e/**`. The rule stays on, from the `recommended` preset, everywhere else. Nothing else in the file changed.
- `.github/dependabot.yml`: the `bun` entry gains `cooldown` with `default-days: 3` and `semver-major-days: 7`, and a comment saying why. The `github-actions` entry is unchanged. Nothing else in the file changed.
- `docs/supply-chain.md`: one checklist line under "Workflows" saying that Dependabot waits for the cooldown. Its `docs/INDEX.md` row is re-measured: 10.3 KB becomes 10.7 KB (`wc -c`: 10,656 bytes).
- `scripts/ci.sh`: a fact fix from step 128, added to this step by the director. The comment above the size and bench smoke commands said the bench job "reports and does not gate yet", which has been false since chore 43. It now says the job "gates the cases in packages/tscache/bench/gated.json and reports the rest", matching `.github/workflows/ci.yml` (the bench job's comment). `gated.json` lists eight Bun cases and no Chromium case. Only the comment changed; `bash -n scripts/ci.sh` passes.

No source, test or published package changed. No dependency was added.

## User answers (2026-11-21)

- **Biome `useDomNodeTextContent`: option A.** Turn the rule off for `e2e/**` only. Every hit there is Playwright's `Locator.innerText()`, not the DOM property `HTMLElement.innerText`; step 73 recorded the warning, and steps 116 and 123 judged it a false positive. Step 123's "Decision concerns" recommended this override.
- **Minimum release age: option A.** A Dependabot `cooldown` for the `bun` ecosystem, about 3 days for patch and minor and 7 for major. This step sets no Bun `minimumReleaseAge` (`bunfig.toml`, `[install]`; the user chose against it), so an upgrade approved by hand can still take a fresh version. Step 123's security lane raised it: Solid 2.0.3 was one to three days old when it landed.

## What was checked

### Biome override syntax

Against the installed schema, `node_modules/@biomejs/biome/configuration_schema.json` (Biome 2.6.4, the version `biome.json`'s `$schema` names):

- `OverridePattern` has `includes` (`OverrideGlobs`) and `linter` (`OverrideLinterConfiguration`, whose `rules` is the same `Rules` type as the top-level linter).
- `Rules.performance` is `SeverityOrPerformance`; `Performance.useDomNodeTextContent` is `UseDomNodeTextContentConfiguration`, which accepts `RulePlainConfiguration`, and that includes the string `"off"` ("Disables the rule").
- The existing override for `.fallowrc.json` and `**/tsconfig*.json` uses the same `includes` form; the new entry follows it.

`grep -rn innerText e2e` finds one call, `e2e/examples/react-lwcharts.spec.ts:37` (`page.locator("#log").innerText()`), which was the only warning.

To confirm the override is scoped, a throwaway file reading `el.innerText` from an `HTMLElement` was linted at the repository root and under `e2e/` (`bunx biome lint <root file> e2e/<dir>/p.ts`; both files deleted afterwards). Biome reported `lint/performance/useDomNodeTextContent` for the root file only: `Checked 2 files … Found 1 warning.`

### Dependabot cooldown keys

Fetched on 2026-11-21:

- [Dependabot options reference, `cooldown`](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown-). The keys are `default-days`, `semver-major-days`, `semver-minor-days`, `semver-patch-days`, `include` and `exclude`. "If `semver-major-days`, `semver-minor-days`, or `semver-patch-days` are not defined, the `default-days` settings will take precedence", so minor and patch need no keys of their own and are left out. The support table marks Bun as supporting both `default-days` and the SemVer-bump days. "The `cooldown` option is only available for version updates, not security updates."
- The same page says Dependabot already applies "a default cooldown period of 3 days to version updates, even when `cooldown` is not configured" ([changelog, 2026-07-14](https://github.blog/changelog/2026-07-14-dependabot-version-updates-introduce-default-package-cooldown)). `default-days: 3` therefore matches the current default; it is written out so the policy is in the repository rather than in GitHub's default, and `semver-major-days: 7` is the new constraint.
- [SchemaStore `dependabot-2.0.json`](https://json.schemastore.org/dependabot-2.0.json) defines `update.properties.cooldown` with the same four `*-days` keys, each an integer from 0 to 90.
- The edited file parses (`Bun.YAML.parse`): the `bun` entry has `cooldown: {"default-days": 3, "semver-major-days": 7}` and its three groups; the `github-actions` entry has no `cooldown`.

### Cooldown and grouped updates

The options reference does not mention groups. It describes the cooldown per dependency: "If a dependency's new release falls within its cooldown period, Dependabot skips updating the version for that dependency." In dependabot-core the check runs in each ecosystem's update checker (`common/lib/dependabot/update_checkers/cooldown_calculation.rb`), which grouped updates also use, and the Bun ecosystem's finder filters candidate releases with it (`bun/lib/dependabot/bun/update_checker/latest_version_finder.rb`, `filter_by_cooldown`). [dependabot-core #15323](https://github.com/dependabot/dependabot-core/issues/15323) (fixed by #15346) was a grouped-update bypass for pre-commit, not Bun. So the cooldown applies to the `react`, `solid` and `dev-dependencies` groups, member by member; a member inside its cooldown may also be proposed at an older eligible version rather than left out.

One consequence for the lockstep groups: a member still inside its cooldown is left out of the group's pull request. React and react-dom, and Solid and its `@solidjs/*` packages, are normally published together, so they cool down together. If one member were published a day or more after the others, a group pull request could arrive without it, and it would follow once its own cooldown ends. Such a pull request would fail CI the way the lockstep comment describes, and it is reviewed by hand in any case. This step does not change the groups.

## Verification

| Check                   | Command                                                                            | Result                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Biome before the change | `bunx biome ci .` on `main` (`6716b4d5`)                                           | `Checked 869 files … No fixes applied. Found 1 warning.` (`e2e/examples/react-lwcharts.spec.ts:37`)                                                                                                                                                                                                    |
| Biome after the change  | `bunx biome ci .`                                                                  | `Checked 869 files … No fixes applied.` No warning                                                                                                                                                                                                                                                     |
| Full gate               | `~/code/tscache-reports/bin/heavy-run.sh "130 child: ci" bun run ci` on `284e0e2b` | exit 0: gitleaks over `main..HEAD` (5 commits, no leaks) and commitlint, Biome `Checked 870 files … No fixes applied.` with no warning, typecheck, build with publint and attw clean, Knip, Fallow (health 97), Vitest 3058 passed (156 files), Playwright 193 passed, size, bench smoke and e2e smoke |

The full gate ran on `284e0e2b`, which includes every change above. The only commit after it fills in this table and changes only this file.

## Contract-test changes

None.

## Decision concerns

None.

## Pre-review (Claude), not the gate

Pre-review 1 (Fable, head `18d1ee6`): one P2 and three nits, all in this file, fixed by the director: Bun does have `install.minimumReleaseAge` (not set, by the user's choice); the group evidence now cites the Bun finder; step 73 only recorded the warning; the protected paths are `.github/dependabot.yml` and `scripts/ci.sh`.

## Security lane

Run 1 (Opus, head `18d1ee6`): no findings. Cooldown applies to version updates only, never security updates. Not a finding: the `github-actions` entry keeps GitHub's default 3 days, majors included; a 7-day major cooldown there is a separate user decision.
