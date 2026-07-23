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
import { scanTags } from "./tag";
import { scanWikilinks } from "./wikilink";

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

function shift(
  from: number,
  to: number,
  bodyOffset: number,
): Span {
  return { start: from + bodyOffset, end: to + bodyOffset };
}

function extendOneNewline(body: string, to: number): number {
  if (to < body.length && body.charCodeAt(to) === 0x0a ) {
    return to + 1;
  }
  if (
    to + 1 < body.length &&
    body.charCodeAt(to) === 0x0d  &&
    body.charCodeAt(to + 1) === 0x0a
  ) {
    return to + 2;
  }
  return to;
}

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

const INLINE_MARKER_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "QuoteMark",
  "ListMark",
  "CodeInfo",
]);

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
      inlines: splitInlines(inlines),
      span: shift(from, end, bodyOffset),
    };
  }

  if (name === "Paragraph") {
    const inlines = readInlinesFromNode(cursor.node, body);
    const end = extendOneNewline(body, to);
    return {
      kind: "paragraph",
      inlines: splitInlines(inlines),
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

  return null;
}

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
  const end = extendThroughBlankLines(body, node.to);
  return { blocks, span: shift(node.from, end, bodyOffset) };
}

function readInlinesFromNode(node: SyntaxNode, body: string): Inline[] {
  let from = node.from;
  let to = node.to;

  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      if (cursor.name === "HeaderMark" && cursor.from === from) {
        from = skipSpace(body, cursor.to);
      }
      if (cursor.name === "HeaderMark" && cursor.to === to) {
        to = trimRight(body, from, cursor.from);
      }
    } while (cursor.nextSibling());
  }

  return readInlines(node, body, from, to);
}

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

    if (INLINE_MARKER_NODES.has(child.name)) {
      hasChild = child.nextSibling();
      continue;
    }

    const inline = readInline(child.node, body);
    if (inline) {
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
      return { kind: "text", value: body.slice(node.from, node.to) };
    case "Autolink": {
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
  const raw = body.slice(node.from, node.to);
  return raw.replace(/^`+/, "").replace(/`+$/, "");
}

function readLink(
  node: SyntaxNode,
  body: string,
  asImage: boolean,
): Inline {
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
        const raw = body.slice(cursor.from, cursor.to);
        title = stripTitleQuotes(raw);
      } else if (cursor.name === "LinkMark") {
        const ch = body.charCodeAt(cursor.from);
        if (!sawOpenBracket && (ch === 0x5b  || ch === 0x21 )) {
          textFrom = cursor.to;
          sawOpenBracket = true;
        } else if (sawOpenBracket && textTo < 0 && body.charCodeAt(cursor.from) === 0x5d ) {
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

function pushText(out: Inline[], raw: string): void {
  if (raw.length === 0) return;
  const folded = raw.replace(/\r?\n/g, " ");
  if (folded.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.kind === "text") {
    last.value += folded;
    return;
  }
  out.push({ kind: "text", value: folded });
}

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

function splitInlines(inlines: Inline[]): Inline[] {
  const flat: Inline[] = [];
  for (const inline of inlines) {
    if (inline.kind === "text") {
      mergeText(flat, inline.value);
    } else if (inline.kind === "link" && inline.dest === "" && inline.title === null) {
      mergeText(flat, "[" + serializeInlinesAsText(inline.children) + "]");
    } else if (inline.kind === "image" && inline.dest === "" && inline.title === null) {
      mergeText(flat, "![" + serializeInlinesAsText(inline.alt) + "]");
    } else if (inline.kind === "emph") {
      flat.push({ kind: "emph", children: splitInlines(inline.children) });
    } else if (inline.kind === "strong") {
      flat.push({ kind: "strong", children: splitInlines(inline.children) });
    } else if (inline.kind === "link") {
      flat.push({
        kind: "link",
        dest: inline.dest,
        title: inline.title,
        children: splitInlines(inline.children),
      });
    } else if (inline.kind === "image") {
      flat.push({
        kind: "image",
        dest: inline.dest,
        title: inline.title,
        alt: splitInlines(inline.alt),
      });
    } else {
      flat.push(inline);
    }
  }
  const out: Inline[] = [];
  for (const inline of flat) {
    if (inline.kind === "text") {
      for (const wikiRun of scanWikilinks(inline.value)) {
        if (wikiRun.kind === "text") {
          for (const tagRun of scanTags(wikiRun.value)) {
            out.push(tagRun as Inline);
          }
        } else {
          out.push(wikiRun as Inline);
        }
      }
    } else {
      out.push(inline);
    }
  }
  return out;
}

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
