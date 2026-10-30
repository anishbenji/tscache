# Fix 26 — Polls end on the bar forming now

Branch: `fix/26-polling-flake` · Reviewer: Codex (high) · Rounds: in progress · Status: under review

The Playwright test `e2e/reference/clients.spec.ts` "one tab polls, fetching only the newest bars, and the others draw without a fetch" failed intermittently: a polling fetch spanned 180 000 ms against the test's 120 000 ms bound. Step 22 (R2-1) first blamed concurrent CI in two checkouts sharing Playwright ports; chore 25 corrected that triage. Investigated by a delegate while the user was away, under the user's grant of 2026-10-30; accepted as a client bug (logged in the auto-approved decisions).

## Root cause

`polling()` in `reference/shared/src/live.ts` read from the previous poll's end to `Date.now()`. The cache snaps an unaligned range end outward to the next grid point (architecture §8, N1), so every poll asked for one bar that cannot exist yet. A poll whose window crossed a minute boundary was snapped at both ends and fetched three minutes, beyond the test's two-minute bound. The test's polling window lasts about 6 s, so it failed whenever that window held a minute boundary (about 10 % of runs), independent of machine load.

## Scope

| Commit | What |
|---|---|
| c68f5f3 | `fix(reference)`: `polling(everyMs, config)` computes the start of the bar forming now from the market's `interval` and `alignmentOffset`, and both the first `since` and each poll's end use it, so both ends of every span lie on the grid. `startSession` passes the market config. Unit test with fake timers across a minute boundary: fails before the fix (the spans end at 59 000, 61 000 and 63 000, between grid points), passes after. The e2e assertion is unchanged |

## Evidence

- Diagnostic logging (not committed) showed polls ending at `Date.now()` (`23:46:35.131Z..23:46:37.133Z`) and the noticed fetch snapped to `23:45:00..23:47:00`.
- Before the fix: the polling test failed 3 of 30 runs under full CPU load (`yes` per core, three workers).
- After the fix: 60 of 60 passed under the same load; noticed fetches span one minute.
- `bun run ci` passed after the fix.

## Follow-up (separate fix)

`readRange` (end clamped to now) and `catchUp(Date.now())` in `reference/shared` also end reads mid-bar; two opening reads of three minutes were seen. The tests at `clients.spec.ts:224` and `:273` share the two-minute bound and could flake the same way. Next fix, test-first.
