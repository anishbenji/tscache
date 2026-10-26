import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Backend,
  type BackendStats,
  createBackend,
  type StreamBatch,
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
    expect(
      (await call(backend, `/api/series/metrics/%E0%A4?${query}`)).status,
    ).toBe(200);
    // An interval too small to advance a timestamp would never end the scan.
    const tiny = "start=1e12&end=1e12&interval=0.000001&offset=0";
    expect((await call(backend, `/api/series/metrics/x?${tiny}`)).status).toBe(
      400,
    );
    const fraction = `start=${NOW + 0.5}&end=${NOW + MINUTE}&interval=${MINUTE}&offset=0`;
    expect(
      (await call(backend, `/api/series/metrics/x?${fraction}`)).status,
    ).toBe(400);
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
    for (const latencyMs of [-1, 1.5, "9", null]) {
      await call(backend, "/api/control", post({ latencyMs }));
    }
    expect((await stats(backend)).latencyMs).toBe(40);
    await call(backend, "/api/control", post({ latencyMs: 1e12 }));
    expect((await stats(backend)).latencyMs).toBe(60_000);
  });
});

describe("failNext", () => {
  it("fails that many series requests, then answers again", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    const path = `/api/series/metrics/web?${query}`;
    await call(backend, "/api/control", post({ failNext: 2 }));
    expect((await call(backend, path)).status).toBe(500);
    expect((await call(backend, path)).status).toBe(500);
    expect((await call(backend, path)).status).toBe(200);
  });
});

describe("service token", () => {
  it("accepts series requests with the service token, whatever the user's token", async () => {
    const backend = createBackend({
      latencyMs: 0,
      auth: true,
      serviceToken: "service",
      now: () => NOW,
    });
    const path = `/api/series/metrics/web?${query}`;
    const as = (token: string) => ({
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await call(backend, path, as("service"))).status).toBe(200);
    expect((await call(backend, path, as("other"))).status).toBe(401);
  });
});

describe("live stream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The next message of an event stream, parsed. */
  async function nextBatch(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<StreamBatch> {
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const data = /^event: bar\ndata: (.*)\n\n$/.exec(text)?.[1];
    if (data === undefined) throw new Error(`not a bar event: ${text}`);
    return JSON.parse(data) as StreamBatch;
  }

  it("pushes the forming bar, then the closed bar with its final values", async () => {
    // The clock moves only when the test says, so each message is known.
    vi.useFakeTimers();
    let now = NOW + 30_000;
    const backend = createBackend({
      latencyMs: 0,
      pushMs: 1000,
      now: () => now,
    });
    const gone = new AbortController();
    const response = await call(
      backend,
      `/api/stream/crypto/BTC?interval=${MINUTE}`,
      { signal: gone.signal },
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect((await stats(backend)).streams).toBe(1);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    const first = await nextBatch(reader);
    expect(first.timestamps).toEqual([NOW]);
    expect(first.meta).toEqual({ version: "v1", finalizedUntil: NOW });
    expect(Object.keys(first.fields)).toEqual([
      "open",
      "high",
      "low",
      "close",
      "volume",
    ]);

    now = NOW + MINUTE + 1000;
    vi.advanceTimersByTime(1000);
    const second = await nextBatch(reader);
    expect(second.timestamps).toEqual([NOW, NOW + MINUTE]);
    expect(second.meta.finalizedUntil).toBe(NOW + MINUTE);
    // The closed bar as the series answers it once final.
    const page = await (
      await call(
        backend,
        `/api/series/crypto/BTC?start=${NOW}&end=${NOW}&interval=${MINUTE}&offset=0`,
      )
    ).json();
    expect(second.fields.close?.[0]).toBe(page.fields.close[0]);

    gone.abort();
    expect((await stats(backend)).streams).toBe(0);
  });

  it("rejects unknown datasets and bad intervals", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    expect((await call(backend, "/api/stream/nope/x?interval=1")).status).toBe(
      404,
    );
    expect((await call(backend, "/api/stream/crypto/x")).status).toBe(400);
    expect(
      (await call(backend, "/api/stream/crypto/x?interval=0.5")).status,
    ).toBe(400);
  });
});
