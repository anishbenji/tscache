# The Vite plugin

The worker needs the fetcher module's **default export**. Vite's `?worker&url` bundles a module as a
worker entry, without its exports, so it does not fit the fetcher. `fetcherUrl()` from `tscache/vite`
gives a `?fetcher` import instead: the module's URL with its exports kept.

<<< @/snippets/vite-config.ts#config{ts}

<<< @/snippets/getting-started.ts#client{ts}

For TypeScript, declare the import once:

<<< @/snippets/env.d.ts{ts}

It needs Vite 8; `vite` is an optional peer dependency of tscache, and the plugin imports nothing from
Vite at runtime.

## What it does

| Where | `?fetcher` gives |
|---|---|
| a client build | the URL of a chunk of its own, with its signature preserved |
| the dev server, in the browser | the URL of the module, served from source |
| a server build | a `file:` URL of the chunk, which server code can `import()` |
| the dev server, in server code | the file's absolute path, which Vite's module runner resolves |

It also adds `tscache` to `ssr.noExternal`, so in dev the library's `import()` of the fetcher goes
through Vite's module runner rather than plain Node. Nothing to configure for
[server rendering](/guides/ssr).

## The fetcher rule: import statically

Vite wraps every bundled `import()` in its module-preload helper, which reads `document` and, when the
import fails, calls `window.dispatchEvent`. A worker has neither, so the fetch would throw a
`ReferenceError` instead of its own error, an expired-token error included, which would then never
reach the other tabs. **`fetcherUrl()` fails the build when the fetcher, or any code it reaches, uses
`import()`**, naming the chunk. `build.modulePreload: false` does not remove the helper.

## A fetcher that needs `import()`

Build it on its own, as a static file, with a bundler that keeps the entry's exports and adds no DOM code
(Bun, or Vite's library mode), and pass its URL without `?fetcher`:

```sh
bun build src/fetcher.ts --splitting --format esm --outdir public/fetcher
```

```ts
const client = await createClient({
  workerUrl,
  // Vite serves public/ under `base`; here `base` is "/" or "/app/".
  fetcher: { module: `${import.meta.env.BASE_URL}fetcher/fetcher.js` },
});
```

This works when `base` is an absolute path; with a relative `base`, give the deployed path yourself. The
step runs outside your app's build: rebuild the fetcher when it changes, repeat any aliases or `define`
values it needs, and serve it with revalidation, since its name carries no hash. The
[worker setup guide](https://github.com/anishbenji/tscache/blob/main/docs/guides/worker-setup.md) has the Vite library-mode config.
