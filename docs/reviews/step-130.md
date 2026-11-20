# Step 130 — Biome rule off for e2e, and a Dependabot cooldown

Branch: `chore/130-e2e-lint-and-dependabot-cooldown` · Status: built, awaiting review · Both changed configuration files are protected paths (`biome.json`, `.github/`), so the user merges this step.

## Scope

- `biome.json`: a new `overrides` entry turns `lint/performance/useDomNodeTextContent` off for `e2e/**`. The rule stays on, from the `recommended` preset, everywhere else. Nothing else in the file changed.
- `.github/dependabot.yml`: the `bun` entry gains `cooldown` with `default-days: 3` and `semver-major-days: 7`, and a comment saying why. The `github-actions` entry is unchanged. Nothing else in the file changed.
- `docs/supply-chain.md`: one checklist line under "Workflows" saying that Dependabot waits for the cooldown. Its `docs/INDEX.md` row is re-measured: 10.3 KB becomes 10.7 KB (`wc -c`: 10,656 bytes).

No source, test or published package changed. No dependency was added.

## User answers (2026-11-21)

- **Biome `useDomNodeTextContent`: option A.** Turn the rule off for `e2e/**` only. Every hit there is Playwright's `Locator.innerText()`, not the DOM property `HTMLElement.innerText`; steps 73, 116 and 123 recorded the one warning as a false positive. Step 123's "Decision concerns" recommended this override.
- **Minimum release age: option A.** A Dependabot `cooldown` for the `bun` ecosystem, about 3 days for patch and minor and 7 for major. There is no Bun `minimumReleaseAge`, so an upgrade approved by hand can still take a fresh version. Step 123's security lane raised it: Solid 2.0.3 was one to three days old when it landed.

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

The options reference does not mention groups. It describes the cooldown per dependency: "If a dependency's new release falls within its cooldown period, Dependabot skips updating the version for that dependency." In dependabot-core the check runs in each ecosystem's update checker (`common/lib/dependabot/update_checkers/cooldown_calculation.rb`), which grouped updates also use, and a grouped update that ignored the cooldown was treated as a bug and fixed ([dependabot-core #15323](https://github.com/dependabot/dependabot-core/issues/15323), fixed by #15346). So the cooldown applies to the `react`, `solid` and `dev-dependencies` groups, member by member.

One consequence for the lockstep groups: a member still inside its cooldown is left out of the group's pull request. React and react-dom, and Solid and its `@solidjs/*` packages, are normally published together, so they cool down together. If one member were published a day or more after the others, a group pull request could arrive without it, and it would follow once its own cooldown ends. Such a pull request would fail CI the way the lockstep comment describes, and it is reviewed by hand in any case. This step does not change the groups.

## Verification

| Check                   | Command                                                              | Result                                                                                              |
| ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Biome before the change | `bunx biome ci .` on `main` (`6716b4d5`)                             | `Checked 869 files … No fixes applied. Found 1 warning.` (`e2e/examples/react-lwcharts.spec.ts:37`) |
| Biome after the change  | `bunx biome ci .`                                                    | `Checked 869 files … No fixes applied.` No warning                                                  |
| Full gate, final head   | `~/code/tscache-reports/bin/heavy-run.sh "130 child: ci" bun run ci` | see below                                                                                           |

## Contract-test changes

None.

## Decision concerns

None.
