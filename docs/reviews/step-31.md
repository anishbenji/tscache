# Fix 31 — Reads and catch-ups end on the bar forming now

Branch: `fix/31-readrange-catchup-midbar` · Reviewer: pending (the director runs the review) · Status: implemented, not yet reviewed

The follow-up recorded in fix 26. The reference clients ended two kinds of read at `Date.now()`, between grid points: `readRange` clamped a read's end to now, and the live feed's catch-up (`onOpened`) read up to now. The cache snaps an unaligned end outward to the next grid point (architecture §8, N1), a bar that cannot exist yet. When a minute boundary passed between the read before the catch-up (the page's first read, or the server's render) and the catch-up itself, the catch-up fetched three minutes: the bar before (the flank into coverage), the bar that closed, the bar forming and the one after it. The reference spec bounds those fetches at two minutes, so `e2e/reference/clients.spec.ts` (the server-rendered test, formerly line 224) failed whenever the boundary fell in that window. Done by a child agent while the user was away, under the user's grant of 2026-10-30.

## Root cause

The same as fix 26's, in the two reads it left: a range ending at now instead of at the start of the bar forming now. Fix 26 fixed `polling()` only.

The test at the former line 273 ("switching the chart library after scrolling keeps the time on screen") shares the two-minute bound but not the cause: it compares positions on screen, which no read's end moves. It has a separate wall-clock dependence (it parses the year from the test's clock, which fails between 00:00 and 06:00 UTC on 1 January), fixed in chore 28.

## Scope

| Commit | What |
|---|---|
| fcf914e | `fix(reference)`: `formingBar(now, config = market)` in `market.ts` gives the start of the bar forming at a time on the grid. `readRange` ends there at the latest, so the server renders and a scroll near now end on the grid; the feed's catch-up reads up to `formingBar(Date.now())`; `polling()` uses the same helper. Tests below |
| d443a24 | `test(e2e)`: the new server-rendered test first has the server render once (see "Found while verifying") |

## Tests

- `reference/shared/test/range.test.ts`: `readRange` ends at the start of the bar forming now for any `now` in that bar, and `formingBar` honours `alignmentOffset`. Five tests failed before the fix, all pass after.
- Two Playwright tests in `e2e/reference/clients.spec.ts`, for each of the three clients. Each holds the event stream back with `page.route`, pins the page's clock with `page.clock.setFixedTime` halfway through the bar after the one the first read ended in, then releases the stream, so the boundary passes on every run:
  - "the server-rendered page fetches only the newest bars when a minute passes before its feed opens": the clock is pinned from the served range's end, read from the page.
  - "a page whose feed opens a minute after its first read fetches only the newest bars": the mock backend's clock is first moved a second into a bar (`advanceMs`, undone by `resetClock` in `afterEach`), so its forming bar cannot change while the page reads.
  - Their assertion is the spec's existing one: every fetch spans at most two minutes.

## Evidence

All Playwright runs used `E2E_EXAMPLES=reference-vanilla,reference-react,reference-solid` and ran under the machine's heavy-job lock.

| Run | Command | Result |
|---|---|---|
| Before the fix, server-rendered test | `bunx playwright test e2e/reference/clients.spec.ts --project examples -g "minute passes before its feed opens" --repeat-each 3` | 9 of 9 failed: a fetch of 180 000 ms against 120 000 |
| Before the fix, catch-up test | `… -g "feed opens a minute after" --repeat-each 5 --workers 1` | 15 of 15 failed, same span |
| After the fix, both | `… -g "minute passes before its feed opens\|feed opens a minute after" --repeat-each 5 --workers 1` | 30 of 30 passed |
| After the fix, the whole spec | `bunx playwright test e2e/reference/clients.spec.ts --project examples` | 59 of 59 passed |
| Stress, after the fix | `stress-load.sh bash -c 'bunx playwright test e2e/reference/clients.spec.ts --project examples --repeat-each 5 --workers 1 --grep-invert "shows the server.s read and fetches only the forming bar"'` (a `yes` per core, ten cores) | 280 of 280 passed in 17.1 min |

`bunx vitest run reference/shared`: 14 passed. `tsc -p reference/shared`, `tsc -p e2e` and Biome clean. `bun run ci` (under the heavy-job lock) passed on d443a24 and again on this file's commit: 1511 Vitest tests, 107 Playwright tests, sizes and both bench smokes.

## Found while verifying

- **Parallel copies under `--repeat-each`.** Without `--workers 1`, copies of a test ran side by side against one app's mock backend and its clock, so one copy's `advanceMs` moved the other's backend too: one run of nine passed before the fix that way. A test-harness effect, not a client one; chore 28 records it and its flake-hunt script repeats with one worker.
- **The server's cache after a restatement.** The stress run (`/tmp/…/stress-load.sh bash -c 'bunx playwright test e2e/reference/clients.spec.ts --project examples --repeat-each 5 --workers 1'`, a `yes` per core) failed the *existing* server-rendered test on repeats 1 and 3 of each client, 6 of 15, with a fetch of almost twelve hours. Cause: the app's server keeps one in-process cache across tests; after a test bumps the dataset version, the next render finds the new version only while reading, clears its cache (by design, N29) and serves almost nothing, so the page fetches everything. In a single run that test comes before any version bump, so it never failed in CI. It is a shared-state flake of the test, not of this fix, and chore 28 fixes it. The new server-rendered test here first has the server render once, so it does not depend on test order. In the same stress run every other test passed, the new ones included, wherever serial mode let them run (82 tests did not run after the failures). The stress run in the table leaves that one test out and covers the rest of the spec, five times each.

## Round 1 — reviewer verdict: pending

## Contract-test changes

None. `range.test.ts`'s expected ends changed from now to the start of the bar forming now: that is the behaviour this fix changes, not a contract test.

## Decision concerns

None.
