/**
 * The Vite plugin for the fetcher module (docs/architecture.md N40–N41;
 * docs/guides/worker-setup.md). Vite bundles a `?worker&url` import as a
 * worker entry without its exports, and tscache's worker needs the
 * fetcher's default export. Nothing is imported from Vite, not even its
 * types: they reference Node's, which would let Node APIs into the browser
 * library's type check. The plugin declares the shapes it uses, and the
 * examples' type check of their vite.config.ts proves it fits Vite's
 * Plugin type.
 */

import { devUrl, serverFileUrl } from "./urls";

/** The parts of Vite's plugin context the hooks use. */
interface Context {
  resolve(
    source: string,
    importer: string | undefined,
    options: { skipSelf: boolean },
  ): Promise<{ id: string } | null>;
  emitFile(file: {
    type: "chunk";
    id: string;
    preserveSignature: "strict";
  }): string;
  environment: { config: { consumer: "client" | "server" } };
}

/** The parts of an output chunk the bundle check reads. */
interface OutputChunkLike {
  type: string;
  code?: string;
  facadeModuleId?: string | null;
  imports?: string[];
  dynamicImports?: string[];
}

/** A Vite plugin (Vite 8's `Plugin`, structurally). */
export interface FetcherUrlPlugin {
  name: string;
  enforce: "pre";
  config(): { ssr: { noExternal: string[] } };
  configResolved(config: { command: "build" | "serve"; base: string }): void;
  resolveId(
    this: Context,
    source: string,
    importer: string | undefined,
  ): Promise<string | undefined>;
  load(this: Context, id: string): string | undefined;
  resolveFileUrl(
    this: Context,
    options: { referenceId: string; relativePath: string },
  ): string | null;
  generateBundle(
    this: { error(message: string): never },
    options: unknown,
    bundle: Record<string, OutputChunkLike>,
  ): void;
}

const QUERY = "?fetcher";
/** A virtual id: the `\0` prefix keeps other plugins off it. */
const PREFIX = "\0tscache-fetcher-url:";

/**
 * `import url from "./fetcher.ts?fetcher"` gives the URL of that module
 * with its exports intact, for `createClient({ fetcher: { module: url } })`.
 * In a build the module becomes a chunk of its own with its signature
 * preserved; in dev it is served from source. Server code (an in-process
 * client during server rendering) gets a URL it can `import()` too: in a
 * server build, a file URL of the chunk; in dev, the file's absolute path,
 * which Vite's module runner resolves.
 *
 * The fetcher's code must import statically (step 16 R3-1, R6-1): Vite
 * wraps every bundled `import()` in its module-preload helper, which reads
 * `document` and, when the import fails, calls `window.dispatchEvent`; a
 * worker has neither, so the fetch would throw a ReferenceError instead of
 * its own error (an expired-token error included). A build whose fetcher
 * graph contains that helper therefore fails, naming the chunk.
 * `build.modulePreload: false` does not remove the helper. A fetcher that
 * needs `import()` is built on its own instead (library mode or another
 * bundler; the worker setup guide) and passed by URL, without `?fetcher`.
 *
 * TypeScript needs the import's type once per project:
 * `declare module "*?fetcher" { const url: string; export default url; }`.
 */
export function fetcherUrl(): FetcherUrlPlugin {
  let serve = false;
  let base = "/";
  // Virtual ids carry a number, never the path: Vite puts an id into a URL
  // unencoded and decodes the request, so a `%` in a path would not match.
  const files: string[] = [];
  const chunks = new Set<string>();
  return {
    name: "tscache:fetcher-url",
    enforce: "pre",
    // In dev, server code import()s the fetcher through Vite's module
    // runner, which resolves /@fs/ paths. An installed tscache would be
    // externalized and its import() run in plain Node, where they mean
    // nothing; bundling it routes the import() through the runner.
    config: () => ({ ssr: { noExternal: ["tscache"] } }),
    configResolved(config) {
      serve = config.command === "serve";
      base = config.base;
    },
    async resolveId(source, importer) {
      if (!source.endsWith(QUERY)) return undefined;
      const target = source.slice(0, -QUERY.length);
      const resolved = await this.resolve(target, importer, { skipSelf: true });
      if (!resolved) return undefined;
      let n = files.indexOf(resolved.id);
      if (n < 0) n = files.push(resolved.id) - 1;
      return `${PREFIX}${n}`;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return undefined;
      const file = files[Number(id.slice(PREFIX.length))];
      if (file === undefined) return undefined;
      if (serve) {
        // Server code gets the absolute path, which Vite's module runner
        // resolves as it is (it does not decode URLs); the browser, an
        // encoded URL under the base.
        return this.environment.config.consumer === "server"
          ? `export default ${JSON.stringify(file)};`
          : `export default ${JSON.stringify(devUrl(base, file))};`;
      }
      const ref = this.emitFile({
        type: "chunk",
        id: file,
        preserveSignature: "strict",
      });
      chunks.add(ref);
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
    // No chunk the worker runs (the fetcher's and every chunk it reaches)
    // may carry Vite's preload helper; its event name marks it in any form.
    generateBundle(_options, bundle) {
      const fetchers = Object.entries(bundle)
        .filter(
          ([, chunk]) =>
            chunk.type === "chunk" &&
            typeof chunk.facadeModuleId === "string" &&
            files.includes(chunk.facadeModuleId),
        )
        .map(([name]) => name);
      for (const fetcher of fetchers) {
        const pending = [fetcher];
        const seen = new Set<string>();
        for (
          let name = pending.pop();
          name !== undefined;
          name = pending.pop()
        ) {
          if (seen.has(name)) continue;
          seen.add(name);
          const chunk = bundle[name];
          if (chunk?.code?.includes("vite:preloadError")) {
            this.error(
              `The fetcher ${fetcher} uses import(): Vite wraps it in a helper (in ${name}) that needs document and window, which tscache's worker lacks. Import the fetcher's dependencies statically, or build the fetcher on its own and pass that file's URL instead of using ?fetcher (see "Building the fetcher on its own" in tscache's worker setup guide).`,
            );
          }
          pending.push(
            ...(chunk?.imports ?? []),
            ...(chunk?.dynamicImports ?? []),
          );
        }
      }
    },
    // Vite renders a file URL as a path under the base, which only a
    // browser can load; server code needs a file URL.
    resolveFileUrl({ referenceId, relativePath }) {
      if (this.environment.config.consumer !== "server") return null;
      if (!chunks.has(referenceId)) return null;
      return serverFileUrl(relativePath);
    },
  };
}
