import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetcherUrl } from "../src/entries/vite";

/**
 * Node's modules and Vite, loaded through specifiers TypeScript does not
 * resolve, as in vite-fetcher-url.test.ts: the package's type check keeps
 * Node's types out.
 */
const load = <T>(specifier: string): Promise<T> =>
  import(/* @vite-ignore */ specifier) as Promise<T>;
const { mkdtemp, realpath, rm, writeFile } = await load<{
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
const { fileURLToPath } = await load<{ fileURLToPath(url: URL): string }>(
  "node:url",
);
const { build, createBuilder } = await load<{
  build(config: object): Promise<unknown>;
  createBuilder(config: object): Promise<{ buildApp(): Promise<void> }>;
}>("vite");

// Implementer tests (step 54, option C of step 53): with Vite's default
// worker format, 'iife', the worker cannot code-split and its import() of
// the persistence chunk (§4.10.8) is inlined, so the plugin warns when a
// browser environment builds. It never changes the config, and stays quiet
// in dev, for 'es' and for a server environment, which builds no worker.

type Plugin = ReturnType<typeof fetcherUrl>;
type Environment = ThisParameterType<Plugin["buildStart"]>["environment"];

/** An environment whose logger records its warnings. */
function environment(
  mode: "build" | "dev",
  format: "es" | "iife",
  consumer: "client" | "server" = "client",
): { context: { environment: Environment }; warnings: string[] } {
  const warnings: string[] = [];
  const config = {
    consumer,
    worker: { format },
    logger: { warn: (message: string) => warnings.push(message) },
  };
  return { context: { environment: { mode, config } }, warnings };
}

describe("fetcherUrl warns about an IIFE worker (step 54)", () => {
  it("warns once in a build whose worker format is 'iife', naming the fix and the guide", () => {
    const plugin = fetcherUrl();
    const { context, warnings } = environment("build", "iife");
    plugin.buildStart.call(context);
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning).toContain("worker: { format: 'es' }");
    expect(warning).toContain("iife");
    expect(warning).toContain(
      "https://github.com/anishbenji/tscache/blob/main/site/guides/vite.md",
    );
  });

  it("warns only once when the environment builds again", () => {
    const plugin = fetcherUrl();
    const { context, warnings } = environment("build", "iife");
    plugin.buildStart.call(context);
    plugin.buildStart.call(context);
    expect(warnings).toHaveLength(1);
  });

  it("says nothing in a build whose worker format is 'es'", () => {
    const plugin = fetcherUrl();
    const { context, warnings } = environment("build", "es");
    plugin.buildStart.call(context);
    expect(warnings).toEqual([]);
  });

  it("says nothing when a server environment builds (format 'iife')", () => {
    const plugin = fetcherUrl();
    const { context, warnings } = environment("build", "iife", "server");
    plugin.buildStart.call(context);
    expect(warnings).toEqual([]);
  });

  it.each(["iife", "es"] as const)(
    "says nothing on the dev server (format %s)",
    (format) => {
      const plugin = fetcherUrl();
      const { context, warnings } = environment("dev", format);
      plugin.buildStart.call(context);
      expect(warnings).toEqual([]);
    },
  );

  it("leaves the worker format as it is", () => {
    const plugin = fetcherUrl();
    const { context } = environment("build", "iife");
    plugin.buildStart.call(context);
    expect(context.environment.config.worker.format).toBe("iife");
    expect(plugin.config()).not.toHaveProperty("worker");
  });
});

describe("fetcherUrl's IIFE warning in a real Vite build (step 54)", () => {
  let root = "";
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "tscache-iife-")));
    await writeFile(join(root, "main.js"), "export const page = 1;\n");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Builds the app without writing it, returning the logger's warnings. */
  async function warningsOf(worker: object): Promise<string[]> {
    const warnings: string[] = [];
    const ignore = () => undefined;
    await build({
      root,
      configFile: false,
      plugins: [fetcherUrl()],
      worker,
      customLogger: {
        info: ignore,
        warn: (message: string) => warnings.push(message),
        warnOnce: (message: string) => warnings.push(message),
        error: ignore,
        clearScreen: ignore,
        hasErrorLogged: () => false,
        hasWarned: false,
      },
      build: {
        write: false,
        rollupOptions: { input: join(root, "main.js") },
      },
    });
    return warnings.filter((message) => message.includes("tscache"));
  }

  it("warns once with Vite's default worker format", async () => {
    const warnings = await warningsOf({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("worker: { format: 'es' }");
  });

  it("says nothing with worker: { format: 'es' }", async () => {
    expect(await warningsOf({ format: "es" })).toEqual([]);
  });
});

// Review finding PR-1/PR-2 (step 54): Vite 8 resolves the config again for
// each environment of `vite build --app` (builder.sharedConfigBuild defaults
// to false), and each resolve reloads vite.config.ts, which calls
// fetcherUrl() again. Only these tests load a real config file, as the
// examples' builds do; the tests above pass the plugin inline, so every
// resolve shares one instance.
describe("fetcherUrl's IIFE warning with a config file (step 54)", () => {
  let root = "";
  const entry = fileURLToPath(
    new URL("../src/entries/vite.ts", import.meta.url),
  );
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "tscache-iife-app-")));
    await writeFile(join(root, "main.js"), "export const page = 1;\n");
    await writeFile(join(root, "server.js"), "export const render = 1;\n");
    await writeFile(
      join(root, "vite.config.mjs"),
      [
        `import { fetcherUrl } from ${JSON.stringify(entry)};`,
        "export default {",
        "  plugins: [fetcherUrl()],",
        "  environments: {",
        `    client: { build: { rollupOptions: { input: ${JSON.stringify(join(root, "main.js"))} } } },`,
        `    ssr: { build: { rollupOptions: { input: ${JSON.stringify(join(root, "server.js"))} } } },`,
        "  },",
        "};",
        "",
      ].join("\n"),
    );
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** The inline config both builds share, recording the logger's warnings. */
  function inline(warnings: string[], extra: object): object {
    const ignore = () => undefined;
    return {
      root,
      configFile: join(root, "vite.config.mjs"),
      customLogger: {
        info: ignore,
        warn: (message: string) => warnings.push(message),
        warnOnce: (message: string) => warnings.push(message),
        error: ignore,
        clearScreen: ignore,
        hasErrorLogged: () => false,
        hasWarned: false,
      },
      ...extra,
    };
  }

  it("warns once in a `vite build --app` of a client and a server environment", async () => {
    const warnings: string[] = [];
    const builder = await createBuilder(
      inline(warnings, { builder: {}, build: { write: false } }),
    );
    await builder.buildApp();
    expect(warnings.filter((m) => m.startsWith("[tscache]"))).toHaveLength(1);
  });

  it("says nothing in a server-only build (`vite build --ssr`)", async () => {
    const warnings: string[] = [];
    await build(
      inline(warnings, {
        build: { write: false, ssr: join(root, "server.js") },
      }),
    );
    expect(warnings.filter((m) => m.startsWith("[tscache]"))).toEqual([]);
  });
});
