// Fixture fetcher for the Playwright suite: answers every aligned slot of the
// requested range with price = t and volume = how many times this module
// instance has been asked. Two pages sharing one SharedWorker therefore see
// volume 1 everywhere when their identical requests were deduplicated.
let calls = 0;

export default {
  async fetch(req) {
    calls += 1;
    // Hold the answer when asked (context.delayMs) so concurrent gets from
    // several pages are really in flight together, not served from cache.
    const delay = req.context && req.context.delayMs;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const first =
      Math.ceil((req.range.start - req.alignmentOffset) / req.interval) *
        req.interval +
      req.alignmentOffset;
    const timestamps = [];
    for (let t = first; t <= req.range.end; t += req.interval)
      timestamps.push(t);
    return {
      timestamps,
      fields: { price: timestamps, volume: timestamps.map(() => calls) },
    };
  },
};
