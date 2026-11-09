import { vi } from "vitest";

export interface LockRequest {
  name: string;
  mode: string;
  signal: AbortSignal | undefined;
  grant(): void;
}

/** A fake navigator.locks recording requests; the test grants them. */
export function installFakeLocks(): LockRequest[] {
  const requests: LockRequest[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: (
        name: string,
        options: { mode: string; signal?: AbortSignal },
        callback: () => unknown,
      ) =>
        new Promise((resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("withdrawn", "AbortError")),
            { once: true },
          );
          requests.push({
            name,
            mode: options.mode,
            signal: options.signal,
            grant: () => {
              Promise.resolve(callback()).then(resolve, reject);
            },
          });
        }),
    },
  });
  return requests;
}
