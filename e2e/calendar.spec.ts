import { Engine, encodeSnapshot } from "../packages/tscache/src/entries/engine";
import {
  cacheConfig,
  connect,
  expect,
  hydrateEncoded,
  open,
  put,
  read,
  stored,
  test,
  workerUrl,
} from "./support";

// Calendar grids in the browser (architecture §2.2, §2.8, §4.10; design §9
// tests 21 and 22): the worker computes slot starts from the browser's own
// time-zone data, a Node engine's snapshot from Node's. The instants are New
// York session opens of 2026, whose rules are settled: 14:30 UTC in winter,
// 13:30 UTC from 8 March.

const daily = () =>
  cacheConfig({
    interval: { unit: "day", zone: "America/New_York", at: "09:30" },
    alignmentOffset: 0,
  });

const winter = [Date.UTC(2026, 2, 5, 14, 30), Date.UTC(2026, 2, 6, 14, 30)];
const summer = [Date.UTC(2026, 2, 9, 13, 30), Date.UTC(2026, 2, 10, 13, 30)];
const sessions = [...winter, ...summer];
const shown = { start: winter[0] as number, end: summer[1] as number };
/** What `put` stores as volume: the timestamp, as an i16 holds it. */
const volumes = (timestamps: number[]) =>
  Array.from(new Int16Array(timestamps));

test("two tabs share a New York daily cache across the start of daylight saving", async ({
  context,
}) => {
  const config = daily();
  const a = await open(context);
  const b = await open(context);
  expect((await connect(a, { workerUrl })).mode).toBe("shared");
  expect((await connect(b, { workerUrl })).mode).toBe("shared");
  await put(a, config, sessions);
  // The other tab reads the same worker's cache, at the session opens of
  // both seasons; the weekend between them is covered and holds no bar.
  expect(await read(b, config, shown, { cacheOnly: true })).toEqual({
    timestamps: sessions,
    volume: volumes(sessions),
    coverage: [shown],
    misses: [],
  });
  // An instant an hour off a summer open is no slot start: it snaps outward
  // to the sessions around it.
  const off = (summer[0] as number) + 3_600_000;
  expect(
    (await read(b, config, { start: off, end: off }, { cacheOnly: true }))
      .timestamps,
  ).toEqual(summer);
});

test("a snapshot rendered by a Node engine hydrates in the browser", async ({
  context,
}) => {
  const config = daily();
  // The server: an engine in this Node process, with Node's zone data.
  const server = new Engine();
  server.cache(config);
  server.put(config.id, {
    timestamps: sessions,
    fields: { price: sessions, volume: volumes(sessions) },
  });
  const snapshot = server.snapshot(config.id, shown);
  expect(snapshot.format).toBe(2);
  // As a page carries it: JSON text of the encoded snapshot (N38).
  const html = JSON.stringify(encodeSnapshot(snapshot));

  const page = await open(context);
  await connect(page, { workerUrl });
  // The browser's zone data places every anchor in the slot the server
  // gave it, so the snapshot applies in full.
  expect(await hydrateEncoded(page, config, html)).toEqual({
    applied: [shown],
  });
  expect(await read(page, config, shown, { cacheOnly: true })).toEqual({
    timestamps: sessions,
    volume: volumes(sessions),
    coverage: [shown],
    misses: [],
  });
});

test("a persisted calendar cache reloads from IndexedDB without a fetch", async ({
  context,
  backend,
}) => {
  const config = { ...daily(), persist: true };
  const a = await open(context);
  expect((await connect(a, backend.clientOptions())).mode).toBe("shared");
  await put(a, config, sessions);
  // Written behind, after the quiet spell.
  await expect
    .poll(() => stored(a, config.id))
    .toEqual({ caches: 1, pages: 1 });
  // A reload: the same worker script under another URL is a new
  // SharedWorker, whose engine knows nothing and loads from the disk.
  const b = await open(context);
  const options = {
    ...backend.clientOptions(),
    workerUrl: "/dist/worker.js?session=2",
  };
  expect((await connect(b, options)).mode).toBe("shared");
  // A fetching read: the stored records cover the range, so nothing is asked.
  expect(await read(b, config, shown)).toEqual({
    timestamps: sessions,
    volume: volumes(sessions),
    coverage: [shown],
    misses: [],
  });
  expect((await backend.state()).requests).toEqual({});
});
