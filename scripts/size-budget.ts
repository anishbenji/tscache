/** The budget for a size measured now: room for small changes. */
export function budgetFor(bytes: number): number {
  return Math.ceil((bytes + Math.max(512, bytes * 0.03)) / 16) * 16;
}

/** How one measured row compares with the committed budgets. */
export type RowCheck =
  | { status: "ok" | "over"; budget: number }
  | { status: "missing" };

/**
 * Checks one row against the committed budgets. Without budgets (`--update`)
 * every row gets the budget it would be written with. With budgets, a row
 * that has none is `missing`: a new entry or chunk needs a reviewed budget
 * in packages/tscache/bench/budgets.json, never one derived from its own size.
 */
export function checkRow(
  budgets: Readonly<Record<string, number>> | undefined,
  key: string,
  brotli: number,
): RowCheck {
  const budget = budgets === undefined ? budgetFor(brotli) : budgets[key];
  if (budget === undefined) return { status: "missing" };
  return { status: brotli <= budget ? "ok" : "over", budget };
}
