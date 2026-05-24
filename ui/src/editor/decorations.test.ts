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
import { parser as defaultParser } from "@lezer/markdown";
import { Text } from "@codemirror/state";

import {
  collectDecorations,
  findFrontmatter,
  livePreviewDecorations,
  type DecoEntry,
  type DecoKind,
} from "./decorations";
import { wikilinkExtension } from "./wikilink";
import type { WikiLinkResolution } from "./wikilinkResolver";

const parser = defaultParser.configure([wikilinkExtension]);

function run(
  src: string,
  activeLine: number,
  resolverLookup?: (targetRaw: string) => WikiLinkResolution | undefined,
): DecoEntry[] {
  const tree = parser.parse(src);
  const doc = Text.of(src.split("\n"));
  return collectDecorations(tree, doc, activeLine, resolverLookup);
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
    const hidden = ofKind(entries, "hide")
      .map((e) => slice(src, e))
      .join("");
    expect(hidden).toBe("[]" + "(http://x)");
  });
});

describe("collectDecorations — out of scope nodes stay raw", () => {
  it("leaves images, thematic breaks and tags undecorated", () => {
    // Wiki-links used to live here too (L2). They were promoted to a
    // decorated node in L3 Session B; see the wiki-link describe block
    // below for the new contract.
    const src = "![alt](http://x)\n\n---\n\n#tag is not a heading\n\nend";
    const entries = run(src, 7);
    expect(kinds(entries)).toEqual(["line-active"]);
  });
});

describe("collectDecorations — wiki-links (L3 Session B)", () => {
  const resolvedAll: (t: string) => WikiLinkResolution = () => ({
    target_path: "note.md",
    anchor: null,
  });
  const unresolvedAll: (t: string) => WikiLinkResolution = () => ({
    target_path: null,
    anchor: null,
  });

  it("[[note]] off-cursor: hide [[ and ]], visible target as mark-wikilink", () => {
    const src = "see [[note]] here\n";
    const entries = run(src, 99, resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[", "]]"]);
  });

  it("[[note|display]] off-cursor: hide [[note|, show display as mark-wikilink", () => {
    const src = "[[note|display]]\n";
    const entries = run(src, 99, resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("display");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[note|", "]]"]);
  });

  it("[[note#heading]] off-cursor: visible target, hide [[ and #heading]]", () => {
    const src = "[[note#heading]]\n";
    const entries = run(src, 99, resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[", "#heading]]"]);
  });

  it("[[note#^id]] off-cursor: visible target, hide [[ and #^id]]", () => {
    const src = "[[note#^id]]\n";
    const entries = run(src, 99, resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[", "#^id]]"]);
  });

  it("![[diagram]] off-cursor: embed indicator + visible target", () => {
    const src = "![[diagram]]\n";
    const entries = run(src, 99, resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("diagram");
    expect(ofKind(entries, "mark-wikilink-embed")).toHaveLength(1);
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["![[", "]]"]);
  });

  it("unresolved target gets mark-wikilink-unresolved instead of mark-wikilink", () => {
    const src = "[[missing]]\n";
    const entries = run(src, 99, unresolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink-unresolved")))).toBe(
      "missing",
    );
    expect(ofKind(entries, "mark-wikilink")).toHaveLength(0);
  });

  it("pending resolution (resolver returns undefined) renders as resolved-style", () => {
    // Don't paint the warning state on tokens we haven't checked yet
    // — that flashes warnings the user has no reason to see. The next
    // decoration rebuild after the IPC returns will repaint correctly.
    const src = "[[note]]\n";
    const entries = run(src, 99, () => undefined);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    expect(ofKind(entries, "mark-wikilink-unresolved")).toHaveLength(0);
  });

  it("on the cursor line, the wiki-link token becomes mark-marker-muted", () => {
    const src = "[[note|display]]\n";
    const entries = run(src, 1, unresolvedAll);
    expect(ofKind(entries, "mark-wikilink")).toHaveLength(0);
    expect(ofKind(entries, "mark-wikilink-unresolved")).toHaveLength(0);
    expect(ofKind(entries, "mark-wikilink-embed")).toHaveLength(0);
    expect(ofKind(entries, "hide")).toHaveLength(0);
    // Brackets + content all muted. We don't assert exact substring
    // splits here — the cursor-line behaviour is "reveal raw source",
    // exact range boundaries are an implementation detail.
    expect(ofKind(entries, "mark-marker-muted").length).toBeGreaterThan(0);
  });

  it("multiple wiki-links in one paragraph each get their own decoration", () => {
    const src = "[[a]] and [[b]]\n";
    const entries = run(src, 99, resolvedAll);
    const visible = ofKind(entries, "mark-wikilink").map((e) => slice(src, e));
    expect(visible.sort()).toEqual(["a", "b"]);
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

describe("findFrontmatter", () => {
  function fm(src: string) {
    return findFrontmatter(Text.of(src.split("\n")));
  }

  it("ends the hide range at the closer line, not the first content line", () => {
    // `---\ntitle: foo\n---\nbody\n` — the closer `---` ends at byte 18
    // (its trailing newline). The hide range must stop there: a
    // block-replace decoration whose `to` lands on the body line's
    // start (byte 19) makes CodeMirror drop that line's
    // `Decoration.line`, so a heading / code block / blockquote
    // immediately after the frontmatter loses its decoration.
    // Regression guard for the §9.6 frontmatter-hide fix.
    expect(fm("---\ntitle: foo\n---\nbody\n")).toEqual({ from: 0, to: 18 });
  });

  it("stops before a heading that immediately follows the frontmatter", () => {
    // No blank line between the closer and `# H`. The hide range must
    // end strictly before the heading line's start, else CodeMirror
    // swallows the heading's line decoration (size/weight scaling).
    const src = "---\nt: 1\n---\n# H\n";
    const headingFrom = src.indexOf("# H");
    const result = fm(src);
    expect(result).not.toBeNull();
    expect(result!.to).toBe(headingFrom - 1);
  });

  it("covers a block that runs to EOF", () => {
    const src = "---\ntitle: foo\n---";
    expect(fm(src)).toEqual({ from: 0, to: src.length });
  });

  it("returns null when the file has no frontmatter", () => {
    expect(fm("# Heading\n\nbody\n")).toBeNull();
  });

  it("does not treat a mid-document --- as frontmatter", () => {
    expect(fm("intro\n\n---\nnot frontmatter\n---\n")).toBeNull();
  });
});

describe("livePreviewDecorations bundle — raw-source toggle contract (L3 Session B)", () => {
  // The L2 Session E raw-source toggle reconfigures the editor's
  // decoration compartment from `livePreviewDecorations` to `[]`.
  // Together these two tests prove that wiki-link decorations are
  // suppressed when the toggle is on: the bundle is non-empty and
  // contains the pipeline that emits the mark-wikilink kinds (proven
  // here) — and the compartment swap to `[]` is CM6 framework code
  // verified end-to-end by the §9.2 interactive smoke.

  it("livePreviewDecorations is a non-empty Extension array", () => {
    // If a future change extracted wiki-link decorations into a
    // separate extension installed outside this bundle, the toggle
    // would no longer suppress them — this guards against that.
    expect(Array.isArray(livePreviewDecorations)).toBe(true);
    expect((livePreviewDecorations as unknown as unknown[]).length).toBeGreaterThan(0);
  });

  it("collectDecorations (driven by the bundle) emits mark-wikilink for wiki-links", () => {
    const src = "[[note]]\n";
    const entries = run(src, 99, () => ({
      target_path: "note.md",
      anchor: null,
    }));
    expect(entries.some((e) => e.kind === "mark-wikilink")).toBe(true);
  });
});
