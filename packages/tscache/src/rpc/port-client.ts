/**
 * Client-side port wrapper (docs/architecture.md §3, §4.7): completes the
 * handshake, correlates requests with responses, rebuilds errors and
 * re-emits events. The CacheHandle facade (step ⑩) sits on top.
 */

import { ProtocolMismatchError, show, TscacheError } from "../errors";
import type { WorkerFeature } from "../types";
import {
  type Evt,
  type FetcherConfig,
  fromWireError,
  type Hello,
  type Init,
  listen,
  type MessagePortLike,
  type Op,
  PROTOCOL_VERSION,
  type Req,
  type ToClient,
  WORKER_FEATURES,
} from "./protocol";

interface Pending {
  op: Op;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** An error reply always becomes an error, however malformed it arrived. */
function rebuild(wire: unknown): TscacheError {
  try {
    return fromWireError(wire as never);
  } catch {
    return new TscacheError("malformed error reply");
  }
}

/** The refusal of a hello whose protocol is not this client's. */
function protocolMismatch(protocol: unknown): ProtocolMismatchError {
  return new ProtocolMismatchError(
    `worker speaks protocol ${show(protocol)}, client speaks ${PROTOCOL_VERSION}`,
    {
      clientProtocol: PROTOCOL_VERSION,
      workerProtocol: typeof protocol === "number" ? protocol : Number.NaN,
    },
  );
}

/**
 * The features of a hello this client knows (N79): names it does not know
 * are ignored, and a malformed field counts as none.
 */
function featuresOf(features: unknown): ReadonlySet<WorkerFeature> {
  if (!Array.isArray(features)) return new Set();
  return new Set(
    WORKER_FEATURES.filter((feature) => features.includes(feature)),
  );
}

/** The init answering an accepted hello, with the fetcher config if any. */
function initReply(init: { fetcher?: FetcherConfig }): Init {
  const reply: Init = { t: "init", protocol: PROTOCOL_VERSION };
  if (init.fetcher !== undefined) reply.fetcher = init.fetcher;
  return reply;
}

/** What the handshake does with each message `handshakeStep` accepts. */
interface HandshakeSteps {
  hello: (message: Hello) => void;
  ok: () => void;
  fail: (error: unknown) => void;
}

/**
 * Takes one handshake message in `stage`: hello first, then the init
 * result. A bye fails the handshake at any stage, and so does anything out
 * of order; a message that is not an object is ignored.
 */
function handshakeStep(
  data: unknown,
  stage: "hello" | "init",
  steps: HandshakeSteps,
): void {
  const message = data as ToClient;
  if (!isObject(message)) return;
  if (message.t === "bye") {
    steps.fail(new TscacheError("port closed during handshake"));
    return;
  }
  const expected =
    stage === "hello" ? message.t === "hello" : message.t !== "hello";
  if (!expected) {
    steps.fail(
      new TscacheError(`handshake out of order: got ${show(message.t)}`),
    );
  } else if (message.t === "hello") {
    steps.hello(message);
  } else if (message.t === "init-ok") {
    steps.ok();
  } else if (message.t === "init-err") {
    steps.fail(fromWireError(message.error));
  }
}

export class PortClient {
  readonly clientId: string;
  /** hello.lock: the worker's lifetime lock, when it holds one (N32). */
  readonly lock: string | undefined;
  /** hello.features this client knows (N79); empty for an older worker. */
  readonly features: ReadonlySet<WorkerFeature>;
  /**
   * hello.lib, the worker script's library version, when it is a string
   * (N136). The handshake never acts on it.
   */
  readonly lib: string | undefined;
  readonly #port: MessagePortLike;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(evt: Evt) => void>();
  readonly #lostListeners = new Set<(error: TscacheError) => void>();
  readonly #unlisten: () => void;
  #seq = 0;
  /** Why requests reject from now on; set once by dispose or a loss. */
  #ended: string | undefined;
  /** Events received before `takeKept`, in port order; undefined after it. */
  #kept: Evt[] | undefined = [];
  /** Runs once, before the next res or evt received (see `takeKept`). */
  #beforeNext: (() => void) | undefined;

  private constructor(
    port: MessagePortLike,
    clientId: string,
    lock: string | undefined,
    features: ReadonlySet<WorkerFeature>,
    lib: string | undefined,
  ) {
    this.#port = port;
    this.clientId = clientId;
    this.lock = lock;
    this.features = features;
    this.lib = lib;
    this.#unlisten = listen(port, {
      onMessage: (data) => this.#receive(data),
      // The other side went away (worker died, server detached): nothing
      // pending can be answered any more.
      onClose: () => this.#shutDown(new TscacheError("port closed"), true),
    });
  }

  /**
   * Waits for hello, checks the protocol, sends init and waits for its
   * answer. Rejects with ProtocolMismatchError when either side refuses,
   * and with TscacheError when the port closes or misbehaves meanwhile.
   * `afterHello` runs once a hello with this protocol arrives, before init is
   * sent, with `hello.lock`: the hosting stops its handshake timer there
   * (N25) and starts watching the worker's lifetime lock (N32).
   */
  static connect(
    port: MessagePortLike,
    init: { fetcher?: FetcherConfig } = {},
    signal?: AbortSignal,
    afterHello?: (lock: string | undefined) => void,
  ): Promise<PortClient> {
    return new Promise((resolve, reject) => {
      // hello first, then the init result: anything else is out of order.
      let stage: "hello" | "init" = "hello";
      let clientId = "";
      let lock: string | undefined;
      let features: ReadonlySet<WorkerFeature> = new Set();
      let lib: string | undefined;
      let unlisten = () => {};
      // Cancelled by the caller (handshake timeout, worker error): stop
      // listening and close this side's port, so a late hello completes
      // nothing. Declared before the aborted check so cleanup always runs.
      const onAbort = () =>
        finish(signal?.reason ?? new TscacheError("handshake aborted"));
      const finish = (error: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        unlisten();
        port.close?.();
        reject(error);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      const onHello = (message: Hello) => {
        if (message.protocol !== PROTOCOL_VERSION) {
          finish(protocolMismatch(message.protocol));
          return;
        }
        clientId = message.clientId;
        // Only a name can be queued on; anything else watches nothing.
        lock = typeof message.lock === "string" ? message.lock : undefined;
        features = featuresOf(message.features);
        // Kept for a development warning (N136); no value of it is refused.
        lib = typeof message.lib === "string" ? message.lib : undefined;
        stage = "init";
        afterHello?.(lock);
        try {
          port.postMessage(initReply(init));
        } catch (error) {
          // An uncloneable fetcher context cannot cross the port.
          finish(error);
        }
      };
      const steps: HandshakeSteps = {
        hello: onHello,
        ok: () => {
          signal?.removeEventListener("abort", onAbort);
          unlisten();
          resolve(new PortClient(port, clientId, lock, features, lib));
        },
        fail: finish,
      };
      unlisten = listen(port, {
        onMessage: (data) => handshakeStep(data, stage, steps),
        onClose: () => finish(new TscacheError("port closed during handshake")),
      });
    });
  }

  /**
   * Every event the worker sent on this port before this call, in port
   * order, as `features` is kept from the hello; keeping ends here. Events
   * arrive between `init-ok` and the client's construction (a `superseded`
   * event right after `init-ok` (N132), an `authInvalid` or `cacheCleared`
   * any tab caused), before anything listens: the client takes them when
   * it is built and delivers them (step 135, gate rounds 6 and 7). Keeping
   * also ends at the first `on` listener, so a port that is never taken
   * over holds nothing for long; later events reach only the listeners.
   * `beforeNext` runs once, when the next response or event arrives and
   * before it is handled (never for a bye), so the caller can deliver what
   * it took first and the port's order holds.
   */
  takeKept(beforeNext: () => void): Evt[] {
    const kept = this.#kept ?? [];
    this.#kept = undefined;
    this.#beforeNext = beforeNext;
    return kept;
  }

  /** Requests awaiting a response (for tests and diagnostics). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Sends a request; `transfer` moves the listed buffers to the worker.
   * Parameters that cannot be cloned reject here and leave nothing behind.
   * @public used by the client facade (step ⑩)
   */
  request(
    op: Op,
    params: unknown,
    transfer: ArrayBuffer[] = [],
  ): Promise<unknown> {
    if (this.#ended !== undefined) {
      return Promise.reject(new TscacheError(this.#ended));
    }
    const id = ++this.#seq;
    const req: Req = { t: "req", id, op, params };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { op, resolve, reject });
      try {
        this.#port.postMessage(req, transfer);
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /** The op of this client's request `id` while it awaits its response. */
  pendingOp(id: number): Op | undefined {
    return this.#pending.get(id)?.op;
  }

  /** Receives every evt message as sent; returns the unsubscribe. */
  on(fn: (evt: Evt) => void): () => void {
    this.#kept = undefined;
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Calls `fn` once when the transport fails underneath (abort, port
   * closed, bye), after pending requests were rejected; never after
   * dispose(). Returns the unsubscribe.
   */
  onLost(fn: (error: TscacheError) => void): () => void {
    this.#lostListeners.add(fn);
    return () => this.#lostListeners.delete(fn);
  }

  /**
   * Releases the port; pending requests reject. Idempotent.
   * @public used by the client facade (step ⑩)
   */
  dispose(): void {
    if (this.#ended !== undefined) return;
    // Tell the server first: a dedicated Worker has no close() to signal
    // with, so the server would otherwise keep this connection forever.
    const bye: Req = { t: "req", id: ++this.#seq, op: "dispose", params: {} };
    try {
      this.#port.postMessage(bye);
    } catch {
      // The port is already unusable; nothing more to tell.
    }
    this.#shutDown(new TscacheError("client disposed"), false);
  }

  /**
   * The transport failed underneath (a dedicated worker's fatal error, the
   * SharedWorker's lifetime lock granted): pending and later requests
   * reject with `error`'s message. Idempotent.
   * @public used by the hostings (step ⑩)
   */
  abort(error: TscacheError): void {
    this.#shutDown(error, true);
  }

  #shutDown(error: TscacheError, lost: boolean): void {
    if (this.#ended !== undefined) return;
    this.#ended = error.message;
    this.#unlisten();
    this.#port.close?.();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!lost) return;
    for (const fn of [...this.#lostListeners]) fn(error);
  }

  /** Keeps the event until the client takes over, then tells the listeners. */
  #event(evt: Evt): void {
    this.#kept?.push(evt);
    for (const fn of [...this.#listeners]) fn(evt);
  }

  #receive(data: unknown): void {
    if (!isObject(data)) return;
    const message = data as ToClient;
    if (message.t === "res" || message.t === "evt") {
      const before = this.#beforeNext;
      this.#beforeNext = undefined;
      before?.();
      // A listener there may have disposed the client: handle nothing more.
      if (this.#ended !== undefined) return;
    }
    if (message.t === "res") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(rebuild(message.error));
    } else if (message.t === "evt") {
      this.#event(message);
    } else if (message.t === "bye") {
      // Controlled detach on the other side (no close event in browsers).
      this.#shutDown(new TscacheError("port closed"), true);
    }
  }
}
