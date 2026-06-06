/**
 * Live-Preview embed widget (L3 Session H.2, spec §2.8).
 *
 * Walks the Lezer tree for every `WikiLink` node whose raw source is an
 * embed token (`![[…]]`) and emits TWO decorations per token (the
 * proven CM6 embed pattern):
 *
 *   1. An atomic INLINE replace over the token's byte span `[node.from,
 *      node.to)` hides the raw `![[…]]` text. No widget, no height, so
 *      it's valid over a sub-line range and CM6 steps the cursor over
 *      it as a single unit. (A `block: true` replace over a sub-line
 *      range is malformed — block decorations must cover whole lines —
 *      and was the bug #6 cursor-jump.)
 *   2. A BLOCK widget at the host line's end renders the embed card
 *      below the line. Block widgets measure their own DOM height, so
 *      the card always reserves space. (An inline-replace *widget* left
 *      block content unmeasured → "embeds invisible until you click".)
 *
 * Cursor-line suppression: when the cursor is on the embed's host
 * line, neither decoration is emitted — the raw `![[…]]` text stays
 * visible for direct editing. Matches the established Live Preview
 * pattern for Emphasis and Link.
 *
 * The field (a `StateField`) rebuilds on doc / tree changes, the
 * `embedResolverUpdated` `StateEffect`, facet swaps, and active-line
 * changes (the suppression trigger).
 *
 * Resolver and open-note-path live in Facets so a vault swap (handled
 * by `Compartment.reconfigure` in `Editor.tsx`) flows the new resolver
 * and seed-chain entry to the widget without rebuilding the editor.
 */

import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { scanWikilinks } from "../ast/wikilink";
import type { EmbedResolver } from "./embedResolver";
import { renderEmbedBody } from "./embedRender";

/**
 * Per-editor embed resolver supplied via {@link embedResolverFacet}.
 * `null` when no vault is open — the field emits no widgets in that
 * case (rather than rendering a forest of loading placeholders).
 */
export const embedResolverFacet = Facet.define<
  EmbedResolver | null,
  EmbedResolver | null
>({
  combine: (values) => values[0] ?? null,
});

/**
 * Open-note absolute vault-relative path (e.g. `notes/Daily.md`), so
 * the renderer can seed the cycle chain with the host note. `null`
 * when no note is selected (top-level embeds still render; only
 * self-embeds inside the open note rely on this seed).
 */
export const openNotePathFacet = Facet.define<string | null, string | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * StateEffect dispatched by `Editor.tsx` whenever the resolver's cache
 * changes. The StateField watches transactions for this effect and
 * rebuilds.
 */
export const embedResolverUpdated = StateEffect.define<null>();

/** Reconstruct the wiki-link `target_raw` cache key from a tokenized run. */
function targetRawOf(
  tok: Extract<ReturnType<typeof scanWikilinks>[number], { kind: "wiki_link" }>,
): string {
  if (tok.anchor === null) return tok.target;
  const prefix = tok.anchor.kind === "block" ? "#^" : "#";
  return `${tok.target}${prefix}${tok.anchor.value}`;
}

class EmbedWidget extends WidgetType {
  constructor(
    private readonly resolver: EmbedResolver,
    private readonly targetRaw: string,
    private readonly openNotePath: string | null,
    // Folded into `eq()` identity. The resolver's `version()` bumps on
    // every cache mutation anywhere — including nested embeds resolved
    // deep in `toDOM()`'s recursive render. Keying identity on the
    // version (rather than only this target's own cache entry) means a
    // descendant resolution forces a remount, so nested `Loading…`
    // placeholders clear (closes bug #5). The version is stable across
    // unrelated edits (no cache mutation → no remount on keystroke).
    private readonly version: number,
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const frame = document.createElement("div");
    frame.className = "cm-md-embed-frame";
    const seedChain = this.openNotePath === null ? [] : [this.openNotePath];
    frame.appendChild(
      renderEmbedBody({
        resolver: this.resolver,
        targetRaw: this.targetRaw,
        chain: seedChain,
      }),
    );
    return frame;
  }

  override eq(other: EmbedWidget): boolean {
    return (
      this.targetRaw === other.targetRaw &&
      this.openNotePath === other.openNotePath &&
      this.version === other.version
    );
  }

  override get estimatedHeight(): number {
    // Block widgets reserve this much vertical space before CM6
    // measures the real DOM height. A rough card-height guess keeps
    // scroll math sane on first paint; CM6 re-measures on layout.
    return 60;
  }

  // Let click events on the widget bubble to the capture-phase
  // mousedown handler in Editor.tsx (which routes wiki-link clicks).
  override ignoreEvent(_event: Event): boolean {
    return false;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const resolver = state.facet(embedResolverFacet);
  if (!resolver) return Decoration.none;
  const openNotePath = state.facet(openNotePathFacet);
  const tree = syntaxTree(state);
  const doc = state.doc;
  const head = state.selection.main.head;
  const activeLineNumber = doc.lineAt(head).number;
  const ranges: Range<Decoration>[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== "WikiLink") return;
      const raw = doc.sliceString(node.from, node.to);
      const tok = scanWikilinks(raw).find((t) => t.kind === "wiki_link");
      if (!tok || tok.kind !== "wiki_link" || !tok.embed) return;
      const line = doc.lineAt(node.from);
      // Cursor-line suppression: when the cursor sits on the embed's
      // host line, expose the raw `![[…]]` text for editing — matches
      // the established Live Preview pattern for Emphasis / Link.
      if (line.number === activeLineNumber) return;
      const targetRaw = targetRawOf(tok);
      const widget = new EmbedWidget(
        resolver,
        targetRaw,
        openNotePath,
        resolver.version(),
      );
      // Two-decoration block model (the proven CM6 embed pattern):
      //
      //   1. An atomic INLINE replace over the token's byte span hides
      //      the raw `![[…]]` text. No widget, no height — valid over a
      //      sub-line range, and CM6 steps the cursor over it as one
      //      unit (keeps bug #6 fixed; a `block: true` replace over a
      //      sub-line range would be a malformed block decoration).
      //   2. A BLOCK widget at the host line's end renders the embed
      //      card below the line. Block widgets measure their own DOM
      //      height, so the card is never clipped/invisible — the
      //      inline-replace-only model left block content unmeasured
      //      ("embeds invisible until you click").
      //
      // Sorted by `from` below: the inline hide (node.from) precedes
      // the block widget (line.to).
      ranges.push(Decoration.replace({}).range(node.from, node.to));
      ranges.push(
        Decoration.widget({ widget, block: true, side: 1 }).range(line.to),
      );
    },
  });

  // CM6 requires the range set sorted by `from`, then by side.
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

/**
 * The field-managed decoration set. Rebuilds on:
 *   - doc changes (text edits)
 *   - tree changes (async Lezer parse completion)
 *   - the `embedResolverUpdated` effect (cache mutated)
 *   - any facet change reaching it (vault swap via Compartment)
 *
 * Widget identity (`EmbedWidget.eq`) folds in the resolver's
 * `version()`, which bumps on every cache mutation anywhere. A rebuild
 * with an unchanged version reuses the existing DOM (so plain edits
 * don't tear embeds down); any resolution change — including a *nested*
 * embed deep in the recursive render — bumps the version, so `eq()`
 * returns false and the widget remounts, picking up the freshly
 * resolved descendant. This is what closes bug #5: keying identity on
 * only the top-level cache entry left nested `Loading…` placeholders
 * frozen because the parent's entry never changed when a child
 * resolved.
 */
export const embedBlockField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    const resolverChanged = tr.effects.some((e) => e.is(embedResolverUpdated));
    const treeChanged =
      syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const facetChanged =
      tr.startState.facet(embedResolverFacet) !==
        tr.state.facet(embedResolverFacet) ||
      tr.startState.facet(openNotePathFacet) !==
        tr.state.facet(openNotePathFacet);
    // Cursor-line suppression (Contract 2): when the active line flips
    // onto or off the embed's host line, the decoration set must
    // rebuild to surface or hide the raw `![[…]]` token bytes.
    const activeLineChanged =
      tr.startState.doc.lineAt(tr.startState.selection.main.head).number !==
      tr.state.doc.lineAt(tr.state.selection.main.head).number;
    if (
      !tr.docChanged &&
      !treeChanged &&
      !resolverChanged &&
      !facetChanged &&
      !activeLineChanged
    ) {
      return deco;
    }
    return buildDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const embedBaseTheme = EditorView.baseTheme({
  ".cm-md-embed-frame": {
    margin: "var(--space-2) 0",
    padding: "var(--space-2) var(--space-3)",
    borderLeft: "var(--space-1) solid var(--c-accent)",
    background: "var(--c-bg-secondary)",
    borderRadius: "var(--radius-sm)",
    fontSize: "0.95em",
  },
  ".cm-md-embed-body": {
    whiteSpace: "pre-wrap",
    color: "var(--c-fg-secondary)",
  },
  ".cm-md-embed-placeholder": {
    color: "var(--c-fg-muted)",
    fontStyle: "italic",
  },
  ".cm-md-embed-placeholder-unresolved, .cm-md-embed-placeholder-missing-anchor":
    {
      color: "var(--c-warning, var(--c-fg-muted))",
    },
  ".cm-md-embed-loading": {
    color: "var(--c-fg-muted)",
    fontStyle: "italic",
  },
  ".cm-md-embed-link": {
    color: "var(--c-accent)",
    textDecoration: "underline dashed",
  },
});

export const embedExtension: Extension = [embedBlockField, embedBaseTheme];
