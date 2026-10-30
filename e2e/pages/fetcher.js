// Fixture fetcher for the Playwright suites: asks the mock backend
// (scripts/e2e-backend.ts) over HTTP with the token from its context. volume
// carries how many times the backend has been asked for that exact range, so
// the data shows whether two tabs shared one fetch. It asks for a columns
// body (examples/mock-backend/src/columns.ts), or for JSON when its context
// has `format: "json"`, which the end-to-end bench uses to compare the two.

// URLs on the e2e server, which serves the built package under /dist and
// the columns decoder at /columns.js; there are no such paths in the
// repository.
// fallow-ignore-next-line unresolved-import
import { COLUMNS_TYPE, decodeColumns } from "/columns.js";
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
    const headers = { authorization: `Bearer ${context.token}` };
    if (context.format !== "json") headers.accept = COLUMNS_TYPE;
    const response = await fetch(`/backend/${context.ns}/candles?${query}`, {
      headers,
    });
    if (response.status === 401) {
      throw new AuthInvalidError("candles refused the access token");
    }
    if (!response.ok) throw new Error(`candles answered ${response.status}`);
    if (response.headers.get("content-type") === COLUMNS_TYPE) {
      const { header, timestamps } = decodeColumns(
        await response.arrayBuffer(),
      );
      return {
        timestamps,
        fields: {
          price: timestamps,
          volume: new Int16Array(timestamps.length).fill(header.calls),
        },
        meta: { version: header.version },
      };
    }
    const { timestamps, version, calls } = await response.json();
    return {
      timestamps,
      fields: { price: timestamps, volume: timestamps.map(() => calls) },
      meta: { version },
    };
  },
};
