import { afterEach, beforeEach, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { Persister, type PersisterOptions } from "../src/persist/persister";
import { MemoryStore } from "./persist-memory-store";
import { config, type PersistConfig } from "./persist-test-helpers";

export function fakeTime(): void {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}
export function harness(
  options: PersisterOptions = {},
  store: MemoryStore = new MemoryStore(),
): {
  engine: Engine;
  store: MemoryStore;
  persister: Persister;
  stopped: {
    cacheId: string;
    reason: "quota-exceeded" | "unavailable" | "error";
    error?: { name: string; message: string };
  }[];
  openStore: ReturnType<typeof vi.fn>;
} {
  const engine = new Engine();
  const stopped: {
    cacheId: string;
    reason: "quota-exceeded" | "unavailable" | "error";
    error?: { name: string; message: string };
  }[] = [];
  const openStore = vi.fn(async () => store);
  const persister = new Persister(engine, openStore, {
    ...options,
    onStopped: (event: (typeof stopped)[number]) => {
      stopped.push(event);
      options.onStopped?.(event);
    },
  });
  return { engine, store, persister, stopped, openStore };
}
export async function opened(
  overrides: Partial<PersistConfig> = {},
  options: PersisterOptions = {},
): Promise<ReturnType<typeof harness>> {
  const h = harness(options);
  h.engine.cache(config(overrides));
  await h.persister.open(config(overrides).id);
  return h;
}
export async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}
export function writes(
  store: MemoryStore,
): Extract<(typeof store.log)[number], { kind: "write" }>[] {
  return store.log.filter(
    (call): call is Extract<(typeof store.log)[number], { kind: "write" }> =>
      call.kind === "write",
  );
}
export function clearAll(
  h: Pick<ReturnType<typeof harness>, "engine" | "persister">,
): Promise<void> {
  h.engine.clearAll();
  return h.persister.clearAll();
}

/** Run work that was made due now, without choosing whether it starts inline
 * or on the zero-delay scheduling timer. Never advances a retry/deadline. */
export async function finish(promise: Promise<void>): Promise<void> {
  await tick();
  await promise;
}
