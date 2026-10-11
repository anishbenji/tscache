/**
 * Client-side port wrapper (docs/architecture.md §3, §4.7): completes the
 * handshake, correlates requests with responses, rebuilds errors and
 * re-emits events. The CacheHandle facade (step ⑩) sits on top.
 */

import { ProtocolMismatchError, show, TscacheError } from "../errors";
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
} from "./protocol";

interface Pending {
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

export class PortClient {
  readonly clientId: string;
  /** hello.lock: the worker's lifetime lock, when it holds one (N32). */
  readonly lock: string | undefined;
  readonly #port: MessagePortLike;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(evt: Evt) => void>();
  readonly #lostListeners = new Set<(error: TscacheError) => void>();
  readonly #unlisten: () => void;
  #seq = 0;
  /** Why requests reject from now on; set once by dispose or a loss. */
  #ended: string | undefined;

  private constructor(
    port: MessagePortLike,
    clientId: string,
    lock: string | undefined,
  ) {
    this.#port = port;
    this.clientId = clientId;
    this.lock = lock;
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
   */
  static connect(
    port: MessagePortLike,
    init: { fetcher?: FetcherConfig } = {},
    signal?: AbortSignal,
  ): Promise<PortClient> {
    return new Promise((resolve, reject) => {
      // hello first, then the init result: anything else is out of order.
      let stage: "hello" | "init" = "hello";
      let clientId = "";
      let lock: string | undefined;
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
          finish(
            new ProtocolMismatchError(
              `worker speaks protocol ${show(message.protocol)}, client speaks ${PROTOCOL_VERSION}`,
              {
                clientProtocol: PROTOCOL_VERSION,
                workerProtocol:
                  typeof message.protocol === "number"
                    ? message.protocol
                    : Number.NaN,
              },
            ),
          );
          return;
        }
        clientId = message.clientId;
        // Only a name can be queued on; anything else watches nothing.
        lock = typeof message.lock === "string" ? message.lock : undefined;
        stage = "init";
        const reply: Init = { t: "init", protocol: PROTOCOL_VERSION };
        if (init.fetcher !== undefined) reply.fetcher = init.fetcher;
        try {
          port.postMessage(reply);
        } catch (error) {
          // An uncloneable fetcher context cannot cross the port.
          finish(error);
        }
      };
      const onMessage = (data: unknown) => {
        const message = data as ToClient;
        if (!isObject(message)) return;
        if (message.t === "bye") {
          finish(new TscacheError("port closed during handshake"));
          return;
        }
        const expected =
          stage === "hello" ? message.t === "hello" : message.t !== "hello";
        if (!expected) {
          finish(
            new TscacheError(`handshake out of order: got ${show(message.t)}`),
          );
        } else if (message.t === "hello") {
          onHello(message);
        } else if (message.t === "init-ok") {
          signal?.removeEventListener("abort", onAbort);
          unlisten();
          resolve(new PortClient(port, clientId, lock));
        } else if (message.t === "init-err") {
          finish(fromWireError(message.error));
        }
      };
      unlisten = listen(port, {
        onMessage,
        onClose: () => finish(new TscacheError("port closed during handshake")),
      });
    });
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
      this.#pending.set(id, { resolve, reject });
      try {
        this.#port.postMessage(req, transfer);
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /** Receives every evt message as sent; returns the unsubscribe. */
  on(fn: (evt: Evt) => void): () => void {
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

  #receive(data: unknown): void {
    if (!isObject(data)) return;
    const message = data as ToClient;
    if (message.t === "res") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(rebuild(message.error));
    } else if (message.t === "evt") {
      for (const fn of [...this.#listeners]) fn(message);
    } else if (message.t === "bye") {
      // Controlled detach on the other side (no close event in browsers).
      this.#shutDown(new TscacheError("port closed"), true);
    }
  }
}
