// Runs the site's code examples against the examples' mock backend and
// checks what they produce (`bun run docs:run`, after `bun run build`).
// `docs:check` only type-checks them; this catches what compiles but does
// not work, such as a server fetch with no origin to resolve against
// (step 29 R2-1). Every snippet is either run here or listed in SKIPPED
// with the reason it cannot run outside a browser.

import { readdirSync } from "node:fs";
import { createBackend } from "@examples/mock-backend/backend";
import { decodeSnapshot, type EncodedSnapshot, type GetResult } from "tscache";
import type { FetchRequest } from "tscache/fetcher";

const SNIPPETS = new URL("../snippets/", import.meta.url);
const FETCHER = new URL("fetcher.ts", SNIPPETS).href;
const MINUTE = 60_000;

/** Snippets that need a browser or a bundler, and why. */
const SKIPPED: Record<string, string> = {
  "client.ts":
    "imports tscache/worker?worker&url and ?fetcher, which only a bundler resolves",
  "errors.ts":
    "imports tscache/worker?worker&url, which only a bundler resolves",
  "getting-started.ts":
    "imports tscache/worker?worker&url and ?fetcher, which only a bundler resolves",
  "live.ts":
    "imports through Vite and opens an EventSource and a timer that never end",
  "patterns.ts":
    "defines functions only; their calls are the cache methods cache.ts runs",
  "snapshots-page.ts":
    "reads document and imports through Vite; its startCache() runs here",
  "vite-config.ts": "a Vite config, which only Vite runs",
  "env.d.ts": "declarations only",
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

const backend = createBackend({ latencyMs: 0 });
const server = Bun.serve({
  port: 0,
  fetch: async (request) =>
    (await backend(request)) ?? new Response("not found", { status: 404 }),
});
const origin = server.url.origin;
/** The last six hours, ending on the bar forming now. */
const now = Math.floor(Date.now() / MINUTE) * MINUTE;
const sixHours = { start: now - 6 * 60 * MINUTE, end: now };
const CANDLE_FIELDS = ["open", "high", "low", "close", "volume"];

const RUNS: Record<string, () => Promise<void>> = {
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
  async "cache.ts"() {
    const { result } = await import(new URL("cache.ts", SNIPPETS).href);
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
  async "engine.ts"() {
    const { week, other } = await import(new URL("engine.ts", SNIPPETS).href);
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
    const { week } = await import(new URL("grid.ts", SNIPPETS).href);
    const snapped = week.misses[0]?.range;
    check(
      snapped?.start === Date.UTC(2026, 9, 25, 14, 30) &&
        snapped.end === Date.UTC(2026, 9, 30, 14, 30),
      `snapped to ${JSON.stringify(snapped)}`,
    );
  },
  async "snapshots-server.ts, snapshots-browser.ts"() {
    const { createRenderer } = await import(
      new URL("snapshots-server.ts", SNIPPETS).href
    );
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
    const { startCache } = await import(
      new URL("snapshots-browser.ts", SNIPPETS).href
    );
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
  },
};

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
// The snippets log what they show; keep the check's output to its verdicts.
const log = console.log;
for (const [name, run] of Object.entries(RUNS)) {
  console.log = () => {};
  try {
    await run();
    console.log = log;
    log(`ok   ${name}`);
  } catch (error) {
    console.log = log;
    failed = true;
    console.error(
      `✗ ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
for (const [name, reason] of Object.entries(SKIPPED))
  log(`skip ${name}: ${reason}`);
server.stop(true);
// In-process clients hold their message ports open: end the process here.
process.exit(failed ? 1 : 0);
