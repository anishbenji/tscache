# Step 02 — Core types and config validation

Branch: `feat/02-core-types` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: in review · Verdict after triage: pending

The branch also carries the agent-workflow tooling (a865e55 onward). Findings are labelled by area.

## Round 1 — reviewer verdict: block

Run by hand with prompt C before `scripts/codex-review.sh` existed. `bun run ci` could not run in the read-only sandbox; the reviewer ran tsc, Biome, Knip, Fallow and Vitest (36/36) separately. The implementer's host run of `bun run ci` passed.

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P0 | Step ②: `alignmentOffset` restricted to `[0, interval)` without approval | accepted | Validated: architecture §2.2 and decision #3 define alignment only as `(t - alignmentOffset) % interval === 0`, and `-1000` with interval 60 000 aligns t = 59 000. Any safe-integer offset is now accepted and normalized into `[0, interval)` (same grid, so equivalent configs resolve identically). Integers remain required because timestamps are exact integers (S§3.1). Fixed in cb4fb92. |
| R1-2 | P1 | Step ②: `AuthInvalidError.code` typed `string`, not the literal | accepted | Validated with a type-level test that failed under tsc. Tests were not type-checked at all, so 33f7440 adds `test/` to the package tsconfig. e76269c types `code` and `AUTH_INVALID_CODE` as `'tscache:auth-invalid'` (architecture §2.6); the constant needed an annotation because an unannotated `const` widens to `string` through generic inference. |
| R1-3 | P1 | Tooling: guard misses `bun test` after a newline | accepted | Reproduced with the new regression cases in `.claude/hooks/guard-bash.test.sh`, now run by `bun run ci`. Fixed in 6968b72. |
| R1-4 | P2 | Tooling: guard blocks harmless mentions of hook-bypass flags | accepted in part | Reproduced: the guard blocked a grep for the rule. 6968b72 moved bypass matching to command position, which a security review showed let `sudo`, `env`, absolute git paths and `bash -c` hide the flags. 53740ce restores match-anywhere and exempts only commands that never invoke git. A git commit whose message mentions a bypass flag stays blocked: telling a message from a real flag needs shell parsing, and the guard fails closed (AGENTS.md: never bypass git hooks). |

## Contract-test changes

None. Step ② is not an engine-logic step; its tests are implementer-written.

## Decision concerns

None.
