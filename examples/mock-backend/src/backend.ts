// The mock backend as a fetch-style handler: series pages, a live stream
// of the forming bar, bearer-token auth with refresh-token rotation, and
// controls the example pages call to show
// what tscache does about latency, a dataset version change or an expired
// token. All state lives in memory, one backend per dev or preview server.

import { datasets, isDatasetName } from "./datasets";
import { seedOf } from "./noise";
import { alignDown, type SeriesQuery, seriesPage } from "./series";

export interface BackendOptions {
  /** Delay before each series page and refresh answer. Default 300 ms. */
  latencyMs?: number;
  /** Require a bearer token on series requests. Default false. */
  auth?: boolean;
  /**
   * A bearer token series requests are always accepted with, as a server
   * that renders pages holds a credential of its own rather than a user's.
   * Default none.
   */
  serviceToken?: string;
  /** Clock, for tests. Default `Date.now`. */
  now?: () => number;
  /** Time between two messages of a live stream. Default 1000 ms. */
  pushMs?: number;
}

/** A pair of tokens, as `/api/auth/login` and `/api/auth/refresh` answer. */
export interface Tokens {
  access: string;
  refresh: string;
}

/** GET /api/stats. */
export interface BackendStats {
  version: string;
  latencyMs: number;
  /** Series pages answered, per dataset. */
  pages: Record<string, number>;
  /** Series requests refused for a missing or stale access token. */
  refused: number;
  /** Successful rotations. */
  refreshes: number;
  /** Refresh attempts with a refresh token that is not the current one. */
  reused: number;
  /** Live streams open now. */
  streams: number;
  /** The backend's clock (ms), advanceMs included. */
  now: number;
}

/**
 * One message of a live stream (GET /api/stream/<dataset>/<symbol>), in
 * the shape of a tscache put batch: the bar forming now and, when a bar
 * has just closed, that bar with its final values first.
 */
export interface StreamBatch {
  timestamps: number[];
  fields: Record<string, number[]>;
  meta: { version: string; finalizedUntil: number };
}

/**
 * POST /api/control.
 * @public used by the example specs under e2e/, which Knip does not scan
 */
export interface BackendControl {
  latencyMs?: number;
  /** Restate every series under a new dataset version. */
  bumpVersion?: true;
  /** Replace the access token; the refresh token stays valid. */
  expireAccess?: true;
  /** Answer the next this many series requests with a server error. */
  failNext?: number;
  /** End every live stream, as a network outage would; clients reconnect. */
  dropStreams?: true;
  /** Move the backend's clock forward, so time passes in a test at once. */
  advanceMs?: number;
  /** Undo every advanceMs, so the next test starts on the real clock. */
  resetClock?: true;
}

/** Answers a request under /api/, or undefined for any other path. */
export type Backend = (request: Request) => Promise<Response | undefined>;

const SERIES = /^\/api\/series\/([^/]+)\/([^/]+)$/;
const STREAM = /^\/api\/stream\/([^/]+)\/([^/]+)$/;
/** How soon a client reconnects a dropped live stream (the SSE retry). */
const RECONNECT_MS = 500;
/** Longer delays would overflow setTimeout, which then fires at once. */
const MAX_LATENCY = 60_000;

function newToken(kind: "at" | "rt"): string {
  return `${kind}-${crypto.randomUUID()}`;
}

function sleep(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

function text(status: number, body: string): Response {
  return new Response(body, { status });
}

function json(body: unknown): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

function parseQuery(url: URL): SeriesQuery | undefined {
  const value = (name: string) => Number(url.searchParams.get(name) ?? "x");
  const query = {
    start: value("start"),
    end: value("end"),
    interval: value("interval"),
    offset: value("offset"),
  };
  // Integers only: a fractional interval can be too small to advance a
  // timestamp, and the scan would never end. tscache asks on its grid.
  const integral = Object.values(query).every(Number.isSafeInteger);
  return integral && query.interval > 0 && query.start <= query.end
    ? query
    : undefined;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function createBackend(options: BackendOptions = {}): Backend {
  const clock = options.now ?? Date.now;
  /** How far BackendControl.advanceMs moved the clock. */
  let advanced = 0;
  const now = () => clock() + advanced;
  const auth = options.auth ?? false;
  const pushMs = options.pushMs ?? 1000;
  let latencyMs = options.latencyMs ?? 300;
  let version = 1;
  /** Series requests still to fail (BackendControl.failNext). */
  let failing = 0;
  /** Ends each open live stream (BackendControl.dropStreams). */
  const streams = new Set<() => void>();
  let tokens: Tokens = { access: newToken("at"), refresh: newToken("rt") };
  const stats = {
    pages: {} as Record<string, number>,
    refused: 0,
    refreshes: 0,
    reused: 0,
    streams: 0,
  };

  /** The seed of a series under the current dataset version. */
  function seedFor(dataset: string, symbol: string): number {
    // The symbol seeds the series as it appears in the path, undecoded: a
    // malformed escape is just another name.
    return seedOf(`${dataset}/${symbol}/v${version}`);
  }

  async function series(request: Request, url: URL): Promise<Response> {
    const [, dataset = "", symbol = ""] = SERIES.exec(url.pathname) ?? [];
    if (!isDatasetName(dataset)) return text(404, "unknown dataset");
    const query = parseQuery(url);
    if (query === undefined) return text(400, "bad query");
    // Decided on arrival, like a real server; the latency only delays it.
    const presented = request.headers.get("authorization");
    const authorized =
      !auth ||
      presented === `Bearer ${tokens.access}` ||
      (options.serviceToken !== undefined &&
        presented === `Bearer ${options.serviceToken}`);
    const tag = `v${version}`;
    const seed = seedFor(dataset, symbol);
    const page = authorized
      ? seriesPage(datasets[dataset], seed, query, now())
      : undefined;
    const fail = authorized && failing > 0;
    if (fail) failing--;
    await sleep(latencyMs);
    if (fail) return text(500, "failing on request");
    if (page === undefined) {
      stats.refused++;
      return text(401, "access token refused");
    }
    stats.pages[dataset] = (stats.pages[dataset] ?? 0) + 1;
    const { next, finalizedUntil, ...data } = page;
    const meta = { version: tag, finalizedUntil };
    return json(
      next === undefined ? { ...data, meta } : { ...data, meta, next },
    );
  }

  /**
   * Server-Sent Events: a `bar` event every pushMs with a StreamBatch,
   * until the client goes away. Unauthenticated: EventSource cannot send
   * an authorization header (a real feed would take a cookie or a
   * short-lived ticket in the URL).
   */
  function stream(request: Request, url: URL): Response {
    const [, dataset = "", symbol = ""] = STREAM.exec(url.pathname) ?? [];
    if (!isDatasetName(dataset)) return text(404, "unknown dataset");
    const interval = Number(url.searchParams.get("interval") ?? "x");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    if (
      !Number.isSafeInteger(interval) ||
      interval <= 0 ||
      !Number.isSafeInteger(offset)
    ) {
      return text(400, "bad query");
    }
    const set = datasets[dataset];
    const encoder = new TextEncoder();
    /** The start of the bar the last message carried. */
    let forming: number | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let open = true;

    function message(): StreamBatch {
      const at = now();
      const bar = alignDown(at, interval, offset);
      const seed = seedFor(dataset, symbol);
      const batch: StreamBatch = {
        timestamps: [],
        fields: Object.fromEntries(
          Object.keys(set.fields).map((name) => [name, []]),
        ),
        meta: {
          version: `v${version}`,
          finalizedUntil:
            alignDown(at - set.provisionalMs(interval), interval, offset) +
            interval,
        },
      };
      const add = (t: number) => {
        const values = set.point(seed, t, interval, at);
        if (values === undefined) return;
        batch.timestamps.push(t);
        Object.values(batch.fields).forEach((column, i) => {
          column.push(values[i] ?? Number.NaN);
        });
      };
      // The bar that just closed, with its final values.
      if (forming !== undefined && forming < bar) add(bar - interval);
      add(bar);
      forming = bar;
      return batch;
    }

    let output: ReadableStreamDefaultController<Uint8Array> | undefined;

    /** Stops the pushes; the reader went away, or end() ended the stream. */
    function close(): void {
      if (!open) return;
      open = false;
      clearInterval(timer);
      streams.delete(end);
      stats.streams--;
    }

    function end(): void {
      close();
      try {
        output?.close();
      } catch {
        // Already closed by the reader.
      }
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
        stats.streams++;
        streams.add(end);
        const push = () => {
          if (!open) return;
          const data = JSON.stringify(message());
          controller.enqueue(encoder.encode(`event: bar\ndata: ${data}\n\n`));
        };
        // A dropped stream is reconnected after this many ms.
        controller.enqueue(encoder.encode(`retry: ${RECONNECT_MS}\n\n`));
        push();
        timer = setInterval(push, pushMs);
        request.signal.addEventListener("abort", end);
      },
      cancel: close,
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  }

  async function refresh(request: Request): Promise<Response> {
    const body = await readJson(request);
    const presented =
      typeof body === "object" && body !== null && "refresh" in body
        ? body.refresh
        : undefined;
    const current = presented === tokens.refresh;
    if (current) {
      tokens = { access: newToken("at"), refresh: newToken("rt") };
      stats.refreshes++;
    } else {
      stats.reused++;
    }
    const answer = tokens;
    await sleep(latencyMs);
    return current ? json(answer) : text(401, "refresh token refused");
  }

  async function control(request: Request): Promise<Response> {
    const body = (await readJson(request)) as BackendControl | undefined;
    if (typeof body !== "object" || body === null) return text(400, "bad body");
    const latency = body.latencyMs ?? Number.NaN;
    if (Number.isSafeInteger(latency) && latency >= 0) {
      latencyMs = Math.min(latency, MAX_LATENCY);
    }
    if (body.bumpVersion === true) version++;
    if (body.dropStreams === true) for (const end of [...streams]) end();
    const advance = body.advanceMs ?? Number.NaN;
    if (Number.isSafeInteger(advance) && advance > 0) advanced += advance;
    if (body.resetClock === true) advanced = 0;
    const failNext = body.failNext ?? Number.NaN;
    if (Number.isSafeInteger(failNext) && failNext >= 0) failing = failNext;
    if (body.expireAccess === true) {
      tokens = { ...tokens, access: newToken("at") };
    }
    return json(snapshot());
  }

  function snapshot(): BackendStats {
    return {
      ...stats,
      now: now(),
      version: `v${version}`,
      latencyMs,
      pages: { ...stats.pages },
    };
  }

  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return undefined;
    const route = `${request.method} ${url.pathname}`;
    if (request.method === "GET" && SERIES.test(url.pathname)) {
      return series(request, url);
    }
    if (request.method === "GET" && STREAM.test(url.pathname)) {
      return stream(request, url);
    }
    switch (route) {
      // The demo has one user, already signed in: login hands out the
      // current tokens, so a second tab never invalidates the first.
      case "POST /api/auth/login":
        return json(tokens);
      case "POST /api/auth/refresh":
        return refresh(request);
      case "POST /api/control":
        return control(request);
      case "GET /api/stats":
        return json(snapshot());
      default:
        return text(404, "not found");
    }
  };
}
