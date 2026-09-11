import { describe, expect, it } from "vitest";

import { computeWindow } from "./virtualList";

describe("computeWindow", () => {
  it("returns an empty window for an empty list", () => {
    expect(computeWindow(0, 400, 32, 0, 5)).toEqual({
      startIndex: 0,
      endIndex: 0,
      offsetY: 0,
      totalHeight: 0,
    });
  });

  it("renders the whole list when it fits in the viewport", () => {
    expect(computeWindow(0, 400, 32, 8, 3)).toEqual({
      startIndex: 0,
      endIndex: 8,
      offsetY: 0,
      totalHeight: 256,
    });
  });

  it("windows to the visible slice plus overscan when scrolled", () => {
    expect(computeWindow(3200, 400, 32, 1000, 5)).toEqual({
      startIndex: 95,
      endIndex: 118,
      offsetY: 3040,
      totalHeight: 32000,
    });
  });

  it("clamps the start index at zero near the top", () => {
    const w = computeWindow(0, 400, 32, 30000, 5);
    expect(w.startIndex).toBe(0);
    expect(w.offsetY).toBe(0);
    expect(w.totalHeight).toBe(960000);
  });

  it("clamps the end index at itemCount near the bottom", () => {
    const w = computeWindow(960000 - 400, 400, 32, 30000, 5);
    expect(w.endIndex).toBe(30000);
    expect(w.startIndex).toBeLessThan(30000);
  });
});
