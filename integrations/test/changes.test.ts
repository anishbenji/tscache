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
afterEach(async () => {
  for (const item of opened.splice(0)) await item.dispose();
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
    expect(reaction(e, shown)).toBe(how);
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
      fail: (error) => {
        throw error;
      },
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
});
