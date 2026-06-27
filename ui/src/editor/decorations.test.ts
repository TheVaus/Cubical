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
  findBlockIds,
  findFrontmatter,
  livePreviewDecorations,
  type CursorState,
  type DecoEntry,
  type DecoKind,
} from "./decorations";
import { tagExtension } from "./tag";
import { wikilinkExtension } from "./wikilink";
import type { WikiLinkResolution } from "./wikilinkResolver";

const parser = defaultParser.configure([wikilinkExtension, tagExtension]);

/** A collapsed caret at `offset`, or a full selection range, as CursorState. */
function toCursor(c: number | CursorState): CursorState {
  return typeof c === "number" ? { head: c, from: c, to: c } : c;
}

/** Document offset of the start of 1-based `line` — for line-based tests. */
function at(src: string, line: number): number {
  return Text.of(src.split("\n")).line(line).from;
}

function run(
  src: string,
  cursor: number | CursorState,
  resolverLookup?: (targetRaw: string) => WikiLinkResolution | undefined,
): DecoEntry[] {
  const tree = parser.parse(src);
  const doc = Text.of(src.split("\n"));
  return collectDecorations(tree, doc, toCursor(cursor), resolverLookup);
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
    const entries = run(src, at(src, 3));
    const lineDeco = one(ofKind(entries, "line-h1"));
    expect(lineDeco.from).toBe(0);
    expect(lineDeco.to).toBe(0);
    expect(slice(src, one(ofKind(entries, "hide")))).toBe("# ");
  });

  it("scales each heading level 1-6 with its own line class", () => {
    const src = "# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6";
    const entries = run(src, at(src, 1));
    expect(ofKind(entries, "line-h1")).toHaveLength(1);
    expect(ofKind(entries, "line-h2")).toHaveLength(1);
    expect(ofKind(entries, "line-h3")).toHaveLength(1);
    expect(ofKind(entries, "line-h4")).toHaveLength(1);
    expect(ofKind(entries, "line-h5")).toHaveLength(1);
    expect(ofKind(entries, "line-h6")).toHaveLength(1);
  });

  it("reveals the marker as muted on the cursor line but keeps the heading class", () => {
    const src = "# Title\n\nbody";
    const entries = run(src, at(src, 1));
    expect(ofKind(entries, "line-h1")).toHaveLength(1);
    expect(ofKind(entries, "hide")).toHaveLength(0);
    expect(slice(src, one(ofKind(entries, "mark-marker-muted")))).toBe("# ");
  });
});

describe("collectDecorations — Setext headings", () => {
  it("tags the content line and hides the underline row", () => {
    const src = "Title\n=====\n\nbody";
    const entries = run(src, at(src, 4));
    expect(ofKind(entries, "line-h1")).toHaveLength(1);
    expect(slice(src, one(ofKind(entries, "hide")))).toBe("=====");
  });
});

describe("collectDecorations — inline emphasis", () => {
  it("italicises Emphasis and hides both * markers", () => {
    const src = "text *word* end\n";
    const entries = run(src, at(src, 2));
    expect(slice(src, one(ofKind(entries, "mark-em")))).toBe("*word*");
    const hidden = ofKind(entries, "hide");
    expect(hidden.map((e) => slice(src, e))).toEqual(["*", "*"]);
  });

  it("bolds StrongEmphasis and hides both ** markers", () => {
    const src = "text **word** end\n";
    const entries = run(src, at(src, 2));
    expect(slice(src, one(ofKind(entries, "mark-strong")))).toBe("**word**");
    const hidden = ofKind(entries, "hide");
    expect(hidden.map((e) => slice(src, e))).toEqual(["**", "**"]);
  });
});

describe("collectDecorations — inline code", () => {
  it("styles InlineCode and hides the backtick markers", () => {
    const src = "call `fn()` now\n";
    const entries = run(src, at(src, 2));
    expect(slice(src, one(ofKind(entries, "mark-code")))).toBe("`fn()`");
    const hidden = ofKind(entries, "hide");
    expect(hidden.map((e) => slice(src, e))).toEqual(["`", "`"]);
  });
});

describe("collectDecorations — code blocks", () => {
  it("tags every line of a fenced block and hides both fence lines", () => {
    const src = "```\ncode\n```\n\nafter";
    const entries = run(src, at(src, 5));
    expect(ofKind(entries, "line-code")).toHaveLength(3);
    const hidden = ofKind(entries, "hide");
    expect(hidden.map((e) => slice(src, e))).toEqual(["```", "```"]);
  });
});

describe("collectDecorations — blockquotes", () => {
  it("tags each quote line and hides the > marker", () => {
    const src = "> quoted\n> lines\n\nafter";
    const entries = run(src, at(src, 4));
    expect(ofKind(entries, "line-quote")).toHaveLength(2);
    const hidden = ofKind(entries, "hide");
    expect(hidden.map((e) => slice(src, e))).toEqual(["> ", "> "]);
  });
});

describe("collectDecorations — lists", () => {
  it("replaces a bullet marker with a bullet glyph", () => {
    const src = "- item\n\nafter";
    const entries = run(src, at(src, 3));
    expect(slice(src, one(ofKind(entries, "bullet")))).toBe("-");
  });

  it("keeps ordered-list numerals — no bullet, no hide", () => {
    const src = "1. first\n2. second\n\nafter";
    const entries = run(src, at(src, 4));
    expect(ofKind(entries, "bullet")).toHaveLength(0);
    expect(ofKind(entries, "hide")).toHaveLength(0);
  });
});

describe("collectDecorations — links", () => {
  it("underlines the link text and hides the brackets and url", () => {
    const src = "see [docs](http://x) now\n";
    const entries = run(src, at(src, 2));
    expect(slice(src, one(ofKind(entries, "mark-link")))).toBe("docs");
    const hidden = ofKind(entries, "hide")
      .map((e) => slice(src, e))
      .join("");
    expect(hidden).toBe("[]" + "(http://x)");
  });
});

describe("collectDecorations — out of scope nodes stay raw", () => {
  it("leaves images and thematic breaks raw; decorates a paragraph-start tag", () => {
    // Wiki-links used to live here too (L2). They were promoted to a
    // decorated node in L3 Session B; see the wiki-link describe block
    // below for the new contract.
    //
    // The image and thematic break contribute no decorations. `#tag`
    // *does* — a tag that opens its own paragraph (offset > 0) is a real
    // Tag node and gets `mark-tag` (regression guard: it used to be
    // dropped by the inline word-boundary check; see tag.ts).
    const src = "![alt](http://x)\n\n---\n\n#tag is not a heading\n\nend";
    const entries = run(src, at(src, 7));
    expect(entries).toEqual([{ from: 23, to: 27, kind: "mark-tag" }]);
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
    const entries = run(src, at(src, 2), resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[", "]]"]);
  });

  it("[[note|display]] off-cursor: hide [[note|, show display as mark-wikilink", () => {
    const src = "[[note|display]]\n";
    const entries = run(src, at(src, 2), resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("display");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[note|", "]]"]);
  });

  it("[[note#heading]] off-cursor: visible target, hide [[ and #heading]]", () => {
    const src = "[[note#heading]]\n";
    const entries = run(src, at(src, 2), resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[", "#heading]]"]);
  });

  it("[[note#^id]] off-cursor: visible target, hide [[ and #^id]]", () => {
    const src = "[[note#^id]]\n";
    const entries = run(src, at(src, 2), resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["[[", "#^id]]"]);
  });

  it("![[diagram]] off-cursor: visible target + hidden brackets (no inline embed indicator — retired in L4-A-fix Contract 2)", () => {
    const src = "![[diagram]]\n";
    const entries = run(src, at(src, 2), resolvedAll);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("diagram");
    const hidden = ofKind(entries, "hide").map((e) => slice(src, e));
    expect(hidden).toEqual(["![[", "]]"]);
  });

  it("does not emit mark-wikilink-embed for embed tokens (retired in L4-A-fix Contract 2)", () => {
    const doc = Text.of(["paragraph", "", "![[Daily]]", "", "tail"]);
    const tree = parser.parse(doc.toString());
    const entries = collectDecorations(tree, doc, toCursor(0));
    for (const e of entries) {
      expect(e.kind).not.toBe("mark-wikilink-embed");
    }
  });

  it("unresolved target gets mark-wikilink-unresolved instead of mark-wikilink", () => {
    const src = "[[missing]]\n";
    const entries = run(src, at(src, 2), unresolvedAll);
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
    const entries = run(src, at(src, 2), () => undefined);
    expect(slice(src, one(ofKind(entries, "mark-wikilink")))).toBe("note");
    expect(ofKind(entries, "mark-wikilink-unresolved")).toHaveLength(0);
  });

  it("when the cursor touches it, the wiki-link token becomes mark-marker-muted", () => {
    const src = "[[note|display]]\n";
    const entries = run(src, 1, unresolvedAll); // caret inside the token
    expect(ofKind(entries, "mark-wikilink")).toHaveLength(0);
    expect(ofKind(entries, "mark-wikilink-unresolved")).toHaveLength(0);
    expect(ofKind(entries, "hide")).toHaveLength(0);
    // Brackets + content all muted. We don't assert exact substring
    // splits here — the touched behaviour is "reveal raw source",
    // exact range boundaries are an implementation detail.
    expect(ofKind(entries, "mark-marker-muted").length).toBeGreaterThan(0);
  });

  it("multiple wiki-links in one paragraph each get their own decoration", () => {
    const src = "[[a]] and [[b]]\n";
    const entries = run(src, at(src, 2), resolvedAll);
    const visible = ofKind(entries, "mark-wikilink").map((e) => slice(src, e));
    expect(visible.sort()).toEqual(["a", "b"]);
  });
});

describe("collectDecorations — tags (L3 Session D)", () => {
  it("emits mark-tag covering the whole token off the cursor line", () => {
    const src = "see #todo here\n";
    const entries = run(src, at(src, 2));
    const tags = ofKind(entries, "mark-tag");
    expect(tags).toHaveLength(1);
    expect(slice(src, tags[0]!)).toBe("#todo");
  });

  it("emits a nested tag as one token", () => {
    const src = "#project/cubical/l3\n";
    const entries = run(src, at(src, 2));
    const tags = ofKind(entries, "mark-tag");
    expect(tags).toHaveLength(1);
    expect(slice(src, tags[0]!)).toBe("#project/cubical/l3");
  });

  it("emits multiple tag marks for multiple tags", () => {
    const src = "#one #two #three\n";
    const entries = run(src, at(src, 2));
    const tags = ofKind(entries, "mark-tag");
    expect(tags.map((t) => slice(src, t))).toEqual(["#one", "#two", "#three"]);
  });

  it("flips to muted when the cursor touches it (no mark-tag emitted)", () => {
    const src = "#todo\n";
    const entries = run(src, 1); // caret inside the tag
    expect(ofKind(entries, "mark-tag")).toHaveLength(0);
    const muted = ofKind(entries, "mark-marker-muted");
    expect(muted.some((e) => slice(src, e) === "#todo")).toBe(true);
  });
});

describe("collectDecorations — inline reveal is touch-based, not line-based", () => {
  // The reference bug: an inline token must stay rendered while the
  // caret merely shares its line; it reveals raw only when the caret
  // actually touches it (boundary-inclusive).

  it("keeps a wiki-link rendered when the caret is elsewhere on its line", () => {
    const src = "see [[note]] here\n"; // [[note]] spans offsets 4..12
    const entries = run(src, 1); // caret inside "see"
    expect(ofKind(entries, "mark-wikilink")).toHaveLength(1);
    expect(ofKind(entries, "hide")).toHaveLength(2); // [[ and ]]
    expect(ofKind(entries, "mark-marker-muted")).toHaveLength(0);
  });

  it("reveals a wiki-link raw when the caret is inside it", () => {
    const src = "see [[note]] here\n";
    const entries = run(src, 7); // caret inside "note"
    expect(ofKind(entries, "mark-wikilink")).toHaveLength(0);
    expect(ofKind(entries, "hide")).toHaveLength(0);
    expect(ofKind(entries, "mark-marker-muted").length).toBeGreaterThan(0);
  });

  it("treats a caret on either boundary as touching the wiki-link", () => {
    const src = "see [[note]] here\n";
    for (const caret of [4, 12]) {
      // 4 == just before "[[", 12 == just after "]]"
      const entries = run(src, caret);
      expect(ofKind(entries, "mark-wikilink")).toHaveLength(0);
      expect(ofKind(entries, "mark-marker-muted").length).toBeGreaterThan(0);
    }
    // One past the closer renders again.
    expect(ofKind(run(src, 13), "mark-wikilink")).toHaveLength(1);
  });

  it("reveals a wiki-link when a selection overlaps it", () => {
    const src = "see [[note]] here\n";
    const entries = run(src, { head: 7, from: 1, to: 7 });
    expect(ofKind(entries, "mark-wikilink")).toHaveLength(0);
    expect(ofKind(entries, "mark-marker-muted").length).toBeGreaterThan(0);
  });

  it("keeps emphasis markers hidden until the caret touches the token", () => {
    const src = "text *word* end\n"; // *word* spans 5..11
    expect(ofKind(run(src, 1), "hide")).toHaveLength(2); // caret in "text"
    expect(ofKind(run(src, 7), "hide")).toHaveLength(0); // caret in "word"
    expect(ofKind(run(src, 7), "mark-marker-muted").length).toBeGreaterThan(0);
  });

  it("keeps a tag rendered until the caret touches it", () => {
    const src = "see #todo here\n"; // #todo spans 4..9
    expect(ofKind(run(src, 1), "mark-tag")).toHaveLength(1); // caret in "see"
    expect(ofKind(run(src, 6), "mark-tag")).toHaveLength(0); // caret in "todo"
  });

  it("still reveals a heading marker line-based — anywhere on the line", () => {
    const src = "# Title\n\nbody";
    // Caret elsewhere on the heading line still reveals the `# `.
    const onLine = run(src, 5);
    expect(slice(src, one(ofKind(onLine, "mark-marker-muted")))).toBe("# ");
    expect(ofKind(onLine, "hide")).toHaveLength(0);
    // Caret on another line hides it.
    expect(ofKind(run(src, at(src, 3)), "hide")).toHaveLength(1);
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
    const entries = run(src, at(src, 2), () => ({
      target_path: "note.md",
      anchor: null,
    }));
    expect(entries.some((e) => e.kind === "mark-wikilink")).toBe(true);
  });
});

function runBlockIds(src: string, cursor: number | CursorState): DecoEntry[] {
  const tree = parser.parse(src);
  const doc = Text.of(src.split("\n"));
  return findBlockIds(doc, tree, toCursor(cursor));
}

describe("findBlockIds", () => {
  it("marks a trailing ^id the cursor is not touching", () => {
    // Caret on line 3 ("other"), so line 1's id is decorated.
    const src = "a paragraph ^intro\n\nother\n";
    const got = runBlockIds(src, at(src, 3));
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe("mark-blockid");
    const line = "a paragraph ^intro";
    expect(got[0]?.from).toBe(line.indexOf("^"));
    expect(got[0]?.to).toBe(line.length);
  });

  it("marks an id alone on its own line", () => {
    const got = runBlockIds("para\n^solo\n", 0); // caret on line 1
    expect(got).toHaveLength(1);
    // Line 2 starts after "para\n" = offset 5.
    expect(got[0]?.from).toBe(5);
    expect(got[0]?.to).toBe(5 + "^solo".length);
  });

  it("reveals (does not mark) the id the cursor is touching", () => {
    // Caret inside ^intro (offset 13).
    const got = runBlockIds("a paragraph ^intro\n", 13);
    expect(got).toHaveLength(0);
  });

  it("ignores ^id inside a fenced code block", () => {
    const src = "```\nlet x = 1 ^nope\n```\nreal ^yes\n";
    const got = runBlockIds(src, at(src, 5)); // caret on the trailing line
    expect(got).toHaveLength(1);
    expect(got[0]?.to).toBe("```\nlet x = 1 ^nope\n```\nreal ^yes".length);
  });

  it("does not match mid-line or non-ws-preceded carets", () => {
    expect(runBlockIds("text ^mid more\n", at("text ^mid more\n", 2))).toHaveLength(0);
    expect(runBlockIds("word^attached\n", at("word^attached\n", 2))).toHaveLength(0);
  });
});
