import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import apiSidebar from "../api/typedoc-sidebar.json" with { type: "json" };

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
export default withMermaid({
  ...config,
  mermaid: {
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
