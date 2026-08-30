import { EditorView } from "@codemirror/view";

import { errorMessage } from "../errorMessage";

export const RENDER_FAILED_CLASS = "cm-render-failed";

export function renderGuarded(what: string, render: () => Node): Node {
  try {
    return render();
  } catch (err) {
    console.error(`${what} failed to render`, err);
    const host = document.createElement("div");
    host.className = RENDER_FAILED_CLASS;
    host.textContent = `⚠ ${what} could not be rendered: ${errorMessage(err)}`;
    return host;
  }
}

export const renderFailureBaseTheme = EditorView.baseTheme({
  [`.${RENDER_FAILED_CLASS}`]: {
    color: "var(--c-warning, var(--c-fg-muted))",
    fontStyle: "italic",
  },
});
