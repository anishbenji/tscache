import { describe, expect, it, vi } from "vitest";
import { AuthState } from "../src/orchestrator/auth";

// Implementer tests: the auth state's waiter bookkeeping (§4.9, design y).
const error = { name: "AuthInvalidError", message: "expired" };

describe("AuthState waiters", () => {
  it("a waiter that subscribes after auth went invalid is told at once and not held", () => {
    const auth = new AuthState(() => {});
    auth.invalidate(error, undefined);
    const fn = vi.fn();
    const unsubscribe = auth.onInvalid(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(auth.waiterCount).toBe(0);
    unsubscribe();
    expect(auth.waiterCount).toBe(0);
  });

  it("invalidate releases every waiter once and holds none afterwards", () => {
    const broadcast = vi.fn();
    const auth = new AuthState(broadcast);
    const first = vi.fn();
    const second = vi.fn();
    auth.onInvalid(first);
    auth.onInvalid(second);
    expect(auth.waiterCount).toBe(2);
    auth.invalidate(error, "ctx");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(auth.waiterCount).toBe(0);
    // A later flip after new material does not tell the released waiters again.
    auth.restore();
    auth.invalidate(error, "ctx");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});
