/**
 * Lezer markdown tree → canonical AST.
 *
 * The TypeScript counterpart to `crates/cubical-ast/src/normalize.rs`.
 * Both produce the same `CanonicalDocument` shape from the same source
 * string; the cross-language parity harness in
 * `crates/cubical-ast/tests/fixtures/parity.json` is the regression
 * test for that contract.
 *
 * The walk:
 * - Frontmatter is split off before Lezer sees the source. `bodyOffset`
 *   shifts every block-level span emitted from the body so the absolute
 *   offsets line up with the original `source`.
 * - Block nodes (`Paragraph`, `ATXHeadingN`, `SetextHeadingN`,
 *   `FencedCode`, `CodeBlock`, `Blockquote`, `BulletList`, `OrderedList`,
 *   `ListItem`, `HorizontalRule`, `HTMLBlock`, `CommentBlock`,
 *   `ProcessingInstructionBlock`) are recognized; everything else is
 *   silently skipped (Cubical's L1 AST doesn't model tables, footnotes,
 *   math, definition lists, ...).
 * - Inline content inside a paragraph or heading is reconstructed by
 *   walking the children and filling text from the gaps between marker
 *   nodes. Soft line breaks (raw `\n` inside an inline span) fold into
 *   a single space; `HardBreak` becomes `{ kind: "line_break" }`.
 * - `Emphasis` / `StrongEmphasis` / `InlineCode` / `Link` / `Image` are
 *   recognized; other inline node kinds (Escape, Entity, HTMLTag,
 *   Comment, ProcessingInstruction, Autolink) flow through as text.
 */

import { parser } from "@lezer/markdown";
import type { SyntaxNode, TreeCursor } from "@lezer/common";

import { parseFrontmatterYaml, splitFrontmatter } from "./frontmatter";
import type {
  Block,
  CanonicalDocument,
  Inline,
  ListItem,
  Span,
} from "./types";
import { scanWikilinks } from "./wikilink";

/** Parse `source` into the canonical AST. Mirrors `cubical_ast::parse`. */
export function normalize(source: string): CanonicalDocument {
  const split = splitFrontmatter(source);
  const frontmatter =
    split.yaml !== null && split.span !== null
      ? parseFrontmatterYaml(split.yaml, split.span)
      : null;

  const tree = parser.parse(split.body);
  const blocks: Block[] = [];
  const cursor = tree.cursor();
  if (cursor.firstChild()) {
    do {
      const block = readBlock(cursor, split.body, split.bodyOffset);
      if (block) blocks.push(block);
    } while (cursor.nextSibling());
  }

  return {
    frontmatter,
    blocks,
    source_len: source.length,
  };
}

/** Shift a body-relative range into an absolute span. */
function shift(
  from: number,
  to: number,
  bodyOffset: number,
): Span {
  return { start: from + bodyOffset, end: to + bodyOffset };
}

/**
 * Lezer ends block spans at the last non-newline character; pulldown-cmark
 * (the Rust normalizer) includes the trailing newline. Extend `to` by
 * exactly one `\n` (LF or CRLF) when present so the two sides agree.
 *
 * Used for headings, paragraphs, blockquotes, thematic breaks. Code
 * blocks intentionally don't extend — pulldown-cmark stops at the
 * closing fence and Lezer agrees.
 */
function extendOneNewline(body: string, to: number): number {
  if (to < body.length && body.charCodeAt(to) === 0x0a /* \n */) {
    return to + 1;
  }
  if (
    to + 1 < body.length &&
    body.charCodeAt(to) === 0x0d /* \r */ &&
    body.charCodeAt(to + 1) === 0x0a
  ) {
    return to + 2;
  }
  return to;
}

/**
 * For list items, pulldown-cmark extends the span through every blank
 * line that separates the item from the next item (or the end of the
 * source). Mirror that by skipping any run of consecutive `\n`s after
 * Lezer's `to`.
 */
function extendThroughBlankLines(body: string, to: number): number {
  while (to < body.length) {
    const c = body.charCodeAt(to);
    if (c === 0x0a) {
      to++;
    } else if (
      c === 0x0d &&
      to + 1 < body.length &&
      body.charCodeAt(to + 1) === 0x0a
    ) {
      to += 2;
    } else {
      break;
    }
  }
  return to;
}

/** Heading levels: ATXHeading1..6 + SetextHeading1..2. */
const HEADING_LEVELS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

/** Inline marker nodes whose contents are not part of the inline stream. */
const INLINE_MARKER_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "QuoteMark",
  "ListMark",
  "CodeInfo",
]);

/**
 * Read a single block-level node at the cursor. Returns `null` for nodes
 * the canonical AST doesn't model (so the caller skips them).
 */
function readBlock(
  cursor: TreeCursor,
  body: string,
  bodyOffset: number,
): Block | null {
  const name = cursor.name;
  const from = cursor.from;
  const to = cursor.to;

  if (name in HEADING_LEVELS) {
    const level = HEADING_LEVELS[name]!;
    const inlines = readInlinesFromNode(cursor.node, body);
    const end = extendOneNewline(body, to);
    return {
      kind: "heading",
      level,
      inlines: splitWikilinks(inlines),
      span: shift(from, end, bodyOffset),
    };
  }

  if (name === "Paragraph") {
    const inlines = readInlinesFromNode(cursor.node, body);
    const end = extendOneNewline(body, to);
    return {
      kind: "paragraph",
      inlines: splitWikilinks(inlines),
      span: shift(from, end, bodyOffset),
    };
  }

  if (name === "FencedCode" || name === "CodeBlock") {
    const { lang, content } = readCodeBlock(cursor.node, body);
    return {
      kind: "code_block",
      lang,
      content,
      span: shift(from, to, bodyOffset),
    };
  }

  if (name === "Blockquote") {
    const blocks: Block[] = [];
    const child = cursor.node.cursor();
    if (child.firstChild()) {
      do {
        if (child.name === "QuoteMark") continue;
        const sub = readBlock(child, body, bodyOffset);
        if (sub) blocks.push(sub);
      } while (child.nextSibling());
    }
    const end = extendOneNewline(body, to);
    return { kind: "quote", blocks, span: shift(from, end, bodyOffset) };
  }

  if (name === "BulletList" || name === "OrderedList") {
    const items: ListItem[] = [];
    const child = cursor.node.cursor();
    if (child.firstChild()) {
      do {
        if (child.name !== "ListItem") continue;
        items.push(readListItem(child.node, body, bodyOffset));
      } while (child.nextSibling());
    }
    // List span end = last item's already-extended span end (which
    // includes any blank lines after the final item).
    const last = items[items.length - 1];
    const listEnd = last ? last.span.end - bodyOffset : to;
    return {
      kind: "list",
      ordered: name === "OrderedList",
      items,
      span: shift(from, listEnd, bodyOffset),
    };
  }

  if (name === "HorizontalRule") {
    const end = extendOneNewline(body, to);
    return { kind: "thematic_break", span: shift(from, end, bodyOffset) };
  }

  if (
    name === "HTMLBlock" ||
    name === "CommentBlock" ||
    name === "ProcessingInstructionBlock"
  ) {
    const end = extendOneNewline(body, to);
    return {
      kind: "html",
      content: body.slice(from, to),
      span: shift(from, end, bodyOffset),
    };
  }

  // Lezer also surfaces `LinkReference` blocks for `[label]: url`
  // definitions. Cubical's L1 AST doesn't model them — they are silent
  // at this layer. Ditto any future extension we don't recognize.
  return null;
}

/** Extract `lang` (info string) and verbatim `content` from a code block. */
function readCodeBlock(
  node: SyntaxNode,
  body: string,
): { lang: string | null; content: string } {
  let lang: string | null = null;
  const parts: { from: number; to: number }[] = [];

  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      if (cursor.name === "CodeInfo") {
        const info = body.slice(cursor.from, cursor.to).trim();
        if (info.length > 0) lang = info;
      } else if (cursor.name === "CodeText") {
        parts.push({ from: cursor.from, to: cursor.to });
      }
    } while (cursor.nextSibling());
  }

  if (parts.length === 0) {
    return { lang, content: "" };
  }

  // Lezer emits one `CodeText` node per line of content, each WITHOUT
  // the trailing newline. Pulldown-cmark's emitted content includes a
  // trailing newline after every line (including the last). Reproduce
  // that here.
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const content = body.slice(first.from, last.to) + "\n";
  return { lang, content };
}

function readListItem(
  node: SyntaxNode,
  body: string,
  bodyOffset: number,
): ListItem {
  const blocks: Block[] = [];
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      if (cursor.name === "ListMark") continue;
      const sub = readBlock(cursor, body, bodyOffset);
      if (sub) blocks.push(sub);
    } while (cursor.nextSibling());
  }
  // Pulldown-cmark extends a list item's span through the blank lines
  // that separate it from the next item (or the source end).
  const end = extendThroughBlankLines(body, node.to);
  return { blocks, span: shift(node.from, end, bodyOffset) };
}

/**
 * Walk a node's inline children, filling text from gaps between recognized
 * markers, and produce a coalesced `Inline[]`.
 */
function readInlinesFromNode(node: SyntaxNode, body: string): Inline[] {
  // For Setext headings, the trailing `HeaderMark` underline must be
  // excluded from the inline range.
  let from = node.from;
  let to = node.to;

  // ATX headings: skip the leading `# ` markers and any optional
  // trailing `#` run. Walk the children to find the inline boundary.
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      // If the *first* HeaderMark is the leading `#`s, advance `from`
      // past it (and past the single space delimiter, which is part of
      // the Heading node's span but not part of the inline content).
      if (cursor.name === "HeaderMark" && cursor.from === from) {
        from = skipSpace(body, cursor.to);
      }
      // If the *last* HeaderMark is at the end of the heading, retract
      // `to` to its start. Covers both ATX trailing `#` and Setext
      // underlines.
      if (cursor.name === "HeaderMark" && cursor.to === to) {
        to = trimRight(body, from, cursor.from);
      }
    } while (cursor.nextSibling());
  }

  return readInlines(node, body, from, to);
}

/**
 * Read inline content from `[from, to)` within the body, walking
 * `node`'s inline-level children (Emphasis, StrongEmphasis, InlineCode,
 * Link, Image, HardBreak, ...). Text not covered by a recognized child
 * node fills from the source `body`.
 */
function readInlines(
  node: SyntaxNode,
  body: string,
  from: number,
  to: number,
): Inline[] {
  const out: Inline[] = [];
  let cursor = from;
  const child = node.cursor();
  let hasChild = child.firstChild();
  while (hasChild) {
    if (child.from < from) {
      hasChild = child.nextSibling();
      continue;
    }
    if (child.from >= to) break;

    // Skip marker children that sit at the boundary; they're handled by
    // their parent (e.g. HeaderMark already trimmed above; LinkMark
    // children are handled inside readLink).
    if (INLINE_MARKER_NODES.has(child.name)) {
      hasChild = child.nextSibling();
      continue;
    }

    const inline = readInline(child.node, body);
    if (inline) {
      // Fill text from the source between the previous cursor and this
      // child's start.
      if (child.from > cursor) {
        pushText(out, body.slice(cursor, child.from));
      }
      out.push(inline);
      cursor = child.to;
    }

    hasChild = child.nextSibling();
  }
  if (cursor < to) {
    pushText(out, body.slice(cursor, to));
  }
  return out;
}

/** Read a single inline-level child node. Returns `null` if not modeled. */
function readInline(node: SyntaxNode, body: string): Inline | null {
  switch (node.name) {
    case "Emphasis": {
      const inner = readInlinesInsideMarks(node, body);
      return { kind: "emph", children: inner };
    }
    case "StrongEmphasis": {
      const inner = readInlinesInsideMarks(node, body);
      return { kind: "strong", children: inner };
    }
    case "InlineCode": {
      const value = readInlineCodeText(node, body);
      return { kind: "code", value };
    }
    case "HardBreak":
      return { kind: "line_break" };
    case "Link": {
      return readLink(node, body, false);
    }
    case "Image": {
      return readLink(node, body, true);
    }
    case "Escape":
    case "Entity":
    case "HTMLTag":
    case "Comment":
    case "ProcessingInstruction":
      // Surface the raw source as text (mirrors the Rust normalizer's
      // "Inline HTML attaches as text" rule).
      return { kind: "text", value: body.slice(node.from, node.to) };
    case "Autolink": {
      // Autolinks are wrapped: `<https://x>`. The visible text is the
      // URL itself; the canonical AST renders this as a Link with the
      // URL as both dest and child text.
      const urlNode = findChildByName(node, "URL");
      const dest = urlNode
        ? body.slice(urlNode.from, urlNode.to)
        : body.slice(node.from + 1, node.to - 1);
      return {
        kind: "link",
        dest,
        title: null,
        children: [{ kind: "text", value: dest }],
      };
    }
    default:
      return null;
  }
}

function readInlinesInsideMarks(node: SyntaxNode, body: string): Inline[] {
  // For `*emph*` and `**strong**`, Lezer puts the surrounding marker
  // characters in `EmphasisMark` children; the actual text content
  // sits in the "gaps" between them (Lezer doesn't emit text nodes).
  // The inner range is therefore [firstMark.to, lastMark.from).
  const marks: Array<{ from: number; to: number }> = [];
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      if (cursor.name === "EmphasisMark") {
        marks.push({ from: cursor.from, to: cursor.to });
      }
    } while (cursor.nextSibling());
  }
  if (marks.length < 2) {
    return readInlines(node, body, node.from, node.to);
  }
  return readInlines(node, body, marks[0]!.to, marks[marks.length - 1]!.from);
}

function readInlineCodeText(node: SyntaxNode, body: string): string {
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      if (cursor.name === "CodeText") {
        return body.slice(cursor.from, cursor.to);
      }
    } while (cursor.nextSibling());
  }
  // Fallback: strip surrounding backticks heuristically.
  const raw = body.slice(node.from, node.to);
  return raw.replace(/^`+/, "").replace(/`+$/, "");
}

function readLink(
  node: SyntaxNode,
  body: string,
  asImage: boolean,
): Inline {
  // Lezer's Link/Image children look like:
  //   LinkMark "[" content... LinkMark "]" LinkMark "(" URL LinkTitle? LinkMark ")"
  // (Image prefixes with "![".) The "content..." is the link text /
  // alt text. We extract URL and (optional) LinkTitle from the URL/
  // LinkTitle children, and recurse the in-bracket content as inlines.
  let dest = "";
  let title: string | null = null;
  let textFrom = -1;
  let textTo = -1;

  const cursor = node.cursor();
  if (cursor.firstChild()) {
    let sawOpenBracket = false;
    do {
      if (cursor.name === "URL") {
        dest = body.slice(cursor.from, cursor.to);
      } else if (cursor.name === "LinkTitle") {
        // Titles are surrounded by `"`/`'`/`(`/`)` — strip them.
        const raw = body.slice(cursor.from, cursor.to);
        title = stripTitleQuotes(raw);
      } else if (cursor.name === "LinkMark") {
        const ch = body.charCodeAt(cursor.from);
        if (!sawOpenBracket && (ch === 0x5b /* [ */ || ch === 0x21 /* ! */)) {
          // The opening bracket: text starts after this mark.
          // ImageMark is "![", which Lezer represents as a 2-char
          // LinkMark; both branches collapse to "text starts at mark.to".
          textFrom = cursor.to;
          sawOpenBracket = true;
        } else if (sawOpenBracket && textTo < 0 && body.charCodeAt(cursor.from) === 0x5d /* ] */) {
          textTo = cursor.from;
        }
      }
    } while (cursor.nextSibling());
  }

  let children: Inline[] = [];
  if (textFrom >= 0 && textTo >= textFrom) {
    children = readInlines(node, body, textFrom, textTo);
  }

  if (asImage) {
    return { kind: "image", dest, title, alt: children };
  }
  return { kind: "link", dest, title, children };
}

function stripTitleQuotes(raw: string): string {
  if (raw.length < 2) return raw;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === "(" && last === ")")
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function findChildByName(
  node: SyntaxNode,
  name: string,
): SyntaxNode | null {
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      if (cursor.name === name) return cursor.node;
    } while (cursor.nextSibling());
  }
  return null;
}

/**
 * Append text to the inline list, folding any embedded soft line
 * breaks to a single space and coalescing with a preceding text run.
 *
 * Pulldown-cmark fires one `Event::Text` per content chunk and the
 * normalizer joins them; this helper simulates the same coalescing on
 * the TS side.
 */
function pushText(out: Inline[], raw: string): void {
  if (raw.length === 0) return;
  // Fold soft line breaks: any standalone newline inside text becomes
  // a single space. CRLF folds the same way.
  const folded = raw.replace(/\r?\n/g, " ");
  if (folded.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.kind === "text") {
    last.value += folded;
    return;
  }
  out.push({ kind: "text", value: folded });
}

/** Skip ASCII space/tab in `body` starting at `pos`. */
function skipSpace(body: string, pos: number): number {
  while (pos < body.length) {
    const c = body.charCodeAt(pos);
    if (c === 0x20 || c === 0x09) {
      pos++;
    } else {
      break;
    }
  }
  return pos;
}

/** Trim trailing ASCII space/tab between `from` and `end`. */
function trimRight(body: string, from: number, end: number): number {
  while (end > from) {
    const c = body.charCodeAt(end - 1);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      end--;
    } else {
      break;
    }
  }
  return end;
}

/**
 * Walk an inline sequence and split every text run through the
 * wiki-link tokenizer. Mirrors `cubical_ast::normalize::split_wikilinks`.
 *
 * Lezer's @lezer/markdown grammar parses `[[X]]` as `[` + Link(dest="",
 * children=[text "X"]) + `]` and `![[X]]` as an Image(dest="",
 * alt=[Link(dest="", children=[text "X"])]). Both are reference/shortcut
 * mis-parses with no link definition in scope. pulldown-cmark on the
 * Rust side emits the same input as plain text (`[[X]]` literally), so
 * to reach parity we first re-flatten those empty-dest Link/Image nodes
 * back to raw bracketed text, then scan for wiki-links.
 */
function splitWikilinks(inlines: Inline[]): Inline[] {
  const flat: Inline[] = [];
  for (const inline of inlines) {
    if (inline.kind === "text") {
      mergeText(flat, inline.value);
    } else if (inline.kind === "link" && inline.dest === "" && inline.title === null) {
      mergeText(flat, "[" + serializeInlinesAsText(inline.children) + "]");
    } else if (inline.kind === "image" && inline.dest === "" && inline.title === null) {
      mergeText(flat, "![" + serializeInlinesAsText(inline.alt) + "]");
    } else if (inline.kind === "emph") {
      flat.push({ kind: "emph", children: splitWikilinks(inline.children) });
    } else if (inline.kind === "strong") {
      flat.push({ kind: "strong", children: splitWikilinks(inline.children) });
    } else if (inline.kind === "link") {
      flat.push({
        kind: "link",
        dest: inline.dest,
        title: inline.title,
        children: splitWikilinks(inline.children),
      });
    } else if (inline.kind === "image") {
      flat.push({
        kind: "image",
        dest: inline.dest,
        title: inline.title,
        alt: splitWikilinks(inline.alt),
      });
    } else {
      flat.push(inline);
    }
  }
  const out: Inline[] = [];
  for (const inline of flat) {
    if (inline.kind === "text") {
      for (const run of scanWikilinks(inline.value)) {
        out.push(run as Inline);
      }
    } else {
      out.push(inline);
    }
  }
  return out;
}

/**
 * Best-effort serialization of an inline subtree back to raw markdown
 * text. Only used to re-flatten Lezer's empty-dest Link/Image
 * mis-parses; other inline kinds inside such a subtree are degenerate
 * (the mis-parse only nests Link/Image/Text) so a minimal handler is
 * sufficient.
 */
function serializeInlinesAsText(inlines: Inline[]): string {
  let s = "";
  for (const inline of inlines) {
    if (inline.kind === "text") {
      s += inline.value;
    } else if (inline.kind === "link" && inline.dest === "" && inline.title === null) {
      s += "[" + serializeInlinesAsText(inline.children) + "]";
    } else if (inline.kind === "image" && inline.dest === "" && inline.title === null) {
      s += "![" + serializeInlinesAsText(inline.alt) + "]";
    }
  }
  return s;
}

function mergeText(out: Inline[], value: string): void {
  if (value.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.kind === "text") {
    out[out.length - 1] = { kind: "text", value: last.value + value };
  } else {
    out.push({ kind: "text", value });
  }
}
