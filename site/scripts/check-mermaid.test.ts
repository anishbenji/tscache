import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diagramReader,
  formatFailure,
  importEntry,
  run,
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

const find = await diagramReader();
const lines = (markdown: string) =>
  find("site/page.md", markdown).map((d) => d.line);

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
  it("finds each mermaid fence at its opening line, frontmatter included", () => {
    const page = `---\ntitle: T\n---\n\n# T\n\n${FLOWCHART}\nText.\n\n${SEQUENCE}`;
    expect(lines(page)).toEqual([7, 16]);
  });

  it("finds a fence inside a container or a list, as the site renders it", () => {
    const page = `::: details Diagram\n\n${FLOWCHART}\n:::\n\n- item\n\n  ${SEQUENCE.replaceAll("\n", "\n  ")}`;
    expect(lines(page)).toEqual([3, 14]);
  });

  it("ignores fences of other languages and mermaid shown as code", () => {
    const page = `\`\`\`ts\nconst a = 1;\n\`\`\`\n\n\`\`\`\`md\n${FLOWCHART}\`\`\`\`\n`;
    expect(lines(page)).toEqual([]);
  });

  it("keeps the diagram's text without the fence", () => {
    const [diagram] = find("site/page.md", fence("flowchart LR\n  A --> B"));
    expect(diagram?.text).toBe("flowchart LR\n  A --> B\n");
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
    const listed = () => ({
      exitCode: 0,
      stdout: "README.md\nsite/index.md\n",
      stderr: "",
    });
    expect(await run([], listed)).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(
      /^mermaid: \d+ diagrams in 1 pages parse$/,
    );
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
    const noPages = () => ({ exitCode: 0, stdout: "README.md\n", stderr: "" });
    expect(await run([], noPages)).toBe(1);
    expect(error).toHaveBeenCalledWith("mermaid: no pages to check");
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
});
