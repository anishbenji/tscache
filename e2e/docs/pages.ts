// The documentation site's pages that hold Mermaid diagrams, for the render
// check (mermaid.spec.ts). The pages are those of the built site
// (site/.vitepress/dist, from `bun run docs:build`), so the list follows the
// site's config (`srcExclude`, the generated api/ pages) without repeating
// it. A page is checked when its built HTML has a diagram element or the
// Markdown it was built from has a `mermaid` fence. The fences, counted by
// the reader the syntax check uses (site/scripts/check-mermaid.ts), are the
// number of diagrams the page must draw: a diagram the browser never draws
// fails the count rather than going unchecked, and so does a diagram element
// with no fence behind it.
//
// The built HTML is the authority on hand-written diagrams. A page whose HTML
// has an element with the class `mermaid`, the plugin's default, fails,
// naming the page: the `<Mermaid>` tag, `<component is="Mermaid">` in either
// form and a raw `<div class="mermaid">` all render one, and neither check
// reads it. (The syntax check's rejection of a `<Mermaid>` tag in the
// Markdown is an earlier, friendlier message for the common form.) The
// residual: a dynamic component given a class of its own renders no
// `mermaid` class and is not detected; closing that would mean opening all
// of the site's pages in the browser, not only those with diagrams.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MERMAID_CLASS } from "../../site/.vitepress/mermaid-class";
import { diagramReader } from "../../site/scripts/check-mermaid";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SITE = join(ROOT, "site");
const DIST = join(SITE, ".vitepress", "dist");

/** A built page with Mermaid diagrams. */
export interface DiagramPage {
  /** The page's path below the site's base, as the built site serves it. */
  path: string;
  /** The Markdown page it was built from, relative to the repository. */
  source: string;
  /** How many `mermaid` fences the page holds, includes expanded. */
  diagrams: number;
  /**
   * How many diagram elements the built HTML has, before Mermaid draws:
   * fewer than `diagrams` when a fence is shown as code, as an untitled
   * `mermaid` fence in a `::: code-group` is.
   */
  elements: number;
}

/**
 * The class vitepress-plugin-mermaid's `<Mermaid>` component renders its
 * wrapper with when it is not given one: the site's fences give it
 * `MERMAID_CLASS`, so this class in the built HTML comes from a component
 * written by hand (the tag, or `<component is="Mermaid">`) or from a raw
 * `.mermaid` element, which Mermaid's own load pass draws.
 */
const DEFAULT_CLASS = "mermaid";

/**
 * How many elements of the built HTML have `className` among their classes:
 * the elements as server-rendered, before Mermaid draws into them. The build
 * escapes `<` and `"` in text and attribute values, so the class is matched
 * only in a real `class` attribute.
 */
export function elementsWithClass(html: string, className: string): number {
  let count = 0;
  for (const [, classes = ""] of html.matchAll(/\sclass="([^"]*)"/g)) {
    if (classes.split(/\s+/).includes(className)) count++;
  }
  return count;
}

/**
 * The served path of a built HTML file: the site sets `cleanUrls`, so
 * `guide/demo.html` is served at `guide/demo` and `how-it-works/index.html`
 * at `how-it-works/`.
 */
function servedPath(html: string): string {
  if (html === "index.html") return "./";
  if (html.endsWith("/index.html")) return html.slice(0, -"index.html".length);
  return html.slice(0, -".html".length);
}

/**
 * Every page of the built site with a `mermaid` fence or a diagram element,
 * in path order.
 * Throws when the site is not built, when a built page has no Markdown
 * page behind it, which a page from a dynamic route or a rewrite would be
 * (the list would then miss its diagrams), or when a built page has an
 * element with the plugin's default class, which only a hand-written
 * diagram renders.
 */
export async function diagramPages(): Promise<DiagramPage[]> {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error(
      `docs: the site is not built (no ${relative(ROOT, DIST)}/index.html); run bun run docs:build first`,
    );
  }
  const find = await diagramReader();
  const pages: DiagramPage[] = [];
  const built = readdirSync(DIST, { recursive: true, encoding: "utf8" })
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.endsWith(".html") && f !== "404.html")
    .sort();
  for (const html of built) {
    const markdown = join(SITE, html.replace(/\.html$/, ".md"));
    const source = relative(ROOT, markdown);
    if (!existsSync(markdown)) {
      throw new Error(
        `docs: ${html} was built from no Markdown page at ${source}; extend the render check before adding a rewrite or a dynamic route`,
      );
    }
    const diagrams = await find(
      source,
      readFileSync(markdown, "utf8"),
      markdown,
    );
    const content = readFileSync(join(DIST, html), "utf8");
    if (elementsWithClass(content, DEFAULT_CLASS) > 0) {
      throw new Error(
        `docs: ${html} (from ${source}) has an element with the class ${DEFAULT_CLASS}, which a hand-written <Mermaid> component or .mermaid element renders and neither the syntax check nor the render check reads; write the diagram as a mermaid fence`,
      );
    }
    const elements = elementsWithClass(content, MERMAID_CLASS);
    if (diagrams.length > 0 || elements > 0) {
      pages.push({
        path: servedPath(html),
        source,
        diagrams: diagrams.length,
        elements,
      });
    }
  }
  return pages;
}
