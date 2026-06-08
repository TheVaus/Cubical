import { describe, expect, it } from "vitest";
import {
  approxSubstringDistance,
  fuzzyMatch,
  matchText,
  rankItems,
  scoreMatch,
  type OmniItem,
} from "./ranker";

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

describe("scoreMatch", () => {
  it("scores a contiguous prefix higher than a scattered match", () => {
    const prefix = scoreMatch("Red King", fuzzyMatch("red", "Red King")!);
    const scattered = scoreMatch(
      "Reader Knight",
      fuzzyMatch("red", "Reader Knight")!,
    );
    expect(prefix).toBeGreaterThan(scattered);
  });
  it("rewards word-boundary matches over mid-word ones", () => {
    const boundary = scoreMatch("Red King", fuzzyMatch("rk", "Red King")!);
    const inWord = scoreMatch("Works", fuzzyMatch("rk", "Works")!);
    expect(boundary).toBeGreaterThan(inWord);
  });
});

describe("rankItems", () => {
  const items: OmniItem[] = [
    note("Red King"),
    note("Reader Knight"),
    tag("red"),
    note("Blue"),
  ];

  it("returns empty for a blank query", () => {
    expect(rankItems("", items, 50)).toEqual([]);
    expect(rankItems("   ", items, 50)).toEqual([]);
  });
  it("excludes non-matches and ranks the exact match first", () => {
    const r = rankItems("red", items, 50);
    expect(r.map((x) => matchText(x.item))).not.toContain("Blue");
    expect(matchText(r[0]!.item)).toBe("red"); // exact match wins
  });
  it("breaks ties: shorter target, then note before tag, then alpha", () => {
    const r = rankItems("re", [tag("re"), note("re")], 50);
    expect(r[0]!.item.kind).toBe("note"); // equal score+len → note first
  });
  it("caps results at the limit", () => {
    const many: OmniItem[] = Array.from({ length: 10 }, (_, i) =>
      note(`Red ${i}`),
    );
    expect(rankItems("red", many, 3)).toHaveLength(3);
  });
  it("carries matchedIndices through", () => {
    const r = rankItems("rk", [note("Red King")], 50);
    expect(r[0]!.matchedIndices).toEqual([0, 4]);
  });
});

describe("approxSubstringDistance", () => {
  it("is 0 when the query is an exact substring", () => {
    expect(approxSubstringDistance("rich", "frontmatter_rich")).toBe(0);
  });
  it("counts a single substitution typo", () => {
    expect(approxSubstringDistance("ricj", "frontmatter_rich")).toBe(1);
  });
  it("counts a single extra letter (query longer)", () => {
    expect(approxSubstringDistance("riich", "rich")).toBe(1);
  });
  it("is the query length when nothing aligns", () => {
    expect(approxSubstringDistance("xyz", "abcdef")).toBe(3);
  });
});

describe("rankItems typo tolerance", () => {
  it("matches a single-substitution typo (ricj → frontmatter_rich)", () => {
    const r = rankItems("ricj", [note("frontmatter_rich"), note("Blue")], 50);
    expect(r.map((x) => matchText(x.item))).toContain("frontmatter_rich");
    expect(r.map((x) => matchText(x.item))).not.toContain("Blue");
  });
  it("ranks clean subsequence matches above typo'd ones", () => {
    // "rich" is a subsequence of "rich_note"; for "ricj_note" it is not
    // (no 'h'/'j' alignment) → fuzzy. Subsequence must win.
    const r = rankItems("rich", [note("ricj_note"), note("rich_note")], 50);
    expect(matchText(r[0]!.item)).toBe("rich_note");
  });
  it("does not fuzzy-match beyond the edit threshold", () => {
    expect(rankItems("xyz", [note("Blue")], 50)).toEqual([]);
  });
  it("requires exactness for very short queries (no fuzzy under 3 chars)", () => {
    expect(rankItems("rx", [note("ra")], 50)).toEqual([]);
  });
});
