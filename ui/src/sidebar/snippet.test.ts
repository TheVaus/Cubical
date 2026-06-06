import { describe, expect, it } from "vitest";
import type { MatchedField } from "../api/ipc";
import { parseHighlights, pickSnippet } from "./snippet";

const mf = (field: string, snippet: string): MatchedField => ({ field, snippet });

describe("pickSnippet", () => {
  it("prefers body over headings/code/frontmatter/title", () => {
    const fields = [mf("title", "t"), mf("headings", "h"), mf("body", "b")];
    expect(pickSnippet(fields)?.field).toBe("body");
  });

  it("falls through the priority order when body is absent", () => {
    expect(pickSnippet([mf("title", "t"), mf("code", "c")])?.field).toBe("code");
    expect(pickSnippet([mf("title", "t"), mf("frontmatter", "f")])?.field).toBe(
      "frontmatter",
    );
    expect(pickSnippet([mf("title", "t")])?.field).toBe("title");
  });

  it("returns null for an empty list", () => {
    expect(pickSnippet([])).toBeNull();
  });

  it("falls back to the first field when no priority field is present", () => {
    expect(pickSnippet([{ field: "weird", snippet: "w" }])?.field).toBe("weird");
  });
});

describe("parseHighlights", () => {
  it("returns a single unmarked segment for plain text", () => {
    expect(parseHighlights("plain text")).toEqual([
      { text: "plain text", mark: false },
    ]);
  });

  it("marks a single highlight", () => {
    expect(parseHighlights("the <mark>quick</mark> fox")).toEqual([
      { text: "the ", mark: false },
      { text: "quick", mark: true },
      { text: " fox", mark: false },
    ]);
  });

  it("handles multiple and adjacent marks", () => {
    expect(parseHighlights("<mark>a</mark><mark>b</mark> c")).toEqual([
      { text: "a", mark: true },
      { text: "b", mark: true },
      { text: " c", mark: false },
    ]);
  });

  it("unescapes HTML entities Tantivy emits", () => {
    expect(parseHighlights("a &amp; b &lt;tag&gt; &quot;q&quot; &#x27;s&#x27;")).toEqual([
      { text: `a & b <tag> "q" 's'`, mark: false },
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseHighlights("")).toEqual([]);
  });

  it("handles a snippet that starts with a mark", () => {
    expect(parseHighlights("<mark>word</mark> rest")).toEqual([
      { text: "word", mark: true },
      { text: " rest", mark: false },
    ]);
  });
});
