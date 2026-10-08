/**
 * The three hostings (docs/architecture.md §2.1, §4.8): each yields a
 * connected PortClient or throws a HostingError, which the fallback chain
 * treats as "step down". Any other error propagates as is.
 */

import { Engine } from "../engine/engine";
import { TscacheError } from "../errors";
import { PortClient } from "../rpc/port-client";
import type { FetcherConfig, MessagePortLike } from "../rpc/protocol";
import { RpcServer } from "../rpc/server";
import type { HostingMode } from "../types";

/** Library version reported by the in-process server. */
const LIB_VERSION = "0.0.0";

/** A hosting could not be established; the chain may step down (N25). */
export class HostingError extends TscacheError {}

export interface Hosting {
  mode: HostingMode;
  client: PortClient;
  /** Releases what this client owns (a dedicated worker); never a SharedWorker. */
  terminate(): void;
}

/** The worker-like globals, looked up at call time so tests can stub them. */
interface WorkerGlobals {
  SharedWorker?: new (
    url: string | URL,
    options?: { type?: "module" },
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
 * Completes the handshake within `timeoutMs`. A worker `error` before then
 * (script failed to load, threw at top level) or a timeout aborts the
 * handshake: its listeners go and this side's port closes, so a late hello
 * completes nothing (the SharedWorker itself is untouched).
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
    worker = new Ctor(url, { type: "module" });
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
  // Never terminated by one client: other tabs may be using it.
  return { mode: "shared", client, terminate: () => {} };
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

/** A MessageChannel pair with its own Engine in this realm (N27, §3.2). */
export async function openInProcess(
  fetcher: FetcherConfig | undefined,
): Promise<Hosting> {
  const channel = new MessageChannel();
  const server = new RpcServer(new Engine(), LIB_VERSION);
  server.attach(channel.port1 as MessagePortLike);
  const client = await PortClient.connect(
    channel.port2 as MessagePortLike,
    fetcher === undefined ? {} : { fetcher },
  );
  return {
    mode: "in-process",
    client,
    terminate: () => server.detach(channel.port1 as MessagePortLike),
  };
}
