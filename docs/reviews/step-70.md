# Step 70 — The restated-history flake in the vanilla-uplot spec

Branch: `fix/70-restated-history-flake` · Status: built

## Scope

The scheduled `Flake hunt` workflow failed on `main` at 0e45a85 (GitHub Actions run 42621162595, 2026-11-09 12:56 UTC: 2 failed, 4 did not run, 809 passed). Both failures were the same test, `e2e/examples/vanilla-uplot.spec.ts:45` › "a restated history clears the cache and is fetched again". The four tests that did not run were the two later tests of the serial group after each failure. The fix changes only that test. No library, example or mock backend code changes.

| Commit  | What                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------ |
| 9e773d1 | `test(e2e)`: the restated-history test counts its notices before the click, not after the clear. |
| —       | `docs(review)`: this file.                                                                       |

## Root cause

Classification: (a), a defect in the test. The library and the example behave as the architecture specifies.

**What failed.** In the run's `playwright.log` (artifact `flake-hunt-logs`), repeats 1 and 3 failed at line 61, and repeats 0, 2 and 4 passed:

```
Error: expect(received).toBe(expected) // Object.is equality
Expected: true
Received: false
- Timeout 5000ms exceeded while waiting on the predicate
> 61 |     .toBe(true);
```

That is the poll for a fetch notice spanning at least nine minutes among the notices recorded after `before`.

**The race.** The test clicked "Restate history", waited for `cleared (version-mismatch)` in the page's log, and only then read `before`, the number of notices so far. The fetch whose answer carries the new version clears the cache inside its `put`, and the `get` that issued it then asks once more for everything the clear wiped (architecture §4.9, N29 as amended 2026-10-31). The `cacheCleared` event reaches the page at once. The refetch of the whole ten-minute window arrives one backend round trip (300 ms) later, as a notice on the BroadcastChannel. Playwright's `toContainText` checks again after 20, 50, 100 and 100 ms, then every 500 ms. So it can see the clear later than the refetch notice arrives. Then `before` already counts the refetch, `slice(before)` holds only tail fetches (each under a minute), and the poll times out. The test read its baseline after a signal that races the effect it was waiting for.

**Evidence.**

- Timing measured from the page (`performance.now()` in the page, 15 repeats under `--load` on the development machine). The refetch notice arrived 260 to 328 ms after the clear was logged. The test saw the clear 43 to 320 ms after it was logged. In the closest repeat the test saw the clear at +320 ms and the refetch arrived at +328 ms: an 8 ms margin, before counting the `notices()` round trip that reads `before`. A slower runner (the GitHub runner under `--load`) closes that margin.
- Deterministic reproduction: a scratch spec waited for the clear, then waited for the refetch notice before reading `before`, as a late observer does. It ran the old assertion and failed 15 of 15 repeats. The same late observation with the baseline read before the click passed 15 of 15. Command: `scripts/flake-hunt.sh -n 15 --load e2e/examples/restate-race.spec.ts` (45 tests executed: 15 failed, all the old variant; 30 passed). The scratch spec was not committed (see below).
- Natural reproduction rate before the fix, on the development machine: 0 failures in 20 repeats, `scripts/flake-hunt.sh -n 20 --load e2e/examples/vanilla-uplot.spec.ts` (80 passed, 4.7 min). On GitHub: 2 failures in 5 repeats (run 42621162595). The previous weekly run (41445274805, 2026-11-02) passed 5 of 5.

## Fix

The test now reads `before` after its first two notices and before the click. Every other example spec that counts notices around an action already takes the count before the action (`solid-uplot.spec.ts`, `solid-lwcharts.spec.ts`, `solid-ssr.spec.ts`, `reference/clients.spec.ts`).

This removes the cause rather than masking it. The refetch is caused by the click, so it cannot come before the count, whenever the test happens to see the clear. Before the click the cache holds the whole window and every poll fetches only the tail, under a minute (the first test of the spec asserts that), so any later notice spanning nine minutes is the refetch after the clear. The assertion, its bound and its timeout are unchanged, and the test still waits for the clear in the log first.

The reproduction does not stay as a regression test, against the usual practice in `docs/testing.md`. It pinned the failing order to show the race, and the fixed test no longer depends on that order. Kept as a test, it would only repeat the fixed assertion after an extra wait. The race is recorded here instead.

## Verification

- `scripts/flake-hunt.sh -n 30 --load e2e/examples/vanilla-uplot.spec.ts`, run through the heavy-job lock: 120 passed (7.1 min), 0 failures in 30 repeats of each of the spec's four tests.
- `bun run ci`, run through the heavy-job lock on the commit that adds this file, which is the branch head; its result is in the step's report to the director. `bun scripts/test-clocks.ts` alone: 147 files clean.
- `bunx biome check e2e/examples/vanilla-uplot.spec.ts`: clean.

## Not verified

- The fix on GitHub's runner. The next weekly `Flake hunt` run, or one dispatched with `files: e2e/examples/vanilla-uplot.spec.ts`, is that check.
- The natural failure rate before the fix on this machine: 0 in 20 repeats. The root cause rests on the measured timing margin, the deterministic reproduction and the CI log.
