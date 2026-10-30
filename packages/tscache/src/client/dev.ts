/**
 * Development-only console output (docs/architecture.md §2.7, resolved
 * decision #8): merge warnings are printed in the page that made the write,
 * once per put, in addition to the put result and the mergeWarning event.
 */

import type { MergeWarning } from "../types";

// Bundlers replace the exact text `process.env.NODE_ENV` at build time (Vite
// in development and production, webpack, Bun with --production), so it is
// read bare. A `typeof process` guard would silence development builds in
// the browser, where the replacement happens but `process` does not exist.
declare const process: { env: { NODE_ENV?: string } };

/**
 * Prints one console.warn listing every range and its fields, unless the
 * build is a production one. A page without `process` that no bundler
 * prepared counts as production: it has no development mode to detect.
 */
export function warnMerges(
  cacheId: string,
  warnings: readonly MergeWarning[],
  source: "put" | "fetch" = "put",
): void {
  if (warnings.length === 0) return;
  // Shaped so that a production build folds this to a bare return and
  // drops the rest of the function.
  try {
    if (process.env.NODE_ENV === "production") return;
  } catch {
    return;
  }
  const ranges = warnings
    .map((w) => `[${w.range.start}, ${w.range.end}] ${w.fields.join(", ")}`)
    .join("; ");
  const subject = source === "put" ? "a put to" : "a fetch for";
  console.warn(
    `tscache: ${subject} cache "${cacheId}" overwrote cached values that differed: ${ranges}. Reported because warnOnOverlapDiff is on, also as mergeWarning events; printed in development builds only.`,
  );
}
