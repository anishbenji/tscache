// The mock backend as a fetch-style handler: series pages, bearer-token auth
// with refresh-token rotation, and controls the example pages call to show
// what tscache does about latency, a dataset version change or an expired
// token. All state lives in memory, one backend per dev or preview server.

import { datasets, isDatasetName } from "./datasets";
import { seedOf } from "./noise";
import { type SeriesQuery, seriesPage } from "./series";

export interface BackendOptions {
  /** Delay before each series page and refresh answer. Default 300 ms. */
  latencyMs?: number;
  /** Require a bearer token on series requests. Default false. */
  auth?: boolean;
  /** Clock, for tests. Default `Date.now`. */
  now?: () => number;
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
}

/** Answers a request under /api/, or undefined for any other path. */
export type Backend = (request: Request) => Promise<Response | undefined>;

const SERIES = /^\/api\/series\/([^/]+)\/([^/]+)$/;

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
  const finite = Object.values(query).every(Number.isFinite);
  return finite && query.interval > 0 && query.start <= query.end
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
  const now = options.now ?? Date.now;
  const auth = options.auth ?? false;
  let latencyMs = options.latencyMs ?? 300;
  let version = 1;
  let tokens: Tokens = { access: newToken("at"), refresh: newToken("rt") };
  const stats = {
    pages: {} as Record<string, number>,
    refused: 0,
    refreshes: 0,
    reused: 0,
  };

  async function series(request: Request, url: URL): Promise<Response> {
    const [, dataset = "", symbol = ""] = SERIES.exec(url.pathname) ?? [];
    if (!isDatasetName(dataset)) return text(404, "unknown dataset");
    const query = parseQuery(url);
    if (query === undefined) return text(400, "bad query");
    // Decided on arrival, like a real server; the latency only delays it.
    const authorized =
      !auth ||
      request.headers.get("authorization") === `Bearer ${tokens.access}`;
    const tag = `v${version}`;
    const seed = seedOf(`${dataset}/${decodeURIComponent(symbol)}/${tag}`);
    const page = authorized
      ? seriesPage(datasets[dataset], seed, query, now())
      : undefined;
    await sleep(latencyMs);
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
    if (typeof body.latencyMs === "number" && body.latencyMs >= 0) {
      latencyMs = body.latencyMs;
    }
    if (body.bumpVersion === true) version++;
    if (body.expireAccess === true) {
      tokens = { ...tokens, access: newToken("at") };
    }
    return json(snapshot());
  }

  function snapshot(): BackendStats {
    return {
      ...stats,
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
