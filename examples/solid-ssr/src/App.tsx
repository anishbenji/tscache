// The page, rendered on the server and hydrated in the browser with the same
// props. Until hydration ends, both sides render the panel from what the
// server read; then the browser's live panel takes over, created only now,
// so nothing it does can make the hydrating render differ from the server's.

import {
  type FetchNotice,
  onFetchNotice,
} from "@examples/mock-backend/notices";
import {
  createEffect,
  createMemo,
  createSignal,
  Errored,
  isPending,
  onSettled,
  Show,
} from "solid-js";
import type { GetResult, HostingMode, Range } from "tscache";
import { SensorChart } from "./chart";
import { type LogLine, Panel, type Status, utc } from "./panel";
import { DAY, type Figures, figuresOf, type ServerRead } from "./sensor";
import { createSession } from "./session";

/** The id of the script element that carries the page's props. */
export const APP_PROPS = "app-props";

/** The browser's answer for a range, and the client that gave it. */
interface Answer {
  mode: HostingMode;
  range: Range;
  result: GetResult;
  figures: Figures;
}

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function describeFetch({ range, pages, outcome }: FetchNotice): string {
  const length = span(range.end - range.start);
  return `fetched ${length} (${utc(range.start)} – ${utc(range.end)} UTC): ${outcome}, ${pages} page(s)`;
}

function Live(props: ServerRead) {
  const [log, setLog] = createSignal<LogLine[]>([]);
  const [fetches, setFetches] = createSignal(0);
  const write = (text: string) =>
    setLog((lines) => [{ at: Date.now(), text }, ...lines].slice(0, 50));

  const { cache, client } = createSession(write);
  // The server's window to begin with; each earlier day moves it back.
  const [start, setStart] = createSignal(() => props.window.start);
  const answer = createMemo<Answer | undefined>(
    async () => {
      const { mode } = client();
      const handle = cache();
      const range = { start: start(), end: Date.now() };
      const result = await handle.get(range);
      return { mode, range, result, figures: figuresOf(result) };
    },
    // Until the first answer the panel goes on showing the server's.
    { loadingValue: undefined },
  );
  const status = (): Status => {
    if (answer() === undefined) return "hydrating";
    return isPending(() => answer()) ? "loading" : "ready";
  };

  // In time for the first fetch: the first get waits for the worker's
  // handshake and the seeds.
  onSettled(() =>
    onFetchNotice((notice) => {
      setFetches((n) => n + 1);
      write(describeFetch(notice));
    }),
  );

  createEffect(
    () => answer()?.result.misses ?? [],
    (misses) => {
      for (const { range, reason } of misses) {
        // Only the minute after now stays uncached: it has not happened.
        if (reason === "uncached") continue;
        write(
          `not loaded: ${utc(range.start)} – ${utc(range.end)} UTC (${reason})`,
        );
      }
    },
  );

  return (
    <Panel
      server={props}
      status={status()}
      mode={answer()?.mode ?? "connecting"}
      figures={answer()?.figures ?? props.figures}
      fetches={fetches()}
      log={log()}
      onLoadPreviousDay={() => setStart((t) => t - DAY)}
    >
      <SensorChart shown={answer()} />
    </Panel>
  );
}

/** The page as the server read it: its render, and the browser's fallback. */
function ServerPanel(props: ServerRead) {
  return (
    <Panel
      server={props}
      status="server-rendered"
      mode={props.mode}
      figures={props.figures}
      fetches={0}
      log={[]}
    />
  );
}

export function App(props: ServerRead) {
  const [hydrated, setHydrated] = createSignal(false);
  onSettled(() => {
    setHydrated(true);
  });

  return (
    <>
      <header>
        <h1>Greenhouse sensor</h1>
        <span>GH1, one reading a minute, times in UTC</span>
      </header>
      <Show when={hydrated()} fallback={<ServerPanel {...props} />}>
        <Errored
          fallback={(error) => (
            <>
              <p class="stats" role="alert">
                The browser's cache failed ({String(error())}); showing what the
                server read.
              </p>
              <ServerPanel {...props} />
            </>
          )}
        >
          <Live {...props} />
        </Errored>
      </Show>
      <p class="key">
        The server reads the last 24 hours through its own tscache client and
        writes what it read into the page: each covered range, with its
        readings. The browser puts them into its cache with their ranges, so it
        knows the empty minutes inside them are dropouts, not time it never
        fetched, and fetches only the minutes since the server's read.
      </p>
    </>
  );
}
