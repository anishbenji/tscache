# Step 17 — Reference clients: vanilla

Branch: `feat/17-reference-vanilla` · Reviewer: GPT-6.1 Sol (high) · Rounds: 3 · Status: in review · Verdict after triage: —

The first of the three reference clients (`docs/roadmap.md`, "Reference clients"; track (c) after the post-build architecture review). Not an engine step: tests are written with the code. The decisions below were the user's (2026-10-26); the roadmap records them.

## Scope

| Commit | What |
|---|---|
| fb163ee | `feat(examples)`: the mock backend gains a `crypto` dataset that trades around the clock (it shares the OHLCV bar code with `candles`, whose values are unchanged), `GET /api/stream/<dataset>/<symbol>` pushing the forming bar as a put batch over Server-Sent Events, and a `serviceToken` option for a page server's credential. The Vite adapter streams response bodies and aborts the backend's answer when the client goes away; `ssrPage` takes a `path` and a `template`, so a server-rendered page can sit beside the app's own pages |
| 815b1bf | `feat(integrations)`: the vanilla series gains `refresh(range?)`, a cache-only read for drawing pushed data without a fetch, skipped while a `show()` is in flight; `serverReader` takes more fetcher context (the server's credential); the package exports its shared core and the vanilla series for the reference clients to import |
| ce91b5a | `feat(reference)`: `reference/shared` (market config and read ranges, the chart interface with Lightweight Charts and uPlot behind it, the credential refresh across tabs, the live feed) and `reference/vanilla` (client-only at `/`, server-rendered at `/ssr`); `e2e/reference/vanilla.spec.ts`; unit tests of the range helpers; typecheck, Vitest, Playwright, Knip and Fallow configuration; README and roadmap |

## Decisions made in the step

Each is reversible and inside the user's decisions; listed so the review can contest them.

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | A 24/7 market (`crypto`) rather than the weekday `candles` | A live chart must move whenever someone opens it; `candles` trades 6.5 hours on weekdays | Keep `candles` and accept a still chart most of the day |
| D2 | The feed's holder puts each batch, then broadcasts it; a non-holder puts only when its client is not on a SharedWorker | With a SharedWorker one put serves every tab; tabs with caches of their own need their own put. All tabs of a browser get the same hosting mode, so holder and readers agree | Every tab puts every batch (simpler, N puts per batch into one shared cache) |
| D3 | Pushed bars are drawn by a cache-only read (`refresh`) of the range on screen, widened to the batch's end | A normal read refetches the provisional tail every time, which would cost one fetch per push | Draw the pushed bar straight into the chart (no read, but the chart and the cache could disagree) |
| D4 | The stream is unauthenticated | `EventSource` cannot send an authorization header; the README names cookie or ticket auth for a real feed | Read the stream with `fetch` and a header, and write the reconnect logic by hand |
| D5 | The server-rendered page reads with a service token | The server's client is shared by every visitor and must not carry a user's token; the mock backend now models a server credential | Run the SSR page against a backend without auth |
| D6 | A chart reports a scroll only around user input (Lightweight Charts) or from its own handlers (uPlot) | Lightweight Charts changes its range by itself after a draw or a resize and reports it the same way; taken for a scroll, each one cost a read. Found while running the page | Compare against the last range set; failed, since the chart adjusts the range a frame later |
| D7 | `@tscache/integrations` gains `exports`, and the reference imports its shared core | One copy of the lifecycle and the hydration; a reader copies the files the README lists | Copy the files into `reference/shared` |

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | A pushed batch of a new dataset version clears the cache, and the cache-only redraws never fetch the history back | accepted | Validated by reading: the put with a new `meta.version` auto-clears (§2.4) and `refresh` reads with `cacheOnly`. The page now reads its range again on `cacheCleared` for the market's cache, on every tab (the event reaches all of them). E2E test bumps the version while streaming and waits for a history fetch and the full bar count; it fails with the listener removed. 198c849 |
| R1-2 | P1 | Switching chart libraries opens the new chart at the opening range, away from the history on screen | accepted | Reproduced. `ChartView` gains `visible()`, and a new chart opens at the old one's range. The page shows the range on screen (`showing`), which the E2E test compares across a switch after scrolling back; it fails with the old opening restored. 198c849 |
| R1-3 | P1 | The page never shows coverage or misses other than auth-pending, so a failed history fetch looks like a confirmed gap | accepted | Validated against the roadmap's scope ("render coverage and misses"). The page shows what an answer lacks by reason, leaving out the provisional forming bar, and offers Retry after a failed fetch. Found while testing: the next push's cache-only redraw reports the failed range as uncached, so the page keeps naming the failure until nothing is missing. The mock backend gains `failNext`; the E2E test fails a history fetch, sees "fetch failed", and retries. 198c849 |

## Round 2 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R2-1 | P1 | uPlot keeps the previous bars for an answer without any (a version clear whose refill fails, in history) | accepted | Validated by reading: `draw` returned before `setData` for no bars. uPlot now sets the empty columns and keeps the time on screen; both views keep it, so later bars appear where the user was. The E2E test scrolls two screens back with uPlot, fails every fetch, bumps the version, and counts candle-coloured pixels down to zero; it fails with the early return restored. Found while fixing: Lightweight Charts' `setData` reports the chart's default range at once, and the view took it for the range on screen, so the opening range was applied only through the old "no bars before" branch. The view now decides the range before `setData`, and keeps the time on screen across a resize. fd19e87 |
| R2-2 | P1 | A tab whose session was lost stays "signed out" after another tab signs in | accepted | Validated by reading: only the tab's own sign-in cleared the state. `onTokensStored` (auth.ts) hears another tab store refreshable tokens through the `storage` event; a signed-out tab gives its client the token and reads again. The E2E test spoils the refresh token, signs both tabs out with an expired access token, signs in from one and waits for the other; it fails without the recovery. fd19e87 |

## Round 3 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R3-1 | P1 | After a stream outage of several minutes, every batch lies more than a bar past the read range and is dropped, so the chart freezes | accepted | Validated by reading `onBatch`. While the chart follows the market (what is on screen reaches the end of the read range), a batch after a gap now widens the range and reads it normally, which fetches the missed bars; in history the page waits as before. The E2E test starts the page with its clock three minutes behind the backend's, so the first pushed bar comes after a gap, and waits for the missed bars; it fails with the read disabled. Found while testing: following measured against the newest bar broke when the fetch reached past the view, so it is measured against the read range. 401e88c |
| R3-2 | P1 | Fallow fails on the branch: the specs' pixel helper exceeds the complexity threshold, and the chart setup is a clone | accepted in part | The complexity finding was real and is fixed: the helper compares packed pixels against a set. The clone group (Lightweight Charts setup shared with two examples) is reported as a warning under `.fallowrc.json` (`minOccurrences: 3`, duplication not gating) and did not fail the run; the reference is the copy readers take, so it stays. `bun run ci` passes on the fix commit. 401e88c |

## Verification

- `bunx vitest run examples/mock-backend integrations reference`: the new stream, dataset, service-token, series and range tests pass.
- `E2E_EXAMPLES=reference-vanilla bunx playwright test --project=examples reference/`: 12 passed after round 3 (6 before round 1); `bun run ci` green after round 3 (1465 Vitest, 60 Playwright) — one stream for two tabs and a hand-over when the holder closes, pushed bars drawn without a fetch, history fetched once on scrolling back with each chart library and not again on scrolling forward, one token refresh across two tabs, the server-rendered page fetching only the forming bar, and switching the library without a fetch.
- Run by hand in Chromium against the dev server: both libraries draw, follow the live bar and scroll back through history; the server-rendered page draws the server's read before the client connects.
- Not verified: Firefox and Safari; the dedicated-worker and in-process paths of the feed (D2) in a real browser.
