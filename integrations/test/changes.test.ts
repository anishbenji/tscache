import {
  type CacheHandle,
  type ClientEvents,
  createClient,
  type Range,
  type TscacheClient,
} from "@anishbenji/tscache";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeWatch, type Frame, reaction } from "../shared/changes";
import { type Connection, connect } from "../shared/connection";
import { type Answer, series } from "../vanilla/series";
import { config, until } from "./helpers";

type Changed = ClientEvents["cacheChanged"];

const shown: Range = { start: 100, end: 200 };

function event(
  written: Range[],
  removed: Range[] = [],
  cleared = false,
): Changed {
  return { cacheId: config.id, written, removed, cleared };
}

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

const opened: { dispose(): unknown }[] = [];
/** What the series of a test reported as failed. */
const failures: unknown[] = [];
afterEach(async () => {
  // A read that failed on a live client fails the test that made it.
  expect(failures.splice(0)).toEqual([]);
  // Views first: a disposed series drops the reads its client's disposal
  // then rejects.
  for (const item of opened.splice(0).reverse()) await item.dispose();
});

describe("reaction (the read rule, N84)", () => {
  it.each([
    {
      name: "a write over the view",
      e: event([{ start: 150, end: 150 }]),
      how: "cache",
    },
    {
      name: "a write beside it",
      e: event([{ start: 300, end: 300 }]),
      how: undefined,
    },
    {
      name: "a write elsewhere with a removal over it",
      e: event([{ start: 300, end: 300 }], [{ start: 190, end: 400 }]),
      how: "cache",
    },
    {
      name: "a write and a clear",
      e: event([{ start: 0, end: 0 }], [], true),
      how: "cache",
    },
    {
      name: "a removal over the view",
      e: event([], [{ start: 200, end: 210 }]),
      how: "fetch",
    },
    {
      name: "a removal beside it",
      e: event([], [{ start: 201, end: 210 }]),
      how: undefined,
    },
    { name: "a clear", e: event([], [], true), how: "fetch" },
  ])("$name: $how", ({ e, how }) => {
    expect(reaction(e, shown, { interval: config.interval })).toBe(how);
  });
});

describe("ChangeWatch", () => {
  async function watched(catchUp = false) {
    const client = await createClient({ mode: "in-process" });
    opened.push(client);
    const cache = await client.cache(config);
    const reads: string[] = [];
    const clock = frames();
    const watch = new ChangeWatch({
      shown: () => shown,
      grid: { interval: config.interval },
      reread: (how) => reads.push(how),
      catchUp,
      frame: clock.frame,
    });
    opened.push(watch);
    watch.follow(cache);
    return { client, cache, reads, clock, watch };
  }

  const point = (t: number) => ({
    timestamps: [t],
    fields: { v: [t], n: [1] },
  });

  it("coalesces a frame's events into one read, fetching if one wrote nothing", async () => {
    const { cache, reads, clock } = await watched();
    // Each put's event arrives before the put resolves.
    await cache.put(point(150));
    await cache.put(point(160));
    expect(clock.count()).toBe(1);
    clock.run();
    expect(reads).toEqual(["cache"]);
    await cache.put(point(170));
    await cache.invalidate({ start: 100, end: 200 });
    clock.run();
    expect(reads).toEqual(["cache", "fetch"]);
    // Nothing over the view: nothing scheduled.
    await cache.put(point(500));
    expect(clock.count()).toBe(0);
  });

  it("follows one handle at a time, catches up once per subscription, and stops on dispose", async () => {
    const { client, cache, reads, clock, watch } = await watched(true);
    clock.run();
    expect(reads).toEqual(["cache"]);
    watch.follow(cache);
    expect(clock.count()).toBe(0);
    const other: CacheHandle = await client.cache(config);
    watch.follow(other);
    clock.run();
    expect(reads).toEqual(["cache", "cache"]);
    await cache.put(point(150));
    watch.dispose();
    expect(clock.count()).toBe(0);
    await cache.put(point(160));
    expect(clock.count()).toBe(0);
    expect(reads).toEqual(["cache", "cache"]);
  });
});

describe("reaction over an unaligned view (round 2, R2-1)", () => {
  // A read snaps its range outward to the grid (architecture §2.3, N1),
  // so the view shows the grid points at both edges too: a change there
  // is a change on screen.
  const edges = { interval: 100, alignmentOffset: 0 };
  const view = { start: 101, end: 199 };
  const at = (t: number) => [{ start: t, end: t }];

  it.each([100, 200])("a write at the snapped edge %i: cache", (t) => {
    expect(reaction(event(at(t)), view, edges)).toBe("cache");
  });

  it.each([100, 200])("a removal at the snapped edge %i: fetch", (t) => {
    expect(reaction(event([], at(t)), view, edges)).toBe("fetch");
  });

  it.each([0, 300])("a write beyond the snapped range, at %i: nothing", (t) => {
    expect(reaction(event(at(t)), view, edges)).toBeUndefined();
  });

  it.each([
    { t: 123, how: "cache" },
    { t: 103, how: "cache" },
    { t: 133, how: undefined },
    { t: 93, how: undefined },
  ])(
    "with an offset (interval 10, offset 3, view 104-118 reads 103-123): a write at $t gives $how",
    ({ t, how }) => {
      const grid = { interval: 10, alignmentOffset: 3 };
      expect(reaction(event(at(t)), { start: 104, end: 118 }, grid)).toBe(how);
    },
  );
});

describe("series follows the cache", () => {
  async function connected(): Promise<{
    connection: Connection;
    client: TscacheClient;
  }> {
    let client: TscacheClient | undefined;
    const connection = connect(async () => {
      client = await createClient({ mode: "in-process" });
      return client;
    });
    opened.push(connection);
    await until(() => connection.state.status === "connected");
    return { connection, client: client as TscacheClient };
  }

  it("a change over the range on screen reads it again from the cache, once per frame", async () => {
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
    expect(answers[0]?.result.timestamps).toEqual(new Float64Array([]));

    // Another writer of the same cache, as another tab would be.
    const writer = await client.cache(config);
    await writer.put({ timestamps: [150], fields: { v: [1], n: [1] } });
    await writer.put({ timestamps: [160], fields: { v: [2], n: [1] } });
    expect(clock.count()).toBe(1);
    clock.run();
    await until(() => answers.length === 2);
    expect(answers[1]?.result.timestamps).toEqual(new Float64Array([150, 160]));

    chart.dispose();
    await writer.put({ timestamps: [170], fields: { v: [3], n: [1] } });
    expect(clock.count()).toBe(0);
  });

  it("a change at the snapped edge of an unaligned view reads it again (round 2, R2-1)", async () => {
    const { connection, client } = await connected();
    const edge = { ...config, id: "edge", interval: 100 };
    const writer = await client.cache(edge);
    await writer.put(
      { timestamps: [100, 200], fields: { v: [1, 2], n: [1, 1] } },
      { range: { start: 100, end: 200 } },
    );
    const answers: Answer[] = [];
    const clock = frames();
    const chart = series(connection, {
      config: edge,
      render: (answer) => answers.push(answer),
      fail: (error) => failures.push(error),
      frame: clock.frame,
    });
    opened.push(chart);
    chart.show({ start: 101, end: 199 });
    await until(() => answers.length === 1);
    expect(Array.from(answers[0]?.result.fields.v ?? [])).toEqual([1, 2]);
    // A new value at 100: outside the raw view, inside the read.
    await writer.put({ timestamps: [100], fields: { v: [9], n: [1] } });
    expect(clock.count()).toBe(1);
    clock.run();
    await until(() => answers.length === 2);
    expect(Array.from(answers[1]?.result.fields.v ?? [])).toEqual([9, 2]);
  });
});
