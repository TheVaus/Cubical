import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

export const colorSourceStyle: HighlightStyle = HighlightStyle.define([
  { tag: t.link, color: "var(--c-accent)" },
  { tag: t.labelName, color: "var(--c-accent)" },
]);

export const colorSourceHighlight: Extension =
  syntaxHighlighting(colorSourceStyle);
