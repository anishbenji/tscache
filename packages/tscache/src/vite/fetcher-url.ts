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

/** Vite's `build.modulePreload.resolveDependencies`. */
type ResolveDependencies = (
  filename: string,
  deps: string[],
  context: { hostId: string; hostType: "html" | "js" },
) => string[];

/** The parts of the app's config the `config` hook reads. */
interface UserConfig {
  build?: {
    modulePreload?:
      | boolean
      | { polyfill?: boolean; resolveDependencies?: ResolveDependencies };
  };
}

/** The parts of an output chunk the bundle walk reads. */
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
  config(user: UserConfig): {
    ssr: { noExternal: string[] };
    build?: { modulePreload: { resolveDependencies: ResolveDependencies } };
  };
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
    options: unknown,
    bundle: Record<string, OutputChunkLike>,
  ): void;
  writeBundle(
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
 * An `import()` inside the fetcher's module graph would get Vite's
 * module-preload helper, which reads `document` when it has something to
 * preload and so throws in the worker (step 16 R3-1). The plugin empties
 * the preload list of every import hosted in a chunk the worker runs (the
 * fetcher's chunk and every chunk it reaches), wrapping any
 * `build.modulePreload.resolveDependencies` the app set, which still runs
 * for every other chunk. A chunk the page shares with the worker therefore
 * loses preloading for its own dynamic imports. If a chunk the worker runs
 * still carries a preload list after the build (a Vite change, or another
 * plugin replacing `resolveDependencies`), the build fails and names the
 * chunk, rather than ship a fetcher that throws in the worker; setting
 * `build.modulePreload: false` is the way out.
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
  /** Output file names of the chunks the worker runs, set per build. */
  const workerChunks = new Set<string>();
  return {
    name: "tscache:fetcher-url",
    enforce: "pre",
    // In dev, server code import()s the fetcher through Vite's module
    // runner, which resolves /@fs/ paths. An installed tscache would be
    // externalized and its import() run in plain Node, where they mean
    // nothing; bundling it routes the import() through the runner.
    config(user) {
      const ssr = { noExternal: ["tscache"] };
      const preload = user.build?.modulePreload;
      // Turned off by the app: Vite then preloads nothing in a worker either.
      if (preload === false) return { ssr };
      const own =
        typeof preload === "object" ? preload.resolveDependencies : undefined;
      const resolveDependencies: ResolveDependencies = (
        filename,
        deps,
        context,
      ) =>
        workerChunks.has(context.hostId)
          ? []
          : own
            ? own(filename, deps, context)
            : deps;
      return { ssr, build: { modulePreload: { resolveDependencies } } };
    },
    // Runs before Vite's import analysis writes the preload lists (this
    // plugin is enforced "pre"): find the chunks the worker runs.
    generateBundle(_options, bundle) {
      workerChunks.clear();
      const pending = Object.entries(bundle)
        .filter(
          ([, chunk]) =>
            chunk.type === "chunk" &&
            typeof chunk.facadeModuleId === "string" &&
            files.includes(chunk.facadeModuleId),
        )
        .map(([name]) => name);
      for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
        if (workerChunks.has(name)) continue;
        workerChunks.add(name);
        const chunk = bundle[name];
        pending.push(
          ...(chunk?.imports ?? []),
          ...(chunk?.dynamicImports ?? []),
        );
      }
    },
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
    // The self-check: Vite writes the preload lists after generateBundle's
    // "pre" phase, so a list left in a worker chunk shows up only here.
    writeBundle(_options, bundle) {
      for (const name of workerChunks) {
        if (bundle[name]?.code?.includes("__vite__mapDeps([")) {
          this.error(
            `${name} runs in tscache's worker but still carries a module preload list, whose helper reads document and throws there. Set build.modulePreload: false, or report this against tscache/vite.`,
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
