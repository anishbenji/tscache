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

function resolve(options: ClientOptions): Resolved {
  const mode = options.mode ?? "shared";
  if (!CHAIN.includes(mode)) {
    throw new ConfigError(`mode must be one of ${CHAIN.join(", ")}`);
  }
  const chain = CHAIN.slice(CHAIN.indexOf(mode));
  if (mode !== "in-process" && options.workerUrl === undefined) {
    throw new ConfigError("workerUrl is required unless mode is 'in-process'");
  }
  const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new ConfigError("handshakeTimeoutMs must be a positive number");
  }
  const fetcher =
    options.fetcher === undefined
      ? undefined
      : {
          module: String(options.fetcher.module),
          ...(options.fetcher.context !== undefined
            ? { context: options.fetcher.context }
            : {}),
        };
  return { chain, workerUrl: options.workerUrl, timeoutMs, fetcher };
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
    // next macrotask, after the awaiting caller has had its turn.
    if (fallbacks.length > 0) {
      setTimeout(() => {
        for (const step of fallbacks) this.#events.emit("modeFallback", step);
      }, 0);
    }
  }

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
