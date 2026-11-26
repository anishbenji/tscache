// Catches syntax errors in the docs site's published Mermaid diagrams, outside a browser.
//
// The site renders each ```mermaid fence in the browser (vitepress-plugin-mermaid), so a syntax
// error builds cleanly and only shows on the live page as Mermaid's error box. This check parses
// those diagrams with the Mermaid the site pins, at build time.
//
// Threat model: this is a docs render check for trusted authors (the maintainer and agents). It
// catches mistakes, not a diagram written to evade it.
//
// Its limits:
//
//   - It is a syntax check, not a render. A diagram that parses but draws wrongly, or throws in
//     Mermaid's renderer, passes.
//   - It reads the regular Markdown files Git lists under `site/` plus the generated `site/api/`
//     pages; on this site today that is every published page, and also the files the site
//     excludes from publishing. It does not load the site's config (`srcExclude`, rewrites,
//     extra pages) or run a dynamic route's paths loader. The no-argument run, which
//     `docs:check` uses, fails naming the path, rather than follow it, on any name Git lists
//     under `site/` that is a symbolic link, and on any Markdown file under `site/` with a
//     bracket-named segment (VitePress's dynamic-route form), whatever it holds and excluded
//     files included; a link or a dynamic route needs the check extended first.
//   - It reads `mermaid` fences only. A page with a hand-written `<Mermaid>` tag, or a `component`
//     tag whose static `is` names Mermaid, in its raw HTML (outside a comment, a quoted attribute
//     value and a raw-text element such as `textarea`) fails, naming the page, rather than go
//     unchecked; inside `<ClientOnly>` too. That is an early, friendlier message: the authority is
//     the render check's count of the plugin's default `mermaid` class in the built HTML
//     (`e2e/docs/pages.ts`), which also catches a raw `.mermaid` element, but not a component
//     rendered only in the browser (inside `<ClientOnly>`, or behind a `v-if` on state set when
//     the page mounts), which the built HTML does not hold. A `mermaid` fence that a
//     `::: code-group` shows as code is still parsed: write a deliberately broken example as an
//     `mmd` fence or give it a title.
//   - It parses with Mermaid's default options, not the site's (`securityLevel`, `sequence`),
//     and does not apply the 50,000-character limit above which `mermaid.render` draws its
//     "Maximum text size in diagram exceeded" box instead of the diagram; the render check
//     (`e2e/docs/mermaid.spec.ts`) fails on that box.
//   - A `details` statement, whose parsing reads an element of the page, is parsed without it.
//
// How it reads and parses:
//
//   - Pages are read by VitePress's own Markdown renderer: the page is rendered, which expands
//     its `<!-- @include -->` directives (inside fences too), and the expanded text is searched
//     for fence tokens whose info is `mermaid`, inside containers and lists too.
//   - Diagrams are parsed by `mermaid.parse`, which applies the diagram's own config and runs its
//     grammar without rendering, and then by the parse step `mermaid.render` runs
//     (`mermaidAPI.getDiagramFromText`): the two preprocess the text differently, so a diagram
//     must pass both. Text that Mermaid reads as its internal `error` diagram (the word `error`
//     alone), which parses and draws the syntax error box, fails too. Outside a browser, Mermaid's DOMPurify has no window and leaves out
//     `sanitize`, `addHook` and `removeHook`, which parsing calls. The check fills them in as
//     no-ops on the very instance Mermaid imports, resolved from Mermaid's own package, before
//     Mermaid loads. Parsing only reads the text, so nothing it sanitises is ever shown. The
//     sequence parser also reads `window.CSS` to check a box's colour and `document` for
//     `details`, so each parse runs with a stand-in `window` and `document` that it removes after.
//
// Mermaid and DOMPurify are resolved through Node's resolver and their package exports, never a
// hard-coded version or path, so the check runs under Bun (`bun run docs:check`) and under Node
// (Vitest) alike, and follows whichever Mermaid `site/package.json` pins.
//
//   bun site/scripts/check-mermaid.ts                  checks the pages Git lists under site/,
//                                                      and the generated site/api/ pages
//   bun site/scripts/check-mermaid.ts <files or dirs>  checks those pages, and the pages under those dirs

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
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
  /**
   * The 1-based line the opening fence is on: a line of the page, or, when `expanded`, a line of
   * the page with its includes expanded (the fence came in with an include, or sits between two).
   */
  line: number;
  expanded?: true;
  text: string;
}

/** A diagram that does not parse. */
export interface Failure {
  file: string;
  line: number;
  expanded?: true;
  message: string;
}

/**
 * Finds the Mermaid diagrams on one Markdown page. `file` is the name the check prints; `path`,
 * the page's real path, from which its includes resolve, defaults to it.
 */
export type FindDiagrams = (
  file: string,
  markdown: string,
  path?: string,
) => Promise<Diagram[]>;

/** Parses one diagram's text, throwing Mermaid's error when it does not parse. */
export type ParseDiagram = (text: string) => Promise<unknown>;

const newlines = (text: string) => text.split("\n").length - 1;

/**
 * A reader of pages built on VitePress's Markdown renderer, with its default options: the site's
 * config adds Mermaid's fence renderer, which changes how a fence renders, not how a page parses.
 * VitePress expands a page's includes only when it renders the page (`renderAsync`, given the
 * page's path), and leaves the expanded text in `env.src`; that text is what gets parsed.
 */
export async function diagramReader(): Promise<FindDiagrams> {
  const md = await createMarkdownRenderer(SITE);
  return async (file, markdown, path = file) => {
    const rendered: { path: string; src?: string } = { path };
    await md.renderAsync(markdown, rendered);
    const src = rendered.src ?? markdown;
    const env: { content?: string } = {};
    const tokens = md.parse(src, env);
    const first = firstLine(src, env.content);
    const toPage = pageLines(markdown, src);
    if (tokens.some(holdsMermaidTag)) {
      throw new Error(
        `mermaid: ${file} has a hand-written <Mermaid> tag, which neither the syntax check nor the render check reads; write the diagram as a mermaid fence`,
      );
    }
    return tokens.flatMap((token) => {
      if (token.type !== "fence" || token.info.trim() !== "mermaid") return [];
      const line = first + (token.map?.[0] ?? 0);
      const onPage = toPage(line);
      return [
        onPage === undefined
          ? { file, line, expanded: true as const, text: token.content }
          : { file, line: onPage, text: token.content },
      ];
    });
  };
}

/**
 * An HTML comment at the scan position, which renders nothing, whatever tags its text names. It
 * ends at `<!-->` or `<!--->`, at the first `-->`, or at the end of the text when nothing closes
 * it, as in Vue's template parser (matched in one pass, never rescanned). It also ends at `--!>`,
 * where HTML ends it and Vue does not: the scan then reads more of the text as tags, so it can
 * only reject more than Vue would.
 */
const COMMENT = /<!---?>|<!--[\s\S]*?(?:--!?>|$)/y;

/**
 * Elements whose content Vue's template parser reads as text up to their closing tag (raw text
 * and RCDATA): a tag written inside one is not a component, and a quote inside one opens no
 * attribute value. Vue does so only for these four names, only when the tag's name starts with a
 * lower-case letter, and only outside `svg` and `math`; it parses `iframe`, `noscript` and `xmp`
 * content, and `<Textarea>` or `<TITLE>` content, as elements.
 */
const RAW_TEXT = new Set(["textarea", "title", "script", "style"]);

/** Each raw-text element's closing tag, in any case (a regex per name, moved with `lastIndex`). */
const RAW_TEXT_CLOSE = new Map(
  [...RAW_TEXT].map((name) => [name, new RegExp(`</${name}`, "gi")]),
);

/** Elements whose content Vue parses in a foreign (XML) namespace, where no element is raw text. */
const FOREIGN = new Set(["svg", "math"]);

/**
 * A `component` tag's static `is` (or `:is` / `v-bind:is` with a string literal) naming Mermaid in
 * any case: `<component is="Mermaid">`, which renders the same component as the tag.
 */
const IS_MERMAID = /\s(?:v-bind)?:?is\s*=\s*["']?["']?mermaid(?![\w$-])/i;

/**
 * CommonMark's open tag (a name, then attributes, each value unquoted or quoted and consumed
 * whole, then an optional `/`) or closing tag, at the scan position: a tag named in a quoted
 * value is part of the attribute, not a tag of its own. The name is group 1 or group 2.
 */
const TAG =
  /<(?:([A-Za-z][A-Za-z0-9-]*)(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|\/([A-Za-z][A-Za-z0-9-]*)\s*>)/y;

/**
 * Whether raw HTML holds a tag that opens or closes vitepress-plugin-mermaid's `<Mermaid>`
 * component, in any case, or a `component` tag whose static `is` names it. The text is scanned
 * left to right, a comment or a tag at a time, so text between tags (an apostrophe included) is
 * read as text; the content of a raw-text element (`RAW_TEXT`) is skipped to its closing tag.
 * Open `svg` and `math` tags are counted, and inside one no element is raw text. A
 * `foreignObject` inside `svg`, which returns to HTML, is not modelled: a raw-text element
 * inside one is read as elements, which can only reject more than Vue would.
 */
function hasMermaidTag(text: string): boolean {
  let foreign = 0;
  for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", at)) {
    COMMENT.lastIndex = at;
    if (COMMENT.exec(text) !== null) {
      at = COMMENT.lastIndex;
      continue;
    }
    TAG.lastIndex = at;
    const tag = TAG.exec(text);
    if (tag === null) {
      at++;
      continue;
    }
    const name = (tag[1] ?? tag[2])?.toLowerCase();
    if (name === "mermaid") return true;
    if (tag[1] !== undefined && name === "component" && IS_MERMAID.test(tag[0]))
      return true;
    at = TAG.lastIndex;
    if (name === undefined || tag[0].endsWith("/>")) continue;
    if (FOREIGN.has(name)) {
      if (tag[1] !== undefined) foreign++;
      else if (foreign > 0) foreign--;
      continue;
    }
    const close = RAW_TEXT_CLOSE.get(name);
    if (
      tag[1] !== undefined &&
      close !== undefined &&
      foreign === 0 &&
      /^[a-z]/.test(tag[1])
    ) {
      close.lastIndex = at;
      at = close.exec(text)?.index ?? text.length;
    }
  }
  return false;
}

/** The parts of a markdown-it token the tag search reads. */
interface HtmlToken {
  type: string;
  content: string;
  children: HtmlToken[] | null;
}

/**
 * Whether an HTML block, or an inline token's raw HTML, holds a `<Mermaid>` tag. markdown-it
 * splits a paragraph's raw HTML into a token per tag, so an inline token's HTML children are
 * scanned as one text, each other child read as a space: the page renders those as escaped text,
 * which holds no tag. The tag in inline code or a fence is a code or fence token, so it is not
 * matched. This is an early, friendlier message: the render check's reading of the built HTML
 * (`e2e/docs/pages.ts`) is the authority on hand-written diagrams, and catches the forms this
 * misses.
 */
function holdsMermaidTag(token: HtmlToken): boolean {
  if (token.type === "html_block" || token.type === "html_inline")
    return hasMermaidTag(token.content);
  if (token.children === null) return false;
  return hasMermaidTag(
    token.children
      .map((child) => (child.type === "html_inline" ? child.content : " "))
      .join(""),
  );
}

/**
 * Maps a 1-based line of the expanded text to the page's line, for the lines before the first
 * include and after the last, which expansion leaves as they are; undefined for the lines between.
 */
function pageLines(
  markdown: string,
  src: string,
): (line: number) => number | undefined {
  const page = markdown.split("\n");
  const expanded = src.split("\n");
  const shorter = Math.min(page.length, expanded.length);
  let before = 0;
  while (before < shorter && page[before] === expanded[before]) before++;
  let after = 0;
  while (
    after < shorter - before &&
    page[page.length - 1 - after] === expanded[expanded.length - 1 - after]
  )
    after++;
  return (line) => {
    if (line <= before) return line;
    if (line > expanded.length - after)
      return line - (expanded.length - page.length);
    return undefined;
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
    default: {
      parse: ParseDiagram;
      mermaidAPI: {
        getDiagramFromText: (text: string) => Promise<{ type: string }>;
      };
    };
  };
  return (text) =>
    withWindow(async () => {
      await api.parse(text);
      const diagram = await api.mermaidAPI.getDiagramFromText(text);
      if (diagram.type === "error")
        throw new Error(
          "Mermaid reads this fence as its error diagram, which draws the syntax error box; the fence holds no diagram",
        );
      return diagram;
    });
}

/** How many parses are running with the stand-ins; they are installed while this is not 0. */
let windowHolders = 0;
/** The globals the first holder installed, which the last one removes. */
let installed: string[] = [];

/** The stand-ins, by global name. */
const STAND_INS: Readonly<Record<string, () => unknown>> = {
  window: () => ({ CSS: { supports: () => true } }),
  document: () => ({ getElementById: () => null }),
};

/**
 * Runs `parse` with a stand-in `window` and `document` where there are none. Mermaid's sequence
 * parser reads `window?.CSS` to check a `box` colour, and `document.getElementById` to read a
 * `details` statement's element, each a ReferenceError without the global. The stand-in `window`
 * accepts every colour, which changes nothing a parse checks; the stand-in `document` has no
 * element, which Mermaid skips, so `details` is parsed without the page's element. Overlapping
 * parses share the stand-ins, installed by the first and removed when the last settles. Each
 * stand-in is installed only where its global is missing, so a `window` or `document` the caller
 * provides is left as it is.
 */
export async function withWindow<T>(parse: () => Promise<T>): Promise<T> {
  if (windowHolders === 0) {
    installed = Object.keys(STAND_INS).filter((name) => !(name in globalThis));
    for (const name of installed)
      Object.defineProperty(globalThis, name, {
        value: STAND_INS[name]?.(),
        configurable: true,
      });
  }
  windowHolders++;
  try {
    return await parse();
  } finally {
    windowHolders--;
    if (windowHolders === 0)
      for (const name of installed)
        delete (globalThis as Record<string, unknown>)[name];
  }
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
      failures.push({
        file: d.file,
        line: d.line,
        ...(d.expanded && { expanded: d.expanded }),
        message,
      });
    }
  }
  return failures;
}

/**
 * One failure as the check prints it: `file:line: ` (the fence's line) and Mermaid's message as
 * Mermaid gives it, its later lines indented. A fence an include brought in has no line on the
 * page, so its line on the expanded page is named as such. A parse error's line counts within the
 * diagram, after Mermaid strips comments, directives and the diagram's own frontmatter, so it is
 * not mapped to a page line.
 */
export function formatFailure(f: Failure): string {
  const [head = "", ...rest] = f.message.trimEnd().split("\n");
  const where = f.expanded
    ? `${f.file}, line ${f.line} of the page with its includes expanded`
    : `${f.file}:${f.line}`;
  return [`${where}: ${head}`, ...rest.map((l) => `    ${l}`)].join("\n");
}

/** What `git ls-files` printed, and its exit code. */
export interface Listing {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Lists the repository's files, tracked or new but not ignored, each ended by a NUL: with `-z`,
 * Git prints a name as it is, where it would otherwise quote one holding a non-ASCII character.
 */
function gitLsFiles(): Listing {
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
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

/**
 * VitePress's pattern for a dynamic-route template (`dynamicRouteRE`): a page such as
 * `guide/[topic].md` whose content a `[topic].paths.ts` loader may inject. The check fails on
 * every page whose path matches, whatever the page holds, rather than model how VitePress loads
 * a template.
 */
const DYNAMIC_ROUTE = /\[(\w+?)\]/;

/** A page's path as the check prints it: relative to this repository when inside it. */
function shown(full: string): string {
  const rel = relative(ROOT, full);
  return rel.startsWith("..") ? full : rel;
}

/**
 * Checks the `given` pages and directories, or the regular Markdown files Git lists under `site/`
 * of `root` plus the pages generated into `site/api/`, which Git ignores, and returns the exit
 * code: 1 when a diagram does not parse, when Git cannot list the files, when there is no page,
 * or, without `given`, when a name Git lists under `site/` is a symbolic link (VitePress follows
 * it; the check does not), or when a listed page has a bracket-named segment in its path
 * (VitePress's dynamic-route form), whatever the page holds and whether or not the site excludes
 * it. A link or a dynamic route needs the check extended first.
 */
export async function run(
  given: readonly string[],
  list: () => Listing = gitLsFiles,
  root: string = ROOT,
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
    const api = join(root, "site", "api");
    const underSite = listed.stdout
      .split("\0")
      .filter((f) => f.startsWith("site/"))
      .map((f) => join(root, f));
    const links = underSite.filter((f) =>
      lstatSync(f, { throwIfNoEntry: false })?.isSymbolicLink(),
    );
    for (const f of links)
      console.error(
        `mermaid: ${shown(f)} is a symbolic link, which VitePress follows and the check does not. Replace the link with the files, or extend the check before adding a link`,
      );
    pages = underSite
      .filter((f) => f.endsWith(".md") && existsSync(f))
      .concat(existsSync(api) ? pagesUnder(api) : []);
    const dynamic = pages.filter((f) =>
      DYNAMIC_ROUTE.test(relative(join(root, "site"), f)),
    );
    for (const f of dynamic)
      console.error(
        `mermaid: ${shown(f)} has a bracket name, which VitePress reads as a dynamic route; the check does not read dynamic routes. Rename the file, or extend the check before adding a route`,
      );
    if (links.length > 0 || dynamic.length > 0) return 1;
  }
  if (pages.length === 0) {
    console.error("mermaid: no pages to check");
    return 1;
  }
  const find = await diagramReader();
  const diagrams: Diagram[] = [];
  for (const page of pages)
    diagrams.push(
      ...(await find(shown(page), readFileSync(page, "utf8"), page)),
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
