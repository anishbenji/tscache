// Runs under Vitest, not Playwright: the docs project matches only *.spec.ts,
// and the chromium project ignores this directory.

import { describe, expect, it } from "vitest";
import { elementsWithClass } from "./pages";

describe("elementsWithClass", () => {
  it("counts the elements whose class list holds the token", () => {
    expect(elementsWithClass('<div class="mermaid"></div>', "mermaid")).toBe(1);
    expect(
      elementsWithClass(
        '<p><div class="a mermaid b"></div><span class="mermaid"></span></p>',
        "mermaid",
      ),
    ).toBe(2);
  });

  it("counts single-quoted class values", () => {
    expect(elementsWithClass("<div class='mermaid'></div>", "mermaid")).toBe(1);
    expect(elementsWithClass("<div class='a mermaid'></div>", "mermaid")).toBe(
      1,
    );
  });

  it("does not count an unquoted class=mermaid in prose, which the build leaves unescaped", () => {
    expect(
      elementsWithClass(
        "<p>Give the wrapper class=mermaid and it draws.</p>",
        "mermaid",
      ),
    ).toBe(0);
    expect(
      elementsWithClass(
        "<p>Write <code>div class=mermaid</code>.</p>",
        "mermaid",
      ),
    ).toBe(0);
  });

  it("does not count a class that only starts with the token", () => {
    expect(
      elementsWithClass('<div class="mermaid-diagram"></div>', "mermaid"),
    ).toBe(0);
    expect(
      elementsWithClass(
        '<div class="mermaid-diagram"></div>',
        "mermaid-diagram",
      ),
    ).toBe(1);
  });

  it("does not count the token in escaped text or an escaped attribute value", () => {
    expect(
      elementsWithClass(
        '<p>&lt;div class=&quot;mermaid&quot;&gt;</p><span title="x class=&quot;mermaid&quot;"></span>',
        "mermaid",
      ),
    ).toBe(0);
  });
});
