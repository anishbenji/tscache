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
