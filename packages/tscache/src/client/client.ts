/**
 * createClient (docs/architecture.md §2.1, §4.8): runs the fallback chain
 * from the pinned hosting, then wraps the connected port in the public
 * client. Zero DOM access at module top level.
 */

import { ConfigError, TscacheError } from "../errors";
import type { PortClient } from "../rpc/port-client";
import type { FetcherConfig } from "../rpc/protocol";
import type {
  CacheConfig,
  ClientEvents,
  ClientOptions,
  HostingMode,
  ResolvedCacheConfig,
} from "../types";
import { CacheHandle } from "./cache";
import { ClientEmitter } from "./events";
import {
  type Hosting,
  HostingError,
  openDedicated,
  openInProcess,
  openShared,
} from "./hosting";

const CHAIN: readonly HostingMode[] = ["shared", "dedicated", "in-process"];

/** The one field of PageTransitionEvent the client looks at. */
interface PageHide {
  persisted?: boolean;
}

/** Surfaces a listener error that no caller can catch. */
function report(error: unknown): void {
  const page = globalThis as { reportError?: (e: unknown) => void };
  if (typeof page.reportError === "function") page.reportError(error);
  else throw error;
}
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;

export interface TscacheClient {
  /** Which hosting won the fallback chain. */
  readonly mode: HostingMode;
  /** Get-or-create (N4). */
  cache(config: CacheConfig): Promise<CacheHandle>;
  /** Empties every cache; in SharedWorker mode this affects ALL tabs. */
  clearAll(): Promise<void>;
  /** Delivers new auth material to the fetcher (step ⑪). */
  updateAuth(context: unknown): Promise<void>;
  on<E extends keyof ClientEvents>(
    event: E,
    fn: (payload: ClientEvents[E]) => void,
  ): () => void;
  off<E extends keyof ClientEvents>(
    event: E,
    fn: (payload: ClientEvents[E]) => void,
  ): void;
  /** Releases the port and anything this client owns. Idempotent. */
  dispose(): Promise<void>;
}

interface Resolved {
  chain: HostingMode[];
  workerUrl: string | URL | undefined;
  timeoutMs: number;
  fetcher: FetcherConfig | undefined;
}

function chainFrom(mode: HostingMode | undefined): HostingMode[] {
  const start = mode ?? "shared";
  if (!CHAIN.includes(start)) {
    throw new ConfigError(`mode must be one of ${CHAIN.join(", ")}`);
  }
  return CHAIN.slice(CHAIN.indexOf(start));
}

function timeoutOf(options: ClientOptions): number {
  const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new ConfigError("handshakeTimeoutMs must be a positive number");
  }
  return timeoutMs;
}

/** The fetcher config as it crosses the wire: module as a string. */
function fetcherOf(options: ClientOptions): FetcherConfig | undefined {
  const fetcher = options.fetcher;
  if (fetcher === undefined) return undefined;
  const wire: FetcherConfig = { module: String(fetcher.module) };
  if (fetcher.context !== undefined) wire.context = fetcher.context;
  return wire;
}

function resolve(options: ClientOptions): Resolved {
  const chain = chainFrom(options.mode);
  if (chain[0] !== "in-process" && options.workerUrl === undefined) {
    throw new ConfigError("workerUrl is required unless mode is 'in-process'");
  }
  return {
    chain,
    workerUrl: options.workerUrl,
    timeoutMs: timeoutOf(options),
    fetcher: fetcherOf(options),
  };
}

function open(mode: HostingMode, r: Resolved): Promise<Hosting> {
  const url = r.workerUrl as string | URL;
  switch (mode) {
    case "shared":
      return openShared(url, r.fetcher, r.timeoutMs);
    case "dedicated":
      return openDedicated(url, r.fetcher, r.timeoutMs);
    default:
      return openInProcess(r.fetcher);
  }
}

/**
 * Tries each hosting in turn. A HostingError steps down and is reported
 * through `fallbacks`; a ProtocolMismatchError (or any other error) rejects.
 */
async function connect(
  r: Resolved,
  fallbacks: ClientEvents["modeFallback"][],
): Promise<Hosting> {
  for (let i = 0; i < r.chain.length; i++) {
    const mode = r.chain[i] as HostingMode;
    try {
      return await open(mode, r);
    } catch (error) {
      const next = r.chain[i + 1];
      if (!(error instanceof HostingError) || next === undefined) throw error;
      fallbacks.push({ from: mode, to: next, reason: error.message });
    }
  }
  throw new TscacheError("no hosting available");
}

class Client implements TscacheClient {
  readonly mode: HostingMode;
  readonly #hosting: Hosting;
  readonly #port: PortClient;
  readonly #events = new ClientEmitter();
  #disposed = false;

  constructor(hosting: Hosting, fallbacks: ClientEvents["modeFallback"][]) {
    this.#hosting = hosting;
    this.#port = hosting.client;
    this.mode = hosting.mode;
    this.#port.on((evt) => this.#events.receive(evt));
    // The chain ran before anyone could subscribe: deliver its steps on the
    // next macrotask, after the awaiting caller has had its turn. Every
    // step is delivered even if a listener throws; the first error surfaces
    // afterwards.
    if (fallbacks.length > 0) {
      setTimeout(() => {
        let failure: { error: unknown } | undefined;
        for (const step of fallbacks) {
          try {
            this.#events.emit("modeFallback", step);
          } catch (error) {
            failure ??= { error };
          }
        }
        // Nobody awaits this macrotask: hand the error to the page's
        // reporter (window.reportError) rather than throwing into the void.
        if (failure !== undefined) report(failure.error);
      }, 0);
    }
    // A tab that closes or navigates away tells the worker (browsers fire
    // no port-close event a SharedWorker could rely on); best effort. A page
    // entering the back/forward cache (persisted) may come back with its
    // objects intact, so it keeps its client.
    const page = globalThis as {
      addEventListener?: (type: string, fn: (e: PageHide) => void) => void;
      removeEventListener?: (type: string, fn: (e: PageHide) => void) => void;
    };
    if (typeof page.addEventListener === "function") {
      this.#unlistenPage = () =>
        page.removeEventListener?.("pagehide", this.#onPageHide);
      page.addEventListener("pagehide", this.#onPageHide);
    }
  }

  readonly #onPageHide = (event: PageHide) => {
    if (event?.persisted === true) return;
    void this.dispose();
  };
  #unlistenPage: () => void = () => {};

  async cache(config: CacheConfig): Promise<CacheHandle> {
    this.#live();
    const resolved = (await this.#port.request(
      "cache",
      config,
    )) as ResolvedCacheConfig;
    return new CacheHandle(resolved.id, this.#port, this.#events);
  }

  async clearAll(): Promise<void> {
    this.#live();
    await this.#port.request("clearAll", {});
  }

  async updateAuth(context: unknown): Promise<void> {
    this.#live();
    await this.#port.request("updateAuth", { context });
  }

  on<E extends keyof ClientEvents>(
    event: E,
    fn: (payload: ClientEvents[E]) => void,
  ): () => void {
    return this.#events.on(event, fn);
  }

  off<E extends keyof ClientEvents>(
    event: E,
    fn: (payload: ClientEvents[E]) => void,
  ): void {
    this.#events.off(event, fn);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unlistenPage();
    this.#port.dispose();
    this.#hosting.terminate();
  }

  #live(): void {
    if (this.#disposed) throw new TscacheError("client disposed");
  }
}

/** §2.1. Resolves once a hosting completed the handshake. */
export async function createClient(
  options: ClientOptions = {},
): Promise<TscacheClient> {
  const r = resolve(options);
  const fallbacks: ClientEvents["modeFallback"][] = [];
  const hosting = await connect(r, fallbacks);
  return new Client(hosting, fallbacks);
}
