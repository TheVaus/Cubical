// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { mathEnabledFacet } from "./math";
import { displayMathField, scanDisplayMath } from "./mathDollar";

function rendered(doc: string, cursor = 0, enabled = true): HTMLElement[] {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [markdown(), mathEnabledFacet.of(enabled), displayMathField],
    }),
  });
  const nodes = [...view.dom.querySelectorAll(".cm-math")] as HTMLElement[];
  view.destroy();
  return nodes;
}

describe("scanDisplayMath", () => {
  it("finds a multi-line $$ block and keeps its interior", () => {
    const regions = scanDisplayMath("before\n$$\na + b\n$$\nafter\n");
    expect(regions).toHaveLength(1);
    expect(regions[0]?.source.trim()).toBe("a + b");
  });

  it("finds a single-line $$…$$ block", () => {
    const regions = scanDisplayMath("$$E = mc^2$$\n");
    expect(regions).toHaveLength(1);
    expect(regions[0]?.source.trim()).toBe("E = mc^2");
  });

  it("spans the whole region so the replacement covers the delimiters", () => {
    const text = "$$\nx\n$$\n";
    const region = scanDisplayMath(text)[0];
    expect(text.slice(region?.from, region?.to)).toBe("$$\nx\n$$");
  });

  it("finds several blocks in one document", () => {
    expect(scanDisplayMath("$$a$$\n\ntext\n\n$$\nb\n$$\n")).toHaveLength(2);
  });

  it("ignores an unterminated block", () => {
    expect(scanDisplayMath("$$\na + b\nno close here\n")).toEqual([]);
  });

  it("ignores an empty block", () => {
    expect(scanDisplayMath("$$\n\n$$\n")).toEqual([]);
    expect(scanDisplayMath("$$$$\n")).toEqual([]);
  });

  it("does not treat a single $ as display math", () => {
    expect(scanDisplayMath("costs $5 and $7 today\n")).toEqual([]);
  });

  it("leaves mid-line $$…$$ literal — display math owns whole lines", () => {
    expect(scanDisplayMath("see $$e^{i\\pi}+1=0$$ inline\n")).toEqual([]);
  });

  it("tolerates indentation on the delimiters", () => {
    expect(scanDisplayMath("  $$\n  x\n  $$\n")).toHaveLength(1);
  });
});

describe("displayMathField", () => {
  it("typesets a $$ block", () => {
    const doc = "text\n\n$$\n\\sum_{i=1}^n i\n$$\n\ntrailing\n";
    expect(rendered(doc, 0)).toHaveLength(1);
    expect(rendered(doc, 0)[0]?.querySelector(".katex")).not.toBeNull();
  });

  it("reveals the source while the cursor is inside the block", () => {
    const doc = "$$\nx + y\n$$\n\ntrailing\n";
    expect(rendered(doc, doc.indexOf("x + y"))).toHaveLength(0);
  });

  it("renders nothing when the math plugin is disabled", () => {
    const doc = "text\n\n$$\nx\n$$\n\ntrailing\n";
    expect(rendered(doc, 0, false)).toHaveLength(0);
  });

  it("leaves $$ inside a fenced code block as code", () => {
    const doc = "```rust\nlet a = 1;\n$$\nnot math\n$$\n```\n\ntrailing\n";
    expect(rendered(doc, doc.length - 2)).toHaveLength(0);
  });
});

describe("displayMathField recomputes per line, not per cursor position", () => {
  const doc = ["a long line of prose", "", "$$", "x + y", "$$", "", "trailing", ""].join(
    "\n",
  );

  function fieldAfterMove(from: number, to: number) {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: from },
        extensions: [markdown(), mathEnabledFacet.of(true), displayMathField],
      }),
    });
    const before = view.state.field(displayMathField);
    view.dispatch({ selection: { anchor: to } });
    const after = view.state.field(displayMathField);
    view.destroy();
    return { before, after };
  }

  it("keeps the decoration set identical when the head moves within a line", () => {
    const { before, after } = fieldAfterMove(0, 10);
    expect(after).toBe(before);
  });

  it("still rebuilds when the head moves onto the math block", () => {
    const { before, after } = fieldAfterMove(0, doc.indexOf("x + y"));
    expect(after).not.toBe(before);
  });
});
