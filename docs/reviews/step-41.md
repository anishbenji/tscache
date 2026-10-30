# Step 41 — Reference clients draw a live bar by its newest bars

Branch: `feat/41-reference-live-update` · Reviewer: Codex (high) · Rounds: 1 · Status: fixes applied after round 1

Item 8 of the performance plan of 2026-10-30: each live tick handed the chart a new answer, and the Lightweight Charts view drew it with a `setData` of every bar (about 720 on the opening range). A view now remembers the answer it drew; when the next one differs from it only in its newest bars, the Lightweight Charts view passes just those to `series.update()`. Any other change still takes `setData`. Built by an implementation child while the user was away, under the user's grant of 2026-10-30. Reference code only: nothing in `packages/tscache` changed.

## Scope

| Commit | What |
|---|---|
| b60c568 | `feat(reference)`: `appendedFrom(before, after)` in `reference/shared/src/chart/view.ts`, the pure decision. It returns the index of the first bar to draw (the last drawn bar when that bar, the forming one, changed; the drawn count when only new bars did), or `undefined` when every bar must be drawn again. Tests: `reference/shared/test/appended.test.ts` (15), written first |
| 6d3de70 | `perf(reference)`: the Lightweight Charts view draws by `update()` when `appendedFrom` allows it; the uPlot view keeps its one `setData` (below). Both count their draws of each kind on their element (`countDraw`: `data-draws-full`, `data-draws-appended`). E2E: three tests per client in `e2e/reference/clients.spec.ts` |
| 3ad5b92 | `reference/README.md` (the chart bullet), and this file |
| e3d81c1 | `test(reference)`, R1-1: each chart view against a stand-in for its library, `reference/shared/test/lightweight-view.test.ts` (7) and `uplot-view.test.ts` (4); the test answers move to `test/answers.ts` |
| (this commit) | Round 1 triage |

The branch was rebased onto `main` at `15fa506` after the first three commits; their measurements below name the hashes they were taken at, before the rebase (`e0bcf85`, `fcfc1be`, `22d381c`).

## Decisions

- **The decision goes by the bars alone.** `appendedFrom` compares timestamps and every field of the two answers, NaN equal to NaN. Every bar before the last drawn one must be equal, the last drawn bar may change (it is the one forming, or a closed bar's final values), and bars after it are new. A moved range, a gap filled or opened, an earlier bar's values, other fields, an empty previous answer or an answer without bars all draw in full. The cost is one comparison per bar and field, against the chart library's redraw.
- **A new dataset version needs no signal of its own.** The chart sees only answers; a version change reaches it as what it changes: the cleared cache answers fewer bars, then the history is read again with its own values, and both draw in full. Where a new version left every drawn value as it was, an incremental draw shows the same bars a full one would. A unit test and an e2e test (`bumpVersion`) cover it.
- **A switched series or chart library starts in full** because a new view has drawn nothing; the decision needs no input for it.
- **uPlot keeps `setData`.** uPlot has no call that adds points: it redraws its canvas from its arrays on any change, its streaming demos call `setData` on each tick, and its docs state that data changed in place still needs `setData` (context7, `/leeoniya/uplot`, "Redraw and extrema caches"). The view already passes the cache's typed arrays without a copy, so a live bar takes the same `setData(…, false)` as before. The view still runs the decision, for the draw count.
- **The test hook is two data attributes on the chart element**, written by the shared views, so all three clients get it without framework code and the server-rendered markup is unchanged (the views exist only in the browser). No client file changed.
- **`series.update()` per bar.** The candle and the volume series each take the changed bars in order; for the forming bar it replaces the last one, for a later bar it appends, which is what the decision guarantees (Lightweight Charts requires a time at or after the last bar's without `historicalUpdate`).

## Evidence

**Unit tests first.** Before the implementation, `bunx vitest run reference/shared/test/appended.test.ts` failed 15 of 15 (`TypeError: appendedFrom is not a function`); after it, 15 passed. They cover: one bar appended; the forming bar updated; the forming bar updated with bars after it; several bars appended; the same bars again; an earlier bar's price or volume changed; a gap filled; a gap opened; the range moved on, moved back and narrowed; no previous answer and an empty one; an answer without bars; NaN kept, NaN filled in, a value lost to NaN, and a forming bar gaining or losing a value; the history under a new version; fields dropped or renamed.

**Mutation checks.** Comparing with `===` alone (NaN never equal) fails 1 test; dropping the check of the bars before the last drawn one fails 3.

**E2E tests first.** New in `e2e/reference/clients.spec.ts`, for each of the vanilla, React and Solid clients:
- `a live bar draws only the newest bars, not every bar (lightweight, step 41)` and `(uplot, step 41)`: after the opening draw, two live bars under the SSE feed raise the appended count by at least two and leave the full count unchanged;
- `a dataset version pushed with a bar draws every bar again (step 41)`.

On the base (the new tests against the unchanged views), each of the nine failed with `Expected: > 0, Received: 0`:

```sh
~/code/tscache-reports/bin/heavy-run.sh "live child: e2e base" bash -c 'export E2E_EXAMPLES=reference-vanilla,reference-react,reference-solid; for g in "newest bars, not every bar .lightweight" "newest bars, not every bar .uplot" "draws every bar again"; do bunx playwright test e2e/reference --project examples -g "$g"; done'
```

On fcfc1be the whole reference suite passed, the 53 existing tests unchanged and the 9 new ones: `~/code/tscache-reports/bin/heavy-run.sh "live child: e2e reference head" env E2E_EXAMPLES=reference-vanilla,reference-react,reference-solid bunx playwright test e2e/reference --project examples` → `62 passed (1.6m)`.

**Trace, base against head (not a gate).** Base `3eeac21` (a detached worktree, `git worktree add --detach /tmp/tscache-live41-base 3eeac21`, then `bun install --frozen-lockfile` and `bun run build`), head `fcfc1be`. Apple Silicon Mac, Playwright's Chromium 153, headless. The script (below) builds and previews `reference/vanilla`, opens `/?feed=sse&chart=<chart>`, waits five seconds after the page is live, then traces 30 seconds: 30 ticks, one answer drawn per tick. It reports, per tick, the union of the renderer main thread's script events (`v8.callFunction`, which runs the worker's answers, `FunctionCall`, `FireAnimationFrame`, timers, events, microtasks, compiles) and the union of all its tasks (`RunTask`), which adds style, layout, paint and commit. Runs alternated base and head:

```sh
~/code/tscache-reports/bin/heavy-run.sh "live child: trace" bash -c 'T=.reviews/step-41/trace-live.ts; for r in 1 2 3; do bun $T /tmp/tscache-live41-base 24141 30 lightweight; bun $T $PWD 24142 30 lightweight; done; bun $T /tmp/tscache-live41-base 24141 30 uplot; bun $T $PWD 24142 30 uplot'
```

| Chart | Build | Scripting per tick (ms), three runs | Median | Main-thread tasks per tick (ms) | Median |
|---|---|---|---:|---|---:|
| Lightweight Charts | base | 4.77, 5.09, 5.42 | 5.09 | 9.61, 10.17, 10.69 | 10.17 |
| Lightweight Charts | head | 4.29, 4.04, 4.22 | 4.22 | 9.73, 9.47, 9.13 | 9.47 |
| uPlot | base | 1.44 | | 24.36 | |
| uPlot | head | 1.51 | | 24.91 | |

On Lightweight Charts a tick costs about 0.9 ms (17 %) less script and 0.7 ms (7 %) less main-thread time; every head run is below every base run. The gain is in the handler that draws the answer: an earlier pass whose filter left out `v8.callFunction` (so counted mostly the chart's animation-frame render) showed no difference (base 2.83 and 3.32 ms, head 3.41 and 3.43 ms), since Lightweight Charts still repaints its visible canvas each frame. uPlot is unchanged, as expected. Its main-thread tasks are mostly time the trace does not attribute to any child event; that is outside this step.

<details>
<summary><code>.reviews/step-41/trace-live.ts</code></summary>

```ts
// Main-thread time per live tick on the reference vanilla page under the
// SSE feed, from a Chromium performance trace (step 41, not a gate).
//
//   bun .reviews/step-41/trace-live.ts <checkout> <port> [seconds] [chart]
//
// Builds and previews <checkout>/reference/vanilla (the checkout's
// package must be built), opens /?feed=sse&chart=<chart>, lets the opening
// reads settle, then traces <seconds> of live ticks. A tick is one change
// of the page's "drawn" time, written once per answer drawn. Reports the
// union of the renderer main thread's scripting events (as DevTools files
// them under Scripting) and of all its tasks, each per tick.

import { type ChildProcess, spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const [root, portArg, secondsArg = "30", chart = "lightweight"] =
  process.argv.slice(2);
if (root === undefined || portArg === undefined) {
  throw new Error("usage: trace-live.ts <checkout> <port> [seconds] [chart]");
}
const port = Number(portArg);
const seconds = Number(secondsArg);
const app = `${root}/reference/vanilla`;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

async function waitUp(url: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not start`);
}

const SCRIPTING = new Set([
  "FunctionCall",
  "v8.callFunction",
  "EvaluateScript",
  "TimerFire",
  "EventDispatch",
  "FireAnimationFrame",
  "RunMicrotasks",
  "FireIdleCallback",
  "v8.compile",
  "v8.evaluateModule",
]);

interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: { name?: string };
}

/** The total length of the union of [ts, ts + dur) intervals, in ms. */
function union(events: TraceEvent[]): number {
  const spans = events
    .map((e) => [e.ts, e.ts + (e.dur ?? 0)] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = [-1, -1];
  for (const [s, e] of spans) {
    if (s > end) {
      total += end - start;
      [start, end] = [s, e];
    } else end = Math.max(end, e);
  }
  return (total + end - start) / 1000;
}

let server: ChildProcess | undefined;
try {
  await run("bun", ["run", "--cwd", app, "build"]);
  server = spawn(
    "bun",
    [
      "run",
      "--cwd",
      app,
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { stdio: "ignore" },
  );
  const base = `http://127.0.0.1:${port}`;
  await waitUp(`${base}/`);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/?feed=sse&chart=${chart}`);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="connection"]')?.textContent ===
      "live",
  );
  await page.waitForTimeout(5000);
  await page.evaluate(() => {
    const drawn = document.querySelector('[data-testid="drawn"]');
    const counter = globalThis as { ticks?: number };
    counter.ticks = 0;
    new MutationObserver(() => {
      counter.ticks = (counter.ticks ?? 0) + 1;
    }).observe(drawn as Node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await browser.startTracing(page, {
    categories: [
      "toplevel",
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "v8",
    ],
  });
  await page.waitForTimeout(seconds * 1000);
  const buffer = await browser.stopTracing();
  const ticks = await page.evaluate(
    () => (globalThis as { ticks?: number }).ticks ?? 0,
  );
  const draws = await page
    .locator("#chart")
    .evaluate((el) => ({ ...el.dataset }));
  await browser.close();

  const { traceEvents } = JSON.parse(buffer.toString()) as {
    traceEvents: TraceEvent[];
  };
  // The page's main thread: the CrRendererMain with the most events.
  const mains = traceEvents
    .filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain")
    .map((e) => `${e.pid}:${e.tid}`);
  const count = (key: string) =>
    traceEvents.filter((e) => `${e.pid}:${e.tid}` === key).length;
  const main = mains.sort((a, b) => count(b) - count(a))[0];
  const onMain = traceEvents.filter(
    (e) => `${e.pid}:${e.tid}` === main && e.ph === "X",
  );
  if (process.env.DUMP) {
    const by = new Map<string, number>();
    for (const e of onMain) by.set(e.name, (by.get(e.name) ?? 0) + (e.dur ?? 0));
    const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.error(top.map(([n, d]) => `${n} ${(d / 1000).toFixed(1)}`).join("\n"));
  }
  const scripting = union(onMain.filter((e) => SCRIPTING.has(e.name)));
  const tasks = union(onMain.filter((e) => e.name === "RunTask"));
  console.log(
    JSON.stringify({
      root,
      chart,
      seconds,
      ticks,
      draws,
      scriptingMs: Number(scripting.toFixed(1)),
      tasksMs: Number(tasks.toFixed(1)),
      scriptingMsPerTick: Number((scripting / ticks).toFixed(2)),
      tasksMsPerTick: Number((tasks / ticks).toFixed(2)),
    }),
  );
} finally {
  server?.kill();
}
```

</details>

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | The new e2e tests do not show that the series get the bars: removing both `series.update()` loops leaves them passing, since the draw counters record `appendedFrom`'s verdict and `nextDraw` watches the answer's time | accepted | fixed in e3d81c1 |

**R1-1, validated.** With both loops deleted from `lightweight.ts`, `~/code/tscache-reports/bin/heavy-run.sh "live child: r1 validate" env E2E_EXAMPLES=reference-vanilla,reference-react,reference-solid bunx playwright test e2e/reference --project examples -g "step 41"` passed 9 of 9. The finding holds: the counters prove the decision is wired, not the drawing.

**Fix.** Unit tests of each view against a stand-in for its library (`vi.mock`), which observe what the library receives:
- `lightweight-view.test.ts` (7). The stand-in series keep their bars as Lightweight Charts documents `setData()` (replace all) and `update()` (replace the last bar at the same time, add one after it, refuse an earlier time). After each draw the test checks the calls each series got and that both the candle and the volume series hold every bar of the answer, values and volume colour included: the first answer and an earlier correction or a moved range through `setData()`; an appended bar, the updated forming bar, and the forming bar with bars after it through `update()`; and six live answers in a row, alternately moving the forming bar and opening a new one, after a single `setData()`.
- `uplot-view.test.ts` (4). For an appended bar, the forming bar, an earlier correction and a moved range, the draw hands uPlot `setData([timestamps, open, high, low, close, volume], false)` with the answer's own arrays.

**Mutation checks**, `bunx vitest run reference/shared/test`:
- both `update()` loops deleted: 4 of the 7 Lightweight tests fail (every `update()` case; the three `setData()` cases pass);
- only the volume loop deleted: the same 4 fail;
- uPlot skipping `setData` for an answer `appendedFrom` accepts: 2 of 4 fail (the appended and forming-bar cases).

Each mutation was undone; the suite then passed 37 of 37. The e2e tests are unchanged: they still show, in the browser, that a live bar under the SSE feed takes the incremental path and a new version the full one.

## What was not verified

- That every e2e test would fail with the hook present but every draw full: the assertion `after.full === before.full` would catch it, but that mutation was not run in the browser.
- What Lightweight Charts itself paints after `update()`: the unit tests use a stand-in that follows its documented semantics, and the e2e tests read the draw counters, not the library's series.
- Firefox and WebKit: the reference suite runs on Chromium only.
- The trace on a slower machine or with more bars on screen; the numbers above are from one machine.

## Contract-test changes

None. No existing test's assertions changed; `appended.test.ts` now imports its answers from `test/answers.ts`.

## Decision concerns

None.
