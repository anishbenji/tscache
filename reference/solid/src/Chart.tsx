// The chart: a library's view (reference/shared/src/chart) inside an
// element Solid renders and leaves alone.
//
// The library is an async memo of the chart kind. Effects wait for an async
// value to settle, so when the kind changes, the chart on screen stays until
// the next library has loaded, and only then is replaced: the old view is
// disposed and the new one created in one step, where the old one was. The
// view is a signal, so the drawing effect follows both the view and the
// answer, and draws a new view at once.

import { type ChartKind, loadChart } from "@reference/shared/chart/load";
import type { ChartView } from "@reference/shared/chart/view";
import { market } from "@reference/shared/market";
import type { Session } from "@reference/shared/session";
import { createEffect, createMemo, createSignal } from "solid-js";
import type { GetResult, Range } from "tscache";

export interface ChartProps {
  /** Null on the server, which renders the empty element only. */
  session: Session | null;
  kind: ChartKind;
  answer: GetResult | undefined;
  /** The time on screen, after each draw and each scroll. */
  onShowing(visible: Range): void;
}

export function Chart(props: ChartProps) {
  let element: HTMLDivElement | undefined;
  // The page's session, fixed for its life.
  const { session } = props;
  // The server creates the same computations as the browser, or hydration
  // could not match the markup to them; it loads and draws nothing, since
  // effects do not run there.
  const library = createMemo(() =>
    session === null ? undefined : loadChart(props.kind),
  );
  const [view, setView] = createSignal<ChartView>();

  createEffect(library, (create) => {
    if (session === null || create === undefined) return;
    if (element === undefined) throw new Error("the chart is not mounted");
    // Where the last chart was, or the page's opening range at first.
    const next = create(element, {
      interval: market.interval,
      opening: session.opening,
    });
    const detach = session.attachChart(next);
    next.onScroll((visible) => {
      props.onShowing(visible);
      session.scrolled(visible);
    });
    setView(next);
    return () => {
      detach();
      next.dispose();
    };
  });

  createEffect(
    () => ({ shown: view(), answer: props.answer }),
    ({ shown, answer }) => {
      if (shown === undefined) return;
      if (answer !== undefined) shown.draw(answer);
      const visible = shown.visible();
      if (visible !== undefined) props.onShowing(visible);
    },
  );

  return (
    <div
      id="chart"
      class="chart"
      ref={(div) => {
        element = div;
      }}
    />
  );
}
