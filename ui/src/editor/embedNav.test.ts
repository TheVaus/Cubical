import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import { correctedVerticalHead } from "./embedNav";

// Doc with an embed-sized "tall block" conceptually on line 3. The
// pure function only cares about line numbers, so any doc with enough
// lines works. Lines: L1 "aaa", L2 "bbb", L3 "ccc", L4 "ddd", L5 "eee".
const DOC = "aaa\nbbb\nccc\nddd\neee\n";
const state = EditorState.create({ doc: DOC });
const lineStart = (n: number) => state.doc.line(n).from;

describe("correctedVerticalHead", () => {
  it("returns null when downward motion lands exactly one line down (no overshoot)", () => {
    // L2 -> L3: visualLine === startLine + 1.
    const start = lineStart(2) + 1;
    const visual = lineStart(3) + 1;
    expect(correctedVerticalHead(state, start, visual, true)).toBeNull();
  });

  it("returns null when upward motion lands exactly one line up (no overshoot)", () => {
    // L5 -> L4.
    const start = lineStart(5) + 1;
    const visual = lineStart(4) + 1;
    expect(correctedVerticalHead(state, start, visual, false)).toBeNull();
  });

  it("corrects a downward overshoot to exactly one document line down", () => {
    // Real captured jump: Down from L2 landed on L4 (skipped embed L3).
    const start = lineStart(2) + 1; // column 1 on L2
    const visual = lineStart(4) + 1; // overshot to L4
    const corrected = correctedVerticalHead(state, start, visual, true);
    // Should land on L3, same column.
    expect(corrected).toBe(lineStart(3) + 1);
  });

  it("corrects an upward overshoot to exactly one document line up", () => {
    // Real captured jump: Up from L5 landed on L2 (skipped L4 and embed L3).
    const start = lineStart(5) + 1; // column 1 on L5
    const visual = lineStart(2) + 1; // overshot to L2
    const corrected = correctedVerticalHead(state, start, visual, false);
    // Should land on L4, same column.
    expect(corrected).toBe(lineStart(4) + 1);
  });

  it("clamps the column to the target line length", () => {
    // Start deep on a line, correct onto a shorter target line.
    const longDoc = "aaaaaaaa\nb\ncc\nddddd\neeeeeeee\n";
    const s = EditorState.create({ doc: longDoc });
    const startHead = s.doc.line(5).from + 7; // column 7 on L5
    const visualHead = s.doc.line(2).from; // overshot up to L2
    const corrected = correctedVerticalHead(s, startHead, visualHead, false);
    // Target L4 ("ddddd", length 5) — column 7 clamps to its end.
    expect(corrected).toBe(s.doc.line(4).to);
  });

  it("does not go past the first line on an upward overshoot", () => {
    // Start L2, visual overshoots to... there's no line 0; from L2 the
    // max(startLine-1,1) = L1, and any overshoot corrects to L1.
    const start = lineStart(2) + 1;
    const visual = lineStart(1); // not an overshoot (L1 == L2-1) → null
    expect(correctedVerticalHead(state, start, visual, false)).toBeNull();
  });
});
