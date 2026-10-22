import {
  type CacheConfig,
  type ClientEvents,
  createClient,
  type TscacheClient,
} from "tscache";

export const config: CacheConfig = {
  id: "h",
  interval: 10,
  fields: { v: "f64", n: "i16" },
};

/** A client whose worker a test can lose, by calling `lose()`. */
export interface Lossy {
  client: TscacheClient;
  lose(): void;
}

/**
 * An in-process client, whose worker cannot be lost, behind a facade that
 * fakes the loss: `lose()` fires workerLost and fails every later call, as
 * a lost client does.
 */
export async function lossy(): Promise<Lossy> {
  const real = await createClient({ mode: "in-process" });
  const listeners = new Set<(e: ClientEvents["workerLost"]) => void>();
  let lost = false;
  const live = <T>(call: () => Promise<T>): Promise<T> =>
    lost ? Promise.reject(new Error("worker lost")) : call();
  const client: TscacheClient = {
    get mode() {
      return real.mode;
    },
    cache: (c) => live(() => real.cache(c)),
    clearAll: () => live(() => real.clearAll()),
    updateAuth: (context) => live(() => real.updateAuth(context)),
    on(event, fn) {
      if (event !== "workerLost") return real.on(event, fn);
      const listener = fn as (e: ClientEvents["workerLost"]) => void;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    off(event, fn) {
      if (event === "workerLost") listeners.delete(fn as never);
      else real.off(event, fn);
    },
    dispose: () => real.dispose(),
  };
  return {
    client,
    lose() {
      lost = true;
      void real.dispose();
      for (const fn of listeners) fn({ reason: "lost in a test" });
    },
  };
}

/** Resolves once `check` holds, polling each macrotask. */
export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition never held");
}
