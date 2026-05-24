import { describe, expect, it } from "vitest";
import { parser as baseParser } from "@lezer/markdown";

import { wikilinkExtension } from "./wikilink";

const parser = baseParser.configure([wikilinkExtension]);

function nodeNamesIn(src: string): string[] {
  const tree = parser.parse(src);
  const out: string[] = [];
  tree.iterate({
    enter: (node) => {
      out.push(node.name);
    },
  });
  return out;
}

function wikilinkRanges(
  src: string,
): Array<{ from: number; to: number; text: string }> {
  const tree = parser.parse(src);
  const ranges: Array<{ from: number; to: number; text: string }> = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === "WikiLink") {
        ranges.push({
          from: node.from,
          to: node.to,
          text: src.slice(node.from, node.to),
        });
      }
    },
  });
  return ranges;
}

describe("wikilinkExtension", () => {
  it("emits a WikiLink node for [[note]]", () => {
    expect(wikilinkRanges("see [[note]] here")).toEqual([
      { from: 4, to: 12, text: "[[note]]" },
    ]);
  });

  it("emits a WikiLink node for ![[diagram]] including the leading !", () => {
    expect(wikilinkRanges("![[diagram]]")).toEqual([
      { from: 0, to: 12, text: "![[diagram]]" },
    ]);
  });

  it("emits a WikiLink node for [[note#heading|alt]]", () => {
    const src = "[[note#heading|alt]]";
    const ranges = wikilinkRanges(src);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.text).toBe(src);
  });

  it("does not emit WikiLink for unclosed [[", () => {
    expect(wikilinkRanges("text [[unclosed and more")).toEqual([]);
  });

  it("does not emit WikiLink for [[]] (empty target)", () => {
    expect(wikilinkRanges("[[]] noise")).toEqual([]);
  });

  it("prevents the default Lezer Link parser from claiming [[X]]", () => {
    const names = nodeNamesIn("[[note]]");
    expect(names).toContain("WikiLink");
    expect(names).not.toContain("Link");
  });

  it("recognises multiple wiki-links in one paragraph", () => {
    const ranges = wikilinkRanges("[[a]] and [[b]]");
    expect(ranges.map((r) => r.text)).toEqual(["[[a]]", "[[b]]"]);
  });
});
