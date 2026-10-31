import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Backend,
  type BackendStats,
  createBackend,
  SOCKET_CLOSE,
  type StreamBatch,
  type Tokens,
} from "../src/backend";
import { COLUMNS_TYPE, decodeColumns } from "../src/columns";
import { datasets } from "../src/datasets";
import { PAGE_SLOTS } from "../src/series";

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

  it("answers the same page as a columns body when the request accepts one", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    const path = `/api/series/candles/ACME?${query}`;
    const json = await call(backend, path);
    const binary = await call(backend, path, {
      headers: { accept: `${COLUMNS_TYPE}, application/json;q=0.5` },
    });
    expect(json.headers.get("content-type")).toMatch(/^application\/json/);
    expect(binary.headers.get("content-type")).toBe(COLUMNS_TYPE);
    // Caches between the two must keep the formats apart.
    expect(json.headers.get("vary")).toBe("accept");
    expect(binary.headers.get("vary")).toBe("accept");
    const page = await json.json();
    const decoded = decodeColumns(await binary.arrayBuffer());
    expect(decoded.header.fields).toEqual(
      Object.entries(datasets.candles.fields).map(([name, dtype]) => ({
        name,
        dtype,
      })),
    );
    expect(decoded.fields.volume).toBeInstanceOf(Uint32Array);
    expect(page.timestamps.length).toBeGreaterThan(0);
    expect([...decoded.timestamps]).toEqual(page.timestamps);
    for (const [name, values] of Object.entries(decoded.fields)) {
      expect([...values]).toEqual(page.fields[name]);
    }
    expect(decoded.header.meta).toEqual(page.meta);
    expect(decoded.header.next).toBeUndefined();
    expect((await stats(backend)).formats).toEqual({ json: 1, columns: 1 });
  });

  it("carries the next page's start in a columns header", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    const long = `start=${NOW - 2 * PAGE_SLOTS * MINUTE}&end=${NOW}&interval=${MINUTE}&offset=0`;
    const path = `/api/series/metrics/web?${long}`;
    const page = await (await call(backend, path)).json();
    const binary = await call(backend, path, {
      headers: { accept: COLUMNS_TYPE },
    });
    const { header, timestamps } = decodeColumns(await binary.arrayBuffer());
    expect(header.next).toBe(page.next);
    expect(timestamps).toHaveLength(PAGE_SLOTS);
  });

  it("answers JSON when the Accept refuses columns or prefers JSON", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    const typeFor = async (accept: string) =>
      (
        await call(backend, `/api/series/metrics/web?${query}`, {
          headers: { accept },
        })
      ).headers.get("content-type");
    expect(await typeFor(`${COLUMNS_TYPE};q=0, application/json`)).toMatch(
      /^application\/json/,
    );
    expect(await typeFor(`application/json, ${COLUMNS_TYPE};q=0.1`)).toMatch(
      /^application\/json/,
    );
    expect(await typeFor("APPLICATION/VND.TSCACHE.COLUMNS")).toBe(COLUMNS_TYPE);
  });

  it("answers JSON to a request that accepts anything", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    const response = await call(backend, `/api/series/metrics/web?${query}`, {
      headers: { accept: "*/*" },
    });
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
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
    // On fake timers: the answer waits exactly the latency, on any machine.
    vi.useFakeTimers();
    let answered = false;
    const answer = call(backend, `/api/series/events/x?${query}`).then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(39);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await answer;
    vi.useRealTimers();
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

  /** The next bar event of an event stream, parsed. */
  async function nextBatch(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<StreamBatch> {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the stream ended");
      const text = new TextDecoder().decode(value);
      if (text.startsWith("retry: ")) continue;
      const data = /^event: bar\ndata: (.*)\n\n$/.exec(text)?.[1];
      if (data === undefined) throw new Error(`not a bar event: ${text}`);
      return JSON.parse(data) as StreamBatch;
    }
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

  it("ends every stream on dropStreams, and moves the clock on advanceMs", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW + 30_000 });
    const response = await call(
      backend,
      `/api/stream/crypto/BTC?interval=${MINUTE}`,
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("retry: 500\n\n");
    expect((await nextBatch(reader)).timestamps).toEqual([NOW]);
    await call(backend, "/api/control", post({ dropStreams: true }));
    expect((await reader.read()).done).toBe(true);
    expect((await stats(backend)).streams).toBe(0);

    await call(backend, "/api/control", post({ advanceMs: MINUTE }));
    expect((await stats(backend)).now).toBe(NOW + 30_000 + MINUTE);
    const later = await call(
      backend,
      `/api/stream/crypto/BTC?interval=${MINUTE}`,
    );
    const next = (later.body as ReadableStream<Uint8Array>).getReader();
    expect((await nextBatch(next)).timestamps).toEqual([NOW + MINUTE]);
    await call(backend, "/api/control", post({ dropStreams: true }));
    await call(backend, "/api/control", post({ resetClock: true }));
    expect((await stats(backend)).now).toBe(NOW + 30_000);
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

describe("live socket", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A socket's server side, recording what the backend sends and closes. */
  function connect(backend: Backend) {
    const sent: StreamBatch[] = [];
    const closes: { code: number; reason: string }[] = [];
    const handler = backend.socket({
      send: (text) => sent.push(JSON.parse(text) as StreamBatch),
      close: (code, reason) => closes.push({ code, reason }),
    });
    return { sent, closes, handler };
  }

  const subscription = (token?: string) =>
    JSON.stringify({
      type: "subscribe",
      token,
      dataset: "crypto",
      symbol: "BTC",
      interval: MINUTE,
    });

  it("pushes the stream's batches after a subscription, until it closes", async () => {
    vi.useFakeTimers();
    let now = NOW + 30_000;
    const backend = createBackend({
      latencyMs: 0,
      pushMs: 1000,
      now: () => now,
    });
    const { sent, closes, handler } = connect(backend);
    expect(sent).toEqual([]);
    handler.message(subscription());
    expect((await stats(backend)).streams).toBe(1);
    expect(sent.map((batch) => batch.timestamps)).toEqual([[NOW]]);

    now = NOW + MINUTE + 1000;
    vi.advanceTimersByTime(1000);
    expect(sent[1]?.timestamps).toEqual([NOW, NOW + MINUTE]);
    // Later messages are not subscriptions.
    handler.message(subscription());
    expect(sent).toHaveLength(2);

    handler.closed();
    expect((await stats(backend)).streams).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(2);
    expect(closes).toEqual([]);
  });

  it("refuses a stale token with the refused close code, and takes the current one", async () => {
    const backend = createBackend({ auth: true, latencyMs: 0, now: () => NOW });
    const tokens: Tokens = await (
      await call(backend, "/api/auth/login", post({}))
    ).json();

    const none = connect(backend);
    none.handler.message(subscription());
    expect(none.closes).toEqual([
      { code: SOCKET_CLOSE.refused, reason: "access token refused" },
    ]);
    await call(backend, "/api/control", post({ expireAccess: true }));
    const stale = connect(backend);
    stale.handler.message(subscription(tokens.access));
    expect(stale.closes.map(({ code }) => code)).toEqual([4401]);
    expect(stale.sent).toEqual([]);
    expect((await stats(backend)).refused).toBe(2);

    const fresh: Tokens = await (
      await call(backend, "/api/auth/login", post({}))
    ).json();
    const current = connect(backend);
    current.handler.message(subscription(fresh.access));
    expect(current.closes).toEqual([]);
    expect(current.sent).toHaveLength(1);
    current.handler.closed();
  });

  it("closes on a bad subscription, and as a restart on dropStreams", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    for (const text of [
      "not json",
      JSON.stringify({ type: "hello" }),
      JSON.stringify({
        type: "subscribe",
        dataset: "nope",
        symbol: "x",
        interval: MINUTE,
      }),
      JSON.stringify({
        type: "subscribe",
        dataset: "crypto",
        symbol: "x",
        interval: 0.5,
      }),
      JSON.stringify({
        type: "subscribe",
        dataset: "crypto",
        symbol: "x",
        interval: MINUTE,
        token: 7,
      }),
    ]) {
      const { closes, handler } = connect(backend);
      handler.message(text);
      expect(closes.map(({ code }) => code)).toEqual([
        SOCKET_CLOSE.badSubscription,
      ]);
    }

    const { closes, handler } = connect(backend);
    handler.message(subscription());
    await call(backend, "/api/control", post({ dropStreams: true }));
    expect(closes).toEqual([
      { code: SOCKET_CLOSE.restart, reason: "the server restarted" },
    ]);
    expect((await stats(backend)).streams).toBe(0);
    // The transport reports the close it was asked for; nothing more happens.
    handler.closed();
    expect(closes).toHaveLength(1);
  });
});
