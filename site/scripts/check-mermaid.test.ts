import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diagramReader,
  formatFailure,
  importEntry,
  run,
  withWindow,
} from "./check-mermaid";

const SCRIPT = fileURLToPath(new URL("./check-mermaid.ts", import.meta.url));

const fence = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\`\n`;

const FLOWCHART = fence(
  "flowchart LR\n  A[engine] --> B{covered?}\n  B -- yes --> C[serve]\n  B -- no --> D[fetch]",
);
const SEQUENCE = fence(
  "sequenceDiagram\n  participant T as Tab\n  participant W as Worker\n  T->>W: req, then wait\n  W-->>T: res",
);
/** A `;` ends a sequence statement, so the text after it is a statement of its own. */
const BROKEN = fence(
  "sequenceDiagram\n  participant T as Tab\n  participant W as Worker\n  W--xT: res, to a closed port; the server forgets it",
);
/** Mermaid's sequence parser reads `window.CSS` to check a box's colour. */
const BOXES = fence(
  "sequenceDiagram\n  box Aqua Client\n    participant T as Tab\n  end\n  box Server\n    participant S as Server\n  end\n  T->>S: req\n  S-->>T: res",
);

/**
 * Mermaid's `details` statement reads a page element while parsing; outside a browser there is
 * no `document`, and a missing element is skipped.
 */
const DETAILS = fence(
  "sequenceDiagram\n  participant Alice\n  participant Bob\n  details Alice: aliceDetails\n  Alice->>Bob: hi",
);
const DETAILS_BROKEN = fence(
  "sequenceDiagram\n  participant Alice\n  participant Bob\n  details Alice: aliceDetails\n  Alice->>Bob: hi; then more",
);
/** Frontmatter that does not open the diagram is a syntax error when the page renders it. */
const COMMENT_THEN_FRONTMATTER = fence(
  "%% Comment\n---\ntitle: T\n---\nflowchart LR\n  A --> B",
);
const DIRECTIVE_THEN_FRONTMATTER = fence(
  "%%{init: {'theme': 'dark'}}%%\n---\ntitle: T\n---\nflowchart LR\n  A --> B",
);
const FRONTMATTER_FIRST = fence(
  "---\ntitle: T\n---\n%% Comment\nflowchart LR\n  A --> B",
);

/** Asserts that `text` starts with `prefix`, compared as a literal string. */
function expectPrefix(text: string | undefined, prefix: string): void {
  expect(text?.slice(0, prefix.length)).toBe(prefix);
}

const find = await diagramReader();
const lines = async (markdown: string) =>
  (await find("site/page.md", markdown)).map((d) => d.line);

/**
 * Writes `pages` (name to Markdown) into a fresh directory and returns it. The directory's name
 * holds a space and parentheses, so an assertion that reads a printed path as a pattern fails.
 */
function fixture(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "check-mermaid (tmp)-"));
  for (const [name, markdown] of Object.entries(pages)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), markdown);
  }
  return dir;
}

describe("check-mermaid: pages", () => {
  it("finds each mermaid fence at its opening line, frontmatter included", async () => {
    const page = `---\ntitle: T\n---\n\n# T\n\n${FLOWCHART}\nText.\n\n${SEQUENCE}`;
    expect(await lines(page)).toEqual([7, 16]);
  });

  it("finds a fence inside a container or a list, as the site renders it", async () => {
    const page = `::: details Diagram\n\n${FLOWCHART}\n:::\n\n- item\n\n  ${SEQUENCE.replaceAll("\n", "\n  ")}`;
    expect(await lines(page)).toEqual([3, 14]);
  });

  it("ignores fences of other languages and mermaid shown as code", async () => {
    const page = `\`\`\`ts\nconst a = 1;\n\`\`\`\n\n\`\`\`\`md\n${FLOWCHART}\`\`\`\`\n`;
    expect(await lines(page)).toEqual([]);
  });

  it("keeps the diagram's text without the fence", async () => {
    const [diagram] = await find(
      "site/page.md",
      fence("flowchart LR\n  A --> B"),
    );
    expect(diagram?.text).toBe("flowchart LR\n  A --> B\n");
  });

  it("reads a page as VitePress renders it, after its includes are expanded", async () => {
    const dir = fixture({
      "part.txt": "B --> C",
      "page.md": `# Page\n\n${fence("flowchart LR\n  A --> B\n  <!-- @include: ./part.txt -->")}\n${FLOWCHART}`,
    });
    try {
      const page = join(dir, "page.md");
      const diagrams = await find("page.md", readFileSync(page, "utf8"), page);
      expect(diagrams.map((d) => [d.line, d.text])).toEqual([
        [3, "flowchart LR\n  A --> B\n  B --> C\n"],
        [9, FLOWCHART.slice("```mermaid\n".length, -"```\n".length)],
      ]);
      expect(diagrams.map((d) => d.expanded)).toEqual([undefined, undefined]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects a page with a hand-written Mermaid tag, naming the page", async () => {
    const tag = '<Mermaid id="m1" graph="x" />';
    for (const page of [
      `# Page\n\n${tag}\n`,
      `# Page\n\nA diagram: ${tag} here.\n`,
      `::: details Diagram\n\n${tag}\n\n:::\n`,
    ]) {
      await expect(find("site/page.md", page)).rejects.toThrow(
        /^mermaid: site\/page\.md has a hand-written <Mermaid> tag/,
      );
    }
  });

  it("rejects a Mermaid tag after quoted text in the same HTML block", async () => {
    const page = "<p>don't</p> <Mermaid id='a' graph='x' />\n";
    await expect(find("site/page.md", page)).rejects.toThrow(
      /^mermaid: site\/page\.md has a hand-written <Mermaid> tag/,
    );
  });

  it("accepts a Mermaid tag in a comment or in a quoted attribute value", async () => {
    for (const page of [
      "<!-- Example: <Mermaid /> -->\n",
      "# Page\n\nText <!-- Example: <Mermaid /> --> here.\n",
      '# Page\n\n<span aria-label="Example <Mermaid /> markup"></span>\n',
      "# Page\n\nText <span title='<Mermaid id=\"a\" />'>x</span> here.\n",
    ]) {
      expect(await lines(page)).toEqual([]);
    }
  });

  it("rejects a dynamic component whose static is names Mermaid, inside ClientOnly too", async () => {
    for (const page of [
      '<ClientOnly><component is="Mermaid" id="m1" graph="x" /></ClientOnly>\n',
      "<component :is=\"'Mermaid'\" />\n",
      "# Page\n\nText <component is='mermaid' graph=\"x\" /> here.\n",
      "<div><component v-bind:is=\"'MERMAID'\" /></div>\n",
    ]) {
      await expect(find("site/page.md", page)).rejects.toThrow(
        /^mermaid: site\/page\.md has a hand-written <Mermaid> tag/,
      );
    }
    expect(await lines('<component is="Badge" />\n')).toEqual([]);
  });

  it("rejects an unquoted is=mermaid, and accepts an is that only starts with Mermaid", async () => {
    await expect(
      find("site/page.md", '<component is=mermaid graph="x" />\n'),
    ).rejects.toThrow(
      /^mermaid: site\/page\.md has a hand-written <Mermaid> tag/,
    );
    expect(await lines('<component is="MermaidLegend" />\n')).toEqual([]);
    expect(await lines('<component :is="mermaidView" />\n')).toEqual([]);
  });

  it("rejects a Mermaid tag that a comment or a raw-text element only seems to hide", async () => {
    for (const page of [
      '<div title="<!--"></div><Mermaid id="a" class="x" graph="g"/><div title="-->"></div>\n',
      '<!--> <Mermaid id="a" class="x" graph="graph TD;A-->B" />\n',
      '<!---> <Mermaid id="a" class="x" graph="g" /> -->\n',
      '<textarea><a x=\'</textarea><Mermaid id="a" class="x" graph="g"/><textarea>\'></textarea>\n',
      '<div><title><a x=\'</title><Mermaid id="a" class="x" graph="g"/><title>\'></title></div>\n',
    ]) {
      await expect(find("site/page.md", page)).rejects.toThrow(
        /^mermaid: site\/page\.md has a hand-written <Mermaid> tag/,
      );
    }
  });

  it("accepts a Mermaid tag inside a raw-text element, which renders it as text", async () => {
    expect(await lines("<textarea><Mermaid/></textarea>\n")).toEqual([]);
    expect(await lines("<textArea><Mermaid/></TEXTAREA>\n")).toEqual([]);
    expect(await lines("<div><title><Mermaid/></title></div>\n")).toEqual([]);
  });

  it("rejects a Mermaid tag in an element Vue parses as elements: a capitalised raw-text name, xmp, or an svg title", async () => {
    for (const page of [
      "<TEXTAREA><Mermaid/></TextArea>\n",
      "<Title><Mermaid/></Title>\n",
      '<xmp><Mermaid class="x" graph="g"/></xmp>\n',
      "<noscript><Mermaid/></noscript>\n",
      "<svg><title><Mermaid/></title></svg>\n",
      "<math><style><Mermaid/></style></math>\n",
    ]) {
      await expect(find("site/page.md", page)).rejects.toThrow(
        /^mermaid: site\/page\.md has a hand-written <Mermaid> tag/,
      );
    }
    expect(await lines("<svg></svg><textarea><Mermaid/></textarea>\n")).toEqual(
      [],
    );
  });

  it("finds a raw-text element's close in the page's own text when U+0130 lower-cases to two units", async () => {
    await expect(
      find(
        "site/page.md",
        `<div><textarea>${"\u0130".repeat(12)}</textarea><Mermaid id="a" class="x" graph="g"/></div>\n`,
      ),
    ).rejects.toThrow(
      /^mermaid: site\/page\.md has a hand-written <Mermaid> tag/,
    );
    expect(
      await lines(
        `<div><textarea>${"\u0130".repeat(13)}</textarea><a title="<Mermaid>">x</a></div>\n`,
      ),
    ).toEqual([]);
  });

  it("reads 160 kB of unterminated comment openers in one pass (a quadratic scan would stall here)", async () => {
    expect(await lines("<!--".repeat(40000))).toEqual([]);
  });

  it("accepts a Mermaid tag shown as inline code or in a fence", async () => {
    const tag = '<Mermaid id="m1" graph="x" />';
    const page = `# Page\n\nWrite \`${tag}\` rarely.\n\n\`\`\`vue\n${tag}\n\`\`\`\n`;
    expect(await lines(page)).toEqual([]);
  });

  it("counts a fence that an include brings in on the expanded page", async () => {
    const dir = fixture({
      "part.txt": FLOWCHART,
      "page.md": "# Page\n\n<!-- @include: ./part.txt -->\n\nEnd.\n",
    });
    try {
      const page = join(dir, "page.md");
      const [diagram] = await find("page.md", readFileSync(page, "utf8"), page);
      expect(diagram?.line).toBe(3);
      expect(diagram?.expanded).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("check-mermaid: reporting", () => {
  it("prints the fence's line and Mermaid's message, its later lines indented", () => {
    const failure = {
      file: "a.md",
      line: 3,
      message: "Parse error on line 2:\n...B\n---^\n",
    };
    expect(formatFailure(failure)).toBe(
      "a.md:3: Parse error on line 2:\n    ...B\n    ---^",
    );
  });

  it("names the expanded page's line when an include brought the fence in", () => {
    const failure = {
      file: "a.md",
      line: 7,
      expanded: true as const,
      message: "Parse error on line 2:\n...B\n",
    };
    expect(formatFailure(failure)).toBe(
      "a.md, line 7 of the page with its includes expanded: Parse error on line 2:\n    ...B",
    );
  });

  it("reads a package's ES module entry from its exports", () => {
    expect(
      importEntry({
        name: "p",
        exports: {
          ".": {
            import: { types: "./x.d.mts", default: "./x.mjs" },
            default: "./x.cjs",
          },
        },
      }),
    ).toBe("./x.mjs");
    expect(importEntry({ name: "p", exports: { ".": "./y.mjs" } })).toBe(
      "./y.mjs",
    );
    expect(importEntry({ name: "p", module: "./z.mjs" })).toBe("./z.mjs");
  });
});

describe("check-mermaid: the command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 1 and names the file and line of a sequence message holding a `;`", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = fixture({
      "ok.md": `# Ok\n\n${FLOWCHART}`,
      "tabs.md": `# Tabs\n\n${BROKEN}`,
    });
    try {
      expect(await run([dir])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expectPrefix(
      printed[0],
      `${join(dir, "tabs.md")}:3: Parse error on line 4:\n`,
    );
    expect(printed).toHaveLength(2);
    expect(printed[1]).toContain("1 of 2 diagram(s) do not parse");
  });

  it("exits 1 when an include puts a `;` in a sequence message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = fixture({
      "message.md": "res, to a closed port; the server forgets it\n",
      "tabs.md": `# Tabs\n\n${fence("sequenceDiagram\n  participant T as Tab\n  participant W as Worker\n  W--xT: <!-- @include: ./message.md -->")}`,
    });
    try {
      expect(await run([dir])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expectPrefix(
      printed[0],
      `${join(dir, "tabs.md")}:3: Parse error on line 4:\n`,
    );
    expect(printed[1]).toContain("1 of 1 diagram(s) do not parse");
  });

  it("passes sequence diagrams with a coloured and an uncoloured box, leaving no window behind", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = fixture({ "page.md": `# Page\n\n${BOXES}` });
    try {
      expect(await run([dir])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
    expect(log).toHaveBeenCalledWith("mermaid: 1 diagrams in 1 pages parse");
    expect("window" in globalThis).toBe(false);
  });

  it("exits 1 when a comment or a directive comes before the diagram's frontmatter", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = fixture({
      "comment.md": `# Comment\n\n${COMMENT_THEN_FRONTMATTER}`,
      "directive.md": `# Directive\n\n${DIRECTIVE_THEN_FRONTMATTER}`,
    });
    try {
      expect(await run([dir])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expect(printed).toHaveLength(3);
    expectPrefix(printed[0], `${join(dir, "comment.md")}:3: `);
    expectPrefix(printed[1], `${join(dir, "directive.md")}:3: `);
    expect(printed[2]).toContain("2 of 2 diagram(s) do not parse");
  });

  it("passes a diagram whose frontmatter comes first", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = fixture({ "page.md": `# Page\n\n${FRONTMATTER_FIRST}` });
    try {
      expect(await run([dir])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
    expect(log).toHaveBeenCalledWith("mermaid: 1 diagrams in 1 pages parse");
  });

  it("passes a sequence diagram with participant details, leaving no document behind", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = fixture({ "page.md": `# Page\n\n${DETAILS}` });
    try {
      expect(await run([dir])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
    expect(log).toHaveBeenCalledWith("mermaid: 1 diagrams in 1 pages parse");
    expect("document" in globalThis).toBe(false);
    expect("window" in globalThis).toBe(false);
  });

  it("exits 1 on a `;` in a sequence message next to participant details", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = fixture({ "page.md": `# Page\n\n${DETAILS_BROKEN}` });
    try {
      expect(await run([dir])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expectPrefix(
      printed[0],
      `${join(dir, "page.md")}:3: Parse error on line 5:\n`,
    );
  });

  it("exits 1 on a fence Mermaid reads as its error diagram, also after a comment", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = fixture({
      "bare.md": `# Bare\n\n${fence("error")}`,
      "comment.md": `# Comment\n\n${fence("%% A note\nerror")}`,
    });
    try {
      expect(await run([dir])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expect(printed).toHaveLength(3);
    expect(printed[0]).toContain(`${join(dir, "bare.md")}:3: `);
    expect(printed[0]).toContain("error diagram");
    expect(printed[1]).toContain(`${join(dir, "comment.md")}:3: `);
    expect(printed[2]).toContain("2 of 2 diagram(s) do not parse");
  });

  it("passes a valid flowchart and a valid sequence diagram", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = fixture({ "page.md": `# Page\n\n${FLOWCHART}\n${SEQUENCE}` });
    try {
      expect(await run([join(dir, "page.md")])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
    expect(log).toHaveBeenCalledWith("mermaid: 2 diagrams in 1 pages parse");
  });

  it("passes a page with no mermaid", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = fixture({ "plain.md": "# Plain\n\nNo diagrams here.\n" });
    try {
      expect(await run([dir])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
    expect(log).toHaveBeenCalledWith("mermaid: 0 diagrams in 1 pages parse");
  });

  it("checks the pages Git lists under site/ when given none", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = fixture({
      "README.md": FLOWCHART,
      "site/index.md": `# Home\n\n${FLOWCHART}`,
    });
    const listed = () => ({
      exitCode: 0,
      stdout: "README.md\0site/index.md\0",
      stderr: "",
    });
    try {
      expect(await run([], listed, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true });
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("mermaid: 1 diagrams in 1 pages parse");
  });

  it("checks a listed page whose name is not ASCII", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture({ "site/guides/café.md": `# Café\n\n${BROKEN}` });
    const listed = () => ({
      exitCode: 0,
      stdout: "site/guides/café.md\0",
      stderr: "",
    });
    try {
      expect(await run([], listed, root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
    expect(String(error.mock.calls[0]?.[0])).toContain(
      `${join(root, "site/guides/café.md")}:3: Parse error on line 4:`,
    );
  });

  it("checks the generated API pages, which Git does not list", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture({
      "site/index.md": `# Home\n\n${FLOWCHART}`,
      "site/api/engine.md": `# Engine\n\n${BROKEN}`,
    });
    const listed = () => ({
      exitCode: 0,
      stdout: "site/index.md\0",
      stderr: "",
    });
    try {
      expect(await run([], listed, root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expect(printed[0]).toContain(
      `${join(root, "site/api/engine.md")}:3: Parse error on line 4:`,
    );
    expect(printed[1]).toContain("1 of 2 diagram(s) do not parse");
  });

  it("exits 1 naming a dynamic route, whose injected content it cannot see", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture({
      "site/index.md": `# Home\n\n${FLOWCHART}`,
      "site/guide/[topic].md": "<!-- @content -->\n",
    });
    const listed = () => ({
      exitCode: 0,
      stdout: "site/index.md\0site/guide/[topic].md\0",
      stderr: "",
    });
    try {
      expect(await run([], listed, root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(join(root, "site/guide/[topic].md"));
    expect(printed[0]).toContain("dynamic route");
  });

  it("exits 1 on a bracket-named page with the content marker spelled without spaces", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture({
      "site/index.md": `# Home\n\n${FLOWCHART}`,
      "site/guide/[topic].md": "<!--@content-->\n",
    });
    const listed = () => ({
      exitCode: 0,
      stdout: "site/index.md\0site/guide/[topic].md\0",
      stderr: "",
    });
    try {
      expect(await run([], listed, root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(join(root, "site/guide/[topic].md"));
    expect(printed[0]).toContain("dynamic route");
  });

  it("exits 1 on a CR-only bracket-named page whose frontmatter hides a broken fence", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture({
      "site/index.md": `# Home\n\n${FLOWCHART}`,
      "site/guide/[topic].md": `---\ntitle: Topic\n---\n\n${BROKEN}`.replaceAll(
        "\n",
        "\r",
      ),
    });
    const listed = () => ({
      exitCode: 0,
      stdout: "site/index.md\0site/guide/[topic].md\0",
      stderr: "",
    });
    try {
      expect(await run([], listed, root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expect(printed[0]).toContain(join(root, "site/guide/[topic].md"));
  });

  it("exits 1 on a bracket-named page whatever it holds, telling the author what to do", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture({
      "site/index.md": `# Home\n\n${FLOWCHART}`,
      "site/snippets/[topic].md": "A plain-text fragment that pages include.\n",
    });
    const listed = () => ({
      exitCode: 0,
      stdout: "site/index.md\0site/snippets/[topic].md\0",
      stderr: "",
    });
    try {
      expect(await run([], listed, root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(join(root, "site/snippets/[topic].md"));
    expect(printed[0]).toContain("Rename the file");
  });

  it("exits 1 naming a symbolic link under site/, which VitePress follows and the check does not", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture({
      "site/index.md": `# Home\n\n${FLOWCHART}`,
      "docs/shared/topic.md": `# Topic\n\n${BROKEN}`,
    });
    symlinkSync("../docs/shared", join(root, "site/shared"));
    const listed = () => ({
      exitCode: 0,
      stdout: "site/index.md\0site/shared\0",
      stderr: "",
    });
    try {
      expect(await run([], listed, root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
    const printed = error.mock.calls.map((call) => String(call[0]));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(join(root, "site/shared"));
    expect(printed[0]).toContain("symbolic link");
    expect(printed[0]).toContain("Replace the link with the files");
  });

  it("exits 1 when Git cannot list the files", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = () => ({ exitCode: 128, stdout: "", stderr: "not a repo" });
    expect(await run([], failed)).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "mermaid: git ls-files failed: not a repo",
    );
  });

  it("exits 1 when there is no page to check", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fixture({ "README.md": "# Readme\n" });
    const noPages = () => ({ exitCode: 0, stdout: "README.md\0", stderr: "" });
    try {
      expect(await run([], noPages, root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true });
    }
    expect(error).toHaveBeenCalledWith("mermaid: no pages to check");
  });

  it("keeps the stand-in window until the last overlapping parse settles", async () => {
    let settleFirst = () => {};
    let settleSecond = () => {};
    const first = withWindow(
      () => new Promise<void>((resolve) => (settleFirst = resolve)),
    );
    const second = withWindow(
      () => new Promise<void>((resolve) => (settleSecond = resolve)),
    );
    expect("window" in globalThis).toBe(true);
    settleFirst();
    await first;
    expect("window" in globalThis).toBe(true);
    settleSecond();
    await second;
    expect("window" in globalThis).toBe(false);
  });

  it("keeps the stand-in document until the last overlapping parse settles", async () => {
    let settleFirst = () => {};
    let settleSecond = () => {};
    const first = withWindow(
      () => new Promise<void>((resolve) => (settleFirst = resolve)),
    );
    const second = withWindow(
      () => new Promise<void>((resolve) => (settleSecond = resolve)),
    );
    expect("document" in globalThis).toBe(true);
    settleFirst();
    await first;
    expect("document" in globalThis).toBe(true);
    settleSecond();
    await second;
    expect("document" in globalThis).toBe(false);
  });

  it("leaves a window it did not install in place", async () => {
    const own = { CSS: { supports: () => false } };
    Object.defineProperty(globalThis, "window", {
      value: own,
      configurable: true,
    });
    try {
      await withWindow(async () => {});
      expect((globalThis as { window?: unknown }).window).toBe(own);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("installs a stand-in document beside a caller's window, keeping the window", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const own = { CSS: { supports: () => true } };
    Object.defineProperty(globalThis, "window", {
      value: own,
      configurable: true,
    });
    const dir = fixture({ "page.md": `# Page\n\n${DETAILS}` });
    try {
      expect(await run([dir])).toBe(0);
      expect((globalThis as { window?: unknown }).window).toBe(own);
      expect("document" in globalThis).toBe(false);
    } finally {
      delete (globalThis as { window?: unknown }).window;
      rmSync(dir, { recursive: true });
    }
    expect(log).toHaveBeenCalledWith("mermaid: 1 diagrams in 1 pages parse");
  });

  // `bun run docs:check` runs the script under Bun, whose module loader differs from Node's: the
  // DOMPurify the script fills in must be the instance Mermaid imports there too, or a real
  // flowchart fails with `addHook is not a function`.
  it("passes a flowchart and fails a broken sequence diagram under Bun", () => {
    const dir = fixture({
      "ok.md": `# Ok\n\n${FLOWCHART}`,
      "tabs.md": `# Tabs\n\n${BROKEN}`,
    });
    try {
      // The timeout only ends a hung child, so the run fails instead of blocking; no assertion
      // depends on how long the child takes.
      const out = spawnSync("bun", [SCRIPT, dir], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(out.error).toBeUndefined();
      expect(out.status, out.stderr).toBe(1);
      expect(out.stderr).toContain(
        `${join(dir, "tabs.md")}:3: Parse error on line 4:`,
      );
      expect(out.stderr).toContain("1 of 2 diagram(s) do not parse");
      expect(out.stderr).not.toContain("ok.md");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("passes sequence diagrams with boxes under Bun", () => {
    const dir = fixture({ "page.md": `# Page\n\n${BOXES}` });
    try {
      // The timeout only ends a hung child, as above.
      const out = spawnSync("bun", [SCRIPT, dir], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(out.error).toBeUndefined();
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("mermaid: 1 diagrams in 1 pages parse");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
