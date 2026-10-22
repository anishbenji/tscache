import { isAuthInvalidError } from "tscache";
import type { FetchRequest } from "tscache/fetcher";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Backend, createBackend } from "../src/backend";
import fetcher from "../src/fetcher";
import { type FetchNotice, onFetchNotice } from "../src/notices";
import { PAGE_SLOTS } from "../src/series";

const MINUTE = 60_000;
const START = Date.UTC(2026, 5, 1);
const NOW = START + 30 * 24 * 60 * MINUTE;

function serve(backend: Backend): void {
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

  it("rejects a cache id that names no series", async () => {
    serve(createBackend({ latencyMs: 0, now: () => NOW }));
    await expect(
      fetcher.fetch(request({ cacheId: "metrics" })),
    ).rejects.toThrow(/<dataset>\/<symbol>/);
  });
});
