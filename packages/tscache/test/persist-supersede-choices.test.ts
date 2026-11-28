// The choices step 135 made where the M5 proposal says nothing
// (docs/reviews/step-135.md, "Choices made without a decision row"): a
// cleanup pending at supersede(), how long clear ids are kept, and a post
// that throws. The contract tests are persister-supersede.test.ts and
// persist-deploy-skew.test.ts.

import { describe, expect, it, vi } from "vitest";
import { ClearPosts } from "../src/persist/clear-posts";
import { fakeTime, harness, tick, writes } from "./persist-harness";
import { batch, config, fixture, tracked } from "./persist-test-helpers";

fakeTime();

describe("a cleanup pending when the worker is superseded", () => {
  it("drops a queued cleanup: the stopped cache's records stay", async () => {
    const h = harness({ debounceMs: 10, timeoutMs: 25 });
    const other = fixture({ id: "other" });
    h.store.seed("other", other);
    h.engine.cache(config());
    h.engine.cache(config({ id: "other" }));
    await h.persister.open("persist");
    await h.persister.open("other");

    // User decision 95 B: load stops defer cleanup, so use a flush deadline.
    const stalled = h.store.gate("write");
    h.engine.put("other", batch([8]));
    const expiring = h.persister.flush("other");
    await tick();
    await stalled.entered;
    await tick(10);
    // This removal is due before the cleanup that the deadline will queue.
    const write = h.store.gate("write");
    h.engine.put("persist", batch([0, 4]));
    h.engine.invalidate("persist", { start: 0, end: 0 });
    const flushing = h.persister.flush("persist");
    await tick(15);
    await expiring;
    await write.entered;
    expect(h.stopped).toEqual([{ cacheId: "other", reason: "unavailable" }]);
    const waiting = tracked(h.persister.durable("other"));
    await Promise.resolve();
    expect(waiting.done).toBe(false);

    h.persister.supersede();
    await waiting.promise;
    await flushing;
    stalled.reject(new Error("late write rejection"));
    write.release();
    await tick(10_000);

    expect(h.stopped).toEqual([
      { cacheId: "other", reason: "unavailable" },
      { cacheId: "persist", reason: "superseded" },
    ]);
    // Since the stalled write, only the flush abandoned at supersede() ran.
    expect(writes(h.store).map(({ cacheId }) => cacheId)).toEqual([
      "other",
      "persist",
    ]);
    expect(h.store.records("other")).toEqual(other);
  });

  it("abandons a running cleanup and releases its waiters at once", async () => {
    const h = harness({ debounceMs: 10, timeoutMs: 25 });
    h.engine.cache(config());
    await h.persister.open("persist");
    h.store.fail("write", 1, "QuotaExceededError");
    const flush = h.store.gate("write");
    const cleanup = h.store.gate("write");
    h.engine.put("persist", batch([0]));
    const flushing = h.persister.flush();
    await tick();
    await flush.entered;
    flush.release();
    await flushing;
    await cleanup.entered;
    expect(h.stopped).toMatchObject([
      { cacheId: "persist", reason: "quota-exceeded" },
    ]);
    const waiting = tracked(h.persister.durable("persist"));
    await Promise.resolve();
    expect(waiting.done).toBe(false);

    h.persister.supersede();
    await waiting.promise;
    expect(writes(h.store).at(-1)?.settled).toBe(false);
    cleanup.release();
    await tick(10_000);

    // Reported once, with its first reason; nothing follows the cleanup.
    expect(h.stopped).toHaveLength(1);
    expect(writes(h.store)).toHaveLength(2);
  });

  /** A cache stopped for its quota, whose cleanup write is held. */
  async function cleaning() {
    const h = harness({ debounceMs: 10, timeoutMs: 25 });
    h.store.seed("unopened", fixture({ id: "unopened" }));
    h.engine.cache(config());
    await h.persister.open("persist");
    h.store.fail("write", 1, "QuotaExceededError");
    const flush = h.store.gate("write");
    const cleanup = h.store.gate("write");
    h.engine.put("persist", batch([0]));
    const flushing = h.persister.flush();
    await tick();
    await flush.entered;
    flush.release();
    await flushing;
    await cleanup.entered;
    return { h, cleanup };
  }

  it("starts a clearAll queued behind the abandoned cleanup at once", async () => {
    const { h, cleanup } = await cleaning();
    const clear = h.store.gate("clearAll");
    h.engine.clearAll();
    const clearing = tracked(h.persister.clearAll());
    await tick();
    // The writer runs one job at a time: the clear waits for the cleanup.
    expect(h.store.log.at(-1)?.kind).toBe("write");

    h.persister.supersede();
    // No time passes: the clear starts in the step that dropped the cleanup,
    // not at the cleanup's deadline.
    await tick();
    await clear.entered;
    expect(h.store.log.at(-1)?.kind).toBe("clearAll");
    expect(clearing.done).toBe(false);
    // The store commits in order, as IndexedDB does: the abandoned
    // cleanup's transaction first, then the clear.
    cleanup.release();
    clear.release();
    await clearing.promise;
    expect(h.store.records("unopened")).toEqual({
      cache: undefined,
      pages: [],
    });
    await tick(10_000);
    expect(h.stopped).toHaveLength(1);
    expect(h.store.log.map(({ kind }) => kind).slice(-2)).toEqual([
      "write",
      "clearAll",
    ]);
  });

  it("lets a close() that waits for the abandoned cleanup drain at once", async () => {
    const { h, cleanup } = await cleaning();
    const closing = tracked(h.persister.close());
    await tick();
    expect(closing.done).toBe(false);

    h.persister.supersede();
    await tick();
    expect(closing.done).toBe(true);
    cleanup.release();
    await tick(10_000);
    expect(writes(h.store)).toHaveLength(2);
  });
});

describe("ClearPosts", () => {
  it("posts nothing and takes no id without a post", () => {
    const nextClearId = vi.fn(() => "own");
    const posts = new ClearPosts({ nextClearId });
    posts.begin()();
    posts.begin("remote")();
    expect(nextClearId).not.toHaveBeenCalled();
  });

  it("gives each own clear a random id by default", () => {
    const post = vi.fn<(clearId: string) => void>();
    const posts = new ClearPosts({ post });
    posts.begin()();
    posts.begin()();
    const ids = post.mock.calls.map(([id]) => id);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[3]).toBe(ids[2]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("ignores a post that throws, at the start and at the settling", () => {
    const post = vi.fn(() => {
      throw new Error("channel closed");
    });
    const posts = new ClearPosts({ post, nextClearId: () => "own" });
    const settled = posts.begin();
    expect(post).toHaveBeenCalledTimes(1);
    expect(settled).not.toThrow();
    expect(post).toHaveBeenCalledTimes(2);
    // A relay whose post throws is still its one relay.
    expect(posts.begin("remote")).not.toThrow();
    expect(post).toHaveBeenCalledTimes(3);
    posts.begin("remote")();
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("never relays a seen clear id again, however many others pass after it", () => {
    const post = vi.fn<(clearId: string) => void>();
    const posts = new ClearPosts({ post, nextClearId: () => "own" });
    // Far above any count bound worth keeping: a set capped at any size
    // below this must fail here, since every such cap relays forever once
    // one id more than it holds circulates between two workers (gate round
    // 1 of step 135). Do not shrink it.
    const fillers = 100_000;
    posts.begin("first")();
    posts.begin()();
    for (let i = 0; i < fillers; i++) posts.begin(`filler-${i}`)();
    post.mockClear();

    // The first ids seen, foreign and own, are still known after them all.
    posts.begin("first")();
    posts.begin("own")();
    posts.begin("filler-0")();
    posts.begin(`filler-${fillers - 1}`)();
    expect(post).not.toHaveBeenCalled();

    // A new id is still relayed once, and only once.
    posts.begin("newest")();
    posts.begin("newest")();
    expect(post.mock.calls).toEqual([["newest"]]);
  });
});
