// What each package entry costs an application: every entry of the built
// package (packages/tscache/dist) bundled on its own, minified, with its
// shared chunks, and compressed as a server would send it. What an entry
// loads with `import()` (the worker's persistence chunk, §4.10.8) is left
// out of it and reported on a row of its own, `<entry> (lazy)`, bundled
// without what the entry already holds: an application that never takes
// that path never loads it. Fails when an entry or its lazy part exceeds
// its budget in packages/tscache/bench/budgets.json, or when a file of the
// built package imports an entry file (a worker loaded under a URL with a
// query would then evaluate its entry twice).
//
//   bun scripts/size.ts            check against the budgets
//   bun scripts/size.ts --update   rewrite the budgets from this build
//
// A budget is the size measured when it was set plus max(512 B, 3 %), so
// small changes pass and a new dependency or a duplicated module does not.
// Raising one is a reviewed edit of budgets.json in the pull request that
// needs it (docs/benchmarking.md).

import {
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { budgetFor, checkRow, parseBudgets } from "./size-budget";

const ROOT = new URL("../packages/tscache/", import.meta.url);
const BUDGETS = fileURLToPath(new URL("bench/budgets.json", ROOT));
const DIST = fileURLToPath(new URL("dist/", ROOT));

/** The package's entries, and whether each runs in a browser. */
const ENTRIES = {
  index: "browser",
  worker: "browser",
  engine: "browser",
  fetcher: "browser",
  vite: "node",
} as const;

type Entry = keyof typeof ENTRIES;

interface Size {
  minified: number;
  gzip: number;
  brotli: number;
}

interface Budgets {
  /**
   * Brotli bytes each entry may reach; `<entry>:lazy` for what it loads
   * with `import()`.
   */
  brotli: Record<string, number>;
}

/** A dist file's source, by the relative specifier that names it. */
const source = (specifier: string) =>
  readFileSync(`${DIST}${specifier.slice(2)}`, "utf8");

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
function closure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...importsOf(source(file)).static);
  }
  return seen;
}

/** Fails when a file of the built package imports one of its entry files. */
function checkEntryImports(): void {
  const entryFiles = new Set(Object.keys(ENTRIES).map((e) => `./${e}.js`));
  for (const file of readdirSync(DIST).filter((f) => f.endsWith(".js"))) {
    const { static: deps, dynamic } = importsOf(source(`./${file}`));
    const bad = [...deps, ...dynamic].filter((dep) => entryFiles.has(dep));
    if (bad.length > 0) {
      throw new Error(
        `dist/${file} imports the entry file ${bad.join(", ")}: an entry must only be loaded as an entry`,
      );
    }
  }
}

/** Leaves the named dist files out of a bundle, as imports. */
function leaveOut(files: ReadonlySet<string>): Bun.BunPlugin {
  return {
    name: "leave-out",
    setup(build) {
      build.onResolve({ filter: /^\.\// }, (args) =>
        files.has(args.path) ? { path: args.path, external: true } : undefined,
      );
    },
  };
}

/** A dist file bundled into one, minified, without `left`, and its sizes. */
async function bundle(
  file: string,
  target: "browser" | "node",
  left: ReadonlySet<string>,
): Promise<Size> {
  const result = await Bun.build({
    entrypoints: [`${DIST}${file.slice(2)}`],
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

/**
 * An entry's initial load, bundled into one file as an application's
 * bundler would, and what it loads with `import()`: each lazy chunk bundled
 * without the files the initial load already holds.
 */
async function measure(
  entry: Entry,
): Promise<{ initial: Size; lazy: Size | undefined }> {
  const reached = closure([`./${entry}.js`]);
  const lazyRoots = new Set(
    [...reached].flatMap((file) => importsOf(source(file)).dynamic),
  );
  const initial = await bundle(`./${entry}.js`, ENTRIES[entry], lazyRoots);
  if (lazyRoots.size === 0) return { initial, lazy: undefined };
  const lazy = await Promise.all(
    [...lazyRoots].map((root) => bundle(root, ENTRIES[entry], reached)),
  );
  return { initial, lazy: total(lazy) };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(2)} kB`;

const update = process.argv.includes("--update");
const budgets: Readonly<Record<string, number>> = update
  ? {}
  : parseBudgets(readFileSync(BUDGETS, "utf8"));

const rows: string[] = [
  "| Entry | Minified | Gzip | Brotli | Budget (brotli) | |",
  "|---|---:|---:|---:|---:|---|",
];
const measured: Record<string, number> = {};
let over = 0;
const missing: string[] = [];
function row(label: string, key: string, size: Size): void {
  measured[key] = size.brotli;
  const check = checkRow(
    update ? "update" : "check",
    budgets,
    key,
    size.brotli,
  );
  if (check.status === "over") over++;
  if (check.status === "missing") missing.push(key);
  const budget = check.status === "missing" ? "none" : kb(check.budget);
  const verdict =
    check.status === "ok"
      ? "ok"
      : check.status === "over"
        ? "**over**"
        : "**no budget**";
  rows.push(
    `| \`${label}\` | ${kb(size.minified)} | ${kb(size.gzip)} | ${kb(size.brotli)} | ${budget} | ${verdict} |`,
  );
}
checkEntryImports();
for (const entry of Object.keys(ENTRIES) as Entry[]) {
  const { initial, lazy } = await measure(entry);
  row(entry, entry, initial);
  if (lazy !== undefined) row(`${entry} (lazy)`, `${entry}:lazy`, lazy);
}

const table = rows.join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Package entry sizes\n\n${table}\n\n`,
  );
}

if (update) {
  const next: Budgets = {
    brotli: Object.fromEntries(
      Object.entries(measured).map(([entry, bytes]) => [
        entry,
        budgetFor(bytes),
      ]),
    ),
  };
  writeFileSync(BUDGETS, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nbudgets written to ${BUDGETS}`);
} else if (missing.length > 0) {
  console.error(
    `\nno committed budget for ${missing.join(", ")}: add one to packages/tscache/bench/budgets.json (bun scripts/size.ts --update, then review it), with the reason in the commit (docs/benchmarking.md).`,
  );
  process.exit(1);
} else if (over > 0) {
  console.error(
    `\n${over} entr${over === 1 ? "y is" : "ies are"} over budget: shrink it, or raise the budget in packages/tscache/bench/budgets.json with the reason in the commit (docs/benchmarking.md).`,
  );
  process.exit(1);
}
