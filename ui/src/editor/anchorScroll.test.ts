import { describe, expect, it } from "vitest";

import { findBlockDefinitionOffset } from "./anchorScroll";

describe("findBlockDefinitionOffset", () => {
  it("finds the line whose trailing token defines the block id", () => {
    const doc = "first line\nbody text ^abc\nmore\n";
    // Offset of the start of the "body text ^abc" line.
    expect(findBlockDefinitionOffset(doc, "abc")).toBe("first line\n".length);
  });

  it("finds a definition on the very first line", () => {
    const doc = "intro paragraph ^top\nrest\n";
    expect(findBlockDefinitionOffset(doc, "top")).toBe(0);
  });

  it("returns null when the id is not the trailing token", () => {
    // `extra` is the final token, not `^abc`.
    expect(findBlockDefinitionOffset("body ^abc extra\n", "abc")).toBeNull();
  });

  it("requires an exact id, not a prefix", () => {
    expect(findBlockDefinitionOffset("text ^abcd\n", "abc")).toBeNull();
  });

  it("returns null when the block id is absent", () => {
    expect(findBlockDefinitionOffset("nothing here\n", "abc")).toBeNull();
  });

  it("returns null for an empty or invalid id", () => {
    expect(findBlockDefinitionOffset("text ^abc\n", "")).toBeNull();
    expect(findBlockDefinitionOffset("text ^a.b\n", "a.b")).toBeNull();
  });

  it("matches a unicode-letter id", () => {
    const doc = "café note ^café\n";
    expect(findBlockDefinitionOffset(doc, "café")).toBe(0);
  });
});
