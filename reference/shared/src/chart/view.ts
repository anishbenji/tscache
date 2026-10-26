// A candle chart as the reference clients use it, whichever library draws
// it. A client hands it each answer of the cache and listens for the user
// scrolling, which asks the cache for the range then on screen. Copy the
// one implementation you use (lightweight.ts or uplot.ts) with this file;
// load.ts picks between them for a page that offers both.

import type { GetResult, Range } from "tscache";

export interface ChartView {
  /**
   * Shows the answer's bars in place of the ones drawn. The time on screen
   * stays where it was, so bars loaded to the left of it do not move the
   * view. The first answer with bars shows the opening range.
   */
  draw(result: GetResult): void;
  /**
   * Calls `listener` with the time range on screen (ms, inclusive) each
   * time the user scrolls or zooms. Never for a change made by draw().
   * Returns the unsubscribe.
   */
  onScroll(listener: (visible: Range) => void): () => void;
  /** The time range on screen, once bars are drawn. */
  visible(): Range | undefined;
  /** Removes the chart from its element. */
  dispose(): void;
}

export interface ChartOptions {
  /** The cache's interval, in ms. */
  interval: number;
  /** The time range the first bars are shown at. */
  opening: Range;
}

export type CreateChart = (
  element: HTMLElement,
  options: ChartOptions,
) => ChartView;

/**
 * Whether two time ranges differ by more than half an interval: a view
 * reports a scroll only then, so its own redraws, which may report the
 * range they kept, are not taken for one.
 */
export function moved(a: Range | undefined, b: Range, interval: number) {
  return (
    a === undefined ||
    Math.abs(a.start - b.start) > interval / 2 ||
    Math.abs(a.end - b.end) > interval / 2
  );
}

/**
 * The range to show after a redraw: where it was, or moved on with the
 * newest bar when the view showed that bar, so a live chart follows the
 * market while the user looks at its end and stays put while they read
 * history.
 */
export function keptRange(
  shown: Range,
  lastBefore: number | undefined,
  lastNow: number | undefined,
): Range {
  if (lastBefore === undefined || lastNow === undefined) return shown;
  if (shown.end < lastBefore) return shown;
  const shift = lastNow - lastBefore;
  return { start: shown.start + shift, end: shown.end + shift };
}
