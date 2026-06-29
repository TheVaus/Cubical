/**
 * Colorized raw-source highlighting — sub-toggle of Raw Source
 * (`editor.colorize_raw_source`, spec
 * `docs/superpowers/specs/2026-06-28-colorize-raw-source-design.md`).
 *
 * Raw Source mode (`decorationCompartment` → `[]`) shows the literal
 * markdown with no styling at all. This extension paints the *colors* of
 * Live Preview onto that raw markup — without hiding or replacing a single
 * character. The "no rendering" guarantee is structural: a `HighlightStyle`
 * can only set `color`; it cannot collapse brackets, scale headings, or
 * swap in widgets.
 *
 * Colors come from `var(--c-accent)` — the *same* token the Live Preview
 * decorations use (`.cm-md-wikilink` / `.cm-md-link` / `.cm-md-tag` in
 * `decorations.ts`). Referencing the var directly (rather than a computed
 * snapshot) means the rules re-theme for free on a light/dark flip, exactly
 * like `decorationBaseTheme`. One source of truth for the accent, shared
 * with rendered mode.
 *
 * Tag coverage is intentionally minimal — only the tokens that get a
 * *distinct color* when rendered:
 *   - `t.link`      → wiki-links (`WikiLink` node, styled `t.link`) and
 *                     standard `[text](url)` links. Both accent in Live
 *                     Preview, so both accent here. Parity, not a bug.
 *   - `t.labelName` → `#tags` (`Tag` node, styled `t.labelName`).
 *
 * Everything else (emphasis, strong, inline code, headings) gets its Live
 * Preview effect from weight / size / background — none of which is a
 * color — so it is left at the default foreground. Faithful to "only
 * colors change".
 *
 * Installed via `colorSourceCompartment` in `Editor.tsx`, gated on
 * `rawSource && colorizeSource`.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * The tag→color mapping. Exported (not just the wrapped extension) so the
 * contract is directly unit-testable without mounting an editor.
 */
export const colorSourceStyle: HighlightStyle = HighlightStyle.define([
  { tag: t.link, color: "var(--c-accent)" }, // wiki-links + markdown links
  { tag: t.labelName, color: "var(--c-accent)" }, // #tags
]);

/** The editor extension: the highlight style wrapped for installation. */
export const colorSourceHighlight: Extension =
  syntaxHighlighting(colorSourceStyle);
