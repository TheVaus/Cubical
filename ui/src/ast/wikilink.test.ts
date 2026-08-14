import { describe, expect, it } from "vitest";

import { scanWikilinks, type TokenizedRun } from "./wikilink";

function text(value: string): TokenizedRun {
  return { kind: "text", value };
}

function wl(
  target: string,
  extra: Partial<Omit<Extract<TokenizedRun, { kind: "wiki_link" }>, "kind" | "target">> = {},
): TokenizedRun {
  return {
    kind: "wiki_link",
    target,
    display: extra.display ?? null,
    anchor: extra.anchor ?? null,
    embed: extra.embed ?? false,
  };
}

describe("scanWikilinks", () => {
  it("returns empty array for empty input", () => {
    expect(scanWikilinks("")).toEqual([]);
  });

  it("passes plain text through", () => {
    expect(scanWikilinks("just text")).toEqual([text("just text")]);
  });

  it("recognises a simple wiki-link", () => {
    expect(scanWikilinks("[[note]]")).toEqual([wl("note")]);
  });

  it("recognises a wiki-link with display", () => {
    expect(scanWikilinks("[[note|see here]]")).toEqual([
      wl("note", { display: "see here" }),
    ]);
  });

  it("recognises a heading anchor", () => {
    expect(scanWikilinks("[[note#heading]]")).toEqual([
      wl("note", { anchor: { kind: "heading", value: "heading" } }),
    ]);
  });

  it("recognises a block anchor", () => {
    expect(scanWikilinks("[[note#^intro]]")).toEqual([
      wl("note", { anchor: { kind: "block", value: "intro" } }),
    ]);
  });

  it("anchor + display together", () => {
    expect(scanWikilinks("[[note#heading|nice text]]")).toEqual([
      wl("note", {
        anchor: { kind: "heading", value: "heading" },
        display: "nice text",
      }),
    ]);
  });

  it("recognises an embed", () => {
    expect(scanWikilinks("![[diagram]]")).toEqual([
      wl("diagram", { embed: true }),
    ]);
  });

  it("splits text around a wiki-link", () => {
    expect(scanWikilinks("see [[note]] for context")).toEqual([
      text("see "),
      wl("note"),
      text(" for context"),
    ]);
  });

  it("handles multiple wiki-links", () => {
    expect(scanWikilinks("[[a]] and [[b]]")).toEqual([
      wl("a"),
      text(" and "),
      wl("b"),
    ]);
  });

  it("passes unclosed [[ through as text", () => {
    expect(scanWikilinks("text [[unclosed and more")).toEqual([
      text("text [[unclosed and more"),
    ]);
  });

  it("rejects empty target", () => {
    expect(scanWikilinks("[[]] noise")).toEqual([text("[[]] noise")]);
  });

  it("rejects whitespace-only target", () => {
    expect(scanWikilinks("[[   ]]")).toEqual([text("[[   ]]")]);
  });

  it("trims edge whitespace inside target", () => {
    expect(scanWikilinks("[[ a note ]]")).toEqual([wl("a note")]);
  });

  it("treats # after | as part of display", () => {
    expect(scanWikilinks("[[note|see #3]]")).toEqual([
      wl("note", { display: "see #3" }),
    ]);
  });

  it("parses a cross-file property ref", () => {
    expect(scanWikilinks("[[Gandalf.age]]")).toEqual([
      { kind: "property_ref", note: "Gandalf", property: "age" },
    ]);
  });

  it("parses a self property ref", () => {
    expect(scanWikilinks("[[.age]]")).toEqual([
      { kind: "property_ref", note: null, property: "age" },
    ]);
  });

  it("keeps an embed with a dotted target a wiki link, not a property ref", () => {
    expect(scanWikilinks("![[chart.png]]")).toEqual([
      wl("chart.png", { embed: true }),
    ]);
    expect(scanWikilinks("![[data.csv]]")).toEqual([
      wl("data.csv", { embed: true }),
    ]);
    expect(scanWikilinks("![[notes/2026.06.20]]")).toEqual([
      wl("notes/2026.06.20", { embed: true }),
    ]);
  });

  it("splits a property ref on the first dot only", () => {
    expect(scanWikilinks("[[a.b.c]]")).toEqual([
      { kind: "property_ref", note: "a", property: "b.c" },
    ]);
  });

  it("falls back to text for an empty property", () => {
    expect(scanWikilinks("[[Gandalf.]]")).toEqual([
      { kind: "text", value: "[[Gandalf.]]" },
    ]);
    expect(scanWikilinks("[[.]]")).toEqual([{ kind: "text", value: "[[.]]" }]);
  });
});
