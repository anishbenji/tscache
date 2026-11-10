import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client/client";
import { HostingError, openDedicated, openShared } from "../src/client/hosting";
import { Engine } from "../src/engine/engine";
import { TscacheError } from "../src/errors";
import type { MessagePortLike } from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { ClientEvents } from "../src/types";
import { installFakeLocks } from "./lock-test-helpers";

// Implementer tests (architecture §4.8, §8 N25): the handshake timeout bounds
// only the wait for hello. What follows hello (the fetcher load, the lifetime
// lock, init-ok or init-err) is not bounded by it. Fake timers drive the
// timeout; the ports are real MessageChannels, which fake timers leave alone.

const url = "/dist/worker.js";
const TIMEOUT = 50;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Waits for a condition the test cannot await. vi.waitFor runs on real
 * timers even while fake ones are installed (docs/testing.md).
 */
const eventually = (assertion: () => unknown) =>
  vi.waitFor(assertion, { timeout: 4000, interval: 1 });

/**
 * The worker's side of a channel, attached to a real RpcServer, with its
 * answer to init (init-ok or init-err) held back until the test releases it:
 * the server says hello at once (naming `lock`, if given) and answers init
 * only when the test says so, as a slow fetcher import would. Whatever the
 * server does after that answer (more messages, closing its port after an
 * init-err) waits behind it, so the order the client sees is kept.
 */
function gatedServer(port: MessagePort, lock?: string) {
  /** The held answers to init, for the test to inspect. */
  const held: unknown[] = [];
  const queue: (() => void)[] = [];
  let gated = true;
  const run = (action: () => void) => {
    if (gated && queue.length > 0) queue.push(action);
    else action();
  };
  const wrapped: MessagePortLike = {
    postMessage: (m: unknown, t?: Transferable[]) => {
      const kind = (m as { t?: unknown }).t;
      const send = () => port.postMessage(m, t ?? []);
      if (gated && (kind === "init-ok" || kind === "init-err")) {
        held.push(m);
        queue.push(send);
      } else run(send);
    },
    addEventListener: (type, fn) =>
      port.addEventListener(type, fn as EventListener),
    removeEventListener: (type, fn) =>
      port.removeEventListener(type, fn as EventListener),
    start: () => port.start(),
    close: () => run(() => port.close()),
  };
  new RpcServer(new Engine(), "0.0.0", lock).attach(wrapped);
  return {
    held,
    /** Closes the worker's side, as a dying worker would. */
    close: () => port.close(),
    release: () => {
      gated = false;
      for (const action of queue.splice(0)) action();
    },
  };
}

/** A dedicated-worker stand-in whose error event the test fires. */
function silentWorker() {
  const errorListeners = new Set<(e: unknown) => void>();
  const port = new MessageChannel().port2;
  let terminated = 0;
  const worker = {
    postMessage: (m: unknown) => port.postMessage(m),
    addEventListener: (type: string, fn: (e: never) => void) => {
      if (type === "error") errorListeners.add(fn as (e: unknown) => void);
      else port.addEventListener(type, fn as EventListener);
    },
    removeEventListener: (type: string, fn: (e: never) => void) => {
      if (type === "error") errorListeners.delete(fn as (e: unknown) => void);
      else port.removeEventListener(type, fn as EventListener);
    },
    start: () => port.start(),
    close: () => port.close(),
    terminate: () => {
      terminated++;
    },
  };
  return {
    worker,
    terminated: () => terminated,
    fail: (message: string) => {
      for (const fn of errorListeners) fn({ message });
    },
  };
}

describe("handshake timeout (N25)", () => {
  it("connects when hello comes at once and init-ok only after the timeout, with no modeFallback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let gate: ReturnType<typeof gatedServer> | undefined;
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal(
      "SharedWorker",
      class {
        port: unknown;
        constructor() {
          const channel = new MessageChannel();
          gate = gatedServer(channel.port1);
          this.port = channel.port2;
        }
        addEventListener() {}
        removeEventListener() {}
      },
    );
    const pending = createClient({
      workerUrl: url,
      handshakeTimeoutMs: TIMEOUT,
    });
    // hello went out and init came back: the server's init-ok is held.
    await eventually(() => expect(gate?.held.length).toBe(1));
    // Far past the timeout, with init-ok still held back.
    await vi.advanceTimersByTimeAsync(TIMEOUT * 10);
    gate?.release();
    const client = await pending;
    try {
      expect(client.mode).toBe("shared");
      const seen: ClientEvents["modeFallback"][] = [];
      client.on("modeFallback", (e) => seen.push(e));
      // Fallback steps are delivered on a zero timer: run it.
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
      await client.dispose();
    }
  });

  it("raises HostingError when hello never comes, and the client steps down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // A SharedWorker whose script never says hello.
    vi.stubGlobal(
      "SharedWorker",
      class {
        port = new MessageChannel().port2;
        addEventListener() {}
        removeEventListener() {}
      },
    );
    const silent = openShared(url, undefined, TIMEOUT);
    const rejected = expect(silent).rejects.toThrow(
      new HostingError(`SharedWorker did not answer within ${TIMEOUT} ms`),
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    await rejected;

    vi.stubGlobal("Worker", undefined);
    const pending = createClient({
      workerUrl: url,
      handshakeTimeoutMs: TIMEOUT,
    });
    await eventually(() => expect(vi.getTimerCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    const client = await pending;
    try {
      // Stepped down past the dedicated worker, which this page lacks.
      expect(client.mode).toBe("in-process");
    } finally {
      vi.useRealTimers();
      await client.dispose();
    }
  });

  it("steps down on a worker error before hello", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = silentWorker();
    vi.stubGlobal("Worker", function FakeWorker() {
      return fake.worker;
    });
    const dedicated = openDedicated(url, undefined, TIMEOUT);
    fake.fail("script 404");
    await expect(dedicated).rejects.toThrow(
      new HostingError("Worker failed to start: script 404"),
    );
    expect(fake.terminated()).toBe(1);
    // The abort came from the error, not the timer, which is gone.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("after hello (N25, N30, N32)", () => {
  const lock = "tscache-worker:w1";

  /** A SharedWorker global whose server is gated; `gate()` is the latest. */
  function installGatedSharedWorker(name?: string) {
    let gate: ReturnType<typeof gatedServer> | undefined;
    vi.stubGlobal(
      "SharedWorker",
      class {
        port: unknown;
        constructor() {
          const channel = new MessageChannel();
          gate = gatedServer(channel.port1, name);
          this.port = channel.port2;
        }
        addEventListener() {}
        removeEventListener() {}
      },
    );
    return () => gate;
  }

  it("steps down when the SharedWorker's lifetime lock is granted between hello and init-ok", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests = installFakeLocks();
    vi.stubGlobal("Worker", undefined);
    const gate = installGatedSharedWorker(lock);
    const pending = createClient({
      workerUrl: url,
      handshakeTimeoutMs: TIMEOUT,
    });
    await eventually(() => expect(gate()?.held.length).toBe(1));
    // The timer is gone: only the lock can end this handshake now.
    await vi.advanceTimersByTimeAsync(TIMEOUT * 10);
    expect(requests.map((r) => [r.name, r.mode])).toEqual([[lock, "shared"]]);
    // The worker's realm ended (its tab's renderer crashed) before init-ok.
    requests[0]?.grant();
    const client = await pending;
    try {
      expect(client.mode).toBe("in-process");
      const seen: ClientEvents["modeFallback"][] = [];
      client.on("modeFallback", (e) => seen.push(e));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.map((e) => [e.from, e.reason])).toEqual([
        [
          "shared",
          "SharedWorker stopped running during the handshake (its lifetime lock was released)",
        ],
        ["dedicated", "Worker is not available"],
      ]);
      // One request in all: the watch was not started twice.
      expect(requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await client.dispose();
    }
  });

  it("hands the hello-time lock watch over to the connected client: one request, withdrawn on terminate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests = installFakeLocks();
    const gate = installGatedSharedWorker(lock);
    const pending = openShared(url, undefined, TIMEOUT);
    await eventually(() => expect(gate()?.held.length).toBe(1));
    expect(requests).toHaveLength(1);
    gate()?.release();
    const hosting = await pending;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal?.aborted).toBe(false);
    hosting.terminate();
    expect(requests[0]?.signal?.aborted).toBe(true);
    hosting.client.dispose();
  });

  it("withdraws the hello-time lock watch when the handshake fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests = installFakeLocks();
    const gate = installGatedSharedWorker(lock);
    const pending = openShared(url, undefined, TIMEOUT);
    const rejected = expect(pending).rejects.toBeInstanceOf(TscacheError);
    await eventually(() => expect(gate()?.held.length).toBe(1));
    // Port closed before init-ok.
    gate()?.close();
    await rejected;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it("an init-err after the timeout rejects createClient without falling back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let dedicated = 0;
    vi.stubGlobal("Worker", function FakeWorker() {
      dedicated++;
      throw new Error("no dedicated worker in this test");
    });
    const gate = installGatedSharedWorker();
    const pending = createClient({
      workerUrl: url,
      handshakeTimeoutMs: TIMEOUT,
      fetcher: { module: "/missing-fetcher-module.js" },
    });
    const rejected = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    // The server could not load the fetcher; its init-err is held back.
    await eventually(() =>
      expect(gate()?.held).toEqual([
        expect.objectContaining({ t: "init-err" }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT * 10);
    gate()?.release();
    const error = await rejected;
    expect(error).toBeInstanceOf(TscacheError);
    expect(error).not.toBeInstanceOf(HostingError);
    expect(String((error as Error).message)).toMatch(/missing-fetcher-module/);
    expect(dedicated).toBe(0);
  });

  it("a worker error after hello still fails the hosting and terminates the worker once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const errorListeners = new Set<(e: unknown) => void>();
    let terminated = 0;
    let gate: ReturnType<typeof gatedServer> | undefined;
    vi.stubGlobal("Worker", function FakeWorker() {
      const channel = new MessageChannel();
      gate = gatedServer(channel.port1);
      const port = channel.port2;
      return {
        postMessage: (m: unknown) => port.postMessage(m),
        addEventListener: (type: string, fn: (e: never) => void) => {
          if (type === "error") errorListeners.add(fn as (e: unknown) => void);
          else port.addEventListener(type, fn as EventListener);
        },
        removeEventListener: (type: string, fn: (e: never) => void) => {
          if (type === "error")
            errorListeners.delete(fn as (e: unknown) => void);
          else port.removeEventListener(type, fn as EventListener);
        },
        start: () => port.start(),
        close: () => port.close(),
        terminate: () => {
          terminated++;
        },
      };
    });
    const pending = openDedicated(url, undefined, TIMEOUT);
    const rejected = expect(pending).rejects.toThrow(
      new HostingError("Worker failed to start: boom"),
    );
    await eventually(() => expect(gate?.held.length).toBe(1));
    // Past the timeout: had the timer still run, it would have failed first.
    await vi.advanceTimersByTimeAsync(TIMEOUT * 10);
    for (const fn of errorListeners) fn({ message: "boom" });
    await rejected;
    expect(terminated).toBe(1);
  });
});
