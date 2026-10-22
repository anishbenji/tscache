// What the page shows, as a pure function of its props: the server renders
// it from what it read, and the browser renders it again from its own
// answers. Times are UTC and numbers are formatted without the locale, so
// the server and the browser write the same text.

import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import type { Figures, Reading, ServerRead } from "./sensor";

/**
 * 'server-rendered' until the browser takes over; 'hydrating' while the
 * browser's cache is connected, seeded and asked for the window; 'loading'
 * while it answers for an earlier start.
 */
export type Status = "server-rendered" | "hydrating" | "loading" | "ready";

export interface LogLine {
  at: number;
  text: string;
}

/** A minute in UTC, such as "2026-10-22 14:32". */
export const utc = (t: number): string =>
  new Date(t).toISOString().slice(0, 16).replace("T", " ");

const clock = (t: number) => new Date(t).toISOString().slice(11, 19);

function value(v: number | null, digits: number): string {
  return v === null ? "–" : v.toFixed(digits);
}

function describe(reading: Reading | null): string {
  if (reading === null) return "none yet";
  const { at, temperature, humidity, battery } = reading;
  return `${value(temperature, 1)} °C, ${value(humidity, 1)} % humidity, battery ${value(battery, 0)} % at ${utc(at)} UTC`;
}

interface PanelProps {
  /** What the server read for this page. */
  server: ServerRead;
  status: Status;
  /** The hosting mode of the client whose figures are shown. */
  mode: string;
  figures: Figures;
  /** Backend fetches the browser's tabs made; none on the server. */
  fetches: number;
  log: LogLine[];
  /** Absent on the server: without JavaScript nothing can load more. */
  onLoadPreviousDay?: () => void;
  /** The chart; the server renders its frame empty. */
  children?: JSX.Element;
}

export function Panel(props: PanelProps) {
  return (
    <>
      <p class="stats">
        <output data-testid="readings">{props.figures.readings}</output>{" "}
        readings ·{" "}
        <output data-testid="known-empty">{props.figures.knownEmpty}</output>{" "}
        slots known to be empty · latest {describe(props.figures.latest)}
      </p>
      <p class="stats">
        Server render:{" "}
        <output data-testid="server-cached">{props.server.cached}</output>{" "}
        readings from its cache,{" "}
        {props.server.figures.readings - props.server.cached} fetched · client{" "}
        <output data-testid="mode">{props.mode}</output> · browser fetches{" "}
        <output data-testid="fetches">{props.fetches}</output> ·{" "}
        <output data-testid="status">{props.status}</output>
      </p>
      <figure class="chart">{props.children}</figure>
      <p>
        <button
          type="button"
          disabled={props.onLoadPreviousDay === undefined}
          onClick={() => props.onLoadPreviousDay?.()}
        >
          Load the previous day
        </button>
      </p>
      <h2>Log</h2>
      <ol class="log" reversed>
        <For each={props.log}>
          {(line) => <li>{`${clock(line.at)}  ${line.text}`}</li>}
        </For>
      </ol>
    </>
  );
}
