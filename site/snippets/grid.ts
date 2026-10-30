import { createClient } from "tscache";

// No fetcher: nothing loads, so a read returns its snapped range as a miss.
const client = await createClient({ mode: "in-process" });

// #region offset
const daily = await client.cache({
  id: "candles/ACME/1d",
  interval: 86_400_000,
  alignmentOffset: 52_200_000, // 14:30 UTC, the market's open
  fields: { open: "f64", high: "f64", low: "f64", close: "f64" },
});
// #endregion offset

// #region snap
// Not on the grid: read outward, from the open at or before the start to
// the open at or after the end.
const week = await daily.get({
  start: Date.UTC(2026, 9, 26, 9, 0),
  end: Date.UTC(2026, 9, 30, 9, 0),
});
console.log(week.misses[0]?.range); // 25 Oct 14:30 UTC to 30 Oct 14:30 UTC
// #endregion snap
