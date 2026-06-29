import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";

import { findBlockDefinitionOffset, findHeadingOffset } from "./anchorScroll";

function mdState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown()] });
}

describe("findHeadingOffset", () => {
  it("finds an ATX heading by its plain text, stripping markers", () => {
    const doc = "intro\n\n## Tasks\n\nbody\n";
    expect(findHeadingOffset(mdState(doc), "Tasks")).toBe(doc.indexOf("## Tasks"));
  });

  it("trims and matches case-sensitively", () => {
    const doc = "# Overview\n";
    expect(findHeadingOffset(mdState(doc), "  Overview  ")).toBe(0);
    expect(findHeadingOffset(mdState(doc), "overview")).toBeNull();
  });

  it("returns null for an absent or empty heading", () => {
    expect(findHeadingOffset(mdState("# Real\n"), "Missing")).toBeNull();
    expect(findHeadingOffset(mdState("# Real\n"), "  ")).toBeNull();
  });

  it("matches the first of several headings", () => {
    const doc = "# A\n\n## B\n\n# A\n";
    expect(findHeadingOffset(mdState(doc), "A")).toBe(0);
  });
});

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
