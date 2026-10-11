import { describe, expect, it } from "vitest";
import {
  type Backend,
  type BackendStats,
  createBackend,
  type Tokens,
} from "../src/backend";

const NOW = Date.UTC(2026, 5, 3, 15);
const MINUTE = 60_000;

function call(
  backend: Backend,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return backend(new Request(`http://localhost${path}`, init)).then((r) => {
    if (r === undefined) throw new Error(`${path} was not handled`);
    return r;
  });
}

const query = `start=${NOW - 60 * MINUTE}&end=${NOW}&interval=${MINUTE}&offset=0`;

function post(body: unknown, token?: string): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify(body),
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  };
}

async function stats(backend: Backend): Promise<BackendStats> {
  return (await call(backend, "/api/stats")).json();
}

describe("createBackend", () => {
  it("answers series pages with the version and watermark", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    const response = await call(backend, `/api/series/metrics/web?${query}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.timestamps).toHaveLength(61);
    expect(Object.keys(body.fields)).toEqual(["cpu", "p95", "requests"]);
    expect(body.meta).toEqual({ version: "v1", finalizedUntil: NOW });
    expect(body.next).toBeUndefined();
    expect((await stats(backend)).pages).toEqual({ metrics: 1 });
  });

  it("leaves other paths alone and rejects bad requests", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    expect(await backend(new Request("http://localhost/index.html"))).toBe(
      undefined,
    );
    expect((await call(backend, `/api/series/nope/x?${query}`)).status).toBe(
      404,
    );
    expect((await call(backend, "/api/series/events/x?start=1")).status).toBe(
      400,
    );
    expect((await call(backend, "/api/elsewhere")).status).toBe(404);
  });

  it("restates the data under a new version", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    const path = `/api/series/metrics/web?${query}`;
    const before = await (await call(backend, path)).json();
    await call(backend, "/api/control", post({ bumpVersion: true }));
    const after = await (await call(backend, path)).json();
    expect(after.meta.version).toBe("v2");
    expect(after.fields.cpu).not.toEqual(before.fields.cpu);
  });

  it("refuses stale access tokens and rotates refresh tokens once", async () => {
    const backend = createBackend({ auth: true, latencyMs: 0, now: () => NOW });
    const path = `/api/series/candles/ACME?${query}`;
    expect((await call(backend, path)).status).toBe(401);

    const first: Tokens = await (
      await call(backend, "/api/auth/login", post({}))
    ).json();
    const authorized = (token: string) =>
      call(backend, path, { headers: { authorization: `Bearer ${token}` } });
    expect((await authorized(first.access)).status).toBe(200);

    await call(backend, "/api/control", post({ expireAccess: true }));
    expect((await authorized(first.access)).status).toBe(401);

    const refreshed = await call(
      backend,
      "/api/auth/refresh",
      post({ refresh: first.refresh }),
    );
    const second: Tokens = await refreshed.json();
    expect(second.refresh).not.toBe(first.refresh);
    expect((await authorized(second.access)).status).toBe(200);

    const replay = await call(
      backend,
      "/api/auth/refresh",
      post({ refresh: first.refresh }),
    );
    expect(replay.status).toBe(401);
    expect(await stats(backend)).toMatchObject({
      refused: 2,
      refreshes: 1,
      reused: 1,
    });
  });

  it("delays answers by the configured latency", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    await call(backend, "/api/control", post({ latencyMs: 40 }));
    const started = performance.now();
    await call(backend, `/api/series/events/x?${query}`);
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
    expect((await stats(backend)).latencyMs).toBe(40);
  });
});
