import { createClient, type TscacheClient } from "@anishbenji/tscache";
import { afterEach, describe, expect, it } from "vitest";
import { createRenderer, defineComponent, h, shallowRef } from "vue";
import { createTscache, type Series, useSeries } from "../vue/series";
import { config, until } from "./helpers";

// The Vue adapter under Node: Vue's own custom renderer mounts a component
// into plain objects, so useSeries runs its real lifecycle without a DOM.
// Step 114 pre-review PR-1: a change while the first, fetching read is in
// flight must not replace that read with a cache-only one.

interface Gate {
  hold?: Promise<void>;
  entered?: () => void;
  fail: boolean;
}
const gate = (): Gate => (globalThis as unknown as { __m7vue: Gate }).__m7vue;
(globalThis as unknown as { __m7vue: Gate }).__m7vue = { fail: false };

const fetcher = `data:text/javascript,${encodeURIComponent(`
  export default {
    async fetch() {
      const g = globalThis.__m7vue;
      if (g.hold !== undefined) {
        const hold = g.hold;
        g.hold = undefined;
        g.entered?.();
        await hold;
      }
      if (g.fail) throw new Error("backend down");
      return { timestamps: [], fields: { v: [], n: [] } };
    },
  };
`)}`;

/** A renderer whose nodes are plain objects: enough to mount and unmount. */
const { createApp } = createRenderer<object, object>({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText: () => {},
  setElementText: () => {},
  insert: () => {},
  remove: () => {},
  patchProp: () => {},
  parentNode: () => null,
  nextSibling: () => null,
});

/** The range the mounted view shows, and the series it made. */
const range = shallowRef({ start: 100, end: 200 });
let series: Series | undefined;

/** A component that only reads a series, as a chart's would. */
const View = defineComponent(function View() {
  series = useSeries(config, range);
  return () => h("div");
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  (globalThis as unknown as { __m7vue: Gate }).__m7vue = { fail: false };
});

describe("Vue useSeries follows its cache", () => {
  it("a change during the first fetching read keeps that read's failure (PR-1)", async () => {
    let client: TscacheClient | undefined;
    const open = async () => {
      client = await createClient({
        mode: "in-process",
        fetcher: { module: fetcher },
      });
      return client;
    };
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      gate().entered = resolve;
    });
    gate().hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp(View);
    app.use(createTscache(open));
    app.mount({});
    unmounts.push(() => app.unmount());
    await entered;

    // Another writer of the same cache, while the first read fetches.
    const writer = await (client as TscacheClient).cache(config);
    await writer.put({ timestamps: [150], fields: { v: [1], n: [1] } });
    gate().fail = true;
    release();

    await until(() => series?.pending.value === false);
    // A round trip on the client's port, then a zero timer: a change
    // re-read the failure allowed would have answered by now.
    await writer.get(range.value, { cacheOnly: true });
    // clock-ok: zero timers run in the order queued; the frame fallback is one.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await writer.get(range.value, { cacheOnly: true });
    const reasons = series?.answer.value?.result.misses.map((m) => m.reason);
    expect(reasons).toContain("fetch-failed");
    expect(Array.from(series?.answer.value?.result.timestamps ?? [])).toEqual([
      150,
    ]);
  });
});
