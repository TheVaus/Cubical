import { describe, expect, it } from "vitest";

import { splitFrontmatter } from "./frontmatter";
import { normalize } from "./normalize";

describe("frontmatter detection", () => {
  it("returns no frontmatter for empty source", () => {
    const split = splitFrontmatter("");
    expect(split.yaml).toBeNull();
    expect(split.body).toBe("");
    expect(split.bodyOffset).toBe(0);
  });

  it("rejects leading whitespace before opener", () => {
    const split = splitFrontmatter(" ---\nx\n---\n");
    expect(split.yaml).toBeNull();
  });

  it("returns no frontmatter when closer is missing", () => {
    const split = splitFrontmatter("---\nx: 1\nbody\n");
    expect(split.yaml).toBeNull();
  });

  it("extracts frontmatter and aligns body offset", () => {
    const src = "---\ntitle: Hello\n---\n# Body\n";
    const split = splitFrontmatter(src);
    expect(split.yaml).toBe("title: Hello\n");
    expect(split.body).toBe("# Body\n");
    expect(src.slice(split.bodyOffset)).toBe(split.body);
  });

  it("handles CRLF line endings", () => {
    const split = splitFrontmatter("---\r\nx: 1\r\n---\r\nBody\r\n");
    expect(split.yaml).toBe("x: 1\r\n");
    expect(split.body).toBe("Body\r\n");
  });
});

describe("normalize() shape", () => {
  it("emits headings with correct level and inlines", () => {
    const doc = normalize("### Hi there\n");
    expect(doc.blocks.length).toBe(1);
    const block = doc.blocks[0];
    if (!block || block.kind !== "heading") {
      throw new Error("expected heading");
    }
    expect(block.level).toBe(3);
    expect(block.inlines).toEqual([{ kind: "text", value: "Hi there" }]);
  });

  it("preserves fenced code language and content", () => {
    const doc = normalize("```ts\nlet x = 1;\n```\n");
    const block = doc.blocks[0];
    if (!block || block.kind !== "code_block") {
      throw new Error("expected code_block");
    }
    expect(block.lang).toBe("ts");
    expect(block.content).toBe("let x = 1;\n");
  });

  it("recognizes nested loose lists", () => {
    const doc = normalize("- outer\n\n  - inner\n");
    const list = doc.blocks[0];
    if (!list || list.kind !== "list" || list.ordered) {
      throw new Error("expected unordered list");
    }
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    const first = list.items[0]!;
    const hasPara = first.blocks.some((b) => b.kind === "paragraph");
    const hasNestedList = first.blocks.some((b) => b.kind === "list");
    expect(hasPara).toBe(true);
    expect(hasNestedList).toBe(true);
  });

  it("recognizes blockquotes recursively", () => {
    const doc = normalize("> a quoted line.\n");
    const quote = doc.blocks[0];
    if (!quote || quote.kind !== "quote") {
      throw new Error("expected quote");
    }
    expect(quote.blocks.length).toBe(1);
    expect(quote.blocks[0]!.kind).toBe("paragraph");
  });

  it("emits link with dest, title, and inline children", () => {
    const doc = normalize('[label](https://x.test "t")\n');
    const para = doc.blocks[0];
    if (!para || para.kind !== "paragraph") throw new Error("expected paragraph");
    const link = para.inlines.find((i) => i.kind === "link");
    expect(link).toBeDefined();
    if (!link || link.kind !== "link") throw new Error("expected link");
    expect(link.dest).toBe("https://x.test");
    expect(link.title).toBe("t");
    expect(link.children).toEqual([{ kind: "text", value: "label" }]);
  });

  it("emits image with alt text", () => {
    const doc = normalize("![alt](pic.png)\n");
    const para = doc.blocks[0];
    if (!para || para.kind !== "paragraph") throw new Error("expected paragraph");
    const img = para.inlines.find((i) => i.kind === "image");
    expect(img).toBeDefined();
    if (!img || img.kind !== "image") throw new Error("expected image");
    expect(img.dest).toBe("pic.png");
    expect(img.alt).toEqual([{ kind: "text", value: "alt" }]);
  });

  it("emits hard break for two trailing spaces + newline", () => {
    const doc = normalize("line one  \nline two\n");
    const para = doc.blocks[0];
    if (!para || para.kind !== "paragraph") throw new Error("expected paragraph");
    const hasBreak = para.inlines.some((i) => i.kind === "line_break");
    expect(hasBreak).toBe(true);
  });

  it("folds soft line breaks into a single space", () => {
    const doc = normalize("first line\nsecond line\n");
    const para = doc.blocks[0];
    if (!para || para.kind !== "paragraph") throw new Error("expected paragraph");
    expect(para.inlines).toEqual([
      { kind: "text", value: "first line second line" },
    ]);
  });

  it("recognizes empty source as an empty document", () => {
    const doc = normalize("");
    expect(doc.frontmatter).toBeNull();
    expect(doc.blocks).toEqual([]);
    expect(doc.source_len).toBe(0);
  });

  it("frontmatter span sits at the start of the source", () => {
    const doc = normalize("---\ntitle: x\n---\n\n# Body\n");
    expect(doc.frontmatter).not.toBeNull();
    expect(doc.frontmatter!.span.start).toBe(0);
  });
});

describe("normalize — wiki-links", () => {
  it("extracts a wiki-link from a paragraph", () => {
    const doc = normalize("see [[Other Note]] for more\n");
    expect(doc.blocks.length).toBe(1);
    const p = doc.blocks[0]!;
    if (p.kind !== "paragraph") throw new Error("expected paragraph");
    expect(p.inlines).toEqual([
      { kind: "text", value: "see " },
      {
        kind: "wiki_link",
        target: "Other Note",
        display: null,
        anchor: null,
        embed: false,
      },
      { kind: "text", value: " for more" },
    ]);
  });

  it("emits an embed wiki-link", () => {
    const doc = normalize("![[diagram]]\n");
    const p = doc.blocks[0]!;
    if (p.kind !== "paragraph") throw new Error("expected paragraph");
    expect(p.inlines).toHaveLength(1);
    const wl = p.inlines[0]!;
    expect(wl.kind).toBe("wiki_link");
    if (wl.kind !== "wiki_link") return;
    expect(wl.embed).toBe(true);
    expect(wl.target).toBe("diagram");
  });

  it("does not scan inline-code content for wiki-links", () => {
    const doc = normalize("see `[[not a link]]` here\n");
    const p = doc.blocks[0]!;
    if (p.kind !== "paragraph") throw new Error("expected paragraph");
    expect(
      p.inlines.some((i) => i.kind === "code" && i.value === "[[not a link]]"),
    ).toBe(true);
    expect(p.inlines.some((i) => i.kind === "wiki_link")).toBe(false);
  });

  it("normalizes property refs into inline nodes", () => {
    const doc = normalize("Age: [[Gandalf.age]] and [[.level]].\n");
    const p = doc.blocks[0]!;
    if (p.kind !== "paragraph") throw new Error("expected paragraph");
    const refs = p.inlines.filter((i) => i.kind === "property_ref");
    expect(refs).toEqual([
      { kind: "property_ref", note: "Gandalf", property: "age" },
      { kind: "property_ref", note: null, property: "level" },
    ]);
  });
});
