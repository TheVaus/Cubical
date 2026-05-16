/**
 * CodeMirror 6 theme generator — L2 Session D (spec §2.5).
 *
 * `buildCmTheme` reads the *computed* design-token values off
 * `<html>` and produces a CM6 theme `Extension` for the editor chrome
 * — background, text colour, caret, selection. It is rebuilt and
 * swapped into the editor's theme `Compartment` (see `Editor.tsx`)
 * whenever `data-theme` flips.
 *
 * Reading computed values (rather than letting CM6's injected CSS
 * carry raw `var(--…)` references) means the chrome and the Solid UI
 * derive from the *same* token surface — one source of truth. When a
 * user later (L5) installs a theme that overrides those tokens, the
 * editor re-themes in lockstep with no editor-code change.
 *
 * Session B's `decorationBaseTheme` already references live
 * `var(--…)`; it re-themes for free and is untouched here. This file
 * owns only the chrome the decorations don't.
 *
 * `buildCmTheme` MUST be called *after* `data-theme` has been written
 * (see `applyTheme` in `../styles/theme.ts`) so `getComputedStyle`
 * reflects the theme being switched to.
 */
import { EditorView } from "@codemirror/view";
import { type Extension } from "@codemirror/state";

/** The editor-chrome tokens this theme consumes. */
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

/** Snapshot every chrome token's computed value in one `getComputedStyle`. */
function readTokens(): Record<Token, string> {
  const computed = getComputedStyle(document.documentElement);
  const out = {} as Record<Token, string>;
  for (const name of TOKENS) {
    out[name] = computed.getPropertyValue(name).trim();
  }
  return out;
}

/**
 * Build the editor-chrome CM6 theme from the tokens currently in
 * effect on `<html>`. Call after `applyTheme` so the snapshot matches
 * the theme being switched to.
 */
export function buildCmTheme(): Extension {
  const t = readTokens();
  const dark = document.documentElement.getAttribute("data-theme") === "dark";

  return EditorView.theme(
    {
      "&": {
        height: "100%",
        fontFamily: t["--font-mono"],
        fontSize: t["--text-sm"],
        color: t["--c-fg-primary"],
        background: t["--c-bg-primary"],
      },
      ".cm-scroller": { overflow: "auto" },
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
