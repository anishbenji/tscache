import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BLOB,
  blank,
  checkPage,
  declarations,
  findAnchors,
  repoReader,
  resolves,
} from "./check-doc-anchors";

const SOURCE = "packages/tscache/src/fixture.ts";

/** A page holding one anchor, as the "How it works" pages write them. */
const page = (symbol: string, path = SOURCE, target = BLOB + path) =>
  `Drawn from:\n\n- [\`${path}#${symbol}\`](${target})\n`;

const problems = (markdown: string, files: Record<string, string>) =>
  checkPage("site/page.md", markdown, (path) => files[path]).map(
    (p) => p.message,
  );

const declares = (source: string, symbol: string) =>
  resolves(declarations(source), symbol);

/** A template literal's interpolation opener, for fixtures that hold one. */
const I = "$" + "{";

describe("check-doc-anchors: pages", () => {
  it("accepts an anchor whose file declares the symbol and whose link points at it", () => {
    expect(
      problems(page("slotOf"), { [SOURCE]: "export function slotOf() {}" }),
    ).toEqual([]);
  });

  it("reports a missing file", () => {
    expect(problems(page("slotOf"), {})).toEqual([
      `${SOURCE} is not a file in the repository`,
    ]);
  });

  it("reports a missing symbol", () => {
    expect(
      problems(page("slotOf"), { [SOURCE]: "export function msOf() {}" }),
    ).toEqual([`${SOURCE} declares no slotOf`]);
  });

  it("compares the target of a link that carries a title", () => {
    const files = { [SOURCE]: "export function slotOf() {}" };
    const titled = (target: string) =>
      `- [\`${SOURCE}#slotOf\`](${target} "title")\n`;
    expect(problems(titled(BLOB + SOURCE), files)).toEqual([]);
    expect(problems(titled("https://example.com/wrong"), files)).toEqual([
      `the link points to https://example.com/wrong, not ${BLOB}${SOURCE}`,
    ]);
  });

  it("reports a link it cannot read rather than treating the anchor as bare", () => {
    const files = { [SOURCE]: "export function slotOf() {}" };
    const odd = `- [\`${SOURCE}#slotOf\`](<${BLOB}${SOURCE}>)\n`;
    expect(problems(odd, files)).toHaveLength(1);
  });

  it("reports a link that points at another file", () => {
    const other = `${BLOB}packages/tscache/src/grid.ts`;
    expect(
      problems(page("slotOf", SOURCE, other), {
        [SOURCE]: "export function slotOf() {}",
      }),
    ).toEqual([`the link points to ${other}, not ${BLOB}${SOURCE}`]);
  });

  it("names the page, line and anchor of each problem", () => {
    expect(
      checkPage("site/page.md", page("gone"), () => "const here = 1;"),
    ).toEqual([
      {
        file: "site/page.md",
        line: 3,
        anchor: `${SOURCE}#gone`,
        message: `${SOURCE} declares no gone`,
      },
    ]);
  });

  it("checks a bare anchor's file and symbol, with no link to compare", () => {
    expect(findAnchors("p.md", `See \`${SOURCE}#a\`.`)).toEqual([
      { file: "p.md", line: 1, path: SOURCE, symbol: "a" },
    ]);
    expect(problems(`See \`${SOURCE}#a\`.`, { [SOURCE]: "let b;" })).toEqual([
      `${SOURCE} declares no a`,
    ]);
  });

  it("ignores fenced code, placeholders and other inline code", () => {
    const markdown = [
      "Anchors take the form `path#symbol`.",
      "```ts",
      `const link = "\`${SOURCE}#gone\`";`,
      "```",
      "<<< @/snippets/cache.ts#get{ts}",
      "`site/guide/page.md#heading`",
    ].join("\n");
    expect(findAnchors("p.md", markdown)).toEqual([]);
  });
});

describe("check-doc-anchors: top-level declarations", () => {
  it.each([
    ["a function", "function f() {}", "f"],
    ["an exported async generator", "export async function* g() {}", "g"],
    ["a class", "export class C {}", "C"],
    ["an abstract class", "export abstract class A {}", "A"],
    ["a const", "const LIMIT = 4;", "LIMIT"],
    ["a let", "let count = 0;", "count"],
    ["a type", "export type Kind = 'a' | 'b';", "Kind"],
    ["an interface", "interface Shape { size: number }", "Shape"],
    ["an enum", "enum Mode { On, Off }", "Mode"],
    ["a const enum", "const enum Flag { A = 1 }", "Flag"],
    ["a declare const", "declare const VERSION: string;", "VERSION"],
    ["an export clause", "const a = 1;\nexport { a as b };", "b"],
    ["a re-export", 'export { createClient } from "./client";', "createClient"],
    ["a type re-export", 'export type { Range } from "./types";', "Range"],
    [
      "a mixed re-export",
      'export { type Grid, slotOf } from "./grid";',
      "Grid",
    ],
  ])("finds %s", (_, source, name) => {
    expect(declares(source, name)).toBe(true);
  });
});

describe("check-doc-anchors: members", () => {
  it.each([
    ["a method", "class C { run(x: number) { return x; } }", "run"],
    ["a private method", "class C { #step() {} }", "#step"],
    ["a static property", "class C { static readonly max = 3; }", "max"],
    ["a getter", "class C { get size(): number { return 1; } }", "size"],
    ["a property", "class C { private ready = false; }", "ready"],
    [
      "a constructor parameter property",
      "class C { constructor(private readonly engine: Engine, x: number) {} }",
      "engine",
    ],
    [
      "an object literal property",
      "const o = { limit: 4, run() {} };",
      "limit",
    ],
    ["an object literal method", "const o = { limit: 4, run() {} };", "run"],
    ["a shorthand property", "const a = 1;\nconst o = { a, b: 2 };", "b"],
    ["an interface member", "interface I { optional?: string }", "optional"],
    ["an object type member", "type T = { readonly id: string };", "id"],
    ["an enum member", "enum E { First, Second = 2 }", "Second"],
    [
      "a nested object's member",
      "function f() { return { deep: 1 }; }",
      "deep",
    ],
  ])("finds %s", (_, source, name) => {
    expect(declares(source, name)).toBe(true);
  });

  it("resolves Top.member against the top-level declaration's own body", () => {
    const source = [
      "export class Orchestrator { get() {} }",
      "export const HANDLERS = Object.freeze({ put: 1 });",
      "interface Options { mode: string }",
      "function helper() { const local = { mode: 1 }; }",
    ].join("\n");
    expect(declares(source, "Orchestrator.get")).toBe(true);
    expect(declares(source, "HANDLERS.put")).toBe(true);
    expect(declares(source, "Options.mode")).toBe(true);
    expect(declares(source, "Orchestrator.put")).toBe(false);
    expect(declares(source, "helper.mode")).toBe(false);
    expect(declares(source, "Missing.get")).toBe(false);
  });
});

describe("check-doc-anchors: what does not declare a name", () => {
  it.each([
    ["a line comment", "// function ghost() {}"],
    ["a block comment", "/* class ghost {} */"],
    ["a string", 'const s = "function ghost() {}";'],
    [
      "a template literal",
      `const s = \`${I}1} class ghost {} ${I}\`nested\`}\`;`,
    ],
    ["a regular expression", "const r = /class ghost {}/g;"],
    ["a function's local", "function f() { const ghost = 1; }"],
    ["a call", "run(ghost);"],
    ["a function body's statements", "function f() { ghost(); }"],
  ])("ignores %s", (_, source) => {
    expect(declares(source, "ghost")).toBe(false);
  });

  it("keeps declarations after a regular expression and a division", () => {
    const source = [
      "const half = total / 2;",
      "const re = /[/}]/;",
      "const quote = '}';",
      "export function after() {}",
    ].join("\n");
    expect(declares(source, "after")).toBe(true);
  });

  it("reads a / after a control keyword's condition as a regular expression", () => {
    const source = [
      "if (ready) /[{]/.test(value);",
      "while (f(x)) /[{]/.exec(value);",
      "const ratio = (a + b) / 2;",
      "class C { actual() {} }",
    ].join("\n");
    expect(declares(source, "C.actual")).toBe(true);
  });

  it("keeps every offset and line where it was", () => {
    const source = `const a = \`x\n${I}'y'}\`; // c\nlet b;`;
    const blanked = blank(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.split("\n")).toHaveLength(source.split("\n").length);
    expect(blanked).toContain("let b;");
    expect(blanked).not.toContain("y");
  });
});

describe("check-doc-anchors: reading the repository", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const own = "scripts/check-doc-anchors.ts";

  it("reads a file Git lists", () => {
    expect(repoReader(root, new Set([own]))(own)).toContain(
      "export function repoReader",
    );
  });

  it("refuses a file that exists but Git does not list, such as a build output", () => {
    expect(repoReader(root, new Set())(own)).toBeUndefined();
  });

  it("refuses a path that leaves the repository, even when listed", () => {
    const outside = "../outside.ts";
    expect(repoReader(root, new Set([outside]))(outside)).toBeUndefined();
  });
});
