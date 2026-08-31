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

import { renderGuarded } from "./widgetGuard";

export interface BlockRenderContext {
  language: string;
  state: EditorState;
}

export interface BlockCompletion {
  language: string;
  detail: string;
  aliases?: readonly string[];
}

export interface BlockRenderer {
  id: string;
  languages: readonly string[];
  frameClass: string;
  estimatedHeight?: number;
  completions?: readonly BlockCompletion[];
  active?: (state: EditorState) => boolean;
  revision?: (state: EditorState) => unknown;
  render: (source: string, ctx: BlockRenderContext) => Node;
}

export const blockRendererFacet = Facet.define<
  BlockRenderer,
  readonly BlockRenderer[]
>({
  combine: (values) => values,
});

export const blockRenderersUpdated = StateEffect.define<null>();

export function languageForInfo(infoText: string): string {
  return infoText.trim().toLowerCase().split(/\s+/)[0] ?? "";
}

export interface BlockMatch {
  renderer: BlockRenderer;
  language: string;
}

export function matchRenderer(
  renderers: readonly BlockRenderer[],
  infoText: string,
): BlockMatch | undefined {
  const language = languageForInfo(infoText);
  if (!language) return undefined;
  const renderer = renderers.find((r) => r.languages.includes(language));
  return renderer ? { renderer, language } : undefined;
}

class BlockWidget extends WidgetType {
  constructor(
    private readonly renderer: BlockRenderer,
    private readonly language: string,
    private readonly source: string,
    private readonly revision: unknown,
  ) {
    super();
  }

  override toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement("div");
    frame.className = this.renderer.frameClass;
    frame.appendChild(
      renderGuarded(`\`\`\`${this.language}`, () =>
        this.renderer.render(this.source, {
          language: this.language,
          state: view.state,
        }),
      ),
    );
    return frame;
  }

  override eq(other: BlockWidget): boolean {
    return (
      this.renderer.id === other.renderer.id &&
      this.language === other.language &&
      this.source === other.source &&
      Object.is(this.revision, other.revision)
    );
  }

  override get estimatedHeight(): number {
    return this.renderer.estimatedHeight ?? 60;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export function activeRenderers(state: EditorState): readonly BlockRenderer[] {
  return state
    .facet(blockRendererFacet)
    .filter((r) => r.active?.(state) ?? true);
}

function revisionsOf(
  state: EditorState,
  renderers: readonly BlockRenderer[],
): unknown[] {
  return renderers.map((r) => r.revision?.(state));
}

function sameRevisions(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

function buildDecorations(
  state: EditorState,
  renderers: readonly BlockRenderer[],
): DecorationSet {
  if (renderers.length === 0) return Decoration.none;
  const tree = syntaxTree(state);
  const doc = state.doc;
  const activeLineNumber = doc.lineAt(state.selection.main.head).number;
  const ranges: Range<Decoration>[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      if (!info) return;
      const match = matchRenderer(
        renderers,
        doc.sliceString(info.from, info.to),
      );
      if (!match) return;

      const fromLine = doc.lineAt(node.from);
      const toLine = doc.lineAt(Math.max(node.from, node.to - 1));
      if (
        activeLineNumber >= fromLine.number &&
        activeLineNumber <= toLine.number
      ) {
        return;
      }

      const body = node.node.getChild("CodeText");
      const source = body ? doc.sliceString(body.from, body.to) : "";

      ranges.push(
        Decoration.replace({
          widget: new BlockWidget(
            match.renderer,
            match.language,
            source,
            match.renderer.revision?.(state),
          ),
          block: true,
        }).range(fromLine.from, toLine.to),
      );
    },
  });

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

export interface BlockRenderState {
  deco: DecorationSet;
  renderers: readonly BlockRenderer[];
  revisions: unknown[];
}

function stateFor(state: EditorState): BlockRenderState {
  const renderers = activeRenderers(state);
  return {
    deco: buildDecorations(state, renderers),
    renderers,
    revisions: revisionsOf(state, renderers),
  };
}

export const blockRenderersField = StateField.define<BlockRenderState>({
  create: (state) => stateFor(state),
  update: (prev, tr) => {
    const renderers = activeRenderers(tr.state);
    const revisions = revisionsOf(tr.state, renderers);
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const activeLineChanged =
      tr.startState.doc.lineAt(tr.startState.selection.main.head).number !==
      tr.state.doc.lineAt(tr.state.selection.main.head).number;
    const renderersChanged =
      prev.renderers.length !== renderers.length ||
      prev.renderers.some((r, i) => r !== renderers[i]);
    const invalidated = tr.effects.some((e) => e.is(blockRenderersUpdated));

    if (
      !tr.docChanged &&
      !treeChanged &&
      !activeLineChanged &&
      !renderersChanged &&
      !invalidated &&
      sameRevisions(prev.revisions, revisions)
    ) {
      return prev;
    }

    return {
      deco: buildDecorations(tr.state, renderers),
      renderers,
      revisions,
    };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of(
      (view) => view.state.field(f, false)?.deco ?? Decoration.none,
    ),
  ],
});

export const blockRenderersBaseTheme = EditorView.baseTheme({
  ".cm-block-frame": {
    margin: "var(--space-2) 0",
    padding: "var(--space-2)",
    border: "1px solid var(--c-border-subtle)",
    borderRadius: "var(--radius-md)",
    background: "var(--c-bg-secondary)",
    overflow: "auto",
  },
});

export function blockRenderers(...renderers: BlockRenderer[]): Extension {
  return renderers.map((r) => blockRendererFacet.of(r));
}
