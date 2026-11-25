// The default theme, plus the stylesheet of the "How it works" diagrams:
// their inline SVGs draw with the theme's colour variables.
import mermaid from "mermaid";
import DefaultTheme from "vitepress/theme";
import "./diagrams.css";

// vitepress-plugin-mermaid draws each diagram itself, and turns Mermaid's
// startOnLoad off only when it first draws, which is after the window's load
// event. Left on until then, Mermaid's own pass at load renders every
// diagram element from its contents, still empty, and draws its "Syntax
// error in text" box into each until the plugin's diagram replaces it
// (docs/reviews/step-145.md). The theme runs before the load event.
mermaid.startOnLoad = false;

export default DefaultTheme;
