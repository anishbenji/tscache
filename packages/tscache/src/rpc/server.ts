/**
 * Worker-side RPC shell (docs/architecture.md §3, §4.7): one Engine, any
 * number of ports. Each port gets a hello with its clientId, must answer
 * with a matching init, and from then on its requests are dispatched to the
 * engine while events fan out to every ready port.
 */

import type { Engine } from "../engine/engine";
import { ProtocolMismatchError, show, TscacheError } from "../errors";
import type {
  GetResult,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
} from "../types";
import {
  type Bye,
  type Evt,
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
  options?: PutOptions;
  t?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class RpcServer {
  readonly #engine: Engine;
  readonly #lib: string;
  readonly #connections = new Set<Connection>();
  #nextClient = 0;

  constructor(engine: Engine, lib: string) {
    this.#engine = engine;
    this.#lib = lib;
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
    };
    this.#send(connection, hello);
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
    if (notify) {
      try {
        connection.port.postMessage({ t: "bye" } satisfies Bye);
      } catch {
        // The port is already gone; nothing to tell.
      }
    }
    connection.unlisten();
    connection.port.close?.();
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
      this.#init(connection, message.protocol);
      return;
    }
    if (message.t === "req") this.#request(connection, message);
  }

  #init(connection: Connection, protocol: number): void {
    if (protocol !== PROTOCOL_VERSION) {
      const error = new ProtocolMismatchError(
        `client speaks protocol ${protocol}, worker speaks ${PROTOCOL_VERSION}`,
        { clientProtocol: protocol, workerProtocol: PROTOCOL_VERSION },
      );
      const reply: InitResult = { t: "init-err", error: toWireError(error) };
      this.#send(connection, reply);
      this.#drop(connection);
      return;
    }
    connection.ready = true;
    const reply: InitResult = { t: "init-ok" };
    this.#send(connection, reply);
  }

  #request(connection: Connection, req: Req): void {
    if (!connection.ready) {
      this.#reply(connection, req.id, new TscacheError("not initialized"));
      return;
    }
    let result: unknown;
    try {
      result = this.#dispatch(connection, req);
    } catch (error) {
      this.#reply(connection, req.id, error);
      return;
    }
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
      throw new TscacheError(`unknown op ${String(req.op)}`);
    }
    const handler = this.#handlers[req.op as Op];
    const p = (isObject(req.params) ? req.params : {}) as Params;
    return handler(connection, req, p);
  }

  readonly #handlers: Record<
    Op,
    (connection: Connection, req: Req, p: Params) => unknown
  > = {
    cache: (_c, req) => this.#engine.cache(req.params as never),
    get: (_c, _r, p) => this.#engine.get(p.cacheId as string, p.range as Range),
    put: (c, req, p) => this.#put(c, req.id, p.cacheId as string, p),
    invalidate: (_c, _r, p) =>
      this.#engine.invalidate(p.cacheId as string, p.range as Range),
    clear: (_c, _r, p) => this.#engine.clear(p.cacheId as string),
    clearAll: () => this.#engine.clearAll(),
    setFinalizedUntil: (_c, _r, p) =>
      this.#engine.setFinalizedUntil(p.cacheId as string, p.t as number),
    // Delivered to the fetcher at step ⑪.
    updateAuth: () => undefined,
    // Acknowledged first; #request detaches the port afterwards.
    dispose: () => undefined,
  };

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
