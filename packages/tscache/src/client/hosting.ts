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
 * Completes the handshake within `timeoutMs`; a worker `error` before then
 * (script failed to load, threw at top level) or a timeout is a HostingError.
 */
async function handshake(
  port: MessagePortLike,
  source: ErrorSource,
  fetcher: FetcherConfig | undefined,
  timeoutMs: number,
  what: string,
): Promise<PortClient> {
  let fail: (error: HostingError) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = (error) => reject(error);
  });
  const onError = (event: unknown) => {
    const message =
      typeof event === "object" && event !== null && "message" in event
        ? String((event as { message: unknown }).message)
        : "worker error";
    fail(new HostingError(`${what} failed to start: ${message}`));
  };
  source.addEventListener("error", onError);
  const timer = setTimeout(
    () =>
      fail(new HostingError(`${what} did not answer within ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    return await Promise.race([
      PortClient.connect(port, fetcher === undefined ? {} : { fetcher }),
      failed,
    ]);
  } finally {
    clearTimeout(timer);
    source.removeEventListener("error", onError);
  }
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
  try {
    const client = await handshake(
      worker,
      worker,
      fetcher,
      timeoutMs,
      "Worker",
    );
    return { mode: "dedicated", client, terminate: () => worker.terminate() };
  } catch (error) {
    worker.terminate();
    throw error;
  }
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
