import {
  ConfigError,
  createClient,
  InvalidRangeError,
  isAuthInvalidError,
  ProtocolMismatchError,
} from "tscache";
import workerUrl from "tscache/worker?worker&url";

// #region connect
try {
  await createClient({ workerUrl });
} catch (error) {
  if (error instanceof ProtocolMismatchError) {
    // A stale cached worker script, or two package versions: reload.
    console.log(error.clientProtocol, error.workerProtocol);
  } else if (error instanceof ConfigError) {
    console.log("bad options:", error.message);
  } else {
    throw error; // TscacheError: e.g. the fetcher module failed to load
  }
}
// #endregion connect

const client = await createClient({ mode: "in-process" });

// #region config
await client.cache({ id: "a", interval: 60_000, fields: { v: "f64" } });
try {
  // Same id, another structure: refused, the live cache is untouched.
  await client.cache({ id: "a", interval: 1_000, fields: { v: "f64" } });
} catch (error) {
  console.log(error instanceof ConfigError); // true
}
// #endregion config

// #region range
const cache = await client.cache({
  id: "a",
  interval: 60_000,
  fields: { v: "f64" },
});
try {
  await cache.get({ start: 10, end: 0 });
} catch (error) {
  console.log(error instanceof InvalidRangeError); // true: start > end
}
// #endregion range

// #region marker
// Inside a fetcher wrapper: recognise the auth signal by its marker, never
// by instanceof (the fetcher bundle may hold its own copy of the class).
function rethrowAuth(error: unknown): void {
  if (isAuthInvalidError(error)) throw error;
}
// #endregion marker
rethrowAuth(undefined);
