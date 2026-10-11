import { afterEach, describe, expect, it, vi } from "vitest";
import {
  holdLifetimeLock,
  type LockManagerLike,
  watchLifetimeLock,
} from "../src/rpc/lifetime";
import type { MessagePortLike } from "../src/rpc/protocol";

// Implementer tests (architecture §4.8, N32): the worker's lifetime lock,
// held by the SharedWorker entry and watched by shared-mode clients, with a
// fake Web Locks API whose grants the test controls.

interface Requested {
  name: string;
  mode: "exclusive" | "shared";
  signal: AbortSignal | undefined;
  /** Runs the callback as the browser would on grant. */
  grant(): void;
  /** Whether the callback's promise settled, which releases the lock. */
  released: boolean;
}

/** A fake navigator.locks: records requests; aborting one rejects it. */
function fakeLocks(): { locks: LockManagerLike; requests: Requested[] } {
  const requests: Requested[] = [];
  const locks: LockManagerLike = {
    request: (name, options, callback) =>
      new Promise((resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("withdrawn", "AbortError")),
          { once: true },
        );
        const entry: Requested = {
          name,
          mode: options.mode,
          signal: options.signal,
          released: false,
          grant: () => {
            Promise.resolve(callback()).then(
              (value) => {
                entry.released = true;
                resolve(value);
              },
              (error) => {
                entry.released = true;
                reject(error);
              },
            );
          },
        };
        requests.push(entry);
      }),
  };
  return { locks, requests };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("holdLifetimeLock", () => {
  it("resolves with a fresh exclusive lock's name once it is held, and keeps it", async () => {
    const { locks, requests } = fakeLocks();
    let held: string | undefined;
    void holdLifetimeLock(locks).then((name) => {
      held = name;
    });
    await tick();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.mode).toBe("exclusive");
    expect(requests[0]?.name).toMatch(/^tscache-worker:[0-9a-f-]{36}$/);
    // Not yet granted: nothing to report.
    expect(held).toBeUndefined();
    requests[0]?.grant();
    await tick();
    expect(held).toBe(requests[0]?.name);
    // The callback never settles, so the lock is never released.
    await tick();
    expect(requests[0]?.released).toBe(false);
  });

  it("names a different lock each time", async () => {
    const { locks, requests } = fakeLocks();
    void holdLifetimeLock(locks);
    void holdLifetimeLock(locks);
    await tick();
    expect(requests[0]?.name).not.toBe(requests[1]?.name);
  });

  it("resolves undefined without Web Locks or when the request is refused", async () => {
    expect(await holdLifetimeLock(undefined)).toBeUndefined();
    const rejecting: LockManagerLike = {
      request: () => Promise.reject(new DOMException("no", "SecurityError")),
    };
    expect(await holdLifetimeLock(rejecting)).toBeUndefined();
    const throwing: LockManagerLike = {
      request: () => {
        throw new TypeError("bad name");
      },
    };
    expect(await holdLifetimeLock(throwing)).toBeUndefined();
  });
});

describe("watchLifetimeLock", () => {
  it("queues in shared mode with the signal and reports the grant once", async () => {
    const { locks, requests } = fakeLocks();
    const gone = vi.fn();
    const watch = new AbortController();
    watchLifetimeLock(locks, "tscache-worker:w", watch.signal, gone);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      name: "tscache-worker:w",
      mode: "shared",
      signal: watch.signal,
    });
    expect(gone).not.toHaveBeenCalled();
    requests[0]?.grant();
    await tick();
    expect(gone).toHaveBeenCalledTimes(1);
    // The callback returns at once: the shared lock is not kept.
    expect(requests[0]?.released).toBe(true);
  });

  it("an aborted watch reports nothing and its rejection is absorbed", async () => {
    const { locks, requests } = fakeLocks();
    const gone = vi.fn();
    const watch = new AbortController();
    watchLifetimeLock(locks, "tscache-worker:w", watch.signal, gone);
    watch.abort();
    // A grant racing the abort still reports nothing.
    requests[0]?.grant();
    await tick();
    expect(gone).not.toHaveBeenCalled();
  });

  it("a refused request watches nothing and throws nothing", async () => {
    const gone = vi.fn();
    const signal = new AbortController().signal;
    watchLifetimeLock(
      { request: () => Promise.reject(new Error("refused")) },
      "n",
      signal,
      gone,
    );
    expect(() =>
      watchLifetimeLock(
        {
          request: () => {
            throw new TypeError("bad");
          },
        },
        "n",
        signal,
        gone,
      ),
    ).not.toThrow();
    await tick();
    expect(gone).not.toHaveBeenCalled();
  });
});

describe("SharedWorker entry", () => {
  /** Loads entries/worker.ts as a SharedWorker global would run it. */
  async function loadSharedWorker(locks: LockManagerLike | undefined) {
    const connect: ((event: { ports: MessagePortLike[] }) => void)[] = [];
    vi.stubGlobal("navigator", locks === undefined ? {} : { locks });
    vi.stubGlobal("importScripts", () => {});
    vi.stubGlobal("onconnect", null);
    vi.stubGlobal(
      "addEventListener",
      (type: string, fn: (event: { ports: MessagePortLike[] }) => void) => {
        if (type === "connect") connect.push(fn);
      },
    );
    vi.resetModules();
    await import("../src/entries/worker");
    expect(connect).toHaveLength(1);
    const ports: MessagePort[] = [];
    return {
      /** Connects a port; returns the messages its page side receives. */
      connect() {
        const channel = new MessageChannel();
        ports.push(channel.port1, channel.port2);
        const seen: unknown[] = [];
        channel.port2.addEventListener("message", (e) => seen.push(e.data));
        channel.port2.start();
        connect[0]?.({ ports: [channel.port1 as MessagePortLike] });
        return seen;
      },
      close: () => {
        for (const port of ports) port.close();
      },
    };
  }

  it("says hello only once it holds its lifetime lock, naming it", async () => {
    const { locks, requests } = fakeLocks();
    const worker = await loadSharedWorker(locks);
    try {
      // Connects before the grant: waits.
      const early = worker.connect();
      await tick();
      expect(early).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.mode).toBe("exclusive");
      requests[0]?.grant();
      for (let i = 0; i < 50 && early.length === 0; i++) await tick();
      expect(early).toEqual([
        expect.objectContaining({
          t: "hello",
          clientId: "c1",
          lock: requests[0]?.name,
        }),
      ]);
      // Connects after the grant: answered at once, by the same server.
      const late = worker.connect();
      for (let i = 0; i < 50 && late.length === 0; i++) await tick();
      expect(late).toEqual([
        expect.objectContaining({ clientId: "c2", lock: requests[0]?.name }),
      ]);
    } finally {
      worker.close();
    }
  });

  it("without Web Locks says hello at once, with no lock", async () => {
    const worker = await loadSharedWorker(undefined);
    try {
      const seen = worker.connect();
      for (let i = 0; i < 50 && seen.length === 0; i++) await tick();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ t: "hello", clientId: "c1" });
      expect(seen[0]).not.toHaveProperty("lock");
    } finally {
      worker.close();
    }
  });
});
