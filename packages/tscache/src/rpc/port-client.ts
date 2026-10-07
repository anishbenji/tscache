/**
 * Client-side port wrapper (docs/architecture.md §3, §4.7): completes the
 * handshake, correlates requests with responses, rebuilds errors and
 * re-emits events. The CacheHandle facade (step ⑩) sits on top.
 */

import { ProtocolMismatchError, TscacheError } from "../errors";
import {
  type Evt,
  type FetcherConfig,
  fromWireError,
  type Init,
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

export class PortClient {
  readonly clientId: string;
  readonly #port: MessagePortLike;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(evt: Evt) => void>();
  readonly #onMessage: (event: { data: unknown }) => void;
  #seq = 0;
  #disposed = false;

  private constructor(port: MessagePortLike, clientId: string) {
    this.#port = port;
    this.clientId = clientId;
    this.#onMessage = (event) => this.#receive(event.data);
    port.addEventListener("message", this.#onMessage);
  }

  /**
   * Waits for hello, checks the protocol, sends init and waits for its
   * answer. Rejects with ProtocolMismatchError when either side refuses.
   */
  static connect(
    port: MessagePortLike,
    init: { fetcher?: FetcherConfig } = {},
  ): Promise<PortClient> {
    return new Promise((resolve, reject) => {
      let clientId: string | undefined;
      const onMessage = (event: { data: unknown }) => {
        const message = event.data as ToClient;
        if (!isObject(message)) return;
        if (message.t === "hello") {
          if (message.protocol !== PROTOCOL_VERSION) {
            finish(
              new ProtocolMismatchError(
                `worker speaks protocol ${message.protocol}, client speaks ${PROTOCOL_VERSION}`,
                {
                  clientProtocol: PROTOCOL_VERSION,
                  workerProtocol: message.protocol,
                },
              ),
            );
            return;
          }
          clientId = message.clientId;
          const reply: Init = { t: "init", protocol: PROTOCOL_VERSION };
          if (init.fetcher !== undefined) reply.fetcher = init.fetcher;
          port.postMessage(reply);
        } else if (message.t === "init-ok") {
          port.removeEventListener("message", onMessage);
          resolve(new PortClient(port, clientId ?? ""));
        } else if (message.t === "init-err") {
          finish(fromWireError(message.error));
        }
      };
      const finish = (error: unknown) => {
        port.removeEventListener("message", onMessage);
        port.close?.();
        reject(error);
      };
      port.addEventListener("message", onMessage);
      port.start?.();
    });
  }

  /**
   * Sends a request; `transfer` moves the listed buffers to the worker.
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
      this.#port.postMessage(req, transfer);
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
    this.#disposed = true;
    this.#port.removeEventListener("message", this.#onMessage);
    this.#port.close?.();
    const error = new TscacheError("client disposed");
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
      else pending.reject(fromWireError(message.error));
    } else if (message.t === "evt") {
      for (const fn of [...this.#listeners]) fn(message);
    }
  }
}
