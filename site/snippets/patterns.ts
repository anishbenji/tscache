import type { CacheHandle } from "tscache";

// #region expiry
// A one-minute series whose previous UTC day a batch rewrites at 02:00:
// once the batch has run, forget that day, and the next get fetches it.
const DAY = 86_400_000;
const MINUTE = 60_000;
export function forgetYesterday(cache: CacheHandle): Promise<void> {
  const today = Math.floor(Date.now() / DAY) * DAY;
  return cache.invalidate({ start: today - DAY, end: today - MINUTE });
}
// #endregion expiry

// #region retry
// Misses never reject: retry what failed, after a pause of your choosing.
export async function readWithRetry(
  cache: CacheHandle,
  range: { start: number; end: number },
) {
  const first = await cache.get(range);
  if (!first.misses.some((miss) => miss.reason === "fetch-failed"))
    return first;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return cache.get(range);
}
// #endregion retry
