// The documentation site's pages that hold Mermaid diagrams, for the render
// check (mermaid.spec.ts). The pages are those of the built site
// (site/.vitepress/dist, from `bun run docs:build`), so the list follows the
// site's config (`srcExclude`, the generated api/ pages) without repeating
// it. Each page's diagrams are counted in the Markdown it was built from, by
// the reader the syntax check uses (site/scripts/check-mermaid.ts), so a
// diagram the browser never draws is missed, not skipped.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Every page of the built site that holds a `mermaid` fence, in path order.
 * Throws when the site is not built, or when a built page has no Markdown
 * page behind it, which a page from a dynamic route or a rewrite would be:
 * the list would then miss its diagrams.
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
    if (diagrams.length > 0) {
      pages.push({ path: servedPath(html), source, diagrams: diagrams.length });
    }
  }
  return pages;
}
