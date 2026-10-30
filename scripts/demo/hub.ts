// The demo hub's HTTP handler: the hub page, built from the catalog, a
// stream of every app's mock-backend counters, and the backend controls
// the page's buttons call. The backends live in the apps' `vite preview`
// servers; the hub only reads and forwards to them, from the server side,
// so the apps need no CORS.

import type { App } from "../../e2e/examples/apps";
import { catalog, type Entry } from "./catalog";

/** How often the stats stream reads every backend. */
const STATS_MS = 1000;

/**
 * The fields of the mock backend's GET /api/stats the panel shows
 * (BackendStats in examples/mock-backend/src/backend.ts, which this project
 * cannot import: its module graph reaches the unbuilt package).
 */
interface BackendStats {
  version: string;
  pages: Record<string, number>;
  refused: number;
  refreshes: number;
  streams: number;
}

/**
 * The controls the hub's buttons may send, each a flag of the mock
 * backend's POST /api/control (BackendControl).
 */
const CONTROLS = ["expireAccess", "dropStreams", "bumpVersion"] as const;
type Control = (typeof CONTROLS)[number];

const CONTROL_LABELS: Record<Control, string> = {
  expireAccess: "Expire token",
  dropStreams: "Drop streams",
  bumpVersion: "Restate history",
};

/** One app's counters on the stats stream, or null when it did not answer. */
type AppStats = Pick<
  BackendStats,
  "version" | "refused" | "refreshes" | "streams"
> & { fetches: number };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function entryHtml(entry: Entry, origin: string): string {
  const launches = entry.launches
    .map(
      (launch) =>
        `<li><a href="${escapeHtml(new URL(launch.path, origin).href)}" target="_blank" data-app="${entry.app}" data-path="${escapeHtml(launch.path)}">${escapeHtml(launch.label)}</a></li>`,
    )
    .join("");
  const lookFor = entry.lookFor
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  return `<article class="entry" id="${entry.app}">
  <h2>${escapeHtml(entry.title)}</h2>
  <p class="stack">${escapeHtml(entry.stack)} · <code>${escapeHtml(origin)}</code></p>
  <p>${escapeHtml(entry.description)}</p>
  <ul class="launches">${launches}</ul>
  <details><summary>What to look for</summary><ul>${lookFor}</ul></details>
</article>`;
}

function panelRow(entry: Entry): string {
  const buttons = CONTROLS.filter(
    (control) => control !== "expireAccess" || entry.auth,
  )
    .map(
      (control) =>
        `<button type="button" data-app="${entry.app}" data-control="${control}">${CONTROL_LABELS[control]}</button>`,
    )
    .join(" ");
  return `<tr data-app="${entry.app}">
  <th scope="row">${entry.app}</th>
  <td data-field="fetches">–</td><td data-field="refused">–</td>
  <td data-field="refreshes">–</td><td data-field="streams">–</td>
  <td data-field="version">–</td><td>${buttons}</td>
</tr>`;
}

const STYLE = `
body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 72rem; padding: 1.5rem; color: #1d2330; }
h1 { margin-bottom: 0.25rem; }
.entries { display: grid; grid-template-columns: repeat(auto-fill, minmax(21rem, 1fr)); gap: 1rem; }
.entry { border: 1px solid #d5d9e2; border-radius: 8px; padding: 0 1rem 1rem; }
.entry h2 { font-size: 1.1rem; }
.stack { color: #5b6475; font-size: 0.9rem; }
.launches { padding-left: 1.1rem; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 0.3rem 0.6rem; border-bottom: 1px solid #e5e8ee; }
td.changed { background: #fff3c4; transition: background 0s; }
td { transition: background 1.5s; }
#feed-state { color: #5b6475; }
`;

/** The page's script: fills the panel from /stats and sends the controls. */
const SCRIPT = `
const rows = new Map([...document.querySelectorAll("tr[data-app]")].map((row) => [row.dataset.app, row]));
const state = document.getElementById("feed-state");
const source = new EventSource("/stats");
source.onopen = () => { state.textContent = "live"; };
source.onerror = () => { state.textContent = "reconnecting"; };
source.onmessage = (event) => {
  for (const [app, stats] of Object.entries(JSON.parse(event.data))) {
    const row = rows.get(app);
    if (!row) continue;
    for (const cell of row.querySelectorAll("td[data-field]")) {
      const value = stats === null ? "down" : String(stats[cell.dataset.field]);
      if (cell.textContent !== value) {
        cell.textContent = value;
        cell.classList.add("changed");
        requestAnimationFrame(() => requestAnimationFrame(() => cell.classList.remove("changed")));
      }
    }
  }
};
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-control]");
  if (!button) return;
  fetch("/control/" + button.dataset.app, { method: "POST", body: button.dataset.control });
});
`;

function page(origins: Record<App, string>): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tscache demo hub</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>tscache demo hub</h1>
  <p>Every example app and reference client, each on its own origin with its own mock backend, so each has its own SharedWorker. Open a page twice to see two tabs share one cache; watch the backend counters below while you do.</p>
</header>
<section class="entries">
${catalog.map((entry) => entryHtml(entry, origins[entry.app])).join("\n")}
</section>
<section>
  <h2>Backends <small id="feed-state">connecting</small></h2>
  <p>What each app's mock backend has answered since the demo started. Fetches are the series pages it served: a second tab that reads from the shared cache adds none. Refused counts requests made with an expired token; refreshes counts token rotations.</p>
  <table>
    <thead><tr><th>App</th><th>Fetches</th><th>Refused</th><th>Refreshes</th><th>Open streams</th><th>Data version</th><th>Controls</th></tr></thead>
    <tbody>
${catalog.map(panelRow).join("\n")}
    </tbody>
  </table>
</section>
<script type="module">${SCRIPT}</script>
</body>
</html>`;
}

async function readStats(origin: string): Promise<AppStats | null> {
  try {
    const response = await fetch(`${origin}api/stats`, {
      signal: AbortSignal.timeout(STATS_MS),
    });
    if (!response.ok) return null;
    const stats = (await response.json()) as BackendStats;
    const fetches = Object.values(stats.pages).reduce((a, b) => a + b, 0);
    const { version, refused, refreshes, streams } = stats;
    return { fetches, version, refused, refreshes, streams };
  } catch {
    return null;
  }
}

/** Server-Sent Events: every app's counters, once a second. */
function statsStream(origins: Record<App, string>): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = async () => {
        const entries = await Promise.all(
          Object.entries(origins).map(
            async ([app, origin]) => [app, await readStats(origin)] as const,
          ),
        );
        const data = JSON.stringify(Object.fromEntries(entries));
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // The page went away between two reads.
          clearInterval(timer);
        }
      };
      void push();
      timer = setInterval(push, STATS_MS);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
}

function isControl(value: string): value is Control {
  return (CONTROLS as readonly string[]).includes(value);
}

/** POST /control/<app>, body one of CONTROLS: forwarded to the backend. */
async function control(
  origins: Record<App, string>,
  app: string,
  request: Request,
): Promise<Response> {
  const origin = Object.hasOwn(origins, app) ? origins[app as App] : undefined;
  const name = await request.text();
  if (origin === undefined || !isControl(name)) {
    return new Response("unknown app or control", { status: 400 });
  }
  const body = { [name]: true };
  const answer = await fetch(`${origin}api/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(null, { status: answer.status });
}

type Route = (request: Request, rest: string) => Response | Promise<Response>;

/** The hub's request handler, given each app's origin (with a final slash). */
export function hub(
  origins: Record<App, string>,
): (request: Request) => Response | Promise<Response> {
  const html = page(origins);
  const home: Route = () =>
    new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  /** "<method> <first path segment>" → handler, given the rest of the path. */
  const routes: Record<string, Route> = {
    "GET /": home,
    "GET /index.html": home,
    "GET /healthz": () => new Response("ok"),
    "GET /stats": () => statsStream(origins),
    "POST /control": (request, app) => control(origins, app, request),
  };
  return (request) => {
    const { pathname } = new URL(request.url);
    const [, first, rest = ""] = /^(\/[^/]*)(?:\/(.*))?$/.exec(pathname) ?? [];
    const route = routes[`${request.method} ${first}`];
    return route?.(request, rest) ?? new Response("not found", { status: 404 });
  };
}
