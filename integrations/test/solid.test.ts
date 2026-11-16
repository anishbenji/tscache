import { createClient, type TscacheClient } from "@anishbenji/tscache";
import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "../shared/connection";
import { type Answer, createSeries } from "../solid/series";
import { config, until } from "./helpers";

// The Solid adapter under Node. Node resolves `solid-js` to its server
// build, whose computations never run again; the browser build's reactive
// core needs no DOM, so this file loads it instead. Step 114 pre-review
// PR2-1: a frame that fires while the first, fetching read is held must not
// turn that read's failure into `uncached`.
vi.mock("solid-js", async () => {
  const browser = new URL(
    "../node_modules/solid-js/dist/solid.js",
    import.meta.url,
  );
  return import(browser.href);
});

interface Gate {
  hold?: Promise<void>;
  entered?: () => void;
  fail: boolean;
  /** Answer with one bar and a watermark inside the view, counting fetches. */
  tail?: boolean;
  fetches?: number;
}
const gate = (): Gate =>
  (globalThis as unknown as { __m7solid: Gate }).__m7solid;
(globalThis as unknown as { __m7solid: Gate }).__m7solid = { fail: false };

const fetcher = `data:text/javascript,${encodeURIComponent(`
  export default {
    async fetch() {
      const g = globalThis.__m7solid;
      if (g.hold !== undefined) {
        const hold = g.hold;
        g.hold = undefined;
        g.entered?.();
        await hold;
      }
      if (g.fail) throw new Error("backend down");
      if (g.tail) {
        g.fetches = (g.fetches ?? 0) + 1;
        return {
          timestamps: [190],
          fields: { v: [1], n: [1] },
          meta: { finalizedUntil: 150 },
        };
      }
      return { timestamps: [], fields: { v: [], n: [] } };
    },
  };
`)}`;

const teardown: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of teardown.splice(0).reverse()) await step();
  vi.unstubAllGlobals();
  (globalThis as unknown as { __m7solid: Gate }).__m7solid = { fail: false };
});

describe("Solid createSeries follows its cache", () => {
  it("a frame that fires while the fetch is held keeps the fetch's failure (PR2-1)", async () => {
    // Animation frames the test runs by hand, so one fires mid-fetch.
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queued.push(callback);
      return queued.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      queued[id - 1] = () => {};
    });
    const runFrames = () => {
      for (const callback of queued.splice(0)) callback(0);
      flush();
    };
    let client: TscacheClient | undefined;
    const connection = connect(async () => {
      client = await createClient({
        mode: "in-process",
        fetcher: { module: fetcher },
      });
      return client;
    });
    teardown.push(() => connection.dispose());
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      gate().entered = resolve;
    });
    gate().hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const shown: Answer[] = [];
    createRoot((dispose) => {
      teardown.push(dispose);
      const series = createSeries(connection, config, () => ({
        start: 100,
        end: 200,
      }));
      createEffect(
        () => series(),
        (answer) => {
          shown.push(answer);
        },
      );
    });
    await entered;

    const writer = await (client as TscacheClient).cache(config);
    await writer.put({ timestamps: [150], fields: { v: [1], n: [1] } });
    expect(queued).toHaveLength(1);
    runFrames(); // while the fetch is still held
    gate().fail = true;
    release();
    // The fetching read's answer lands, with its failure.
    await until(() => shown.length === 1);
    expect(shown[0]?.result.misses.map((m) => m.reason)).toEqual([
      "fetch-failed",
      "fetch-failed",
    ]);
    // The held change comes back on a later frame, once the answer landed,
    // and its cache-only answer replaces it.
    await until(() => queued.length > 0);
    runFrames();
    await until(() => shown.length === 2);
    const result = shown[1]?.result;
    expect(Array.from(result?.timestamps ?? [])).toEqual([150]);
    expect(result?.misses.map((m) => m.reason)).toEqual([
      "fetch-failed",
      "fetch-failed",
    ]);
  });

  it("a derived range accessor reads its own change from the cache, never fetching in a loop (round 1, P0)", async () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queued.push(callback);
      return queued.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      queued[id - 1] = () => {};
    });
    gate().tail = true;
    const connection = connect(() =>
      createClient({ mode: "in-process", fetcher: { module: fetcher } }),
    );
    teardown.push(() => connection.dispose());
    const shown: Answer[] = [];
    createRoot((dispose) => {
      teardown.push(dispose);
      // A new object on every run: the same view by value.
      const series = createSeries(connection, config, () => ({
        start: 100,
        end: 200,
      }));
      createEffect(
        () => series(),
        (answer) => {
          shown.push(answer);
        },
      );
    });
    // The first read fetches; its write (provisional from 150) sends the
    // event whose frame is now queued: the answer arrives after the event.
    await until(() => shown.length === 1);
    expect(gate().fetches).toBe(1);
    expect(queued).toHaveLength(1);
    for (const callback of queued.splice(0)) callback(0);
    flush();
    await until(() => shown.length === 2);
    // A cache-only read: no fetch, so no write and no further event.
    expect(gate().fetches).toBe(1);
    expect(queued).toHaveLength(0);
  });
});
