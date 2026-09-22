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

import { offActiveLine } from "./decorationField";
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

function collectBlocks(
  state: EditorState,
  renderers: readonly BlockRenderer[],
): Range<Decoration>[] {
  if (renderers.length === 0) return [];
  const tree = syntaxTree(state);
  const doc = state.doc;
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

  return ranges;
}

export interface BlockRenderState {
  ranges: readonly Range<Decoration>[];
  activeLine: number;
  deco: DecorationSet;
  renderers: readonly BlockRenderer[];
  revisions: unknown[];
}

const activeLineOf = (state: EditorState): number =>
  state.doc.lineAt(state.selection.main.head).number;

function stateFor(
  state: EditorState,
  renderers: readonly BlockRenderer[] = activeRenderers(state),
  revisions: unknown[] = revisionsOf(state, renderers),
): BlockRenderState {
  const ranges = collectBlocks(state, renderers);
  return {
    ranges,
    activeLine: activeLineOf(state),
    deco: offActiveLine(state, ranges),
    renderers,
    revisions,
  };
}

export const blockRenderersField = StateField.define<BlockRenderState>({
  create: (state) => stateFor(state),
  update: (prev, tr) => {
    const renderers = activeRenderers(tr.state);
    const revisions = revisionsOf(tr.state, renderers);
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const renderersChanged =
      prev.renderers.length !== renderers.length ||
      prev.renderers.some((r, i) => r !== renderers[i]);
    const invalidated = tr.effects.some((e) => e.is(blockRenderersUpdated));

    if (
      tr.docChanged ||
      treeChanged ||
      renderersChanged ||
      invalidated ||
      !sameRevisions(prev.revisions, revisions)
    ) {
      return stateFor(tr.state, renderers, revisions);
    }

    const activeLine = activeLineOf(tr.state);
    if (activeLine === prev.activeLine) return prev;
    return {
      ...prev,
      activeLine,
      deco: offActiveLine(tr.state, prev.ranges),
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
