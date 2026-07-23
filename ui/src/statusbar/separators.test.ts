import { describe, expect, it } from "vitest";
import { leadingSeparators } from "./separators";

describe("leadingSeparators", () => {
  it("never puts a separator before the first visible item", () => {
    expect(leadingSeparators([true, true, true])).toEqual([false, true, true]);
  });

  it("skips hidden items and never marks them", () => {
    expect(leadingSeparators([false, true, false, true])).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("handles all-hidden", () => {
    expect(leadingSeparators([false, false])).toEqual([false, false]);
  });

  it("handles a single visible item", () => {
    expect(leadingSeparators([false, true, false])).toEqual([
      false,
      false,
      false,
    ]);
  });
});
