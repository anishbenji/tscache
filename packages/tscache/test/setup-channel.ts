// Node has a real BroadcastChannel, and it spans every thread of the
// process. The worker entry and the hostings that post a clearAll open the
// workers' channel when the realm has one (docs/architecture.md §4.7,
// §4.10.7), so with the real one a clearAll in one test file of this package
// could clear the engine of another. It is removed here, before each of the
// package's test files: a hosting under test then behaves as in a realm
// without BroadcastChannel, and a test of the channel installs a fake one
// (test/workers-channel.ts; docs/testing.md, Shared state). Other
// workspaces keep it: the examples report their fetches over one.

import { expect } from "vitest";

if (expect.getState().testPath?.includes("/packages/tscache/test/")) {
  Reflect.deleteProperty(globalThis, "BroadcastChannel");
}
