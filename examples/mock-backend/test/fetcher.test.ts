import { isAuthInvalidError } from "tscache";
import type { FetchRequest } from "tscache/fetcher";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Backend, createBackend } from "../src/backend";
import { COLUMNS_TYPE, ColumnsError, encodeColumns } from "../src/columns";
import fetcher from "../src/fetcher";
import { type FetchNotice, onFetchNotice } from "../src/notices";
import { PAGE_SLOTS } from "../src/series";

const MINUTE = 60_000;
const START = Date.UTC(2026, 5, 1);
const NOW = START + 30 * 24 * 60 * MINUTE;

function serve(backend: (request: Request) => ReturnType<Backend>): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const response = await backend(
      new Request(new URL(input, "http://localhost"), init),
    );
    return response ?? new Response("not found", { status: 404 });
  });
}

function request(overrides: Partial<FetchRequest> = {}): FetchRequest {
  return {
    cacheId: "metrics/web",
    range: { start: START, end: START + (2 * PAGE_SLOTS + 10) * MINUTE },
    interval: MINUTE,
    alignmentOffset: 0,
    context: {},
    ...overrides,
  };
}

function nextNotice(): Promise<FetchNotice> {
  return new Promise((resolve) => {
    const stop = onFetchNotice((notice) => {
      stop();
      resolve(notice);
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetcher", () => {
  it("returns the whole range across pages and reports the fetch", async () => {
    serve(createBackend({ latencyMs: 0, now: () => NOW }));
    const noticed = nextNotice();
    const response = await fetcher.fetch(request());
    // Metrics have a point in every slot, so the count proves completeness.
    const timestamps = response.timestamps as number[];
    expect(timestamps).toHaveLength(2 * PAGE_SLOTS + 11);
    expect(timestamps[PAGE_SLOTS]).toBe(START + PAGE_SLOTS * MINUTE);
    expect((response.fields.cpu as number[]).length).toBe(timestamps.length);
    expect(response.meta).toEqual({ version: "v1", finalizedUntil: NOW });
    expect(await noticed).toMatchObject({ pages: 3, outcome: "ok" });
  });

  it("asks for columns bodies and returns typed arrays", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    const accepted: (string | null)[] = [];
    serve(async (req) => {
      accepted.push(req.headers.get("accept"));
      return backend(req);
    });
    const response = await fetcher.fetch(request({ cacheId: "candles/ACME" }));
    expect(accepted).toHaveLength(3);
    for (const accept of accepted) expect(accept).toContain(COLUMNS_TYPE);
    expect(response.timestamps).toBeInstanceOf(Float64Array);
    expect(response.fields.open).toBeInstanceOf(Float64Array);
    expect(response.fields.volume).toBeInstanceOf(Uint32Array);
    // The same data as the JSON pages, joined across the three pages.
    const json = await fetcher.fetch(
      request({ cacheId: "candles/ACME", context: { format: "json" } }),
    );
    expect(Array.isArray(json.timestamps)).toBe(true);
    expect(json.timestamps.length).toBeGreaterThan(1000);
    expect([...response.timestamps]).toEqual(json.timestamps);
    expect(Object.keys(response.fields)).toEqual(Object.keys(json.fields));
    for (const [name, values] of Object.entries(response.fields)) {
      expect([...(values as ArrayLike<number> & Iterable<number>)]).toEqual(
        json.fields[name],
      );
    }
    expect(response.meta).toEqual(json.meta);
  });

  it("asks for JSON when its context says so", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    const accepted: (string | null)[] = [];
    serve(async (req) => {
      accepted.push(req.headers.get("accept"));
      return backend(req);
    });
    await fetcher.fetch(request({ context: { format: "json" } }));
    expect(accepted.length).toBeGreaterThan(0);
    for (const accept of accepted)
      expect(accept ?? "").not.toContain(COLUMNS_TYPE);
  });

  it("returns a one-page range as views over the body it fetched", async () => {
    serve(createBackend({ latencyMs: 0, now: () => NOW }));
    const response = await fetcher.fetch(
      request({ range: { start: START, end: START + 59 * MINUTE } }),
    );
    const timestamps = response.timestamps as Float64Array;
    expect(timestamps).toBeInstanceOf(Float64Array);
    expect(timestamps).toHaveLength(60);
    for (const values of Object.values(response.fields)) {
      expect((values as Float32Array).buffer).toBe(timestamps.buffer);
    }
  });

  it("reads JSON from a backend that ignores Accept", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    serve(async (req) => {
      const headers = new Headers(req.headers);
      headers.delete("accept");
      return backend(new Request(req.url, { headers }));
    });
    const response = await fetcher.fetch(request());
    expect(Array.isArray(response.timestamps)).toBe(true);
    expect(response.timestamps).toHaveLength(2 * PAGE_SLOTS + 11);
  });

  it("rejects a truncated columns body as a failed fetch", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    serve(async (req) => {
      const response = (await backend(req)) as Response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(bytes.subarray(0, bytes.byteLength - 1), {
        headers: response.headers,
      });
    });
    const noticed = nextNotice();
    const error = await fetcher.fetch(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ColumnsError);
    expect(isAuthInvalidError(error)).toBe(false);
    expect(await noticed).toMatchObject({ outcome: "failed" });
  });

  it("reads a columns body whatever the parameters or case of its type", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    for (const type of [
      `${COLUMNS_TYPE}; charset=binary`,
      "Application/VND.tscache.Columns",
      ` ${COLUMNS_TYPE} ;v=1`,
    ]) {
      serve(async (req) => {
        const response = (await backend(req)) as Response;
        return new Response(await response.arrayBuffer(), {
          headers: { "content-type": type },
        });
      });
      const response = await fetcher.fetch(request());
      expect(response.timestamps, type).toBeInstanceOf(Float64Array);
      expect(response.timestamps).toHaveLength(2 * PAGE_SLOTS + 11);
    }
  });

  it("refuses a u8 page followed by a u16 page rather than wrap 300 to 44", async () => {
    const page = (dtype: "u8" | "u16", value: number, next?: number) =>
      new Response(
        encodeColumns(
          {
            timestamps: [next === undefined ? START + MINUTE : START],
            fields: { volume: [value] },
            dtypes: { volume: dtype },
          },
          {
            meta: { version: "v1", finalizedUntil: NOW },
            ...(next === undefined ? {} : { next }),
          },
        ),
        { headers: { "content-type": COLUMNS_TYPE } },
      );
    const pages = [page("u8", 1, START + MINUTE), page("u16", 300)];
    vi.stubGlobal("fetch", async () => pages.shift());
    await expect(fetcher.fetch(request())).rejects.toThrow(/columns differ/);
  });

  it("refuses pages whose field names only join to the same text", async () => {
    // ["a\0b"] and ["a", "b"] read alike once joined with NUL (R2-1's class).
    const page = (fields: Record<string, number[]>, next?: number) =>
      new Response(
        JSON.stringify({
          timestamps: [next === undefined ? START + MINUTE : START],
          fields,
          meta: { version: "v1", finalizedUntil: NOW },
          ...(next === undefined ? {} : { next }),
        }),
      );
    const pages = [
      page({ "a\u0000b": [1] }, START + MINUTE),
      page({ a: [2], b: [3] }),
    ];
    vi.stubGlobal("fetch", async () => pages.shift());
    await expect(fetcher.fetch(request())).rejects.toThrow(/columns differ/);
  });

  it("refuses pages whose columns disagree", async () => {
    const page = (dtype: "f64" | "f32", next?: number) =>
      new Response(
        encodeColumns(
          { timestamps: [START], fields: { cpu: [1] }, dtypes: { cpu: dtype } },
          {
            meta: { version: "v1", finalizedUntil: NOW },
            ...(next === undefined ? {} : { next }),
          },
        ),
        { headers: { "content-type": COLUMNS_TYPE } },
      );
    const pages = [page("f64", START + MINUTE), page("f32")];
    vi.stubGlobal("fetch", async () => pages.shift());
    await expect(fetcher.fetch(request())).rejects.toThrow(/columns differ/);
  });

  it("keeps the earliest watermark of its pages", async () => {
    // The clock moves on between pages, so each page reports a later
    // watermark than the one before.
    let now = NOW;
    const backend = createBackend({ latencyMs: 0, now: () => now });
    serve(async (req) => {
      const response = await backend(req);
      now += MINUTE;
      return response;
    });
    const response = await fetcher.fetch(request());
    expect(response.meta?.finalizedUntil).toBe(NOW);
  });

  it("refuses to mix two dataset versions in one range", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    let pages = 0;
    serve(async (req) => {
      const response = await backend(req);
      if (++pages === 1) {
        await backend(
          new Request("http://localhost/api/control", {
            method: "POST",
            body: JSON.stringify({ bumpVersion: true }),
          }),
        );
      }
      return response;
    });
    const response = await fetcher.fetch(request());
    expect(response.meta?.version).toBe("v2");
    expect(pages).toBe(5);
  });

  it("throws AuthInvalidError when the token is refused", async () => {
    serve(createBackend({ auth: true, latencyMs: 0, now: () => NOW }));
    const noticed = nextNotice();
    const error = await fetcher
      .fetch(request({ context: { token: "at-stale" } }))
      .catch((e: unknown) => e);
    expect(isAuthInvalidError(error)).toBe(true);
    expect(await noticed).toMatchObject({ outcome: "auth-invalid" });
  });

  it("asks the backend at the context's origin when it has one", async () => {
    const backend = createBackend({ latencyMs: 0, now: () => NOW });
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      asked.push(String(input));
      return (await backend(new Request(input, init))) as Response;
    });
    await fetcher.fetch(
      request({ context: { origin: "http://127.0.0.1:5105/" } }),
    );
    expect(asked).toHaveLength(3);
    for (const url of asked) {
      expect(url).toMatch(
        /^http:\/\/127\.0\.0\.1:5105\/api\/series\/metrics\/web\?/,
      );
    }
  });

  it("keeps fields whose names Object.prototype also has", async () => {
    // Raw JSON, so __proto__ arrives as an own key, as from a backend; an
    // object literal would set the prototype instead.
    const meta = `"meta":{"version":"v1","finalizedUntil":${NOW}}`;
    const pages = [
      `{"timestamps":[${START}],"fields":{"constructor":[1],"__proto__":[2]},${meta},"next":${START + MINUTE}}`,
      `{"timestamps":[${START + MINUTE}],"fields":{"constructor":[3],"__proto__":[4]},${meta}}`,
    ];
    vi.stubGlobal("fetch", async () => new Response(pages.shift()));
    const response = await fetcher.fetch(request());
    expect(Object.entries(response.fields)).toEqual([
      ["constructor", [1, 3]],
      ["__proto__", [2, 4]],
    ]);
  });

  it("rejects a cache id that names no series", async () => {
    serve(createBackend({ latencyMs: 0, now: () => NOW }));
    await expect(
      fetcher.fetch(request({ cacheId: "metrics" })),
    ).rejects.toThrow(/<dataset>\/<symbol>/);
  });
});
