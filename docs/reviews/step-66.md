# Step 66 — Supply-chain hardening

Branch: `ci/66-supply-chain` · Status: built, awaiting review

The step adds an OpenSSF Scorecard workflow and its badge, a hardening checklist (`docs/supply-chain.md`), and two repository settings: a ruleset protecting the `v*` release tags and the `npm-publish` environment. The settings were applied with `gh api` on 2026-11-09 under the user's decision of that day that agents may make these changes and record each one in the pull request. No other setting was changed.

## Scope

| Commit  | What                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4daddb0 | `ci`: `.github/workflows/scorecard.yml` and the Scorecard badge at the top of `README.md`.                                                          |
| fee9973 | `docs`: `docs/supply-chain.md`, the hardening checklist. It is a new page because `docs/releasing.md` belongs to step 64, which has not merged yet. |

`ci.yml` and `release.yml` are not touched (step 64 owns them).

## The Scorecard workflow

Triggers: push to `main`, weekly (Mondays 03:17 UTC) and `branch_protection_rule`. The workflow-level permissions are `{}`; the single job `analysis` holds:

| Permission               | Why                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `contents: read`         | Check out the repository and read it for the checks.                                                    |
| `actions: read`          | Read Actions data that some checks query; listed in the action's documentation.                         |
| `security-events: write` | Upload the SARIF results to code scanning.                                                              |
| `id-token: write`        | Sign the published results with the GitHub OIDC token (`publish_results: true`). No other job holds it. |

The job follows the Scorecard API's workflow restrictions: no top-level `env` or `defaults`, no workflow-level write permission, an Ubuntu hosted runner, and only the approved actions. The issues, pull-requests and checks reads the action's README suggests are for private repositories; this repository is public, so they are left out.

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

- The Scorecard workflow has not run: it triggers on push to `main`, a schedule or a branch-protection change, none of which happens before merge. The badge shows no score until the first run on `main` publishes one.
- No linter for workflow files (actionlint, zizmor) is installed here, and adding one is a dependency decision. The workflow was parsed as YAML and checked by reading against the action's restrictions.
- The tag ruleset was not exercised by pushing a tag (the brief forbids creating `v*` tags).
- The npm-side items of the checklist (two-factor authentication, trusted publisher, no tokens on the account) are read on npmjs.com by the maintainer; no agent can see them.

## Decision concerns

- The ruleset follows the brief: creation restricted, deletion and non-fast-forward blocked. GitHub also offers an `update` rule, which blocks any update to an existing matching tag. Whether `non_fast_forward` alone stops every way of moving a tag to another commit is worth confirming; adding `update` is a one-line change to the ruleset if the user wants it.
