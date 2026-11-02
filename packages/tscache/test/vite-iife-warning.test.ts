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
const { build } = await load<{ build(config: object): Promise<unknown> }>(
  "vite",
);

// Implementer tests (step 54, option C of step 53): with Vite's default
// worker format, 'iife', the worker cannot code-split and its import() of
// the persistence chunk (§4.10.8) is inlined, so the plugin warns at build
// time. It never changes the config, and stays quiet in dev and for 'es'.

type Plugin = ReturnType<typeof fetcherUrl>;
type Resolved = Parameters<Plugin["configResolved"]>[0];

/** A resolved config whose logger records its warnings. */
function resolved(
  command: "build" | "serve",
  format: "es" | "iife",
): { config: Resolved; warnings: string[] } {
  const warnings: string[] = [];
  const config = {
    command,
    base: "/",
    worker: { format },
    logger: { warn: (message: string) => warnings.push(message) },
  };
  return { config, warnings };
}

describe("fetcherUrl warns about an IIFE worker (step 54)", () => {
  it("warns once in a build whose worker format is 'iife', naming the fix and the guide", () => {
    const plugin = fetcherUrl();
    const { config, warnings } = resolved("build", "iife");
    plugin.configResolved(config);
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning).toContain("worker: { format: 'es' }");
    expect(warning).toContain("iife");
    expect(warning).toContain(
      "https://github.com/anishbenji/tscache/blob/main/site/guides/vite.md",
    );
  });

  it("warns only once when the config resolves again", () => {
    const plugin = fetcherUrl();
    const { config, warnings } = resolved("build", "iife");
    plugin.configResolved(config);
    plugin.configResolved(config);
    expect(warnings).toHaveLength(1);
  });

  it("says nothing in a build whose worker format is 'es'", () => {
    const plugin = fetcherUrl();
    const { config, warnings } = resolved("build", "es");
    plugin.configResolved(config);
    expect(warnings).toEqual([]);
  });

  it.each(["iife", "es"] as const)(
    "says nothing on the dev server (format %s)",
    (format) => {
      const plugin = fetcherUrl();
      const { config, warnings } = resolved("serve", format);
      plugin.configResolved(config);
      expect(warnings).toEqual([]);
    },
  );

  it("leaves the worker format as it is", () => {
    const plugin = fetcherUrl();
    const { config } = resolved("build", "iife");
    plugin.configResolved(config);
    expect(config.worker.format).toBe("iife");
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
