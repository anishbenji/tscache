// The end-to-end scenarios' page (docs/benchmarking.md): bundled and served
// by scripts/bench-e2e.ts, which drives it from Chromium. It loads the
// package's client of each revision from the server (`/base/index.js`,
// `/head/index.js`), whose SharedWorkers fetch from the Playwright suites'
// mock backend through their fixture fetcher (e2e/pages/fetcher.js: price
// is the timestamp, volume how often the backend was asked for the range).
// Every operation checks what it read and throws on a wrong result, so a
// scenario cannot quietly stop doing its work.

import type * as Client from "../src/entries/index";
import type {
  CacheConfig,
  CacheHandle,
  ClientOptions,
  GetResult,
  Range,
  TscacheClient,
} from "../src/entries/index";
import {
  BARS,
  type E2ePage,
  type Once,
  type PageScenario,
  type Preparation,
  type Side,
} from "./e2e-api";
import { type AsyncOp, sampleAsync } from "./sample";

const INTERVAL = 60_000;
/** The first bar of the first read: a Monday. */
const T0 = Date.UTC(2026, 0, 5);

function config(id: string): CacheConfig {
  return { id, interval: INTERVAL, fields: { price: "f64", volume: "i16" } };
}

/** The `seq`th read: BARS bars, right after the previous read's. */
function rangeOf(seq: number): Range {
  const start = T0 + seq * BARS * INTERVAL;
  return { start, end: start + (BARS - 1) * INTERVAL };
}

/** The bars `got` holds, once checked against what the backend serves. */
function checked(got: GetResult, range: Range): number {
  const n = got.timestamps.length;
  const last = got.timestamps[n - 1];
  const price = got.fields.price as Float64Array;
  const right =
    n === (range.end - range.start) / INTERVAL + 1 &&
    got.timestamps[0] === range.start &&
    last === range.end &&
    price[n - 1] === range.end &&
    got.misses.length === 0;
  if (!right) {
    throw new Error(
      `wrong result for ${range.start}–${range.end}: ${n} bars from ${got.timestamps[0]} to ${last}, ${got.misses.length} misses`,
    );
  }
  return n;
}

/** The client entry of `side`'s revision, as the bench server serves it. */
async function load(side: Side): Promise<typeof Client> {
  const url = `/${side}/index.js`;
  return (await import(url)) as typeof Client;
}

/**
 * Options for a client of `side`, whose SharedWorker is the one named by
 * `worker` (a fresh name starts a fresh worker).
 */
function options(side: Side, ns: string, worker: string): ClientOptions {
  return {
    workerUrl: `/${side}/worker.js?${worker}`,
    fetcher: { module: "/fetcher.js", context: { ns, token: "at-0" } },
  };
}

function shared(client: TscacheClient): TscacheClient {
  if (client.mode !== "shared") {
    throw new Error(`the client is hosted ${client.mode}, not shared`);
  }
  return client;
}

/** A scenario readied on one side of this page. */
interface Prepared {
  /** The leader's operation; a follower has none. */
  op?: AsyncOp;
  /** Undoes what the operation left behind, outside any timer. */
  reset(): Promise<void>;
  calls: number;
}

const prepared = new Map<string, Prepared>();

function entry(scenario: PageScenario, side: Side): Prepared {
  const found = prepared.get(`${scenario}:${side}`);
  if (found === undefined) throw new Error(`${scenario} is not prepared`);
  return found;
}

function opOf(scenario: PageScenario, side: Side): AsyncOp {
  const { op } = entry(scenario, side);
  if (op === undefined) throw new Error(`${scenario} has no leader here`);
  return op;
}

/** A cache filled with three screens; the operation reads the middle one. */
function readViewport(cache: CacheHandle, entry: Prepared): AsyncOp {
  const range = rangeOf(1);
  return async () => {
    entry.calls++;
    return checked(await cache.get(range), range);
  };
}

interface Ask {
  seq: number;
  range: Range;
}

interface Answer {
  seq: number;
  value?: number;
  error?: string;
}

/** The follower: answers each read the leader asks for, from this page. */
function follow(cache: CacheHandle, channel: BroadcastChannel): void {
  channel.onmessage = async ({ data }: MessageEvent<Ask>) => {
    let answer: Answer;
    try {
      answer = {
        seq: data.seq,
        value: checked(await cache.get(data.range), data.range),
      };
    } catch (error) {
      answer = { seq: data.seq, error: String(error) };
    }
    channel.postMessage(answer);
  };
}

/**
 * The leader: asks the follower page for a new range and reads it here at
 * the same time; done when both pages have it. Each operation reads a range
 * no earlier one did, so exactly one of the two gets fetches it.
 */
function lead(
  cache: CacheHandle,
  channel: BroadcastChannel,
  entry: Prepared,
): AsyncOp {
  const waiting = new Map<number, (answer: Answer) => void>();
  channel.onmessage = ({ data }: MessageEvent<Answer>) => {
    waiting.get(data.seq)?.(data);
  };
  let seq = 0;
  return async () => {
    entry.calls++;
    const next = seq++;
    const ask: Ask = { seq: next, range: rangeOf(next) };
    const answered = new Promise<Answer>((resolve) => {
      waiting.set(ask.seq, resolve);
    });
    channel.postMessage(ask);
    const [got, answer] = await Promise.all([cache.get(ask.range), answered]);
    waiting.delete(ask.seq);
    if (answer.error !== undefined) {
      throw new Error(`the second tab: ${answer.error}`);
    }
    return checked(got, ask.range);
  };
}

async function prepare(p: Preparation): Promise<void> {
  const { createClient } = await load(p.side);
  const client = shared(await createClient(options(p.side, p.ns, p.scenario)));
  const cache = await client.cache(config(p.id));
  const state: Prepared = { reset: async () => {}, calls: 0 };
  if (p.scenario === "read-viewport-shared") {
    const wide = { start: rangeOf(0).start, end: rangeOf(2).end };
    checked(await cache.get(wide), wide);
    state.op = readViewport(cache, state);
  } else {
    const channel = new BroadcastChannel(`tscache-e2e:${p.side}`);
    if (p.role === "follower") follow(cache, channel);
    else {
      state.op = lead(cache, channel, state);
      state.reset = () => cache.clear();
    }
  }
  prepared.set(`${p.scenario}:${p.side}`, state);
}

async function once(scenario: PageScenario, side: Side): Promise<Once> {
  const op = opOf(scenario, side);
  const start = performance.now();
  const value = await op();
  const ms = performance.now() - start;
  await entry(scenario, side).reset();
  return { ms, value };
}

const page: E2ePage = {
  async firstRead(side, ns) {
    const { createClient } = await load(side);
    const range = rangeOf(0);
    const start = performance.now();
    const client = await createClient(options(side, ns, crypto.randomUUID()));
    const cache = await client.cache(config(crypto.randomUUID()));
    const got = await cache.get(range);
    const ms = performance.now() - start;
    shared(client);
    return { ms, value: checked(got, range) };
  },
  prepare,
  once,
  sample(scenario, rounds) {
    const base = entry(scenario, "base");
    const head = entry(scenario, "head");
    return sampleAsync(opOf(scenario, "base"), opOf(scenario, "head"), {
      rounds,
      between: async () => {
        await base.reset();
        await head.reset();
      },
    });
  },
  calls: (scenario, side) => entry(scenario, side).calls,
};

(globalThis as { tscacheE2e?: E2ePage }).tscacheE2e = page;
