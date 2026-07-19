/**
 * Shared inline-style helpers for the Properties cells (L2 Session F).
 *
 * Every value resolves to a `var(--…)` design token — no hardcoded
 * colors, fonts, or spacing (spec §6 DoD). Cubical's components style
 * via inline objects (see `App.tsx` / `Editor.tsx`); these helpers keep
 * the cell inputs consistent without a CSS-class layer.
 */

import type { JSX } from "solid-js";

/** Text-like input styling, with an accent border while focused. */
export function inputStyle(focused: boolean): JSX.CSSProperties {
  return {
    width: "100%",
    "box-sizing": "border-box",
    padding: "var(--space-1) var(--space-2)",
    "font-family": "var(--font-body)",
    "font-size": "var(--text-sm)",
    color: "var(--c-fg-primary)",
    background: "var(--c-bg-primary)",
    border: `1px solid ${focused ? "var(--c-accent)" : "var(--c-border-subtle)"}`,
    "border-radius": "var(--radius-sm)",
    outline: "none",
    transition: "border-color var(--transition-fast)",
  };
}
