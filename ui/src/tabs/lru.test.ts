import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_TAB_LIMIT, clampLimit, liveFileIds, liveIds, touch } from "./lru";

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

describe("liveFileIds", () => {
  const isFile = (id: string) => !id.startsWith("tag:");

  it("does not let a non-file active id occupy a slot", () => {
    expect(liveFileIds(["tag:x", "a", "b"], "tag:x", 2, isFile)).toEqual([
      "a",
      "b",
    ]);
  });

  it("activating a non-file id evicts none of the already-warm file ids", () => {
    const mru = ["a", "b"];
    const before = liveFileIds(mru, "a", 2, isFile);
    const after = liveFileIds(["tag:x", ...mru], "tag:x", 2, isFile);
    expect(after).toEqual(before);
  });

  it("never keeps a terminal id alive — eviction would kill a running process", () => {
    const isFilePath = (id: string) => !id.startsWith("terminal:");

    expect(
      liveFileIds(["terminal:1", "a", "terminal:2", "b"], "terminal:1", 4, isFilePath),
    ).toEqual(["a", "b"]);
  });

  it("opening a terminal does not evict a warm file tab", () => {
    const isFilePath = (id: string) => !id.startsWith("terminal:");
    const before = liveFileIds(["a", "b"], "a", 2, isFilePath);
    const after = liveFileIds(["terminal:1", "a", "b"], "terminal:1", 2, isFilePath);

    expect(after).toEqual(before);
  });
});
