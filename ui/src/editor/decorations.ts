import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  Facet,
  StateEffect,
  StateField,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { type SyntaxNode, type Tree } from "@lezer/common";

import { measurePerf } from "../core/perf";
import { scanWikilinks, type TokenizedRun } from "../ast/wikilink";
import type { WikiLinkResolution } from "./wikilinkResolver";

export type DecoKind =
  | "line-h1"
  | "line-h2"
  | "line-h3"
  | "line-h4"
  | "line-h5"
  | "line-h6"
  | "line-code"
  | "line-quote"
  | "mark-em"
  | "mark-strong"
  | "mark-code"
  | "mark-link"
  | "mark-wikilink"
  | "mark-wikilink-unresolved"
  | "mark-tag"
  | "mark-blockid"
  | "mark-marker-muted"
  | "hide"
  | "bullet";

export interface WikiLinkResolverFacetValue {
  get(targetRaw: string): WikiLinkResolution | undefined;
  fetch(targetRaw: string): void;
}

export const wikilinkResolverFacet = Facet.define<
  WikiLinkResolverFacetValue | null,
  WikiLinkResolverFacetValue | null
>({
  combine: (values) => values[0] ?? null,
});

export const wikilinkResolverUpdated = StateEffect.define<null>();

export interface DecoEntry {
  from: number;
  to: number;
  kind: DecoKind;
}

export interface CursorState {
  head: number;
  from: number;
  to: number;
}

function cursorTouches(
  cursor: CursorState,
  from: number,
  to: number,
): boolean {
  return cursor.from <= to && cursor.to >= from;
}

interface Marker {
  from: number;
  to: number;
  bullet: boolean;
  token: { from: number; to: number } | null;
}

export function findFrontmatter(
  doc: Text,
): { from: number; to: number } | null {
  if (doc.lines < 2) return null;
  if (doc.line(1).text !== "---") return null;
  for (let ln = 2; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    if (line.text === "---") {
      return { from: 0, to: line.to };
    }
  }
  return null;
}

const TRAILING_BLOCK_ID = /(^|\s)\^([A-Za-z_][A-Za-z0-9_-]*)\s*$/;

function isInsideCode(tree: Tree, pos: number): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node) {
    const n = node.name;
    if (
      n === "FencedCode" ||
      n === "CodeBlock" ||
      n === "CodeText" ||
      n === "InlineCode"
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

export function findBlockIds(
  doc: Text,
  tree: Tree,
  cursor: CursorState,
): DecoEntry[] {
  const out: DecoEntry[] = [];
  for (let ln = 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    const m = TRAILING_BLOCK_ID.exec(line.text);
    if (!m) continue;
    const lead = m[1] ?? "";
    const id = m[2] ?? "";
    const caretRel = m.index + lead.length;
    const from = line.from + caretRel;
    const to = from + 1 + id.length;
    if (cursorTouches(cursor, from, to)) continue;
    if (isInsideCode(tree, from)) continue;
    out.push({ from, to, kind: "mark-blockid" });
  }
  return out;
}

function extendSpaces(doc: Text, from: number): number {
  const line = doc.lineAt(from);
  let p = from;
  while (p < line.to && doc.sliceString(p, p + 1) === " ") p++;
  return p;
}

function resolverKey(
  tok: Extract<TokenizedRun, { kind: "wiki_link" }>,
): string {
  if (tok.anchor === null) return tok.target;
  const prefix = tok.anchor.kind === "block" ? "#^" : "#";
  return `${tok.target}${prefix}${tok.anchor.value}`;
}

export function collectDecorations(
  tree: Tree,
  doc: Text,
  cursor: CursorState,
  resolverLookup?: (targetRaw: string) => WikiLinkResolution | undefined,
): DecoEntry[] {
  const visible: DecoEntry[] = [];
  const markers: Marker[] = [];
  const activeLine = doc.lineAt(cursor.head).number;

  tree.iterate({
    enter: (node) => {
      const name = node.name;

      const heading = /^(ATX|Setext)Heading([1-6])$/.exec(name);
      if (heading) {
        const level = Number(heading[2]);
        const isSetext = heading[1] === "Setext";
        const contentLine = doc.lineAt(node.from);
        visible.push({
          from: contentLine.from,
          to: contentLine.from,
          kind: `line-h${level}` as DecoKind,
        });
        const heads = node.node.getChildren("HeaderMark");
        heads.forEach((hm, i) => {
          if (!isSetext && i === 0) {
            markers.push({
              from: hm.from,
              to: extendSpaces(doc, hm.to),
              bullet: false,
              token: null,
            });
          } else {
            markers.push({
              from: hm.from,
              to: hm.to,
              bullet: false,
              token: null,
            });
          }
        });
        return;
      }

      if (name === "Emphasis" || name === "StrongEmphasis") {
        visible.push({
          from: node.from,
          to: node.to,
          kind: name === "Emphasis" ? "mark-em" : "mark-strong",
        });
        const emToken = { from: node.from, to: node.to };
        for (const em of node.node.getChildren("EmphasisMark")) {
          markers.push({
            from: em.from,
            to: em.to,
            bullet: false,
            token: emToken,
          });
        }
        return;
      }

      if (name === "InlineCode") {
        visible.push({ from: node.from, to: node.to, kind: "mark-code" });
        const codeToken = { from: node.from, to: node.to };
        for (const cm of node.node.getChildren("CodeMark")) {
          markers.push({
            from: cm.from,
            to: cm.to,
            bullet: false,
            token: codeToken,
          });
        }
        return;
      }

      if (name === "FencedCode" || name === "CodeBlock") {
        const startLn = doc.lineAt(node.from).number;
        const endLn = doc.lineAt(Math.max(node.from, node.to - 1)).number;
        for (let ln = startLn; ln <= endLn; ln++) {
          const line = doc.line(ln);
          visible.push({ from: line.from, to: line.from, kind: "line-code" });
        }
        if (name === "FencedCode") {
          for (const cm of node.node.getChildren("CodeMark")) {
            const line = doc.lineAt(cm.from);
            markers.push({
              from: line.from,
              to: line.to,
              bullet: false,
              token: null,
            });
          }
        }
        return;
      }

      if (name === "Blockquote") {
        const startLn = doc.lineAt(node.from).number;
        const endLn = doc.lineAt(Math.max(node.from, node.to - 1)).number;
        for (let ln = startLn; ln <= endLn; ln++) {
          const line = doc.line(ln);
          visible.push({ from: line.from, to: line.from, kind: "line-quote" });
        }
        return;
      }

      if (name === "QuoteMark") {
        markers.push({
          from: node.from,
          to: extendSpaces(doc, node.to),
          bullet: false,
          token: null,
        });
        return;
      }

      if (name === "ListItem") {
        const parent = node.node.parent;
        if (parent && parent.name === "BulletList") {
          const lm = node.node.getChild("ListMark");
          if (lm) {
            markers.push({
              from: lm.from,
              to: lm.to,
              bullet: true,
              token: null,
            });
          }
        }
        return;
      }

      if (name === "Link") {
        const url = node.node.getChild("URL");
        if (!url) return;
        const linkMarks = node.node.getChildren("LinkMark");
        const open = linkMarks[0];
        const close = linkMarks[1];
        if (open && close && close.from > open.to) {
          visible.push({ from: open.to, to: close.from, kind: "mark-link" });
        }
        const linkToken = { from: node.from, to: node.to };
        for (const lm of linkMarks) {
          markers.push({
            from: lm.from,
            to: lm.to,
            bullet: false,
            token: linkToken,
          });
        }
        markers.push({
          from: url.from,
          to: url.to,
          bullet: false,
          token: linkToken,
        });
        const title = node.node.getChild("LinkTitle");
        if (title) {
          markers.push({
            from: title.from,
            to: title.to,
            bullet: false,
            token: linkToken,
          });
        }
        return;
      }

      if (name === "Tag") {
        const revealed = cursorTouches(cursor, node.from, node.to);
        visible.push({
          from: node.from,
          to: node.to,
          kind: revealed ? "mark-marker-muted" : "mark-tag",
        });
        return;
      }

      if (name === "WikiLink") {
        const raw = doc.sliceString(node.from, node.to);
        const tok = scanWikilinks(raw).find((t) => t.kind === "wiki_link");
        if (!tok || tok.kind !== "wiki_link") return;

        const revealed = cursorTouches(cursor, node.from, node.to);
        if (revealed) {
          visible.push({
            from: node.from,
            to: node.to,
            kind: "mark-marker-muted",
          });
          return;
        }

        const openerLen = tok.embed ? 3 : 2;
        const closerLen = 2;
        const contentEnd = node.to - closerLen;

        let visibleFrom: number;
        let visibleTo: number;
        if (tok.display !== null) {
          const pipeRel = raw.indexOf("|", openerLen);
          visibleFrom = node.from + pipeRel + 1;
          visibleTo = contentEnd;
        } else {
          let i = node.from + openerLen;
          while (i < contentEnd) {
            const ch = raw.charCodeAt(i - node.from);
            if (ch === 0x23  || ch === 0x7c ) break;
            i++;
          }
          visibleFrom = node.from + openerLen;
          visibleTo = i;
        }

        if (visibleFrom > node.from) {
          visible.push({ from: node.from, to: visibleFrom, kind: "hide" });
        }
        const resolution = resolverLookup?.(resolverKey(tok));
        const visibleKind: DecoKind =
          resolution && resolution.target_path === null
            ? "mark-wikilink-unresolved"
            : "mark-wikilink";
        visible.push({ from: visibleFrom, to: visibleTo, kind: visibleKind });
        if (visibleTo < node.to) {
          visible.push({ from: visibleTo, to: node.to, kind: "hide" });
        }
        return;
      }
    },
  });

  const out: DecoEntry[] = [...visible];

  for (const m of markers) {
    const reveal = m.token
      ? cursorTouches(cursor, m.token.from, m.token.to)
      : doc.lineAt(m.from).number === activeLine;
    if (reveal) {
      out.push({ from: m.from, to: m.to, kind: "mark-marker-muted" });
    } else {
      out.push({ from: m.from, to: m.to, kind: m.bullet ? "bullet" : "hide" });
    }
  }

  out.sort((a, b) => a.from - b.from || a.to - b.to);
  return out;
}

class BulletWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-bullet";
    span.textContent = "•";
    return span;
  }
  override eq(): boolean {
    return true;
  }
}

const headingLineDeco: Decoration[] = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-md-line-h${level}` }),
);
const codeLineDeco = Decoration.line({ class: "cm-md-line-code" });
const quoteLineDeco = Decoration.line({ class: "cm-md-line-quote" });
const emMarkDeco = Decoration.mark({ class: "cm-md-em" });
const strongMarkDeco = Decoration.mark({ class: "cm-md-strong" });
const inlineCodeMarkDeco = Decoration.mark({ class: "cm-md-inline-code" });
const linkMarkDeco = Decoration.mark({ class: "cm-md-link" });
const wikilinkMarkDeco = Decoration.mark({ class: "cm-md-wikilink" });
const wikilinkUnresolvedDeco = Decoration.mark({
  class: "cm-md-wikilink-unresolved",
});
const tagMarkDeco = Decoration.mark({ class: "cm-md-tag" });
const blockIdMarkDeco = Decoration.mark({ class: "cm-md-blockid" });
const mutedMarkDeco = Decoration.mark({ class: "cm-md-mark-muted" });
const hideDeco = Decoration.replace({});
const hideBlockDeco = Decoration.replace({ block: true });
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });

function buildDecorationSet(entries: DecoEntry[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case "line-h1":
      case "line-h2":
      case "line-h3":
      case "line-h4":
      case "line-h5":
      case "line-h6": {
        const deco = headingLineDeco[Number(e.kind.slice(-1)) - 1];
        if (deco) ranges.push(deco.range(e.from));
        break;
      }
      case "line-code":
        ranges.push(codeLineDeco.range(e.from));
        break;
      case "line-quote":
        ranges.push(quoteLineDeco.range(e.from));
        break;
      case "mark-em":
        ranges.push(emMarkDeco.range(e.from, e.to));
        break;
      case "mark-strong":
        ranges.push(strongMarkDeco.range(e.from, e.to));
        break;
      case "mark-code":
        ranges.push(inlineCodeMarkDeco.range(e.from, e.to));
        break;
      case "mark-link":
        ranges.push(linkMarkDeco.range(e.from, e.to));
        break;
      case "mark-wikilink":
        ranges.push(wikilinkMarkDeco.range(e.from, e.to));
        break;
      case "mark-wikilink-unresolved":
        ranges.push(wikilinkUnresolvedDeco.range(e.from, e.to));
        break;
      case "mark-tag":
        ranges.push(tagMarkDeco.range(e.from, e.to));
        break;
      case "mark-blockid":
        ranges.push(blockIdMarkDeco.range(e.from, e.to));
        break;
      case "mark-marker-muted":
        ranges.push(mutedMarkDeco.range(e.from, e.to));
        break;
      case "hide":
        ranges.push(hideDeco.range(e.from, e.to));
        break;
      case "bullet":
        ranges.push(bulletDeco.range(e.from, e.to));
        break;
    }
  }
  return Decoration.set(ranges, true);
}

function buildFor(view: EditorView): DecorationSet {
  return measurePerf("editor:decorations", () => buildDecorations(view));
}

function buildDecorations(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state);
  const sel = view.state.selection.main;
  const cursor: CursorState = { head: sel.head, from: sel.from, to: sel.to };
  const resolver = view.state.facet(wikilinkResolverFacet);
  const entries = collectDecorations(
    tree,
    view.state.doc,
    cursor,
    resolver ? (t) => resolver.get(t) : undefined,
  );
  const blockIds = findBlockIds(view.state.doc, tree, cursor);
  return buildDecorationSet([...entries, ...blockIds]);
}

function kickResolverFetches(view: EditorView): void {
  const resolver = view.state.facet(wikilinkResolverFacet);
  if (!resolver) return;
  const tree = syntaxTree(view.state);
  const seen = new Set<string>();
  tree.iterate({
    enter: (node) => {
      if (node.name !== "WikiLink") return;
      const raw = view.state.doc.sliceString(node.from, node.to);
      const tok = scanWikilinks(raw).find((t) => t.kind === "wiki_link");
      if (!tok || tok.kind !== "wiki_link") return;
      const key = resolverKey(tok);
      if (seen.has(key)) return;
      seen.add(key);
      if (resolver.get(key) === undefined) resolver.fetch(key);
    },
  });
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildFor(view);
      kickResolverFetches(view);
    }

    update(update: ViewUpdate): void {
      const resolverChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(wikilinkResolverUpdated)),
      );
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        resolverChanged
      ) {
        this.decorations = buildFor(update.view);
        kickResolverFetches(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function frontmatterHideSet(doc: Text): DecorationSet {
  const fm = findFrontmatter(doc);
  if (!fm) return Decoration.none;
  return Decoration.set([hideBlockDeco.range(fm.from, fm.to)]);
}

const frontmatterHideField = StateField.define<DecorationSet>({
  create: (state) => frontmatterHideSet(state.doc),
  update: (deco, tr) => (tr.docChanged ? frontmatterHideSet(tr.newDoc) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

const decorationBaseTheme = EditorView.baseTheme({
  ".cm-md-line-h1": {
    fontSize: "var(--text-2xl)",
    fontWeight: "700",
    lineHeight: "var(--leading-tight)",
  },
  ".cm-md-line-h2": {
    fontSize: "var(--text-xl)",
    fontWeight: "700",
    lineHeight: "var(--leading-tight)",
  },
  ".cm-md-line-h3": {
    fontSize: "var(--text-lg)",
    fontWeight: "600",
    lineHeight: "var(--leading-tight)",
  },
  ".cm-md-line-h4": { fontSize: "var(--text-base)", fontWeight: "600" },
  ".cm-md-line-h5": { fontSize: "var(--text-sm)", fontWeight: "700" },
  ".cm-md-line-h6": {
    fontSize: "var(--text-sm)",
    fontWeight: "600",
    color: "var(--c-fg-muted)",
  },
  ".cm-md-line-code": {
    background: "var(--c-bg-secondary)",
    paddingLeft: "var(--space-3)",
    paddingRight: "var(--space-3)",
  },
  ".cm-md-line-quote": {
    borderLeft: "var(--space-1) solid var(--c-accent)",
    paddingLeft: "var(--space-3)",
    color: "var(--c-fg-secondary)",
    fontStyle: "italic",
  },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-inline-code": {
    background: "var(--c-bg-tertiary)",
    borderRadius: "var(--radius-sm)",
    paddingLeft: "var(--space-1)",
    paddingRight: "var(--space-1)",
  },
  ".cm-md-link": { color: "var(--c-accent)", textDecoration: "underline" },
  ".cm-md-wikilink": {
    color: "var(--c-accent)",
    textDecoration: "underline",
    cursor: "pointer",
  },
  ".cm-md-wikilink-unresolved": {
    color: "var(--c-warning, var(--c-accent))",
    textDecoration: "underline dashed",
    cursor: "pointer",
  },
  ".cm-md-tag": {
    color: "var(--c-accent)",
    background: "var(--c-bg-tertiary)",
    borderRadius: "var(--radius-sm)",
    paddingLeft: "var(--space-1)",
    paddingRight: "var(--space-1)",
    fontWeight: "500",
    cursor: "pointer",
  },
  ".cm-md-blockid": {
    color: "var(--c-fg-muted)",
    fontSize: "0.85em",
  },
  ".cm-md-mark-muted": { color: "var(--editor-mark-fg-muted)" },
  ".cm-md-bullet": { color: "var(--c-accent)" },
});

export const livePreviewDecorations: Extension = [
  livePreviewPlugin,
  frontmatterHideField,
  decorationBaseTheme,
];
