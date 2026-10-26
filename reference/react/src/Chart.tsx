// The chart: a library's view (reference/shared/src/chart) inside an
// element React renders and leaves alone. An effect creates the view for
// the chart kind and tears it down; another draws each new answer into it.
// Both libraries are imperative, so the view lives in a ref, not in state.

import { type ChartKind, loadChart } from "@reference/shared/chart/load";
import type { ChartView } from "@reference/shared/chart/view";
import { market } from "@reference/shared/market";
import type { Session } from "@reference/shared/session";
import { useEffect, useEffectEvent, useRef } from "react";
import type { GetResult, Range } from "tscache";

export interface ChartProps {
  /** Null on the server, which renders the empty element only. */
  session: Session | null;
  kind: ChartKind;
  answer: GetResult | undefined;
  /** The time on screen, after each draw and each scroll. */
  onShowing(visible: Range): void;
}

export function Chart({ session, kind, answer, onShowing }: ChartProps) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<ChartView | null>(null);
  /** Where the last chart was, so a chart of another kind opens there. */
  const last = useRef<Range | undefined>(undefined);
  const showing = useEffectEvent(() => {
    const visible = view.current?.visible();
    if (visible !== undefined) onShowing(visible);
  });

  useEffect(() => {
    const target = element.current;
    if (session === null || target === null) return;
    let cancelled = false;
    let mounted: ChartView | undefined;
    let detach: (() => void) | undefined;
    // Only the library shown is loaded.
    void loadChart(kind).then((create) => {
      if (cancelled) return;
      const opening = last.current ?? session.opening;
      mounted = create(target, { interval: market.interval, opening });
      view.current = mounted;
      detach = session.attachChart(mounted);
      mounted.onScroll((visible) => {
        showing();
        session.scrolled(visible);
      });
      const { answer } = session.state;
      if (answer !== undefined) mounted.draw(answer);
      showing();
    });
    return () => {
      cancelled = true;
      if (mounted === undefined) return;
      last.current = mounted.visible() ?? last.current;
      detach?.();
      mounted.dispose();
      view.current = null;
    };
  }, [session, kind]);

  useEffect(() => {
    if (answer === undefined || view.current === null) return;
    view.current.draw(answer);
    showing();
  }, [answer]);

  return <div id="chart" className="chart" ref={element} />;
}
