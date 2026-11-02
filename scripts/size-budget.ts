/** The budget for a size measured now: room for small changes. */
export function budgetFor(bytes: number): number {
  return Math.ceil((bytes + Math.max(512, bytes * 0.03)) / 16) * 16;
}

/** How one measured row compares with the committed budgets. */
export type RowCheck =
  | { status: "ok" | "over"; budget: number }
  | { status: "missing" };

/**
 * Reads the committed budgets file (`{ "brotli": { "<key>": bytes } }`).
 * Throws when the table is absent or malformed, so a check never falls back
 * to budgets derived from the sizes it measures.
 */
export function parseBudgets(text: string): Readonly<Record<string, number>> {
  const parsed: unknown = JSON.parse(text);
  const table =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { brotli?: unknown }).brotli
      : undefined;
  if (
    typeof table !== "object" ||
    table === null ||
    Array.isArray(table) ||
    !Object.values(table).every((v) => typeof v === "number")
  ) {
    throw new Error(
      'packages/tscache/bench/budgets.json has no "brotli" table of numbers',
    );
  }
  return table as Record<string, number>;
}

/**
 * Checks one row. Only `--update` derives a budget from the row's own size
 * (the budget it would be written with); in a check, a row without a
 * committed budget is `missing`: a new entry or chunk needs a reviewed budget
 * in packages/tscache/bench/budgets.json.
 */
export function checkRow(
  mode: "check" | "update",
  budgets: Readonly<Record<string, number>>,
  key: string,
  brotli: number,
): RowCheck {
  const budget = mode === "update" ? budgetFor(brotli) : budgets[key];
  if (budget === undefined) return { status: "missing" };
  return { status: brotli <= budget ? "ok" : "over", budget };
}
