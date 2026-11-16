import {
  createClient,
  type GetResult,
  type Range,
  type TscacheClient,
} from "@anishbenji/tscache";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChangeWatch,
  cacheOnlyAfter,
  type Frame,
  keepFailures,
  ViewReads,
} from "../shared/changes";
import { type Connection, connect } from "../shared/connection";
import { type Answer, series } from "../vanilla/series";
import { config, until } from "./helpers";

// How a view's own reads and its change re-reads meet (step 114
// pre-review PR-1, PR-3 and PR-6): a cache-only re-read never replaces a
// fetching read still in flight, a repeated read posts no subscription
// churn, and a read the view starts itself takes the place of the frame's.

const shown: Range = { start: 100, end: 200 };

/** A frame scheduler the test runs by hand. */
function frames(): { frame: Frame; run(): void; count(): number } {
  const queued: (() => void)[] = [];
  return {
    frame: (callback) => {
      queued.push(callback);
      return () => {
        const at = queued.indexOf(callback);
        if (at !== -1) queued.splice(at, 1);
      };
    },
    run: () => {
      for (const callback of queued.splice(0)) callback();
    },
    count: () => queued.length,
  };
}

/** Fetcher control, read per call by the module below. */
interface Gate {
  /** When set, the next fetch waits for it. */
  hold?: Promise<void>;
  entered?: () => void;
  /** Whether fetches reject. */
  fail: boolean;
  /** Whether fetches are refused for credentials. */
  auth?: boolean;
}
const gate = (): Gate => (globalThis as unknown as { __m7view: Gate }).__m7view;
function resetGate(): void {
  (globalThis as unknown as { __m7view: Gate }).__m7view = { fail: false };
}
resetGate();

const fetcher = `data:text/javascript,${encodeURIComponent(`
  export default {
    async fetch({ range }) {
      const g = globalThis.__m7view;
      if (g.hold !== undefined) {
        const hold = g.hold;
        g.hold = undefined;
        g.entered?.();
        await hold;
      }
      if (g.fail) throw new Error("backend down");
      if (g.auth) {
        const e = new Error("401");
        e.code = "tscache:auth-invalid";
        throw e;
      }
      return { timestamps: [], fields: { v: [], n: [] } };
    },
  };
`)}`;

/** Holds the next fetch; resolves `entered` once it waits. */
function holdNextFetch(): { entered: Promise<void>; release(): void } {
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    gate().entered = resolve;
  });
  gate().hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, release };
}

const opened: { dispose(): unknown }[] = [];
/** What the series of a test reported as failed. */
const failures: unknown[] = [];
afterEach(async () => {
  // A read that failed on a live client fails the test that made it.
  expect(failures.splice(0)).toEqual([]);
  // Views first: a disposed series drops the reads its client's disposal
  // then rejects.
  for (const item of opened.splice(0).reverse()) await item.dispose();
  vi.restoreAllMocks();
  resetGate();
});

async function connected(withFetcher = false): Promise<{
  connection: Connection;
  client: TscacheClient;
}> {
  let client: TscacheClient | undefined;
  const connection = connect(async () => {
    client = await createClient({
      mode: "in-process",
      ...(withFetcher ? { fetcher: { module: fetcher } } : {}),
    });
    return client;
  });
  opened.push(connection);
  await until(() => connection.state.status === "connected");
  return { connection, client: client as TscacheClient };
}

describe("ViewReads (PR-1, PR2-1)", () => {
  /**
   * A view on ViewReads with only the glue an adapter adds: reading again
   * when asked, and latest-wins over the answers.
   */
  function view(
    client: TscacheClient,
    frame: Frame,
    { fresh = false }: { fresh?: boolean } = {},
  ) {
    const answers: GetResult[] = [];
    let latest = 0;
    const reads: boolean[] = [];
    let range: Range | undefined = shown;
    let owner: unknown = "client";
    const views = new ViewReads({
      shown: () => range,
      interval: config.interval,
      reread: () => read(),
      frame,
    });
    opened.push(views);
    function read(): void {
      // As Angular: a view that shows nothing reads nothing.
      if (range === undefined) return;
      const request = ++latest;
      // `fresh`: a new object with the same endpoints for every read, as a
      // derived accessor gives.
      const asked = fresh ? { ...range } : range;
      const started = views.read(client.cache(config), asked, owner);
      reads.push(started.cacheOnly);
      started.answer.then(
        (result) => {
          if (request === latest) answers.push(result);
        },
        // As an adapter: a dropped read's failure is not the view's.
        (error: unknown) => {
          if (request === latest) failures.push(error);
        },
      );
    }
    return {
      read,
      answers,
      reads,
      /** Moves the view to `next`. */
      move(next: Range) {
        range = next;
      },
      /** Shows nothing, as an Angular view whose range is undefined. */
      idle() {
        range = undefined;
      },
      /** Gives the view a new owner, as a replaced client does. */
      own(next: unknown) {
        owner = next;
      },
    };
  }

  it("a fresh range object with the same endpoints is the same view (round 1, P0)", async () => {
    const { client } = await connected(true);
    const clock = frames();
    const v = view(client, clock.frame, { fresh: true });
    v.read();
    await until(() => v.answers.length === 1);
    const writer = await client.cache(config);
    await writer.put({ timestamps: [150], fields: { v: [1], n: [1] } });
    clock.run();
    await until(() => v.answers.length === 2);
    expect(v.reads).toEqual([false, true]);
  });

  it("a change whose frame comes while the view shows nothing is forgotten (round 3, P1)", async () => {
    const { client } = await connected(true);
    const clock = frames();
    const v = view(client, clock.frame);
    v.read();
    await until(() => v.answers.length === 1);
    const writer = await client.cache(config);
    await writer.put({ timestamps: [150], fields: { v: [1], n: [1] } });
    await until(() => clock.count() === 1);
    v.idle();
    clock.run();
    // Not seen: the view shows nothing.
    await writer.invalidate(shown);
    v.move(shown);
    v.read();
    await until(() => v.answers.length === 2);
    expect(v.reads).toEqual([false, false]);
  });

  it("a new owner at the same range fetches (a replaced client)", async () => {
    const { client } = await connected(true);
    const clock = frames();
    const v = view(client, clock.frame);
    v.read();
    await until(() => v.answers.length === 1);
    const writer = await client.cache(config);
    await writer.put({ timestamps: [150], fields: { v: [1], n: [1] } });
    v.own("another client");
    clock.run();
    await until(() => v.answers.length === 2);
    expect(v.reads).toEqual([false, false]);
  });

  it("a fetch that latest-wins dropped holds no change (round 1, P1)", async () => {
    const { client } = await connected(true);
    const clock = frames();
    const v = view(client, clock.frame);
    const writer = await client.cache(config);
    const elsewhere = { start: 300, end: 400 };
    // The second view's range is covered: its read needs no fetch.
    await writer.put(
      { timestamps: [300], fields: { v: [1], n: [1] } },
      { range: elsewhere },
    );
    const held = holdNextFetch();
    v.read(); // the first range: its fetch stays held
    await held.entered;
    v.move(elsewhere);
    v.read();
    await until(() => v.answers.length === 1);
    await writer.put({ timestamps: [310], fields: { v: [2], n: [1] } });
    expect(clock.count()).toBe(1);
    clock.run();
    // Read again at once, while the dropped fetch is still held.
    await until(() => v.answers.length === 2);
    expect(v.reads).toEqual([false, false, true]);
    expect(Array.from(v.answers[1]?.timestamps ?? [])).toEqual([300, 310]);
    held.release();
  });

  it.each([
    {
      name: "fails",
      set: (g: Gate) => (g.fail = true),
      reason: "fetch-failed",
    },
    {
      name: "meets invalid credentials",
      set: (g: Gate) => (g.auth = true),
      reason: "auth-pending",
    },
  ])(
    "a frame while the fetch is held, then the fetch $name: the view ends on $reason",
    async ({ set, reason }) => {
      const { client } = await connected(true);
      const clock = frames();
      const v = view(client, clock.frame);
      const held = holdNextFetch();
      v.read();
      await held.entered;
      // Another writer's put reaches the view while its fetch is held.
      const writer = await client.cache(config);
      await writer.put({ timestamps: [150], fields: { v: [1], n: [1] } });
      expect(clock.count()).toBe(1);
      clock.run(); // the frame fires while the fetch is held
      expect(v.reads).toEqual([false]);
      set(gate());
      held.release();
      await until(() => v.answers.length === 1);
      // The held change comes back through the frame, after the answer.
      expect(clock.count()).toBe(1);
      clock.run();
      await until(() => v.answers.length === 2);
      expect(v.reads).toEqual([false, true]);
      const last = v.answers.at(-1) as GetResult;
      expect(Array.from(last.timestamps)).toEqual([150]);
      expect(last.misses.map((m) => m.reason)).toEqual([reason, reason]);
    },
  );

  it("a held change reads the cache once the fetch answered", async () => {
    const { client } = await connected(true);
    const clock = frames();
    const v = view(client, clock.frame);
    const held = holdNextFetch();
    v.read();
    await held.entered;
    const writer = await client.cache(config);
    await writer.put({ timestamps: [150], fields: { v: [1], n: [1] } });
    clock.run();
    held.release();
    await until(() => v.answers.length === 1);
    clock.run();
    await until(() => v.answers.length === 2);
    expect(v.reads).toEqual([false, true]);
    expect(v.answers[1]?.misses).toEqual([]);
  });

  it("a cache-only read starts only once the answer before it settled", async () => {
    let settle: (r: GetResult) => void = () => {};
    const base = new Promise<GetResult>((resolve) => {
      settle = resolve;
    });
    const started: string[] = [];
    const after = cacheOnlyAfter(
      base,
      async () => {
        started.push("read");
        return {
          timestamps: new Float64Array(),
          fields: {},
          coverage: [],
          misses: [{ range: shown, reason: "uncached" }],
        };
      },
      10,
    );
    await Promise.resolve();
    expect(started).toEqual([]);
    settle({
      timestamps: new Float64Array(),
      fields: {},
      coverage: [],
      misses: [{ range: shown, reason: "fetch-failed" }],
    });
    expect((await after).misses.map((m) => m.reason)).toEqual(["fetch-failed"]);
    expect(started).toEqual(["read"]);
  });
});

describe("keepFailures (PR-1)", () => {
  const empty = { timestamps: new Float64Array(), fields: {}, coverage: [] };
  const error = { name: "Error", message: "backend down" };

  it("keeps a failure label where the slot is still missing, and only there", () => {
    const previous: GetResult = {
      ...empty,
      misses: [
        { range: { start: 100, end: 200 }, reason: "fetch-failed", error },
      ],
    };
    const next: GetResult = {
      ...empty,
      misses: [
        { range: { start: 50, end: 140 }, reason: "uncached" },
        { range: { start: 160, end: 250 }, reason: "uncached" },
      ],
    };
    expect(keepFailures(previous, next, 10).misses).toEqual([
      { range: { start: 50, end: 90 }, reason: "uncached" },
      { range: { start: 100, end: 140 }, reason: "fetch-failed", error },
      { range: { start: 160, end: 200 }, reason: "fetch-failed", error },
      { range: { start: 210, end: 250 }, reason: "uncached" },
    ]);
  });

  it("returns the answer as it is when the previous one labelled nothing", () => {
    const next: GetResult = {
      ...empty,
      misses: [{ range: shown, reason: "uncached" }],
    };
    expect(keepFailures(undefined, next, 10)).toBe(next);
    expect(keepFailures(next, next, 10)).toBe(next);
  });
});

describe("ChangeWatch.started (PR-6)", () => {
  it("drops the frame's cache-only read, and a fetching one only for a fetching read", async () => {
    const client = await createClient({ mode: "in-process" });
    opened.push(client);
    const cache = await client.cache(config);
    const reads: string[] = [];
    const clock = frames();
    const watch = new ChangeWatch({
      shown: () => shown,
      grid: { interval: config.interval },
      reread: (how) => reads.push(how),
      frame: clock.frame,
    });
    opened.push(watch);
    watch.follow(cache);
    const point = (t: number) => ({
      timestamps: [t],
      fields: { v: [t], n: [1] },
    });
    await cache.put(point(150));
    watch.started(false);
    clock.run();
    expect(reads).toEqual([]);
    await cache.invalidate(shown);
    watch.started(false);
    clock.run();
    expect(reads).toEqual(["fetch"]);
    await cache.invalidate(shown);
    await cache.put(point(150));
    await cache.invalidate(shown);
    watch.started(true);
    clock.run();
    expect(reads).toEqual(["fetch"]);
  });
});

describe("vanilla series and its own reads", () => {
  /** Every subscribe and unsubscribe the page posts to its in-process worker. */
  function subscriptionOps(): () => string[] {
    const post = vi.spyOn(MessagePort.prototype, "postMessage");
    return () =>
      post.mock.calls.flatMap(([message]) => {
        const op = (message as { t?: string; op?: string }).op;
        return (message as { t?: string }).t === "req" &&
          (op === "subscribe" || op === "unsubscribe")
          ? [op]
          : [];
      });
  }

  it("a repeated refresh() posts no unsubscribe or subscribe (PR-3)", async () => {
    const ops = subscriptionOps();
    const { connection } = await connected();
    const answers: Answer[] = [];
    const chart = series(connection, {
      config,
      render: (answer) => answers.push(answer),
      fail: (error) => failures.push(error),
      frame: () => () => {},
    });
    opened.push(chart);
    chart.show(shown);
    await until(() => answers.length === 1);
    for (let i = 0; i < 3; i++) {
      chart.refresh();
      await until(() => answers.length === i + 2);
    }
    expect(ops()).toEqual(["subscribe"]);
  });

  it("a refresh after a change takes the place of the frame's re-read (PR-6)", async () => {
    const { connection, client } = await connected();
    const answers: Answer[] = [];
    const clock = frames();
    const chart = series(connection, {
      config,
      render: (answer) => answers.push(answer),
      fail: (error) => failures.push(error),
      frame: clock.frame,
    });
    opened.push(chart);
    chart.show(shown);
    await until(() => answers.length === 1);
    const writer = await client.cache(config);
    await writer.put({ timestamps: [150], fields: { v: [1], n: [1] } });
    expect(clock.count()).toBe(1);
    chart.refresh();
    await until(() => answers.length === 2);
    expect(Array.from(answers[1]?.result.timestamps ?? [])).toEqual([150]);
    expect(clock.count()).toBe(0);
  });

  it("an overtaken show() fetch holds no change in the range now shown (round 1, P1)", async () => {
    const { connection, client } = await connected(true);
    const answers: Answer[] = [];
    const clock = frames();
    const chart = series(connection, {
      config,
      render: (answer) => answers.push(answer),
      fail: (error) => failures.push(error),
      frame: clock.frame,
    });
    opened.push(chart);
    const writer = await client.cache(config);
    const elsewhere = { start: 300, end: 400 };
    await writer.put(
      { timestamps: [300], fields: { v: [1], n: [1] } },
      { range: elsewhere },
    );
    const held = holdNextFetch();
    chart.show(shown);
    await held.entered;
    chart.show(elsewhere);
    await until(() => answers.length === 1);
    await writer.put({ timestamps: [310], fields: { v: [2], n: [1] } });
    expect(clock.count()).toBe(1);
    clock.run();
    // The range on screen reads again while the first fetch is still held.
    await until(() => answers.length === 2);
    expect(Array.from(answers[1]?.result.timestamps ?? [])).toEqual([300, 310]);
    held.release();
  });

  it("a change while show() fetches keeps the fetch's failure on screen (PR-1)", async () => {
    const { connection, client } = await connected(true);
    const answers: Answer[] = [];
    const clock = frames();
    const chart = series(connection, {
      config,
      render: (answer) => answers.push(answer),
      fail: (error) => failures.push(error),
      frame: clock.frame,
    });
    opened.push(chart);
    const held = holdNextFetch();
    chart.show(shown);
    await held.entered;
    const writer = await client.cache(config);
    await writer.put({ timestamps: [150], fields: { v: [1], n: [1] } });
    clock.run();
    gate().fail = true;
    held.release();
    await until(() => answers.length > 0);
    // The show's answer may be followed only by reads its failure allows.
    await writer.get(shown, { cacheOnly: true });
    clock.run();
    const last = answers.at(-1)?.result as GetResult;
    expect(last.misses.map((miss) => miss.reason)).toContain("fetch-failed");
  });
});
