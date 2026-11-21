/**
 * createClient (docs/architecture.md §2.1, §4.8): runs the fallback chain
 * from the pinned hosting, then wraps the connected port in the public
 * client. Zero DOM access at module top level.
 */

import { ConfigError, TscacheError } from "../errors";
import type { PortClient } from "../rpc/port-client";
import { type Evt, type FetcherConfig, LIB_VERSION } from "../rpc/protocol";
import type {
  CacheConfig,
  ClientEvents,
  ClientOptions,
  HostingMode,
  MemoryStats,
  ResolvedCacheConfig,
  WorkerFeature,
} from "../types";
import { CacheHandle } from "./cache";
import { ChangeSubscriptions } from "./changes";
import { noteSuperseded, warnBudget, warnMerges, warnWorkerLib } from "./dev";
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
  /**
   * The optional features this client's worker offers (N79): empty for a
   * worker script from before them (a stale cached script during a deploy).
   * Without `'cacheChanged'`, its listeners are never called.
   */
  readonly features: ReadonlySet<WorkerFeature>;
  /**
   * Set once a worker of a newer generation of this application (another
   * tscache version, fetcher module or worker build) is running in the
   * origin (N113): `lib` is that worker's tscache version. This tab's worker
   * no longer persists; the tab keeps working from memory and its fetcher,
   * and a reload joins the newer worker. Undefined until then. The
   * `superseded` event fires when it is set; read this in code that may
   * run after the event. A worker reports it only when
   * `client.features.has('superseded')`.
   */
  readonly superseded: ClientEvents["superseded"] | undefined;
  /** Get-or-create (N4). */
  cache(config: CacheConfig): Promise<CacheHandle>;
  /**
   * Empties every cache; in SharedWorker mode this affects ALL tabs. Where
   * the browser has IndexedDB it also empties the persisted records, from
   * any hosting (N54, N66), and resolves once the disk is empty or the
   * clear gave up at its deadline; it never rejects for a disk failure.
   * It also reaches the other SharedWorkers of the origin (N116), which
   * clear their caches and the disk too; the promise does not wait for
   * them. Their tabs hear `cacheCleared`, possibly more than once.
   */
  clearAll(): Promise<void>;
  /** Delivers new auth material to the fetcher (step ⑪). */
  updateAuth(context: unknown): Promise<void>;
  /**
   * What the worker's caches hold now (§2.9): the budget in force, the
   * bytes the cached points hold, the pinned part, the pages evicted so far
   * and one entry per cache. In a SharedWorker it covers every tab's
   * caches. Rejects with TscacheError against a worker that does not offer
   * memory budgets (`client.features.has('memoryBudget')` is false).
   */
  memoryStats(): Promise<MemoryStats>;
  /**
   * Events, including workerLost (N32): the worker behind this client is
   * gone, every pending and later call rejects, and a new client is needed.
   * A `cacheChanged` listener here hears every cache's changes; the first
   * one subscribes this client to them and the last one's removal ends it.
   */
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
  memoryBudget: number | undefined;
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

/** A positive safe integer, as the engine takes it (§2.9). */
function budgetOf(options: ClientOptions): number | undefined {
  const budget = options.memoryBudget;
  if (budget === undefined) return undefined;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new ConfigError(
      "memoryBudget must be a positive safe integer of bytes",
    );
  }
  return budget;
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
    memoryBudget: budgetOf(options),
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
  readonly features: ReadonlySet<WorkerFeature>;
  readonly #hosting: Hosting;
  readonly #port: PortClient;
  readonly #events = new ClientEmitter();
  readonly #changes: ChangeSubscriptions;
  /** client.on cacheChanged listeners, each with its subscription's release. */
  readonly #changeListeners = new Map<
    (payload: ClientEvents["cacheChanged"]) => void,
    () => void
  >();
  /** Why calls reject from now on: disposed, or the worker was lost. */
  #ended: string | undefined;
  #superseded: ClientEvents["superseded"] | undefined;

  constructor(hosting: Hosting, fallbacks: ClientEvents["modeFallback"][]) {
    this.#hosting = hosting;
    this.#port = hosting.client;
    this.mode = hosting.mode;
    this.features = this.#port.features;
    this.#changes = new ChangeSubscriptions(this.#port);
    // A worker script of another library version (N117): development only.
    warnWorkerLib(LIB_VERSION, this.#port.lib);
    this.#port.on((evt) => {
      this.#warnFetched(evt);
      if (evt.scope === "client" && evt.event === "superseded") {
        this.#supersede(evt);
      } else this.#events.receive(evt);
    });
    this.#port.onLost((error) => this.#lose(error));
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

  get superseded(): ClientEvents["superseded"] | undefined {
    return this.#superseded;
  }

  /**
   * The worker is superseded (N113): the property is set before the
   * listeners run, and only the first event counts.
   */
  #supersede(evt: Evt): void {
    if (this.#superseded !== undefined) return;
    const payload = evt.payload as Partial<ClientEvents["superseded"]> | null;
    const lib = typeof payload?.lib === "string" ? payload.lib : "";
    this.#superseded = { lib };
    noteSuperseded(lib, this.#port.lib);
    this.#events.receive({ ...evt, payload: this.#superseded });
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
    return new CacheHandle(
      resolved.id,
      this.#port,
      this.#events,
      this.#changes,
    );
  }

  async clearAll(): Promise<void> {
    this.#live();
    await this.#port.request("clearAll", {});
  }

  async updateAuth(context: unknown): Promise<void> {
    this.#live();
    await this.#port.request("updateAuth", { context });
  }

  async memoryStats(): Promise<MemoryStats> {
    this.#live();
    if (!this.features.has("memoryBudget")) {
      throw new TscacheError(
        "memoryStats: this client's worker does not offer memory budgets (an older worker script?)",
      );
    }
    return (await this.#port.request("memoryStats", {})) as MemoryStats;
  }

  on<E extends keyof ClientEvents>(
    event: E,
    fn: (payload: ClientEvents[E]) => void,
  ): () => void {
    const off = this.#events.on(event, fn);
    if (event !== "cacheChanged") return off;
    const listener = fn as (payload: ClientEvents["cacheChanged"]) => void;
    // As the emitter: a listener registered twice is one listener.
    if (!this.#changeListeners.has(listener)) {
      this.#changeListeners.set(listener, this.#changes.hold({ all: true }));
    }
    return () => this.off(event, fn);
  }

  off<E extends keyof ClientEvents>(
    event: E,
    fn: (payload: ClientEvents[E]) => void,
  ): void {
    this.#events.off(event, fn);
    if (event !== "cacheChanged") return;
    const listener = fn as (payload: ClientEvents["cacheChanged"]) => void;
    const release = this.#changeListeners.get(listener);
    if (release === undefined) return;
    this.#changeListeners.delete(listener);
    release();
  }

  async dispose(): Promise<void> {
    if (this.#ended !== undefined) return;
    this.#ended = "client disposed";
    this.#unlistenPage();
    this.#port.dispose();
    this.#hosting.terminate();
  }

  /**
   * The transport failed underneath (N32): the port has already rejected
   * what was pending. Release what this client owns, as dispose() would,
   * then tell the page once.
   */
  #lose(error: TscacheError): void {
    if (this.#ended !== undefined) return;
    this.#ended = error.message;
    this.#unlistenPage();
    this.#hosting.terminate();
    try {
      this.#events.emit("workerLost", { reason: error.message });
    } catch (failure) {
      // Raised inside a port or lock callback, where nobody awaits it.
      report(failure);
    }
  }

  /**
   * Decision #8 for orchestrated fetches, whose warnings reach the page only
   * as events: the tab whose get started the fetch prints each one. Other
   * tabs' requests are theirs to print, and a put prints from its result.
   */
  #warnFetched(evt: Evt): void {
    if (evt.scope !== "request" || evt.event !== "mergeWarning") return;
    const own = `${this.#port.clientId}:`;
    if (!evt.requestId.startsWith(own)) return;
    const id = Number(evt.requestId.slice(own.length));
    if (this.#port.pendingOp(id) === "put") return;
    const { cacheId, range, fields } =
      evt.payload as ClientEvents["mergeWarning"];
    warnMerges(cacheId, [{ range, fields }], "fetch");
  }

  #live(): void {
    if (this.#ended !== undefined) throw new TscacheError(this.#ended);
  }
}

/**
 * Sends the budget once after `init-ok` (§2.9, N101): the answer is the
 * budget in force, and a development build warns when it is not this one.
 * A worker without the feature is sent nothing.
 */
async function applyBudget(port: PortClient, bytes: number): Promise<void> {
  if (!port.features.has("memoryBudget")) {
    warnBudget(bytes, "unsupported");
    return;
  }
  const answer = (await port.request("memoryBudget", { bytes })) as {
    budget?: number;
  };
  if (answer?.budget !== bytes) warnBudget(bytes, answer?.budget);
}

/**
 * §2.1. Resolves once a hosting completed the handshake and, with a
 * `memoryBudget`, once the worker answered it (§2.9). The budget goes out
 * on the port before the client exists: the client queues the fallback
 * steps on a timer when it is built, which must run after the caller holds
 * it. A failed budget op releases the port and the hosting, and rethrows.
 */
export async function createClient(
  options: ClientOptions = {},
): Promise<TscacheClient> {
  const r = resolve(options);
  const fallbacks: ClientEvents["modeFallback"][] = [];
  const hosting = await connect(r, fallbacks);
  if (r.memoryBudget !== undefined) {
    try {
      await applyBudget(hosting.client, r.memoryBudget);
    } catch (error) {
      hosting.client.dispose();
      hosting.terminate();
      throw error;
    }
  }
  return new Client(hosting, fallbacks);
}
