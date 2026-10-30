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
   * view. The first answer with bars shows the opening range. An answer
   * that differs from the last one only in its newest bars, as a live bar
   * does, redraws only those where the library can (appendedFrom).
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

/** Equal, taking NaN (a value the answer lacks) for equal to NaN. */
function same(a: number | undefined, b: number | undefined): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/**
 * Where a chart that drew `before` starts to redraw for `after`, when
 * `after` differs from it only in its newest bars: the index in `after` of
 * the first bar to draw, which is `before`'s last bar when that bar (the
 * one forming) changed, and `before`'s length when nothing but new bars
 * did. Undefined when every bar must be drawn again: nothing drawn yet, an
 * answer without bars, other fields, or a change before the last bar
 * (a range that moved, a gap filled or opened, an earlier bar's values).
 *
 * It goes by the bars alone, so a new dataset version is caught by what it
 * changes: its cleared cache answers fewer bars, and its history other
 * values.
 */
export function appendedFrom(
  before: GetResult | undefined,
  after: GetResult,
): number | undefined {
  const count = before?.timestamps.length ?? 0;
  if (before === undefined || count === 0) return undefined;
  if (after.timestamps.length < count) return undefined;
  const names = Object.keys(after.fields);
  if (names.length !== Object.keys(before.fields).length) return undefined;
  const last = count - 1;
  for (let i = 0; i < count; i++) {
    if (before.timestamps[i] !== after.timestamps[i]) return undefined;
  }
  let from = count;
  for (const name of names) {
    const was = before.fields[name];
    const now = after.fields[name];
    if (was === undefined || now === undefined) return undefined;
    for (let i = 0; i < last; i++) {
      if (!same(was[i], now[i])) return undefined;
    }
    if (!same(was[last], now[last])) from = last;
  }
  return from;
}

/**
 * Counts a view's draws on its element, in `data-draws-full` (every bar
 * drawn) and `data-draws-appended` (only the newest, appendedFrom): what a
 * test reads to see that a live bar redraws only the bars it changed.
 */
export function countDraw(element: HTMLElement, appended: boolean): void {
  const key = appended ? "drawsAppended" : "drawsFull";
  element.dataset[key] = String(Number(element.dataset[key] ?? 0) + 1);
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
