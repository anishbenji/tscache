/**
 * Worker-side RPC shell (docs/architecture.md §3, §4.7): one Engine, any
 * number of ports. Each port gets a hello with its clientId, must answer
 * with a matching init, and from then on its requests are dispatched to the
 * engine while events fan out to every ready port.
 */

import type { ReaderChange } from "../engine/cache";
import { type Engine, observeCaches } from "../engine/engine";
import { ProtocolMismatchError, show, TscacheError } from "../errors";
import { toMs } from "../grid";
import { Orchestrator } from "../orchestrator/orchestrator";
import type {
  CacheConfig,
  ClientEvents,
  GetOptions,
  GetResult,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
  Snapshot,
} from "../types";
import {
  type Bye,
  type Evt,
  type FetcherConfig,
  type Hello,
  type InitResult,
  listen,
  type MessagePortLike,
  type Op,
  PROTOCOL_VERSION,
  type Req,
  type Res,
  type ToClient,
  type ToServer,
  toWireError,
  transferablesOf,
  type WireError,
  WORKER_FEATURES,
} from "./protocol";

interface Connection {
  port: MessagePortLike;
  clientId: string;
  ready: boolean;
  /** Removes the port's message and close listeners. */
  unlisten: () => void;
}

/** What a request may carry; the engine validates the values. */
interface Params {
  cacheId?: string;
  range?: Range;
  batch?: PutBatch;
  options?: PutOptions & GetOptions;
  t?: number;
  context?: unknown;
  snapshot?: Snapshot;
  all?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * What a subscribe or unsubscribe names (N74): a cache id, or undefined
 * for every cache. Anything but `{ cacheId: string }` or `{ all: true }`
 * throws TscacheError.
 */
function subscriptionOf(p: Params, op: string): string | undefined {
  if (p.all === true && p.cacheId === undefined) return undefined;
  if (typeof p.cacheId === "string" && p.all === undefined) return p.cacheId;
  throw new TscacheError(
    `${op}: params must be { cacheId: string } or { all: true }`,
  );
}

/** The public RequestId of a connection's request (§2.7). */
function idOf(connection: Connection, req: Req): string {
  return `${connection.clientId}:${req.id}`;
}

/**
 * The hosting's persistence, as the server uses it (§4.10.8): in the
 * SharedWorker `persist/hosted.ts`, which loads the persister lazily; in
 * the dedicated-worker and in-process hostings, where the realm has
 * IndexedDB, `persist/clear-only.ts`, which persists nothing and only
 * empties the disk at `clearAll` (§4.10.7, N66). Without one, `clearAll`
 * clears memory only.
 */
export interface Persistence {
  /** Starts persisting a cache; settles once its load has settled. */
  open(cacheId: string): Promise<void>;
  /**
   * Runs an op that names a cache. When it recorded a removal, or another
   * op did meanwhile, it answers, success or failure, only once that
   * removal is durable or the cache's persistence stopped (N58).
   */
  durably(cacheId: string, op: () => unknown): unknown;
  /**
   * Empties every cache and the disk in one synchronous step (N54);
   * answers once the disk is empty or the clear failed (in the SharedWorker,
   * every persisted cache has then stopped; N66 for the other hostings).
   * `clearMemory` empties the caches (default `Engine.clearAll`): the
   * server passes its own, so a deferred clear still names its request.
   */
  clearAll(clearMemory?: () => void): unknown;
  /** The last connection went: writes what the debounce still holds. */
  flush(): void;
}

export class RpcServer {
  readonly #engine: Engine;
  readonly #orchestrator: Orchestrator;
  readonly #lib: string;
  readonly #lock: string | undefined;
  readonly #persistence: Persistence | undefined;
  readonly #connections = new Set<Connection>();
  #nextClient = 0;
  /** Per cache, the connections subscribed to its cacheChanged (N74). */
  readonly #readers = new Map<string, Set<Connection>>();
  /** The connections subscribed to every cache's cacheChanged. */
  readonly #allReaders = new Set<Connection>();
  /** The request whose engine call is running: what caused a change (N75). */
  #cause: string | undefined;

  /**
   * `lock`: the Web Lock the worker holds for its lifetime, sent in hello
   * (N32). `persistence`: the SharedWorker hosting's persister (§4.10.8),
   * or in the dedicated-worker and in-process hostings the clear-only
   * `ClearOnlyPersistence` (N66), which persists nothing and only empties
   * the disk at `clearAll`; without one, `persist: true` does nothing and
   * every op answers as before persistence.
   */
  constructor(
    engine: Engine,
    lib: string,
    lock?: string,
    persistence?: Persistence,
  ) {
    this.#engine = engine;
    this.#lib = lib;
    this.#lock = lock;
    this.#persistence = persistence;
    this.#orchestrator = new Orchestrator(
      engine,
      (evt) => this.#broadcast(evt),
      (requestId, call) => this.#caused(requestId, call),
    );
    observeCaches(engine, {
      onChange: () => {},
      onMutate: () => {},
      hasReaders: (cacheId) =>
        this.#allReaders.size > 0 || this.#readers.has(cacheId),
      onReaderChange: (cacheId, change) => this.#changed(cacheId, change),
    });
    engine.on("cacheCleared", (payload) => {
      this.#broadcast({
        t: "evt",
        scope: "cache",
        cacheId: payload.cacheId,
        event: "cacheCleared",
        payload,
      });
    });
  }

  /** Starts the handshake on a port. */
  attach(port: MessagePortLike): void {
    const connection: Connection = {
      port,
      clientId: `c${++this.#nextClient}`,
      ready: false,
      unlisten: () => {},
    };
    connection.unlisten = listen(port, {
      onMessage: (data) => this.#receive(connection, data),
      // The peer closed (client disposed, tab gone): forget it quietly.
      onClose: () => this.#drop(connection, false),
    });
    this.#connections.add(connection);
    const hello: Hello = {
      t: "hello",
      protocol: PROTOCOL_VERSION,
      lib: this.#lib,
      clientId: connection.clientId,
      features: [...WORKER_FEATURES],
    };
    if (this.#lock !== undefined) hello.lock = this.#lock;
    this.#send(connection, hello);
  }

  /**
   * Tells every ready port that a cache's persistence stopped (§4.10.8):
   * the persistence's `onStopped`.
   */
  persistStopped(payload: ClientEvents["persistStopped"]): void {
    this.#broadcast({
      t: "evt",
      scope: "cache",
      cacheId: payload.cacheId,
      event: "persistStopped",
      payload,
    });
  }

  /** Attached ports still alive (for tests and diagnostics). */
  get connections(): number {
    return this.#connections.size;
  }

  detach(port: MessagePortLike): void {
    for (const connection of this.#connections) {
      if (connection.port === port) this.#drop(connection);
    }
  }

  /**
   * Forgets a connection. `notify` posts a bye first, for a controlled
   * detach: a browser MessagePort fires no close event, so the client would
   * otherwise never learn that its pending requests are orphaned.
   */
  #drop(connection: Connection, notify = true): void {
    if (!this.#connections.delete(connection)) return;
    this.#unsubscribeAll(connection);
    if (notify) {
      try {
        connection.port.postMessage({ t: "bye" } satisfies Bye);
      } catch {
        // The port is already gone; nothing to tell.
      }
    }
    connection.unlisten();
    connection.port.close?.();
    // The last tab is gone: write what the debounce still holds (§4.10.8).
    if (this.#connections.size === 0) this.#persistence?.flush();
  }

  /**
   * Posts a message. A message that cannot be cloned is answered, when it
   * was a response, with a plain generic error that always can be; if even
   * that fails, the port is unusable and is dropped.
   */
  #send(
    connection: Connection,
    message: ToClient,
    transfer: Transferable[] = [],
  ): void {
    try {
      connection.port.postMessage(message, transfer);
    } catch (error) {
      if (message.t !== "res") return;
      const fallback: Res = {
        t: "res",
        id: message.id,
        ok: false,
        error: {
          name: "Error",
          message: `reply could not be sent: ${show(error)}`,
        },
      };
      try {
        connection.port.postMessage(fallback);
      } catch {
        this.#drop(connection);
      }
    }
  }

  #receive(connection: Connection, data: unknown): void {
    if (!isObject(data)) return;
    const message = data as ToServer;
    if (message.t === "init") {
      void this.#init(connection, message.protocol, message.fetcher);
      return;
    }
    if (message.t === "req") void this.#request(connection, message);
  }

  async #init(
    connection: Connection,
    protocol: number,
    fetcher: FetcherConfig | undefined,
  ): Promise<void> {
    if (protocol !== PROTOCOL_VERSION) {
      const error = new ProtocolMismatchError(
        `client speaks protocol ${show(protocol)}, worker speaks ${PROTOCOL_VERSION}`,
        {
          clientProtocol: typeof protocol === "number" ? protocol : Number.NaN,
          workerProtocol: PROTOCOL_VERSION,
        },
      );
      const reply: InitResult = { t: "init-err", error: toWireError(error) };
      this.#send(connection, reply);
      this.#drop(connection);
      return;
    }
    // A fetcher that fails to load is a startup error (N30).
    if (isObject(fetcher) && typeof fetcher.module === "string") {
      try {
        await this.#orchestrator.load(fetcher);
      } catch (error) {
        const reply: InitResult = { t: "init-err", error: toWireError(error) };
        this.#send(connection, reply);
        this.#drop(connection);
        return;
      }
    }
    if (!this.#connections.has(connection)) return;
    connection.ready = true;
    const reply: InitResult = { t: "init-ok" };
    this.#send(connection, reply);
  }

  async #request(connection: Connection, req: Req): Promise<void> {
    if (!connection.ready) {
      this.#reply(connection, req.id, new TscacheError("not initialized"));
      return;
    }
    let result: unknown;
    try {
      result = await this.#dispatch(connection, req);
    } catch (error) {
      this.#reply(connection, req.id, error);
      return;
    }
    // The port may have gone while an orchestrated get was in flight.
    if (!this.#connections.has(connection)) return;
    const res: Res = { t: "res", id: req.id, ok: true, result };
    const transfer =
      req.op === "get" ? transferablesOf(result as GetResult) : [];
    this.#send(connection, res, transfer);
    // The acknowledgement must leave before the port goes.
    if (req.op === "dispose") this.#drop(connection);
  }

  /** Every request is answered, whatever the error looks like. */
  #reply(connection: Connection, id: number, error: unknown): void {
    let wire: WireError;
    try {
      wire = toWireError(error);
    } catch {
      wire = { name: "Error", message: "unserializable error" };
    }
    this.#send(connection, { t: "res", id, ok: false, error: wire });
  }

  /** One op, one engine call; the engine validates every value. */
  #dispatch(connection: Connection, req: Req): unknown {
    // Own properties only: "toString" is not an op.
    if (typeof req.op !== "string" || !Object.hasOwn(this.#handlers, req.op)) {
      throw new TscacheError(`unknown op ${show(req.op)}`);
    }
    const handler = this.#handlers[req.op as Op];
    const p = (isObject(req.params) ? req.params : {}) as Params;
    return handler(connection, req, p);
  }

  readonly #handlers: Record<
    Op,
    (connection: Connection, req: Req, p: Params) => unknown
  > = {
    cache: (_c, req) => this.#cache(req.params as CacheConfig),
    get: (c, req, p) =>
      this.#durably(p.cacheId, () =>
        this.#orchestrator.get(
          p.cacheId as string,
          p.range as Range,
          p.options,
          `${c.clientId}:${req.id}`,
        ),
      ),
    put: (c, req, p) =>
      this.#durably(p.cacheId, () =>
        this.#caused(idOf(c, req), () =>
          this.#put(c, req.id, p.cacheId as string, p),
        ),
      ),
    invalidate: (c, req, p) =>
      this.#durably(p.cacheId, () =>
        this.#caused(idOf(c, req), () =>
          this.#orchestrator.invalidate(p.cacheId as string, p.range as Range),
        ),
      ),
    clear: (c, req, p) =>
      this.#durably(p.cacheId, () =>
        this.#caused(idOf(c, req), () =>
          this.#engine.clear(p.cacheId as string),
        ),
      ),
    clearAll: (c, req) => this.#clearAll(idOf(c, req)),
    setFinalizedUntil: (c, req, p) =>
      this.#durably(p.cacheId, () =>
        this.#caused(idOf(c, req), () =>
          this.#engine.setFinalizedUntil(p.cacheId as string, p.t as number),
        ),
      ),
    hydrate: (c, req, p) =>
      this.#durably(p.cacheId, () =>
        this.#caused(idOf(c, req), () =>
          this.#engine.hydrate(p.cacheId as string, p.snapshot as Snapshot),
        ),
      ),
    updateAuth: (_c, _r, p) => this.#orchestrator.updateAuth(p.context),
    // They touch no data, so they never wait for the persistence.
    subscribe: (c, _r, p) => this.#subscribe(c, p, true),
    unsubscribe: (c, _r, p) => this.#subscribe(c, p, false),
    // Acknowledged first; #request detaches the port afterwards.
    dispose: () => undefined,
  };

  /**
   * Get-or-create; a persisted cache answers once its load settled, so no
   * call through a handle reaches a cache whose load is pending (§4.10.5).
   * `open` is called in the same synchronous step that creates the cache.
   */
  #cache(config: CacheConfig): unknown {
    const resolved = this.#engine.cache(config);
    const persistence = this.#persistence;
    if (persistence === undefined || !resolved.persist) return resolved;
    return persistence.open(resolved.id).then(() => resolved);
  }

  /** Runs an op that names a cache, through the persistence when there is one (N58). */
  #durably(cacheId: unknown, op: () => unknown): unknown {
    const persistence = this.#persistence;
    if (persistence === undefined || typeof cacheId !== "string") return op();
    return persistence.durably(cacheId, op);
  }

  /**
   * Empties every cache, and with persistence the disk (N54). The memory
   * clear runs under the request's id, also when the persistence defers it.
   */
  #clearAll(requestId: string): unknown {
    const clearMemory = () =>
      this.#caused(requestId, () => this.#engine.clearAll());
    const persistence = this.#persistence;
    return persistence === undefined
      ? clearMemory()
      : persistence.clearAll(clearMemory);
  }

  /** Runs an engine call with `requestId` as the cause of its changes. */
  #caused<T>(requestId: string | undefined, call: () => T): T {
    const outer = this.#cause;
    this.#cause = requestId;
    try {
      return call();
    } finally {
      this.#cause = outer;
    }
  }

  /**
   * subscribe / unsubscribe (N74): `{ cacheId }` or `{ all: true }`.
   * Idempotent; a connection holds each subscription at most once.
   */
  #subscribe(connection: Connection, p: Params, on: boolean): undefined {
    const cacheId = subscriptionOf(p, on ? "subscribe" : "unsubscribe");
    if (cacheId === undefined) {
      if (on) this.#allReaders.add(connection);
      else this.#allReaders.delete(connection);
      return undefined;
    }
    const readers = this.#readers.get(cacheId) ?? new Set<Connection>();
    if (on) readers.add(connection);
    else readers.delete(connection);
    if (readers.size === 0) this.#readers.delete(cacheId);
    else this.#readers.set(cacheId, readers);
    return undefined;
  }

  /** A dropped connection's subscriptions go with it. */
  #unsubscribeAll(connection: Connection): void {
    this.#allReaders.delete(connection);
    for (const [cacheId, readers] of this.#readers) {
      if (readers.delete(connection) && readers.size === 0) {
        this.#readers.delete(cacheId);
      }
    }
  }

  /**
   * One mutating call's reader change → one cacheChanged, in ms, to each
   * subscribed ready connection, once even if it holds both subscriptions.
   */
  #changed(cacheId: string, change: ReaderChange): void {
    const grid = this.#engine.configOf(cacheId);
    const payload: ClientEvents["cacheChanged"] = {
      cacheId,
      written: change.written.map((range) => toMs(range, grid)),
      removed: change.removed.map((range) => toMs(range, grid)),
      cleared: change.cleared,
    };
    if (this.#cause !== undefined) payload.requestId = this.#cause;
    const evt: Evt = {
      t: "evt",
      scope: "cache",
      cacheId,
      event: "cacheChanged",
      payload,
    };
    const targets = new Set(this.#allReaders);
    for (const connection of this.#readers.get(cacheId) ?? []) {
      targets.add(connection);
    }
    for (const connection of targets) {
      if (connection.ready) this.#send(connection, evt);
    }
  }

  /** put, then the request-scoped mergeWarning events (N21). */
  #put(
    connection: Connection,
    reqId: number,
    cacheId: string,
    p: Params,
  ): PutResult {
    const result = this.#engine.put(cacheId, p.batch as PutBatch, p.options);
    const requestId = `${connection.clientId}:${reqId}`;
    for (const warning of result.warnings) {
      this.#broadcast({
        t: "evt",
        scope: "request",
        cacheId,
        requestId,
        event: "mergeWarning",
        payload: { cacheId, requestId, ...warning },
      });
    }
    return result;
  }

  #broadcast(evt: Evt): void {
    for (const connection of [...this.#connections]) {
      if (connection.ready) this.#send(connection, evt);
    }
  }
}
