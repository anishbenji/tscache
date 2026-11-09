# Step 66 — Supply-chain hardening

Branch: `ci/66-supply-chain` · Status: built, awaiting review

The step adds an OpenSSF Scorecard workflow and its badge, a hardening checklist (`docs/supply-chain.md`), and two repository settings: a ruleset protecting the `v*` release tags and the `npm-publish` environment. The settings were applied with `gh api` on 2026-11-09 under the user's decision of that day that agents may make these changes and record each one in the pull request. No other setting was changed.

## Scope

| Commit  | What                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4daddb0 | `ci`: `.github/workflows/scorecard.yml` and the Scorecard badge at the top of `README.md`.                                                          |
| fee9973 | `docs`: `docs/supply-chain.md`, the hardening checklist. It is a new page because `docs/releasing.md` belongs to step 64, which has not merged yet. |
| f9309f1 | `docs(review)`: this file, recording the two repository settings.                                                                                   |
| b17616c | `ci`: drop `actions: read` and the `branch_protection_rule` trigger (pre-review findings 3 and 4).                                                  |
| 6212b19 | `docs`: correct the checklist's token grep, `id-token` claim and tag-ruleset text (pre-review findings 1, 2 and 5).                                 |

`ci.yml` and `release.yml` are not touched (step 64 owns them).

## The Scorecard workflow

Triggers: push to `main` and weekly (Mondays 03:17 UTC), the two the action's README lists. `branch_protection_rule` is left out: it fires only for classic branch protection, and this repository uses rulesets. The workflow-level permissions are `{}`; the single job `analysis` holds:

| Permission               | Why                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `contents: read`         | Check out the repository.                                                                                                             |
| `security-events: write` | Upload the SARIF results to code scanning.                                                                                            |
| `id-token: write`        | Sign the published results with the GitHub OIDC token (`publish_results: true`). Outside it, only release.yml's `stage` job holds it. |

The job follows the Scorecard API's workflow restrictions: no top-level `env` or `defaults`, no workflow-level write permission, an Ubuntu hosted runner, and only the approved actions. The README lists issues, pull-requests and checks reads for private repositories only, and `ossf/scorecard`'s own analysis workflow grants only `security-events` and `id-token` at job level; this repository is public, so no other read is granted. (`actions: read` was in the first build and was dropped in b17616c.)

Action pins, each resolved from the release tag with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (and the annotated tag object where the ref points to one). The scorecard-action, checkout and upload-artifact pins match the ones in `ossf/scorecard`'s own analysis workflow.

| Action                              | Version | Commit                                                            |
| ----------------------------------- | ------- | ----------------------------------------------------------------- |
| `actions/checkout`                  | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1` (same pin as `ci.yml`) |
| `ossf/scorecard-action`             | v2.5.0  | `fa7117db83c52d787ae5a89f350999701505d78e`                        |
| `actions/upload-artifact`           | v7.0.2  | `cf430e030ddbb5b0abf93d22962f4752f3646cd9`                        |
| `github/codeql-action/upload-sarif` | v4.39.3 | `33d7b85da1a04171e211befe2c739303b9a4c066`                        |

## Repository settings

All commands ran as `anishbenji` (repository admin) against `anishbenji/tscache`.

### State before

```sh
gh api repos/anishbenji/tscache/rulesets
gh api repos/anishbenji/tscache/environments
gh api repos/anishbenji/tscache/environments/npm-publish
```

- Rulesets: one, `protect-main` (id 24496690, target `branch`, `~DEFAULT_BRANCH`, rules `deletion`, `non_fast_forward`, `pull_request`, `required_status_checks` for `ci`, no bypass actors). No tag ruleset existed.
- Environments: `{"total_count":0,"environments":[]}`; `npm-publish` returned 404.

Neither setting existed, so both were created; nothing was adjusted.

### 1. Ruleset `protect-release-tags`

Command:

```sh
gh api --method POST repos/anishbenji/tscache/rulesets --input ruleset-tags.json
```

Payload (`ruleset-tags.json`):

```json
{
  "name": "protect-release-tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always" }
  ],
  "conditions": {
    "ref_name": { "include": ["refs/tags/v*"], "exclude": [] }
  },
  "rules": [
    { "type": "creation" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
```

Actor id 5 is the built-in repository admin role; on this personal repository the only admin is `anishbenji`. `creation` restricts who may create a matching tag, so only the bypass actor can; `deletion` and `non_fast_forward` apply to everyone else, and the admin bypasses them too.

State after (`gh api repos/anishbenji/tscache/rulesets/26846390`, fields reduced):

```json
{
  "id": 26846390,
  "name": "protect-release-tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "conditions": { "ref_name": { "exclude": [], "include": ["refs/tags/v*"] } },
  "rules": [
    { "type": "creation" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ],
  "current_user_can_bypass": "always",
  "created_at": "2026-11-09T16:36:31.460+05:30"
}
```

`gh api repos/anishbenji/tscache/rulesets` now lists `protect-main` (24496690) and `protect-release-tags` (26846390). `protect-main` read back byte-identical to its state before.

Undo:

```sh
gh api --method DELETE repos/anishbenji/tscache/rulesets/26846390
```

### 1a. Ruleset `protect-release-tags`: add the `update` rule (pre-review finding 5)

`non_fast_forward` still allows a fast-forward move of a `v*` tag, so the `update` rule was added, which blocks any update to an existing matching tag for everyone outside the bypass list. This stays within the 2026-11-09 grant for a ruleset protecting `v*` tags; nothing else in the ruleset changed.

State before (`gh api repos/anishbenji/tscache/rulesets/26846390`, fields reduced): as in the state after of section 1, rules `creation`, `deletion`, `non_fast_forward`, `updated_at` `2026-11-09T16:36:31.527+05:30`.

Command:

```sh
gh api --method PUT repos/anishbenji/tscache/rulesets/26846390 --input ruleset-tags-r2.json
```

Payload (`ruleset-tags-r2.json`; a PUT with only `rules` replaces the rule list and leaves the other fields as they were):

```json
{
  "rules": [
    { "type": "creation" },
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
```

State after (same command, fields reduced):

```json
{
  "name": "protect-release-tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "conditions": { "ref_name": { "exclude": [], "include": ["refs/tags/v*"] } },
  "rules": [
    { "type": "creation" },
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "update" }
  ],
  "updated_at": "2026-11-09T16:48:30.875+05:30"
}
```

The ruleset now blocks creating, updating (fast-forward or not) and deleting a `v*` tag for everyone except the repository admin role, which bypasses it always. `protect-main` read back byte-identical again.

Undo (back to the state of section 1):

```sh
gh api --method PUT repos/anishbenji/tscache/rulesets/26846390 --input - <<'EOF'
{ "rules": [{ "type": "creation" }, { "type": "deletion" }, { "type": "non_fast_forward" }] }
EOF
```

### 2. Environment `npm-publish`

Commands:

```sh
gh api --method PUT repos/anishbenji/tscache/environments/npm-publish --input env.json
gh api --method POST repos/anishbenji/tscache/environments/npm-publish/deployment-branch-policies --input env-policy.json
```

Payloads:

```json
{
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
```

```json
{ "name": "v*", "type": "tag" }
```

No required reviewers, no wait timer, no secrets and no variables were set.

State after:

```sh
gh api repos/anishbenji/tscache/environments/npm-publish
gh api repos/anishbenji/tscache/environments/npm-publish/deployment-branch-policies
gh api repos/anishbenji/tscache/environments/npm-publish/secrets
gh api repos/anishbenji/tscache/environments/npm-publish/variables
```

```json
{
  "name": "npm-publish",
  "protection_rules": [{ "id": 71801380, "type": "branch_policy" }],
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  },
  "can_admins_bypass": true,
  "created_at": "2026-11-09T11:06:39Z"
}
```

```json
{
  "total_count": 1,
  "branch_policies": [{ "id": 66037048, "name": "v*", "type": "tag" }]
}
```

Secrets: `{"total_count":0,"secrets":[]}`. Variables: `{"variables":[],"total_count":0}`.

`can_admins_bypass: true` is GitHub's default; it lets an admin bypass required reviewers, of which there are none. The deployment ref policy itself is not bypassed by it.

Undo:

```sh
# Remove the tag policy only:
gh api --method DELETE repos/anishbenji/tscache/environments/npm-publish/deployment-branch-policies/66037048
# Or remove the environment entirely:
gh api --method DELETE repos/anishbenji/tscache/environments/npm-publish
```

Deleting the environment breaks the npm trusted publisher, which names it, until it is recreated with the same name.

### Not changed

Branch protection for `main` (`protect-main`, verified unchanged), GitHub Pages (step 65), repository secrets, Actions settings, and every other setting.

## CI

`~/code/tscache-reports/bin/heavy-run.sh "66 child: ci" bun run ci` on the final head: see the step report.

## Not verified

- The Scorecard workflow has not run: it triggers on push to `main` or on its schedule, neither of which happens before merge. The badge shows no score until the first run on `main` publishes one.
- No linter for workflow files (actionlint, zizmor) is installed here, and adding one is a dependency decision. The workflow was parsed as YAML and checked by reading against the action's restrictions.
- The tag ruleset was not exercised by pushing a tag (the brief forbids creating `v*` tags).
- The npm-side items of the checklist (two-factor authentication, trusted publisher, no tokens on the account) are read on npmjs.com by the maintainer; no agent can see them.

## Pre-review (director, before Codex)

Five P2 findings, all validated by the director and all accepted.

| #   | Finding                                                                                                                     | Resolution                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The checklist's token grep matches the page itself, and after step 64 `release.yml` and its review file                     | 6212b19: the grep skips `docs/` and matches only a credential in use. On this branch (6212b19) and on `ci/64-release-workflow` (3150930) it prints nothing and exits 1; on test files holding an `.npmrc` line, an `env:` assignment and an `export` it reports all three, and it skips a comment that only names the variable. |
| 2   | The checklist says only the publish job holds `id-token: write`; Scorecard's job holds it too, and step 64's job is `stage` | 6212b19: the item names release.yml's `stage` job as the only user of `npm-publish`, and Scorecard's `analysis` job as the one other holder of `id-token: write`, with a grep and its expected output.                                                                                                                          |
| 3   | `actions: read` is not needed on a public repository                                                                        | b17616c: dropped; the comment and this file's reasoning updated.                                                                                                                                                                                                                                                                |
| 4   | `branch_protection_rule` never fires on a repository that uses rulesets                                                     | b17616c: trigger dropped.                                                                                                                                                                                                                                                                                                       |
| 5   | `non_fast_forward` still lets a `v*` tag move forward                                                                       | `update` rule added to ruleset 26846390 (section 1a); the checklist's chain and ruleset item state what it enforces, including the admin role's permanent bypass.                                                                                                                                                               |

## Decision concerns

None.
