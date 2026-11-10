import { describe, expect, it } from "vitest";

// Implementer tests (architecture §4.9, N30): the orchestrator loads the
// fetcher module with a runtime import() of a specifier only known at run
// time. An application's bundler would otherwise replace that import with a
// stub that always rejects (webpack 5 and Rspack: an empty context; Turbopack:
// a stub that throws), so the import carries a hint for each bundler family
// to leave it alone. The hints are comments: they have no runtime behaviour
// to assert, so these tests read the source text instead, and fail if a
// refactor drops a hint or adds another non-literal import() without them.

/** Node's fs and url, through specifiers TypeScript does not resolve (vite-fetcher-url.test.ts). */
const load = <T>(specifier: string): Promise<T> =>
  import(/* @vite-ignore */ specifier) as Promise<T>;
const { readFile, readdir } = await load<{
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(
    path: string,
    options: { recursive: true },
  ): Promise<readonly string[]>;
}>("node:fs/promises");
const { fileURLToPath } = await load<{ fileURLToPath(url: URL): string }>(
  "node:url",
);

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * Every `import(` in code whose specifier is not a string literal, with the
 * comments written between the parenthesis and the specifier. A method such
 * as `#import(` is not the operator; `import()` in
 * prose (a closing parenthesis right after) is not a call and is skipped.
 */
const DYNAMIC =
  /(?<![\w#.$])import\(((?:\s*\/\*[\s\S]*?\*\/)*)\s*(?=[^\s"'`)])/g;

interface DynamicImport {
  file: string;
  comments: string;
}

async function dynamicImports(): Promise<DynamicImport[]> {
  const files = (await readdir(SRC, { recursive: true }))
    .filter((file) => file.endsWith(".ts"))
    .sort();
  const found: DynamicImport[] = [];
  for (const file of files) {
    const text = await readFile(`${SRC}${file}`, "utf8");
    for (const match of text.matchAll(DYNAMIC)) {
      found.push({ file, comments: (match[1] ?? "").trim() });
    }
  }
  return found;
}

describe("bundler hints on the fetcher import", () => {
  it("the fetcher import is the only import() of a non-literal specifier in src", async () => {
    const found = await dynamicImports();
    expect(found.map(({ file }) => file)).toEqual([
      "orchestrator/orchestrator.ts",
    ]);
  });

  it("tells Vite and webpack-family bundlers (webpack, Rspack, Turbopack) to leave it alone", async () => {
    const [fetcherImport] = await dynamicImports();
    expect(fetcherImport?.comments).toContain("/* @vite-ignore */");
    expect(fetcherImport?.comments).toContain("/* webpackIgnore: true */");
  });
});
