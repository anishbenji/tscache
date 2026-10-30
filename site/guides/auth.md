# Credentials and refresh

## Cookies need nothing

Cookie-based authentication needs no tscache code: cookies go with the worker's fetches, as with any
same-origin request.

## Tokens

With tokens, the flow is:

1. The page passes the token in the fetcher's `context` (`createClient({ fetcher: { module, context } })`).
2. The fetcher sends it, and **throws `AuthInvalidError`** when the backend refuses it.
3. The worker marks credentials invalid and **broadcasts `authInvalid` to every tab**, once each time credentials become invalid,
   with the `context` the refused fetch carried.
4. While credentials are invalid, no fetch runs: `get` does not wait, and the affected ranges come back
   at once as misses with reason `'auth-pending'`.
5. Any tab refreshes and calls `client.updateAuth(newContext)`. The fetcher's optional `updateAuth` hook
   runs, the new context takes effect, and fetching resumes.
6. Tabs read again; the ranges that were `'auth-pending'` are fetched.

<<< @/snippets/client.ts#auth{ts}

A `get` never waits for a human: nothing is retried on behalf of a `get` that already returned.

The detection is by marker, `error.code === 'tscache:auth-invalid'`, never `instanceof`, so a fetcher
bundled with its own copy of the class works. A failure from a fetch that started under credentials
since replaced is ignored, so a late refusal of an old token does not undo a refresh.

## Refreshing once across tabs

Every tab hears `authInvalid`. With a rotating refresh token, each refresh token works once, and many
servers revoke the whole session when a spent one comes back; if every tab refreshed, all but the first
would present a spent token. The examples' snippet refreshes under a Web Lock, one tab at a time: a tab
that gets the lock after another's refresh compares the stored access token with the refused one (the
event's `context`) and adopts the new tokens instead of refreshing again.

<<< ../../examples/react-lwcharts/src/auth-refresh.ts{ts}

Its main assumption is that a refresh issues a **new** access token. A backend that renews an access
token in place returns the refused string again, so each tab that heard the refusal refreshes once in
turn, always with the current refresh token: the session survives, at the cost of one redundant refresh
per extra tab.

The reference clients use the same scheme with a sign-in flow around it
([`reference/shared/src/auth.ts`](https://github.com/anishbenji/tscache/blob/main/reference/shared/src/auth.ts)).

## Why broadcast

The architecture compared three designs: tell only the tab whose read failed (other tabs stay silently
stale), broadcast to all (simple; the lock prevents a stampede), and a worker-elected handler that fails
over when its tab dies (cleanest, but election and failover are complex; on the roadmap). Version 1
broadcasts (§6.2 of the [architecture document](https://github.com/anishbenji/tscache/blob/main/docs/architecture.md)).
