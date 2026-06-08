import { describe, expect, it } from "vitest";
import { fuzzyMatch, matchText, type OmniItem } from "./ranker";

const note = (title: string, path = title + ".md"): OmniItem => ({
  kind: "note",
  title,
  path,
});
const tag = (t: string): OmniItem => ({ kind: "tag", tag: t });

describe("matchText", () => {
  it("uses title for notes and tag for tags", () => {
    expect(matchText(note("Red King"))).toBe("Red King");
    expect(matchText(tag("project/cubical"))).toBe("project/cubical");
  });
});

describe("fuzzyMatch", () => {
  it("matches a case-insensitive subsequence and returns indices", () => {
    expect(fuzzyMatch("rk", "Red King")).toEqual([0, 4]); // R..K
  });
  it("returns the earliest greedy indices", () => {
    expect(fuzzyMatch("re", "Red King")).toEqual([0, 1]);
  });
  it("returns null when not a subsequence", () => {
    expect(fuzzyMatch("xyz", "Red King")).toBeNull();
  });
  it("matches an empty query as an empty index list", () => {
    expect(fuzzyMatch("", "anything")).toEqual([]);
  });
  it("is unicode-safe (matches by code point)", () => {
    expect(fuzzyMatch("é", "café")).toEqual([3]);
  });
});
