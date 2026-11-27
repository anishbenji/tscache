import { orderTests } from "./persist-orders";

// Every short order of events around the SharedWorker hosting's deferred
// cleanup, the chunk's import included (step 132, Codex gate round 3):
// `persist-orders.ts` has the events, the outcomes, the properties and the
// bound.

orderTests(true);
