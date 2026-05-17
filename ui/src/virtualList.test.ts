/**
 * Virtual-list windowing math — unit tests.
 *
 * `computeWindow` is the pure core of the file-list virtualization:
 * given the scroll position and viewport size, it returns the slice of
 * rows that need to be in the DOM (plus an overscan margin) and the
 * pixel offset to position them at. Rendering only this window is what
 * keeps a 30k-file vault from freezing the webview.
 */
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
    // 8 rows * 32px = 256px, viewport 400px — everything visible.
    expect(computeWindow(0, 400, 32, 8, 3)).toEqual({
      startIndex: 0,
      endIndex: 8,
      offsetY: 0,
      totalHeight: 256,
    });
  });

  it("windows to the visible slice plus overscan when scrolled", () => {
    // 1000 rows, scrolled to 3200px, 400px viewport, 5-row overscan.
    // first visible = 100, last = ceil(3600/32) = 113.
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
    // Scrolled so the last row is at the viewport bottom.
    const w = computeWindow(960000 - 400, 400, 32, 30000, 5);
    expect(w.endIndex).toBe(30000);
    expect(w.startIndex).toBeLessThan(30000);
  });
});
