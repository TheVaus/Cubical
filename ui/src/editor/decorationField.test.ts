import { describe, expect, it } from "vitest";
import { EditorState, StateEffect, type Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { decorationField } from "./decorationField";

const DOC = "one\ntwo\nthree\nfour\n";
const mark = Decoration.mark({ class: "x" });
const refresh = StateEffect.define<null>();

function counted() {
  let collects = 0;
  const field = decorationField({
    collect: (state) => {
      collects++;
      const ranges: Range<Decoration>[] = [];
      for (let n = 1; n < state.doc.lines; n++) {
        const line = state.doc.line(n);
        ranges.push(mark.range(line.from, line.to));
      }
      return ranges;
    },
    effects: [refresh],
  });
  const state = EditorState.create({
    doc: DOC,
    selection: { anchor: 0 },
    extensions: [markdown(), field],
  });
  return { field, state, collects: () => collects };
}

function decoratedLines(state: EditorState, field: ReturnType<typeof counted>["field"]) {
  const lines: number[] = [];
  state.field(field).deco.between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number);
  });
  return lines;
}

describe("decorationField", () => {
  it("hides the active line's ranges", () => {
    const { field, state } = counted();
    expect(decoratedLines(state, field)).toEqual([2, 3, 4]);
  });

  it("moves the reveal to the new line without collecting again", () => {
    const { field, state, collects } = counted();
    const before = collects();
    const moved = state.update({
      selection: { anchor: state.doc.line(3).from },
    }).state;
    expect(decoratedLines(moved, field)).toEqual([1, 2, 4]);
    expect(collects()).toBe(before);
    expect(moved.field(field).ranges).toBe(state.field(field).ranges);
  });

  it("keeps the same value when the head stays on its line", () => {
    const { field, state } = counted();
    const moved = state.update({ selection: { anchor: 2 } }).state;
    expect(moved.field(field)).toBe(state.field(field));
  });

  it("collects again on an edit or a declared effect", () => {
    const { state, collects } = counted();
    const before = collects();
    const edited = state.update({ changes: { from: 0, insert: "x" } }).state;
    expect(collects()).toBe(before + 1);
    void edited.update({ effects: refresh.of(null) }).state;
    expect(collects()).toBe(before + 2);
  });
});
