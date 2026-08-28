import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

import type { BlockRenderer } from "./blockRenderers";
import { equationsEnabledFacet, makeRefResolver } from "./equation";
import { equationErrorMessage } from "./equationRender";
import { evaluate } from "./expr/evaluate";
import { formatResult } from "./expr/format";
import { propertyResolverFacet } from "./propertyRef";

function appendRow(
  table: HTMLElement,
  source: string,
  result: string,
  failed: boolean,
): void {
  const row = document.createElement("div");
  row.className = "cm-calc__row";
  const left = document.createElement("span");
  left.className = "cm-calc__source";
  left.textContent = source;
  const right = document.createElement("span");
  right.className = failed
    ? "cm-calc__result cm-calc__result--error"
    : "cm-calc__result";
  right.textContent = result;
  row.append(left, right);
  table.appendChild(row);
}

export function renderCalcBlock(
  source: string,
  state: EditorState,
): HTMLElement {
  const host = document.createElement("div");
  host.className = "cm-calc";
  const resolver = state.facet(propertyResolverFacet);
  const resolve = makeRefResolver(resolver, () => state.doc.toString());

  const lines = source.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    host.classList.add("cm-calc--empty");
    host.textContent = "Empty calculation block";
    return host;
  }

  for (const line of lines) {
    const expression = line.trim();
    const outcome = evaluate(expression, resolve);
    if (outcome.status === "ok") {
      appendRow(host, expression, formatResult(outcome.value), false);
    } else if (outcome.status === "loading") {
      appendRow(host, expression, "…", false);
    } else {
      appendRow(host, expression, equationErrorMessage(outcome.kind), true);
    }
  }
  return host;
}

export const calcBlockRenderer: BlockRenderer = {
  id: "calc",
  languages: ["calc"],
  frameClass: "cm-block-frame cm-calc-frame",
  estimatedHeight: 48,
  completions: [{ language: "calc", detail: "Calculation" }],
  active: (state) => state.facet(equationsEnabledFacet),
  revision: (state) => state.facet(propertyResolverFacet)?.version(),
  render: (source, ctx) => renderCalcBlock(source, ctx.state),
};

export const calcBlockBaseTheme = EditorView.baseTheme({
  ".cm-calc__row": {
    display: "flex",
    justifyContent: "space-between",
    gap: "1.5rem",
    fontFamily: "var(--font-mono)",
  },
  ".cm-calc__source": {
    color: "var(--c-fg-muted)",
  },
  ".cm-calc__result": {
    color: "var(--c-accent)",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-calc__result--error": {
    color: "var(--c-warning, var(--c-fg-muted))",
  },
  ".cm-calc--empty": {
    color: "var(--c-fg-muted)",
    fontStyle: "italic",
  },
});
