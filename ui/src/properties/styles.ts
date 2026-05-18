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

/** A rounded chip pill (string-list / tag-list members). */
export function chipStyle(isTag: boolean): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    gap: "var(--space-1)",
    padding: "0 var(--space-2)",
    height: "1.5rem",
    "font-family": isTag ? "var(--font-mono)" : "var(--font-body)",
    "font-size": "var(--text-xs)",
    color: isTag ? "var(--c-accent)" : "var(--c-fg-primary)",
    background: "var(--c-bg-tertiary)",
    border: "1px solid var(--c-border-subtle)",
    "border-radius": "var(--radius-full)",
  };
}

/** A small chrome button (chip `×`, `+ add`, type chevron). */
export function miniButtonStyle(): JSX.CSSProperties {
  return {
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    padding: "0 var(--space-1)",
    "font-family": "var(--font-body)",
    "font-size": "var(--text-xs)",
    color: "var(--c-fg-muted)",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    "line-height": "1",
  };
}
