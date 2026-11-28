import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import apiSidebar from "../api/typedoc-sidebar.json" with { type: "json" };
import { MERMAID_CLASS } from "./mermaid-class";

/** Pages link to the repository's own files (the architecture document,
 *  the examples) on GitHub. */
const REPO = "https://github.com/anishbenji/tscache";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILE = new RegExp(`^${REPO}/(?:blob|tree)/main/([^#?]+)`);

/**
 * VitePress fails the build on a dead link between pages. A link to a
 * repository file is an external URL to it, so this checks those too: the
 * file must exist in the working tree.
 */
function missingRepoFile(href: string): string | undefined {
  const path = FILE.exec(href)?.[1];
  if (path === undefined) return undefined;
  return existsSync(ROOT + decodeURIComponent(path)) ? undefined : path;
}

const config = defineConfig({
  // GitHub Pages serves the project site under the repository's name:
  // https://anishbenji.github.io/tscache/ (.github/workflows/pages.yml).
  base: "/tscache/",
  title: "tscache",
  description:
    "Browser time-series cache: SharedWorker multi-tab sharing, worker-side fetch orchestration, coverage tracking with real-gap awareness.",
  cleanUrls: true,
  srcExclude: ["README.md", "snippets/**"],
  markdown: {
    config(md) {
      md.core.ruler.push("tscache-repo-links", (state) => {
        for (const token of state.tokens) {
          for (const child of token.children ?? []) {
            const href = child.attrGet("href");
            const missing = href === null ? undefined : missingRepoFile(href);
            if (missing !== undefined) {
              throw new Error(
                `${state.env.relativePath}: links to ${missing}, which is not in the repository`,
              );
            }
          }
        }
      });
    },
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Concepts", link: "/concepts/coverage" },
      { text: "How it works", link: "/how-it-works/" },
      { text: "API", link: "/usage/client" },
      { text: "Reference", link: "/api/" },
    ],
    sidebar: {
      "/api/": [{ text: "API reference", items: apiSidebar }],
      "/": [
        {
          text: "Introduction",
          items: [
            { text: "What tscache is", link: "/" },
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Demo hub", link: "/guide/demo" },
          ],
        },
        {
          text: "Concepts",
          items: [
            { text: "Coverage and gaps", link: "/concepts/coverage" },
            { text: "Intervals and the grid", link: "/concepts/grid" },
            { text: "Segments and slots", link: "/concepts/segments" },
            { text: "Versions and watermarks", link: "/concepts/freshness" },
            {
              text: "Invalidation and clearing",
              link: "/concepts/invalidation",
            },
            { text: "Events", link: "/concepts/events" },
          ],
        },
        {
          text: "How it works",
          items: [
            { text: "Overview", link: "/how-it-works/" },
            { text: "Package map", link: "/how-it-works/package-map" },
            { text: "Data model", link: "/how-it-works/data-model" },
            { text: "Startup and fallback", link: "/how-it-works/startup" },
            { text: "A read, end to end", link: "/how-it-works/read" },
            { text: "Sharing across tabs", link: "/how-it-works/tabs" },
            { text: "Fences and invalidation", link: "/how-it-works/fences" },
            { text: "Auth refresh", link: "/how-it-works/auth" },
            { text: "Persistence", link: "/how-it-works/persistence" },
            { text: "Live feeds", link: "/how-it-works/live-feeds" },
            { text: "Code tour", link: "/how-it-works/code-tour" },
          ],
        },
        {
          text: "API by example",
          items: [
            { text: "The client", link: "/usage/client" },
            { text: "A cache", link: "/usage/cache" },
            { text: "Snapshots", link: "/usage/snapshots" },
            { text: "The fetcher module", link: "/usage/fetcher" },
            { text: "The engine", link: "/usage/engine" },
            { text: "Errors", link: "/usage/errors" },
            { text: "Generated reference", link: "/api/" },
          ],
        },
        {
          text: "Guides",
          items: [
            { text: "Workers and fallback", link: "/guides/workers" },
            { text: "Writing a fetcher", link: "/guides/fetcher" },
            { text: "The Vite plugin", link: "/guides/vite" },
            { text: "Credentials and refresh", link: "/guides/auth" },
            { text: "Server rendering", link: "/guides/ssr" },
            { text: "Live feeds", link: "/guides/live-feeds" },
            { text: "Persistence", link: "/guides/persistence" },
            { text: "Expiry and other patterns", link: "/guides/patterns" },
          ],
        },
        {
          text: "Frameworks and charts",
          items: [
            { text: "Vanilla JavaScript", link: "/frameworks/vanilla" },
            { text: "React", link: "/frameworks/react" },
            { text: "Solid", link: "/frameworks/solid" },
            { text: "Chart libraries", link: "/frameworks/charts" },
          ],
        },
        {
          text: "More",
          items: [
            { text: "Performance", link: "/performance" },
            { text: "Troubleshooting and FAQ", link: "/troubleshooting" },
            { text: "Architecture for contributors", link: "/contributing" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: REPO }],
    search: { provider: "local" },
    outline: [2, 3],
  },
});

// Renders ```mermaid fences in the browser, with Mermaid's dark theme while
// the site is dark. securityLevel 'strict' (the plugin defaults to 'loose'):
// labels are encoded as text and click handlers are off; the diagrams need
// neither. Sequence diagrams wrap their text and keep their natural size
// (the page scrolls them sideways, diagrams.css): scaled to the column, the
// flows' text would shrink to a few pixels.
//
// Mermaid 12 changed its defaults; these settings keep the 11.x look
// (docs/reviews/step-139.md):
// - theme 'default': 12 gives flowcharts and sequence diagrams their own
//   theme ('redux-color'), used whenever the site sets none. The plugin
//   still switches to 'dark' while the site is dark.
// - look 'classic': 12's per-diagram default is 'neo' (square black-bordered
//   nodes, drop shadows).
// - layout 'dagre': 12 lays out with ELK by default, which routes the package
//   map's edges at right angles and makes it three times taller.
// - flowchart wrappingWidth 200 and minNodeWidth 0: 12 wraps node labels at
//   120 px and widens every node to at least 120 px.
// - themeCSS: VitePress sets a 28 px line height on every paragraph in the
//   page, so a label's <p> grew past the box Mermaid measured at 1.5 lines
//   and its last line was cut off (on 11.x too); the label keeps Mermaid's
//   own line height instead.
//
// Each diagram's element has the class MERMAID_CLASS rather than the
// plugin's default, `mermaid`, which Mermaid's own pass at page load would
// render into while still empty (mermaid-class.ts).
export default withMermaid({
  ...config,
  mermaidPlugin: { class: MERMAID_CLASS },
  mermaid: {
    theme: "default",
    look: "classic",
    layout: "dagre",
    themeCSS: "p { line-height: inherit; }",
    flowchart: { wrappingWidth: 200, minNodeWidth: 0 },
    securityLevel: "strict",
    sequence: {
      useMaxWidth: false,
      wrap: true,
      width: 140,
      actorMargin: 30,
      messageFontSize: 14,
      noteFontSize: 14,
      actorFontSize: 14,
    },
  },
});
