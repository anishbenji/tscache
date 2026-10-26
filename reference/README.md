# Reference clients

Complete applications built on tscache, written to be copied: one each for vanilla JavaScript,
React and Solid (`docs/roadmap.md`, "Reference clients"). Each one charts one-minute candles of a
market that trades around the clock, live, and shows the whole client lifecycle. Nothing here is
published. The integration snippets (`integrations/`) show the smallest wiring for six frameworks;
these clients add what an application needs on top of it.

| Folder | Status |
|---|---|
| `shared/` | What every client uses, whatever its framework (below) |
| `vanilla/` | Done |
| `react/` | Next |
| `solid/` | After React |

## What every client does

- **Connects once** and replaces the client when the worker behind it is lost
  (`connect` from `integrations/shared/connection.ts`).
- **Reads around the screen.** The opening read covers the last six hours and one screen before
  them. Scrolling, after a pause of 150 ms, reads what is then on screen plus a screen on each side,
  and the cache fetches only what it does not hold. Only the latest answer is drawn.
- **Draws with either chart library.** Lightweight Charts and uPlot implement one small interface
  (`shared/src/chart/view.ts`). The page switches between them with a menu or `?chart=uplot`, and
  loads only the library it shows. While the newest bar is on screen, the chart follows the market;
  while the user reads history, it stays put.
- **Takes pushed bars.** The backend streams the bar forming now over Server-Sent Events. One tab
  per browser holds the stream, elected with a Web Lock, and puts each batch into the cache; the
  other tabs hear of it on a BroadcastChannel and read it back from the cache alone, without a fetch
  (`shared/src/live.ts`). When that tab closes, another takes the stream over. Each time the
  stream opens again, after an outage or under another tab, a tab that follows the market reads its
  newest bars with a fetch, which mends what the stream missed: whole bars, or the final values of
  the bar that was forming when it broke.
- **Refreshes credentials once across tabs.** An expired access token reaches every tab as
  `authInvalid`; one tab rotates the tokens under a Web Lock, every tab hands the new token to its
  client, and the reads that came back `auth-pending` are asked again (`shared/src/auth.ts`).
- **Renders on the server too.** `/ssr` is the same page rendered on the server, which reads with a
  credential of its own; the browser draws the server's read before it connects and starts its cache
  from it, so it fetches only the bar still forming.

## Running one

```sh
bun run build                      # the clients use the built package
bun run --cwd reference/vanilla dev
```

Open `/` for the client-only page and `/ssr` for the server-rendered one. The mock backend
(`examples/mock-backend`) runs inside the dev server and requires a token, as a real backend would.
`e2e/reference/` drives each client in several tabs, both chart libraries included.

## Copying a client

Take the client's folder, `shared/`, and the parts of `integrations/shared/` it imports
(`connection.ts`, `hydration.ts`, `server.ts`, and for vanilla `integrations/vanilla/series.ts`).
Then replace what belongs to the demo:

- the fetcher (`examples/mock-backend/src/fetcher.ts`) with one for your backend
  (`docs/architecture.md` §2.5);
- `shared/src/market.ts` with your series' cache config, and the live feed's URL;
- `shared/src/auth.ts` with your sign-in and refresh endpoints, or drop it if your backend uses
  cookies, which reach the worker's fetches by themselves;
- the server's credential (`shared/src/server.ts`) with one from the server's environment.

## Limits

- The stream is unauthenticated: `EventSource` cannot send an authorization header. A real feed
  takes a cookie or a short-lived ticket in its URL.
- A pushed bar at or after the batch's `finalizedUntil` stays provisional, so a read that fetches
  (a scroll that reaches the newest bar) asks the backend for it again. That keeps the cache right
  if a push goes missing.
- All tabs of a browser are assumed to get the same hosting mode, so the stream's holder and its
  readers agree on whether one cache serves them all.
