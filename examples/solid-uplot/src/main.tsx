// A greenhouse sensor that reports every 10 seconds. It drops single
// readings and goes offline for 15-minute blocks, and the backend serves no
// point there. tscache keeps one presence bit per point and records the
// fetched range as coverage, so an empty slot inside coverage is a confirmed
// gap: the charts break there, and switching ranges or zooming inside
// covered time asks the backend for nothing.

import { render } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  Loading,
  onSettled,
} from "solid-js";
import type { Range } from "tscache";
import "uplot/dist/uPlot.min.css";
import { PANELS, SensorChart } from "./chart";
import { type Frame, toFrame } from "./frame";
import {
  duration,
  entries,
  fetches,
  log,
  moment,
  time,
  watchFetches,
} from "./log";
import { createSession, INTERVAL } from "./session";

const HOUR = 3_600_000;

const PRESETS = [
  { hours: 1, label: "Last hour" },
  { hours: 6, label: "Last 6 hours" },
  { hours: 24, label: "Last 24 hours" },
] as const;

/** The shown range, and the preset that chose it (none after a zoom). */
interface View {
  range: Range;
  hours?: number;
}

function lastHours(hours: number): View {
  const now = Date.now();
  return { hours, range: { start: now - hours * HOUR, end: now } };
}

interface DashboardProps {
  mode: string;
  frame: Frame;
  onSelect: (range: Range) => void;
}

function Dashboard(props: DashboardProps) {
  const [drawn, setDrawn] = createSignal(false);
  const status = () => {
    if (isPending(() => props.frame)) return "loading";
    return drawn() ? "ready" : "drawing";
  };

  createEffect(
    () => props.frame.misses,
    (misses) => {
      for (const { range, reason } of misses) {
        // With a fetcher, only the slot after now stays uncached: it has
        // not happened yet.
        if (reason === "uncached") continue;
        log(
          `not loaded: ${moment(range.start)} – ${moment(range.end)} (${reason})`,
        );
      }
    },
  );

  return (
    <>
      <p class="stats">
        Mode <output data-testid="mode">{props.mode}</output> · backend fetches{" "}
        <output data-testid="fetches">{fetches()}</output> · points{" "}
        <output data-testid="points">{props.frame.points}</output> · confirmed
        gaps <output data-testid="gaps">{props.frame.gaps.length}</output> ·{" "}
        <output data-testid="status">{status()}</output>
      </p>
      <p class="shown">
        {moment(props.frame.range.start)} – {moment(props.frame.range.end)} (
        {duration(props.frame.range.end - props.frame.range.start)})
      </p>
      <For each={PANELS}>
        {(panel) => (
          <SensorChart
            panel={panel}
            frame={props.frame}
            onSelect={props.onSelect}
            onDraw={() => setDrawn(true)}
          />
        )}
      </For>
    </>
  );
}

function App() {
  const { client, cache } = createSession();
  const [view, setView] = createSignal<View>(lastHours(6));
  const frame = createMemo<Frame>(async () => {
    const handle = cache();
    const { range } = view();
    return toFrame(await handle.get(range), range, INTERVAL);
  });

  onSettled(watchFetches);

  return (
    <>
      <header>
        <h1>Greenhouse sensor</h1>
        <nav class="presets">
          <For each={PRESETS}>
            {(preset) => (
              <button
                type="button"
                aria-pressed={view().hours === preset.hours ? "true" : "false"}
                onClick={() => setView(lastHours(preset.hours))}
              >
                {preset.label}
              </button>
            )}
          </For>
        </nav>
      </header>
      <Errored
        fallback={(error) => (
          <p class="stats" role="alert">
            The cache failed: {String(error())}
          </p>
        )}
      >
        <Loading
          fallback={
            <p class="stats">
              <output data-testid="status">connecting</output>
            </p>
          }
        >
          <Dashboard
            mode={client().mode}
            frame={frame()}
            onSelect={(range) => setView({ range })}
          />
        </Loading>
      </Errored>
      <p class="key">
        <span class="swatch gap" /> A break inside loaded time is a confirmed
        gap: the sensor sent no reading there, the cache knows it, and it is
        never fetched again. <span class="swatch unloaded" /> Hatched time is
        not loaded. Drag across a chart to zoom in.
      </p>
      <h2>Log</h2>
      <ol class="log" reversed>
        <For each={entries()}>
          {(entry) => (
            <li>
              {time(entry.at)} {entry.text}
            </li>
          )}
        </For>
      </ol>
    </>
  );
}

render(() => <App />, document.querySelector("#app") ?? document.body);
