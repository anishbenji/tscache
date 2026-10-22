# Worker entry setup

`createClient` needs the URL of the worker script, `tscache/worker`, as your
bundler serves it. The URL is resolved by the browser at runtime, so a bare
package specifier does not work: each bundler has its own way to turn the
package entry into a served file. If the URL is wrong, both worker hostings
fail to start and the client falls back to an in-process engine that no other
tab shares; watch the `modeFallback` event during development.

The worker is an ES module (`{ type: 'module' }`), so the setup must produce a
module worker.

## Vite

```ts
import { createClient } from "tscache";
// `?worker&url` bundles the module worker and gives its served URL.
import workerUrl from "tscache/worker?worker&url";

const client = await createClient({ workerUrl });
```

## webpack 5 (and Rspack)

webpack bundles a worker only when it sees `new Worker(new URL(...))` in your
code; `createClient` creates the worker internally, so that syntax is not
available, and a bare `new URL("tscache/worker", import.meta.url)` emits the
entry file as a single asset **without** the chunks it imports (the worker
then fails to start and the client falls back to in-process). Serve the whole
`dist/` directory instead, for example with `copy-webpack-plugin`:

```js
// webpack.config.js
import CopyPlugin from "copy-webpack-plugin";
export default {
  plugins: [
    new CopyPlugin({
      patterns: [{ from: "node_modules/tscache/dist", to: "vendor/tscache" }],
    }),
  ],
};
```

```ts
const client = await createClient({ workerUrl: "/vendor/tscache/worker.js" });
```

## No bundler

Serve `node_modules/tscache/dist/worker.js` (and the chunks next to it) from
your origin, or copy `dist/` into your static assets, and pass that path:

```ts
const client = await createClient({ workerUrl: "/vendor/tscache/worker.js" });
```

## The fetcher module

`fetcher.module` is a URL too: the worker loads it with `import()` and uses
its default export (`docs/architecture.md` §2.5). Serve it as an ES module
from your origin, with that export intact.

With Vite, `?worker&url` does not fit the fetcher: Vite bundles a worker
entry without its exports, so the module loads but has no default export.
`fetcherUrl()` from `tscache/vite` emits the fetcher as a chunk of its own
instead, with its exports intact, and serves it from source in dev. It needs
Vite 8 (`vite` is an optional peer dependency of tscache):

```ts
// vite.config.ts
import { fetcherUrl } from "tscache/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [fetcherUrl()] });
```

```ts
import { createClient } from "tscache";
import workerUrl from "tscache/worker?worker&url";
import fetcherUrl from "./fetcher.ts?fetcher";

const client = await createClient({ workerUrl, fetcher: { module: fetcherUrl } });
```

For TypeScript, declare the import once:
`declare module "*?fetcher" { const url: string; export default url; }`.

Without a bundler, write the fetcher as a plain ES module and import
`AuthInvalidError` from your served copy of `dist/fetcher.js`
(`import { AuthInvalidError } from "/vendor/tscache/fetcher.js"`).

## Server rendering

A server reads with an in-process client (`mode: 'in-process'`, no
`workerUrl`), which imports the fetcher module in the server's own process.
Two things differ from the browser:

- The module URL must be one the server can `import()`. Vite renders an
  emitted chunk's URL as a path under `base`, which only a browser can load,
  so `fetcherUrl()` gives server code a file URL in a server build instead.
  In dev, Vite's module runner resolves the same `/@fs/` path the browser
  gets. Nothing to configure.
- A server has no page origin, so a fetcher that requests relative paths
  needs the backend's origin from its context. The examples' fetcher reads
  `context.origin`; the browser's client omits it.

The server hands its answer to the browser as a snapshot (`docs/architecture.md`
§2.8). Read with `snapshot: true`, and the result carries a `Snapshot` taken
from the same state as its columns. The page carries both: the columns for the
render, and the snapshot for the cache, encoded for JSON:

```ts
// Server: one read gives the page's data and the cache's snapshot.
const { snapshot, ...result } = await cache.get(range, { snapshot: true });
const html = render(result); // your framework's renderer
const json = JSON.stringify(encodeSnapshot(snapshot!)).replaceAll("<", "\\u003c");
page.head += `<script id="tscache-snapshot" type="application/json">${json}</script>`;

// Browser: before the first live read.
const text = document.getElementById("tscache-snapshot")!.textContent!;
const { applied, skipped } = await cache.hydrate(decodeSnapshot(JSON.parse(text)));
```

`hydrate` writes only where the browser's cache neither covers anything nor
holds a provisional point, in one call inside the worker, so another tab's
newer fetch is never replaced. A snapshot of another dataset version is
refused (`skipped: 'version-mismatch'`), and the snapshot's own provisional
tail is left for the browser to fetch. The snapshot stays usable after
`hydrate`, so the client that replaces a lost one can be seeded from it too.
A worker from before `hydrate` (a stale cached script) rejects the call with
"unknown op"; treat that as nothing applied, and the cache fetches instead.
Escape every `<` in the JSON, as above, so no string in it can close the
script element.

The SSR examples (`examples/react-ssr`, `examples/solid-ssr`) and the
integration snippets (`integrations/`) show the whole flow.

## Notes

- Same origin only: a worker script on another origin is refused by the
  browser, and `SharedWorker` is shared only among same-origin tabs.
- Chrome on Android has no `SharedWorker`; the chain falls back to a dedicated
  `Worker` per tab (one `modeFallback` event). Nothing to configure.
- Check the setup once with `client.mode`: `'shared'` (or `'dedicated'` where
  SharedWorker is unavailable) means the URL resolved.
- Chromium runs a `SharedWorker` in the process of the tab that created it.
  If that tab crashes, the worker and its cache go with it; every other tab's
  client then rejects its calls and emits `workerLost` once. Create a new
  client to go on (it starts a new worker, with an empty cache). Detection
  uses Web Locks, so it needs a secure context (HTTPS or `localhost`);
  elsewhere the calls of those tabs hang.

  ```ts
  let client = await createClient(options);
  const recover = () => {
    void createClient(options).then((next) => {
      client = next;
      client.on("workerLost", recover);
    });
  };
  client.on("workerLost", recover);
  ```

  Detection assumes two things (architecture §4.8, N43, N44). First, no
  script of your origin takes the worker's lock. Its name is readable with
  `navigator.locks.query()`; a script that requests it with `steal: true`
  and later releases it makes every client report `workerLost` while the
  worker runs on. The worker never requests its lock again, so every client
  that connects to it afterwards reports loss at once, and the loop above
  reconnects until the last tab closes. Second, the fetcher module never
  closes its worker: a dedicated worker that calls `self.close()` fires no
  `error`, so the calls of its tab hang.
