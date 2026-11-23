import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

const find = await diagramReader();
const lines = async (markdown: string) =>
  (await find("site/page.md", markdown)).map((d) => d.line);

/** Writes `pages` (name to Markdown) into a fresh directory and returns it. */
function fixture(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "check-mermaid-"));
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
    expect(printed[0]).toMatch(
      new RegExp(`^${join(dir, "tabs.md")}:3: Parse error on line 4:\n`),
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
    expect(printed[0]).toMatch(
      new RegExp(`^${join(dir, "tabs.md")}:3: Parse error on line 4:\n`),
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
    expect(printed[0]).toMatch(new RegExp(`^${join(dir, "comment.md")}:3: `));
    expect(printed[1]).toMatch(new RegExp(`^${join(dir, "directive.md")}:3: `));
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
    expect(printed[0]).toMatch(
      new RegExp(`^${join(dir, "page.md")}:3: Parse error on line 5:\n`),
    );
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

  it("passes a bracket-named page that takes no injected content", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
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
      expect(await run([], listed, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true });
    }
    expect(log).toHaveBeenCalledWith("mermaid: 1 diagrams in 2 pages parse");
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
