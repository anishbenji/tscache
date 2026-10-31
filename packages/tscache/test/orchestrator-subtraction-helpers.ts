import { expect } from "vitest";
import { Engine } from "../src/engine/engine";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { PortClient } from "../src/rpc/port-client";
import type { Evt, MessagePortLike } from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type {
  CacheConfig,
  FetchRequest,
  FetchResponse,
  GetOptions,
  GetResult,
  Miss,
  Range,
} from "../src/types";

export const range = (start: number, end: number): Range => ({ start, end });
export const config = {
  id: "n31",
  interval: 10,
  alignmentOffset: 3,
  fields: { price: "f64", volume: "i16" },
} as const;

function response(r: Range, value = 1, version?: string): FetchResponse {
  const timestamps: number[] = [];
  for (let t = r.start; t <= r.end; t += 10) timestamps.push(t);
  return {
    timestamps,
    fields: { price: timestamps, volume: timestamps.map(() => value) },
    ...(version ? { meta: { version } } : {}),
  };
}

export function complete(got: GetResult, r: Range): void {
  const expected = response(r).timestamps;
  expect(Array.from(got.timestamps)).toEqual(expected);
  expect(Array.from(got.fields.price ?? [])).toEqual(expected);
  expect(got.coverage).toEqual([r]);
  expect(got.misses).toEqual([]);
}

export function miss(
  start: number,
  end: number,
  reason: "uncached" | "fetch-failed" | "auth-pending",
  message?: string,
): Miss {
  return {
    range: range(start, end),
    reason,
    ...(message ? { error: { name: "Error", message } } : {}),
  };
}

export interface Call {
  request: FetchRequest;
  answer(version?: string): void;
  fail(error: unknown): void;
  respond(value: FetchResponse): void;
}

/** A fixture fetcher that delegates exclusively to test-controlled gates. */
const module = `data:text/javascript,${encodeURIComponent(`export default {
  fetch(req) { return globalThis.__n31.fetch(req); },
  updateAuth(context) { return globalThis.__n31.updateAuth(context); }
};`)}`;

export class Harness {
  readonly engine: Engine = new Engine();
  readonly calls: Call[] = [];
  readonly clients: PortClient[] = [];
  readonly events: Evt[][] = [];
  readonly server: RpcServer = new RpcServer(this.engine, "0.0.0");
  hook: (() => Promise<void>) | undefined;
  readonly cfg: CacheConfig;
  constructor(extra: Partial<CacheConfig> = {}) {
    this.cfg = { ...config, ...extra };
    (globalThis as unknown as { __n31: unknown }).__n31 = {
      fetch: (request: FetchRequest) =>
        new Promise<FetchResponse>((resolve, reject) => {
          const value = this.calls.length + 1;
          this.calls.push({
            request,
            answer: (version) =>
              resolve(response(request.range, value, version)),
            fail: reject,
            respond: resolve,
          });
        }),
      updateAuth: () => this.hook?.(),
    };
  }
  async connect(context?: unknown): Promise<PortClient> {
    const channel = new MessageChannel();
    this.server.attach(channel.port1 as MessagePortLike);
    const client = await PortClient.connect(channel.port2 as MessagePortLike, {
      fetcher: { module, ...(context === undefined ? {} : { context }) },
    });
    const seen: Evt[] = [];
    client.on((event) => seen.push(event));
    this.events.push(seen);
    this.clients.push(client);
    await client.request("cache", this.cfg);
    return client;
  }
  async direct(context?: unknown): Promise<Orchestrator> {
    this.engine.cache(this.cfg);
    const o = new Orchestrator(this.engine, () => {});
    await o.load({ module, context });
    return o;
  }
  get(
    client: PortClient,
    r: Range,
    options?: GetOptions,
  ): { promise: Promise<GetResult>; settled: () => boolean } {
    let settled = false;
    const promise = client.request("get", {
      cacheId: this.cfg.id,
      range: r,
      options,
    }) as Promise<GetResult>;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    return { promise, settled: () => settled };
  }
  /** FIFO port round trip: all earlier requests on this client have planned. */
  async turn(client: PortClient): Promise<void> {
    await client.request("get", {
      cacheId: this.cfg.id,
      range: range(3, 3),
      options: { cacheOnly: true },
    });
  }
  async put(client: PortClient, r: Range, version?: string): Promise<void> {
    await client.request("put", {
      cacheId: this.cfg.id,
      batch: response(r, 99, version),
      options: { range: r },
    });
  }
  invalidate(client: PortClient, r: Range): Promise<unknown> {
    return client.request("invalidate", { cacheId: this.cfg.id, range: r });
  }
  auth(client: PortClient, context: unknown): Promise<unknown> {
    return client.request("updateAuth", { context });
  }
  ranges(): Range[] {
    return this.calls.map((call) => call.request.range);
  }
  call(index: number): Call {
    const found = this.calls[index];
    if (!found)
      throw new Error(
        `no fetch ${index}; received ${JSON.stringify(this.ranges())}`,
      );
    return found;
  }
  async close(): Promise<void> {
    // Failed assertions must not strand ports or fetches in the runner.
    for (const client of this.clients) client.dispose();
    for (const call of this.calls) call.answer();
  }
}

export const authError = (): Error & { code: string } =>
  Object.assign(new Error("401"), { code: "tscache:auth-invalid" });
