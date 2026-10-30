# Svelte 5

`series.svelte.ts` is the adapter. `tscacheContext(connection)` turns the
page's connection (`shared/connection.ts`) into root context for `mount()`
or `hydrate()`. A `Series`, created while a component initialises, holds
the cache's answer for its `range` in `current`; `loading` says that answer
is for an earlier range, and setting `range` reads again. The page owns the
connection. `client-only.ts` connects, mounts the component below and
disposes the connection after `unmount()`; `ssr-server.ts` renders the same
component with `svelte/server` and `ssr-browser.ts` hydrates it. A chart
that scrolls would set `chart.range` to its visible range.

```svelte
<script lang="ts">
  import { untrack } from "svelte";
  import { candles, describe, lastDays } from "../shared/candles";
  import type { ServerRead } from "../shared/hydration";
  import { Series } from "./series.svelte";

  // The server's read, when the server rendered the page. The series takes
  // it once, as its first answer, hence untrack.
  let { read }: { read?: ServerRead } = $props();
  const chart = untrack(
    () => new Series(candles, read?.range ?? lastDays(90, Date.now()), read),
  );
</script>

<svelte:boundary>
  <!-- A chart library would take the result's timestamps and fields here. -->
  <p aria-busy={chart.loading}>
    {chart.current ? describe(chart.current.result) : "Loading…"}
  </p>
  {#snippet failed(error)}
    <p role="alert">The chart could not load: {String(error)}</p>
  {/snippet}
</svelte:boundary>
```

## Why these idioms

- `range` and the answer are `$state.raw`. Deep state would proxy the typed
  arrays, and an answer is replaced whole, never edited.
- `createSubscriber` makes `connection.state` trackable while an effect or
  template reads it, with one subscription per app. An `$effect` mirroring
  it into `$state` would need a component and a copy kept in sync.
- The page creates and disposes the connection, so it reaches the app
  through the `context` option of `mount()` and `hydrate()`; `createContext`
  can only be set inside a component. The server render passes no context.
- Each series has one effect, which reads for the current range and client.
  An answer lands only from the latest read, and only while its range is
  still `range`, so a slow answer never replaces a newer one, even for the
  same range object; the previous answer stays until the next lands.
- A read rejected because the worker was lost is dropped, and the new client
  reads again. A failed read on a live client, or a failed connection, is
  thrown from `current`, so a `<svelte:boundary>` shows it.
- Effects do not run on the server, so the server's render shows the read it
  was given and connects nothing. Hydration renders the same read, then the
  live answer replaces it. `{#await}` renders only its pending branch on the
  server, and `await` in `$derived` still needs `experimental.async`.

## Known limits

- tsc checks the `.ts` files; nothing here runs `svelte-check` on this one.
- A failure is final for its series. For a retry, create the series in a
  child component inside the boundary, whose `reset` then creates it again.
- `loading` stays false while a new client reads the same range again, since
  the answer shown is for that range.
- A seed is checked against the dataset version only when the dataset has
  one (`../README.md`, "Checks and limits"; architecture §2.8).
- `open` runs per client, so it can read current credentials;
  `examples/react-lwcharts/src/auth-refresh.ts` handles `authInvalid`.
