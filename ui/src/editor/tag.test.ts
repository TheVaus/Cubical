import { describe, expect, it } from "vitest";
import { parser } from "@lezer/markdown";

import { tagExtension } from "./tag";

const tagParser = parser.configure([tagExtension]);

/** Collect every node of `name` in source order. */
function nodesNamed(source: string, name: string): { from: number; to: number; text: string }[] {
  const tree = tagParser.parse(source);
  const out: { from: number; to: number; text: string }[] = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === name) {
        out.push({ from: node.from, to: node.to, text: source.slice(node.from, node.to) });
      }
    },
  });
  return out;
}

describe("tagExtension", () => {
  it("recognises a simple tag at line start", () => {
    expect(nodesNamed("#todo\n", "Tag")).toEqual([
      { from: 0, to: 5, text: "#todo" },
    ]);
  });

  it("recognises a tag after a space", () => {
    const got = nodesNamed("see #todo done", "Tag");
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe("#todo");
  });

  it("recognises a nested tag", () => {
    const got = nodesNamed("#a/b/c", "Tag");
    expect(got).toEqual([{ from: 0, to: 6, text: "#a/b/c" }]);
  });

  it("does not match a hash after a word char", () => {
    expect(nodesNamed("issue#42", "Tag")).toEqual([]);
  });

  it("does not match `# heading`", () => {
    expect(nodesNamed("# heading", "Tag")).toEqual([]);
  });

  it("does not match `#42`", () => {
    expect(nodesNamed("#42", "Tag")).toEqual([]);
  });

  it("does not match bare `##foo`", () => {
    expect(nodesNamed("##foo", "Tag")).toEqual([]);
  });

  it("matches multiple tags in a run", () => {
    const got = nodesNamed("#one #two #three", "Tag");
    expect(got.map((n) => n.text)).toEqual(["#one", "#two", "#three"]);
  });

  it("does not extend through a trailing slash", () => {
    const got = nodesNamed("#a/", "Tag");
    expect(got).toEqual([{ from: 0, to: 2, text: "#a" }]);
  });

  it("does not recognise a tag inside an inline code span", () => {
    // Lezer's `InlineCode` is a leaf — no inline parser descends into it.
    expect(nodesNamed("`#notatag`", "Tag")).toEqual([]);
  });
});
