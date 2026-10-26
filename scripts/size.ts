// What each package entry costs an application: every entry of the built
// package (packages/tscache/dist) bundled on its own, minified, with its
// shared chunks, and compressed as a server would send it. Fails when an
// entry exceeds its budget in packages/tscache/bench/budgets.json.
//
//   bun scripts/size.ts            check against the budgets
//   bun scripts/size.ts --update   rewrite the budgets from this build
//
// A budget is the size measured when it was set plus max(512 B, 3 %), so
// small changes pass and a new dependency or a duplicated module does not.
// Raising one is a reviewed edit of budgets.json in the pull request that
// needs it (docs/benchmarking.md).

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = new URL("../packages/tscache/", import.meta.url);
const BUDGETS = fileURLToPath(new URL("bench/budgets.json", ROOT));

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
  /** Brotli bytes each entry may reach. */
  brotli: Record<Entry, number>;
}

async function measure(entry: Entry): Promise<Size> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL(`dist/${entry}.js`, ROOT))],
    target: ENTRIES[entry],
    format: "esm",
    minify: true,
    // The `./vite` entry runs inside Vite: Vite and Node's modules are the
    // application's, not the package's.
    external: ["vite", "node:*"],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `bundling ${entry} failed`);
  }
  const output = result.outputs[0];
  if (output === undefined) throw new Error(`bundling ${entry} gave nothing`);
  const code = Buffer.from(await output.arrayBuffer());
  return {
    minified: code.byteLength,
    gzip: gzipSync(code, { level: 9 }).byteLength,
    brotli: brotliCompressSync(code, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

/** The budget for a size measured now: room for small changes. */
function budgetFor(bytes: number): number {
  return Math.ceil((bytes + Math.max(512, bytes * 0.03)) / 16) * 16;
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(2)} kB`;

const update = process.argv.includes("--update");
const budgets: Budgets | undefined = update
  ? undefined
  : JSON.parse(readFileSync(BUDGETS, "utf8"));

const rows: string[] = [
  "| Entry | Minified | Gzip | Brotli | Budget (brotli) | |",
  "|---|---:|---:|---:|---:|---|",
];
const measured = {} as Record<Entry, number>;
let over = 0;
for (const entry of Object.keys(ENTRIES) as Entry[]) {
  const size = await measure(entry);
  measured[entry] = size.brotli;
  const budget = budgets?.brotli[entry] ?? budgetFor(size.brotli);
  const fits = size.brotli <= budget;
  if (!fits) over++;
  rows.push(
    `| \`${entry}\` | ${kb(size.minified)} | ${kb(size.gzip)} | ${kb(size.brotli)} | ${kb(budget)} | ${fits ? "ok" : "**over**"} |`,
  );
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
    ) as Record<Entry, number>,
  };
  writeFileSync(BUDGETS, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nbudgets written to ${BUDGETS}`);
} else if (over > 0) {
  console.error(
    `\n${over} entr${over === 1 ? "y is" : "ies are"} over budget: shrink it, or raise the budget in packages/tscache/bench/budgets.json with the reason in the commit (docs/benchmarking.md).`,
  );
  process.exit(1);
}
