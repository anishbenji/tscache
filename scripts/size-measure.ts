// How scripts/size.ts measures a package entry: every entry of a built
// package bundled on its own, minified, with its shared chunks, and
// compressed as a server would send it. What an entry loads with `import()`
// is measured apart from it (`lazy`), and what a lazy chunk loads with
// `import()` in turn apart from both (`nested`). Kept free of side effects so
// that a test can measure a fixture package (scripts/size-measure.test.ts).

import { readdirSync, readFileSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Where an entry runs. */
export type Target = "browser" | "node";

export interface Size {
  minified: number;
  gzip: number;
  brotli: number;
}

/** An entry's initial load, and what it loads with `import()`. */
export interface EntrySize {
  initial: Size;
  lazy: Size | undefined;
  nested: Size | undefined;
}

/** A dist file's source, by the relative specifier that names it. */
const source = (dist: string, specifier: string) =>
  readFileSync(`${dist}${specifier.slice(2)}`, "utf8");

/** The dist files a module imports, statically and with `import()`. */
function importsOf(code: string): { static: string[]; dynamic: string[] } {
  const relative = (re: RegExp) =>
    [...code.matchAll(re)].map((m) => m[1] as string);
  return {
    static: relative(/(?:\bfrom|\bimport)\s*"(\.\/[\w-]+\.js)"/g),
    dynamic: relative(/\bimport\s*\(\s*"(\.\/[\w-]+\.js)"\s*\)/g),
  };
}

/** The dist files `roots` reach through static imports, the roots included. */
function closure(dist: string, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...importsOf(source(dist, file)).static);
  }
  return seen;
}

/** Fails when a file of the built package imports one of its entry files. */
export function checkEntryImports(
  dist: string,
  entries: readonly string[],
): void {
  const entryFiles = new Set(entries.map((e) => `./${e}.js`));
  for (const file of readdirSync(dist).filter((f) => f.endsWith(".js"))) {
    const { static: deps, dynamic } = importsOf(source(dist, `./${file}`));
    const bad = [...deps, ...dynamic].filter((dep) => entryFiles.has(dep));
    if (bad.length > 0) {
      throw new Error(
        `dist/${file} imports the entry file ${bad.join(", ")}: an entry must only be loaded as an entry`,
      );
    }
  }
}

/**
 * A chunk's specifier with its content hash replaced by a constant of the
 * same length. tsdown names a chunk `<name>-<8-character hash>.js`, and the
 * hash changes with any edit to the chunk or to a chunk it imports, comments
 * included, although the minifier drops those comments; left in an import
 * string, it would move the compressed size by a few bytes of noise. An
 * application's bundler names the chunks it emits itself, so the package's
 * hashes never reach what its users download.
 */
function stableChunkName(specifier: string): string {
  const match = /^(\.\/[\w-]+)-[\w-]{8}\.js$/.exec(specifier);
  if (match === null) {
    throw new Error(
      `${specifier} is left out of a bundle but is not named <name>-<8-character hash>.js: update stableChunkName in scripts/size-measure.ts`,
    );
  }
  return `${match[1]}-00000000.js`;
}

/**
 * Leaves the named dist files out of a bundle, as imports whose specifiers
 * carry no content hash (`stableChunkName`).
 */
function leaveOut(files: ReadonlySet<string>): Bun.BunPlugin {
  const named = new Map<string, string>();
  return {
    name: "leave-out",
    setup(build) {
      build.onResolve({ filter: /^\.\// }, (args) => {
        if (!files.has(args.path)) return undefined;
        const path = stableChunkName(args.path);
        const other = named.get(path);
        if (other !== undefined && other !== args.path) {
          throw new Error(
            `${other} and ${args.path} would both be measured as ${path}`,
          );
        }
        named.set(path, args.path);
        return { path, external: true };
      });
    },
  };
}

/** A dist file bundled into one, minified, without `left`, and its sizes. */
async function bundle(
  dist: string,
  file: string,
  target: Target,
  left: ReadonlySet<string>,
): Promise<Size> {
  const result = await Bun.build({
    entrypoints: [`${dist}${file.slice(2)}`],
    target,
    format: "esm",
    minify: true,
    plugins: [leaveOut(left)],
    // The `./vite` entry runs inside Vite: Vite and Node's modules are the
    // application's, not the package's.
    external: ["vite", "node:*"],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `bundling ${file} failed`);
  }
  const output = result.outputs[0];
  if (output === undefined) throw new Error(`bundling ${file} gave nothing`);
  const code = Buffer.from(await output.arrayBuffer());
  return {
    minified: code.byteLength,
    gzip: gzipSync(code, { level: 9 }).byteLength,
    brotli: brotliCompressSync(code, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

/** Sums sizes. */
function total(sizes: Size[]): Size {
  return sizes.reduce(
    (sum, size) => ({
      minified: sum.minified + size.minified,
      gzip: sum.gzip + size.gzip,
      brotli: sum.brotli + size.brotli,
    }),
    { minified: 0, gzip: 0, brotli: 0 },
  );
}

/** The dist files that `files` load with `import()`, other than `except`. */
function dynamicOf(
  dist: string,
  files: Iterable<string>,
  except: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...files]
      .flatMap((file) => importsOf(source(dist, file)).dynamic)
      .filter((file) => !except.has(file)),
  );
}

/**
 * An entry's initial load, bundled into one file as an application's
 * bundler would, and what it loads with `import()`: each lazy chunk bundled
 * without the files the initial load already holds, and each chunk a lazy
 * chunk loads with `import()` in turn (nested) without the files the
 * initial load and the lazy chunks hold. A chunk's own `import()` targets
 * are left out of it, never inlined. `dist` is the built package's
 * directory, with a trailing slash.
 */
export async function measureEntry(
  dist: string,
  entry: string,
  target: Target,
): Promise<EntrySize> {
  const reached = closure(dist, [`./${entry}.js`]);
  const lazyRoots = dynamicOf(dist, reached, reached);
  const initial = await bundle(dist, `./${entry}.js`, target, lazyRoots);
  if (lazyRoots.size === 0) {
    return { initial, lazy: undefined, nested: undefined };
  }
  const lazyFiles = closure(dist, [...lazyRoots]);
  const held = new Set([...reached, ...lazyRoots]);
  const nestedRoots = dynamicOf(dist, lazyFiles, held);
  const lazy = await Promise.all(
    [...lazyRoots].map((root) =>
      bundle(dist, root, target, new Set([...reached, ...nestedRoots])),
    ),
  );
  const above = new Set([...reached, ...lazyFiles]);
  const deeper = dynamicOf(
    dist,
    closure(dist, [...nestedRoots]),
    new Set([...above, ...nestedRoots]),
  );
  if (deeper.size > 0) {
    throw new Error(
      `${entry}: a nested lazy chunk loads ${[...deeper].join(", ")} with import(); measure that level too`,
    );
  }
  const nested = await Promise.all(
    [...nestedRoots].map((root) => bundle(dist, root, target, above)),
  );
  return {
    initial,
    lazy: total(lazy),
    nested: nested.length === 0 ? undefined : total(nested),
  };
}
