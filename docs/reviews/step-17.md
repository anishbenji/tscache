# Step 17 — Reference clients: vanilla

Branch: `feat/17-reference-vanilla` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: in review · Verdict after triage: —

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

## Verification

- `bunx vitest run examples/mock-backend integrations reference`: the new stream, dataset, service-token, series and range tests pass.
- `E2E_EXAMPLES=reference-vanilla bunx playwright test --project=examples reference/`: 6 passed — one stream for two tabs and a hand-over when the holder closes, pushed bars drawn without a fetch, history fetched once on scrolling back with each chart library and not again on scrolling forward, one token refresh across two tabs, the server-rendered page fetching only the forming bar, and switching the library without a fetch.
- Run by hand in Chromium against the dev server: both libraries draw, follow the live bar and scroll back through history; the server-rendered page draws the server's read before the client connects.
- Not verified: Firefox and Safari; the dedicated-worker and in-process paths of the feed (D2) in a real browser.
