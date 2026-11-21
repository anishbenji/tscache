import { describe, expect, it, vi } from "vitest";
import { Engine, observeCaches } from "../src/engine/engine";
import { ClearOnlyPersistence } from "../src/persist/clear-only";
import { ClearPosts } from "../src/persist/clear-posts";
import { HostedPersistence } from "../src/persist/hosted";
import * as lazy from "../src/persist/lazy";
import type { ClientEvents } from "../src/types";
import { PAGE_BYTES, span } from "./m3-memory-helpers";
import { fakeTime, finish, tick } from "./persist-harness";
import { deferred, MemoryStore } from "./persist-memory-store";
import {
  all,
  batch,
  config,
  fixture,
  recordsOf,
  tracked,
} from "./persist-test-helpers";

fakeTime();

type Stop = ClientEvents["persistStopped"];
type Post = (clearId: string) => void;

const empty = { cache: undefined, pages: [] };
const debounceMs = 10;
const timeoutMs = 25;

function hosted(
  engine: Engine,
  store: MemoryStore,
  post?: Post,
  nextClearId = () => "local-clear",
) {
  const chunk = deferred<typeof lazy>();
  const load = vi.fn(() => chunk.promise);
  const stops: Stop[] = [];
  const persistence = new HostedPersistence(engine, load, async () => store, {
    debounceMs,
    timeoutMs,
    onStopped: (event) => stops.push(event),
    nextClearId,
    ...(post === undefined ? {} : { post }),
  });
  return { engine, persistence, chunk, load, stops };
}

function callClear(
  persistence: HostedPersistence | ClearOnlyPersistence,
  clearMemory?: () => void,
  fromClearId?: string,
): Promise<void> {
  return Promise.resolve(persistence.clearAll(clearMemory, fromClearId)).then(
    () => undefined,
  );
}

describe("M5 §6: superseding a lazy SharedWorker persister", () => {
  it("7: an open after an idle supersede reads nothing; a later clear still loads the chunk", async () => {
    const store = new MemoryStore();
    store.seed("persist", fixture());
    const h = hosted(new Engine(), store);
    h.engine.cache(config());

    h.persistence.supersede();
    await h.persistence.open("persist");
    expect(h.stops).toEqual([{ cacheId: "persist", reason: "superseded" }]);
    expect(h.load).not.toHaveBeenCalled();
    expect(store.log).toEqual([]);

    const clearing = callClear(h.persistence);
    expect(h.load).toHaveBeenCalledTimes(1);
    h.chunk.resolve(lazy);
    await finish(clearing);
    expect(store.log.map(({ kind }) => kind)).toEqual(["clearAll"]);
    expect(store.records("persist")).toEqual(empty);
  });

  it("7: a waiting open stops when the chunk arrives and the held ops run in order", async () => {
    const store = new MemoryStore();
    store.seed("persist", fixture());
    const h = hosted(new Engine(), store);
    h.engine.cache(config());
    h.engine.cache(config({ id: "plain", persist: false }));
    const opening = h.persistence.open("persist");
    const order: string[] = [];
    const putBefore = h.persistence.durably("persist", () => {
      order.push("put before clear");
      h.engine.put("persist", batch([8]));
    });
    const clearing = callClear(h.persistence, () => {
      order.push("clear");
      h.engine.clearAll();
    });
    const putAfter = h.persistence.durably("plain", () => {
      order.push("put after clear");
      h.engine.put("plain", batch([12]));
    });

    h.persistence.supersede();
    expect(order).toEqual([]);
    h.chunk.resolve(lazy);
    await tick();
    await Promise.all([opening, putBefore, clearing, putAfter]);

    expect(order).toEqual(["put before clear", "clear", "put after clear"]);
    expect(h.stops).toEqual([{ cacheId: "persist", reason: "superseded" }]);
    expect(store.log.map(({ kind }) => kind)).toEqual(["clearAll"]);
    expect(h.engine.coverage("persist", all)).toEqual([]);
    expect(h.engine.coverage("plain", all)).toEqual([span(12)]);
    expect(store.records("persist")).toEqual(empty);
  });

  it.each(["fails", "times out"])(
    "7: superseding after the chunk %s does not report the stopped cache again",
    async (outcome) => {
      const store = new MemoryStore();
      const h = hosted(new Engine(), store);
      h.engine.cache(config());
      h.engine.cache(config({ id: "later" }));
      const opening = h.persistence.open("persist");
      if (outcome === "fails") h.chunk.reject(new Error("chunk unavailable"));
      else await tick(timeoutMs);
      await opening;
      expect(h.stops).toEqual([
        expect.objectContaining({ cacheId: "persist", reason: "unavailable" }),
      ]);
      const [prior] = h.stops;

      h.persistence.supersede();
      await h.persistence.open("persist");
      await h.persistence.open("later");
      if (outcome === "times out") h.chunk.resolve(lazy);
      await tick();

      expect(h.stops).toEqual([
        prior,
        { cacheId: "later", reason: "superseded" },
      ]);
      expect(h.load).toHaveBeenCalledTimes(1);
      expect(store.log).toEqual([]);
    },
  );
});

describe.each([
  { mode: "shared", Hosting: HostedPersistence },
  { mode: "clear-only", Hosting: ClearOnlyPersistence },
])("M5 §6: $mode hosting posts clearAll", ({ Hosting }) => {
  const paths = [
    "disk success",
    "disk rejection",
    "disk deadline",
    "chunk rejection",
    "chunk deadline",
  ] as const;

  it.each(
    (["local", "channel"] as const).flatMap((source) =>
      paths.map((path) => ({ source, path })),
    ),
  )(
    "8: $source clear posts at the required steps on $path",
    async ({ source, path }) => {
      const engine = new Engine();
      const store = new MemoryStore();
      const stored = fixture({}, [0]);
      store.seed("persist", stored);
      engine.cache(config());
      engine.put("persist", batch([4]));
      const chunk = deferred<typeof lazy>();
      const order: string[] = [];
      const statesAtPost: {
        records: ReturnType<MemoryStore["records"]>;
        transactionSettled: boolean | undefined;
      }[] = [];
      // A recipient can stay pending even after the sending call answers.
      const recipient = deferred<void>();
      const post = vi.fn((clearId: string) => {
        order.push(clearId);
        statesAtPost.push({
          records: store.records("persist"),
          transactionSettled: store.log.at(-1)?.settled,
        });
        return recipient.promise;
      });
      const nextClearId = vi.fn(() => "local-clear");
      const persistence = new Hosting(
        engine,
        () => chunk.promise,
        async () => store,
        {
          debounceMs,
          timeoutMs,
          nextClearId,
          post,
        },
      );
      const clearMemory = vi.fn(() => {
        order.push("memory");
        engine.clearAll();
      });
      const local = source === "local";
      const id = local ? "local-clear" : "remote-clear";
      const clearing = tracked(
        callClear(persistence, clearMemory, local ? undefined : id),
      );

      // No await between the call and this check. Memory was cleared before
      // the local post, and a receiver has no start post.
      expect(order).toEqual(local ? ["memory", id] : ["memory"]);
      expect(engine.coverage("persist", all)).toEqual([]);
      expect(clearing.done).toBe(false);

      if (path === "chunk rejection")
        chunk.reject(new Error("chunk unavailable"));
      else if (path === "chunk deadline") await tick(timeoutMs);
      else {
        const gate = store.gate("clearAll");
        chunk.resolve(lazy);
        await tick();
        await gate.entered;
        expect(post).toHaveBeenCalledTimes(local ? 1 : 0);
        expect(clearing.done).toBe(false);
        if (path === "disk success") gate.release();
        else if (path === "disk deadline") await tick(timeoutMs);
        else {
          store.fail("clearAll", Infinity);
          gate.reject(new Error("clear rejected"));
          await tick(timeoutMs);
        }
        await clearing.promise;
        if (path === "disk deadline") {
          gate.reject(new Error("late rejection"));
          await tick();
        }
      }
      await clearing.promise;
      if (path === "chunk deadline") {
        chunk.resolve(lazy);
        await tick();
      }

      expect(clearMemory).toHaveBeenCalledTimes(1);
      expect(nextClearId).toHaveBeenCalledTimes(local ? 1 : 0);
      expect(order).toEqual(local ? ["memory", id, id] : ["memory", id]);
      const after = path === "disk success" ? empty : stored;
      expect(statesAtPost.map(({ records }) => records)).toEqual(
        local ? [stored, after] : [after],
      );
      if (path.startsWith("disk")) {
        expect(statesAtPost.at(-1)?.transactionSettled).toBe(
          path !== "disk deadline",
        );
      }
      expect(store.records("persist")).toEqual(after);
      if (path.startsWith("chunk")) expect(store.log).toEqual([]);
    },
  );

  it.each(["received", "originated"])(
    "8: a clear id this worker already %s clears again without a new post",
    async (history) => {
      const engine = new Engine();
      const store = new MemoryStore();
      const post = vi.fn<Post>();
      const persistence = new Hosting(
        engine,
        async () => lazy,
        async () => ({
          read: store.read.bind(store),
          write: store.write.bind(store),
          clearAll: store.clearAll.bind(store),
          close() {},
        }),
        { nextClearId: () => "logout", post },
      );
      engine.cache(config());

      store.seed("persist", fixture({}, [0]));
      engine.put("persist", batch([0]));
      const local = history === "originated";
      await finish(
        callClear(persistence, undefined, local ? undefined : "logout"),
      );
      expect(engine.get("persist", all).timestamps).toHaveLength(0);
      expect(store.records("persist")).toEqual(empty);
      expect(post.mock.calls).toEqual(
        local ? [["logout"], ["logout"]] : [["logout"]],
      );

      store.seed("persist", fixture({}, [4]));
      engine.put("persist", batch([4]));
      await finish(callClear(persistence, undefined, "logout"));
      expect(engine.get("persist", all).timestamps).toHaveLength(0);
      expect(store.records("persist")).toEqual(empty);
      expect(store.log.map(({ kind }) => kind)).toEqual([
        "clearAll",
        "clearAll",
      ]);
      expect(post.mock.calls).toEqual(
        local ? [["logout"], ["logout"]] : [["logout"]],
      );
    },
  );

  it("8: clearing without a post still clears memory and disk", async () => {
    const engine = new Engine();
    const store = new MemoryStore();
    store.seed("persist", fixture());
    engine.cache(config());
    engine.put("persist", batch([4]));
    const persistence = new Hosting(
      engine,
      async () => lazy,
      async () => store,
    );
    const clearMemory = vi.fn(() => engine.clearAll());
    await finish(callClear(persistence, clearMemory));

    expect(clearMemory).toHaveBeenCalledTimes(1);
    expect(engine.coverage("persist", all)).toEqual([]);
    expect(store.log.map(({ kind }) => kind)).toEqual(["clearAll"]);
    expect(store.records("persist")).toEqual(empty);
  });
});

it("8: a clear held behind the SharedWorker chunk posts only when it runs", async () => {
  const order: string[] = [];
  const h = hosted(new Engine(), new MemoryStore(), (id) => {
    order.push(id);
  });
  h.engine.cache(config());
  const opening = h.persistence.open("persist");
  const held = h.persistence.durably("persist", () => {
    order.push("held put");
    h.engine.put("persist", batch([0]));
  });
  const clearMemory = vi.fn(() => {
    order.push("memory");
    h.engine.clearAll();
  });
  const clearing = callClear(h.persistence, clearMemory);
  expect(order).toEqual([]);
  expect(clearMemory).not.toHaveBeenCalled();

  h.chunk.resolve(lazy);
  await tick();
  await Promise.all([opening, held, clearing]);

  expect(clearMemory).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["held put", "memory", "local-clear", "local-clear"]);
  expect(h.engine.coverage("persist", all)).toEqual([]);
});

it("8: duplicate channel deliveries during one disk clear relay only once", async () => {
  const store = new MemoryStore();
  const post = vi.fn<Post>();
  const h = hosted(new Engine(), store, post);
  h.engine.cache(config());
  h.chunk.resolve(lazy);
  const gate = store.gate("clearAll");
  const memoryClear = vi.fn(() => h.engine.clearAll());
  const first = callClear(h.persistence, memoryClear, "remote-clear");
  await tick();
  await gate.entered;
  h.engine.put("persist", batch([4]));
  const second = callClear(h.persistence, memoryClear, "remote-clear");
  expect(memoryClear).toHaveBeenCalledTimes(2);
  expect(h.engine.get("persist", all).timestamps).toHaveLength(0);
  gate.release();
  await Promise.all([first, second]);

  expect(store.log.map(({ kind }) => kind)).toEqual(["clearAll"]);
  expect(post.mock.calls).toEqual([["remote-clear"]]);
});

describe("N135: clear relay across queued workers", () => {
  function queuedClearChannel() {
    const workers: { inbox: string[]; clears: ClearPosts }[] = [];

    function post(clearId: string, sender?: string[]) {
      for (const { inbox } of workers) {
        if (inbox !== sender) inbox.push(clearId);
      }
    }

    return {
      post,
      join(name: string) {
        const inbox: string[] = [];
        const sent: string[] = [];
        let nextId = 0;
        const clears = new ClearPosts({
          nextClearId: () => `${name}-${nextId++}`,
          post(clearId) {
            sent.push(clearId);
            post(clearId, inbox);
          },
        });
        workers.push({ inbox, clears });
        return { clears, sent };
      },
      drain() {
        // A 200-id burst to three workers needs 1,800 deliveries if each
        // worker relays each id once.
        const deliveryCap = 2_000;
        let delivered = 0;
        while (delivered < deliveryCap) {
          const before = delivered;
          for (const { inbox, clears } of workers) {
            const clearId = inbox.shift();
            if (clearId === undefined) continue;
            clears.begin(clearId)();
            delivered++;
            if (delivered === deliveryCap) break;
          }
          if (delivered === before) break;
        }

        const pending = workers.reduce(
          (total, { inbox }) => total + inbox.length,
          0,
        );
        expect(
          pending,
          `queued clear messages after ${delivered} deliveries`,
        ).toBe(0);
      },
    };
  }

  function clearIds(name: string, count: number): string[] {
    return Array.from({ length: count }, (_, index) => `${name}-${index}`);
  }

  it.each([65, 200])(
    "two workers each relay a burst of %i foreign clear ids once",
    (count) => {
      const bus = queuedClearChannel();
      const first = bus.join("first");
      const second = bus.join("second");
      const ids = clearIds("poster", count);
      for (const id of ids) bus.post(id);

      bus.drain();

      expect(first.sent).toEqual(ids);
      expect(second.sent).toEqual(ids);
    },
  );

  it("two workers drain a burst of 65 unsettled clears from one worker", () => {
    const bus = queuedClearChannel();
    const origin = bus.join("origin");
    const receiver = bus.join("receiver");
    const ids = clearIds("origin", 65);
    const settles = ids.map(() => origin.clears.begin());

    bus.drain();
    expect(origin.sent).toEqual(ids);
    expect(receiver.sent).toEqual(ids);

    for (const settle of settles) settle();
    bus.drain();
    expect(origin.sent).toEqual([...ids, ...ids]);
    expect(receiver.sent).toEqual(ids);
  });

  it("three workers drain a burst of 200 foreign clear ids", () => {
    const bus = queuedClearChannel();
    const workers = ["first", "second", "third"].map((name) => bus.join(name));
    const ids = clearIds("poster", 200);
    for (const id of ids) bus.post(id);

    bus.drain();

    for (const worker of workers) expect(worker.sent).toEqual(ids);
  });

  it("two workers drain 200 sequential clears one at a time", () => {
    const bus = queuedClearChannel();
    const first = bus.join("first");
    const second = bus.join("second");
    const ids = clearIds("poster", 200);

    for (const id of ids) {
      bus.post(id);
      bus.drain();
    }

    expect(first.sent).toEqual(ids);
    expect(second.sent).toEqual(ids);
  });
});

/** FIFO delivery to the subscribers present at post, excluding the sender.
 * The test drives delivery independently of the persisters' timers. */
function channel() {
  const inboxes = new Map<string, string[]>();
  const posts: { from: string; clearId: string }[] = [];
  return {
    posts,
    join(from: string, store: MemoryStore, engine = new Engine()) {
      const inbox: string[] = [];
      inboxes.set(from, inbox);
      const worker = hosted(
        engine,
        store,
        (clearId) => {
          posts.push({ from, clearId });
          for (const [recipient, pending] of inboxes) {
            if (recipient !== from) pending.push(clearId);
          }
        },
        () => `${from}-logout`,
      );
      return {
        ...worker,
        inbox,
        async deliver() {
          const clearId = inbox.shift();
          if (clearId === undefined)
            throw new Error(`no clear posted to ${from}`);
          await finish(callClear(worker.persistence, undefined, clearId));
        },
      };
    },
  };
}

it("9: a worker that joins during the clear gets the settle post", async () => {
  const store = new MemoryStore();
  store.seed("persist", fixture({}, [0, 4]));
  const bus = channel();
  const sender = bus.join("S", store);
  const clearing = callClear(sender.persistence);
  expect(bus.posts).toEqual([{ from: "S", clearId: "S-logout" }]);

  const late = bus.join("N", store);
  late.chunk.resolve(lazy);
  late.engine.cache(config());
  await late.persistence.open("persist");
  expect(late.engine.get("persist", all).timestamps).toEqual(
    new Float64Array([0, 4]),
  );
  expect(late.inbox).toEqual([]);

  sender.chunk.resolve(lazy);
  await finish(clearing);
  expect(late.inbox).toEqual(["S-logout"]);
  expect(store.records("persist")).toEqual(empty);
  await late.deliver();
  expect(late.engine.get("persist", all).timestamps).toHaveLength(0);
  expect(late.engine.coverage("persist", all)).toEqual([]);
  expect(store.records("persist")).toEqual(empty);
});

it.each([
  { number: 10, memoryBudget: undefined, loaded: [0, 4, 8] },
  { number: 28, memoryBudget: PAGE_BYTES, loaded: [8] },
])(
  "$number: the lagging writer relays to a worker that loaded its late flush",
  async ({ memoryBudget, loaded }) => {
    const store = new MemoryStore();
    const bus = channel();
    const sender = bus.join("S", store);
    const lagging = bus.join("R", store);
    sender.chunk.resolve(lazy);
    lagging.chunk.resolve(lazy);
    lagging.engine.cache(config());
    await lagging.persistence.open("persist");
    lagging.engine.put("persist", batch([0, 4, 8]), { range: span(0, 8) });

    await finish(callClear(sender.persistence));
    expect(bus.posts).toEqual([
      { from: "S", clearId: "S-logout" },
      { from: "S", clearId: "S-logout" },
    ]);
    expect(lagging.inbox).toEqual(["S-logout", "S-logout"]);
    expect(store.records("persist")).toEqual(empty);

    // R has heard neither post and flushes data from before the logout.
    await tick(debounceMs);
    expect(store.records("persist")).toEqual(recordsOf(lagging.engine));

    const late = bus.join(
      "N",
      store,
      new Engine(memoryBudget === undefined ? {} : { memoryBudget }),
    );
    late.chunk.resolve(lazy);
    late.engine.cache(config());
    const reports = vi.fn();
    observeCaches(late.engine, {
      onChange: () => {},
      onMutate: () => {},
      hasReaders: () => true,
      onReaderChange: reports,
    });
    await late.persistence.open("persist");
    expect(late.inbox).toEqual([]);
    expect([...late.engine.get("persist", all).timestamps]).toEqual(loaded);
    expect(late.engine.coverage("persist", all)).toEqual(
      memoryBudget === undefined ? [span(0, 8)] : [span(8)],
    );
    if (memoryBudget !== undefined) {
      expect(late.engine.memoryStats()).toMatchObject({
        budget: memoryBudget,
        bytes: PAGE_BYTES,
        evictedPages: 2,
      });
    }

    await lagging.deliver();
    await lagging.deliver();
    expect(late.inbox).toEqual(["S-logout"]);
    expect(bus.posts.at(-1)).toEqual({ from: "R", clearId: "S-logout" });
    await late.deliver();

    expect(lagging.engine.get("persist", all).timestamps).toHaveLength(0);
    expect(late.engine.get("persist", all).timestamps).toHaveLength(0);
    expect(late.engine.coverage("persist", all)).toEqual([]);
    expect(store.records("persist")).toEqual(empty);
    if (memoryBudget !== undefined) {
      expect(late.engine.memoryStats()).toMatchObject({
        budget: memoryBudget,
        bytes: 0,
        evictedPages: 2,
      });
      reports.mockClear();
      late.engine.invalidate("persist", span(0, 4));
      expect(reports).not.toHaveBeenCalled();
      await tick(debounceMs);
      expect(store.records("persist")).toEqual(empty);
    }
  },
);
