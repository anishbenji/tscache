/**
 * The class of the element vitepress-plugin-mermaid draws each diagram into
 * (its `mermaidPlugin.class` option, in config.ts), which the stylesheet
 * (theme/diagrams.css) and the render check (e2e/docs/) select by.
 *
 * Not the plugin's default, `mermaid`: Mermaid registers a handler on the
 * window's `load` event that, while its `startOnLoad` is on, renders every
 * `.mermaid` element from its contents. The plugin turns `startOnLoad` off
 * only when it first draws, after the `load` event, so that pass rendered
 * each of its elements while still empty and drew Mermaid's "Syntax error
 * in text" box into it until the plugin's diagram replaced it
 * (docs/reviews/step-145.md). Under another class the pass finds nothing.
 */
export const MERMAID_CLASS = "mermaid-diagram";
