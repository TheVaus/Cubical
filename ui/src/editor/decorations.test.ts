/**
 * Live Preview decoration logic — unit tests.
 *
 * `collectDecorations` is the pure, view-independent core of the L2
 * Session B decoration plugin: given a parsed Lezer tree, the document
 * text, and the active (cursor) line number, it returns a flat list of
 * decoration entries. The CM6 `ViewPlugin` is a thin wrapper that turns
 * these entries into a `DecorationSet`; the purely visual behaviour is
 * verified by the interactive smoke pass, not here.
 *
 * The tree is produced by the same CommonMark parser the editor uses
 * (`@lezer/markdown`'s base `parser`, which `@codemirror/lang-markdown`
 * configures for the editor) so node names match exactly.
 */
import { describe, expect, it } from "vitest";
import { parser } from "@lezer/markdown";
import { Text } from "@codemirror/state";

import { collectDecorations, type DecoEntry, type DecoKind } from "./decorations";

function run(src: string, activeLine: number): DecoEntry[] {
  const tree = parser.parse(src);
  const doc = Text.of(src.split("\n"));
  return collectDecorations(tree, doc, activeLine);
}

function kinds(entries: DecoEntry[]): DecoKind[] {
  return entries.map((e) => e.kind);
}

function ofKind(entries: DecoEntry[], kind: DecoKind): DecoEntry[] {
  return entries.filter((e) => e.kind === kind);
}

/** Assert exactly one entry of a kind and return it. */
function one(entries: DecoEntry[]): DecoEntry {
  expect(entries).toHaveLength(1);
  const [first] = entries;
  if (!first) throw new Error("expected one entry");
  return first;
}

function slice(src: string, e: DecoEntry): string {
  return src.slice(e.from, e.to);
}

describe("collectDecorations — ATX headings", () => {
  it("hides the # marker and tags the line with its heading level", () => {
    const src = "# Title\n\nbody";
    const entries = run(src, 3);
    const lineDeco = one(ofKind(entries, "line-h1"));
    expect(lineDeco.from).toBe(0);
    expect(lineDeco.to).toBe(0);
    expect(slice(src, one(ofKind(entries, "hide")))).toBe("# ");
  });

  it("scales each heading level 1-6 with its own line class", () => {
    const src = "# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6";
    const entries = run(src, 99 /* no real active line */);
    expect(ofKind(entries, "line-h1")).toHaveLength(1);
    expect(ofKind(entries, "line-h2")).toHaveLength(1);
    expect(ofKind(entries, "line-h3")).toHaveLength(1);
    expect(ofKind(entries, "line-h4")).toHaveLength(1);
    expect(ofKind(entries, "line-h5")).toHaveLength(1);
    expect(ofKind(entries, "line-h6")).toHaveLength(1);
  });

  it("reveals the marker as muted on the cursor line but keeps the heading class", () => {
    const src = "# Title\n\nbody";
    const entries = run(src, 1);
    expect(ofKind(entries, "line-h1")).toHaveLength(1);
    expect(ofKind(entries, "hide")).toHaveLength(0);
    expect(slice(src, one(ofKind(entries, "mark-marker-muted")))).toBe("# ");
  });
});

describe("collectDecorations — Setext headings", () => {
  it("tags the content line and hides the underline row", () => {
    const src = "Title\n=====\n\nbody";
    const entries = run(src, 4);
    expect(ofKind(entries, "line-h1")).toHaveLength(1);
    expect(slice(src, one(ofKind(entries, "hide")))).toBe("=====");
  });
});

describe("collectDecorations — inline emphasis", () => {
  it("italicises Emphasis and hides both * markers", () => {
    const src = "text *word* end\n";
    const entries = run(src, 2);
    expect(slice(src, one(ofKind(entries, "mark-em")))).toBe("*word*");
    const hidden = ofKind(entries, "hide");
    expect(hidden.map((e) => slice(src, e))).toEqual(["*", "*"]);
  });

  it("bolds StrongEmphasis and hides both ** markers", () => {
    const src = "text **word** end\n";
    const entries = run(src, 2);
    expect(slice(src, one(ofKind(entries, "mark-strong")))).toBe("**word**");
    const hidden = ofKind(entries, "hide");
    expect(hidden.map((e) => slice(src, e))).toEqual(["**", "**"]);
  });
});

describe("collectDecorations — inline code", () => {
  it("styles InlineCode and hides the backtick markers", () => {
    const src = "call `fn()` now\n";
    const entries = run(src, 2);
    expect(slice(src, one(ofKind(entries, "mark-code")))).toBe("`fn()`");
    const hidden = ofKind(entries, "hide");
    expect(hidden.map((e) => slice(src, e))).toEqual(["`", "`"]);
  });
});

describe("collectDecorations — code blocks", () => {
  it("tags every line of a fenced block and hides both fence lines", () => {
    const src = "```\ncode\n```\n\nafter";
    const entries = run(src, 5);
    expect(ofKind(entries, "line-code")).toHaveLength(3);
    const hidden = ofKind(entries, "hide");
    expect(hidden.map((e) => slice(src, e))).toEqual(["```", "```"]);
  });
});

describe("collectDecorations — blockquotes", () => {
  it("tags each quote line and hides the > marker", () => {
    const src = "> quoted\n> lines\n\nafter";
    const entries = run(src, 4);
    expect(ofKind(entries, "line-quote")).toHaveLength(2);
    const hidden = ofKind(entries, "hide");
    expect(hidden.map((e) => slice(src, e))).toEqual(["> ", "> "]);
  });
});

describe("collectDecorations — lists", () => {
  it("replaces a bullet marker with a bullet glyph", () => {
    const src = "- item\n\nafter";
    const entries = run(src, 3);
    expect(slice(src, one(ofKind(entries, "bullet")))).toBe("-");
  });

  it("keeps ordered-list numerals — no bullet, no hide", () => {
    const src = "1. first\n2. second\n\nafter";
    const entries = run(src, 4);
    expect(ofKind(entries, "bullet")).toHaveLength(0);
    expect(ofKind(entries, "hide")).toHaveLength(0);
  });
});

describe("collectDecorations — links", () => {
  it("underlines the link text and hides the brackets and url", () => {
    const src = "see [docs](http://x) now\n";
    const entries = run(src, 2);
    expect(slice(src, one(ofKind(entries, "mark-link")))).toBe("docs");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e)).join("");
    expect(hidden).toBe("[]" + "(http://x)");
  });
});

describe("collectDecorations — out of scope nodes stay raw", () => {
  it("leaves images, wiki-links, thematic breaks and tags undecorated", () => {
    const src = "![alt](http://x)\n\n[[WikiPage]]\n\n---\n\n#tag is not a heading\n\nend";
    const entries = run(src, 9);
    // The only decoration for an all-out-of-scope document is the
    // active-line background.
    expect(kinds(entries)).toEqual(["line-active"]);
  });
});

describe("collectDecorations — active line", () => {
  it("emits a line-active entry anchored at the cursor line start", () => {
    const src = "alpha\nbeta\ngamma";
    const entries = run(src, 2);
    const active = one(ofKind(entries, "line-active"));
    expect(active.from).toBe(6); // start of line 2
    expect(active.to).toBe(6);
  });
});
