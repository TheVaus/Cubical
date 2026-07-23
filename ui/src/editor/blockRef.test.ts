import { describe, expect, it } from "vitest";

import { buildBlockRefLink, byteOffsetOf } from "./blockRef";

describe("byteOffsetOf", () => {
  it("equals the char position for pure ASCII", () => {
    expect(byteOffsetOf("hello world", 5)).toBe(5);
  });

  it("counts multi-byte chars before the cursor as their UTF-8 length", () => {
    expect(byteOffsetOf("café world", 4)).toBe(5);
  });

  it("counts an astral char (surrogate pair) as 4 bytes", () => {
    expect(byteOffsetOf("😀x", 2)).toBe(4);
  });

  it("is 0 at the start", () => {
    expect(byteOffsetOf("anything", 0)).toBe(0);
  });
});

describe("buildBlockRefLink", () => {
  it("strips a trailing .md and wraps the block anchor", () => {
    expect(buildBlockRefLink("notes/Daily.md", "b1a2c3")).toBe(
      "[[notes/Daily#^b1a2c3]]",
    );
  });

  it("leaves a path without .md untouched", () => {
    expect(buildBlockRefLink("Foo", "x")).toBe("[[Foo#^x]]");
  });
});
