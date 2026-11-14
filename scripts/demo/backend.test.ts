import { describe, expect, it } from "vitest";
import { Backend } from "./backend";

// The demo recorder's gate on its demo's backend (scripts/demo/record.ts):
// nothing is sent to the recorded app's port until the recorder has accepted
// its own launcher's hub, and nothing once that launcher is stopping or has
// exited, since the port may be anyone's then (step 65 R3-1; step 89
// pre-reviews).

/** A fetch that records each URL it is asked for and answers 200. */
function recording(): { fetcher: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetcher = ((url: string | URL | Request) => {
    urls.push(String(url));
    return Promise.resolve(Response.json({ ok: true }));
  }) as typeof fetch;
  return { fetcher, urls };
}

const ORIGIN = "http://127.0.0.1:5201/";

describe("Backend", () => {
  it("sends nothing before its demo is accepted", async () => {
    const { fetcher, urls } = recording();
    const backend = new Backend(ORIGIN, fetcher);
    await expect(backend.request("api/stats")).rejects.toThrow(/own demo/);
    expect(urls).toEqual([]);
  });

  it("sends to its origin once its demo is accepted", async () => {
    const { fetcher, urls } = recording();
    const backend = new Backend(ORIGIN, fetcher);
    backend.accept();
    const response = await backend.request("api/control", { method: "POST" });
    expect(response.ok).toBe(true);
    expect(urls).toEqual([`${ORIGIN}api/control`]);
  });

  it("sends nothing once its demo is lost, even if accepted again", async () => {
    const { fetcher, urls } = recording();
    const backend = new Backend(ORIGIN, fetcher);
    backend.accept();
    backend.lose();
    await expect(backend.request("api/control")).rejects.toThrow(/own demo/);
    backend.accept();
    await expect(backend.request("api/stats")).rejects.toThrow(/own demo/);
    expect(urls).toEqual([]);
  });
});
