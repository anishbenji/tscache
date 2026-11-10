// The checks every benchmark read passes before its view counts: a view
// that is not a whole answer fails the run, in every mode alike, rather
// than being drawn and counted as served.

import type { GetResult, Range } from "@anishbenji/tscache";

/** What the chart draws: times and closes. */
export interface Bars {
  timestamps: ArrayLike<number>;
  close: ArrayLike<number>;
}

const span = ({ start, end }: Range) =>
  `${new Date(start).toISOString()} to ${new Date(end).toISOString()}`;

/**
 * The chart's bars from a tscache answer. A get() whose fetch failed
 * resolves with what the cache held and a miss (docs/architecture.md §2.3);
 * the baselines' fetches reject instead, so a miss rejects here too, with
 * each miss's reason and error.
 */
export function barsOf(
  result: Pick<GetResult, "timestamps" | "fields" | "misses">,
  range: Range,
): Bars {
  if (result.misses.length > 0) {
    const reasons = result.misses.map(
      (miss) =>
        `${miss.reason}${miss.error === undefined ? "" : ` (${miss.error.message})`}`,
    );
    throw new Error(
      `tscache answered ${span(range)} with misses: ${reasons.join("; ")}`,
    );
  }
  return { timestamps: result.timestamps, close: result.fields.close ?? [] };
}

/**
 * `bars`, once checked to hold any: every range of the workload lies in
 * settled history of a market that trades around the clock, so a view
 * with no bars is a fault, whichever mode answered it.
 */
export function drawable(bars: Bars, range: Range): Bars {
  if (bars.timestamps.length === 0) {
    throw new Error(`the answer for ${span(range)} has no bars`);
  }
  return bars;
}
