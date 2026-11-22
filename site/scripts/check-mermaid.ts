// Fails when a Mermaid diagram in the docs site does not parse.
//
// The site renders every ```mermaid fence in the browser (vitepress-plugin-mermaid), so a syntax
// error builds cleanly and only shows on the live page as Mermaid's error box. This check parses
// each diagram with the Mermaid the site pins, at build time.
//
//   - Pages are parsed by VitePress's own Markdown renderer, so a fence is found exactly as the
//     site finds it: a fence token whose info is `mermaid`, inside containers and lists too.
//   - Diagrams are parsed by `mermaid.parse`, which runs the diagram's grammar without rendering.
//     Outside a browser, Mermaid's DOMPurify has no window and leaves out `sanitize`, `addHook` and
//     `removeHook`, which parsing calls. The check fills them in as no-ops on the very instance
//     Mermaid imports, resolved from Mermaid's own package, before Mermaid loads. Parsing only reads
//     the text, so nothing it sanitises is ever shown.
//
// Mermaid and DOMPurify are resolved through Node's resolver and their package exports, never a
// hard-coded version or path, so the check runs under Bun (`bun run docs:check`) and under Node
// (Vitest) alike, and follows whichever Mermaid `site/package.json` pins.
//
//   bun site/scripts/check-mermaid.ts                  checks every page Git lists under site/
//   bun site/scripts/check-mermaid.ts <files or dirs>  checks those pages, and the pages under those dirs

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMarkdownRenderer } from "vitepress";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SITE = join(ROOT, "site");

/** A Mermaid fence on a page. */
export interface Diagram {
  file: string;
  /** The 1-based line of the page the opening fence is on. */
  line: number;
  text: string;
}

/** A diagram that does not parse. */
export interface Failure {
  file: string;
  line: number;
  message: string;
}

/** Finds the Mermaid diagrams on one Markdown page. */
export type FindDiagrams = (file: string, markdown: string) => Diagram[];

/** Parses one diagram's text, throwing Mermaid's error when it does not parse. */
export type ParseDiagram = (text: string) => Promise<unknown>;

const newlines = (text: string) => text.split("\n").length - 1;

/**
 * A reader of pages built on VitePress's Markdown renderer, with its default options: the site's
 * config adds Mermaid's fence renderer, which changes how a fence renders, not how a page parses.
 */
export async function diagramReader(): Promise<FindDiagrams> {
  const md = await createMarkdownRenderer(SITE);
  return (file, markdown) => {
    const env: { content?: string } = {};
    const tokens = md.parse(markdown, env);
    const first = firstLine(markdown, env.content);
    return tokens.flatMap((token) =>
      token.type === "fence" && token.info.trim() === "mermaid"
        ? [{ file, line: first + (token.map?.[0] ?? 0), text: token.content }]
        : [],
    );
  };
}

/**
 * The 1-based line of the page where the parsed text starts. VitePress strips the frontmatter
 * before parsing and leaves the rest of the page as `content`.
 */
function firstLine(markdown: string, content = markdown): number {
  if (!markdown.endsWith(content)) {
    throw new Error("mermaid: the frontmatter is not a prefix of the page");
  }
  return 1 + newlines(markdown.slice(0, markdown.length - content.length));
}

/** A package's directory and manifest, resolved from `from` as Node resolves it. */
function packageOf(
  name: string,
  from: string,
): { dir: string; manifest: Manifest } {
  let dir = dirname(
    realpathSync(createRequire(join(from, "noop.js")).resolve(name)),
  );
  for (;;) {
    const path = join(dir, "package.json");
    if (existsSync(path)) {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
      if (manifest.name === name) return { dir, manifest };
    }
    const up = dirname(dir);
    if (up === dir)
      throw new Error(`mermaid: no package.json for ${name} above ${from}`);
    dir = up;
  }
}

interface Manifest {
  name?: string;
  module?: string;
  exports?: unknown;
}

/**
 * The file an ES module `import` of a package's root loads: its `"."` export's `import` entry.
 * It takes `import`, then `default`, at each level, not the condition order Node and Bun apply. A
 * package that lists `node`, `bun` or `module-sync` first, pointing at another file, would load a
 * second DOMPurify the fill-in misses; every real diagram then fails loudly, and the flowchart test
 * catches it.
 */
export function importEntry(manifest: Manifest): string {
  let entry: unknown = manifest.exports;
  if (entry !== null && typeof entry === "object" && "." in entry)
    entry = entry["."];
  for (;;) {
    if (typeof entry === "string") return entry;
    if (entry === null || typeof entry !== "object") break;
    const conditions = entry as Record<string, unknown>;
    const next = conditions.import ?? conditions.default;
    if (next === undefined) break;
    entry = next;
  }
  if (manifest.module !== undefined) return manifest.module;
  throw new Error(`mermaid: ${manifest.name} has no ES module entry`);
}

const importOf = (pkg: { dir: string; manifest: Manifest }) =>
  pathToFileURL(join(pkg.dir, importEntry(pkg.manifest))).href;

/** Loads the site's Mermaid, with the DOMPurify methods parsing needs filled in. */
export async function mermaidParser(): Promise<ParseDiagram> {
  const mermaid = packageOf("mermaid", SITE);
  const purify = packageOf("dompurify", mermaid.dir);
  const { default: DOMPurify } = (await import(importOf(purify))) as {
    default: Record<string, unknown>;
  };
  Object.assign(DOMPurify, {
    sanitize: (text: string) => text,
    addHook: () => {},
    removeHook: () => {},
  });
  const { default: api } = (await import(importOf(mermaid))) as {
    default: { parse: ParseDiagram };
  };
  return (text) => api.parse(text);
}

/** The diagrams that do not parse, each with Mermaid's message. */
export async function checkDiagrams(
  diagrams: readonly Diagram[],
  parse: ParseDiagram,
): Promise<Failure[]> {
  const failures: Failure[] = [];
  for (const d of diagrams) {
    try {
      await parse(d.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ file: d.file, line: d.line, message });
    }
  }
  return failures;
}

/**
 * One failure as the check prints it: `file:line: ` (the fence's line) and Mermaid's message as
 * Mermaid gives it, its later lines indented. A parse error's line counts within the diagram, after
 * Mermaid strips comments, directives and the diagram's own frontmatter, so it is not mapped to a
 * page line.
 */
export function formatFailure(f: Failure): string {
  const [head = "", ...rest] = f.message.trimEnd().split("\n");
  return [`${f.file}:${f.line}: ${head}`, ...rest.map((l) => `    ${l}`)].join(
    "\n",
  );
}

/** What `git ls-files` printed, and its exit code. */
export interface Listing {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Lists the repository's files, tracked or new but not ignored. */
function gitLsFiles(): Listing {
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return {
    exitCode: listed.status ?? 1,
    stdout: listed.stdout ?? "",
    stderr: listed.stderr ?? String(listed.error ?? ""),
  };
}

/** The Markdown pages under `dir`, outside `node_modules`, in a stable order. */
function pagesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter(
      (f) => f.endsWith(".md") && !f.split(/[\\/]/).includes("node_modules"),
    )
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile())
    .sort();
}

/** A page's path as the check prints it: relative to the repository when inside it. */
function shown(full: string): string {
  const rel = relative(ROOT, full);
  return rel.startsWith("..") ? full : rel;
}

/**
 * Checks the `given` pages and directories, or every page Git lists under `site/`, and returns the
 * exit code: 1 when a diagram does not parse, when Git cannot list the files, or when there is no
 * page.
 */
export async function run(
  given: readonly string[],
  list: () => Listing = gitLsFiles,
): Promise<number> {
  let pages: string[];
  if (given.length > 0) {
    pages = given.flatMap((g) => {
      const full = resolve(g);
      return existsSync(full) && statSync(full).isDirectory()
        ? pagesUnder(full)
        : [full];
    });
  } else {
    const listed = list();
    if (listed.exitCode !== 0) {
      console.error(`mermaid: git ls-files failed: ${listed.stderr}`);
      return 1;
    }
    pages = listed.stdout
      .split("\n")
      .filter((f) => f.startsWith("site/") && f.endsWith(".md"))
      .map((f) => join(ROOT, f))
      .filter((f) => existsSync(f));
  }
  if (pages.length === 0) {
    console.error("mermaid: no pages to check");
    return 1;
  }
  const find = await diagramReader();
  const diagrams = pages.flatMap((page) =>
    find(shown(page), readFileSync(page, "utf8")),
  );
  const failures = await checkDiagrams(diagrams, await mermaidParser());
  for (const f of failures) console.error(formatFailure(f));
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} of ${diagrams.length} diagram(s) do not parse. Fix each at the line shown.`,
    );
    return 1;
  }
  console.log(
    `mermaid: ${diagrams.length} diagrams in ${pages.length} pages parse`,
  );
  return 0;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
