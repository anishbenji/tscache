// The page's one chart, the same component in every variant: client-only,
// server-rendered and hydrated, server-rendered alone. What differs is the
// providers the app is bootstrapped with (client-only.ts, ssr-server.ts,
// ssr-browser.ts). The text is computed in TypeScript rather than the
// template, so the type check covers it.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from "@angular/core";
import { candles, describe, lastDays } from "../shared/candles";
import { cacheResource } from "./tscache";

@Component({
  selector: "candles-chart",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: "<p>{{ text() }}</p>",
})
// Bootstrapped in README.md: @angular/platform-browser is not installed here.
// fallow-ignore-next-line unrendered-component
export class CandlesChart {
  /**
   * The range on screen. Scrolling the chart sets it to the visible range;
   * the cache fetches only what it does not hold.
   */
  readonly range = signal(lastDays(90, Date.now()));
  readonly candles = cacheResource(candles, this.range);

  // A chart library would take result.timestamps and result.fields in an
  // afterRenderEffect() instead; they are the cache's copies, so it may keep
  // them without copying.
  protected readonly text = computed(() => {
    const error = this.candles.error();
    if (error !== undefined) return `Could not read: ${error.message}`;
    return this.candles.hasValue()
      ? describe(this.candles.value())
      : "Loading…";
  });
}
