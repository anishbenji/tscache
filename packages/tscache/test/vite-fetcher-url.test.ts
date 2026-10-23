import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetcherUrl } from "../src/entries/vite";
import { devUrl, serverFileUrl } from "../src/vite/urls";

/**
 * Node's modules and Vite, loaded through specifiers TypeScript does not
 * resolve: the package has no Node type definitions, and Vite's types
 * reference Node's, which this package's type check keeps out so Node APIs
 * cannot slip into the library (batch-realms.test.ts). These are the calls
 * used here; Vitest runs under Node.
 */
const load = <T>(specifier: string): Promise<T> =>
  import(/* @vite-ignore */ specifier) as Promise<T>;
const { mkdir, mkdtemp, realpath, rm, writeFile } = await load<{
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  mkdtemp(prefix: string): Promise<string>;
  realpath(path: string): Promise<string>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}>("node:fs/promises");
const { tmpdir } = await load<{ tmpdir(): string }>("node:os");
const { join } = await load<{ join(...parts: string[]): string }>("node:path");
const { pathToFileURL } = await load<{ pathToFileURL(path: string): URL }>(
  "node:url",
);
const { execFile } = await load<{
  execFile(
    file: string,
    args: string[],
    done: (error: unknown, stdout: string) => void,
  ): void;
}>("node:child_process");

/** The Vite calls used here. */
interface Vite {
  build(config: object): Promise<unknown>;
  createServer(config: object): Promise<{
    ssrLoadModule(url: string): Promise<Record<string, unknown>>;
    listen(): Promise<unknown>;
    resolvedUrls: { local: string[] } | null;
    close(): Promise<void>;
  }>;
}
const { build, createServer } = await load<Vite>("vite");

// Implementer tests (N40): real Vite builds and dev servers of a tiny app
// that imports a fetcher with `?fetcher`, checking what tscache's worker
// relies on: the URL loads a module whose default export survived. The
// fetcher lives outside the app's root, in a directory whose name holds a
// space and a literal `%`, so dev URLs go through /@fs/ and must be encoded
// (step 16 R2-1).

let base = "";
let root = "";
const LIB = "lib %41";
beforeAll(async () => {
  // The real path: fs.allow compares real paths, and macOS links /var.
  base = await realpath(await mkdtemp(join(tmpdir(), "tscache-vite-")));
  root = join(base, "app");
  await mkdir(join(base, LIB), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(
    join(base, LIB, "fetcher.js"),
    "export default { fetch: () => 'fetched' };\n",
  );
  await writeFile(
    join(root, "main.js"),
    `import url from "../${LIB}/fetcher.js?fetcher";\nexport { url };\n`,
  );
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Runs an ES module script in plain Node and returns its stdout. */
function runInNode(script: string): Promise<string> {
  const node = (globalThis as { process?: { execPath?: string } }).process
    ?.execPath as string;
  return new Promise<string>((resolve, reject) =>
    execFile(
      node,
      ["--input-type=module", "-e", script],
      (error: unknown, stdout: string) =>
        error ? reject(error) : resolve(stdout),
    ),
  );
}

interface Main {
  url: string;
}
interface FetcherModule {
  default: { fetch(): string };
}

/** Options every dev server here shares: serving files outside the root. */
const devOptions = () => ({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [fetcherUrl()],
});

describe("fetcherUrl (tscache/vite)", () => {
  it("a client build emits the fetcher as its own chunk, default export kept, at a URL under the base", async () => {
    const outDir = join(root, "client");
    await build({
      ...devOptions(),
      base: "/app/",
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

  it("a server build gives a file URL that server code can import(), whatever the assets directory is called (R3-2)", async () => {
    await build({
      ...devOptions(),
      build: {
        ssr: "main.js",
        outDir: join(root, "server"),
        assetsDir: "assets %41 #1",
      },
    });
    // Plain Node, as server code runs: Vitest's own import() resolver does
    // not decode file URLs as Node does.
    const node = (globalThis as { process?: { execPath?: string } }).process
      ?.execPath as string;
    const main = pathToFileURL(join(root, "server", "main.mjs")).href;
    const script = `const { url } = await import(${JSON.stringify(main)});
      const fetcher = await import(url);
      process.stdout.write(JSON.stringify([url, fetcher.default.fetch()]));`;
    const output = await new Promise<string>((resolve, reject) =>
      execFile(
        node,
        ["--input-type=module", "-e", script],
        (error: unknown, stdout: string) =>
          error ? reject(error) : resolve(stdout),
      ),
    );
    const [url, fetched] = JSON.parse(output) as [string, string];
    expect(url).toMatch(
      /^file:\/\/.*\/assets%20%2541%20%231\/fetcher-[\w-]+\.mjs$/,
    );
    expect(fetched).toBe("fetched");
  });

  it("a dev server under a base gives the browser an encoded /@fs/ URL inside that base (R1-2, R2-1)", async () => {
    const server = await createServer({
      ...devOptions(),
      base: "/app/",
      server: { port: 0, hmr: false, ws: false, fs: { allow: [base] } },
    });
    try {
      await server.listen();
      const origin = new URL(server.resolvedUrls?.local[0] ?? "").origin;
      const get = async (path: string) => {
        const response = await fetch(new URL(path, origin));
        if (response.status !== 200) {
          throw new Error(
            `${path}: ${response.status} ${await response.text()}`,
          );
        }
        return response.text();
      };
      /** Follows the module's imports to the string it default-exports. */
      const exported = async (path: string): Promise<string> => {
        const code = await get(path);
        const value = /export default "([^"]+)"/.exec(code)?.[1];
        if (value !== undefined) return value;
        const next = /from\s+"([^"]+)"/.exec(code)?.[1];
        if (next === undefined) throw new Error(`${path} exports no string`);
        return exported(next);
      };
      const url = await exported("/app/main.js");
      expect(url).toMatch(/^\/app\/@fs\/.*\/fetcher\.js$/);
      // The space and the literal % arrive encoded.
      expect(url).toContain("lib%20%2541");
      expect(await get(url)).toContain("fetched");
    } finally {
      await server.close();
    }
  });

  it("the dev server's module runner loads the fetcher from its URL", async () => {
    const server = await createServer({
      ...devOptions(),
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        fs: { allow: [base] },
      },
      appType: "custom",
    });
    try {
      const main = (await server.ssrLoadModule("/main.js")) as unknown as Main;
      // An absolute path, which the runner resolves without decoding.
      expect(main.url).toBe(join(base, LIB, "fetcher.js"));
      const fetcher = (await server.ssrLoadModule(
        main.url,
      )) as unknown as FetcherModule;
      expect(fetcher.default.fetch()).toBe("fetched");
    } finally {
      await server.close();
    }
  });

  it("an installed tscache is bundled in dev SSR, so its import() of the fetcher URL resolves (R1-4)", async () => {
    // A stand-in for an installed tscache, which Vite would externalize: its
    // import() would then run in plain Node, where /@fs/ paths mean nothing.
    await mkdir(join(root, "node_modules", "tscache"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "tscache", "package.json"),
      '{ "name": "tscache", "type": "module", "exports": "./index.js" }\n',
    );
    await writeFile(
      join(root, "node_modules", "tscache", "index.js"),
      "export const load = (url) => import(/* @vite-ignore */ url);\n",
    );
    await writeFile(
      join(root, "ssr.js"),
      `import { load } from "tscache";\nimport url from "../${LIB}/fetcher.js?fetcher";\nexport const fetcher = () => load(url);\n`,
    );
    const server = await createServer({
      ...devOptions(),
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        fs: { allow: [base] },
      },
      appType: "custom",
    });
    try {
      const ssr = (await server.ssrLoadModule("/ssr.js")) as unknown as {
        fetcher(): Promise<FetcherModule>;
      };
      expect((await ssr.fetcher()).default.fetch()).toBe("fetched");
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
  it("a fetcher's import() of code the page shares runs without document, as in a worker (R3-1)", async () => {
    const app = join(base, "preload");
    await mkdir(app, { recursive: true });
    // shared.js is used by the fetcher's decoder and by the page's lazy
    // module, so it becomes a chunk of its own and both imports carry a
    // preload list (two entries: the module and shared.js).
    const files: Record<string, string> = {
      "shared.js": "export const unit = (s) => s + 'fetched';\n",
      "decoder.js":
        "import { unit } from './shared.js';\nexport const decode = () => unit('');\n",
      "fetcher.js":
        "export default { async fetch() { const { decode } = await import('./decoder.js'); return decode(); } };\n",
      "lazy.js":
        "import { unit } from './shared.js';\nexport const lazy = () => unit('page ');\n",
      "main.js":
        "import url from './fetcher.js?fetcher';\nimport('./lazy.js').then((m) => console.log(m.lazy(), url));\n",
      "index.html": '<script type="module" src="/main.js"></script>\n',
    };
    for (const [name, code] of Object.entries(files)) {
      await writeFile(join(app, name), code);
    }
    const outDir = join(app, "dist");
    // The app's own resolveDependencies still runs, for the page's imports.
    const hosts: string[] = [];
    await build({
      root: app,
      configFile: false,
      logLevel: "silent",
      plugins: [fetcherUrl()],
      build: {
        outDir,
        modulePreload: {
          resolveDependencies: (
            _file: string,
            deps: string[],
            context: { hostId: string },
          ) => {
            hosts.push(context.hostId);
            return deps;
          },
        },
      },
    });
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.every((host) => !host.includes("fetcher-"))).toBe(true);
    const { readdir, readFile } = await load<{
      readdir(path: string): Promise<string[]>;
      readFile(path: string, encoding: "utf8"): Promise<string>;
    }>("node:fs/promises");
    const assets = await readdir(join(outDir, "assets"));
    const fetcherFile = assets.find((f) => f.startsWith("fetcher-"));
    expect(fetcherFile).toBeDefined();
    const href = pathToFileURL(join(outDir, "assets", fetcherFile ?? "")).href;
    // Plain Node has no document, as a worker has none.
    const output = await runInNode(
      `const m = await import(${JSON.stringify(href)});\nprocess.stdout.write(await m.default.fetch());`,
    );
    expect(output).toBe("fetched");
    // The page's own lazy import keeps its preload list.
    const page = await Promise.all(
      assets
        .filter((f) => f.startsWith("index-") && f.endsWith(".js"))
        .map((f) => readFile(join(outDir, "assets", f), "utf8")),
    );
    expect(page.join("")).toContain("__vite__mapDeps");
  });
});

describe("devUrl (R1-3, R2-1)", () => {
  it.each([
    ["/", "/repo/fetcher.ts", "/@fs/repo/fetcher.ts"],
    ["/app", "/repo/fetcher.ts", "/app/@fs/repo/fetcher.ts"],
    ["/", "C:/repo/fetcher.ts", "/@fs/C:/repo/fetcher.ts"],
    ["/app/", "C:/a b/%41/f.ts", "/app/@fs/C:/a%20b/%2541/f.ts"],
  ])("base %s, file %s → %s", (prefix, file, url) => {
    expect(devUrl(prefix, file)).toBe(url);
  });
});

describe("serverFileUrl (R3-2)", () => {
  it.each([
    ["assets/f.mjs", "./assets/f.mjs"],
    ["./assets/f.mjs", "./assets/f.mjs"],
    ["../x/f.mjs", "../x/f.mjs"],
    ["assets %41 #?/f.mjs", "./assets%20%2541%20%23%3F/f.mjs"],
    ["a b/f-!~{001}~.mjs", "./a%20b/f-!~{001}~.mjs"],
  ])("%s → %s", (relativePath, encoded) => {
    expect(serverFileUrl(relativePath)).toBe(
      `new URL(${JSON.stringify(encoded)}, import.meta.url).href`,
    );
  });
});
