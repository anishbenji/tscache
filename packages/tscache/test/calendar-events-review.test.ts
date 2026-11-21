import { afterEach, expect, it } from "vitest";
import { Engine, useCalendarGridContext } from "../src/engine/engine";
import { PortClient } from "../src/rpc/port-client";
import type { MessagePortLike } from "../src/rpc/protocol";
import { RpcServer } from "../src/rpc/server";
import type { ClientEvents, HydrateResult, Snapshot } from "../src/types";
import {
  batch,
  DAY,
  engine,
  HOUR,
  ID,
  NY,
  probe,
  span,
} from "./calendar-contract-helpers";

// Implementer test added after security lane 2 of step 129
// (docs/reviews/step-129.md, S2.1).

const daily = { unit: "day", zone: NY, at: "09:30" } as const;
const winter = () => -5 * HOUR;
const dailyStart = (slot: number) => slot * DAY + 14.5 * HOUR;

const ports: PortClient[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.dispose();
});

// S2.1 (§2.8, §4.5): the charge bounds a snapshot's validation and its
// application into a cache that knows nothing. What the worker then tells
// subscribed readers is outside it: each range of the call's cacheChanged
// is converted once more, at most 12 lookups a range.
it("17: with a subscribed reader a hydrate adds at most 12 lookups for each range of its event", async () => {
  const ranges = 200;
  const first = 40 * 512 + 20;
  const writer = engine(daily, {}, probe(winter).context);
  for (let i = 0; i < ranges; i++) {
    writer.put(ID, batch([dailyStart(first + 2 * i)]));
  }
  const all = span(dailyStart(first), dailyStart(first + 2 * (ranges - 1)));
  const snapshot: Snapshot = writer.snapshot(ID, all);
  expect(snapshot.coverage).toHaveLength(ranges);
  const charge =
    24 + 36 * snapshot.coverage.length + 12 * snapshot.segments.length;

  // No reader: the engine's own work, within the charge.
  const alone = probe(winter);
  const quiet = engine(daily, {}, alone.context);
  quiet.hydrate(ID, snapshot);
  expect(alone.lookups.length).toBeLessThanOrEqual(charge);

  // The same hydrate through a worker's server, with a tab subscribed.
  const { context, lookups } = probe(winter);
  const hosted = new Engine();
  useCalendarGridContext(hosted, context);
  const server = new RpcServer(hosted, "0.0.0");
  const channel = new MessageChannel();
  server.attach(channel.port1 as MessagePortLike);
  const port = await PortClient.connect(channel.port2 as MessagePortLike, {});
  ports.push(port);
  const events: ClientEvents["cacheChanged"][] = [];
  port.on((evt) => {
    if (evt.event === "cacheChanged") {
      events.push(evt.payload as ClientEvents["cacheChanged"]);
    }
  });
  await port.request("cache", {
    id: ID,
    interval: daily,
    fields: { value: "f64" },
  });
  await port.request("subscribe", { cacheId: ID });
  lookups.length = 0;
  const result = (await port.request("hydrate", {
    cacheId: ID,
    snapshot,
  })) as HydrateResult;
  expect(result.applied).toEqual(snapshot.coverage);
  // The event came before the answer, with one range for each part.
  expect(events).toHaveLength(1);
  expect(events[0]?.written).toEqual(snapshot.coverage);
  const reported =
    (events[0]?.written.length ?? 0) + (events[0]?.removed.length ?? 0);
  // More than the charge, which is the point of the narrower claim...
  expect(lookups.length).toBeGreaterThan(alone.lookups.length);
  // ...and within the stated bound.
  expect(lookups.length).toBeLessThanOrEqual(charge + 12 * reported);
  expect(context.tableCount).toBe(0);
});
