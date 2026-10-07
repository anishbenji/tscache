/**
 * Wire format (docs/architecture.md §3.1–§3.2, §4.7): message types and the
 * helpers that carry errors and buffers across a port. No DOM references:
 * the same messages travel a browser MessagePort, a Node MessageChannel and
 * the in-process pair.
 */

import {
  AuthInvalidError,
  ConfigError,
  InvalidRangeError,
  ProtocolMismatchError,
  PutError,
  type PutErrorCode,
  TscacheError,
  UnknownCacheError,
} from "../errors";

export const PROTOCOL_VERSION = 1;

export type Op =
  | "cache"
  | "get"
  | "put"
  | "invalidate"
  | "clear"
  | "clearAll"
  | "setFinalizedUntil"
  | "updateAuth"
  | "dispose";

export interface WireError {
  name: string;
  message: string;
  code?: string;
  data?: unknown;
}

export interface FetcherConfig {
  module: string;
  context?: unknown;
}

export type Hello = {
  t: "hello";
  protocol: number;
  lib: string;
  clientId: string;
};
export type Init = { t: "init"; protocol: number; fetcher?: FetcherConfig };
export type InitResult = { t: "init-ok" } | { t: "init-err"; error: WireError };
export type Req = { t: "req"; id: number; op: Op; params: unknown };
export type Res =
  | { t: "res"; id: number; ok: true; result: unknown }
  | { t: "res"; id: number; ok: false; error: WireError };
export type Evt =
  | { t: "evt"; scope: "client"; event: string; payload: unknown }
  | {
      t: "evt";
      scope: "cache";
      cacheId: string;
      event: string;
      payload: unknown;
    }
  | {
      t: "evt";
      scope: "request";
      cacheId: string;
      requestId: string;
      event: string;
      payload: unknown;
    };

export type ToClient = Hello | InitResult | Res | Evt;
export type ToServer = Init | Req;

/** The port surface both MessagePort and a worker global satisfy. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  start?(): void;
  close?(): void;
}

interface PutErrorData {
  offenderIndex: number;
  offenderTimestamp?: number;
  expected?: string;
}

interface ProtocolData {
  clientProtocol: number;
  workerProtocol: number;
}

/** Error → WireError. Any value can be thrown; non-errors become messages. */
export function toWireError(error: unknown): WireError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const wire: WireError = { name: error.name, message: error.message };
  if (error instanceof PutError) {
    wire.code = error.code;
    const data: PutErrorData = { offenderIndex: error.offenderIndex };
    if (error.offenderTimestamp !== undefined) {
      data.offenderTimestamp = error.offenderTimestamp;
    }
    if (error.expected !== undefined) data.expected = error.expected;
    wire.data = data;
  } else if (error instanceof ProtocolMismatchError) {
    const data: ProtocolData = {
      clientProtocol: error.clientProtocol,
      workerProtocol: error.workerProtocol,
    };
    wire.data = data;
  } else if ("code" in error && typeof error.code === "string") {
    wire.code = error.code;
  }
  return wire;
}

/**
 * WireError → the §2.6 class with that name, fields restored. An unknown
 * name becomes a TscacheError that keeps the original name in its message.
 */
export function fromWireError(wire: WireError): TscacheError {
  switch (wire.name) {
    case "PutError": {
      const data = (wire.data ?? {}) as Partial<PutErrorData>;
      return new PutError(wire.message, {
        code: wire.code as PutErrorCode,
        offenderIndex: data.offenderIndex ?? -1,
        ...(data.offenderTimestamp !== undefined
          ? { offenderTimestamp: data.offenderTimestamp }
          : {}),
        ...(data.expected !== undefined ? { expected: data.expected } : {}),
      });
    }
    case "ProtocolMismatchError": {
      const data = (wire.data ?? {}) as Partial<ProtocolData>;
      return new ProtocolMismatchError(wire.message, {
        clientProtocol: data.clientProtocol ?? Number.NaN,
        workerProtocol: data.workerProtocol ?? Number.NaN,
      });
    }
    case "ConfigError":
      return new ConfigError(wire.message);
    case "InvalidRangeError":
      return new InvalidRangeError(wire.message);
    case "UnknownCacheError":
      return new UnknownCacheError(wire.message);
    case "AuthInvalidError":
      return new AuthInvalidError(wire.message);
    case "TscacheError":
      return new TscacheError(wire.message);
    default:
      return new TscacheError(`${wire.name}: ${wire.message}`);
  }
}

/** The distinct buffers behind a message's typed arrays, for the transfer list. */
export function transferablesOf(value: {
  timestamps?: ArrayBufferView | number[];
  fields?: Record<string, ArrayBufferView | number[]>;
}): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (view: ArrayBufferView | number[] | undefined) => {
    if (ArrayBuffer.isView(view) && view.buffer instanceof ArrayBuffer) {
      buffers.add(view.buffer);
    }
  };
  add(value.timestamps);
  if (value.fields !== undefined) {
    for (const view of Object.values(value.fields)) add(view);
  }
  return [...buffers];
}
