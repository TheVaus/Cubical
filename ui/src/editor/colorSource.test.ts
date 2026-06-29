// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { tags as t } from "@lezer/highlight";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { colorSourceStyle, colorSourceHighlight } from "./colorSource";
import { wikilinkExtension } from "./wikilink";
import { tagExtension } from "./tag";

/** Mount a real CodeMirror view with the raw-source coloring installed. */
function makeColoredView(doc: string): EditorView {
  const host = document.createElement("div");
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      // Cursor at end so no token is on the active line (irrelevant here —
      // coloring has no cursor-reveal behavior — but mirrors sibling tests).
      selection: { anchor: doc.length },
      extensions: [
        markdown({ extensions: [wikilinkExtension, tagExtension] }),
        colorSourceHighlight,
      ],
    }),
  });
}

/**
 * The colorized-raw-source HighlightStyle paints rendered-mode colors onto
 * the raw markup without hiding or replacing anything (that "no rendering"
 * guarantee is structural — a HighlightStyle can only set `color`). These
 * tests pin the tag→color contract: which tokens get tinted, with which
 * token, and which tokens are deliberately left alone.
 */
describe("colorSourceStyle", () => {
  it("assigns a highlight class to wiki-link / markdown-link tokens (t.link)", () => {
    expect(colorSourceStyle.style([t.link])).toBeTruthy();
  });

  it("assigns a highlight class to tag tokens (t.labelName)", () => {
    expect(colorSourceStyle.style([t.labelName])).toBeTruthy();
  });

  it("paints the targeted tokens with the rendered-mode accent token", () => {
    const rules = colorSourceStyle.module?.getRules() ?? "";
    expect(rules).toContain("var(--c-accent)");
  });

  it("leaves untargeted tokens (emphasis) uncolored — only colors change", () => {
    expect(colorSourceStyle.style([t.emphasis])).toBeNull();
  });
});

describe("colorSourceHighlight (mounted)", () => {
  it("wraps a raw [[wiki-link]] in the link-colored span without hiding it", () => {
    const linkClass = colorSourceStyle.style([t.link]);
    expect(linkClass).toBeTruthy();

    const view = makeColoredView("[[Foo]]\n");
    try {
      const span = view.contentDOM.querySelector(`.${linkClass}`);
      expect(span).not.toBeNull();
      // No rendering: the literal markup stays in the text, brackets intact.
      expect(span?.textContent).toBe("[[Foo]]");
      expect(view.state.doc.toString()).toBe("[[Foo]]\n");
    } finally {
      view.destroy();
    }
  });

  it("colors a #tag with the same link class (both → accent)", () => {
    const tagClass = colorSourceStyle.style([t.labelName]);
    const view = makeColoredView("#todo\n");
    try {
      const span = view.contentDOM.querySelector(`.${tagClass}`);
      expect(span?.textContent).toBe("#todo");
    } finally {
      view.destroy();
    }
  });
});
