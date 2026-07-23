import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import { correctedVerticalHead } from "./embedNav";

const DOC = "aaa\nbbb\nccc\nddd\neee\n";
const state = EditorState.create({ doc: DOC });
const lineStart = (n: number) => state.doc.line(n).from;

describe("correctedVerticalHead", () => {
  it("returns null when downward motion lands exactly one line down (no overshoot)", () => {
    const start = lineStart(2) + 1;
    const visual = lineStart(3) + 1;
    expect(correctedVerticalHead(state, start, visual, true)).toBeNull();
  });

  it("returns null when upward motion lands exactly one line up (no overshoot)", () => {
    const start = lineStart(5) + 1;
    const visual = lineStart(4) + 1;
    expect(correctedVerticalHead(state, start, visual, false)).toBeNull();
  });

  it("corrects a downward overshoot to exactly one document line down", () => {
    const start = lineStart(2) + 1;
    const visual = lineStart(4) + 1;
    const corrected = correctedVerticalHead(state, start, visual, true);
    expect(corrected).toBe(lineStart(3) + 1);
  });

  it("corrects an upward overshoot to exactly one document line up", () => {
    const start = lineStart(5) + 1;
    const visual = lineStart(2) + 1;
    const corrected = correctedVerticalHead(state, start, visual, false);
    expect(corrected).toBe(lineStart(4) + 1);
  });

  it("clamps the column to the target line length", () => {
    const longDoc = "aaaaaaaa\nb\ncc\nddddd\neeeeeeee\n";
    const s = EditorState.create({ doc: longDoc });
    const startHead = s.doc.line(5).from + 7;
    const visualHead = s.doc.line(2).from;
    const corrected = correctedVerticalHead(s, startHead, visualHead, false);
    expect(corrected).toBe(s.doc.line(4).to);
  });

  it("does not go past the first line on an upward overshoot", () => {
    const start = lineStart(2) + 1;
    const visual = lineStart(1);
    expect(correctedVerticalHead(state, start, visual, false)).toBeNull();
  });
});
