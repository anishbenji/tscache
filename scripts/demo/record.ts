// `bun scripts/demo/record.ts [--reuse-builds] [--only <name>[,<name>]]`:
// records the four demo scenarios of the README and the site (multi-tab
// sharing, credential refresh, server rendering, live-feed reconnect)
// headless in Chromium against the demo (`bun run demo`), one Playwright
// video per scenario, and converts each with ffmpeg into
//
// - docs/media/<name>.gif, for the README (GitHub, npm and editors show it);
// - site/public/media/<name>.mp4 (H.264) and .webm (VP9), for the site.
//
// It starts the demo itself (scripts/demo.ts; --reuse-builds passes through)
// and stops it at the end; Ctrl-C, SIGTERM or SIGHUP stops it, Chromium and
// everything the demo started too. Every scenario runs on the vanilla reference
// client in a fresh browser context, so a fresh SharedWorker. The recorded
// page is a stage this script serves: a caption, a strip of the app's
// mock-backend counters since the scenario began, and the app itself in one
// or two same-site iframes. Two iframes of one origin share its SharedWorker,
// Web Locks and localStorage exactly as two tabs do, and both fit in one
// recording. Each scenario checks what its caption claims as it runs, and
// fails the recording when the app does not show it; what it observed is
// printed at the end. ffmpeg must be on PATH (a local tool, not a
// dependency). A heavy job: run it through the machine's heavy-job lock.

import { copyFileSync, renameSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  chromium,
  expect,
  type FrameLocator,
  type Page,
} from "@playwright/test";
import { demoPorts, hubPort } from "./catalog";
import { Processes } from "./processes";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/**
 * Where docs/media/ and site/public/media/ are: the checkout, or
 * RECORD_MEDIA_ROOT for the recorder's tests only, so they never touch the
 * committed media (e2e/demo/launcher.spec.ts).
 */
const MEDIA_ROOT = process.env.RECORD_MEDIA_ROOT || ROOT;
const GIF_DIR = join(MEDIA_ROOT, "docs/media");
const VIDEO_DIR = join(MEDIA_ROOT, "site/public/media");
const MINUTE = 60_000;
/** The recorded viewport; the site's videos keep it. */
const VIEW = { width: 960, height: 600 };
/** The README's GIFs: narrower, fewer frames, a small palette. */
const GIF = { width: 720, fps: 8, colors: 96 };
const APP = "reference-vanilla";
const LIVE_PATH = "/?chart=lightweight&feed=sse";

const port = hubPort(process.env);
const appOrigin = `http://127.0.0.1:${demoPorts(port)[APP]}/`;
const hubOrigin = `http://127.0.0.1:${port}/`;

/** The mock backend's counters the stage shows (GET /api/stats). */
interface Counters {
  /** Series pages served. */
  fetches: number;
  /** Bars in the series pages served. */
  bars: number;
  refused: number;
  refreshes: number;
  streams: number;
}

async function counters(): Promise<Counters> {
  const response = await fetch(`${appOrigin}api/stats`);
  if (!response.ok) throw new Error(`stats: ${response.status}`);
  const stats = (await response.json()) as Omit<
    Counters,
    "fetches" | "bars"
  > & {
    pages: Record<string, number>;
    points: number;
  };
  const fetches = Object.values(stats.pages).reduce((a, b) => a + b, 0);
  const { points: bars, refused, refreshes, streams } = stats;
  return { fetches, bars, refused, refreshes, streams };
}

async function control(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${appOrigin}api/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control: ${response.status}`);
}

// --- The stage ------------------------------------------------------------

type Chip = keyof Counters;

const CHIP_LABELS: Record<Chip, string> = {
  fetches: "backend fetches",
  bars: "bars served",
  refused: "requests refused",
  refreshes: "token refreshes",
  streams: "open live streams",
};

const STAGE_STYLE = `
* { box-sizing: border-box; }
body { margin: 0; width: ${VIEW.width}px; height: ${VIEW.height}px; overflow: hidden;
  font: 15px/1.4 system-ui, sans-serif; color: #1d2330; background: #eef1f6; }
header { height: 92px; padding: 10px 16px 0; }
.title { font-size: 13px; color: #5b6475; letter-spacing: 0.02em; }
.caption { font-size: 21px; font-weight: 600; margin-top: 4px; min-height: 58px; }
.chips { display: flex; gap: 10px; padding: 0 16px; height: 40px; }
.chip { background: #fff; border: 1px solid #d5d9e2; border-radius: 6px; padding: 4px 10px;
  display: flex; align-items: baseline; gap: 8px; transition: background 1.2s; }
.chip b { font-size: 20px; font-variant-numeric: tabular-nums; }
.chip span { color: #5b6475; font-size: 13px; }
.chip.changed { background: #ffe58a; transition: background 0s; }
.tabs { display: flex; gap: 16px; padding: 8px 16px 0; }
.tab { flex: 1; }
.tab .label { font-size: 13px; font-weight: 600; color: #5b6475; height: 20px; }
.frame { overflow: hidden; border: 1px solid #c4cad6; border-radius: 6px; background: #fbfbf9; }
.frame iframe { border: 0; transform-origin: 0 0; display: block; }
`;

/** The stage's script: the caption, and the counters since the baseline. */
const STAGE_SCRIPT = `
let baseline = null;
const absolute = new Set(["streams"]);
async function read() {
  const response = await fetch("/counters", { cache: "no-store" });
  return response.json();
}
window.stageCaption = (text) => { document.getElementById("caption").textContent = text; };
window.stageReset = async () => { baseline = await read(); paint(baseline); };
function paint(now) {
  for (const chip of document.querySelectorAll(".chip")) {
    const key = chip.dataset.key;
    const value = absolute.has(key) ? now[key] : now[key] - baseline[key];
    const cell = chip.querySelector("b");
    if (cell.textContent !== String(value)) {
      cell.textContent = String(value);
      chip.classList.add("changed");
      requestAnimationFrame(() => requestAnimationFrame(() => chip.classList.remove("changed")));
    }
  }
}
setInterval(async () => { if (baseline !== null) paint(await read()); }, 200);
`;

/** What the stage's script puts on its window. */
interface StageWindow {
  stageCaption(text: string): void;
  stageReset(): Promise<void>;
}

/** Counts the counters from now on (all but open streams). */
async function resetCounters(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as StageWindow).stageReset(),
  );
}

interface StageOptions {
  title: string;
  chips: Chip[];
  /** One label per iframe: "Tab 1", "Tab 2". */
  tabs: string[];
}

/** The iframe's scale: a page laid out wider than the column it shows in. */
function frameLayout(tabs: number): {
  width: number;
  height: number;
  scale: number;
} {
  const column = (VIEW.width - 32 - 16 * (tabs - 1)) / tabs;
  const height = VIEW.height - 92 - 40 - 8 - 20 - 12;
  const scale = tabs === 1 ? 0.85 : 0.78;
  return { width: column, height, scale };
}

function stageHtml({ title, chips, tabs }: StageOptions): string {
  const layout = frameLayout(tabs.length);
  const inner = `width:${layout.width / layout.scale}px;height:${layout.height / layout.scale}px;transform:scale(${layout.scale})`;
  const chipHtml = chips
    .map(
      (key) =>
        `<div class="chip" data-key="${key}"><span>${CHIP_LABELS[key]}</span><b>–</b></div>`,
    )
    .join("");
  const tabHtml = tabs
    .map(
      (label, i) =>
        `<div class="tab"><div class="label">${label}</div><div class="frame" style="width:${layout.width}px;height:${layout.height}px"><iframe id="tab-${i}" title="${label}" style="${inner}"></iframe></div></div>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>${STAGE_STYLE}</style></head><body>
<header><div class="title">tscache · ${title}</div><div class="caption" id="caption"></div></header>
<div class="chips">${chipHtml}</div>
<div class="tabs">${tabHtml}</div>
<script>${STAGE_SCRIPT}</script></body></html>`;
}

/** Serves the stage page of the scenario running, and the counters. */
function startStage(): {
  origin: string;
  show(options: StageOptions): void;
  stop(): void;
} {
  let html = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/counters") return Response.json(await counters());
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}/`,
    show(options) {
      html = stageHtml(options);
    },
    stop() {
      void server.stop(true);
    },
  };
}

// --- Scenarios --------------------------------------------------------------

interface Recording {
  page: Page;
  caption(text: string): Promise<void>;
  /** Shows the app's page in tab `i`. */
  open(i: number, path: string): Promise<FrameLocator>;
  /** Waits in real time, so the video holds a moment. */
  hold(ms: number): Promise<void>;
  /** Marks where the published clip starts. */
  start(): Promise<void>;
  /** What the scenario observed, printed at the end. */
  note(text: string): void;
}

interface Scenario {
  name: string;
  stage: StageOptions;
  run(recording: Recording): Promise<void>;
}

/** Waits until the page in `tab` is connected, live and has drawn bars. */
async function live(tab: FrameLocator): Promise<number> {
  await expect(tab.getByTestId("connection")).toHaveText("live", {
    timeout: 30_000,
  });
  const summary = tab.getByTestId("summary");
  await expect(summary).toHaveText(/^[1-9][\d,]* bars/);
  const text = (await summary.textContent()) ?? "";
  return Number(/^([\d,]+)/.exec(text)?.[1]?.replace(/,/g, ""));
}

/** What the counters moved by between two reads. */
function moved(before: Counters, after: Counters) {
  return {
    fetches: after.fetches - before.fetches,
    bars: after.bars - before.bars,
    refused: after.refused - before.refused,
    refreshes: after.refreshes - before.refreshes,
  };
}

/** "1 fetch", "2 fetches"; "1 bar", "3 bars". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The most bars a read of the newest bars fetches: the bar forming now and
 * the one that closed since the last read. The reads that catch up after
 * a gap add the bars the gap held.
 */
const NEWEST = 2;

const scenarios: Scenario[] = [
  {
    name: "multi-tab-sharing",
    stage: {
      title: "multi-tab sharing",
      chips: ["fetches", "bars"],
      tabs: ["Tab 1", "Tab 2"],
    },
    async run(r) {
      const zero = await counters();
      await r.start();
      await r.caption(
        "Tab 1 opens. Its cache is empty, so the SharedWorker fetches the history.",
      );
      const a = await r.open(0, LIVE_PATH);
      const shown = await live(a);
      // After the hold, so a fetch of tab 1's (its feed opening reads the
      // newest bars) is counted before tab 2 opens.
      await r.hold(1500);
      const first = await counters();
      const opening = moved(zero, first);
      // The README and the site say tab 1 fetches the history in one fetch.
      if (opening.fetches !== 1) {
        throw new Error(`tab 1 made ${opening.fetches} fetches, not one`);
      }
      await r.caption(
        "Tab 2 opens on the same SharedWorker and draws from the shared cache.",
      );
      const b = await r.open(1, LIVE_PATH);
      const drawn = await live(b);
      await expect(b.getByTestId("mode")).toHaveText("shared");
      // The README and the site say tab 2 draws the same bars. Both first
      // read twelve hours up to the bar forming now (readRange in
      // reference/shared/src/market.ts), 721 bars; a bar that opens while
      // tab 2 loads is pushed into the cache and redrawn, one bar more.
      if (drawn < shown || drawn > shown + 1) {
        throw new Error(`tab 2 drew ${drawn} bars, tab 1 ${shown}`);
      }
      await r.hold(600);
      const step = moved(first, await counters());
      if (step.bars > NEWEST) {
        throw new Error(`tab 2 fetched ${step.bars} bars, not the newest`);
      }
      await r.caption(
        `Tab 2 drew ${drawn} bars; the backend served it ${step.bars === 0 ? "nothing" : `${count(step.bars, "bar", "bars")}, the newest`}.`,
      );
      await r.hold(2500);
      r.note(
        `tab 1: ${shown} bars drawn, ${count(opening.fetches, "fetch", "fetches")} of ${opening.bars} bars; tab 2: ${drawn} bars drawn, mode shared, ${count(step.fetches, "fetch", "fetches")} of ${count(step.bars, "bar", "bars")}`,
      );
    },
  },
  {
    name: "credential-refresh",
    stage: {
      title: "credential refresh",
      chips: ["refused", "refreshes", "fetches"],
      tabs: ["Tab 1", "Tab 2"],
    },
    async run(r) {
      const a = await r.open(0, LIVE_PATH);
      const b = await r.open(1, LIVE_PATH);
      await live(a);
      await live(b);
      await resetCounters(r.page);
      const before = await counters();
      await r.start();
      await r.caption("Two tabs, one SharedWorker, one access token.");
      await r.hold(1200);
      await r.caption("The backend expires the access token.");
      await control({ expireAccess: true });
      await r.hold(1200);
      await r.caption(
        "Tab 1 scrolls back. The backend refuses the expired token; one tab refreshes it for both.",
      );
      await drag(r.page, 0);
      await expect
        .poll(async () => (await counters()).refreshes, { timeout: 20_000 })
        .toBe(before.refreshes + 1);
      await expect(a.getByTestId("missing")).toHaveText("nothing missing", {
        timeout: 20_000,
      });
      await expect(a.getByTestId("auth")).toHaveText("signed in");
      await expect(b.getByTestId("auth")).toHaveText("signed in");
      await r.hold(800);
      const step = moved(before, await counters());
      if (step.refreshes !== 1 || step.refused < 1) {
        throw new Error(`${step.refused} refused, ${step.refreshes} refreshes`);
      }
      await r.caption(
        "One refresh for both tabs: both stay signed in, and the history arrives.",
      );
      await r.hold(2500);
      r.note(
        `${step.refused} refused, ${step.refreshes} refresh, ${count(step.fetches, "fetch", "fetches")} of ${step.bars} bars; both tabs "signed in", tab 1 "nothing missing"`,
      );
    },
  },
  {
    name: "server-rendering",
    stage: {
      title: "server rendering",
      chips: ["fetches", "bars"],
      tabs: ["The server-rendered page (/ssr)"],
    },
    async run(r) {
      // The server's in-process cache outlives requests: one render first,
      // so the recorded render is one of a server that has served the page
      // before.
      const warm = await fetch(`${appOrigin}ssr`);
      if (!warm.ok) throw new Error(`/ssr: ${warm.status}`);
      await resetCounters(r.page);
      const before = await counters();
      await r.start();
      await r.caption(
        "The server has rendered this page before, so its cache already holds the history.",
      );
      await r.hold(1200);
      const tab = await r.open(0, "/ssr");
      const drawn = await live(tab);
      await expect(tab.locator("#chart canvas").first()).toBeVisible();
      await r.hold(800);
      const step = moved(before, await counters());
      // The server's read and the browser's read each fetch the newest bars.
      if (step.bars > 2 * NEWEST) {
        throw new Error(`${step.bars} bars served for the page`);
      }
      await r.caption(
        `${drawn} bars drawn from the server's read; server and browser fetched only ${count(step.bars, "bar", "bars")}.`,
      );
      await r.hold(3000);
      r.note(
        `${drawn} bars drawn; server and browser together: ${count(step.fetches, "fetch", "fetches")} of ${count(step.bars, "bar", "bars")}`,
      );
    },
  },
  {
    name: "live-feed-reconnect",
    stage: {
      title: "live-feed reconnect",
      chips: ["streams", "fetches", "bars"],
      tabs: ["The live page (Server-Sent Events)"],
    },
    async run(r) {
      const tab = await r.open(0, LIVE_PATH);
      await live(tab);
      await expect
        .poll(async () => (await counters()).streams, { timeout: 10_000 })
        .toBe(1);
      await resetCounters(r.page);
      await r.start();
      await r.caption("The live feed streams new bars into the cache.");
      await r.hold(1500);
      const before = await counters();
      await r.caption(
        "The backend drops every stream, and its clock moves a minute on while the feed is down.",
      );
      await control({ dropStreams: true, advanceMs: MINUTE });
      // The client reconnects after the stream's retry delay (500 ms).
      await expect
        .poll(async () => (await counters()).streams, { intervals: [50] })
        .toBe(0);
      await expect
        .poll(async () => (await counters()).streams, { timeout: 15_000 })
        .toBe(1);
      await r.caption(
        "The feed reconnects and reads over the bars the outage broke into.",
      );
      await expect
        .poll(async () => (await counters()).fetches, { timeout: 15_000 })
        .toBeGreaterThan(before.fetches);
      await r.hold(800);
      const step = moved(before, await counters());
      // The README and the site say one fetch mends the gap.
      if (step.fetches !== 1 || step.bars > NEWEST + 1) {
        throw new Error(
          `the catch-up made ${step.fetches} fetches of ${step.bars} bars`,
        );
      }
      await r.caption(
        `Caught up with ${count(step.fetches, "fetch", "fetches")} of ${count(step.bars, "bar", "bars")}, not the history.`,
      );
      await r.hold(2500);
      r.note(
        `streams 1, then 0, then 1; ${count(step.fetches, "fetch", "fetches")} of ${count(step.bars, "bar", "bars")} after the drop`,
      );
    },
  },
];

/** Drags tab `i`'s chart by most of its width, back in time. */
async function drag(page: Page, i: number): Promise<void> {
  const box = await page.locator(`#tab-${i}`).boundingBox();
  if (box === null) throw new Error("no tab");
  const y = box.y + box.height * 0.7;
  await page.mouse.move(box.x + box.width * 0.15, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, y, { steps: 20 });
  await page.mouse.up();
}

// --- Recording and conversion ---------------------------------------------

interface Clip {
  scenario: Scenario;
  video: string;
  /** Seconds into the video. */
  from: number;
  to: number;
  notes: string[];
}

async function record(
  browser: Browser,
  stage: ReturnType<typeof startStage>,
  scenario: Scenario,
  rawDir: string,
): Promise<Clip> {
  console.log(`recording ${scenario.name}`);
  stage.show(scenario.stage);
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    recordVideo: { dir: rawDir, size: VIEW },
  });
  const page = await context.newPage();
  const born = performance.now();
  const at = () => (performance.now() - born) / 1000;
  const notes: string[] = [];
  let from: number | undefined;
  await page.goto(stage.origin);
  await resetCounters(page);
  const recording: Recording = {
    page,
    async caption(text) {
      await page.evaluate(
        (t) => (globalThis as unknown as StageWindow).stageCaption(t),
        text,
      );
    },
    async open(i, path) {
      const url = new URL(path, appOrigin).href;
      await page.locator(`#tab-${i}`).evaluate((frame, src) => {
        (frame as unknown as { src: string }).src = src;
      }, url);
      return page.frameLocator(`#tab-${i}`);
    },
    hold: (ms) => Bun.sleep(ms),
    async start() {
      from = at();
    },
    note: (text) => notes.push(text),
  };
  try {
    await scenario.run(recording);
  } finally {
    await context.close();
  }
  const video = await page.video()?.path();
  if (video === undefined || from === undefined) {
    throw new Error(`${scenario.name}: no video, or no start mark`);
  }
  return { scenario, video, from, to: at(), notes };
}

/**
 * The ffmpeg binary: RECORD_FFMPEG for the recorder's tests only, which
 * stand a script in for it (e2e/demo/launcher.spec.ts).
 */
const FFMPEG = process.env.RECORD_FFMPEG || "ffmpeg";

/**
 * Set, synchronously, the moment shutdown begins. Every step that starts
 * work checks it first, in the same synchronous run as the work it starts:
 * the demo's start, Chromium's launch, each scenario, each ffmpeg, and the
 * install of a scenario's media; each ffmpeg checks it again once it exits.
 * So once shutdown begins, no new process starts and no media file changes.
 */
let cancelled = false;

/** Stops the step that calls it once shutdown has begun. */
function stopIfCancelled(): void {
  if (cancelled) throw new Error("the recorder is stopping");
}

/** The ffmpeg running now, which shutdown stops before anything else. */
let converting: ReturnType<typeof Bun.spawn> | undefined;

async function ffmpeg(args: string[]): Promise<void> {
  stopIfCancelled();
  const run = Bun.spawn(
    [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", ...args],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  converting = run;
  const code = await run.exited;
  converting = undefined;
  // An ffmpeg that shutdown stopped, or that finished after it began, ends
  // the conversion here, whatever its exit code.
  stopIfCancelled();
  if (code !== 0) throw new Error(`ffmpeg ${args.join(" ")}: exit ${code}`);
}

/**
 * Moves each finished file over its committed one, unless shutdown has
 * begun. Synchronous, so no signal handler runs between the check and the
 * last move: a scenario's three files are replaced together or not at all.
 * A move across file systems copies.
 */
function install(moves: [from: string, to: string][]): void {
  stopIfCancelled();
  for (const [from, to] of moves) {
    try {
      renameSync(from, to);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EXDEV") throw error;
      copyFileSync(from, to);
      unlinkSync(from);
    }
  }
}

/**
 * Writes the clip's GIF, MP4 and WebM into `work`, then, once all three
 * exist, moves them into place. A failed conversion leaves the committed
 * media as they were. Once shutdown begins (`cancelled`), no further ffmpeg
 * starts, the one running is stopped, and nothing is installed, even when
 * that ffmpeg had just finished.
 */
async function convert(clip: Clip, work: string): Promise<string[]> {
  const { name } = clip.scenario;
  const trim = [
    "-ss",
    clip.from.toFixed(2),
    "-to",
    clip.to.toFixed(2),
    "-i",
    clip.video,
  ];
  const mp4 = join(work, `${name}.mp4`);
  const webm = join(work, `${name}.webm`);
  const gif = join(work, `${name}.gif`);
  await ffmpeg([
    ...trim,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "26",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4,
  ]);
  await ffmpeg([
    ...trim,
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "0",
    "-crf",
    "38",
    "-row-mt",
    "1",
    webm,
  ]);
  const scale = `fps=${GIF.fps},scale=${GIF.width}:-1:flags=lanczos`;
  await ffmpeg([
    ...trim,
    "-filter_complex",
    `[0:v]${scale},split[a][b];[a]palettegen=max_colors=${GIF.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    "-loop",
    "0",
    gif,
  ]);
  const placed: [string, string][] = [
    [gif, join(GIF_DIR, `${name}.gif`)],
    [mp4, join(VIDEO_DIR, `${name}.mp4`)],
    [webm, join(VIDEO_DIR, `${name}.webm`)],
  ];
  install(placed);
  return placed.map(([, to]) => to);
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function waitForHub(): Promise<void> {
  // The demo builds every app first, which takes minutes.
  const deadline = Date.now() + 15 * MINUTE;
  while (Date.now() < deadline && !cancelled) {
    try {
      if ((await fetch(`${hubOrigin}healthz`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(500);
  }
  throw new Error(`the demo hub did not answer on ${hubOrigin}`);
}

const processes = new Processes();
let stage: ReturnType<typeof startStage> | undefined;
let browser: Browser | undefined;
/** Chromium while it launches, so shutdown closes one it did not see yet. */
let launching: Promise<Browser> | undefined;
let rawDir: string | undefined;
let exiting: Promise<never> | undefined;

/**
 * The one way out, as in scripts/demo.ts. In order: marks the recorder
 * cancelled and signals a running ffmpeg, before anything is awaited; waits
 * for that ffmpeg to exit; closes Chromium (one still launching too), stops
 * the stage, resets the backend's clock and stops the demo with everything
 * it started; removes the raw videos and any unfinished conversion; then
 * exits. The demo's processes run in groups of their own, so a Ctrl-C in
 * the terminal reaches only this process, and only this stops them.
 */
function shutdown(code: number, reason?: string): Promise<never> {
  if (exiting !== undefined) return exiting;
  cancelled = true;
  const running = converting;
  running?.kill();
  exiting = (async () => {
    if (reason !== undefined) console.error(reason);
    await running?.exited;
    const opened = browser ?? (await launching?.catch(() => undefined));
    await opened?.close().catch(() => {});
    stage?.stop();
    // Undo a scenario's clock move; the backend may be down already.
    await control({ resetClock: true }).catch(() => {});
    await processes.stop();
    if (rawDir !== undefined) {
      await rm(rawDir, { recursive: true, force: true });
    }
    process.exit(code);
  })();
  return exiting;
}

process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));
process.on("SIGHUP", () => void shutdown(129));

async function main(): Promise<void> {
  if (Bun.which(FFMPEG) === null) {
    throw new Error(`${FFMPEG} is not on PATH (macOS: brew install ffmpeg)`);
  }
  const only = option("--only")?.split(",");
  const chosen = scenarios.filter((s) => only?.includes(s.name) ?? true);
  if (chosen.length === 0) {
    throw new Error(
      `--only names none of ${scenarios.map((s) => s.name).join(", ")}`,
    );
  }
  await mkdir(GIF_DIR, { recursive: true });
  await mkdir(VIDEO_DIR, { recursive: true });
  rawDir = await mkdtemp(join(tmpdir(), "tscache-record-"));
  const demoArgs = process.argv.includes("--reuse-builds")
    ? ["--reuse-builds"]
    : [];
  stopIfCancelled();
  const demo = processes.start(["bun", "scripts/demo.ts", ...demoArgs], {
    cwd: ROOT,
  });
  void demo.exited.then((code) => {
    if (!cancelled) void shutdown(1, `the demo exited with ${code}`);
  });
  stage = startStage();
  await waitForHub();
  // The recorder handles the signals itself: Playwright's handlers would
  // close Chromium and exit without stopping the demo.
  stopIfCancelled();
  launching = chromium.launch({
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  browser = await launching;
  const results: { clip: Clip; files: string[] }[] = [];
  for (const scenario of chosen) {
    stopIfCancelled();
    const clip = await record(browser, stage, scenario, rawDir);
    if (scenario.name === "live-feed-reconnect") {
      await control({ resetClock: true });
    }
    results.push({ clip, files: await convert(clip, rawDir) });
  }
  for (const { clip, files } of results) {
    console.log(
      `\n${clip.scenario.name}: ${(clip.to - clip.from).toFixed(1)} s`,
    );
    for (const note of clip.notes) console.log(`  observed: ${note}`);
    for (const file of files) {
      const { size } = await stat(file);
      console.log(
        `  ${relative(MEDIA_ROOT, file)}  ${(size / 1024).toFixed(0)} KiB`,
      );
    }
  }
}

try {
  await main();
  await shutdown(0);
} catch (error) {
  await shutdown(1, String(error instanceof Error ? error.stack : error));
}
