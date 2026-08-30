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
import { renderGuarded } from "./widgetGuard";

export const embedResolverFacet = Facet.define<
  EmbedResolver | null,
  EmbedResolver | null
>({
  combine: (values) => values[0] ?? null,
});

export const openNotePathFacet = Facet.define<string | null, string | null>({
  combine: (values) => values[0] ?? null,
});

export const embedResolverUpdated = StateEffect.define<null>();

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
    private readonly version: number,
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const frame = document.createElement("div");
    frame.className = "cm-md-embed-frame";
    const seedChain = this.openNotePath === null ? [] : [this.openNotePath];
    frame.appendChild(
      renderGuarded(`![[${this.targetRaw}]]`, () =>
        renderEmbedBody({
          resolver: this.resolver,
          targetRaw: this.targetRaw,
          chain: seedChain,
        }),
      ),
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
    return 60;
  }

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
      if (line.text.trim() !== raw.trim()) return;
      if (line.number === activeLineNumber) return;
      const targetRaw = targetRawOf(tok);
      const widget = new EmbedWidget(
        resolver,
        targetRaw,
        openNotePath,
        resolver.version(),
      );
      ranges.push(
        Decoration.replace({ widget, block: true }).range(line.from, line.to),
      );
    },
  });

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

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
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of(
      (view) => view.state.field(f, false) ?? Decoration.none,
    ),
  ],
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
