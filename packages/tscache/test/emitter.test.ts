import { describe, expect, it } from "vitest";
import { Emitter } from "../src/engine/emitter";

type Events = { changed: { value: number }; other: string };

describe("Emitter — architecture §4.6", () => {
  it("on returns an unsubscribe that stops subsequent delivery", () => {
    const emitter = new Emitter<Events>();
    const seen: Events["changed"][] = [];
    const unsubscribe = emitter.on("changed", (payload) => seen.push(payload));
    expect(unsubscribe).toBeTypeOf("function");
    emitter.emit("changed", { value: 1 });
    unsubscribe();
    emitter.emit("changed", { value: 2 });
    expect(seen).toEqual([{ value: 1 }]);
  });

  it("off removes the specified listener without removing the others", () => {
    const emitter = new Emitter<Events>();
    const seen: string[] = [];
    const removed = () => seen.push("removed");
    emitter.on("changed", removed);
    emitter.on("changed", () => seen.push("kept"));
    emitter.off("changed", removed);
    emitter.emit("changed", { value: 1 });
    expect(seen).toEqual(["kept"]);
  });

  it("delivers the payload to several listeners only for its event", () => {
    const emitter = new Emitter<Events>();
    const seen: [string, Events["changed"]][] = [];
    for (const name of ["a", "b", "c"]) {
      emitter.on("changed", (payload) => seen.push([name, payload]));
    }
    emitter.on("other", () => {
      throw new Error("Unrelated event was delivered");
    });
    emitter.emit("changed", { value: 7 });
    expect(seen.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["a", { value: 7 }],
      ["b", { value: 7 }],
      ["c", { value: 7 }],
    ]);
  });

  it("a listener added during emit starts with the next emit", () => {
    const emitter = new Emitter<Events>();
    const addedValues: number[] = [];
    const added = (payload: Events["changed"]) =>
      addedValues.push(payload.value);
    const stopAdding = emitter.on("changed", () => {
      emitter.on("changed", added);
    });
    emitter.emit("changed", { value: 1 });
    expect(addedValues).toEqual([]);
    stopAdding();
    emitter.emit("changed", { value: 2 });
    expect(addedValues).toEqual([2]);
  });

  it.each(["off", "unsubscribe"] as const)(
    "listeners removed with %s during emit still receive that emit",
    (method) => {
      const emitter = new Emitter<Events>();
      const seen: string[] = [];
      // Both callbacks remove both listeners, so this is independent of
      // listener invocation order; each must still receive the current emit.
      const a = () => {
        seen.push("a");
        remove();
      };
      const b = () => {
        seen.push("b");
        remove();
      };
      const unsubscribeA = emitter.on("changed", a);
      const unsubscribeB = emitter.on("changed", b);
      function remove(): void {
        if (method === "off") {
          emitter.off("changed", a);
          emitter.off("changed", b);
        } else {
          unsubscribeA();
          unsubscribeB();
        }
      }
      emitter.emit("changed", { value: 1 });
      expect(seen.sort()).toEqual(["a", "b"]);
      emitter.emit("changed", { value: 2 });
      expect(seen.sort()).toEqual(["a", "b"]);
    },
  );

  it("a throwing listener's error is rethrown only after all listeners ran", () => {
    const emitter = new Emitter<Events>();
    const error = new Error("listener failed");
    const seen: string[] = [];
    emitter.on("changed", () => seen.push("a"));
    emitter.on("changed", () => {
      seen.push("throwing");
      throw error;
    });
    emitter.on("changed", () => seen.push("b"));
    let caught: unknown;
    try {
      emitter.emit("changed", { value: 1 });
    } catch (value) {
      caught = value;
      expect(seen.sort()).toEqual(["a", "b", "throwing"]);
    }
    expect(caught).toBe(error);
  });

  it("emitting or removing listeners for an unknown event is inert", () => {
    const emitter = new Emitter<Events>();
    const seen: number[] = [];
    emitter.on("changed", ({ value }) => seen.push(value));
    // Exercise an untyped caller without extending the declared event map.
    const unknownEvent = "unknown" as keyof Events;
    expect(() => emitter.emit(unknownEvent, "ignored")).not.toThrow();
    expect(() => emitter.off(unknownEvent, () => {})).not.toThrow();
    expect(seen).toEqual([]);
    emitter.emit("changed", { value: 3 });
    expect(seen).toEqual([3]);
  });
});
