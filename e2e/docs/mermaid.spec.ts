import { expect, test } from "@playwright/test";
import { MERMAID_CLASS } from "../../site/.vitepress/mermaid-class";
import { diagramPages } from "./pages";

// The documentation site's Mermaid diagrams, drawn in a browser. The syntax
// check (site/scripts/check-mermaid.ts, in docs:check) parses each diagram
// outside a browser; this opens every page of the built site that holds one
// and fails, naming the page, when a diagram is not drawn, when Mermaid draws
// its error box, even for a moment, or when the page logs an error. Each page
// is opened in the light and the dark colour scheme, since the site draws its
// diagrams with Mermaid's dark theme while the site is dark, and the run
// checks that the site took the scheme.
//
// The site is served as built (`bun run docs:build`, which `bun run ci` runs
// before Playwright) by scripts/docs-server.ts (playwright.config.ts).

declare global {
  interface Window {
    /** How many errors the page has logged or thrown (see the init script). */
    __docErrors?: number;
    /** How many of Mermaid's error marks have been added to the page. */
    __docErrorMarks?: number;
  }
}

/**
 * What Mermaid's error rendering draws: the error diagram it draws for a
 * diagram that does not parse (its icon and its "Syntax error in text"
 * lines), and the same marks drawn into a diagram whose renderer threw.
 */
const ERROR_MARKS = ".error-icon, .error-text";

/**
 * The temporary element `mermaid.render` draws a diagram in, at the end of
 * the body, removed when the render succeeds and left when it fails.
 */
const RENDERING = 'body > [id^="dmermaid-"]';

/**
 * The text of the diagram Mermaid draws in place of one whose text, comments
 * stripped, is longer than its `maxTextSize` (50,000 characters by default):
 * an ordinary flowchart, drawn without an error, so no other check here sees
 * it. Mermaid's source is always `graph TB;a[<this text>];style a fill:#faa`,
 * so the check matches that structure, not the text alone: a valid diagram
 * may quote the message.
 */
const SIZE_LIMIT = "Maximum text size in diagram exceeded";

/** The element vitepress-plugin-mermaid renders each diagram into. */
const DIAGRAM = `div.${MERMAID_CLASS}`;

const pages = await diagramPages();

test("the built site has pages with Mermaid diagrams", () => {
  expect(pages.length).toBeGreaterThan(0);
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} scheme`, () => {
    test.use({ colorScheme });

    for (const { path, source, diagrams, elements } of pages) {
      test(`${source} draws its ${diagrams} diagram(s)`, async ({ page }) => {
        const where = `${source} (${colorScheme})`;
        // A fence shown as code has no diagram element, so the wait below
        // would last to the test's time limit: fail at once instead.
        expect(
          elements,
          `${where}: diagram elements in the built HTML, against the page's mermaid fences. Fewer elements than fences means a fence is shown as code, as an untitled mermaid fence in a ::: code-group is: give the fence a title or write it as mmd`,
        ).toBe(diagrams);
        const errors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        page.on("pageerror", (error) => errors.push(error.message));
        // Counts, inside the page, the errors it logs and every error mark
        // Mermaid adds, from before the page's first script: an error box
        // that a later render replaces is caught too, and the wait below ends
        // as soon as either happens rather than at the test's time limit.
        await page.addInitScript((marks) => {
          window.__docErrors = 0;
          window.__docErrorMarks = 0;
          const error = () => {
            window.__docErrors = (window.__docErrors ?? 0) + 1;
          };
          const log = console.error.bind(console);
          console.error = (...args: unknown[]) => {
            error();
            log(...args);
          };
          window.addEventListener("error", error);
          window.addEventListener("unhandledrejection", error);
          new MutationObserver((records) => {
            for (const record of records)
              for (const node of record.addedNodes)
                if (
                  node instanceof Element &&
                  (node.matches(marks) || node.querySelector(marks) !== null)
                )
                  window.__docErrorMarks = (window.__docErrorMarks ?? 0) + 1;
          }).observe(document, { childList: true, subtree: true });
        }, ERROR_MARKS);

        await page.goto(path);
        // Drawn, failed or erred: every diagram's element holds an SVG and
        // no render is under way, or Mermaid has drawn an error mark, or the
        // page has logged an error, or it has more diagram elements than
        // fences (an element with no fence, which no render would fill).
        await page.waitForFunction(
          ({ expected, diagram, rendering }) => {
            if ((window.__docErrors ?? 0) > 0) return true;
            if ((window.__docErrorMarks ?? 0) > 0) return true;
            const boxes = [...document.querySelectorAll(diagram)];
            if (boxes.length > expected) return true;
            return (
              boxes.length >= expected &&
              boxes.every((box) => box.querySelector("svg") !== null) &&
              document.querySelector(rendering) === null
            );
          },
          { expected: diagrams, diagram: DIAGRAM, rendering: RENDERING },
        );

        const found = await page.evaluate(
          ({ diagram, marks, rendering, sizeLimit }) => ({
            drawn: [...document.querySelectorAll(diagram)].map(
              (box) => box.querySelector("svg") !== null,
            ),
            // Mermaid's replacement diagram: a flowchart with one node and
            // no edge, whose text is the message and whose shape is filled
            // #faa. A diagram that only quotes the message is not one.
            sizeLimited: [...document.querySelectorAll(diagram)].filter(
              (box) => {
                const svg = box.querySelector(
                  'svg[aria-roledescription^="flowchart"]',
                );
                if (svg === null) return false;
                const nodes = svg.querySelectorAll("g.node");
                const node = nodes[0];
                if (nodes.length !== 1 || node === undefined) return false;
                if (svg.querySelectorAll(".edgePaths > *").length > 0)
                  return false;
                const shape = node.querySelector("rect, path, polygon");
                return (
                  node.textContent?.trim() === sizeLimit &&
                  /fill:\s*#faa\b/i.test(shape?.getAttribute("style") ?? "")
                );
              },
            ).length,
            marksAdded: window.__docErrorMarks ?? 0,
            marksShown: document.querySelectorAll(marks).length,
            rendering: document.querySelectorAll(rendering).length,
            errorDiagram:
              document.querySelector('svg[aria-roledescription="error"]') !==
              null,
            // VitePress's class for its dark appearance, which it sets from
            // the colour scheme and the plugin draws Mermaid's dark theme by.
            dark: document.documentElement.classList.contains("dark"),
          }),
          {
            diagram: DIAGRAM,
            marks: ERROR_MARKS,
            rendering: RENDERING,
            sizeLimit: SIZE_LIMIT,
          },
        );
        expect(
          found.dark,
          `${where}: the page's html element has the class dark`,
        ).toBe(colorScheme === "dark");
        expect(errors, `${where} logged errors`).toEqual([]);
        expect(
          found.marksAdded,
          `${where}: Mermaid drew its error box (marks added while loading)`,
        ).toBe(0);
        expect(found.marksShown, `${where}: Mermaid's error box is shown`).toBe(
          0,
        );
        expect(
          found.errorDiagram,
          `${where}: Mermaid drew its error diagram`,
        ).toBe(false);
        expect(found.rendering, `${where}: a render did not finish`).toBe(0);
        expect(
          found.sizeLimited,
          `${where}: Mermaid drew "${SIZE_LIMIT}" in place of a diagram whose text, comments stripped, is over its 50,000-character limit; shorten or split the diagram`,
        ).toBe(0);
        expect(
          found.drawn.length,
          `${where}: diagram elements on the page, against the page's mermaid fences`,
        ).toBe(diagrams);
        expect(
          found.drawn.filter((drawn) => !drawn).length,
          `${where}: diagrams not drawn`,
        ).toBe(0);
      });
    }
  });
}
