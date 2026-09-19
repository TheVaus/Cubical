import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { withinLines } from "./withinLines";

const doc = Text.of(["ab", "cd", "ef"]);

describe("withinLines", () => {
  it("keeps a range that stays on one line", () => {
    expect(withinLines(doc, { from: 0, to: 2 })).toEqual([{ from: 0, to: 2 }]);
  });

  it("splits a range at each line break and leaves the breaks out", () => {
    expect(withinLines(doc, { from: 1, to: 7 })).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 5 },
      { from: 6, to: 7 },
    ]);
  });

  it("carries the other fields onto every part", () => {
    expect(withinLines(doc, { from: 1, to: 4, kind: "hide" })).toEqual([
      { from: 1, to: 2, kind: "hide" },
      { from: 3, to: 4, kind: "hide" },
    ]);
  });

  it("drops an empty range", () => {
    expect(withinLines(doc, { from: 2, to: 2 })).toEqual([]);
  });
});
