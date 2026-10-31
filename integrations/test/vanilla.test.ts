import type { GetOptions, Range } from "tscache";
import { afterEach, describe, expect, it } from "vitest";
import { type Connection, connect } from "../shared/connection";
import { type Answer, series } from "../vanilla/series";
import { config, type Lossy, lossy, until } from "./helpers";

const open: Connection[] = [];
afterEach(async () => {
  for (const connection of open.splice(0)) await connection.dispose();
});

async function connected() {
  const clients: Lossy[] = [];
  const connection = connect(async () => {
    const next = await lossy();
    clients.push(next);
    return next.client;
  });
  open.push(connection);
  await until(() => connection.state.status === "connected");
  return { connection, clients };
}

function recorder(connection: Connection) {
  const answers: Answer[] = [];
  const failures: unknown[] = [];
  const chart = series(connection, {
    config,
    render: (answer) => answers.push(answer),
    fail: (error) => failures.push(error),
  });
  return { chart, answers, failures };
}

const a: Range = { start: 0, end: 100 };
const b: Range = { start: 100, end: 200 };

describe("series", () => {
  it("renders the answer for the range shown", async () => {
    const { connection } = await connected();
    const { chart, answers } = recorder(connection);
    chart.show(a);
    await until(() => answers.length === 1);
    expect(answers[0]?.range).toEqual(a);
    expect(answers[0]?.result.misses).toEqual([
      { range: { start: 0, end: 100 }, reason: "uncached" },
    ]);
  });

  it("renders only the latest range's answer", async () => {
    const { connection } = await connected();
    const { chart, answers } = recorder(connection);
    chart.show(a);
    chart.show(b);
    await until(() => answers.length > 0);
    // clock-ok: an absence check; a slow machine can only hide a late answer, not fail the test.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answers.map((answer) => answer.range)).toEqual([b]);
  });

  it("waits for the connection, then reads", async () => {
    const late = connect(async () => (await lossy()).client);
    open.push(late);
    const { chart, answers } = recorder(late);
    chart.show(a);
    expect(answers).toEqual([]);
    await until(() => answers.length === 1);
  });

  it("reads again on the client that replaces a lost one, without reporting the loss", async () => {
    const { connection, clients } = await connected();
    const { chart, answers, failures } = recorder(connection);
    chart.show(a);
    await until(() => answers.length === 1);
    clients[0]?.lose();
    await until(() => answers.length === 2);
    expect(clients).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it("reports a failed read on a live client", async () => {
    const { connection } = await connected();
    const { chart, failures } = recorder(connection);
    chart.show({ start: Number.NaN, end: 0 });
    await until(() => failures.length === 1);
  });

  it("reports a connection that failed", async () => {
    const connection = connect(() => Promise.reject(new Error("no worker")));
    open.push(connection);
    const { chart, failures } = recorder(connection);
    chart.show(a);
    await until(() => failures.length === 1);
    expect(failures[0]).toEqual(new Error("no worker"));
  });

  it("refresh() reads the range on screen from the cache alone", async () => {
    const { connection, clients } = await connected();
    const client = clients[0]?.client;
    if (client === undefined) throw new Error("not connected");
    const asked: (GetOptions | undefined)[] = [];
    const real = client.cache.bind(client);
    client.cache = async (c) => {
      const cache = await real(c);
      const get = cache.get.bind(cache);
      cache.get = (range, options) => {
        asked.push(options);
        return get(range, options);
      };
      return cache;
    };
    const { chart, answers } = recorder(connection);
    chart.show(a);
    await until(() => answers.length === 1);
    const cache = await connection.cache(client, config);
    await cache.put({
      timestamps: [50, 140],
      fields: { v: [1, 3], n: [2, 4] },
    });
    chart.refresh();
    await until(() => answers.length === 2);
    expect(Array.from(answers[1]?.result.timestamps ?? [])).toEqual([50]);
    // A range past the one on screen, as for a bar pushed after it.
    chart.refresh({ start: 0, end: 150 });
    await until(() => answers.length === 3);
    expect(answers[2]?.range).toEqual({ start: 0, end: 150 });
    expect(Array.from(answers[2]?.result.timestamps ?? [])).toEqual([50, 140]);
    expect(asked).toEqual([
      { cacheOnly: false },
      { cacheOnly: true },
      { cacheOnly: true },
    ]);
  });

  it("refresh() is skipped while a show() is in flight", async () => {
    const { connection } = await connected();
    const { chart, answers } = recorder(connection);
    chart.show(a);
    chart.refresh();
    await until(() => answers.length === 1);
    // clock-ok: an absence check; a slow machine can only hide a late answer, not fail the test.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answers).toHaveLength(1);
  });

  it("reads nothing once disposed, whoever calls show() or refresh()", async () => {
    const { connection } = await connected();
    const { chart, answers } = recorder(connection);
    chart.dispose();
    chart.show(a);
    chart.refresh(b);
    // clock-ok: an absence check; a slow machine can only hide a late answer, not fail the test.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answers).toEqual([]);
  });

  it("drops an answer in flight when disposed", async () => {
    const { connection } = await connected();
    const { chart, answers } = recorder(connection);
    chart.show(a);
    chart.dispose();
    // clock-ok: an absence check; a slow machine can only hide a late answer, not fail the test.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answers).toEqual([]);
  });
});
