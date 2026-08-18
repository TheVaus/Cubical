import katex from "katex";
import { EditorView } from "@codemirror/view";
import { Facet } from "@codemirror/state";

import type { BlockRenderer } from "./blockRenderers";

export const mathEnabledFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? true,
});

export interface MathRenderOptions {
  displayMode: boolean;
}

export function renderMath(
  source: string,
  options: MathRenderOptions,
): HTMLElement {
  const host = document.createElement("div");
  host.className = options.displayMode
    ? "cm-math cm-math--display"
    : "cm-math cm-math--inline";
  const expression = source.trim();
  if (!expression) {
    host.classList.add("cm-math--empty");
    host.textContent = "Empty math block";
    return host;
  }
  try {
    katex.render(expression, host, {
      displayMode: options.displayMode,
      throwOnError: true,
      strict: false,
      output: "htmlAndMathml",
    });
  } catch (err) {
    host.classList.add("cm-math--error");
    host.textContent =
      err instanceof Error ? err.message : "Could not render math";
  }
  return host;
}

export const mathBlockRenderer: BlockRenderer = {
  id: "math",
  languages: ["math", "latex", "katex"],
  frameClass: "cm-block-frame cm-math-frame",
  estimatedHeight: 48,
  completions: [
    { language: "math", detail: "Math", aliases: ["latex", "katex"] },
  ],
  active: (state) => state.facet(mathEnabledFacet),
  render: (source) => renderMath(source, { displayMode: true }),
};

export const mathBaseTheme = EditorView.baseTheme({
  ".cm-math-frame": {
    textAlign: "center",
  },
  ".cm-math--error": {
    color: "var(--c-warning, var(--c-fg-muted))",
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    textAlign: "left",
    whiteSpace: "pre-wrap",
  },
  ".cm-math--empty": {
    color: "var(--c-fg-muted)",
    fontStyle: "italic",
  },
});
