// Fixture fetcher for the Playwright suites: asks the mock backend
// (scripts/e2e-backend.ts) over HTTP with the token from its context. volume
// carries how many times the backend has been asked for that exact range, so
// the data shows whether two tabs shared one fetch.

// A URL on the e2e server, which serves the built package under /dist; there
// is no such path in the repository.
// fallow-ignore-next-line unresolved-import
import { AuthInvalidError } from "/dist/fetcher.js";

export default {
  async fetch({ range, interval, alignmentOffset, context }) {
    const query = new URLSearchParams({
      start: String(range.start),
      end: String(range.end),
      interval: String(interval),
      offset: String(alignmentOffset),
    });
    const response = await fetch(`/backend/${context.ns}/candles?${query}`, {
      headers: { authorization: `Bearer ${context.token}` },
    });
    if (response.status === 401) {
      throw new AuthInvalidError(`candles refused token ${context.token}`);
    }
    if (!response.ok) throw new Error(`candles answered ${response.status}`);
    const { timestamps, version, calls } = await response.json();
    return {
      timestamps,
      fields: { price: timestamps, volume: timestamps.map(() => calls) },
      meta: { version },
    };
  },
};
