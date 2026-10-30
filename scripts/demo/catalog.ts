// What the demo hub (scripts/demo.ts) lists: every example app and every
// reference client, the pages each one serves, and what each page shows.
// The Playwright spec e2e/demo/hub.spec.ts opens every launch from the hub
// and checks it with `ready` and `data`.

import { type App, apps } from "../../e2e/examples/apps";

/** An element the page fills in, found by its `data-testid`. */
interface Probe {
  testId: string;
  /** What its text must match. */
  text: string | RegExp;
}

/** One page of an app, as the hub links it. */
export interface Launch {
  label: string;
  /** Path and query on the app's server. */
  path: string;
  /** Matches once the page has connected and read. */
  ready: Probe;
  /** Matches once the page shows data from the backend. */
  data: Probe;
}

export interface Entry {
  app: App;
  title: string;
  /** Framework, chart library and rendering, in a few words. */
  stack: string;
  description: string;
  /** What to try, and what to watch while trying it. */
  lookFor: string[];
  /** The app's backend requires a bearer token, so expiring it shows a refresh. */
  auth: boolean;
  launches: Launch[];
}

/** A count above zero. */
const POSITIVE = /^[1-9]\d*$/;

/** The reference clients' status line once the live feed is open. */
const LIVE: Probe = { testId: "connection", text: "live" };
/** The reference clients' summary once it holds bars. */
const BARS: Probe = { testId: "summary", text: /^[1-9]\d* bars/ };

function referenceLaunches(): Launch[] {
  const launch = (label: string, path: string): Launch => ({
    label,
    path,
    ready: LIVE,
    data: BARS,
  });
  return [
    launch(
      "Client-only · Lightweight Charts · SSE",
      "/?chart=lightweight&feed=sse",
    ),
    launch("Client-only · uPlot", "/?chart=uplot&feed=sse"),
    launch("WebSocket feed", "/?feed=ws"),
    launch("Polling feed", "/?feed=poll"),
    launch("Server-rendered (/ssr)", "/ssr"),
  ];
}

const REFERENCE_LOOK_FOR = [
  "Open the same page in a second tab: it draws the history at once, and the backend's fetch count in the panel below grows by the newest bars at most. One SharedWorker serves every tab of the origin.",
  "Only one tab holds the live feed (the backend's open streams stays at 1); close it and another tab takes the feed over.",
  "Switch the feed between SSE, WebSocket and polling with the menu: every tab of the origin follows the latest choice.",
  "Scroll back through history: only spans the cache lacks are fetched.",
  "Expire token (in the panel below): one tab refreshes it for every tab, and the backend counts one refresh. Drop streams: the feed reconnects and mends the bars it missed.",
  "On /ssr the page arrives with the server's read and the browser fetches only the bar still forming.",
];

export const catalog: Entry[] = [
  {
    app: "vanilla-uplot",
    title: "Live server metrics and sparse events",
    stack: "Vanilla TypeScript · uPlot · client-only",
    description:
      "A dashboard polling the last ten minutes every second, with a provisional tail after the backend's watermark; and a week of one-minute event counts where most slots are empty.",
    lookFor: [
      "The log: one ten-minute fetch on open, then short fetches of the provisional tail only.",
      "Restate history: the cache clears itself on the version change and fetches the window again.",
      "On the events page, zooming inside the loaded week asks the backend for nothing: empty slots are covered, not missing.",
    ],
    auth: false,
    launches: [
      {
        label: "Live server metrics",
        path: "/",
        ready: { testId: "status", text: "live" },
        data: { testId: "final", text: POSITIVE },
      },
      {
        label: "Sparse event counts",
        path: "/events.html",
        ready: { testId: "status", text: "ready" },
        data: { testId: "points", text: POSITIVE },
      },
    ],
  },
  {
    app: "solid-uplot",
    title: "Greenhouse sensor with dropouts",
    stack: "Solid · uPlot · client-only",
    description:
      "Temperature, humidity and battery every ten seconds, with dropped readings and offline blocks the cache records as confirmed gaps.",
    lookFor: [
      "The three charts break at exactly the same places: a point has all its fields or none.",
      "Last hour and zooming in are answered from the cache; the backend's fetch count stays put.",
    ],
    auth: false,
    launches: [
      {
        label: "Sensor dashboard",
        path: "/",
        ready: { testId: "status", text: "ready" },
        data: { testId: "points", text: POSITIVE },
      },
    ],
  },
  {
    app: "solid-lwcharts",
    title: "Candles with weekend gaps",
    stack: "Solid · Lightweight Charts · client-only",
    description:
      "Half-hour candles of a stock that trades on weekdays only; scrolling back loads earlier fortnights.",
    lookFor: [
      "Empty slots known: nights and weekends are covered, so they are never fetched.",
      "Load an earlier fortnight: the page asks for the whole range again and the cache fetches only the new fortnight.",
    ],
    auth: false,
    launches: [
      {
        label: "Candles",
        path: "/",
        ready: { testId: "status", text: "ready" },
        data: { testId: "bars", text: POSITIVE },
      },
    ],
  },
  {
    app: "react-lwcharts",
    title: "Two tabs, one SharedWorker",
    stack: "React · Lightweight Charts · client-only · bearer auth",
    description:
      "Five-minute candles in as many tabs as you open, behind a bearer token that expires on demand.",
    lookFor: [
      "Open another tab: it draws three days at once and fetches only the forming bar; the mode reads shared.",
      "Expire access token (on the page or in the panel below): one tab refreshes it, every tab carries on, and the backend counts one refresh.",
      "Close the tab that created the worker (see the README): the other tabs get workerLost, replace their client and carry on.",
    ],
    auth: true,
    launches: [
      {
        label: "Candles",
        path: "/",
        ready: { testId: "status", text: "ready" },
        data: { testId: "bars", text: POSITIVE },
      },
    ],
  },
  {
    app: "react-ssr",
    title: "Server-rendered candles",
    stack: "React 19 · Lightweight Charts · server-rendered",
    description:
      "The server reads half a year through tscache and renders the page; the browser's cache starts from that read.",
    lookFor: [
      "On load the browser fetches none of the history the server read: only the forming day.",
      "Disable JavaScript: the figures and table are still there.",
      "A tab that loses its worker builds a new client and refetches from the server's snapshot.",
    ],
    auth: false,
    launches: [
      {
        label: "Daily candles",
        path: "/",
        ready: { testId: "status", text: "ready" },
        data: { testId: "bars", text: POSITIVE },
      },
    ],
  },
  {
    app: "solid-ssr",
    title: "Server-rendered sensor",
    stack: "Solid · uPlot · server-rendered",
    description:
      "A day of sensor readings rendered on the server through an in-process client; confirmed gaps travel to the browser with the coverage.",
    lookFor: [
      "Known-empty minutes come from the server's read, so the browser never asks for them.",
      "Load the previous day: only that day is fetched.",
    ],
    auth: false,
    launches: [
      {
        label: "Sensor day",
        path: "/",
        ready: { testId: "status", text: "ready" },
        data: { testId: "readings", text: POSITIVE },
      },
    ],
  },
  {
    app: "reference-vanilla",
    title: "Reference client: vanilla",
    stack: "No framework · both chart libraries · client and SSR",
    description:
      "The complete live-market client, meant to be copied: one-minute candles, a live feed elected across tabs, credential refresh and worker replacement.",
    lookFor: REFERENCE_LOOK_FOR,
    auth: true,
    launches: referenceLaunches(),
  },
  {
    app: "reference-react",
    title: "Reference client: React",
    stack: "React · both chart libraries · client and SSR",
    description:
      "The same page bound to React with useSyncExternalStore; the session lives outside the component tree.",
    lookFor: REFERENCE_LOOK_FOR,
    auth: true,
    launches: referenceLaunches(),
  },
  {
    app: "reference-solid",
    title: "Reference client: Solid",
    stack: "Solid · both chart libraries · client and SSR",
    description:
      "The same page bound to Solid with one signal; the chart library loads in an async memo.",
    lookFor: REFERENCE_LOOK_FOR,
    auth: true,
    launches: referenceLaunches(),
  },
];

/** The hub's port when DEMO_PORT is not set. */
const DEFAULT_PORT = 5400;

/** The hub's port: DEMO_PORT, or 5400. */
export function hubPort(env: Readonly<Record<string, string | undefined>>) {
  const set = env.DEMO_PORT;
  if (set === undefined || set === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(set)) {
    throw new RangeError(`DEMO_PORT must be a port number, not ${set}`);
  }
  return Number(set);
}

/**
 * Each app's port in the demo: the ports after the hub's, in the order of
 * `apps`. They differ from the example specs' ports, so the demo and the
 * Playwright suite run side by side, each app with its own backend.
 */
export function demoPorts(hub: number): Record<App, number> {
  const names = Object.keys(apps) as App[];
  return Object.fromEntries(
    names.map((app, i) => [app, hub + 1 + i]),
  ) as Record<App, number>;
}
