import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client/client";
import { HostingError, openDedicated, openShared } from "../src/client/hosting";
import { Engine } from "../src/engine/engine";
import type { MessagePortLike } from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { ClientEvents } from "../src/types";

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
 * The worker's side of a channel, attached to a real RpcServer, with init-ok
 * held back until the test releases it: the server says hello at once and
 * answers init only when the test says so, as a slow fetcher import would.
 */
function gatedServer(port: MessagePort) {
  const held: unknown[] = [];
  let gated = true;
  const wrapped: MessagePortLike = {
    postMessage: (m: unknown, t?: Transferable[]) => {
      if (gated && (m as { t?: unknown }).t === "init-ok") held.push(m);
      else port.postMessage(m, t ?? []);
    },
    addEventListener: (type, fn) =>
      port.addEventListener(type, fn as EventListener),
    removeEventListener: (type, fn) =>
      port.removeEventListener(type, fn as EventListener),
    start: () => port.start(),
    close: () => port.close(),
  };
  new RpcServer(new Engine(), "0.0.0").attach(wrapped);
  return {
    held,
    release: () => {
      gated = false;
      for (const m of held.splice(0)) port.postMessage(m);
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
