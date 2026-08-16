// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { blockRenderers, blockRenderersField } from "./blockRenderers";
import { mathBlockRenderer, mathEnabledFacet, renderMath } from "./math";

function rendered(doc: string, cursor = 0, enabled = true): HTMLElement[] {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        markdown(),
        mathEnabledFacet.of(enabled),
        blockRenderersField,
        blockRenderers(mathBlockRenderer),
      ],
    }),
  });
  const nodes = [...view.dom.querySelectorAll(".cm-math")] as HTMLElement[];
  view.destroy();
  return nodes;
}

describe("renderMath", () => {
  it("typesets a valid expression into KaTeX output", () => {
    const el = renderMath("x^2 + y^2 = z^2", { displayMode: true });
    expect(el.querySelector(".katex")).not.toBeNull();
    expect(el.classList.contains("cm-math--error")).toBe(false);
  });

  it("emits MathML alongside HTML so the output is accessible", () => {
    const el = renderMath("\\frac{a}{b}", { displayMode: true });
    expect(el.querySelector("math")).not.toBeNull();
  });

  it("reports a bad expression instead of throwing", () => {
    const el = renderMath("\\frac{", { displayMode: true });
    expect(el.classList.contains("cm-math--error")).toBe(true);
    expect(el.textContent).toBeTruthy();
  });

  it("does not execute markup embedded in the source", () => {
    const el = renderMath("<img src=x onerror=alert(1)>", {
      displayMode: true,
    });
    expect(el.querySelector("img")).toBeNull();
  });

  it("labels an empty expression rather than rendering blank", () => {
    const el = renderMath("   ", { displayMode: true });
    expect(el.classList.contains("cm-math--empty")).toBe(true);
  });

  it("marks display and inline modes differently", () => {
    expect(
      renderMath("x", { displayMode: true }).classList.contains(
        "cm-math--display",
      ),
    ).toBe(true);
    expect(
      renderMath("x", { displayMode: false }).classList.contains(
        "cm-math--inline",
      ),
    ).toBe(true);
  });
});

describe("mathBlockRenderer", () => {
  const doc = "text\n\n```math\n\\int_0^1 x\\,dx\n```\n\ntrailing\n";

  it("typesets a ```math fenced block", () => {
    expect(rendered(doc, 0)).toHaveLength(1);
    expect(rendered(doc, 0)[0]?.querySelector(".katex")).not.toBeNull();
  });

  it("also accepts the latex and katex aliases", () => {
    for (const lang of ["latex", "katex"]) {
      const d = "```" + lang + "\nx^2\n```\n\ntrailing\n";
      expect(rendered(d, d.length - 2)).toHaveLength(1);
    }
  });

  it("reveals the source while the cursor is inside the block", () => {
    const inside = doc.indexOf("\\int");
    expect(rendered(doc, inside)).toHaveLength(0);
  });

  it("renders nothing when the math plugin is disabled", () => {
    expect(rendered(doc, 0, false)).toHaveLength(0);
  });

  it("leaves other fenced languages alone", () => {
    const d = "```rust\nfn main() {}\n```\n\ntrailing\n";
    expect(rendered(d, d.length - 2)).toHaveLength(0);
  });
});
