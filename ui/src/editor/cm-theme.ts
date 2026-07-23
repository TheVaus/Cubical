import { EditorView } from "@codemirror/view";
import { type Extension } from "@codemirror/state";

const TOKENS = [
  "--c-bg-primary",
  "--c-fg-primary",
  "--editor-caret",
  "--editor-selection-bg",
  "--font-mono",
  "--text-sm",
  "--space-3",
] as const;

type Token = (typeof TOKENS)[number];

function readTokens(): Record<Token, string> {
  const computed = getComputedStyle(document.documentElement);
  const out = {} as Record<Token, string>;
  for (const name of TOKENS) {
    out[name] = computed.getPropertyValue(name).trim();
  }
  return out;
}

export function buildCmTheme(): Extension {
  const t = readTokens();
  const dark = document.documentElement.getAttribute("data-theme") === "dark";

  return EditorView.theme(
    {
      "&": {
        flex: "1 0 auto",
        fontFamily: t["--font-mono"],
        fontSize: t["--text-sm"],
        color: t["--c-fg-primary"],
        background: "transparent",
      },
      ".cm-scroller": { overflow: "visible" },
      ".cm-content": {
        padding: t["--space-3"],
        caretColor: t["--editor-caret"],
      },
      "&.cm-focused": { outline: "none" },
      ".cm-content ::selection": { background: t["--editor-selection-bg"] },
      ".cm-line::selection": { background: t["--editor-selection-bg"] },
    },
    { dark },
  );
}
