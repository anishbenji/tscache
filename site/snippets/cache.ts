import { createClient, PutError } from "tscache";

const client = await createClient({ mode: "in-process" });
const MINUTE = 60_000;

// #region config
const cache = await client.cache({
  id: "sensor/42",
  interval: MINUTE, // required
  alignmentOffset: 0, // timestamps satisfy (t - offset) % interval === 0
  fields: { temperature: "f32", errors: "u16" },
  gapSplitK: 4, // default 4
  segmentSlotCap: 32_768, // default 32 768
  version: "2026-10", // opt-in dataset version
  warnOnOverlapDiff: false, // default false
});
// #endregion config

// #region put
const t0 = Date.UTC(2026, 9, 30, 9, 0);
// Without a range: adds or overwrites these points, claims their own span.
await cache.put({
  timestamps: [t0, t0 + MINUTE, t0 + 2 * MINUTE],
  fields: { temperature: [21.5, 21.7, Number.NaN], errors: [0, 0, 1] },
});
// With a range: the answer for 09:00–09:59, so the slots without a point
// become confirmed gaps, and points the batch omits are removed.
const { warnings } = await cache.put(
  {
    timestamps: new Float64Array([t0, t0 + MINUTE]),
    fields: {
      temperature: new Float32Array([21.5, 21.8]),
      errors: new Uint16Array([0, 0]),
    },
  },
  { range: { start: t0, end: t0 + 59 * MINUTE } },
);
console.log(warnings); // non-empty only with warnOnOverlapDiff
// The typed arrays above were transferred to the worker: they are now
// detached. Pass copies if you still need them.
// #endregion put

// #region put-error
try {
  await cache.put({
    timestamps: [t0 + 30_000],
    fields: { temperature: [20], errors: [0] },
  });
} catch (error) {
  if (error instanceof PutError) {
    console.log(error.code, error.offenderIndex, error.expected);
    // "misaligned" 0 "t ≡ 0 (mod 60000)"
  }
}
// #endregion put-error

// #region get
const hour = { start: t0, end: t0 + 59 * MINUTE };
const result = await cache.get(hour, { cacheOnly: true });
console.log(result.timestamps.length, result.coverage, result.misses);
// #endregion get

// #region invalidate
// Forget what is known about the range; the next get fetches it again.
// The points stay readable until then.
await cache.invalidate(hour);
// #endregion invalidate

// #region watermark
// Points at or after 10:00 are provisional: stored, never covered.
await cache.setFinalizedUntil(t0 + 60 * MINUTE);
// #endregion watermark

// #region events
const unsubscribe = cache.on("cacheCleared", ({ reason }) => {
  console.log("cleared", reason); // "manual", "clear-all" or "version-mismatch"
});
await cache.clear(); // with a SharedWorker, every tab's view of this cache
unsubscribe();
// #endregion events
