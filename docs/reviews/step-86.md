# Step 86 — Development-tooling security updates within the declared ranges

Branch: `chore/86-audit-fix` · Reviewer: GPT-6.1 Sol (high) · Rounds: pending · Status: in review · Verdict after triage: pending

## Scope

The user chose option A of decision 53 on 2026-11-13: upgrade the packages that `bun audit` flags, within the declared ranges only. The lockfile changes; no `package.json` does. Every advisory is in development tooling (commitlint's config loader and the documentation site); the published `tscache` package has no runtime dependencies, so nothing it ships changes.

| Commit (by subject)                                            | What                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| `chore(deps): update fast-uri and js-yaml within their ranges` | `bun audit fix` (no `--latest`); `bun.lock` only.        |
| `docs(review): step 86 scope and verification`                 | This file, and the review-file count in `docs/INDEX.md`. |

### Resolved versions changed

From the lockfile diff; no other entry moved.

| Package    | Old   | New   | Reached through                                                                 |
| ---------- | ----- | ----- | ------------------------------------------------------------------------------- |
| `fast-uri` | 3.1.2 | 3.1.9 | `@commitlint/cli` → `@commitlint/load` → `@commitlint/config-validator` → `ajv` |
| `js-yaml`  | 4.2.0 | 4.3.2 | `@commitlint/cli` → `@commitlint/load` → `cosmiconfig`                          |

### Advisories before and after

`bun audit` (Bun 1.4.2) on main `fa9e5e4`: 16 advisories, 10 high, 3 moderate, 3 low. After the update: 2, 1 moderate and 1 low.

| Package            | Severity | Advisory                                                                                                                                                                           | After     |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `fast-uri` 3.1.2   | high     | GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp, GHSA-7p8r-x3mc-p8w7, GHSA-v2hh-gcrm-f6hx, GHSA-4c8g-83qw-93j6, GHSA-qw65-cvwx-89v3 (each fixed in 3.1.7 or earlier) | fixed     |
| `fast-uri` 3.1.2   | moderate | GHSA-hrr3-gc8f-f4qj (fixed in 3.1.8), GHSA-w74x-v6f9-j3xg (fixed in 3.1.9)                                                                                                         | fixed     |
| `fast-uri` 3.1.2   | low      | GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp (fixed in 3.1.9)                                                                                                                          | fixed     |
| `js-yaml` 4.2.0    | high     | GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh (fixed in 4.3.2)                                                                                                     | fixed     |
| `katex` 0.16.47    | low      | GHSA-238p-pmpm-9mq7 (fixed in 0.18.2)                                                                                                                                              | remaining |
| `minimatch` 10.2.6 | moderate | GHSA-g3hv-75wg-m249 (fixed in 11.0.1)                                                                                                                                              | remaining |

### Remaining advisories

Both are in the documentation site (`@tscache/site`), are blocked by a parent's declared range, and are left for the user's decision; nothing was changed for them.

| Package            | Blocked by                                                                                      | Range change that would fix it                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `katex` 0.16.47    | `mermaid` 11.17.2 depends on `katex@^0.16.47`; `site/package.json` pins `mermaid` to 11.17.2    | Move `mermaid` in `site/package.json` to 12.2.0 or later (the first release that depends on `katex@^0.18.0`; 12.3.0 is the latest), a major upgrade; or override `katex` to 0.18.2 at the root, outside the range `mermaid` 11 declares.                   |
| `minimatch` 10.2.6 | `typedoc` 0.28.20 depends on `minimatch@^10.2.5`; `site/package.json` pins `typedoc` to 0.28.20 | No stable `typedoc` release accepts `minimatch` 11 (0.28.20 is the latest stable; only 1.0.0 prereleases exist). The fix needs an override of `minimatch` to 11.0.1 at the root, outside the range `typedoc` declares, or waiting for a `typedoc` release. |

Notes on the two tables, from the pre-review:

- The three `js-yaml` advisories are fixed in 4.3.0, 4.3.1 and 4.3.2 respectively (`bun audit --json` on main); 4.3.2 clears all three.
- The `mermaid` 12 route for `katex` also needs `vitepress-plugin-mermaid`: `site/package.json` pins it at 2.0.17, its latest release, whose peer range is `mermaid: "10 || 11"`. Moving `mermaid` to 12 would therefore violate that peer range until the plugin ships a release that accepts 12.

## Verification

The first full `bun run ci` on 21f0303 exited 1: six tests timed out at 5 s in `cache-model-property.test.ts` and `cache-faults-property.test.ts` (step 74), with no assertion failure, at a load average of about 17. The two files passed alone (16 of 16), and the second full run on the same head exited 0. The packages this step moves are used only by commitlint. The timeouts are addressed separately in step 88.

| Command                                                                               | Result                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bun audit` on main                                                                   | 16 vulnerabilities (10 high, 3 moderate, 3 low), exit 1.                                                            |
| `bun audit fix`                                                                       | Fixed 14 vulnerabilities in 2 packages; reported `katex` and `minimatch` as blocked by a dependent's range; exit 0. |
| `git diff --name-only`                                                                | `bun.lock` only.                                                                                                    |
| `bun audit` after                                                                     | 2 vulnerabilities (1 moderate, 1 low), exit 1.                                                                      |
| `bun install --frozen-lockfile`                                                       | No changes, exit 0.                                                                                                 |
| `npm view mermaid@<v> dependencies.katex`, `npm view typedoc versions`                | The ranges in the table above.                                                                                      |
| `~/code/tscache-reports/bin/heavy-run.sh "86 child: ci" bun run ci` on the final head | Exit 0.                                                                                                             |

## Pre-review (Fable), not the gate

One P2 (the `mermaid` 12 route also breaks the `vitepress-plugin-mermaid` peer range) and two nits (the `js-yaml` fix versions; the header fields); all fixed in `docs(review): step 86 pre-review fixes`.

## Security lane (Claude), not the gate

run 1, head cfc6d67: P0 0, P1 0, P2 0
