// The end-to-end scenarios (docs/benchmarking.md), driven in Chromium by
// `bun scripts/bench.ts e2e`. Report-only: nothing here fails on a timing,
// only on a wrong result or a fetch too many.
//
// The package's client, worker and fetcher entries are bundled for each
// revision and served beside the scenario page (packages/tscache/bench/
// e2e.ts) and the Playwright suites' mock backend and fixture fetcher, so a
// page talks to a real SharedWorker that fetches over HTTP. The fetcher asks
// for columns bodies or JSON, named per side, so one revision can be timed
// against itself with the two formats. Each scenario
// gets a BrowserContext of its own, whose pages share its SharedWorkers.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium } from "@playwright/test";
import {
  BARS,
  type E2ePage,
  type FetcherFormat,
  type Once,
  type PageScenario,
  type Side,
} from "../packages/tscache/bench/e2e-api";
import type { CaseResult } from "../packages/tscache/bench/run";
import { type Sample, summarise } from "../packages/tscache/bench/sample";
import { type BackendSnapshot, backend, columnsModule } from "./e2e-backend";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE = join(ROOT, "packages/tscache");

export interface E2eRun {
  /**
   * The base revision's `src`; without one, the smoke: each scenario once
   * on the head, its results checked.
   */
  baseSrc: string | undefined;
  headSrc: string;
  /** A scratch directory for the bundles. */
  work: string;
  rounds: number;
  only: string[] | undefined;
  /** The fixture fetcher's format on each side. */
  fetchers: Readonly<Record<Side, FetcherFormat>>;
}

type Scenario = "handshake-first-read" | PageScenario;

/** The scenarios, in the order run, with what each times. */
const SCENARIOS: Readonly<Record<Scenario, string>> = {
  "handshake-first-read":
    "a new tab creates a client, connects to a new SharedWorker and reads 1,500 bars it fetches",
  "read-viewport-shared":
    "get 1,500 cached bars through a SharedWorker: the port round trip and the transfer",
  "two-tabs-one-fetch":
    "two tabs ask for the same 1,500 bars at once and share one fetch",
  "live-tail-get":
    "get 1,500 bars whose newest is provisional through a SharedWorker: one fetch answered at once, the merge, the read and the transfer",
};

/**
 * live-tail-get's fetcher: answers every grid point of the range at once,
 * from memory, so the scenario times the worker's work rather than a
 * server's. price is the timestamp; volume counts the fetches made for
 * the cache so far, so the page sees that each get fetched once more.
 */
const TAIL_FETCHER = `
  const fetches = new Map();
  export default {
    async fetch({ cacheId, range, interval, alignmentOffset }) {
      const calls = (fetches.get(cacheId) ?? 0) + 1;
      fetches.set(cacheId, calls);
      const timestamps = [];
      const first = Math.ceil((range.start - alignmentOffset) / interval) * interval + alignmentOffset;
      for (let t = first; t <= range.end; t += interval) timestamps.push(t);
      return {
        timestamps,
        fields: { price: timestamps, volume: timestamps.map(() => calls) },
      };
    },
  };`;

/** A scenario's result; the smoke's carries its one run's time. */
export type E2eResult = CaseResult & { ms?: number };

async function build(options: Bun.BuildConfig): Promise<void> {
  const result = await Bun.build(options);
  if (!result.success) {
    throw new AggregateError(result.logs, "e2e bench build failed");
  }
}

/** The client, worker and fetcher entries of one revision, unminified ESM. */
function buildRevision(src: string, out: string): Promise<void> {
  const entries = join(src, "entries");
  return build({
    entrypoints: ["index.ts", "worker.ts", "fetcher.ts"].map((entry) =>
      join(entries, entry),
    ),
    root: entries,
    outdir: out,
    target: "browser",
    format: "esm",
  });
}

const HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>tscache e2e bench</title></head>
  <body><script type="module" src="/page.js"></script></body>
</html>`;

/** Serves the bundles, the fixture fetcher and the mock backend. */
function serve(out: string) {
  const files = (path: string): string | undefined => {
    if (path === "/page.js") return join(out, "page.js");
    if (path === "/fetcher.js") return join(ROOT, "e2e/pages/fetcher.js");
    // The fixture fetcher imports its error class from the built package.
    if (path === "/dist/fetcher.js") return join(out, "head/fetcher.js");
    const match = /^\/(base|head)\/([\w-]+\.js)$/.exec(path);
    return match === null
      ? undefined
      : join(out, match[1] as string, match[2] as string);
  };
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        return new Response(HTML, { headers: { "content-type": "text/html" } });
      }
      if (url.pathname.startsWith("/backend/")) return backend(request, url);
      if (url.pathname === "/columns.js") return columnsModule();
      if (url.pathname === "/tail-fetcher.js") {
        return new Response(TAIL_FETCHER, {
          headers: { "content-type": "text/javascript" },
        });
      }
      const path = files(url.pathname);
      const file = path === undefined ? undefined : Bun.file(path);
      if (file === undefined || !(await file.exists())) {
        return new Response("not found", { status: 404 });
      }
      return new Response(file, {
        headers: { "content-type": "text/javascript" },
      });
    },
  });
}

interface Driver {
  browser: Browser;
  /** The server's origin. */
  origin: string;
  /** The scenario page's URL, naming each side's fetcher format. */
  pageUrl: string;
  sides: Side[];
  rounds: number;
}

/** A new page of the context with the scenario page loaded. */
async function open(context: BrowserContext, pageUrl: string) {
  const page = await context.newPage();
  page.setDefaultTimeout(0);
  await page.goto(pageUrl);
  await page.waitForFunction(() => "tscacheE2e" in globalThis);
  return page;
}

/** The backend's fetches for `ns`, by "start-end". */
async function fetches(
  origin: string,
  ns: string,
): Promise<Record<string, number>> {
  const response = await fetch(`${origin}/backend/${ns}/state`);
  return ((await response.json()) as BackendSnapshot).requests;
}

function result(
  scenario: Scenario,
  outcome: { sample: Sample } | Once,
): E2eResult {
  const what = SCENARIOS[scenario];
  return "sample" in outcome
    ? { name: scenario, what, sample: outcome.sample }
    : { name: scenario, what, expected: BARS, ...outcome };
}

/**
 * handshake-first-read: each run a new tab and a new SharedWorker, timed
 * in the page from createClient to the first read's answer. Runs are
 * paired as `sample` pairs batches, one run a batch: a run takes tens of
 * milliseconds, far above the clock's 100 µs.
 */
async function firstReads(d: Driver): Promise<E2eResult> {
  const context = await d.browser.newContext();
  const once = async (side: Side): Promise<Once> => {
    const ns = randomUUID();
    const page = await open(context, d.pageUrl);
    try {
      const run = await page.evaluate(
        ([s, n]) =>
          (
            globalThis as unknown as { tscacheE2e: E2ePage }
          ).tscacheE2e.firstRead(s, n),
        [side, ns] as const,
      );
      const seen = Object.values(await fetches(d.origin, ns));
      if (seen.length !== 1 || seen[0] !== 1) {
        throw new Error(`a first read fetched ${JSON.stringify(seen)} times`);
      }
      return run;
    } finally {
      await page.close();
    }
  };
  try {
    if (d.sides.length === 1) {
      return result("handshake-first-read", await once("head"));
    }
    for (let i = 0; i < 2; i++) {
      await once("base");
      await once("head");
    }
    const base: number[] = [];
    const head: number[] = [];
    for (let round = 0; round < d.rounds; round++) {
      if (round % 2 === 0) {
        base.push((await once("base")).ms);
        head.push((await once("head")).ms);
      } else {
        head.push((await once("head")).ms);
        base.push((await once("base")).ms);
      }
    }
    return result("handshake-first-read", {
      sample: summarise(base, head, 1),
    });
  } finally {
    await context.close();
  }
}

/**
 * The fetches a page scenario may make on one side, given how often its
 * operation ran: read-viewport-shared only its one fill (every read is a
 * cache hit), two-tabs-one-fetch one per operation, of a range no other
 * asked for (the second tab's get joined the first's fetch, or found its
 * result cached), live-tail-get none (its fetcher answers from memory, and
 * the page checks that every get fetched).
 */
function checkFetches(
  scenario: PageScenario,
  seen: Record<string, number>,
  calls: number,
): void {
  const counts = Object.values(seen);
  const expected: Record<PageScenario, () => boolean> = {
    "read-viewport-shared": () => counts.length === 1 && counts[0] === 1,
    "two-tabs-one-fetch": () =>
      counts.length === calls && counts.every((n) => n === 1),
    "live-tail-get": () => counts.length === 0,
  };
  const right = expected[scenario]();
  if (!right) {
    throw new Error(
      `${scenario}: ${calls} operations made these fetches: ${JSON.stringify(seen)}`,
    );
  }
}

/** A scenario timed inside one page (and answered by a second, for two tabs). */
async function inPage(d: Driver, scenario: PageScenario): Promise<E2eResult> {
  const context = await d.browser.newContext();
  try {
    const leader = await open(context, d.pageUrl);
    const follower =
      scenario === "two-tabs-one-fetch"
        ? await open(context, d.pageUrl)
        : undefined;
    const ns = { base: randomUUID(), head: randomUUID() };
    for (const side of d.sides) {
      const p = { scenario, side, ns: ns[side], id: randomUUID() };
      await follower?.evaluate(
        (q) =>
          (globalThis as unknown as { tscacheE2e: E2ePage }).tscacheE2e.prepare(
            q,
          ),
        { ...p, role: "follower" as const },
      );
      await leader.evaluate(
        (q) =>
          (globalThis as unknown as { tscacheE2e: E2ePage }).tscacheE2e.prepare(
            q,
          ),
        { ...p, role: "leader" as const },
      );
    }
    const outcome =
      d.sides.length === 1
        ? await leader.evaluate(
            (s) =>
              (
                globalThis as unknown as { tscacheE2e: E2ePage }
              ).tscacheE2e.once(s, "head"),
            scenario,
          )
        : {
            sample: await leader.evaluate(
              ([s, r]) =>
                (
                  globalThis as unknown as { tscacheE2e: E2ePage }
                ).tscacheE2e.sample(s, r),
              [scenario, d.rounds] as const,
            ),
          };
    for (const side of d.sides) {
      const calls = await leader.evaluate(
        ([s, side]) =>
          (globalThis as unknown as { tscacheE2e: E2ePage }).tscacheE2e.calls(
            s,
            side,
          ),
        [scenario, side] as const,
      );
      checkFetches(scenario, await fetches(d.origin, ns[side]), calls);
    }
    return result(scenario, outcome);
  } finally {
    await context.close();
  }
}

/** Runs the scenarios in Chromium: paired with a base, or the smoke. */
export async function runE2e(run: E2eRun): Promise<E2eResult[]> {
  const out = join(run.work, "e2e");
  const sides: Side[] = run.baseSrc === undefined ? ["head"] : ["base", "head"];
  await buildRevision(run.headSrc, join(out, "head"));
  if (run.baseSrc !== undefined) {
    await buildRevision(run.baseSrc, join(out, "base"));
  }
  await build({
    entrypoints: [join(PACKAGE, "bench/e2e.ts")],
    outdir: out,
    naming: "page.js",
    target: "browser",
    format: "esm",
  });
  const server = serve(out);
  const browser = await chromium.launch();
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const formats = new URLSearchParams(run.fetchers);
    const d: Driver = {
      browser,
      origin,
      pageUrl: `${origin}/?${formats}`,
      sides,
      rounds: run.rounds,
    };
    const selected = (Object.keys(SCENARIOS) as Scenario[]).filter(
      (s) => run.only === undefined || run.only.includes(s),
    );
    const results: E2eResult[] = [];
    for (const scenario of selected) {
      results.push(
        scenario === "handshake-first-read"
          ? await firstReads(d)
          : await inPage(d, scenario),
      );
    }
    return results;
  } finally {
    await browser.close();
    await server.stop(true);
  }
}
