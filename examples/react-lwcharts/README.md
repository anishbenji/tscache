# React + Lightweight Charts

Five-minute candles for the last three days, charted in as many tabs as you
open. The page is built around what tscache does for a multi-tab app: one
cache for every tab, one token refresh for every tab, and recovery when the
worker that holds the cache is lost.

```sh
bun install
bun run build                                 # builds the tscache package
bun run --cwd examples/react-lwcharts dev     # http://localhost:5173/
```

The dev server also serves the shared mock backend (`examples/mock-backend`)
under `/api/`, here with bearer-token auth turned on
(`mockBackend({ auth: true })`), so nothing else needs to run. Click
**Open another tab** and put the two windows side by side.

## One SharedWorker for every tab

The chart asks the cache for the last three days every five seconds. Bars
before the backend's watermark (`meta.finalizedUntil`) are final, so after
the first fetch each refresh fetches only the bar forming now. The log and
the fetch counter show it: one fetch of three days when the first tab
opens, then fetches of about ten minutes.

**Decision shown: one SharedWorker serves every tab of the origin.** Every
tab's client connects to the same worker and asks the same cache, so a range
one tab fetched is never fetched for another. Open the second tab: it draws
the three days at once, and its first refresh fetches only the forming bar.
When two tabs need the same range at the same moment, the worker sends one
fetch and both wait on it (in-flight deduplication, `docs/architecture.md`
§2.5). The fetch counter counts the fetches of every tab's worker since this
page opened, so both tabs count the same fetches; the mode reads `shared`.

## An expired token, refreshed once

**Expire access token** makes the backend replace the access token, as if it
had timed out. The refresh token still works, and it rotates: each refresh
token can be used once, and the backend counts any second use as `reused`.

**Decision shown: `authInvalid` reaches every tab, with the refused
context.** The next tail fetch is refused, the fetcher throws
`AuthInvalidError`, and the worker sends `authInvalid` to every tab,
together with the fetcher context the refused fetch carried (N33). Each tab
runs the refresh snippet (`src/auth-refresh.ts`), which waits on a Web Lock.
The first tab to get the lock refreshes and stores the new tokens in
`localStorage`; each tab after it finds that the refused token was already
replaced and adopts the new tokens instead of refreshing again. All tabs
call `updateAuth` with them. The panel shows `authInvalid` heard once in
every tab, the backend's refreshes going up by one however many tabs are
open, and reused refresh tokens staying at zero: a rotating refresh token is
never presented twice.

The snippet clears the refresh token from storage before it spends it. If
the refresh or the save of the new tokens fails, every tab ends the session
instead of retrying with a spent token, and shows **Sign in again**. One
tab's sign-in recovers them all, because they share the worker.

**Decision shown: `get` never blocks on auth.** While auth is invalid the
cache answers at once: the history is drawn from the cache, and the forming
bar comes back as an `auth-pending` miss (the auth state reads `pending`, and
the log shows the miss). No fetch is sent until `updateAuth`; the next
refresh after it fetches the bar. Nothing waits for a person to sign in (§2.3, §2.5).
Cookie-based auth needs none of this: cookies flow with the worker's
fetches.

## Losing the worker

**Decision shown: `workerLost`, and a new client.** Chromium hosts a
SharedWorker in the renderer process of the tab that created it. Close that
tab and nothing is lost: the worker keeps running while any tab is connected
to it. Crash it instead (type `chrome://crash` in the address bar of the
first tab you opened) and the worker and its cache go with it. Every other
tab's client then rejects its calls and emits `workerLost` once. This app
answers by creating a new client, which starts a new worker; the refresh
snippet is installed on the new client and removed from the
old one, the cache is opened again, and, since the new worker's cache is
empty, the three days are fetched once more. The log shows each step
(`docs/guides/worker-setup.md`).

## What else is in here

- `src/client.ts` keeps the client in React state and replaces it on
  `workerLost`. The effects that build on it (the refresh snippet, the cache
  and its polling) depend on that state, so each is torn down and rebuilt
  for the new client, and the client is disposed on unmount.
- `src/auth.ts` installs the snippet and tracks the tab's auth state with a
  reducer: `pending` from an `authInvalid` or an `auth-pending` miss until a
  complete answer, `lost` when the snippet gives up.
- `src/auth-refresh.ts` is the refresh snippet, ready to copy: the logic of
  `e2e/pages/auth-refresh.js`, which the library's end-to-end suite
  exercises (`e2e/auth.spec.ts`), with TypeScript types added.
- `src/tokens.ts` keeps the tokens all tabs share in `localStorage`; the
  fetcher context carries only the access token.
- `src/Chart.tsx` draws with the Lightweight Charts v5 API: candles in the
  main pane and volume in a pane of its own. Time is shown in UTC; the
  backend's sessions run from 13:30 to 20:00 UTC on weekdays, and the time
  scale closes the nights and weekends without bars.
