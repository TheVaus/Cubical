// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import { attachUpdateListener } from "./listenerSlot";

let view: EditorView | undefined;
afterEach(() => view?.destroy());

const edits = () => {
  const seen = vi.fn();
  return { seen, handler: (u: ViewUpdate) => u.docChanged && seen() };
};

const type = (v: EditorView) =>
  v.dispatch({ changes: { from: v.state.doc.length, insert: "x" } });

describe("attachUpdateListener", () => {
  it("stops calling a detached listener", () => {
    view = new EditorView({ doc: "" });
    const first = edits();
    const detach = attachUpdateListener(view, first.handler);
    type(view);
    detach();
    type(view);
    expect(first.seen).toHaveBeenCalledTimes(1);
  });

  it("does not stack listeners across remounts", () => {
    view = new EditorView({ doc: "" });
    const first = edits();
    const second = edits();
    attachUpdateListener(view, first.handler)();
    attachUpdateListener(view, second.handler);
    type(view);
    expect(first.seen).not.toHaveBeenCalled();
    expect(second.seen).toHaveBeenCalledTimes(1);
  });
});
