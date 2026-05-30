/**
 * Live-Preview embed widget (L3 Session H.2, spec §2.8).
 *
 * Walks the Lezer tree for every `WikiLink` node whose raw source is an
 * embed token (`![[…]]`) and emits one block-widget decoration per
 * token, attached at the end of the token's *line* with `side: 1`. The
 * widget mounts a frame and asks `renderEmbedBody` to fill it.
 *
 * Block decorations can only come from a `StateField` (CM6 forbids
 * them in `ViewPlugin`s). The field rebuilds on doc / tree changes
 * and on the `embedResolverUpdated` `StateEffect` — that effect is
 * dispatched by `Editor.tsx`'s `onUpdate` subscription whenever the
 * `EmbedResolver` cache changes (fetch completion or `invalidate()`).
 *
 * Resolver and open-note-path live in Facets so a vault swap (handled
 * by `Compartment.reconfigure` in `Editor.tsx`) flows the new resolver
 * and seed-chain entry to the widget without rebuilding the editor.
 *
 * The inline `mark-wikilink-embed` `⎘` glyph in `decorations.ts` is
 * unchanged — it stays as a marker on the source token; this widget
 * adds the *content* below.
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
import type { EmbedResolver, EmbedResolution } from "./embedResolver";
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

class EmbedBlockWidget extends WidgetType {
  constructor(
    private readonly resolver: EmbedResolver,
    private readonly targetRaw: string,
    private readonly openNotePath: string | null,
    // Carried purely for `eq()` identity — the resolver replaces this
    // entry reference via `cache.set` on fetch completion, so reference
    // equality cleanly distinguishes "same state" from "needs remount"
    // without diffing widget innards. The renderer inside `toDOM()`
    // still reads the live resolver; this field is identity-only.
    private readonly entry: EmbedResolution | undefined,
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

  override eq(other: EmbedBlockWidget): boolean {
    return (
      this.targetRaw === other.targetRaw &&
      this.openNotePath === other.openNotePath &&
      this.entry === other.entry
    );
  }

  override get estimatedHeight(): number {
    // Best-effort guess so CM6's scroll calculations don't thrash; the
    // widget rerenders on resolver updates and CM6 will measure for
    // real on layout.
    return 60;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const resolver = state.facet(embedResolverFacet);
  if (!resolver) return Decoration.none;
  const openNotePath = state.facet(openNotePathFacet);
  const tree = syntaxTree(state);
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== "WikiLink") return;
      const raw = doc.sliceString(node.from, node.to);
      const tok = scanWikilinks(raw).find((t) => t.kind === "wiki_link");
      if (!tok || tok.kind !== "wiki_link" || !tok.embed) return;
      const line = doc.lineAt(node.from);
      const targetRaw = targetRawOf(tok);
      const widget = new EmbedBlockWidget(
        resolver,
        targetRaw,
        openNotePath,
        resolver.get(targetRaw),
      );
      ranges.push(
        Decoration.widget({
          widget,
          block: true,
          side: 1,
        }).range(line.to),
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
 * Widget identity is anchored to each target's resolver cache *entry*
 * reference (see `EmbedBlockWidget.eq`). When a rebuild produces a
 * widget whose entry reference matches its predecessor's, CM6 reuses
 * the existing DOM; when the resolver flips the entry via `cache.set`
 * on fetch completion, the new widget's `eq()` returns false and the
 * DOM is remounted. This means unrelated edits (or sibling-embed
 * fetches) don't tear down embeds that haven't actually changed.
 */
const embedBlockField = StateField.define<DecorationSet>({
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
    if (
      !tr.docChanged &&
      !treeChanged &&
      !resolverChanged &&
      !facetChanged
    ) {
      return deco;
    }
    return buildDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const embedBaseTheme = EditorView.baseTheme({
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
