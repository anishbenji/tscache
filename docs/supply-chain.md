# Supply-chain hardening

What protects the path from a commit on `main` to a version on npm, and how to check that each protection is still in place. Run through the checklist before every release and after any change to the repository settings, the npm package settings or the workflows.

The release flow itself (the placeholder bootstrap, cutting a release, approving a staged version) is in `docs/releasing.md`.

## The chain

1. A change reaches `main` only through a pull request that passes the `ci` check (ruleset `protect-main`).
2. The maintainer creates a `v*` tag. Only a repository admin may create one, and no one may delete or force-move one (ruleset `protect-release-tags`).
3. The tag starts `release.yml`. Its publish job runs in the environment `npm-publish`, which accepts deployments from `v*` tags only, and it holds `id-token: write` so it can exchange the GitHub OIDC token with npm.
4. npm's trusted publisher for `@anishbenji/tscache` accepts that token only from this repository, `release.yml` and the `npm-publish` environment, and allows only `npm stage publish`. The job stages the version with provenance; nothing is live yet.
5. The maintainer approves the staged version on npmjs.com or with `npm stage approve`, which asks for the security key. Approval is the final human gate.

No step uses an npm token.

## Checklist

### npm account and package

- [ ] Two-factor authentication is on for the `anishbenji` account, with a security key, and npm asks for it on every write (publish, approve, settings, dist-tags, owners). Check at npmjs.com → Account → Two-Factor Authentication.
- [ ] The package's publishing access requires two-factor authentication and disallows tokens. Check at npmjs.com → `@anishbenji/tscache` → Settings → Publishing access.
- [ ] The package has exactly one trusted publisher: GitHub Actions, repository `anishbenji/tscache`, workflow `release.yml`, environment `npm-publish`, allowed to run `npm stage publish` only (`npm publish` and `npm dist-tag` not allowed).
- [ ] The maintainers list holds `anishbenji` only.
- [ ] The account has no access tokens (npmjs.com → Access Tokens lists none). If one is ever created for a manual task, revoke it the same day.

### Tokens and secrets

- [ ] No npm token exists anywhere: not in repository, environment or organisation secrets, not in a workflow, not in an `.npmrc` in the repository.

  ```sh
  gh secret list --repo anishbenji/tscache
  gh secret list --repo anishbenji/tscache --env npm-publish
  git grep -n -i -e '_authToken' -e 'NPM_TOKEN' -e 'NODE_AUTH_TOKEN'
  ```

  Each command prints nothing.

- [ ] Gitleaks runs on every commit (pre-commit hook) and again over the whole branch in `bun run ci`.

### Release tags

- [ ] The ruleset `protect-release-tags` is active, targets `refs/tags/v*`, blocks creation, deletion and non-fast-forward updates, and lists only the repository admin role as a bypass actor.

  ```sh
  gh api repos/anishbenji/tscache/rulesets \
    --jq '.[] | select(.name == "protect-release-tags") | .id' |
    xargs -I{} gh api repos/anishbenji/tscache/rulesets/{} \
    --jq '{enforcement, bypass_actors, conditions, rules: [.rules[].type]}'
  ```

  Expected: `enforcement` is `active`, `bypass_actors` holds one entry (`RepositoryRole`, id 5, `always`), the include list is `["refs/tags/v*"]`, and the rules are `creation`, `deletion` and `non_fast_forward`.

### The `npm-publish` environment

- [ ] The environment accepts deployments only from refs matching the tag pattern `v*`: no branch policy, and protected branches off.

  ```sh
  gh api repos/anishbenji/tscache/environments/npm-publish \
    --jq '.deployment_branch_policy'
  gh api repos/anishbenji/tscache/environments/npm-publish/deployment-branch-policies \
    --jq '.branch_policies[] | {name, type}'
  ```

  Expected: `{"custom_branch_policies":true,"protected_branches":false}`, then one policy, `{"name":"v*","type":"tag"}`.

- [ ] The environment holds no secrets and no variables. A required reviewer is optional; the npm approval step is already a human gate.
- [ ] Only the publish job of `release.yml` names the environment, and only that job holds `id-token: write`.

### Workflows

- [ ] Every workflow sets top-level `permissions` to read-only or `{}`, and each job asks only for what it needs.
- [ ] Every third-party action is pinned to a full commit SHA, with its version in a comment. Dependabot proposes updates monthly; each one is reviewed by hand.
- [ ] No workflow runs on `pull_request_target` or `workflow_run`, and none interpolates untrusted event fields (pull request titles, branch names, commit messages) into a `run:` script.
- [ ] Checkouts set `persist-credentials: false` unless a later step must push.

### Branch protection for `main`

Review the ruleset `protect-main` against this list; a change to it is a decision for the maintainer.

```sh
gh api repos/anishbenji/tscache/rulesets \
  --jq '.[] | select(.name == "protect-main") | .id' |
  xargs -I{} gh api repos/anishbenji/tscache/rulesets/{} \
  --jq '{enforcement, bypass_actors, conditions, rules}'
```

- [ ] Enforcement is `active`, the target is the default branch, and the bypass list is empty, so the admin also goes through a pull request.
- [ ] Deletion and non-fast-forward updates are blocked.
- [ ] A pull request is required, review threads must be resolved, and the only merge method is a merge commit.
- [ ] The `ci` status check is required. Whether `bench` should be required too is an open decision for the maintainer.
- [ ] No classic branch protection rule overlaps the ruleset (`gh api repos/anishbenji/tscache/branches/main/protection` returns 404).

### OpenSSF Scorecard

- [ ] `.github/workflows/scorecard.yml` ran on the latest push to `main` and succeeded.
- [ ] The README badge shows a current score; the full report is at <https://scorecard.dev/viewer/?uri=github.com/anishbenji/tscache>.
- [ ] The code scanning alerts from Scorecard (Security → Code scanning, tool "Scorecard") are each fixed or dismissed with a reason. A score below its previous value is investigated before the release.

## Undoing a setting

The tag ruleset and the environment were created by the agents under the maintainer's decision of 2026-11-09. `docs/reviews/step-66.md` records the exact commands, the payloads, the state before and after, and how to remove each one.
