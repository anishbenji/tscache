import { describe, expect, it } from "vitest";
import { STOPPING_LINE, STOPPING_NOTICE, stopping } from "./lines";

// The line the demo launcher (scripts/demo.ts) prints first thing as it
// starts stopping, which the recorder (scripts/demo/record.ts) reads to stop
// sending to its backend (step 89, second pre-review).

describe("stopping", () => {
  it("is false until the launcher's output holds the line", () => {
    expect(stopping("")).toBe(false);
    expect(stopping("built tscache\nbuilt solid-uplot\n")).toBe(false);
    // Half of it, as one chunk of the pipe may bring.
    expect(stopping(`built tscache\n${STOPPING_LINE.slice(0, 10)}`)).toBe(
      false,
    );
  });

  it("is true once the line has arrived whole, whatever follows it", () => {
    expect(stopping(`${STOPPING_LINE}\n`)).toBe(true);
    expect(
      stopping(`built tscache\n${STOPPING_LINE}\nsolid-uplot: exited\n`),
    ).toBe(true);
    expect(stopping(`built tscache\r\n${STOPPING_LINE}\r\n`)).toBe(true);
  });

  it("finds the launcher's notice even right after a partial line", () => {
    // An app server's last stderr chunk can end mid-line just before the
    // launcher prints its notice (step 89, security lane S1.1).
    expect(stopping(`Error: listen EADDR${STOPPING_NOTICE}\nINUSE\n`)).toBe(
      true,
    );
  });

  it("is not fooled by the line inside another line", () => {
    expect(stopping(`app: ${STOPPING_LINE} soon\n`)).toBe(false);
  });
});
