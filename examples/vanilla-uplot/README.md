# Vanilla TypeScript + uPlot

Two pages with no framework, each built around one design decision of
tscache.

```sh
bun install
bun run build                                # builds the tscache package
bun run --cwd examples/vanilla-uplot dev     # http://localhost:5173/
```

The dev server also serves the shared mock backend
(`examples/mock-backend`) under `/api/`, so nothing else needs to run.

## Live server metrics (`index.html`)

A dashboard asks for the last ten minutes of server metrics every second.
The backend reports a watermark with each answer (`meta.finalizedUntil`):
request counts for the last 30 seconds are still arriving, so the points
after the watermark are provisional. The yellow band on the chart marks
them.

**Decision shown: the volatile tail.** Points before the watermark become
covered and are never fetched again. Points after it are stored but stay
outside coverage, so each poll fetches only the provisional tail and the
seconds since the previous poll, and merges it new-wins. The log shows it:
one fetch of ten minutes when the page opens, then short fetches of about
35 seconds. See `finalizedUntil` in `docs/architecture.md` §2.4 and §2.5.

**Restate history** asks the backend for a new dataset version. The next
tail fetch reports it, the cache clears itself (`cacheCleared` with reason
`version-mismatch`), and the next poll fetches the whole window again. A
backend that restated history without reporting a version would go
unnoticed (§2.4).

## Sparse event counts (`events.html`)

A week of one-minute event counts, where most slots hold no event.

**Decision shown: coverage is separate from data.** One fetch covers the
week, and coverage then records every slot of it as known, including the
roughly 9,700 slots without an event. Zoom in by dragging across the chart:
each zoom calls `get` for the new range, the cache answers it, and the log
shows no new fetch. Without coverage, an empty stretch could not be told
from one never fetched.

**Decision shown: dense segments split on long gaps.** The cache stores
points in dense segments with one presence bit per slot, and starts a new
segment wherever more than `gapSplitK` slots in a row are empty (default 4).
Memory follows the events, not the week. The week also arrives in three
backend pages: the shared fetcher loops until it holds the whole requested
range, as a fetcher against a paginated API must (§2.5).

## What else is in here

- `src/session.ts` creates the client with the worker and fetcher URLs as
  Vite serves them (`docs/guides/worker-setup.md`), and creates a new client
  when the worker is lost (`workerLost`). A worker is lost when the tab
  hosting the SharedWorker crashes.
- The fetch count and the log come from the shared fetcher, which announces
  each fetch on a `BroadcastChannel`. Open the page in a second tab: both
  tabs share one SharedWorker and one cache, so the second tab triggers no
  fetch for history the first already holds.
