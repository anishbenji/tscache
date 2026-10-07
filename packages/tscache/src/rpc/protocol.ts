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
  show,
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

/** Server → client: the server is dropping this port (controlled detach). */
export type Bye = { t: "bye" };

export type ToClient = Hello | InitResult | Res | Evt | Bye;
export type ToServer = Init | Req;

/** The port surface both MessagePort and a worker global satisfy. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void;
  start?(): void;
  close?(): void;
}

/**
 * Subscribes to a port's messages and its closure together, and returns the
 * one function that removes both: lifecycle handling on either side of the
 * wire goes through here, so a listener is never left behind.
 */
export function listen(
  port: MessagePortLike,
  handlers: { onMessage(data: unknown): void; onClose(): void },
): () => void {
  const onMessage = (event: { data?: unknown }) =>
    handlers.onMessage(event.data);
  const onClose = () => handlers.onClose();
  port.addEventListener("message", onMessage);
  port.addEventListener("close", onClose);
  port.start?.();
  return () => {
    port.removeEventListener("message", onMessage);
    port.removeEventListener("close", onClose);
  };
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

/** The §2.6 classes by their stable wire names; most specific first. */
const WIRE_CLASSES: [string, new (...args: never[]) => Error][] = [
  ["PutError", PutError],
  ["ProtocolMismatchError", ProtocolMismatchError],
  ["ConfigError", ConfigError],
  ["InvalidRangeError", InvalidRangeError],
  ["UnknownCacheError", UnknownCacheError],
  ["AuthInvalidError", AuthInvalidError],
  ["TscacheError", TscacheError],
];

/**
 * The name an error travels under: the stable wire name of its §2.6 class,
 * decided by instanceof, since a minifier may rename the constructor and
 * with it `error.name`. Other errors keep their own name.
 */
function wireNameOf(error: Error): string {
  for (const [name, cls] of WIRE_CLASSES) {
    if (error instanceof cls) return name;
  }
  return error.name;
}

/** Error → WireError. Any value can be thrown; non-errors become messages. */
export function toWireError(error: unknown): WireError {
  // show() never calls the value's own conversion, which can throw.
  if (!(error instanceof Error)) {
    return { name: "Error", message: show(error) };
  }
  // A message that is not a string (a hostile object) must not reach the
  // wire as is: it may clone yet throw on conversion at the other end.
  const message =
    typeof error.message === "string" ? error.message : show(error.message);
  const wire: WireError = { name: wireNameOf(error), message };
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

/** A wire error with every field forced to the type the wire promises. */
function normalized(input: WireError): WireError {
  const wire: WireError = {
    name: typeof input?.name === "string" ? input.name : "Error",
    message:
      typeof input?.message === "string" ? input.message : show(input?.message),
  };
  if (typeof input?.code === "string") wire.code = input.code;
  if (input?.data !== undefined) wire.data = input.data;
  return wire;
}

function rebuildPutError(wire: WireError): PutError {
  const data = (wire.data ?? {}) as Partial<PutErrorData>;
  const opts: ConstructorParameters<typeof PutError>[1] = {
    code: wire.code as PutErrorCode,
    offenderIndex: data.offenderIndex ?? -1,
  };
  if (data.offenderTimestamp !== undefined) {
    opts.offenderTimestamp = data.offenderTimestamp;
  }
  if (data.expected !== undefined) opts.expected = data.expected;
  return new PutError(wire.message, opts);
}

function rebuildProtocolError(wire: WireError): ProtocolMismatchError {
  const data = (wire.data ?? {}) as Partial<ProtocolData>;
  return new ProtocolMismatchError(wire.message, {
    clientProtocol: data.clientProtocol ?? Number.NaN,
    workerProtocol: data.workerProtocol ?? Number.NaN,
  });
}

/** Rebuilders by wire name; the message-only classes share one shape. */
const REBUILDERS: Record<string, (wire: WireError) => TscacheError> = {
  PutError: rebuildPutError,
  ProtocolMismatchError: rebuildProtocolError,
  ConfigError: (w) => new ConfigError(w.message),
  InvalidRangeError: (w) => new InvalidRangeError(w.message),
  UnknownCacheError: (w) => new UnknownCacheError(w.message),
  AuthInvalidError: (w) => new AuthInvalidError(w.message),
  TscacheError: (w) => new TscacheError(w.message),
};

/**
 * WireError → the §2.6 class with that name, fields restored. The peer may
 * be another bundle or a hostile page, so every field is normalized first;
 * an unknown name becomes a TscacheError that keeps the name in its message.
 */
export function fromWireError(input: WireError): TscacheError {
  const wire = normalized(input);
  const rebuild = Object.hasOwn(REBUILDERS, wire.name)
    ? REBUILDERS[wire.name]
    : undefined;
  if (rebuild === undefined) {
    return new TscacheError(`${wire.name}: ${wire.message}`);
  }
  return rebuild(wire);
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
