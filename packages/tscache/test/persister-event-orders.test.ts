import { orderTests } from "./persist-orders";

// Every short order of events around the Persister's deferred cleanup (step
// 132, Codex gate round 3): `persist-orders.ts` has the events, the
// outcomes, the properties and the bound.

orderTests(false);
