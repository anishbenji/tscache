/**
 * The three hostings (docs/architecture.md §2.1, §4.8): each yields a
 * connected PortClient or throws a HostingError, which the fallback chain
 * treats as "step down". Any other error propagates as is.
 */

import { TscacheError } from "../errors";
import { lockManager, watchLifetimeLock } from "../rpc/lifetime";
import { PortClient } from "../rpc/port-client";
import type { FetcherConfig, MessagePortLike } from "../rpc/protocol";
import type { HostingMode } from "../types";

/** A hosting could not be established; the chain may step down (N25). */
export class HostingError extends TscacheError {}

export interface Hosting {
  mode: HostingMode;
  client: PortClient;
  /**
   * Releases what this client owns (a dedicated worker, a queued lock
   * request); never a SharedWorker. Idempotent.
   */
  terminate(): void;
}

/** The worker-like globals, looked up at call time so tests can stub them. */
interface WorkerGlobals {
  SharedWorker?: new (
    url: string | URL,
    options?: { type?: "module"; extendedLifetime?: boolean },
  ) => { port: MessagePortLike } & ErrorSource;
  Worker?: new (
    url: string | URL,
    options?: { type?: "module" },
  ) => MessagePortLike & ErrorSource & { terminate(): void };
}

interface ErrorSource {
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener(type: "error", listener: (event: unknown) => void): void;
}

/**
 * Completes the handshake. `timeoutMs` bounds only the wait for hello
 * (N25): once hello arrives the timer stops, and the rest (the worker
 * loading the fetcher module, init-ok or init-err) takes as long as it
 * takes. A worker `error` at any point before init-ok (script failed to
 * load, threw at top level) or the timeout aborts the handshake: its
 * listeners go and this side's port closes, so a late hello completes
 * nothing (the SharedWorker itself is untouched).
 */
async function handshake(
  port: MessagePortLike,
  source: ErrorSource,
  fetcher: FetcherConfig | undefined,
  timeoutMs: number,
  what: string,
): Promise<PortClient> {
  const controller = new AbortController();
  const onError = (event: unknown) => {
    controller.abort(
      new HostingError(`${what} failed to start: ${describe(event)}`),
    );
  };
  source.addEventListener("error", onError);
  const timer = setTimeout(
    () =>
      controller.abort(
        new HostingError(`${what} did not answer within ${timeoutMs} ms`),
      ),
    timeoutMs,
  );
  try {
    return await PortClient.connect(
      port,
      fetcher === undefined ? {} : { fetcher },
      controller.signal,
      () => clearTimeout(timer),
    );
  } finally {
    clearTimeout(timer);
    source.removeEventListener("error", onError);
  }
}

/** The message of a worker error event, if it has one. */
function describe(event: unknown): string {
  return typeof event === "object" && event !== null && "message" in event
    ? String((event as { message: unknown }).message)
    : "worker error";
}

function globals(): WorkerGlobals {
  return globalThis as unknown as WorkerGlobals;
}

export async function openShared(
  url: string | URL,
  fetcher: FetcherConfig | undefined,
  timeoutMs: number,
): Promise<Hosting> {
  const Ctor = globals().SharedWorker;
  if (typeof Ctor !== "function") {
    throw new HostingError("SharedWorker is not available");
  }
  let worker: InstanceType<NonNullable<WorkerGlobals["SharedWorker"]>>;
  try {
    // extendedLifetime keeps the worker about 30 s after its last tab, so the
    // final flush can land (§4.10.8, N50); a browser without the option
    // ignores it. Every tab passes the same options, so they reach one worker.
    worker = new Ctor(url, { type: "module", extendedLifetime: true });
  } catch (error) {
    throw new HostingError(
      `SharedWorker could not be created: ${String(error)}`,
    );
  }
  const client = await handshake(
    worker.port,
    worker,
    fetcher,
    timeoutMs,
    "SharedWorker",
  );
  // The worker can die with the tab hosting it and nothing else would tell
  // this one (N32): queue on its lifetime lock, granted only once it is gone.
  const watch = new AbortController();
  const locks = lockManager();
  if (client.lock !== undefined && locks !== undefined) {
    watchLifetimeLock(locks, client.lock, watch.signal, () =>
      client.abort(
        new TscacheError(
          "SharedWorker stopped running (its lifetime lock was released)",
        ),
      ),
    );
  }
  // Never terminated by one client: other tabs may be using it.
  return { mode: "shared", client, terminate: () => watch.abort() };
}

export async function openDedicated(
  url: string | URL,
  fetcher: FetcherConfig | undefined,
  timeoutMs: number,
): Promise<Hosting> {
  const Ctor = globals().Worker;
  if (typeof Ctor !== "function") {
    throw new HostingError("Worker is not available");
  }
  let worker: InstanceType<NonNullable<WorkerGlobals["Worker"]>>;
  try {
    worker = new Ctor(url, { type: "module" });
  } catch (error) {
    throw new HostingError(`Worker could not be created: ${String(error)}`);
  }
  let client: PortClient;
  try {
    client = await handshake(worker, worker, fetcher, timeoutMs, "Worker");
  } catch (error) {
    worker.terminate();
    throw error;
  }
  // A Worker reports a fatal error but never a port closure: keep watching
  // for the hosting's lifetime so pending requests do not hang.
  const onFatal = (event: unknown) =>
    client.abort(new TscacheError(`Worker failed: ${describe(event)}`));
  worker.addEventListener("error", onFatal);
  return {
    mode: "dedicated",
    client,
    terminate: () => {
      worker.removeEventListener("error", onFatal);
      worker.terminate();
    },
  };
}

/**
 * The in-process hosting (N27), loaded on first use: the engine is a chunk
 * of its own, which a page served by a worker never fetches. A chunk that
 * fails to load fails this hosting like any other, so `createClient`
 * rejects with this HostingError (it is the last of the chain).
 */
export async function openInProcess(
  fetcher: FetcherConfig | undefined,
): Promise<Hosting> {
  let connect: (fetcher: FetcherConfig | undefined) => Promise<Hosting>;
  try {
    const { connectInProcess } = await import("./in-process");
    connect = connectInProcess;
  } catch (error) {
    throw new HostingError(
      `the in-process hosting could not be loaded: ${String(error)}`,
    );
  }
  return connect(fetcher);
}
