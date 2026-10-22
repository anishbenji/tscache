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
A small plugin emits the fetcher as a chunk of its own instead; the examples
ship it as `fetcherUrl()` in `examples/mock-backend/src/vite.ts`:

```ts
// vite.config.ts
import { defineConfig, type Plugin } from "vite";

const PREFIX = "\0fetcher-url:";

/** `import url from "./fetcher.ts?fetcher"`: the module's URL, exports kept. */
function fetcherUrl(): Plugin {
  let serve = false;
  return {
    name: "fetcher-url",
    enforce: "pre",
    configResolved(config) {
      serve = config.command === "serve";
    },
    async resolveId(source, importer) {
      if (!source.endsWith("?fetcher")) return undefined;
      const target = source.slice(0, -"?fetcher".length);
      const resolved = await this.resolve(target, importer, { skipSelf: true });
      return resolved ? PREFIX + resolved.id : undefined;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return undefined;
      const file = id.slice(PREFIX.length);
      if (serve) return `export default ${JSON.stringify(`/@fs${file}`)};`;
      const ref = this.emitFile({ type: "chunk", id: file, preserveSignature: "strict" });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
  };
}

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

- The module URL must be one the server can `import()`. Vite's dev server
  runs server code through its module runner, which resolves the same
  `/@fs/` path the plugin gives the browser. A server build, however, renders
  an emitted chunk's URL as a path under `base`, which only a browser can
  load. Add a `resolveFileUrl` hook that gives server code a file URL
  instead (the examples' `fetcherUrl()` does):

  ```ts
  // In the plugin above: remember each emitted chunk's reference id in
  // `chunks` (a Set), then:
  resolveFileUrl({ referenceId, relativePath }) {
    if (this.environment.config.consumer !== "server") return null;
    if (!chunks.has(referenceId)) return null;
    const path = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
    return `new URL(${JSON.stringify(path)}, import.meta.url).href`;
  },
  ```

- A server has no page origin, so a fetcher that requests relative paths
  needs the backend's origin from its context. The examples' fetcher reads
  `context.origin`; the browser's client omits it.

The SSR examples (`examples/react-ssr`, `examples/solid-ssr`) show the rest:
the server writes the covered parts of its answer into the page, and the
browser puts them back with their ranges, so it fetches only what they do not
cover.

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
