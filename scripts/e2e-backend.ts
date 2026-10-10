// In-memory mock backend for the Playwright suites: candles behind a bearer
// token, a rotating refresh endpoint, and gates that hold requests until the
// test releases them, so a test keeps a fetch in flight without sleeping.
// Tests run in parallel against one server, so state lives under
// /backend/<ns>/ and is created on first use. Every request is decided when
// it arrives; a hold delays only its answer.

export type Gate = "candles" | "refresh";

interface BackendState {
  /** Reported by candles answers, as it was when the request arrived. */
  version: string;
  /** The one valid access token and the one valid refresh token. */
  access: string;
  refresh: string;
  /** Bumped on expire and on rotation; tokens are `at-${g}` / `rt-${g}`. */
  generation: number;
  /** "start-end" → candles requests seen, counted on arrival, any outcome. */
  requests: Record<string, number>;
  /** Successful rotations. */
  refreshes: number;
  /** Refresh attempts with a refresh token that is not the current one. */
  reused: number;
  /** How many upcoming requests of each kind to hold. */
  hold: Record<Gate, number>;
  /** Resolvers of the requests currently held. */
  held: Record<Gate, Array<() => void>>;
}

/** GET /backend/<ns>/state. */
export interface BackendSnapshot {
  version: string;
  access: string;
  refresh: string;
  requests: Record<string, number>;
  refreshes: number;
  reused: number;
  /** Requests currently held, per gate. */
  held: Record<Gate, number>;
}

/** POST /backend/<ns>/control. */
export interface BackendControl {
  version?: string;
  /** Replaces the access token only; the refresh token stays valid. */
  expire?: true;
  /** Sets how many upcoming requests of each kind to hold. */
  hold?: Partial<Record<Gate, number>>;
  /** Answers every request held at that gate. */
  release?: Gate;
}

const states = new Map<string, BackendState>();

function stateOf(ns: string): BackendState {
  let state = states.get(ns);
  if (state === undefined) {
    state = {
      version: "v1",
      access: "at-0",
      refresh: "rt-0",
      generation: 0,
      requests: {},
      refreshes: 0,
      reused: 0,
      hold: { candles: 0, refresh: 0 },
      held: { candles: [], refresh: [] },
    };
    states.set(ns, state);
  }
  return state;
}

function pass(state: BackendState, gate: Gate): Promise<void> {
  if (state.hold[gate] === 0) return Promise.resolve();
  state.hold[gate]--;
  return new Promise((resolve) => state.held[gate].push(resolve));
}

/** Every grid point `offset + k * interval` inside [start, end]. */
function gridPoints(
  start: number,
  end: number,
  interval: number,
  offset: number,
): number[] {
  const points: number[] = [];
  const first = Math.ceil((start - offset) / interval) * interval + offset;
  for (let t = first; t <= end; t += interval) points.push(t);
  return points;
}

async function candles(
  state: BackendState,
  request: Request,
  url: URL,
): Promise<Response> {
  const param = (name: string) =>
    Number(url.searchParams.get(name) ?? Number.NaN);
  const start = param("start");
  const end = param("end");
  const interval = param("interval");
  const offset = param("offset");
  if (![start, end, interval, offset].every(Number.isFinite) || interval <= 0) {
    return new Response("bad query", { status: 400 });
  }
  const key = `${start}-${end}`;
  const calls = (state.requests[key] ?? 0) + 1;
  state.requests[key] = calls;
  const version = state.version;
  const valid =
    request.headers.get("authorization") === `Bearer ${state.access}`;
  await pass(state, "candles");
  if (!valid) return new Response("access token refused", { status: 401 });
  const timestamps = gridPoints(start, end, interval, offset);
  return Response.json({ timestamps, version, calls });
}

async function refresh(
  state: BackendState,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as { refresh?: unknown };
  const current = body.refresh === state.refresh;
  if (current) {
    state.generation++;
    state.access = `at-${state.generation}`;
    state.refresh = `rt-${state.generation}`;
    state.refreshes++;
  } else {
    state.reused++;
  }
  const tokens = { access: state.access, refresh: state.refresh };
  await pass(state, "refresh");
  return current
    ? Response.json(tokens)
    : new Response("refresh token reused", { status: 401 });
}

async function control(
  state: BackendState,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as BackendControl;
  if (body.version !== undefined) state.version = body.version;
  if (body.expire === true) {
    state.generation++;
    state.access = `at-${state.generation}`;
  }
  for (const [gate, n] of Object.entries(body.hold ?? {})) {
    state.hold[gate as Gate] = n;
  }
  if (body.release !== undefined) {
    for (const resolve of state.held[body.release].splice(0)) resolve();
  }
  return new Response(null, { status: 204 });
}

function snapshot(state: BackendState): BackendSnapshot {
  return {
    version: state.version,
    access: state.access,
    refresh: state.refresh,
    requests: { ...state.requests },
    refreshes: state.refreshes,
    reused: state.reused,
    held: {
      candles: state.held.candles.length,
      refresh: state.held.refresh.length,
    },
  };
}

const routes: Record<
  string,
  (state: BackendState, request: Request, url: URL) => Promise<Response>
> = {
  "GET candles": candles,
  "POST refresh": refresh,
  "POST control": control,
  "GET state": async (state) => Response.json(snapshot(state)),
};

/** Answers a request under /backend/. */
export function backend(request: Request, url: URL): Promise<Response> {
  const [, ns, action] =
    /^\/backend\/([^/]+)\/([^/]+)$/.exec(url.pathname) ?? [];
  const route = routes[`${request.method} ${action}`];
  if (ns === undefined || route === undefined) {
    return Promise.resolve(new Response("not found", { status: 404 }));
  }
  return route(stateOf(ns), request, url);
}
