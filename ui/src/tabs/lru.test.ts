import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_TAB_LIMIT, clampLimit, liveIds, touch } from "./lru";

describe("clampLimit", () => {
  it("keeps sane values", () => {
    expect(clampLimit(8)).toBe(8);
    expect(clampLimit(1)).toBe(1);
  });

  it("clamps zero and negatives to one", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
  });

  it("floors fractions and falls back on non-numbers", () => {
    expect(clampLimit(3.9)).toBe(3);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_LIVE_TAB_LIMIT);
  });
});

describe("touch", () => {
  it("moves an id to the front without duplicating it", () => {
    expect(touch(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(touch(["a", "b"], "z")).toEqual(["z", "a", "b"]);
  });
});

describe("liveIds", () => {
  it("caps at the limit in MRU order", () => {
    expect(liveIds(["a", "b", "c", "d"], "a", 2)).toEqual(["a", "b"]);
  });

  it("always includes the active tab even when it is cold", () => {
    expect(liveIds(["a", "b", "c"], "c", 2)).toEqual(["c", "a"]);
  });

  it("handles no active tab", () => {
    expect(liveIds(["a", "b"], null, 1)).toEqual(["a"]);
  });

  it("respects the clamp", () => {
    expect(liveIds(["a", "b"], "a", 0)).toEqual(["a"]);
  });
});
