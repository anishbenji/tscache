import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKEND_MS, request } from "./request";

// The demo recorder's one way to make an HTTP request (scripts/demo/record.ts):
// every request, its body included, fails after BACKEND_MS, so no exit path
// hangs on a server that never answers (step 65, PR6-3 and R4-2). The fetch
// is passed in, so fake timers drive the deadline: they do not drive
// AbortSignal.timeout.

/** A fetch that never answers: it settles only when its signal aborts. */
function silentFetch(): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

/** A body that never ends, until the signal of the fetch that sent it aborts. */
function stalledBody(signal: AbortSignal | null | undefined): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      signal?.addEventListener("abort", () => controller.error(signal.reason), {
        once: true,
      });
    },
  });
}

describe("request", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a request that never answers once BACKEND_MS have passed", async () => {
    const pending = request("http://127.0.0.1:1/api/stats", {}, silentFetch());
    const outcome = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(BACKEND_MS);
    await outcome;
  });

  it("does not reject before BACKEND_MS", async () => {
    let settled = false;
    const pending = request("http://127.0.0.1:1/api/stats", {}, silentFetch());
    pending
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(BACKEND_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it("rejects a response whose body never ends once BACKEND_MS have passed", async () => {
    const fetcher = ((_url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(new Response(stalledBody(init?.signal)))) as typeof fetch;
    const pending = request("http://127.0.0.1:1/ssr", {}, fetcher);
    const outcome = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(BACKEND_MS);
    await outcome;
  });

  it("passes on a fetch's own failure before the deadline, and leaves no timer behind", async () => {
    const refused = new TypeError("connection refused");
    const fetcher = ((_url: string | URL | Request) =>
      Promise.reject(refused)) as typeof fetch;
    await expect(
      request("http://127.0.0.1:1/api/stats", {}, fetcher),
    ).rejects.toBe(refused);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns an answer in time, body included, and leaves no timer behind", async () => {
    const seen: RequestInit[] = [];
    const fetcher = ((_url: string | URL | Request, init: RequestInit = {}) => {
      seen.push(init);
      return Promise.resolve(Response.json({ points: 3 }, { status: 201 }));
    }) as typeof fetch;
    const response = await request(
      "http://127.0.0.1:1/api/control",
      { method: "POST", body: "{}" },
      fetcher,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ points: 3 });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });
});
