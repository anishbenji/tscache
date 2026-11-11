# Step 77 — The scroll-back flake in the reference clients spec

Branch: `fix/77-clients-scrollback-flake` · Reviewer: GPT-6.1 Sol (high) · Rounds: — · Status: — · Verdict after triage: —

## Scope

`bun run ci` run 1 on the step 76 branch (2026-11-10, a docs-only branch with two changed sentences) failed at `e2e/reference/clients.spec.ts:283`, in "scrolling back fetches only the history the cache lacks (uplot)" for reference-vanilla: after the drag forward, the test expects no history fetch among the notices since `settled`, and it found one. 143 passed, 1 failed, 19 did not run; run 2 passed (`docs/reviews/step-76.md`). The fix changes only that test. No library, reference client or mock backend code changes.

| Commit (by subject)                                                     | What                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `test(e2e): wait for the read where the scroll-back drag ended`         | The test waits for the fetches of the read at the end of the drag before it counts notices. |
| `docs(review): step 77, the scroll-back flake in the reference clients` | This file.                                                                                  |

## Root cause

Classification: (a), a defect in the test. The reference client and the library behave as designed.

**What failed.** The run's log shows the one history fetch found after `settled`:

```
- Array []
+ Array [
+   Object {
+     "cacheId": "crypto/BTC/1m",
+     "outcome": "ok",
+     "pages": 1,
+     "range": Object {
+       "end": 1794273540000,
+       "start": 1794263640000,
+     },
+   },
+ ]
> 283 |         expect(back.filter(isHistory)).toEqual([]);
```

The fetch spans 165 minutes. The drag back moves the chart by about three quarters of its six-hour screen, so the read at the end of the drag lacks about four and a half hours of history. A fetch of 165 minutes is not that read: it is the rest of it, after an earlier read had fetched the first part. In the reproduction below the drag back lacked 274 minutes in all; on that measure the earlier read in CI fetched about 109 minutes, just over the 100 bars the test's bar-count condition asks for.

**The race.** The session reads the range on screen each time scrolling pauses for `SCROLL_PAUSE_MS` (150 ms, `reference/shared/src/session.ts`), not once per drag. The test's `drag` sends twenty pointer moves, and on a loaded machine two of them can lie more than 150 ms apart. The page then reads where the drag paused, and that read fetches part of the history. Its answer alone can pass the test's condition `barCount > opened + 100`, which the test takes as "the scroll back has been answered". The read at the end of the drag follows: its timer fires 150 ms after the last move, and its fetch, which takes only what the mid-drag read did not (in-flight subtraction, architecture §4.9.1), posts its notice one backend round trip (300 ms) later. When the test reads `settled` inside that window, the notice lands after it, and the check after the drag forward finds it. The condition the test waited on does not mean the read for where the drag ended has been answered.

**Evidence.**

- Deterministic reproduction: a scratch spec drove the same drag back in two moves with a pause between them, waited for the page's first scroll read (counted with an init script that wraps the page's 150 ms timers) and its answer, raised the backend's latency to 1000 ms, made the second move, and waited for the second scroll read to fire. It then ran the old test body from the bar-count poll on, and, after the drag forward, waited until the fetch notices reached the read where the drag back ended, so that notice was in before `back` was read. These two waits force the order suspected in the CI run. With the old assertion it failed 15 of 15 repeats, each with one 137-minute history fetch after `settled` whose end meets the start of the mid-drag read's fetch (opened 721 bars, 858 after the mid-drag read). The same forced order with the fix passed 15 of 15, with the first version of the fix and again with the final one (see Verification). Command: `scripts/flake-hunt.sh -n 15 --load e2e/reference/scrollback-race.spec.ts` (30 tests executed: 15 failed, all the old variant; 15 passed). The scratch spec was not committed (see below).
- Natural reproduction rate before the fix, on the development machine: 0 failures in 20 repeats, `scripts/flake-hunt.sh -n 20 --load e2e/reference/clients.spec.ts` (1380 passed, 1.3 h). The failure needs two pointer moves more than 150 ms apart and the test's next notice count inside a 300 ms window, which the CI run on a loaded machine met once.

## Fix

After the bar-count poll, the test waits until the fetch notices since the drag began cover every bar from near the start of the read where the drag ended through the bar before the opening fetch. Only then does it read `scrolled` and `settled`. That read starts one screen before what is on screen (`readRange` in `reference/shared/src/market.ts`), which the test takes from the page's `showing` output: its start less its span. A new helper, `fetchedThrough`, checks that the recorded ranges cover the span without a gap, and `showingRange` reads both ends of `showing` (`showingStart` now uses it).

The wait stops ten minutes short of that start (`REACH_SLACK`). The shown times are rounded down to the minute, and a chart's span can be a little off six hours: Lightweight Charts showed `12:21 – 18:20` in one run, so its read started a minute later than the shown start less six hours. A first version of the fix waited for exactly that start, which held for uPlot but timed out for Lightweight Charts in 2 of 20 repeats (see Verification). The slack cannot hide a fetch the assertion is about. If the wait stops short of the read's start, what that read may still fetch spans ten minutes and a little more, and the assertion counts only history fetches, which span over an hour (`isHistory`).

This removes the cause rather than masking it. However many reads the drag back made, the read where it ended asks for that whole span, and the cache fetches whatever part it lacks. Once the span is covered, every history fetch the drag back caused has posted its notice. Any history fetch after `settled` is then one the drag forward caused, which is what the assertion is about. The assertion, the bar-count conditions and every timeout are unchanged. The wait polls a condition, as `docs/testing.md` (Waiting) asks; it adds no sleep, retry or clock read (`bun scripts/test-clocks.ts`: clean).

The drag keeps its twenty steps. A drag in one move would avoid the mid-drag read, but it would only hide that a page reads each time scrolling pauses; the test now holds whatever reads the drag makes.

The reproduction does not stay as a regression test, against the usual practice in `docs/testing.md`, for the reason step 70 gives: it pins the failing order with a timer wrapper and a raised latency to show the race, and the fixed test no longer depends on that order. The race is recorded here instead.

## Verification

- `scripts/flake-hunt.sh -n 20 --load e2e/reference/clients.spec.ts` after the fix, through the heavy-job lock: 1380 passed (1.3 h), 0 failures in 20 repeats of each of the spec's 69 tests.
- The first version of the fix, which waited for exactly the shown start less six hours, under the same command: 1348 passed, 2 failed, 30 did not run (1.3 h). Both failures were reference-solid's Lightweight Charts scroll-back test, timing out in the new wait with the page showing a span of 5 h 59 min and "nothing missing". The wait now takes the shown span and the slack described in Fix. The reproduction above was run again with the final wait: 15 of 15 failed with the old assertion, 15 of 15 passed with the fix.
- `bun run ci` through the heavy-job lock on the branch head: its result is in the step's report to the director. `bun scripts/test-clocks.ts` alone: 158 files clean. `bunx tsc -p e2e`: no errors. `bunx biome check e2e/reference/clients.spec.ts`: clean.

## Contract-test changes

None.

## Not verified

- The fix on GitHub's runner. The next weekly `Flake hunt` run, or one dispatched with `files: e2e/reference/clients.spec.ts`, is that check.
- The failure arising naturally on this machine: 0 in 20 repeats before the fix. The root cause rests on the CI log's fetch span, the deterministic reproduction and the session's scroll pause.
