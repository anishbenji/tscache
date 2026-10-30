# Chore 25 — Playwright ports per checkout

Branch: `chore/25-e2e-ports` · Reviewer: Codex (high) · Status: in review

Outside CI, Playwright reuses a server it finds on its port (`reuseExistingServer: !process.env.CI`), and every port of the suite was fixed. Two checkouts on one machine running the suite at once therefore shared the e2e server, the example servers and their mock backends: one run could test the other checkout's build and see its backend state, and pass or fail for the wrong reason. Agents now run several worktrees at once (step 22 and chores 23 and 24 did), so this is a verification hazard. Chosen by Claude while the user was away, under the user's grant of 2026-10-30. Tooling only.

## Scope

| Commit | What |
|---|---|
| 15da738 | `chore(e2e)`: `portOffset()` in `e2e/examples/apps.ts`: a hash of the checkout's path picks an offset in steps of 1000, below the ephemeral range; `E2E_PORT_OFFSET` overrides it, CI uses none. `appPort()`, `serverPort`, and `appUrl()` carry it; `playwright.config.ts` passes `E2E_PORT` to `scripts/e2e-server.ts`. `e2e/tsconfig.json` gets Bun's type definitions for the Node side |
| 5f47460 | `chore(e2e)`: hashed offsets are never 0, which CI and a checkout without offsets use; an empty `E2E_PORT_OFFSET` counts as unset |

## Decisions made in the step

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | Offset from a hash of the checkout's path, 1 to 39 thousand | Automatic: an agent starting a worktree need not remember a variable. Below 49152 for every port (the highest is 5203 + 39 000). One pair of checkouts in 39 still collides | An explicit variable only; `reuseExistingServer: false` (a second run then fails on the busy port instead of sharing it, and local reruns lose the reuse) |
| D2 | Bun's type definitions for `e2e/`, as for the scripts | The specs' Node side needs `process` and `node:crypto`; `@types/node` is not a direct dependency | Computing the offset in `playwright.config.ts` and passing it to the workers through the environment (the specs still read `process.env`) |

## Verification

- `bun run typecheck` passes.
- Offsets: this worktree 33 000, `/private/tmp/tscache-ports2` 10 000, the main checkout 24 000; 5 000 sample paths all in 1 000–39 000.
- The full Playwright suite ran in this worktree and a second checkout of the branch at the same time: 101 passed in each, on 9173/10201 and 4173/5201 (before 5f47460 the second hashed to 0).
- After 5f47460: the reference and dedup specs in three checkouts at once (this branch twice, the main checkout without the change) listened on 37173/38201, 14173/15201 and 4173/5201, with no shared server. The polling assertion at `e2e/reference/clients.spec.ts:556` still failed in two of the three runs, on their own ports. So the ports were not the cause of step 22's R2-1, as its triage assumed. Fix 26 found the real cause (a poll crossing a minute boundary fetched one slot too many), and step 22's review file now records the correction. This chore stands on its own: a checkout must not test another checkout's servers.

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | No test covers the offset's CI precedence, override bounds, invalid values, empty or unset values, or nonzero hashes; a regression to 0 would pass CI, which uses 0 | Accept. Valid: `portOffset` had no unit test | `e2e/examples/apps.test.ts` (run by Vitest; Playwright's projects skip it) covers each case. Writing it found a bug: `Number()` read `" "` as 0, and `"0x1"` and `"1e1"` as numbers, so a blank or hex override was accepted; the override is now digits only. A test that two sample paths get different offsets was dropped: the hash can collide by design (one pair in 39, D1), and those two did |
