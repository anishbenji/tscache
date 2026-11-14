import { describe, expect, it } from "vitest";
import { fetcherUrl } from "../src/entries/vite";
import { devUrl, serverFileUrl } from "../src/vite/urls";

// Implementer tests (step 109): fetcherUrl's hooks called directly, one
// path each, including the guards the real builds and dev servers of
// vite-fetcher-url.test.ts never reach. They pin the plugin's behaviour
// while its hooks move into module functions.

type Plugin = ReturnType<typeof fetcherUrl>;
type Context = ThisParameterType<Plugin["load"]>;
type Bundle = Parameters<Plugin["generateBundle"]>[1];

const FILE = "/repo/lib %41/fetcher.ts";
const OTHER = "/repo/other.ts";

interface Fake {
  context: Context;
  emitted: unknown[];
  /** The arguments of every `resolve` call, in order. */
  resolved: unknown[][];
}

/**
 * A plugin context in `consumer`'s environment that resolves `./fetcher`
 * and `./same` to FILE, `./other` to OTHER and nothing else, and numbers
 * the chunks it emits, recording each `resolve` call.
 */
function fake(consumer: "client" | "server" = "client"): Fake {
  const emitted: unknown[] = [];
  const resolved: unknown[][] = [];
  const ids: Record<string, string> = {
    "./fetcher": FILE,
    "./same": FILE,
    "./other": OTHER,
  };
  const context: Context = {
    async resolve(source, importer, options) {
      resolved.push([source, importer, options]);
      const id = ids[source];
      return id === undefined ? null : { id };
    },
    emitFile(file) {
      emitted.push(file);
      return `ref${emitted.length}`;
    },
    environment: { config: { consumer } },
  };
  return { context, emitted, resolved };
}

/** A plugin after Vite resolved its config. */
function plugin(command: "build" | "serve", base = "/"): Plugin {
  const p = fetcherUrl();
  p.configResolved({ command, base });
  return p;
}

/** The virtual id `resolveId` gives `source`. */
async function virtualId(p: Plugin, source: string): Promise<string> {
  const id = await p.resolveId.call(fake().context, source, "/repo/main.ts");
  if (id === undefined) throw new Error(`${source} did not resolve`);
  return id;
}

describe("fetcherUrl's plugin (step 109)", () => {
  it("is named tscache:fetcher-url", () => {
    expect(fetcherUrl().name).toBe("tscache:fetcher-url");
  });

  it("warns, word for word, when a browser build makes IIFE workers", () => {
    const warnings: string[] = [];
    fetcherUrl().buildStart.call({
      environment: {
        mode: "build",
        config: {
          consumer: "client",
          worker: { format: "iife" },
          logger: { warn: (message: string) => warnings.push(message) },
        },
      },
    });
    expect(warnings).toEqual([
      "[tscache] Vite builds workers as IIFE (worker.format 'iife'), which cannot code-split: the tscache worker's persistence code is inlined into the worker file, so every app downloads it, persisting or not. Set worker: { format: 'es' } in vite.config.ts to make it a chunk the worker loads only when a cache persists. See https://github.com/anishbenji/tscache/blob/main/site/guides/vite.md",
    ]);
  });
});

describe("fetcherUrl's resolveId (step 109)", () => {
  it("resolves the import without its query, from its importer, skipping itself", async () => {
    const p = plugin("build");
    const { context, resolved } = fake();
    await p.resolveId.call(context, "./fetcher?fetcher", "/repo/main.ts");
    expect(resolved).toEqual([
      ["./fetcher", "/repo/main.ts", { skipSelf: true }],
    ]);
  });

  it("leaves an import whose query only contains ?fetcher alone", async () => {
    const p = plugin("build");
    const { context, resolved } = fake();
    expect(
      await p.resolveId.call(context, "./x?fetcher&y", "/repo/main.ts"),
    ).toBeUndefined();
    expect(resolved).toEqual([]);
  });

  it("gives nothing for a ?fetcher import whose module does not resolve", async () => {
    const p = plugin("build");
    expect(
      await p.resolveId.call(fake().context, "./missing?fetcher", undefined),
    ).toBeUndefined();
  });

  it("gives one virtual id per file, whichever specifier reaches it", async () => {
    const p = plugin("build");
    const first = await virtualId(p, "./fetcher?fetcher");
    expect(first).toBe("\0tscache-fetcher-url:0");
    expect(await virtualId(p, "./same?fetcher")).toBe(first);
    expect(await virtualId(p, "./other?fetcher")).toBe(
      "\0tscache-fetcher-url:1",
    );
  });
});

describe("fetcherUrl's load (step 109)", () => {
  it("loads nothing for another id, or a virtual id it never gave", async () => {
    const p = plugin("build");
    await virtualId(p, "./fetcher?fetcher");
    const { context, emitted } = fake();
    expect(p.load.call(context, "/repo/main.ts")).toBeUndefined();
    expect(p.load.call(context, "\0tscache-fetcher-url:1")).toBeUndefined();
    expect(emitted).toEqual([]);
  });

  it("in a build, emits the file as a chunk with its signature kept", async () => {
    const p = plugin("build");
    const id = await virtualId(p, "./fetcher?fetcher");
    const { context, emitted } = fake();
    expect(p.load.call(context, id)).toBe(
      "export default import.meta.ROLLUP_FILE_URL_ref1;",
    );
    expect(emitted).toEqual([
      { type: "chunk", id: FILE, preserveSignature: "strict" },
    ]);
  });

  it("in dev, gives the browser an encoded URL under the base, emitting nothing", async () => {
    const p = plugin("serve", "/app");
    const id = await virtualId(p, "./fetcher?fetcher");
    const { context, emitted } = fake("client");
    expect(p.load.call(context, id)).toBe(
      `export default ${JSON.stringify(devUrl("/app", FILE))};`,
    );
    expect(emitted).toEqual([]);
  });

  it("in dev, gives server code the file's absolute path", async () => {
    const p = plugin("serve", "/app");
    const id = await virtualId(p, "./fetcher?fetcher");
    const { context, emitted } = fake("server");
    expect(p.load.call(context, id)).toBe(
      `export default ${JSON.stringify(FILE)};`,
    );
    expect(emitted).toEqual([]);
  });
});

describe("fetcherUrl's resolveFileUrl (step 109)", () => {
  const options = { referenceId: "ref1", relativePath: "assets/f.mjs" };

  it("gives a server environment a file URL of an emitted fetcher chunk", async () => {
    const p = plugin("build");
    const id = await virtualId(p, "./fetcher?fetcher");
    const { context } = fake("server");
    p.load.call(context, id);
    expect(p.resolveFileUrl.call(context, options)).toBe(
      serverFileUrl("assets/f.mjs"),
    );
  });

  it("leaves a browser environment's URL, and another file's, to Vite", async () => {
    const p = plugin("build");
    const id = await virtualId(p, "./fetcher?fetcher");
    p.load.call(fake("client").context, id);
    expect(p.resolveFileUrl.call(fake("client").context, options)).toBeNull();
    expect(
      p.resolveFileUrl.call(fake("server").context, {
        ...options,
        referenceId: "ref2",
      }),
    ).toBeNull();
  });
});

describe("fetcherUrl's generateBundle (step 109)", () => {
  const HELPER = "window.dispatchEvent(new Event('vite:preloadError'))";

  /**
   * Runs the bundle check with the fetchers `sources` name (FILE's by
   * default); gives the error it raised, if any.
   */
  async function check(
    bundle: Bundle,
    sources: string[] = ["./fetcher?fetcher"],
  ): Promise<string | undefined> {
    const p = plugin("build");
    for (const source of sources) await virtualId(p, source);
    const errors: string[] = [];
    const context = {
      error(message: string): never {
        errors.push(message);
        throw new Error(message);
      },
    };
    try {
      p.generateBundle.call(context, {}, bundle);
    } catch (error) {
      if (errors.length === 0) throw error;
    }
    return errors[0];
  }

  it("fails on the helper in a chunk the fetcher imports, naming both chunks", async () => {
    const message = await check({
      "fetcher.js": {
        type: "chunk",
        code: "",
        facadeModuleId: FILE,
        imports: ["a.js"],
      },
      "a.js": { type: "chunk", code: "", dynamicImports: ["b.js"] },
      "b.js": { type: "chunk", code: HELPER },
    });
    expect(message).toMatch(/^The fetcher fetcher\.js uses import\(\)/);
    expect(message).toContain("(in b.js)");
  });

  it("fails with the whole message, naming the fetcher and the chunk", async () => {
    const message = await check({
      "fetcher.js": {
        type: "chunk",
        code: "",
        facadeModuleId: FILE,
        imports: ["a.js"],
      },
      "a.js": { type: "chunk", code: HELPER },
    });
    expect(message).toBe(
      `The fetcher fetcher.js uses import(): Vite wraps it in a helper (in a.js) that needs document and window, which tscache's worker lacks. Import the fetcher's dependencies statically, or build the fetcher on its own and pass that file's URL instead of using ?fetcher (see "Building the fetcher on its own" in tscache's worker setup guide).`,
    );
  });

  it("checks every fetcher: fails on the second when only it reaches the helper", async () => {
    const message = await check(
      {
        "fetcher.js": { type: "chunk", code: "", facadeModuleId: FILE },
        "other.js": {
          type: "chunk",
          code: "",
          facadeModuleId: OTHER,
          dynamicImports: ["lazy.js"],
        },
        "lazy.js": { type: "chunk", code: HELPER },
      },
      ["./fetcher?fetcher", "./other?fetcher"],
    );
    expect(message).toMatch(/^The fetcher other\.js uses import\(\)/);
    expect(message).toContain("(in lazy.js)");
  });

  it("fails on the helper in the fetcher's own chunk", async () => {
    const message = await check({
      "fetcher.js": { type: "chunk", code: HELPER, facadeModuleId: FILE },
    });
    expect(message).toContain("The fetcher fetcher.js uses import()");
    expect(message).toContain("(in fetcher.js)");
  });

  it("passes a fetcher graph without the helper, cycles and missing chunks included", async () => {
    expect(
      await check({
        "fetcher.js": {
          type: "chunk",
          code: "",
          facadeModuleId: FILE,
          imports: ["a.js", "gone.js"],
        },
        "a.js": { type: "chunk", code: "", imports: ["fetcher.js"] },
        "page.js": { type: "chunk", code: HELPER, facadeModuleId: OTHER },
      }),
    ).toBeUndefined();
  });

  it("checks only chunks: an asset of the fetcher's file is not a fetcher", async () => {
    expect(
      await check({
        "fetcher.txt": { type: "asset", code: HELPER, facadeModuleId: FILE },
      }),
    ).toBeUndefined();
  });
});
