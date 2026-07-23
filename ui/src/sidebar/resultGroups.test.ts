import { describe, expect, it } from "vitest";
import type { MatchedField, SearchHit } from "../api/ipc";
import { buildFileGroups, buildStableFileGroups } from "./resultGroups";

const hit = (
  over: Partial<SearchHit> & { matched_fields: MatchedField[] },
): SearchHit => ({
  path: "note.md",
  title: "Note",
  score: 1,
  mtime_secs: 1_717_000_000,
  tags: [],
  ...over,
});

const mf = (field: string, snippet: string): MatchedField => ({ field, snippet });

describe("buildFileGroups", () => {
  it("returns one group per hit, preserving hit order and identity", () => {
    const groups = buildFileGroups([
      hit({ path: "a.md", title: "Alpha", matched_fields: [mf("body", "x")] }),
      hit({ path: "b.md", title: "Beta", matched_fields: [mf("body", "y")] }),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["a.md", "b.md"]);
    expect(groups[0]).toMatchObject({ path: "a.md", title: "Alpha" });
    expect(groups[1]).toMatchObject({ path: "b.md", title: "Beta" });
  });

  it("carries mtime through to the group", () => {
    const groups = buildFileGroups([
      hit({ mtime_secs: 42, matched_fields: [mf("body", "x")] }),
    ]);
    expect(groups[0]?.mtime_secs).toBe(42);
  });

  it("renders one card per matched field, ordered body→headings→code→frontmatter→title", () => {
    const groups = buildFileGroups([
      hit({
        matched_fields: [
          mf("title", "t"),
          mf("frontmatter", "f"),
          mf("code", "c"),
          mf("headings", "h"),
          mf("body", "b"),
        ],
      }),
    ]);
    expect(groups[0]?.cards.map((c) => c.field)).toEqual([
      "body",
      "headings",
      "code",
      "frontmatter",
      "title",
    ]);
  });

  it("places unknown fields last, preserving their backend order", () => {
    const groups = buildFileGroups([
      hit({
        matched_fields: [mf("weird", "w"), mf("body", "b"), mf("other", "o")],
      }),
    ]);
    expect(groups[0]?.cards.map((c) => c.field)).toEqual([
      "body",
      "weird",
      "other",
    ]);
  });

  it("parses <mark> highlights into segments per card", () => {
    const groups = buildFileGroups([
      hit({ matched_fields: [mf("body", "the <mark>quick</mark> fox")] }),
    ]);
    expect(groups[0]?.cards[0]?.segments).toEqual([
      { text: "the ", mark: false },
      { text: "quick", mark: true },
      { text: " fox", mark: false },
    ]);
  });

  it("drops cards whose snippet has no renderable text", () => {
    const groups = buildFileGroups([
      hit({ matched_fields: [mf("body", "b"), mf("headings", "")] }),
    ]);
    expect(groups[0]?.cards.map((c) => c.field)).toEqual(["body"]);
  });

  it("returns an empty array for no hits", () => {
    expect(buildFileGroups([])).toEqual([]);
  });
});

describe("buildStableFileGroups", () => {
  const hits = [
    hit({ path: "a.md", title: "Alpha", matched_fields: [mf("body", "x")] }),
    hit({ path: "b.md", title: "Beta", matched_fields: [mf("body", "y")] }),
  ];

  it("reuses every group's object reference when a refetch is unchanged", () => {
    const first = buildStableFileGroups([], hits);
    const second = buildStableFileGroups(first, hits.map((h) => ({ ...h })));

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("gives a fresh reference only to the group whose results actually changed", () => {
    const first = buildStableFileGroups([], hits);
    const changed = [
      hits[0]!,
      hit({
        path: "b.md",
        title: "Beta",
        matched_fields: [mf("body", "new match text")],
      }),
    ];
    const second = buildStableFileGroups(first, changed);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]?.cards[0]?.segments[0]?.text).toBe("new match text");
  });
});
