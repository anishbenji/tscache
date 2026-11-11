import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Anchor,
  anchorReader,
  BLOB,
  checkAnchors,
  declarations,
  repoReader,
  resolves,
  run,
} from "./check-doc-anchors";

const SOURCE = "packages/tscache/src/fixture.ts";
const SPAN = `\`${SOURCE}#slotOf\``;
const WRONG = "https://example.com/wrong";
const MISMATCH = `the link points to ${WRONG}, not ${BLOB}${SOURCE}`;
const PART =
  "an anchor in a link must be the link's whole text, so its target can be checked";
const SLOT_OF = { [SOURCE]: "export function slotOf() {}" };

const find = await anchorReader();
const findAnchors = (markdown: string, file = "site/page.md"): Anchor[] =>
  find(file, markdown);

/** A page holding one anchor, as the "How it works" pages write them. */
const page = (symbol: string, path = SOURCE, target = BLOB + path) =>
  `Drawn from:\n\n- [\`${path}#${symbol}\`](${target})\n`;

const problems = (markdown: string, files: Record<string, string>) =>
  checkAnchors(findAnchors(markdown), (path) => files[path]).map(
    (p) => p.message,
  );

const declares = (source: string, symbol: string, path?: string) =>
  resolves(declarations(source, path), symbol);

/** A template literal's interpolation opener, for fixtures that hold one. */
const I = "$" + "{";

describe("check-doc-anchors: pages", () => {
  it("accepts an anchor whose file declares the symbol and whose link points at it", () => {
    expect(problems(page("slotOf"), SLOT_OF)).toEqual([]);
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

  it("reports a link that points at another file", () => {
    const other = `${BLOB}packages/tscache/src/grid.ts`;
    expect(problems(page("slotOf", SOURCE, other), SLOT_OF)).toEqual([
      `the link points to ${other}, not ${BLOB}${SOURCE}`,
    ]);
  });

  it("compares the target of a link that carries a title", () => {
    const titled = (target: string, title: string) =>
      `- [${SPAN}](${target} ${title})\n`;
    for (const title of ['"title"', "'title'", "(title)"]) {
      expect(problems(titled(BLOB + SOURCE, title), SLOT_OF)).toEqual([]);
      expect(problems(titled(WRONG, title), SLOT_OF)).toEqual([MISMATCH]);
    }
  });

  it("compares the target of a reference link in each form", () => {
    const defined = (use: string, label: string, target: string) =>
      `- ${use}\n\n[${label}]: ${target}\n`;
    expect(
      problems(defined(`[${SPAN}][g]`, "g", BLOB + SOURCE), SLOT_OF),
    ).toEqual([]);
    // Full, collapsed and shortcut, labels matched as Markdown matches them.
    expect(problems(defined(`[${SPAN}][G]`, "g", WRONG), SLOT_OF)).toEqual([
      MISMATCH,
    ]);
    expect(problems(defined(`[${SPAN}][]`, SPAN, WRONG), SLOT_OF)).toEqual([
      MISMATCH,
    ]);
    expect(problems(defined(`[${SPAN}]`, SPAN, WRONG), SLOT_OF)).toEqual([
      MISMATCH,
    ]);
    // The first definition of a label wins.
    const twice = `- [${SPAN}][g]\n\n[g]: ${WRONG}\n[g]: ${BLOB}${SOURCE}\n`;
    expect(problems(twice, SLOT_OF)).toEqual([MISMATCH]);
  });

  it("reads a definition right after a heading, as the site renders it", () => {
    const after = (target: string) =>
      `# Title\n[g]: ${target}\n\n- [${SPAN}][g]\n`;
    expect(problems(after(WRONG), SLOT_OF)).toEqual([MISMATCH]);
    expect(problems(after(BLOB + SOURCE), SLOT_OF)).toEqual([]);
  });

  it("reads a definition-shaped line inside a paragraph as text", () => {
    const continued = `Some prose\n[\`${SOURCE}#gone\`]: is rendered as text\n`;
    expect(problems(continued, SLOT_OF)).toEqual([
      `${SOURCE} declares no gone`,
    ]);
  });

  it("reads the link forms the old check could not, and their targets", () => {
    const angled = (target: string) => `- [${SPAN}](<${target}>)\n`;
    expect(problems(angled(BLOB + SOURCE), SLOT_OF)).toEqual([]);
    expect(problems(angled(WRONG), SLOT_OF)).toEqual([MISMATCH]);
    const split = `- [${SPAN}](\n  ${WRONG}\n  "title"\n)\n`;
    expect(problems(split, SLOT_OF)).toEqual([MISMATCH]);
  });

  it("reads a reference to an undefined label as text, as the site renders it", () => {
    // Neither renders a link, so the anchor is bare: its file and symbol are still checked.
    for (const text of [`[${SPAN}][nowhere]`, `[${SPAN}]`]) {
      expect(findAnchors(`- ${text}\n`)).toEqual([
        { file: "site/page.md", line: 1, path: SOURCE, symbol: "slotOf" },
      ]);
      expect(problems(`- ${text}\n`, {})).toEqual([
        `${SOURCE} is not a file in the repository`,
      ]);
    }
  });

  it("reports an anchor that is only part of a link's text", () => {
    const definition = `\n\n[g]: ${BLOB}${SOURCE}\n`;
    const shortcut = `\n\n[the ${SPAN} helper]: ${BLOB}${SOURCE}\n`;
    for (const text of [
      `[the ${SPAN} helper](${WRONG})`,
      `[${SPAN} helper](${BLOB}${SOURCE})`,
      `[**${SPAN}**][g]${definition}`,
      `[the ${SPAN} helper][g]${definition}`,
      `[the ${SPAN} helper]${shortcut}`,
    ]) {
      expect(problems(`- ${text}\n`, SLOT_OF)).toEqual([PART]);
    }
    expect(problems(`- see [the docs](x) and ${SPAN}\n`, SLOT_OF)).toEqual([]);
  });

  it("names the page, line and anchor of each problem", () => {
    expect(
      checkAnchors(findAnchors(page("gone")), () => "const here = 1;"),
    ).toEqual([
      {
        file: "site/page.md",
        line: 3,
        anchor: `${SOURCE}#gone`,
        message: `${SOURCE} declares no gone`,
      },
    ]);
  });

  it("reports the line each anchor is on", () => {
    const at = (symbol: string) => `\`${SOURCE}#${symbol}\``;
    const markdown = [
      "---", // 1
      "title: Lines",
      "---",
      "",
      `# The ${at("heading")}`, // 5
      "",
      `A paragraph with ${at("first")}`, // 7
      `and, on its next line, [${at("second")}](${BLOB}${SOURCE})`, // 8
      `after [a link](`, // 9
      `  ${WRONG}`, // 10
      `  "split") ${at("third")}`, // 11
      "",
      `- an item`, // 13
      `  continued ${at("item")}`, // 14
      "",
      `> quoted`, // 16
      `> ${at("quote")}`, // 17
      "",
      "| a | b |", // 19
      "| - | - |",
      `| ${at("cell")} | x |`, // 21
      "",
      "```ts", // 23
      at("fenced"),
      "```",
      "",
      `Last ${at("last")}`, // 27
    ].join("\n");
    expect(
      findAnchors(markdown).map(({ symbol, line }) => [symbol, line]),
    ).toEqual([
      ["heading", 5],
      ["first", 7],
      ["second", 8],
      ["third", 11],
      ["item", 14],
      ["quote", 17],
      ["cell", 21],
      ["last", 27],
    ]);
  });

  it("checks a bare anchor's file and symbol, with no link to compare", () => {
    expect(findAnchors(`See \`${SOURCE}#a\`.`, "p.md")).toEqual([
      { file: "p.md", line: 1, path: SOURCE, symbol: "a" },
    ]);
    expect(problems(`See \`${SOURCE}#a\`.`, { [SOURCE]: "let b;" })).toEqual([
      `${SOURCE} declares no a`,
    ]);
  });

  it("ignores fenced code, includes, raw HTML, placeholders and other inline code", () => {
    const markdown = [
      "Anchors take the form `path#symbol`.",
      "```ts",
      `const link = "\`${SOURCE}#gone\`";`,
      "```",
      "",
      "<<< @/snippets/cache.ts#get{ts}",
      "",
      "<!--@include: ./overview.svg-->",
      "",
      `<div>\`${SOURCE}#gone\`</div>`,
      "",
      "`site/guide/page.md#heading`",
    ].join("\n");
    expect(findAnchors(markdown)).toEqual([]);
  });
});

describe("check-doc-anchors: top-level declarations", () => {
  it.each([
    ["a function", "function f() {}", "f"],
    ["an exported async generator", "export async function* g() {}", "g"],
    ["a declared function", "declare function d(): void;", "d"],
    ["a class", "export class C {}", "C"],
    ["an abstract class", "export abstract class A {}", "A"],
    ["a named default class", "export default class D {}", "D"],
    ["a const", "const LIMIT = 4;", "LIMIT"],
    ["a let", "let count = 0;", "count"],
    ["a var", "var legacy = 0;", "legacy"],
    ["a second declarator", "const a = 1, b = 2;", "b"],
    ["an object destructuring", "const { a, b: renamed } = o;", "renamed"],
    ["a nested destructuring", "const { a: [, second] } = o;", "second"],
    ["a rest element", "const [head, ...rest] = list;", "rest"],
    ["a type", "export type Kind = 'a' | 'b';", "Kind"],
    ["an interface", "interface Shape { size: number }", "Shape"],
    ["an enum", "enum Mode { On, Off }", "Mode"],
    ["a const enum", "const enum Flag { A = 1 }", "Flag"],
    ["a namespace", "namespace Space { export const x = 1; }", "Space"],
    ["a declare const", "declare const VERSION: string;", "VERSION"],
    ["an export clause", "const a = 1;\nexport { a as b };", "b"],
    ["a re-export", 'export { createClient } from "./client";', "createClient"],
    ["a type re-export", 'export type { Range } from "./types";', "Range"],
    [
      "a mixed re-export",
      'export { type Grid, slotOf } from "./grid";',
      "Grid",
    ],
    ["a namespace re-export", 'export * as grid from "./grid";', "grid"],
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

  it("does not take a constructor parameter without a modifier for a member", () => {
    expect(declares("class C { constructor(x: number) {} }", "x")).toBe(false);
  });

  it("resolves Top.member against the top-level declaration's own body", () => {
    const source = [
      "export class Orchestrator { get() {} #round() {} }",
      "export const HANDLERS = Object.freeze({ put: 1 });",
      "export const TABLE = { read: 1 } as const satisfies object;",
      "interface Options { mode: string }",
      "type Shape = { size: number };",
      "enum Mode { On }",
      "namespace Space { export function inner() {} }",
      "class Merged { a() {} }",
      "interface Merged { b: number }",
      "const Expr = class { run() {} };",
      "function helper() { const local = { mode: 1 }; }",
      "const client = create({ mode: 1 });",
    ].join("\n");
    for (const symbol of [
      "Orchestrator.get",
      "Orchestrator.#round",
      "HANDLERS.put",
      "TABLE.read",
      "Options.mode",
      "Shape.size",
      "Mode.On",
      "Space.inner",
      "Merged.a",
      "Merged.b",
      "Expr.run",
    ]) {
      expect(declares(source, symbol), symbol).toBe(true);
    }
    for (const symbol of [
      "Orchestrator.put",
      "helper.mode",
      "Missing.get",
      "client.mode",
    ]) {
      expect(declares(source, symbol), symbol).toBe(false);
    }
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
    ["a named function expression", "export const impl = function ghost() {};"],
    ["a named class expression", "export const impl = class ghost {};"],
    ["a declared module's contents", 'declare module "m" { const ghost: 1; }'],
    ["a global augmentation", "declare global { var ghost: 1; }"],
  ])("ignores %s", (_, source) => {
    expect(declares(source, "ghost")).toBe(false);
  });

  it("does not take a global augmentation for a top-level name", () => {
    expect(declares("declare global { var x: 1; }", "global")).toBe(false);
  });

  it("finds a declaration after each construct that misled the old scanner", () => {
    // Regular expressions after a condition, an interpolation and a spread; divisions after a
    // postfix operator and after keywords used as property names; JSX in a .tsx file.
    const source = [
      "if (ready) /[{]/.test(value);",
      "while (f(x)) /[{]/.exec(value);",
      `const t = \`${I}/[{]/.source}\`;`,
      "const a = [.../[{]/.exec(x)];",
      "const b = n! / 2, c = i++ / 2, d = i-- / 2;",
      "const e = s.in / 2;",
      "class K { #in = 1; f() { return this.#in / 2; } }",
      "const half = total / 2;",
      "const re = /[/}]/;",
      "const quote = '}';",
      "class C { actual() {} }",
    ].join("\n");
    expect(declares(source, "C.actual")).toBe(true);
    const jsx = [
      `const view = <div className={\`a ${I}b}\`}>{/* } */}</div>;`,
      "export function after() { return <a href='/x'>/</a>; }",
    ].join("\n");
    expect(declares(jsx, "after", "view.tsx")).toBe(true);
  });

  it("parses a .tsx anchor's file as TSX", () => {
    const files = {
      "app/view.tsx":
        "export const View = () => <p>/</p>;\nexport class After {}",
    };
    const markdown = `See \`app/view.tsx#After\`.`;
    expect(
      checkAnchors(
        findAnchors(markdown),
        (path) => files[path as "app/view.tsx"],
      ),
    ).toEqual([]);
  });
});

describe("check-doc-anchors: reading the repository", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const own = "site/scripts/check-doc-anchors.ts";

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

describe("check-doc-anchors: the command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 1 when Git cannot list the files", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = () => ({ exitCode: 128, stdout: "", stderr: "not a repo" });
    expect(await run([], failed)).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "doc-anchors: git ls-files failed: not a repo",
    );
  });

  it("exits 1 when there is no page to check", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const noPages = () => ({ exitCode: 0, stdout: "README.md\n", stderr: "" });
    expect(await run([], noPages)).toBe(1);
    expect(error).toHaveBeenCalledWith("doc-anchors: no pages to check");
  });
});
