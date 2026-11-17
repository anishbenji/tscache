/**
 * Development-only console output (docs/architecture.md §2.7, resolved
 * decision #8): merge warnings are printed in the page that made the write,
 * once per put, in addition to the put result and the mergeWarning event.
 */

import type { MergeWarning, WorkerFeature } from "../types";

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

/**
 * Prints one console.warn that the worker lacks a feature a listener needs
 * (N80), unless the build is a production one.
 */
export function warnMissingFeature(feature: WorkerFeature): void {
  try {
    if (process.env.NODE_ENV === "production") return;
  } catch {
    return;
  }
  console.warn(
    `tscache: this client's worker does not offer ${feature} (an older worker script?), so ${feature} listeners will not be called. Check client.features.has("${feature}") and poll instead; printed in development builds only.`,
  );
}

/** Whether this is a development build; see `warnMerges`. */
function development(): boolean {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}

/**
 * Prints one console.warn that the client's `memoryBudget` is not in force
 * (§2.9, N88, N101, N103): the worker kept an earlier budget, already held
 * a cache, or does not offer budgets at all. Development builds only.
 */
export function warnBudget(
  requested: number,
  inForce: number | undefined | "unsupported",
): void {
  if (!development()) return;
  const why =
    inForce === "unsupported"
      ? "this client's worker does not offer memory budgets (an older worker script?), so no budget applies and memoryStats() rejects"
      : inForce === undefined
        ? "the worker already held a cache when the budget arrived, so it runs without one until it restarts"
        : `the worker keeps the first budget it received, ${inForce} bytes, until it restarts`;
  console.warn(
    `tscache: memoryBudget ${requested} is not in force: ${why}. client.memoryStats() reports the budget in force; printed in development builds only.`,
  );
}
