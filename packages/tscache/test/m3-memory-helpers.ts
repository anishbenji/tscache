import { cacheStateOf, Engine } from "../src/engine/engine";
import { PortClient } from "../src/rpc/port-client";
import type { Evt, MessagePortLike, Req } from "../src/rpc/protocol";
import type { RpcServer } from "../src/rpc/server";
import type {
  CacheConfig,
  FetchRequest,
  FetchResponse,
  MemoryStats,
  PutBatch,
  Range,
} from "../src/types";

// Additive contracts from M3 §3.2/3.7/3.11. These adapters let tsc check
// the tests before the implementation exists, as persist-test-helpers does.
// They do not supply fallback behaviour: absent methods fail at runtime.
// Step 121 (implementer): Engine now takes the option and has
// memoryStats(), so the adapter is Engine itself, typed by src/types.
export const MemoryEngine: new (options?: {
  memoryBudget?: number;
}) => Engine & { memoryStats(): MemoryStats } = Engine;

export const PAGE_BYTES: number = 4 * 8 + 1;
export const whole: Range = { start: -64, end: 127 };
export function config(overrides: Partial<CacheConfig> = {}): CacheConfig {
  return {
    id: "a",
    interval: 1,
    fields: { value: "f64" },
    segmentSlotCap: 4,
    gapSplitK: 1,
    ...overrides,
  };
}
export function batch(
  timestamps: number[],
  values: number[] = timestamps,
  meta?: PutBatch["meta"],
): PutBatch {
  return {
    timestamps,
    fields: { value: values },
    ...(meta === undefined ? {} : { meta }),
  };
}
export function span(start: number, end: number = start): Range {
  return { start, end };
}
export function times(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}
export function restore(
  engine: Engine,
  cacheId: string,
  records: Parameters<ReturnType<typeof cacheStateOf>["restore"]>[0],
): void {
  cacheStateOf(engine, cacheId).restore(records);
}

/** A module-backed fetcher with a per-test handler, like orchestrator.test.ts.
 * A handler may await a deferred gate, never a timer. */
type Handler = (request: FetchRequest) => Promise<FetchResponse>;
interface FetchControl {
  handler: Handler;
  requests: FetchRequest[];
}
function control(): FetchControl {
  return (globalThis as unknown as { __m3Memory: FetchControl }).__m3Memory;
}
export const fetcherModule: string = `data:text/javascript,${encodeURIComponent(`
  export default { async fetch(request) {
    const control = globalThis.__m3Memory;
    control.requests.push(structuredClone(request));
    return control.handler(request);
  } };
`)}`;
export function fetching(
  handler: Handler = async ({ range }) => batch(times(range.start, range.end)),
): FetchRequest[] {
  const state: FetchControl = { handler, requests: [] };
  (globalThis as unknown as { __m3Memory: FetchControl }).__m3Memory = state;
  return control().requests;
}

export interface Wire {
  client: PortClient;
  events: Evt[];
  sent: Req[];
  close(): void;
}
export async function wire(
  server: RpcServer,
  fetcher: boolean = false,
): Promise<Wire> {
  const channel = new MessageChannel();
  const sent: Req[] = [];
  const port = channel.port2 as unknown as {
    postMessage(message: unknown, transfer?: Transferable[]): void;
  };
  const post = port.postMessage.bind(port);
  port.postMessage = (message, transfer) => {
    if ((message as { t?: string }).t === "req") sent.push(message as Req);
    post(message, transfer ?? []);
  };
  server.attach(channel.port1 as MessagePortLike);
  const client = await PortClient.connect(
    channel.port2 as MessagePortLike,
    fetcher ? { fetcher: { module: fetcherModule } } : {},
  );
  const events: Evt[] = [];
  client.on((event) => events.push(event));
  return {
    client,
    events,
    sent,
    close: () => {
      client.dispose();
      server.detach(channel.port1 as MessagePortLike);
      channel.port1.close();
      channel.port2.close();
    },
  };
}
export function send(
  wire: Wire,
  op: Req["op"],
  params: unknown,
): { answer: Promise<unknown>; requestId: string } {
  const before = wire.sent.length;
  const answer = wire.client.request(op, params);
  const request = wire.sent[before];
  if (request === undefined) throw new Error("request was not posted");
  return { answer, requestId: `${wire.client.clientId}:${request.id}` };
}
