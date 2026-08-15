import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { mathEnabledFacet, renderMath } from "./math";

const FENCE = "$$";

export interface DisplayMathRegion {
  from: number;
  to: number;
  source: string;
}

interface ScannedLine {
  text: string;
  trimmed: string;
  from: number;
  to: number;
}

function scanLines(text: string): ScannedLine[] {
  const out: ScannedLine[] = [];
  let from = 0;
  for (const text_ of text.split("\n")) {
    out.push({
      text: text_,
      trimmed: text_.trim(),
      from,
      to: from + text_.length,
    });
    from += text_.length + 1;
  }
  return out;
}

export function scanDisplayMath(text: string): DisplayMathRegion[] {
  const regions: DisplayMathRegion[] = [];
  const lines = scanLines(text);

  let i = 0;
  while (i < lines.length) {
    const open = lines[i];
    if (!open || !open.trimmed.startsWith(FENCE)) {
      i += 1;
      continue;
    }

    const singleLine =
      open.trimmed.length >= FENCE.length * 2 &&
      open.trimmed.endsWith(FENCE) &&
      open.trimmed !== FENCE;
    if (singleLine) {
      const inner = open.trimmed.slice(FENCE.length, -FENCE.length);
      if (inner.trim()) {
        regions.push({ from: open.from, to: open.to, source: inner });
        i += 1;
        continue;
      }
    }

    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (candidate && candidate.trimmed.endsWith(FENCE)) {
        close = j;
        break;
      }
    }
    const closeLine = close === -1 ? undefined : lines[close];
    if (!closeLine) {
      i += 1;
      continue;
    }

    const head = open.trimmed.slice(FENCE.length);
    const tail = closeLine.trimmed.slice(
      0,
      closeLine.trimmed.length - FENCE.length,
    );
    const middle = lines.slice(i + 1, close).map((l) => l.text);
    const source = [head, ...middle, tail].join("\n");

    if (source.trim()) {
      regions.push({ from: open.from, to: closeLine.to, source });
    }
    i = close + 1;
  }

  return regions;
}

function codeRanges(state: EditorState): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "FencedCode" || node.name === "CodeBlock") {
        ranges.push([node.from, node.to]);
      }
    },
  });
  return ranges;
}

class DisplayMathWidget extends WidgetType {
  constructor(private readonly source: string) {
    super();
  }

  override toDOM(): HTMLElement {
    const frame = document.createElement("div");
    frame.className = "cm-block-frame cm-math-frame";
    frame.appendChild(renderMath(this.source, { displayMode: true }));
    return frame;
  }

  override eq(other: DisplayMathWidget): boolean {
    return this.source === other.source;
  }

  override get estimatedHeight(): number {
    return 48;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  if (!state.facet(mathEnabledFacet)) return Decoration.none;
  const doc = state.doc;
  const head = state.selection.main.head;
  const excluded = codeRanges(state);
  const ranges: Range<Decoration>[] = [];

  for (const region of scanDisplayMath(doc.toString())) {
    if (excluded.some(([from, to]) => region.from < to && from < region.to)) {
      continue;
    }
    if (head >= region.from && head <= region.to) continue;
    ranges.push(
      Decoration.replace({
        widget: new DisplayMathWidget(region.source),
        block: true,
      }).range(region.from, region.to),
    );
  }

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

export const displayMathField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const headMoved =
      tr.startState.selection.main.head !== tr.state.selection.main.head;
    const enabledChanged =
      tr.startState.facet(mathEnabledFacet) !== tr.state.facet(mathEnabledFacet);
    if (!tr.docChanged && !treeChanged && !headMoved && !enabledChanged) {
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

export const displayMathExtension: Extension = [displayMathField];
