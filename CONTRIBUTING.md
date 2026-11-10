# Contributing to tscache

Thank you for helping. This page is the short version; the details live in
[`site/contributing.md`](site/contributing.md) (the architecture map for
contributors) and [`docs/workflow.md`](docs/workflow.md) (how each change is
built, tested and reviewed). The normative design is
[`docs/architecture.md`](docs/architecture.md); its locked decisions are not
reopened in a pull request without discussion in an issue first.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node 22.12 or later, [Bun](https://bun.sh) and
[gitleaks](https://github.com/gitleaks/gitleaks) on your `PATH`.

```sh
bun install                        # installs the workspace dependencies
bunx lefthook install              # installs the git hooks
bun run build                      # builds the package into packages/tscache/dist
bunx playwright install chromium   # once, for the browser tests
```

## Checks

```sh
bun run test       # Vitest, under Node
bun run typecheck  # tsc on every project
bun run check      # Biome lint and format
bun run ci         # the full gate that GitHub Actions runs
```

**Never run `bun test`.** It starts Bun's own test runner, not Vitest, and the
suite does not run under it. Use `bun run test` or `bunx vitest run`.

Tests follow [`docs/testing.md`](docs/testing.md): no wall clock, no sleeps, no
timing assertions and no retries.

## Commits and pull requests

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/),
  and the subject starts with a lowercase word, for example
  `fix(engine): keep the watermark when a put is empty`. Commitlint checks this
  in the `commit-msg` hook and again in CI.
- Keep commits small, and keep the repository green after each one.
- Do not bypass the git hooks (`--no-verify`, `LEFTHOOK=0`); if a hook fails,
  fix the cause.
- Adding or upgrading a dependency is a decision: open an issue first.
- Open the pull request against `main` and fill in its template. It merges once
  the `ci` check passes and the maintainer approves.

## Reporting problems

Bugs and feature requests go through the issue forms. For questions, see
[`SUPPORT.md`](SUPPORT.md). Security problems are reported privately, as
described in [`SECURITY.md`](SECURITY.md).
