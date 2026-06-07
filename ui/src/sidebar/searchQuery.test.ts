import { describe, expect, it } from "vitest";
import { buildSearchQuery } from "./searchQuery";

describe("buildSearchQuery", () => {
  it("maps default scope and passes sort/limit/offset through, fuzzy off", () => {
    const q = buildSearchQuery({
      text: "hello world",
      sort: "relevance",
      scope: "default",
      limit: 50,
      offset: 0,
    });
    expect(q).toEqual({
      text: "hello world",
      limit: 50,
      offset: 0,
      fields: { kind: "default" },
      fuzzy: false,
      sort: "relevance",
    });
  });

  it("never requests fuzzy (avoids L4-A's title-only single-term rewrite)", () => {
    for (const scope of ["default", "headings_only", "body_only", "code_only", "tags"] as const) {
      expect(
        buildSearchQuery({ text: "frontmatter", sort: "relevance", scope, limit: 50, offset: 0 }).fuzzy,
      ).toBe(false);
    }
  });

  it("maps single-field scopes", () => {
    expect(
      buildSearchQuery({ text: "x", sort: "recency_desc", scope: "headings_only", limit: 50, offset: 0 }).fields,
    ).toEqual({ kind: "headings_only" });
    expect(
      buildSearchQuery({ text: "x", sort: "relevance", scope: "body_only", limit: 50, offset: 0 }).fields,
    ).toEqual({ kind: "body_only" });
    expect(
      buildSearchQuery({ text: "x", sort: "relevance", scope: "code_only", limit: 50, offset: 0 }).fields,
    ).toEqual({ kind: "code_only" });
  });

  it("splits the query box into tags for the tags scope", () => {
    expect(
      buildSearchQuery({ text: "  project/cubical   urgent ", sort: "relevance", scope: "tags", limit: 50, offset: 0 }).fields,
    ).toEqual({ kind: "tags", tags: ["project/cubical", "urgent"] });
  });

  it("yields an empty tag list when the query box is blank under tags scope", () => {
    expect(
      buildSearchQuery({ text: "   ", sort: "relevance", scope: "tags", limit: 50, offset: 0 }).fields,
    ).toEqual({ kind: "tags", tags: [] });
  });

  it("carries recency_desc sort through", () => {
    expect(
      buildSearchQuery({ text: "x", sort: "recency_desc", scope: "default", limit: 50, offset: 0 }).sort,
    ).toBe("recency_desc");
  });
});
