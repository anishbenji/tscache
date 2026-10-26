# Step 18 — Reference clients: React

Branch: `feat/18-reference-react` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: in review · Verdict after triage: —

The second of the three reference clients (`docs/roadmap.md`, "Reference clients"; decisions of 2026-10-26). Not an engine step: tests are written with the code.

## Scope

| Commit | What |
|---|---|
| ce8a7b5 | `refactor(reference)`: what the vanilla page does, apart from writing its markup and drawing its chart, moves to `reference/shared/src/session.ts`, with every fix of step 17's review: the read range, the live feed and its catch-up, the credential refresh and sign-in, what an answer lacks. The session holds the page's state as one immutable object, replaced on each change. The vanilla page binds it; its 13 tests pass unchanged |
| dc962ae | `feat(reference)`: `reference/react` (React 19, client-only at `/`, server-rendered at `/ssr`); `ssrPage` passes the requested URL to the server entry; the reference spec runs every test against both clients; the stylesheet moves to `reference/shared`; Knip, Fallow, README and roadmap |

## Decisions made in the step

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | One framework-neutral session for every client, extracted from the vanilla page | Step 17's seven rounds fixed the page's behaviour (refill after a clear, gaps, catch-up, teardown, a restored session); a second copy of that logic in React, and a third in Solid, would have to be fixed three times. The clients then differ only in binding and drawing | Write each client's logic in its framework's idiom (hooks, signals): more idiomatic on the surface, three copies of the hard parts |
| D2 | React binds the session with `useSyncExternalStore`, not the integration snippet's `useSeries` | `useSeries` caches each range's answer and never reads it again (a limit its README states), which a live chart cannot have: pushes, cache-only redraws, Retry and catch-up all read a range again | Extend `useSeries` with a read generation; it would keep Suspense, at the cost of a new promise per push |
| D3 | No Suspense in the React client | The session's state always has something to show: the server's read, or "loading…" until the first answer; nothing suspends | A Suspense boundary for the first answer, which the session would have to expose as a promise |
| D4 | The chart is an effect on a ref'd element, not state | Both libraries are imperative; their views live in a ref and are created and disposed by an effect keyed on the session and the chart kind, so StrictMode's doubled effects create, dispose and create again | A chart library's React wrapper, which neither library ships officially |
| D5 | `RenderRequest` gains `url` | The server-rendered page must render the chart kind `?chart=` asks for, or hydration would not match the browser's | Render the default kind on the server and switch after hydration, at the cost of a second mount |

## Verification

- `bun run ci` green: 1467 Vitest, 74 Playwright, including `e2e/reference/clients.spec.ts` with all 13 tests against each client.
- Run by hand in Chromium against the React dev server: `/ssr?chart=uplot` hydrates with no warning and draws the server's read; `/` draws and follows the market.
- Not verified: Firefox and Safari; the feed on dedicated-worker or in-process tabs in a real browser.
