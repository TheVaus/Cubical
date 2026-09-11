import { describe, expect, it } from "vitest";
import { parseHighlights } from "./snippet";

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
