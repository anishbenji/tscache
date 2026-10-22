// The package has no Node type definitions (batch-realms.test.ts); Vitest
// runs under Node.
// @ts-expect-error -- no Node types
import { mkdtemp, rm, writeFile } from "node:fs/promises";
// @ts-expect-error -- no Node types
import { tmpdir } from "node:os";
// @ts-expect-error -- no Node types
import { join } from "node:path";
// @ts-expect-error -- no Node types
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetcherUrl } from "../src/entries/vite";

/**
 * Vite, loaded through a specifier TypeScript does not resolve: Vite's
 * types reference Node's, which this package's type check keeps out so
 * Node APIs cannot slip into the library. These are the calls used here.
 */
interface Vite {
  build(config: object): Promise<unknown>;
  createServer(config: object): Promise<{
    ssrLoadModule(url: string): Promise<Record<string, unknown>>;
    close(): Promise<void>;
  }>;
}
const VITE = "vite";
const { build, createServer } = (await import(VITE)) as Vite;

// Implementer tests (N40): real Vite builds of a tiny app that imports a
// fetcher with `?fetcher`, checking what tscache's worker relies on: the
// URL loads a module whose default export survived.

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tscache-vite-"));
  await writeFile(
    join(root, "fetcher.js"),
    "export default { fetch: () => 'fetched' };\n",
  );
  await writeFile(
    join(root, "main.js"),
    'import url from "./fetcher.js?fetcher";\nexport { url };\n',
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Main {
  url: string;
}
interface FetcherModule {
  default: { fetch(): string };
}

describe("fetcherUrl (tscache/vite)", () => {
  it("a client build emits the fetcher as its own chunk, default export kept, at a URL under the base", async () => {
    const outDir = join(root, "client");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      base: "/app/",
      plugins: [fetcherUrl()],
      build: {
        outDir,
        rollupOptions: {
          input: join(root, "main.js"),
          preserveEntrySignatures: "strict",
          output: { entryFileNames: "[name].js" },
        },
      },
    });
    const main = (await import(
      pathToFileURL(join(outDir, "main.js")).href
    )) as Main;
    expect(main.url).toMatch(/^\/app\/assets\/fetcher-[\w-]+\.js$/);
    const chunk = join(outDir, main.url.slice("/app/".length));
    const fetcher = (await import(pathToFileURL(chunk).href)) as FetcherModule;
    expect(fetcher.default.fetch()).toBe("fetched");
  });

  it("a server build gives a file URL that server code can import()", async () => {
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [fetcherUrl()],
      build: { ssr: "main.js", outDir: join(root, "server") },
    });
    const main = (await import(
      pathToFileURL(join(root, "server", "main.mjs")).href
    )) as Main;
    expect(main.url).toMatch(/^file:\/\/.*\/fetcher-[\w-]+\.mjs$/);
    const fetcher = (await import(main.url)) as FetcherModule;
    expect(fetcher.default.fetch()).toBe("fetched");
  });

  it("the dev server serves the fetcher from source under /@fs", async () => {
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [fetcherUrl()],
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: "custom",
    });
    try {
      const main = (await server.ssrLoadModule("/main.js")) as unknown as Main;
      expect(main.url).toMatch(/^\/@fs\/.*\/fetcher\.js$/);
      const fetcher = (await server.ssrLoadModule(
        main.url,
      )) as unknown as FetcherModule;
      expect(fetcher.default.fetch()).toBe("fetched");
    } finally {
      await server.close();
    }
  });

  it("leaves other imports alone", async () => {
    const plugin = fetcherUrl();
    const context = {} as ThisParameterType<typeof plugin.resolveId>;
    expect(
      await plugin.resolveId.call(context, "./fetcher.js", undefined),
    ).toBeUndefined();
  });
});
