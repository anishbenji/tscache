// How the benchmark page waits on its tabs and opens them together, kept
// apart from the page so it can be tested without a browser.

import type { TabMessage } from "./protocol";

type Waiter = {
  type: TabMessage["type"];
  resolve(message: TabMessage): void;
  reject(error: Error): void;
};

/**
 * The tabs' messages, delivered to whoever waits for that tab and that
 * message type: a run's late "done" never answers a wait for "disposed".
 * A tab's "failed" rejects every wait of that tab.
 */
export class Mailbox {
  readonly #waiting = new Map<string, Waiter[]>();

  next<T extends Exclude<TabMessage["type"], "failed">>(
    tab: string,
    type: T,
  ): Promise<Extract<TabMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const waiters = this.#waiting.get(tab) ?? [];
      waiters.push({
        type,
        resolve: resolve as (message: TabMessage) => void,
        reject,
      });
      this.#waiting.set(tab, waiters);
    });
  }

  deliver(message: TabMessage): void {
    const waiters = this.#waiting.get(message.tab) ?? [];
    const answered = waiters.filter(
      (w) => message.type === "failed" || w.type === message.type,
    );
    const rest = waiters.filter((w) => !answered.includes(w));
    if (rest.length === 0) this.#waiting.delete(message.tab);
    else this.#waiting.set(message.tab, rest);
    for (const waiter of answered) {
      if (message.type === "failed") waiter.reject(new Error(message.error));
      else waiter.resolve(message);
    }
  }
}

/**
 * Opens tabs at once. When one fails, the tabs that did open are closed
 * before the first failure is rethrown, so none is left behind.
 */
export async function openTogether<T extends { close(): Promise<void> }>(
  openers: readonly (() => Promise<T>)[],
): Promise<T[]> {
  const settled = await Promise.allSettled(openers.map((open) => open()));
  const opened = settled.flatMap((s) =>
    s.status === "fulfilled" ? [s.value] : [],
  );
  const failure = settled.find((s) => s.status === "rejected");
  if (failure === undefined) return opened;
  await Promise.allSettled(opened.map((tab) => tab.close()));
  throw failure.reason;
}
