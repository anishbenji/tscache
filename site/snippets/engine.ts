// #region engine
import { Engine, PutError } from "tscache/engine";

const engine = new Engine();
const DAY = 86_400_000;
engine.cache({ id: "daily", interval: DAY, fields: { close: "f64" } });

engine.on("cacheCleared", ({ cacheId, reason }) => {
  console.log(cacheId, reason);
});

const monday = Date.UTC(2026, 9, 26);
// Synchronous: no worker, no port, no fetcher.
engine.put(
  "daily",
  { timestamps: [monday, monday + DAY], fields: { close: [101, 102] } },
  { range: { start: monday, end: monday + 6 * DAY } }, // the weekend is a confirmed gap
);
const week = engine.get("daily", { start: monday, end: monday + 6 * DAY });
console.log(week.timestamps.length, week.coverage, week.misses); // 2, one range, []

// A snapshot without a read, for persistence or a test.
const snapshot = engine.snapshot("daily", {
  start: monday,
  end: monday + 6 * DAY,
});
const other = new Engine();
other.cache({ id: "daily", interval: DAY, fields: { close: "f64" } });
console.log(other.hydrate("daily", snapshot).applied);

try {
  engine.put("daily", { timestamps: [monday + 1], fields: { close: [1] } });
} catch (error) {
  if (error instanceof PutError) console.log(error.code); // "misaligned"
}

// #endregion engine

// Read by `bun run docs:run`, which checks what the example produced.
export { other, week };
