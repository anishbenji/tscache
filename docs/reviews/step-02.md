# Step 02 — Core types and config validation

Branch: `feat/02-core-types` · Reviewer: GPT-6.1 Sol (high) · Rounds: 4 · Status: settled (guard closed by user decision at the round cap) · Verdict after triage: merge

The branch also carries the agent-workflow tooling (a865e55 onward). Findings are labelled by area.

## Merge request

### Summary

Step ② of the commit plan: the public type surface (architecture §2), the error taxonomy (§2.6) and `CacheConfig` validation with documented defaults (§2.2, decisions #2–#4). Nothing consumes `resolveCacheConfig` yet; the engine arrives in steps ③–⑧. The branch also lands the agent workflow: review checklist, automated Codex review loop, Bash guard hook and Fallow pinning. Under the branch rule added in 2836be8 that tooling would go on its own `chore/` branch; it predates the rule and is merged here as one unit, by choice.

### Commits

| Group | Commits |
|---|---|
| Step ② code | a58cc2f types and errors · a876b66 config validation · e76269c literal auth marker · cb4fb92, df74084 alignment offset · 7afd517 non-object config · 33f7440, 1396ac1 test hygiene |
| Agent workflow | a865e55 workflow, checklist, Claude/Codex config · 719ad5f Fallow pin · e371c71 review script · 2ed571a, 2836be8, e4e7add docs |
| Bash guard | 6968b72, 53740ce, 0ec39f0, 1fc3198, 516947f, 291a9df |
| Triage | b744887, b6b72f5, d51de0d, this file |

### Review outcome

Four Codex rounds and two background security reviews raised 16 findings, all accepted and fixed (R1-4 first in part, fully by round 3). No rejections, no decision concerns. Step ② code drew 4 findings (2 P0, 2 P1), all fixed with tests. The guard drew findings in every round; at the cap the user chose to fix round 4's four and stop, documenting its known limits.

### Confidence

High for step ② code. Every validator branch has a test, the two P0s (alignment contract, precision near 2^53) are pinned by boundary tests, and the code has no consumers yet, so later steps exercise it again under contract tests. `bun run ci` passes on 291a9df: guard cases, Biome, tsc (now including tests), Knip, Fallow, Vitest 49/49, build, attw, publint, pack dry-run.

Medium for the guard, by design. It is a tripwire for accidents, not a security boundary, and its header lists what it cannot see (variable expansion, aliases, scripts on disk, tools that spawn git or bun, partial option tables). Git hooks themselves still run on every commit and push.

### Blast radius

- **Package consumers:** none. The package is unpublished (0.0.0). Public exports added: errors, `DTYPES` and types from `.`, and `AuthInvalidError`/`AUTH_INVALID_CODE` from `./fetcher`. `./engine` and `./worker` stay empty.
- **Later steps:** build on `ResolvedCacheConfig`. Its `alignmentOffset` is always in `[0, interval)`, which the slot-index math in step ③ can rely on.
- **Every Claude Bash call in this repo** passes through the guard. A false positive blocks a command (recover with a different phrasing or the Write/Edit tools); a crash blocks every Bash call (fail closed) until the guard is fixed with Write/Edit or the hook is removed from `.claude/settings.json`.
- **CI and hooks:** `bun run ci` gains the guard suite; `tsc` now type-checks `test/`; Lefthook and CI run the pinned Fallow.
- **Repository hygiene:** `test-results/` was tracked on `main` and is now gitignored (its stale `.last-run.json` is deleted); `.reviews/` holds raw review output and is gitignored.

### Test coverage

No coverage tool is installed (adding `@vitest/coverage-v8` would be a dependency decision). By inspection:

| Module | Covered | Not covered |
|---|---|---|
| `engine/validate.ts` | Defaults; explicit values; frozen result and defensive `fields` copy; every dtype; 30 rejection cases (each field, NaN, Infinity, unsafe integers, empty and array `fields`, non-object config); offset normalization incl. negative, over-interval, near 2^53 and `-0` | — |
| `errors.ts` | Hierarchy, `name`, `PutError` and `ProtocolMismatchError` fields, literal marker type, marker detection incl. a foreign class copy | Nothing constructs `PutError` yet (step ⑤) |
| `types.ts`, entries | Type-checked; build, attw and publint resolve every entry | No test pins the exact export list of `.` |
| Guard | 85 command cases plus a crash check, run in CI | Known limits above |

### Residual notes

- The built `./fetcher` entry imports a shared chunk holding all seven error classes (2.3 kB). N6's purpose holds — no DOM or client code — and `sideEffects: false` lets bundlers drop the unused classes, but an unbundled fetcher loads the whole chunk. Splitting `AuthInvalidError` into its own module would make the entry minimal; optional follow-up.
- `isAuthInvalidError` returns `boolean`, not a type guard; worth revisiting when the orchestrator (step ⑪) consumes it.

### Before merging

```sh
bun run ci
git switch main && git merge --no-ff feat/02-core-types
```

## Round 1 — reviewer verdict: block

Run by hand with prompt C before `scripts/codex-review.sh` existed. `bun run ci` could not run in the read-only sandbox; the reviewer ran tsc, Biome, Knip, Fallow and Vitest (36/36) separately. The implementer's host run of `bun run ci` passed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | Step ②: `alignmentOffset` restricted to `[0, interval)` without approval | accepted | Validated: architecture §2.2 and decision #3 define alignment only as `(t - alignmentOffset) % interval === 0`, and `-1000` with interval 60 000 aligns t = 59 000. Any safe-integer offset is now accepted and normalized into `[0, interval)` (same grid, so equivalent configs resolve identically). Integers remain required because timestamps are exact integers (S§3.1). Fixed in cb4fb92. |
| R1-2 | P1 | Step ②: `AuthInvalidError.code` typed `string`, not the literal | accepted | Validated with a type-level test that failed under tsc. Tests were not type-checked at all, so 33f7440 adds `test/` to the package tsconfig. e76269c types `code` and `AUTH_INVALID_CODE` as `'tscache:auth-invalid'` (architecture §2.6); the constant needed an annotation because an unannotated `const` widens to `string` through generic inference. |
| R1-3 | P1 | Tooling: guard misses `bun test` after a newline | accepted | Reproduced with the new regression cases in `.claude/hooks/guard-bash.test.sh`, now run by `bun run ci`. Fixed in 6968b72. |
| R1-4 | P2 | Tooling: guard blocks harmless mentions of hook-bypass flags | accepted in part | Reproduced: the guard blocked a grep for the rule. 6968b72 moved bypass matching to command position, which a security review showed let `sudo`, `env`, absolute git paths and `bash -c` hide the flags. 53740ce restores match-anywhere and exempts only commands that never invoke git. A git commit whose message mentions a bypass flag stays blocked: telling a message from a real flag needs shell parsing, and the guard fails closed (AGENTS.md: never bypass git hooks). |

## Security review (background, between rounds 1 and 2)

Claude Code's commit security review flagged the guard twice. Both were reviewed against the guard's purpose, a tripwire for the AGENTS.md hook rules.

| # | Finding | Decision | Resolution |
|---|---|---|---|
| S-1 | 6968b72: command-position matching lets wrappers (`sudo`, `env`, absolute git path, `bash -c`) hide hook-bypass flags | accepted | Fixed in 53740ce (see R1-4). |
| S-2 | Parser differentials: quote or backslash splicing, git's abbreviated long options, case-insensitive `core.hooksPath`, quoted Lefthook values | accepted | Fixed in 0ec39f0: matching runs on text with quotes and backslashes stripped and case folded; `--no-v…` prefixes, Lefthook exclude/skip/uninstall routes and wrapped or path-qualified test-runner calls are caught. The guard now states that it is a tripwire, not a security boundary — regexes cannot follow variables, `eval` or scripts on disk. |

## Round 2 — reviewer verdict: block

Via `scripts/codex-review.sh`; host `bun run ci` passed. The reviewer confirmed R1-2 and R1-3 fixed and R1-4's partial acceptance justified.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P0 | Step ②: R1-1 normalization loses precision near 2^53 (re-raises R1-1) | accepted | Reproduced: interval `Number.MAX_SAFE_INTEGER`, offset 2 resolved to 1. Now adds interval only to negative remainders, and turns a `-0` remainder into `0` (found while fixing). Boundary tests added. Fixed in df74084. |
| R2-2 | P2 | Tooling: guard blocks backticks inside a single-quoted commit message | accepted | Reproduced with a regression case. Backtick substitution is now checked on text with single-quoted spans removed. Fixed in 1fc3198. |

Also: 1396ac1 replaces Vitest's deprecated `toThrowError` with `toThrow` (no behaviour change).

## Round 3 — reviewer verdict: merge after fixes

Host `bun run ci` passed. The reviewer confirmed every earlier accepted finding fixed and re-raised no rejection. All three findings are further parser differentials in the guard, so instead of another regex patch the guard was rebuilt as a shell tokenizer (`.claude/hooks/guard-bash.ts`): quotes, escapes, `$'…'`, operators, heredocs, `$(…)` and backtick substitutions, `bash -c` and `eval` bodies, leading assignments and wrappers are resolved, and the rules apply to real argv. Unparseable input fails closed if it names a guarded tool, and a guard crash now blocks instead of allowing (Claude Code only blocks on exit 2). The regression file holds 61 command cases plus a crash check.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | Tooling: git global options (`-C`, `-c`) hide `commit -n` | accepted | Reproduced. Global options are skipped before the subcommand. Fixed in 516947f. |
| R3-2 | P1 | Tooling: a leading `VAR=value` hides the forbidden test runner | accepted | Reproduced. Leading assignments are consumed (and checked) before argv0. Fixed in 516947f. |
| R3-3 | P2 | Tooling: `(bun test)` inside a single-quoted message is blocked | accepted | Reproduced. Quoted text is now a word, never a command boundary; mentions of bypass flags inside commit messages and heredocs also pass now, which supersedes the strict-side note in R1-4. Fixed in 516947f. |

## Round 4 — reviewer verdict: merge after fixes

Host `bun run ci` passed. The reviewer confirmed the other accepted findings fixed. Round 4 hit both stop rules: the four-round cap, and the convergence check (the guard drew findings in every round). R4-4 is step ② code and was triaged normally. For the guard the user chose to fix the four validated findings and stop without a fifth round, recording the guard's known limits in its header.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R4-1 | P1 | Tooling: a leading redirection (`2>/dev/null git …`) hides guarded commands | accepted | Reproduced. Redirection targets and fd numbers are no longer argv; process substitution still parses. Fixed in 291a9df. |
| R4-2 | P1 | Tooling: ANSI-C escapes (`$'b\x75n' test`) hide the forbidden runner | accepted | Reproduced. `$'…'` is decoded as bash does (hex, unicode, octal, control and named escapes). Fixed in 291a9df. |
| R4-3 | P1 | Tooling: Bun global options (`bun --cwd x test`) hide the subcommand | accepted | Reproduced. Bun options and their values are skipped to find the subcommand. Fixed in 291a9df. |
| R4-4 | P1 | Step ②: null or undefined config throws `TypeError`, not `ConfigError` | accepted | Reproduced for null and undefined. Non-object configs, and arrays passed as `fields` (found while fixing; they were accepted as index-named fields), now throw `ConfigError` (architecture §2.6). Tests added. Fixed in 7afd517. |
| R4-5 | P2 | Tooling: a commit message mentioning a bypass flag is still blocked | accepted | Reproduced. Git checks now walk real options and skip option values, so a message is never read as a flag. Fixed in 291a9df. |

## Contract-test changes

None. Step ② is not an engine-logic step; its tests are implementer-written.

## Decision concerns

None.
