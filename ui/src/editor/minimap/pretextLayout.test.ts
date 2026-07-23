import { describe, expect, it, vi, beforeEach } from "vitest";

const prepareWithSegments = vi.fn();
const layoutWithLines = vi.fn();

vi.mock("@chenglou/pretext", () => ({
  prepareWithSegments: (...a: unknown[]) => prepareWithSegments(...a),
  layoutWithLines: (...a: unknown[]) => layoutWithLines(...a),
}));

import { layoutDocument } from "./pretextLayout";

beforeEach(() => {
  prepareWithSegments.mockReset();
  layoutWithLines.mockReset();
});

describe("layoutDocument", () => {
  it("prepares with the font, lays out at width/lineHeight, flattens lines", () => {
    prepareWithSegments.mockReturnValue({ prepared: true });
    layoutWithLines.mockReturnValue({
      height: 8,
      lineCount: 2,
      lines: [{ text: "one" }, { text: "two" }],
    });

    const out = layoutDocument({
      text: "one two",
      width: 96,
      lineHeight: 4,
      font: "10px monospace",
    });

    expect(prepareWithSegments).toHaveBeenCalledWith("one two", "10px monospace");
    expect(layoutWithLines).toHaveBeenCalledWith({ prepared: true }, 96, 4);
    expect(out).toEqual({
      lines: [{ text: "one" }, { text: "two" }],
      contentHeight: 8,
    });
  });

  it("returns an empty layout for empty text without calling Pretext", () => {
    const out = layoutDocument({
      text: "",
      width: 96,
      lineHeight: 4,
      font: "10px monospace",
    });
    expect(out).toEqual({ lines: [], contentHeight: 0 });
    expect(prepareWithSegments).not.toHaveBeenCalled();
  });
});
