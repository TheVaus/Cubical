/**
 * Live Preview decorations — L2 Session B (spec §2.2).
 *
 * A CodeMirror 6 `ViewPlugin` that makes the markdown buffer read like
 * a document: headings scale, emphasis renders, code blocks get a
 * surface, marker tokens (`#`, `*`, backticks, `>`, list dashes, link
 * brackets + url) are hidden — except on the cursor's line, where the
 * raw source is revealed so it stays directly editable.
 *
 * Decoration source is **Lezer exclusively** (`syntaxTree(state)`).
 * This is the L2 §5 deviation #2: decorations need byte-precise marker
 * token positions, which the canonical Rust-mirrored AST deliberately
 * abstracts away. The canonical-AST path (`onAstChange`) is unaffected;
 * decorations are a parallel consumer.
 *
 * `collectDecorations` is the pure, view-independent core (unit-tested
 * in `decorations.test.ts`). The `ViewPlugin` is a thin wrapper that
 * recomputes the entry list on every relevant update and turns it into
 * a `DecorationSet`.
 *
 * One decoration — hiding a top-of-file YAML frontmatter block — is the
 * exception: it is a *block* decoration, which CodeMirror forbids from
 * a `ViewPlugin`, so it is supplied by a separate `StateField`
 * (`frontmatterHideField`). It is also not Lezer-sourced — the markdown
 * grammar does not model frontmatter — so `findFrontmatter` scans the
 * document directly.
 *
 * Out of scope (left raw, no decoration — L3+ territory): tables,
 * images, HTML blocks, thematic breaks, task-list checkboxes, math,
 * callouts, wiki-links `[[…]]`, embeds `![[…]]`, block IDs, tags.
 */
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

import { scanWikilinks, type TokenizedRun } from "../ast/wikilink";
import type { WikiLinkResolution } from "./wikilinkResolver";

/** A decoration the plugin should apply, as flat positional data. */
export type DecoKind =
  | "line-h1"
  | "line-h2"
  | "line-h3"
  | "line-h4"
  | "line-h5"
  | "line-h6"
  | "line-code"
  | "line-quote"
  | "line-active"
  | "mark-em"
  | "mark-strong"
  | "mark-code"
  | "mark-link"
  | "mark-wikilink"
  | "mark-wikilink-unresolved"
  | "mark-wikilink-embed"
  | "mark-tag"
  | "mark-blockid"
  | "mark-marker-muted"
  | "hide"
  | "bullet";

/**
 * Per-editor wiki-link resolver supplied via {@link wikilinkResolverFacet}.
 * `null` when no vault is open (everything renders as resolved-style).
 *
 * The decoration plugin reads `get` for sync lookup and calls `fetch`
 * for cache misses; both are pure functions on the resolver object. We
 * pass only what the plugin needs — not the whole `WikiLinkResolver`
 * interface — so test stubs stay minimal.
 */
export interface WikiLinkResolverFacetValue {
  get(targetRaw: string): WikiLinkResolution | undefined;
  fetch(targetRaw: string): void;
}

/**
 * Facet that supplies the per-editor wiki-link resolver to extensions.
 * `Editor.tsx` writes the current resolver into a Compartment that
 * `.reconfigure`s this facet whenever the vault changes.
 */
export const wikilinkResolverFacet = Facet.define<
  WikiLinkResolverFacetValue | null,
  WikiLinkResolverFacetValue | null
>({
  combine: (values) => values[0] ?? null,
});

/**
 * StateEffect dispatched by `Editor.tsx` whenever the resolver's cache
 * changes (a fetch completed or an `invalidate()` was called). The
 * decoration plugin watches transactions for this effect and rebuilds.
 */
export const wikilinkResolverUpdated = StateEffect.define<null>();

export interface DecoEntry {
  /** Document offset where the decoration starts. */
  from: number;
  /** Document offset where it ends (== `from` for line decorations). */
  to: number;
  kind: DecoKind;
}

/** A marker token — hidden off the cursor line, revealed (muted) on it. */
interface Marker {
  from: number;
  to: number;
  /** Bullet-list dashes render as a `•` glyph rather than vanishing. */
  bullet: boolean;
}

/**
 * Locate a YAML frontmatter block at the very top of the document.
 * Matches the byte-for-byte rules of `ui/src/ast/frontmatter.ts` (and
 * the Rust side): opener `---` on line 1, closer `---` on its own
 * line. Returns the range from document start through the closer
 * line's end — fed straight to a block-replace decoration, which
 * collapses those lines cleanly with no leftover blank line.
 */
export function findFrontmatter(
  doc: Text,
): { from: number; to: number } | null {
  if (doc.lines < 2) return null;
  if (doc.line(1).text !== "---") return null;
  for (let ln = 2; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    if (line.text === "---") {
      // End at the closer line's own end: its trailing newline, or the
      // document end when the closer is the last line (`line.to` gives
      // both). The range must NOT extend to the next line's start — a
      // `block: true` replace decoration whose `to` coincides with a
      // line start makes CodeMirror drop that line's `Decoration.line`,
      // which would strip the decoration off a heading / code block /
      // blockquote sitting immediately after the frontmatter.
      return { from: 0, to: line.to };
    }
  }
  return null;
}

/** Trailing block id on a line: `^id` preceded by start-or-whitespace. */
const TRAILING_BLOCK_ID = /(^|\s)\^([A-Za-z_][A-Za-z0-9_-]*)\s*$/;

/** True when `pos` resolves inside a fenced/inline code construct. */
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

/**
 * Scan every line for a trailing `^block-id` token (spec §2.7 grammar),
 * skipping the cursor line (revealed raw, like every marker) and any id
 * inside fenced/inline code. Returns `mark-blockid` entries. Pure; the
 * markdown grammar has no `^id` node, so this is a direct doc scan in
 * the `findFrontmatter` tradition rather than a Lezer walk.
 */
export function findBlockIds(
  doc: Text,
  tree: Tree,
  activeLine: number,
): DecoEntry[] {
  const out: DecoEntry[] = [];
  for (let ln = 1; ln <= doc.lines; ln++) {
    if (ln === activeLine) continue;
    const line = doc.line(ln);
    const m = TRAILING_BLOCK_ID.exec(line.text);
    if (!m) continue;
    const lead = m[1] ?? "";
    const id = m[2] ?? "";
    // `lead` is the leading "" or single whitespace char; the caret
    // sits right after it. `1 + id.length` covers "^" + the id.
    const caretRel = m.index + lead.length;
    const from = line.from + caretRel;
    const to = from + 1 + id.length;
    if (isInsideCode(tree, from)) continue;
    out.push({ from, to, kind: "mark-blockid" });
  }
  return out;
}

/** Advance past run-of-spaces immediately after `from`, within its line. */
function extendSpaces(doc: Text, from: number): number {
  const line = doc.lineAt(from);
  let p = from;
  while (p < line.to && doc.sliceString(p, p + 1) === " ") p++;
  return p;
}

/**
 * Wiki-link cache key: the wiki-link target as written including any
 * `#anchor`. Matches the `target_raw` input shape that the
 * `resolve_link` IPC accepts.
 */
function resolverKey(
  tok: Extract<TokenizedRun, { kind: "wiki_link" }>,
): string {
  if (tok.anchor === null) return tok.target;
  const prefix = tok.anchor.kind === "block" ? "#^" : "#";
  return `${tok.target}${prefix}${tok.anchor.value}`;
}

/**
 * Walk the Lezer tree and produce the decoration entry list for the
 * current cursor line. Pure: no `EditorView`, no DOM — directly
 * testable against a parsed tree.
 *
 * `resolverLookup`, when supplied, supplies wiki-link resolution
 * status per target. A return of `undefined` means "not yet checked"
 * and paints as resolved-style pending the next rebuild.
 */
export function collectDecorations(
  tree: Tree,
  doc: Text,
  activeLine: number,
  resolverLookup?: (targetRaw: string) => WikiLinkResolution | undefined,
): DecoEntry[] {
  const visible: DecoEntry[] = [];
  const markers: Marker[] = [];

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
            });
          } else {
            markers.push({ from: hm.from, to: hm.to, bullet: false });
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
        for (const em of node.node.getChildren("EmphasisMark")) {
          markers.push({ from: em.from, to: em.to, bullet: false });
        }
        return;
      }

      if (name === "InlineCode") {
        visible.push({ from: node.from, to: node.to, kind: "mark-code" });
        for (const cm of node.node.getChildren("CodeMark")) {
          markers.push({ from: cm.from, to: cm.to, bullet: false });
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
          // Hide the whole fence line (backticks + any info string).
          for (const cm of node.node.getChildren("CodeMark")) {
            const line = doc.lineAt(cm.from);
            markers.push({ from: line.from, to: line.to, bullet: false });
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

      // Continuation-line `>` markers are not direct children of the
      // Blockquote node, so they are matched on their own — `QuoteMark`
      // only ever appears inside a blockquote.
      if (name === "QuoteMark") {
        markers.push({
          from: node.from,
          to: extendSpaces(doc, node.to),
          bullet: false,
        });
        return;
      }

      if (name === "ListItem") {
        // Bullet lists swap the dash for a glyph; ordered lists keep
        // their numerals (the number carries the sequence).
        const parent = node.node.parent;
        if (parent && parent.name === "BulletList") {
          const lm = node.node.getChild("ListMark");
          if (lm) markers.push({ from: lm.from, to: lm.to, bullet: true });
        }
        return;
      }

      if (name === "Link") {
        // Only inline links `[text](url)` — a Link with a `URL` child.
        // Reference / shortcut links have no URL child; wiki-links
        // `[[…]]` never parse as Link at all. Both stay raw.
        const url = node.node.getChild("URL");
        if (!url) return;
        const linkMarks = node.node.getChildren("LinkMark");
        const open = linkMarks[0];
        const close = linkMarks[1];
        if (open && close && close.from > open.to) {
          visible.push({ from: open.to, to: close.from, kind: "mark-link" });
        }
        for (const lm of linkMarks) {
          markers.push({ from: lm.from, to: lm.to, bullet: false });
        }
        markers.push({ from: url.from, to: url.to, bullet: false });
        const title = node.node.getChild("LinkTitle");
        if (title) {
          markers.push({ from: title.from, to: title.to, bullet: false });
        }
        return;
      }

      if (name === "Tag") {
        const onActiveLine = doc.lineAt(node.from).number === activeLine;
        visible.push({
          from: node.from,
          to: node.to,
          kind: onActiveLine ? "mark-marker-muted" : "mark-tag",
        });
        return;
      }

      if (name === "WikiLink") {
        const raw = doc.sliceString(node.from, node.to);
        const tok = scanWikilinks(raw).find((t) => t.kind === "wiki_link");
        if (!tok || tok.kind !== "wiki_link") return;

        const onActiveLine = doc.lineAt(node.from).number === activeLine;
        if (onActiveLine) {
          // Reveal the whole token muted — mirrors how Link / Emphasis
          // behave on the cursor line. Exact sub-range styling is an
          // implementation detail when editing is in progress.
          visible.push({
            from: node.from,
            to: node.to,
            kind: "mark-marker-muted",
          });
          return;
        }

        const openerLen = tok.embed ? 3 : 2; // "![[" or "[["
        const closerLen = 2; // "]]"
        const contentEnd = node.to - closerLen;

        // Visible range inside the body: display takes precedence over
        // target. Find boundaries within the absolute byte offsets.
        let visibleFrom: number;
        let visibleTo: number;
        if (tok.display !== null) {
          // `display` sits after the body's `|`. The pipe lives inside
          // `[[…]]` past the opener; locate it in absolute coords.
          const pipeRel = raw.indexOf("|", openerLen);
          visibleFrom = node.from + pipeRel + 1;
          visibleTo = contentEnd;
        } else {
          // No display — visible range is the target. Walk from the
          // body start to the first `#` (anchor) or `|` (which can't
          // appear here without a display branch).
          let i = node.from + openerLen;
          while (i < contentEnd) {
            const ch = raw.charCodeAt(i - node.from);
            if (ch === 0x23 /* # */ || ch === 0x7c /* | */) break;
            i++;
          }
          visibleFrom = node.from + openerLen;
          visibleTo = i;
        }

        // Off-cursor: hide everything except the visible range; mark
        // the visible range as resolved / unresolved; add an embed
        // indicator widget for `![[…]]`.
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
        if (tok.embed) {
          // Zero-width widget at the token start.
          visible.push({
            from: node.from,
            to: node.from,
            kind: "mark-wikilink-embed",
          });
        }
        return;
      }
    },
  });

  const out: DecoEntry[] = [...visible];

  if (activeLine >= 1 && activeLine <= doc.lines) {
    const from = doc.line(activeLine).from;
    out.push({ from, to: from, kind: "line-active" });
  }

  for (const m of markers) {
    const onActiveLine = doc.lineAt(m.from).number === activeLine;
    if (onActiveLine) {
      out.push({ from: m.from, to: m.to, kind: "mark-marker-muted" });
    } else {
      out.push({ from: m.from, to: m.to, kind: m.bullet ? "bullet" : "hide" });
    }
  }

  out.sort((a, b) => a.from - b.from || a.to - b.to);
  return out;
}

/** `•` glyph standing in for a hidden bullet-list dash. */
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
const activeLineDeco = Decoration.line({ class: "cm-md-line-active" });
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

/** Small icon glyph standing in for an `![[…]]` embed marker. */
class EmbedIndicatorWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-wikilink-embed";
    span.textContent = "⎘";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  override eq(): boolean {
    return true;
  }
}
const wikilinkEmbedDeco = Decoration.widget({
  widget: new EmbedIndicatorWidget(),
  side: -1,
});

/** Turn the flat entry list into a sorted CM6 `DecorationSet`. */
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
      case "line-active":
        ranges.push(activeLineDeco.range(e.from));
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
      case "mark-wikilink-embed":
        ranges.push(wikilinkEmbedDeco.range(e.from));
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
  const tree = syntaxTree(view.state);
  const head = view.state.selection.main.head;
  const activeLine = view.state.doc.lineAt(head).number;
  const resolver = view.state.facet(wikilinkResolverFacet);
  const entries = collectDecorations(
    tree,
    view.state.doc,
    activeLine,
    resolver ? (t) => resolver.get(t) : undefined,
  );
  const blockIds = findBlockIds(view.state.doc, tree, activeLine);
  return buildDecorationSet([...entries, ...blockIds]);
}

/**
 * Walk the tree and ask the resolver to fetch any uncached targets.
 * The plugin runs this after every rebuild; the resolver dedupes
 * concurrent fetches and notifies via `wikilinkResolverUpdated` when
 * results arrive (which triggers another rebuild that will then paint
 * unresolved warnings).
 */
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
        // Async Lezer parsing can finish after the doc settled.
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

/**
 * Build the block-replace decoration that hides a top-of-file YAML
 * frontmatter block. Empty set when the document has none.
 */
function frontmatterHideSet(doc: Text): DecorationSet {
  const fm = findFrontmatter(doc);
  if (!fm) return Decoration.none;
  return Decoration.set([hideBlockDeco.range(fm.from, fm.to)]);
}

/**
 * Frontmatter hiding lives in a `StateField`, NOT the `ViewPlugin`:
 * CodeMirror rejects block decorations supplied by plugins ("Block
 * decorations may not be specified via plugins") because they change
 * the document layout, which is derived from `EditorState` before
 * plugins run. Kept inside the `livePreviewDecorations` bundle so the
 * raw-source compartment swap reveals the YAML along with everything
 * else. Detected outside the Lezer walk because the markdown grammar
 * reads a YAML preamble as `thematic break + text + thematic break`.
 */
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
  ".cm-md-line-active": { background: "var(--editor-active-line-bg)" },
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
  ".cm-md-wikilink-embed": {
    color: "var(--c-accent)",
    marginRight: "var(--space-1)",
    fontSize: "0.85em",
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

/**
 * The Live Preview extension: the decoration `ViewPlugin` plus the
 * base theme that styles every decoration class. Composed into the
 * editor inside a CM6 `Compartment` (see `Editor.tsx`) so L2 Session E
 * can reconfigure it to a no-op for the raw-source toggle.
 */
export const livePreviewDecorations: Extension = [
  livePreviewPlugin,
  frontmatterHideField,
  decorationBaseTheme,
];
