// Runs the site's code examples against the examples' mock backend and
// checks what they produce (`bun run docs:run`, after `bun run build`).
// `docs:check` only type-checks them; this catches what compiles but does
// not work: a server fetch with no origin to resolve against (step 29
// R2-1), a listener for an event the backend never sends (R3-1). Every
// snippet runs here, except those in SKIPPED, each with its reason; a
// snippet in neither list fails the check.
//
// Bun is not a browser, so the page's environment is stood in for by
// shims (installShims): the bundler's `?worker&url` and `?fetcher`
// imports, a page origin for relative URLs, an EventSource, and no
// workers, so every client falls back to in-process, as the chain does
// where workers are missing.

import { readdirSync } from "node:fs";
import { createBackend } from "@examples/mock-backend/backend";
import {
  COLUMNS_TYPE,
  ColumnsError,
  decodeColumns,
  encodeColumns,
} from "@examples/mock-backend/columns";
import {
  type Dtype,
  decodeSnapshot,
  type EncodedSnapshot,
  type GetResult,
} from "tscache";
import type { FetchRequest } from "tscache/fetcher";

const SNIPPETS = new URL("../snippets/", import.meta.url);
const FETCHER = new URL("fetcher.ts", SNIPPETS).href;
const MINUTE = 60_000;

/** Snippets that cannot run here, and why. */
const SKIPPED: Record<string, string> = {
  "env.d.ts": "type declarations only",
};

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Every column of a result has one value per timestamp. */
function checkColumns(result: GetResult, fields: readonly string[]): void {
  check(
    Object.keys(result.fields).sort().join() === [...fields].sort().join(),
    `fields ${Object.keys(result.fields).join()}`,
  );
  for (const values of Object.values(result.fields)) {
    check(values.length === result.timestamps.length, "column lengths differ");
  }
}

/** Nothing failed to fetch: every miss is uncached (the provisional tail). */
function checkFetched(result: GetResult): void {
  const failed = result.misses.filter((miss) => miss.reason !== "uncached");
  check(failed.length === 0, `misses ${JSON.stringify(failed)}`);
}

/** Resolves when `arm` calls its callback; rejects after `ms`. */
function within(
  ms: number,
  what: string,
  arm: (done: () => void) => () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`${what} within ${ms} ms`));
    }, ms);
    stop = arm(() => {
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

const backend = createBackend({ latencyMs: 0, pushMs: 200 });
const server = Bun.serve({
  port: 0,
  fetch: async (request) =>
    (await backend(request)) ?? new Response("not found", { status: 404 }),
});
const origin = server.url.origin;

/**
 * An EventSource as the spec dispatches: a message with an `event:` field
 * goes to listeners of that type only, and `onmessage` hears only events
 * without one. No reconnection: the check ends its streams itself.
 */
class TestEventSource extends EventTarget {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readonly #abort = new AbortController();

  constructor(url: string | URL) {
    super();
    this.#read(new URL(url, origin)).catch(() => {});
  }

  close(): void {
    this.#abort.abort();
  }

  async #read(url: URL): Promise<void> {
    const response = await fetch(url, { signal: this.#abort.signal });
    if (response.body === null) return;
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      for (
        let end = buffer.indexOf("\n\n");
        end >= 0;
        end = buffer.indexOf("\n\n")
      ) {
        this.#dispatch(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
  }

  #dispatch(block: string): void {
    let type = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (data.length === 0) return;
    const event = new MessageEvent(type, { data: data.join("\n") });
    if (type === "message") this.onmessage?.(event);
    this.dispatchEvent(event);
  }
}

function installShims(): void {
  // What a bundler gives these imports: a worker URL nothing will load
  // (there are no workers below), and the fetcher module's file URL.
  Bun.plugin({
    name: "docs-snippet-imports",
    setup(build) {
      // Bun resolves the file and keeps the query on its path.
      build.onLoad({ filter: /\?(worker&url|fetcher)$/ }, (args) => ({
        contents: `export default ${JSON.stringify(args.path.endsWith("?fetcher") ? FETCHER : "/worker.js")};`,
        loader: "js",
      }));
    },
  });
  const page = globalThis as Record<string, unknown>;
  // No SharedWorker, no Worker: the chain steps down to in-process.
  for (const name of ["SharedWorker", "Worker"]) {
    Object.defineProperty(page, name, { value: undefined, configurable: true });
  }
  // The page's origin is the backend's, as with the examples' dev server.
  const realFetch = globalThis.fetch;
  const pageFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(
      typeof input === "string" && input.startsWith("/")
        ? new URL(input, origin)
        : input,
      init,
    );
  globalThis.fetch = Object.assign(pageFetch, realFetch);
  page.EventSource = TestEventSource;
}

/** The last six hours, ending on the bar forming now. */
const now = Math.floor(Date.now() / MINUTE) * MINUTE;
const sixHours = { start: now - 6 * 60 * MINUTE, end: now };
const CANDLE_FIELDS = ["open", "high", "low", "close", "volume"];
const CANDLES = {
  open: "f64",
  high: "f64",
  low: "f64",
  close: "f64",
  volume: "u32",
} as const;
const load = (file: string) => import(new URL(file, SNIPPETS).href);

/** Each run gets what its snippets logged, in order. */
type Run = (logs: unknown[][]) => Promise<void>;

const RUNS: Record<string, Run> = {
  async "fetcher.ts"() {
    const { default: fetcher } = await import(FETCHER);
    // Five days of one-minute bars: more than one page of the backend's.
    const request: FetchRequest = {
      cacheId: "crypto/BTC",
      range: { start: now - 5 * 24 * 60 * MINUTE, end: now - 60 * MINUTE },
      interval: MINUTE,
      alignmentOffset: 0,
      context: { origin },
    };
    const response = await fetcher.fetch(request);
    check(
      response.timestamps.length > 5000,
      `${response.timestamps.length} points, expected several pages`,
    );
    for (const name of CANDLE_FIELDS) {
      check(
        response.fields[name]?.length === response.timestamps.length,
        `field ${name}`,
      );
    }
    check(typeof response.meta?.version === "string", "no version");
    check(typeof response.meta?.finalizedUntil === "number", "no watermark");
  },
  async "fetcher-columns.ts"() {
    const { default: json } = await import(FETCHER);
    const { default: columns } = await load("fetcher-columns.ts");
    // Several pages, joined, hold what the JSON fetcher reads.
    const request: FetchRequest = {
      cacheId: "crypto/BTC",
      range: { start: now - 5 * 24 * 60 * MINUTE, end: now - 60 * MINUTE },
      interval: MINUTE,
      alignmentOffset: 0,
      context: { origin },
    };
    const [binary, text] = await Promise.all([
      columns.fetch(request),
      json.fetch(request),
    ]);
    check(binary.timestamps instanceof Float64Array, "timestamps not typed");
    check(
      binary.fields.volume instanceof Uint32Array,
      "volume not a u32 column",
    );
    check(
      binary.timestamps.length > 5000 &&
        binary.timestamps.join() === text.timestamps.join(),
      "the timestamps differ from the JSON fetcher's",
    );
    for (const name of CANDLE_FIELDS) {
      check(
        Array.from(binary.fields[name] as ArrayLike<number>).join() ===
          (text.fields[name] as number[]).join(),
        `field ${name} differs from the JSON fetcher's`,
      );
    }
    // The watermark follows the clock, which may tick between the two.
    check(binary.meta?.version === text.meta?.version, "the versions differ");
    check(typeof binary.meta?.finalizedUntil === "number", "no watermark");
    // One page: its columns are views over the one body fetched.
    const hour = await columns.fetch({
      ...request,
      range: { start: now - 2 * 60 * MINUTE, end: now - 60 * MINUTE },
    });
    const buffers = new Set(
      [hour.timestamps, ...Object.values(hour.fields)].map(
        (view) => (view as Float64Array).buffer,
      ),
    );
    check(buffers.size === 1, `one page decoded into ${buffers.size} buffers`);
    // Pages whose columns differ are refused, not converted: a u16 300
    // joined into the first page's u8 array would read as 44 (step 42
    // R1-1), and so would names built to make a delimited signature of the
    // two schemas alike (R2-1).
    const odd = "a:u8\u0000a";
    const mixtures: [
      string,
      [string, Dtype, number][],
      [string, Dtype, number][],
    ][] = [
      ["u8 then u16 volume", [["volume", "u8", 1]], [["volume", "u16", 300]]],
      [
        "colliding names",
        [
          ["a", "u8", 1],
          [odd, "u16", 2],
        ],
        [
          [odd, "u8", 3],
          ["a", "u16", 300],
        ],
      ],
    ];
    const pageFetch = globalThis.fetch;
    try {
      for (const [what, first, second] of mixtures) {
        const meta = { version: "v1", finalizedUntil: now };
        const page = (columns: [string, Dtype, number][], t: number) =>
          encodeColumns(
            {
              timestamps: [t],
              fields: Object.fromEntries(columns.map(([n, , v]) => [n, [v]])),
              dtypes: Object.fromEntries(columns.map(([n, d]) => [n, d])),
            },
            t === now ? { meta } : { meta, next: now },
          );
        const pages = [page(first, now - MINUTE), page(second, now)];
        globalThis.fetch = Object.assign(
          async () =>
            new Response(pages.shift(), {
              headers: { "content-type": COLUMNS_TYPE },
            }),
          pageFetch,
        );
        const mixed = await columns
          .fetch({ ...request, range: { start: now - MINUTE, end: now } })
          .then(
            (response: { fields: Record<string, ArrayLike<number>> }) =>
              JSON.stringify(
                Object.entries(response.fields).map(([n, v]) => [
                  n,
                  Array.from(v),
                ]),
              ),
            (error: unknown) => error,
          );
        check(
          mixed instanceof ColumnsError,
          `pages of ${what} gave ${String(mixed)}, not a ColumnsError`,
        );
      }
    } finally {
      globalThis.fetch = pageFetch;
    }
    // Under Bun as under Node (Vitest): a Buffer at an unaligned offset of
    // its pool decodes, from a copy (R2-2).
    const bytes = encodeColumns({
      timestamps: [now],
      fields: { close: [1.5] },
      dtypes: { close: "f64" },
    });
    const pool = Buffer.alloc(bytes.byteLength + 3);
    pool.set(bytes, 3);
    const fromBuffer = decodeColumns(pool.subarray(3));
    check(
      fromBuffer.timestamps[0] === now && fromBuffer.fields.close?.[0] === 1.5,
      "an unaligned Buffer did not decode",
    );
  },
  async "getting-started.ts"() {
    const { result } = await load("getting-started.ts");
    check(result.coverage.length > 0, "nothing covered");
    checkFetched(result);
    checkColumns(result, CANDLE_FIELDS);
  },
  async "client.ts"(logs) {
    await load("client.ts");
    // Its modeFallback listener reports each step down to in-process; the
    // client delivers those steps on a timer after createClient resolves.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const steps = logs.filter((line) => String(line[0]).startsWith("tscache:"));
    check(
      steps.length === 2 && String(steps[1]?.[0]).endsWith("using in-process"),
      `logged ${JSON.stringify(logs)}`,
    );
  },
  async "cache.ts"() {
    const { result } = await load("cache.ts");
    check(
      result.timestamps.length === 2,
      `${result.timestamps.length} points, expected the range put's 2`,
    );
    check(
      result.coverage.length === 1 && result.misses.length === 0,
      "the hour is not covered",
    );
    checkColumns(result, ["temperature", "errors"]);
  },
  async "errors.ts"(logs) {
    await load("errors.ts");
    // The ConfigError and the InvalidRangeError, each caught and logged.
    check(
      logs.filter((line) => line[0] === true).length === 2,
      `logged ${JSON.stringify(logs)}`,
    );
  },
  async "engine.ts"() {
    const { week, other } = await load("engine.ts");
    check(week.timestamps.length === 2, `${week.timestamps.length} points`);
    check(
      week.coverage.length === 1 && week.misses.length === 0,
      "the week is not covered",
    );
    const copied = other.get("daily", week.coverage[0]);
    check(
      copied.timestamps.length === 2,
      "the hydrated engine lacks the points",
    );
  },
  async "grid.ts"() {
    const { week } = await load("grid.ts");
    const snapped = week.misses[0]?.range;
    check(
      snapped?.start === Date.UTC(2026, 9, 25, 14, 30) &&
        snapped.end === Date.UTC(2026, 9, 30, 14, 30),
      `snapped to ${JSON.stringify(snapped)}`,
    );
  },
  async "live.ts"() {
    const { cache, followStream, startPolling } = await load("live.ts");
    // The first streamed batch reaches the cache, then the stream closes.
    await within(5000, "no streamed bar reached the cache", (done) =>
      followStream(cache, done),
    );
    const pushed: GetResult = await cache.get(
      { start: now - MINUTE, end: now + MINUTE },
      { cacheOnly: true },
    );
    check(pushed.timestamps.length > 0, "the streamed bar is not in the cache");
    // One poll fetches the newest bars.
    await within(5000, "no poll answered", (done) =>
      startPolling(cache, done, 50),
    );
    const polled: GetResult = await cache.get(
      { start: now - 5 * MINUTE, end: now },
      { cacheOnly: true },
    );
    check(
      polled.timestamps.length >= 5,
      `the poll left ${polled.timestamps.length} bars`,
    );
  },
  async "patterns.ts"() {
    const { forgetYesterday, readWithRetry } = await load("patterns.ts");
    const { createClient } = await import("tscache");
    const client = await createClient({
      mode: "in-process",
      fetcher: { module: FETCHER, context: { origin } },
    });
    const cache = await client.cache({
      id: "crypto/BTC",
      interval: MINUTE,
      fields: CANDLES,
    });
    const result: GetResult = await readWithRetry(cache, sixHours);
    check(result.timestamps.length > 300, `${result.timestamps.length} points`);
    checkFetched(result);
    await forgetYesterday(cache);
  },
  async "vite-config.ts"() {
    const { default: config } = await load("vite-config.ts");
    check(
      config.plugins?.[0]?.name === "tscache:fetcher-url",
      "the plugin is not configured",
    );
  },
  async "snapshots-server.ts, snapshots-browser.ts, snapshots-page.ts"(logs) {
    const { createRenderer } = await load("snapshots-server.ts");
    const render = await createRenderer({ fetcherModule: FETCHER, origin });
    const html: string = await render(sixHours);
    const text =
      /<script id="tscache-snapshot" type="application\/json">(.*)<\/script>/s.exec(
        html,
      )?.[1];
    check(text !== undefined, "the page carries no snapshot");
    const snapshot = decodeSnapshot(JSON.parse(text) as EncodedSnapshot);
    check(snapshot.segments.length > 0, "the server read no points");
    check(snapshot.coverage.length > 0, "the server's snapshot covers nothing");
    // The browser's half, in-process here, against the same backend.
    const { startCache } = await load("snapshots-browser.ts");
    const result: GetResult = await startCache(
      { mode: "in-process", fetcher: { module: FETCHER, context: { origin } } },
      sixHours,
      text,
    );
    check(
      result.timestamps.length > 300,
      `the browser read ${result.timestamps.length} points`,
    );
    // Only the provisional tail may be missing: it is never covered, so it
    // is reported 'uncached' even after its fetch.
    const tailOnly = result.misses.every(
      (miss) => miss.reason === "uncached" && miss.range.end === sixHours.end,
    );
    check(tailOnly, `misses ${JSON.stringify(result.misses)}`);
    checkColumns(result, CANDLE_FIELDS);
    // The page entry, with the server's script element in its document.
    const page = globalThis as Record<string, unknown>;
    page.document = {
      getElementById: (id: string) =>
        id === "tscache-snapshot" ? { textContent: text } : null,
    };
    try {
      const before = logs.length;
      await load("snapshots-page.ts");
      const points = logs.slice(before).at(-1)?.[0];
      check(
        typeof points === "number" && points > 300,
        `the page read ${String(points)} points`,
      );
    } finally {
      delete page.document;
    }
  },
};

installShims();
const covered = new Set([
  ...Object.keys(RUNS).flatMap((name) => name.split(", ")),
  ...Object.keys(SKIPPED),
]);
const unlisted = readdirSync(SNIPPETS).filter((file) => !covered.has(file));
let failed = unlisted.length > 0;
for (const file of unlisted) {
  console.error(
    `✗ ${file}: neither run nor skipped; add it to RUNS or SKIPPED`,
  );
}
// The snippets log what they show (log and warn): collect it for the runs to check, and
// keep the output to the verdicts.
const log = console.log;
const warn = console.warn;
for (const [name, run] of Object.entries(RUNS)) {
  const logs: unknown[][] = [];
  console.log = console.warn = (...line: unknown[]) => logs.push(line);
  try {
    await run(logs);
    console.log = log;
    console.warn = warn;
    log(`ok   ${name}`);
  } catch (error) {
    console.log = log;
    console.warn = warn;
    failed = true;
    console.error(
      `✗ ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
for (const [name, reason] of Object.entries(SKIPPED)) {
  log(`skip ${name}: ${reason}`);
}
server.stop(true);
// In-process clients hold their message ports open: end the process here.
process.exit(failed ? 1 : 0);
