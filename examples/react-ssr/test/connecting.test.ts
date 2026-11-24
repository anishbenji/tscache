import { describe, expect, it } from "vitest";
import {
  type Attempt,
  attempts,
  type Outcomes,
  untilPageGone,
} from "../src/connecting";

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** One started attempt: what it was given, and how to settle it. */
interface Started {
  attempt: Attempt;
  resolve(result: string): void;
  reject(error: unknown): void;
}

/** Attempts whose `connect` a test settles by hand, and what they report. */
function harness() {
  const started: Started[] = [];
  const seen: string[] = [];
  const on: Outcomes<string> = {
    connected: (result) => seen.push(`connected ${result}`),
    lost: (reason) => seen.push(`lost ${reason}`),
    failed: (error) => seen.push(`failed ${(error as Error).message}`),
    drop: (result) => seen.push(`dropped ${result}`),
  };
  const stop = attempts((attempt) => {
    const { promise, resolve, reject } = deferred<string>();
    started.push({ attempt, resolve, reject });
    return promise;
  }, on);
  return { started, seen, stop };
}

/**
 * Lets every settled promise's handlers run. `attempts` keeps its promise
 * chain to itself, so a test cannot await it; it cannot flake: the handlers
 * are microtasks of promises already settled, with no timer or I/O between,
 * and Node drains every microtask before it runs a setImmediate callback.
 */
const settle = () => new Promise<void>((done) => setImmediate(done));

describe("attempts", () => {
  it("reports a live attempt's result as connected", async () => {
    const { started, seen } = harness();
    expect(started).toHaveLength(1);
    expect(started[0]?.attempt.live()).toBe(true);
    started[0]?.resolve("first");
    await settle();
    expect(seen).toEqual(["connected first"]);
  });

  it("drops a lost attempt's late result, and the next attempt connects", async () => {
    const { started, seen } = harness();
    const first = started[0];
    first?.attempt.lose("crashed");
    expect(first?.attempt.live()).toBe(false);
    expect(started).toHaveLength(2);
    expect(started[1]?.attempt.live()).toBe(true);

    // The lost attempt's seeding failed but no longer fails the attempt, so
    // it resolves after the next one connected: it must not replace it.
    started[1]?.resolve("second");
    await settle();
    first?.resolve("first");
    await settle();
    expect(seen).toEqual(["lost crashed", "connected second", "dropped first"]);
  });

  it("drops the result of an attempt that resolves after stop, and starts no other", async () => {
    const { started, seen, stop } = harness();
    stop();
    expect(started[0]?.attempt.live()).toBe(false);
    started[0]?.attempt.lose("closed");
    started[0]?.resolve("first");
    await settle();
    expect(started).toHaveLength(1);
    expect(seen).toEqual(["dropped first"]);
  });

  it("reports an attempt that fails to connect", async () => {
    const { started, seen } = harness();
    started[0]?.reject(new Error("no worker"));
    await settle();
    expect(seen).toEqual(["failed no worker"]);
  });

  it("says nothing of a lost attempt's failure, and the next attempt connects", async () => {
    const { started, seen } = harness();
    // The port client rejects the pending call, then reports the loss.
    started[0]?.attempt.lose("port closed");
    started[0]?.reject(new Error("port closed"));
    started[1]?.resolve("second");
    await settle();
    expect(seen).toEqual(["lost port closed", "connected second"]);
  });

  it("says nothing of a failure that arrives after stop", async () => {
    const { started, seen, stop } = harness();
    stop();
    started[0]?.reject(new Error("unmounted"));
    await settle();
    expect(seen).toEqual([]);
  });
});

describe("untilPageGone", () => {
  /** A `pagehide` event, `persisted` as given. */
  const pagehide = (persisted: boolean) =>
    Object.assign(new Event("pagehide"), { persisted });

  it("stops the attempts when the page is hidden for good", async () => {
    // tscache disposes the client on this event: its pending hydrate rejects
    // with "client disposed" and no workerLost fires, so seedCache counts it
    // as not applied. The attempt must not report that client as connected.
    const page = new EventTarget();
    const { started, seen, stop } = harness();
    untilPageGone(page, stop);
    page.dispatchEvent(pagehide(false));
    expect(started[0]?.attempt.live()).toBe(false);
    started[0]?.resolve("first");
    await settle();
    expect(seen).toEqual(["dropped first"]);
  });

  it("keeps them going when the page enters the back/forward cache", async () => {
    const page = new EventTarget();
    const { started, seen, stop } = harness();
    untilPageGone(page, stop);
    page.dispatchEvent(pagehide(true));
    started[0]?.resolve("first");
    await settle();
    expect(seen).toEqual(["connected first"]);
  });

  it("stops listening when told to", () => {
    const page = new EventTarget();
    let stops = 0;
    const unlisten = untilPageGone(page, () => {
      stops += 1;
    });
    unlisten();
    page.dispatchEvent(pagehide(false));
    expect(stops).toBe(0);
  });
});
