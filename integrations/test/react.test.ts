import {
  type CacheConfig,
  createClient,
  type GetResult,
  type Range,
  type TscacheClient,
} from "@anishbenji/tscache";
import {
  Activity,
  createElement,
  type ExoticComponent,
  StrictMode,
  Suspense,
  useEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TscacheProvider, useSeries } from "../react/series";
import { type Connection, connect } from "../shared/connection";
import { config, until } from "./helpers";

// The React adapter under Node, with no new dependency: react-dom/client
// renders into a stub container, which is enough for a tree that renders
// no host node (the components below return null). Step 114: round 1's
// P1 (a change carried into another cache or client), and pre-review
// PR-2, PR-4 and PR2-2, which had no test before.

const g = globalThis as Record<string, unknown>;
const noop = () => {};
const doc: Record<string, unknown> = {
  nodeType: 9,
  addEventListener: noop,
  removeEventListener: noop,
  activeElement: null,
  body: null,
};
doc.defaultView = g;
doc.ownerDocument = doc;
const container = {
  nodeType: 1,
  nodeName: "DIV",
  tagName: "DIV",
  ownerDocument: doc,
  namespaceURI: "http://www.w3.org/1999/xhtml",
  addEventListener: noop,
  removeEventListener: noop,
  childNodes: [],
  firstChild: null,
  lastChild: null,
  appendChild: noop,
  removeChild: noop,
  insertBefore: noop,
  textContent: "",
};
g.window = g;
g.document = doc;
g.HTMLIFrameElement = class {};

interface Backend {
  /** Fetches per cache id. */
  fetches: Record<string, number>;
  hold?: Promise<void>;
  entered?: () => void;
  /** Holds for the next fetches, one each, in order. */
  holds: { wait: Promise<void>; entered: () => void }[];
  fail: boolean;
  /** Answer with a watermark inside the range: its tail stays provisional. */
  tail?: boolean;
}
const backend = (): Backend =>
  (globalThis as unknown as { __m7react: Backend }).__m7react;
function resetBackend(): void {
  (globalThis as unknown as { __m7react: Backend }).__m7react = {
    fetches: {},
    holds: [],
    fail: false,
  };
}
resetBackend();

/**
 * Answers every fetch with one bar 50 ms into the range asked (150 for
 * 100-200), counting fetches per cache.
 */
const fetcher = `data:text/javascript,${encodeURIComponent(`
  export default {
    async fetch(request) {
      const b = globalThis.__m7react;
      b.fetches[request.cacheId] = (b.fetches[request.cacheId] ?? 0) + 1;
      if (b.hold !== undefined) {
        const hold = b.hold;
        b.hold = undefined;
        b.entered?.();
        await hold;
      }
      const queued = b.holds.shift();
      if (queued !== undefined) {
        queued.entered();
        await queued.wait;
      }
      if (b.fail) throw new Error("backend down");
      return {
        timestamps: [request.range.start + 50],
        fields: { v: [7], n: [1] },
        ...(b.tail ? { meta: { finalizedUntil: request.range.start + 20 } } : {}),
      };
    },
  };
`)}`;

const teardown: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of teardown.splice(0).reverse()) await step();
  gets.length = 0;
  answered.length = 0;
  vi.unstubAllGlobals();
  resetBackend();
});

const range = { start: 100, end: 200 };

/** What the view rendered, newest last. */
interface Rendered {
  cache: string;
  points: number[];
  misses: string[];
}

/** What the mounted view rendered, and how often the fallback showed. */
const seen = { renders: [] as Rendered[], fallbacks: 0 };

function Chart(props: { config: CacheConfig; range: Range; inline: boolean }) {
  // `inline`: an equal config, but a new object on every render.
  const cacheConfig = props.inline ? { ...props.config } : props.config;
  const result: GetResult = useSeries(cacheConfig, props.range);
  seen.renders.push({
    cache: props.config.id,
    points: Array.from(result.timestamps),
    misses: result.misses.map((miss) => miss.reason),
  });
  return null;
}

function Fallback() {
  seen.fallbacks++;
  return null;
}

function mount(connection: Connection, strict = false) {
  seen.renders = [];
  seen.fallbacks = 0;
  const root: Root = createRoot(container as never);
  teardown.push(() => root.unmount());
  const show = (cacheConfig: CacheConfig, range: Range, inline = false) => {
    const tree = createElement(
      TscacheProvider,
      { connection },
      createElement(
        Suspense,
        { fallback: createElement(Fallback) },
        createElement(Chart, { config: cacheConfig, range, inline }),
      ),
    );
    root.render(strict ? createElement(StrictMode, null, tree) : tree);
  };
  return {
    renders: seen.renders,
    show,
    fallbacks: () => seen.fallbacks,
    unmount: () => root.unmount(),
  };
}

/** Two series in one component, so one Suspense boundary waits on both. */
function Pair(props: { first: CacheConfig; second: CacheConfig }) {
  const first = useSeries(props.first, range);
  const second = useSeries(props.second, range);
  seen.renders.push({
    cache: `${props.first.id}+${props.second.id}`,
    points: [...first.timestamps, ...second.timestamps],
    misses: [...first.misses, ...second.misses].map((miss) => miss.reason),
  });
  return null;
}

function mountPair(
  connection: Connection,
  first: CacheConfig,
  second: CacheConfig,
) {
  seen.renders = [];
  seen.fallbacks = 0;
  const root: Root = createRoot(container as never);
  teardown.push(() => root.unmount());
  root.render(
    createElement(
      TscacheProvider,
      { connection },
      createElement(
        Suspense,
        { fallback: createElement(Fallback) },
        createElement(Pair, { first, second }),
      ),
    ),
  );
  return { renders: seen.renders };
}

/** Activity, typed so that createElement takes its children as arguments. */
const Hideable = Activity as ExoticComponent<{ mode: "visible" | "hidden" }>;

/** Whether the Activity's effects are torn down: it is hidden. */
const activity = { hidden: false };
function Effects() {
  useEffect(() => {
    activity.hidden = false;
    return () => {
      activity.hidden = true;
    };
  }, []);
  return null;
}

/** A chart inside an Activity the test hides and shows. */
function mountActivity(connection: Connection) {
  seen.renders = [];
  seen.fallbacks = 0;
  activity.hidden = false;
  const root: Root = createRoot(container as never);
  teardown.push(() => root.unmount());
  const show = (mode: "visible" | "hidden") =>
    root.render(
      createElement(
        TscacheProvider,
        { connection },
        createElement(
          Suspense,
          { fallback: createElement(Fallback) },
          createElement(
            Hideable,
            { mode },
            createElement(Chart, { config, range, inline: false }),
            createElement(Effects),
          ),
        ),
      ),
    );
  return { renders: seen.renders, show, unmount: () => root.unmount() };
}

/** Animation frames the test runs by hand. */
function stubFrames(): { queued: FrameRequestCallback[]; run(): void } {
  const queued: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queued.push(callback);
    return queued.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queued[id - 1] = () => {};
  });
  return {
    queued,
    run: () => {
      for (const callback of queued.splice(0)) callback(0);
    },
  };
}

/** Holds the next fetch not held yet; resolves `entered` once it waits. */
function holdFetch(): { entered: Promise<void>; release(): void } {
  let release = () => {};
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend().holds.push({ wait, entered });
  return { entered: waiting, release };
}

/** Every get the page made, as `<cache> <start>-<end> <fetch|cache>`. */
const gets: string[] = [];
/** The gets the cache has answered, named the same. */
const answered: string[] = [];

/** A client whose cache handles log their gets. */
function logging(client: TscacheClient): TscacheClient {
  const open = client.cache.bind(client);
  client.cache = async (cacheConfig) => {
    const handle = await open(cacheConfig);
    const get = handle.get.bind(handle);
    handle.get = (asked, options) => {
      const how = options?.cacheOnly === true ? "cache" : "fetch";
      const what = `${cacheConfig.id} ${asked.start}-${asked.end} ${how}`;
      gets.push(what);
      const answer = get(asked, options);
      answer.then(
        () => answered.push(what),
        () => {},
      );
      return answer;
    };
    return handle;
  };
  return client;
}

/** A logging client with the fetcher, whose worker a test can lose. */
async function losable(): Promise<{ client: TscacheClient; lose(): void }> {
  const real = logging(
    await createClient({ mode: "in-process", fetcher: { module: fetcher } }),
  );
  const listeners = new Set<() => void>();
  let lost = false;
  const live = <T>(call: () => Promise<T>): Promise<T> =>
    lost ? Promise.reject(new Error("worker lost")) : call();
  const client: TscacheClient = {
    get mode() {
      return real.mode;
    },
    get features() {
      return real.features;
    },
    cache: (c) => live(() => real.cache(c)),
    clearAll: () => live(() => real.clearAll()),
    updateAuth: (context) => live(() => real.updateAuth(context)),
    on(event, fn) {
      if (event !== "workerLost") return real.on(event, fn);
      const listener = fn as () => void;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    off(event, fn) {
      if (event === "workerLost") listeners.delete(fn as () => void);
      else real.off(event, fn);
    },
    dispose: () => real.dispose(),
  };
  return {
    client,
    lose() {
      lost = true;
      void real.dispose();
      for (const fn of listeners) fn();
    },
  };
}

async function connected(): Promise<{
  connection: Connection;
  clients: TscacheClient[];
}> {
  const clients: TscacheClient[] = [];
  const connection = connect(async () => {
    const client = logging(
      await createClient({ mode: "in-process", fetcher: { module: fetcher } }),
    );
    clients.push(client);
    return client;
  });
  teardown.push(() => connection.dispose());
  return { connection, clients };
}

describe("React useSeries follows its cache", () => {
  it("a change recorded for one cache is not carried into another at the same range (round 1, P1)", async () => {
    const { connection } = await connected();
    const view = mount(connection);
    const a = { ...config, id: "a" };
    const b = { ...config, id: "b" };
    view.show(a, range);
    await until(() => view.renders.at(-1)?.points.length === 1);
    // The subscription's catch-up records a cache-only change for a.
    await until(() => view.renders.length >= 2);
    await until(() => gets.includes("a 100-200 cache"));
    view.show(b, range);
    // b's first read fetches: a's change record is not b's.
    await until(() => backend().fetches.b === 1);
    expect(gets.filter((get) => get.startsWith("b "))[0]).toBe(
      "b 100-200 fetch",
    );
    expect(backend().fetches).toEqual({ a: 1, b: 1 });
  });

  it("a change recorded on a lost client is not carried into its replacement (round 1, P1)", async () => {
    const clients: { client: TscacheClient; lose(): void }[] = [];
    const connection = connect(async () => {
      const next = await losable();
      clients.push(next);
      return next.client;
    });
    teardown.push(() => connection.dispose());
    const view = mount(connection);
    view.show(config, range);
    await until(() => view.renders.at(-1)?.points.length === 1);
    // The subscription's catch-up records a cache-only change.
    await until(() => gets.includes("h 100-200 cache"));
    clients[0]?.lose();
    // The replacement's cache is a new, empty one: its first read fetches.
    await until(() => clients.length === 2);
    await until(() => (backend().fetches.h ?? 0) === 2);
    expect(gets.filter((get) => get === "h 100-200 fetch")).toHaveLength(2);
    await until(() => view.renders.at(-1)?.points.length === 1);
  });

  it("a fresh range object with the same endpoints is the same view (round 1, audit)", async () => {
    const { connection, clients } = await connected();
    const view = mount(connection);
    view.show(config, range);
    await until(() => gets.includes("h 100-200 cache"));
    view.show(config, { ...range });
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.put({ timestamps: [160], fields: { v: [8], n: [1] } });
    await until(() => view.renders.at(-1)?.points.length === 2);
    // Only the first read fetched; the change re-read read the cache.
    expect(backend().fetches).toEqual({ h: 1 });
    expect(gets.filter((get) => get.endsWith("fetch"))).toEqual([
      "h 100-200 fetch",
    ]);
  });

  it("a change re-read never brings back the Suspense fallback (PR-2)", async () => {
    const { connection, clients } = await connected();
    const view = mount(connection);
    view.show(config, range);
    await until(() => view.renders.at(-1)?.points.length === 1);
    expect(view.fallbacks()).toBe(1);
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.put({ timestamps: [160], fields: { v: [8], n: [1] } });
    await until(() => view.renders.at(-1)?.points.length === 2);
    expect(view.fallbacks()).toBe(1);
  });

  it("a change while the newest read fetches keeps that read's failure (PR2-2)", async () => {
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
    };
    const { connection, clients } = await connected();
    const view = mount(connection);
    view.show(config, range);
    await until(() => view.renders.at(-1)?.points.length === 1);
    // Let the subscription's catch-up read land before the scenario.
    await until(() => queued.length > 0);
    runFrames();
    await until(() => view.renders.length >= 2);
    // An invalidate from another tab: the view refetches (held fetch).
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      backend().entered = resolve;
    });
    backend().hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.invalidate(range);
    await until(() => queued.length > 0);
    runFrames();
    await entered;
    // A bar arrives while that fetch is held; its frame fires now.
    await writer.put({ timestamps: [160], fields: { v: [8], n: [1] } });
    await until(() => queued.length > 0);
    runFrames();
    backend().fail = true;
    release();
    await until(() =>
      (view.renders.at(-1)?.misses ?? []).includes("fetch-failed"),
    );
    // The held change comes back after the answer, and keeps its labels.
    await until(() => queued.length > 0);
    runFrames();
    await until(() => view.renders.at(-1)?.points.length === 2);
    expect(view.renders.at(-1)?.misses).not.toContain("uncached");
  });

  it("a new range's commit reads it from the cache once more (PR-4)", async () => {
    const { connection } = await connected();
    const view = mount(connection);
    view.show(config, range);
    await until(() => gets.includes("h 100-200 cache"));
    view.show(config, { start: 100, end: 210 });
    // The move fetches; once it commits, a change judged against the old
    // range in between is caught by one cache-only read of the new one.
    await until(() => gets.includes("h 100-210 fetch"));
    await until(() => gets.includes("h 100-210 cache"));
  });

  it("a change held on an overtaken fetch does not block the current view's (PR3-1)", async () => {
    const frames = stubFrames();
    const { connection, clients } = await connected();
    const view = mount(connection);
    const elsewhere = { start: 300, end: 400 };
    view.show(config, range);
    await until(() => view.renders.at(-1)?.points.length === 1);
    await until(() => frames.queued.length > 0);
    frames.run(); // the subscription's catch-up
    await until(() => gets.includes("h 100-200 cache"));
    // The writer shares the view's port: when a write resolves, its event
    // has arrived and its frame is queued.
    const writer = await (clients[0] as TscacheClient).cache(config);
    // The first range refetches after an invalidate, and that fetch hangs.
    const stuck = holdFetch();
    await writer.invalidate(range);
    frames.run();
    await stuck.entered;
    // A bar during the hung fetch: held on it.
    await writer.put({ timestamps: [160], fields: { v: [8], n: [1] } });
    frames.run();
    // The view moves on; its new range's fetch lands, and the range
    // commits: its commit reads the new range from the cache once (PR-4),
    // which also says the view now follows changes over it.
    view.show(config, elsewhere);
    await until(() => view.renders.at(-1)?.points.includes(350) === true);
    while (!gets.includes("h 300-400 cache")) {
      await until(
        () => frames.queued.length > 0 || gets.includes("h 300-400 cache"),
      );
      frames.run();
    }
    // On the new range: an invalidate refetches, and a bar arrives during
    // that fetch, held on it.
    const current = holdFetch();
    await writer.invalidate(elsewhere);
    frames.run();
    await current.entered;
    await writer.put({ timestamps: [360], fields: { v: [9], n: [1] } });
    frames.run();
    const reads = () => gets.filter((get) => get === "h 300-400 cache").length;
    const before = reads();
    // That fetch fails: it writes nothing, so no event of its own follows,
    // and only the hold's release can bring the held change back, while
    // the first range's fetch still hangs.
    backend().fail = true;
    current.release();
    await until(() =>
      (view.renders.at(-1)?.misses ?? []).includes("fetch-failed"),
    );
    await until(() => frames.queued.length > 0);
    frames.run();
    await until(() => reads() === before + 1);
    expect(view.renders.at(-1)?.points).toContain(360);
    expect(view.renders.at(-1)?.misses).toContain("fetch-failed");
    stuck.release();
  });

  it("an inline config with equal content subscribes once and reads no more after its catch-up (PR3-2)", async () => {
    const post = vi.spyOn(MessagePort.prototype, "postMessage");
    const subscribes = () =>
      post.mock.calls.filter(
        ([message]) => (message as { op?: string }).op === "subscribe",
      ).length;
    const frames = stubFrames();
    const { connection, clients } = await connected();
    const view = mount(connection);
    view.show(config, range, true);
    await until(() => view.renders.at(-1)?.points.length === 1);
    await until(() => frames.queued.length > 0);
    frames.run(); // the catch-up
    await until(() => gets.includes("h 100-200 cache"));
    // Another writer's bar: its read and render come after every commit
    // and effect of the catch-up, so a re-subscription has happened by then.
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.put({ timestamps: [160], fields: { v: [8], n: [1] } });
    await until(() => frames.queued.length > 0);
    frames.run();
    await until(() => view.renders.at(-1)?.points.length === 2);
    const before = view.renders.length;
    view.show(config, range, true);
    await until(() => view.renders.length > before);
    expect(subscribes()).toBe(1);
    expect(gets).toEqual([
      "h 100-200 fetch",
      "h 100-200 cache",
      "h 100-200 cache",
    ]);
  });
});

// The model in docs/reviews/step-114.md, "React state model": one test per
// event that the tests above do not pin.
describe("React useSeries: every read of the model", () => {
  const elsewhere = { start: 300, end: 400 };
  const fetchesOf = (what: string) =>
    gets.filter((get) => get === `${what} fetch`).length;
  /** The last render shows exactly `points`, with no miss. */
  const shows = (view: { renders: Rendered[] }, ...points: number[]) => {
    const last = view.renders.at(-1);
    return last?.points.join() === points.join() && last.misses.length === 0;
  };

  it("going back to a range invalidated meanwhile fetches it again (PR4-1)", async () => {
    const { connection, clients } = await connected();
    const view = mount(connection);
    view.show(config, range);
    await until(() => shows(view, 150));
    view.show(config, elsewhere);
    await until(() => shows(view, 350));
    // A render is not yet a commit (React may delay one that follows a
    // fallback); the cache-only read of a new range's commit is.
    await until(() => gets.includes("h 300-400 cache"));
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.invalidate(range);
    const returned = gets.length;
    view.show(config, range);
    // The move back is a read of its own: it fetches what the invalidate
    // withdrew, whatever the view read there before.
    await until(() => backend().fetches.h === 3);
    await until(() => shows(view, 150));
    expect(
      gets.slice(returned).find((get) => get.startsWith("h 100-200")),
    ).toBe("h 100-200 fetch");
    expect(view.renders.slice(-1)[0]?.misses).toEqual([]);
  });

  it("going back to a range whose first visit React abandoned is a fetching read of its own", async () => {
    const { connection } = await connected();
    const view = mount(connection);
    const third = { start: 500, end: 600 };
    view.show(config, range);
    await until(() => shows(view, 150));
    // The move to 300-400 loads in a background render, and a newer range
    // overtakes it before its read answers.
    const slow = holdFetch();
    view.show(config, elsewhere);
    await slow.entered;
    view.show(config, third);
    await until(() => shows(view, 550));
    slow.release();
    await until(() => gets.includes("h 500-600 cache"));
    view.show(config, elsewhere);
    await until(() => shows(view, 350));
    expect(fetchesOf("h 300-400")).toBe(2);
  });

  it("a remount is a new view: its first read fetches", async () => {
    const { connection, clients } = await connected();
    const first = mount(connection);
    first.show(config, range);
    await until(() => shows(first, 150));
    await until(() => gets.includes("h 100-200 cache"));
    first.unmount();
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.invalidate(range);
    const again = mount(connection);
    again.show(config, range);
    await until(() => backend().fetches.h === 2);
    await until(() => shows(again, 150));
    expect(fetchesOf("h 100-200")).toBe(2);
  });

  it("a render waiting on a second read finds its first again (Suspense retries)", async () => {
    const { connection } = await connected();
    const a = { ...config, id: "a" };
    const b = { ...config, id: "b" };
    const first = holdFetch();
    const second = holdFetch();
    const view = mountPair(connection, a, b);
    await first.entered;
    first.release();
    // The first read has answered and the render tried again: the second
    // read is out, and the boundary waits on it.
    await second.entered;
    second.release();
    await until(() => view.renders.at(-1)?.points.join() === "150,150");
    expect(backend().fetches).toEqual({ a: 1, b: 1 });
    expect(gets.filter((get) => get.endsWith("fetch"))).toEqual([
      "a 100-200 fetch",
      "b 100-200 fetch",
    ]);
    expect(seen.fallbacks).toBe(1);
  });

  it("an invalidate between a read's answer and its commit fetches once it commits", async () => {
    const { connection, clients } = await connected();
    const a = { ...config, id: "a" };
    const b = { ...config, id: "b" };
    const first = holdFetch();
    const second = holdFetch();
    const view = mountPair(connection, a, b);
    await first.entered;
    first.release();
    await second.entered;
    // a's read has answered; the commit waits for b's. Another tab
    // invalidates a meanwhile.
    const writer = await (clients[0] as TscacheClient).cache(a);
    await writer.invalidate(range);
    second.release();
    await until(() => backend().fetches.a === 2);
    await until(() => {
      const last = view.renders.at(-1);
      return last?.points.join() === "150,150" && last.misses.length === 0;
    });
    expect(fetchesOf("a 100-200")).toBe(2);
    expect(backend().fetches.b).toBe(1);
  });

  it("a change while the first mount's read fetches is read after it commits, labels kept", async () => {
    const { connection, clients } = await connected();
    const view = mount(connection);
    const slow = holdFetch();
    view.show(config, range);
    await slow.entered;
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.put({ timestamps: [160], fields: { v: [8], n: [1] } });
    backend().fail = true;
    slow.release();
    await until(() =>
      (view.renders.at(-1)?.misses ?? []).includes("fetch-failed"),
    );
    await until(() => gets.includes("h 100-200 cache"));
    await until(() => view.renders.length >= 2);
    expect(gets).toEqual(["h 100-200 fetch", "h 100-200 cache"]);
    expect(view.renders.at(-1)?.points).toEqual([160]);
    expect(view.renders.at(-1)?.misses).not.toContain("uncached");
    expect(view.fallbacks()).toBe(1);
  });

  it("a first mount whose worker is lost while it loads is answered by the replacement", async () => {
    const clients: { client: TscacheClient; lose(): void }[] = [];
    const connection = connect(async () => {
      const next = await losable();
      clients.push(next);
      return next.client;
    });
    teardown.push(() => connection.dispose());
    const view = mount(connection);
    const slow = holdFetch();
    view.show(config, range);
    await slow.entered;
    clients[0]?.lose();
    await until(() => clients.length === 2);
    await until(() => shows(view, 150));
    // One fetching read per client, and the fallback of the first mount only.
    expect(fetchesOf("h 100-200")).toBe(2);
    expect(view.fallbacks()).toBe(1);
    slow.release();
  });

  it("StrictMode's doubled render and effects make one view and one fetching read", async () => {
    const { connection, clients } = await connected();
    const view = mount(connection, true);
    view.show(config, range);
    await until(() => shows(view, 150));
    await until(() => gets.includes("h 100-200 cache"));
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.put({ timestamps: [160], fields: { v: [8], n: [1] } });
    await until(() => shows(view, 150, 160));
    expect(backend().fetches).toEqual({ h: 1 });
    expect(fetchesOf("h 100-200")).toBe(1);
  });

  it("a view over a provisional tail reads its own fetch's event from the cache, never fetching in a loop (N84)", async () => {
    const frames = stubFrames();
    backend().tail = true;
    const { connection } = await connected();
    const view = mount(connection);
    view.show(config, range);
    await until(() => view.renders.at(-1)?.points.join() === "150");
    // The commit's cache-only read: a fetching read here would fetch the
    // provisional tail again, and its event would ask for the next.
    await until(() => gets.includes("h 100-200 cache"));
    await until(() => answered.includes("h 100-200 cache"));
    frames.run();
    expect(frames.queued).toHaveLength(0);
    expect(backend().fetches).toEqual({ h: 1 });
    expect(gets).toEqual(["h 100-200 fetch", "h 100-200 cache"]);
  });

  it("a change over a range the view has left reads nothing", async () => {
    const { connection, clients } = await connected();
    const view = mount(connection);
    view.show(config, range);
    await until(() => shows(view, 150));
    await until(() => gets.includes("h 100-200 cache"));
    view.show(config, elsewhere);
    await until(() => shows(view, 350));
    await until(() => gets.includes("h 300-400 cache"));
    const left = gets.length;
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.put({ timestamps: [160], fields: { v: [8], n: [1] } });
    // A later change over the range on screen: its read comes after any
    // read the first change would have caused.
    await writer.put({ timestamps: [360], fields: { v: [9], n: [1] } });
    await until(() => shows(view, 350, 360));
    expect(gets.slice(left)).toEqual(["h 300-400 cache"]);
  });

  /** The ops the page posted to its worker, counted by name. */
  function posted(): (op: string) => number {
    const post = vi.spyOn(MessagePort.prototype, "postMessage");
    teardown.push(() => post.mockRestore());
    return (op) =>
      post.mock.calls.filter(
        ([message]) => (message as { op?: string }).op === op,
      ).length;
  }

  /** Fake timers for the 30 s a view is kept; frames and React still run. */
  function fakeTimers(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    teardown.push(() => vi.useRealTimers());
  }

  it("a view no component shows stops following 30 s after it was last shown", async () => {
    fakeTimers();
    const count = posted();
    const { connection } = await connected();
    const view = mountActivity(connection);
    view.show("visible");
    await until(() => shows(view, 150));
    await until(() => answered.includes("h 100-200 cache"));
    view.unmount();
    await until(() => activity.hidden);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(count("unsubscribe")).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count("subscribe")).toBe(1);
    expect(count("unsubscribe")).toBe(1);
  });

  it("a hidden Activity reads nothing, and reads what changed when it is shown again", async () => {
    const frames = stubFrames();
    const { connection, clients } = await connected();
    const view = mountActivity(connection);
    view.show("visible");
    await until(() => shows(view, 150));
    await until(() => gets.includes("h 100-200 cache"));
    view.show("hidden");
    await until(() => activity.hidden);
    frames.run();
    const since = gets.length;
    // A change while hidden schedules no frame: the view waits to be shown.
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.put({ timestamps: [160], fields: { v: [8], n: [1] } });
    expect(frames.queued).toHaveLength(0);
    view.show("visible");
    await until(() => frames.queued.length > 0);
    frames.run();
    await until(() => shows(view, 150, 160));
    expect(gets.slice(since)).toEqual(["h 100-200 cache"]);
    expect(backend().fetches).toEqual({ h: 1 });
  });

  it("an Activity hidden for longer than a view is kept starts afresh with a fetch", async () => {
    fakeTimers();
    const count = posted();
    const { connection, clients } = await connected();
    const view = mountActivity(connection);
    view.show("visible");
    await until(() => shows(view, 150));
    await until(() => gets.includes("h 100-200 cache"));
    await until(() => answered.includes("h 100-200 cache"));
    view.show("hidden");
    await until(() => activity.hidden);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count("unsubscribe")).toBe(1);
    // Unheard, since the view no longer follows: another tab's invalidate.
    const writer = await (clients[0] as TscacheClient).cache(config);
    await writer.invalidate(range);
    view.show("visible");
    await until(() => backend().fetches.h === 2);
    await until(() => shows(view, 150));
    expect(fetchesOf("h 100-200")).toBe(2);
    expect(count("subscribe")).toBe(2);
  });
});
