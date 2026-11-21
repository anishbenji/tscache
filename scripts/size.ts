// What each package entry costs an application: every entry of the built
// package (packages/tscache/dist) bundled on its own, minified, with its
// shared chunks, and compressed as a server would send it. What an entry
// loads with `import()` (the worker's persistence chunk, §4.10.8) is left
// out of it and reported on a row of its own, `<entry> (lazy)`, bundled
// without what the entry already holds: an application that never takes
// that path never loads it. What a lazy chunk loads with `import()` in turn
// (the in-process hosting's clear-only call, §4.10.7) is left out of it the
// same way and reported on `<entry> (lazy, nested)`, bundled without what
// the entry and the lazy chunks above it hold. Fails when an entry or its lazy part exceeds
// its budget in packages/tscache/bench/budgets.json, or when a file of the
// built package imports an entry file (a worker loaded under a URL with a
// query would then evaluate its entry twice). The measurement itself is in
// scripts/size-measure.ts: a chunk left out of a bundle is named there with
// its content hash replaced by a constant, so that an edit to comments alone
// moves no size.
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
import { budgetFor, checkRow, parseBudgets } from "./size-budget";
import { checkEntryImports, measureEntry, type Size } from "./size-measure";

const ROOT = new URL("../packages/tscache/", import.meta.url);
const BUDGETS = fileURLToPath(new URL("bench/budgets.json", ROOT));
const DIST = fileURLToPath(new URL("dist/", ROOT));

/** The package's entries, and whether each runs in a browser. */
const ENTRIES = {
  index: "browser",
  worker: "browser",
  engine: "browser",
  fetcher: "browser",
  grid: "browser",
  vite: "node",
} as const;

type Entry = keyof typeof ENTRIES;

interface Budgets {
  /**
   * Brotli bytes each entry may reach; `<entry>:lazy` for what it loads
   * with `import()`.
   */
  brotli: Record<string, number>;
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
checkEntryImports(DIST, Object.keys(ENTRIES));
for (const entry of Object.keys(ENTRIES) as Entry[]) {
  const { initial, lazy, nested } = await measureEntry(
    DIST,
    entry,
    ENTRIES[entry],
  );
  row(entry, entry, initial);
  if (lazy !== undefined) row(`${entry} (lazy)`, `${entry}:lazy`, lazy);
  if (nested !== undefined) {
    row(`${entry} (lazy, nested)`, `${entry}:lazy:nested`, nested);
  }
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
