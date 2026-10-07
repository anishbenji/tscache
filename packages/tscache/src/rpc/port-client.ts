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
  readonly #port: MessagePortLike;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(evt: Evt) => void>();
  readonly #unlisten: () => void;
  #seq = 0;
  #disposed = false;

  private constructor(port: MessagePortLike, clientId: string) {
    this.#port = port;
    this.clientId = clientId;
    this.#unlisten = listen(port, {
      onMessage: (data) => this.#receive(data),
      // The other side went away (worker died, server detached): nothing
      // pending can be answered any more.
      onClose: () => this.#shutDown(new TscacheError("port closed")),
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
  ): Promise<PortClient> {
    return new Promise((resolve, reject) => {
      // hello first, then the init result: anything else is out of order.
      let stage: "hello" | "init" = "hello";
      let clientId = "";
      let unlisten = () => {};
      const finish = (error: unknown) => {
        unlisten();
        port.close?.();
        reject(error);
      };
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
          unlisten();
          resolve(new PortClient(port, clientId));
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
    if (this.#disposed) {
      return Promise.reject(new TscacheError("client disposed"));
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
   * Releases the port; pending requests reject. Idempotent.
   * @public used by the client facade (step ⑩)
   */
  dispose(): void {
    if (this.#disposed) return;
    // Tell the server first: a dedicated Worker has no close() to signal
    // with, so the server would otherwise keep this connection forever.
    const bye: Req = { t: "req", id: ++this.#seq, op: "dispose", params: {} };
    try {
      this.#port.postMessage(bye);
    } catch {
      // The port is already unusable; nothing more to tell.
    }
    this.#shutDown(new TscacheError("client disposed"));
  }

  #shutDown(error: TscacheError): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unlisten();
    this.#port.close?.();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
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
      this.#shutDown(new TscacheError("port closed"));
    }
  }
}
