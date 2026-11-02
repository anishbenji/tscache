import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Node's modules and Vite, loaded through specifiers TypeScript does not
 * resolve, as in vite-fetcher-url.test.ts: the package's type check keeps
 * Node's types out.
 */
const load = <T>(specifier: string): Promise<T> =>
  import(/* @vite-ignore */ specifier) as Promise<T>;
const { mkdtemp, readFile, realpath, rm, writeFile } = await load<{
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  realpath(path: string): Promise<string>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}>("node:fs/promises");
const { tmpdir } = await load<{ tmpdir(): string }>("node:os");
const { dirname, join } = await load<{
  dirname(path: string): string;
  join(...parts: string[]): string;
}>("node:path");
const { fileURLToPath, pathToFileURL } = await load<{
  fileURLToPath(url: string): string;
  pathToFileURL(path: string): URL;
}>("node:url");
const { build } = await load<{ build(config: object): Promise<unknown> }>(
  "vite",
);

// Implementer tests (§4.10.8): the worker entry loads its persistence code
// with import(), and an app built with Vite's `?worker&url` must still get a
// worker that runs. Vite's worker builds carry no module-preload helper
// (which reads `document`, absent in a worker; step 16 R3-1); with
// `worker.format: 'es'` the persistence code is a chunk of its own that the
// worker entry does not hold, and with the default 'iife' it is inlined.

const WORKER = fileURLToPath(
  new URL("../src/entries/worker.ts", import.meta.url).href,
);
/** A string only `engine/restore.ts` holds: marks the persistence code. */
const PERSIST_MARK = "records apply only into a cache that knows nothing";

let root = "";
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "tscache-vite-worker-")));
  await writeFile(
    join(root, "main.js"),
    `import url from ${JSON.stringify(`${WORKER}?worker&url`)};\nexport { url };\n`,
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A relative module specifier, in any quotes the minifier picks. */
const SPECIFIER = String.raw`["'\`](\.{1,2}/[^"'\`]+\.js)["'\`]`;
const IMPORT = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*)${SPECIFIER}`,
  "g",
);
const DYNAMIC = new RegExp(String.raw`\bimport\s*\(\s*${SPECIFIER}\s*\)`);

/** The relative files a module imports, statically and with import(). */
function importsOf(code: string): string[] {
  return [...code.matchAll(IMPORT)].map((m) => m[1] as string);
}

/** Builds the app with the worker format; the worker's files, entry first. */
async function workerFiles(format: "es" | "iife"): Promise<string[]> {
  const outDir = join(root, format);
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    worker: { format },
    build: {
      outDir,
      rollupOptions: {
        input: join(root, "main.js"),
        preserveEntrySignatures: "strict",
        output: { entryFileNames: "[name].js" },
      },
    },
  });
  const { url } = (await import(
    pathToFileURL(join(outDir, "main.js")).href
  )) as { url: string };
  const files: string[] = [];
  const pending = [join(outDir, url.slice(1))];
  for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
    if (files.includes(file)) continue;
    files.push(file);
    const code = await readFile(file, "utf8");
    pending.push(...importsOf(code).map((dep) => join(dirname(file), dep)));
  }
  return files;
}

describe("the worker entry under Vite's ?worker&url (§4.10.8)", () => {
  it("worker.format 'es': the persistence code is a chunk the entry loads with import(), without Vite's preload helper", async () => {
    const files = await workerFiles("es");
    const [entry, ...chunks] = await Promise.all(
      files.map((file) => readFile(file, "utf8")),
    );
    expect(entry).not.toContain(PERSIST_MARK);
    expect(entry).toMatch(DYNAMIC);
    expect(chunks.some((code) => code.includes(PERSIST_MARK))).toBe(true);
    // Vite keeps the code both share in the entry, which the chunk imports
    // by its own URL: the worker must run under that URL, unchanged
    // (docs/guides/worker-setup.md).
    expect(
      importsOf(chunks.find((c) => c.includes(PERSIST_MARK)) ?? "").map((dep) =>
        join(dirname(files[0] as string), dep),
      ),
    ).toContain(files[0]);
    for (const code of [entry, ...chunks]) {
      expect(code).not.toContain("vite:preloadError");
      expect(code).not.toMatch(/\bdocument\b/);
    }
  });

  it("the default worker.format 'iife': one file, the persistence code inlined, without the preload helper", async () => {
    const files = await workerFiles("iife");
    expect(files).toHaveLength(1);
    const code = await readFile(files[0] as string, "utf8");
    expect(code).toContain(PERSIST_MARK);
    expect(code).not.toContain("vite:preloadError");
    expect(code).not.toMatch(/\bdocument\b/);
  });
});
