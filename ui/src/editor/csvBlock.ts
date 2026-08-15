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

import { renderDelimitedTable } from "../viewer/render";

const DELIMITER_BY_INFO: Record<string, string> = {
  csv: ",",
  tsv: "\t",
};

class CsvBlockWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly delimiter: string,
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const frame = document.createElement("div");
    frame.className = "cm-csv-frame";
    frame.appendChild(renderDelimitedTable(this.source, this.delimiter));
    return frame;
  }

  override eq(other: CsvBlockWidget): boolean {
    return (
      this.source === other.source && this.delimiter === other.delimiter
    );
  }

  override get estimatedHeight(): number {
    return 60;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export function delimiterForInfo(infoText: string): string | undefined {
  return DELIMITER_BY_INFO[infoText.trim().toLowerCase()];
}

function buildDecorations(state: EditorState): DecorationSet {
  const tree = syntaxTree(state);
  const doc = state.doc;
  const activeLineNumber = doc.lineAt(state.selection.main.head).number;
  const ranges: Range<Decoration>[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      if (!info) return;
      const delimiter = delimiterForInfo(doc.sliceString(info.from, info.to));
      if (delimiter === undefined) return;

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
          widget: new CsvBlockWidget(source, delimiter),
          block: true,
        }).range(fromLine.from, toLine.to),
      );
    },
  });

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

export const csvBlockField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const activeLineChanged =
      tr.startState.doc.lineAt(tr.startState.selection.main.head).number !==
      tr.state.doc.lineAt(tr.state.selection.main.head).number;
    if (!tr.docChanged && !treeChanged && !activeLineChanged) return deco;
    return buildDecorations(tr.state);
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of(
      (view) => view.state.field(f, false) ?? Decoration.none,
    ),
  ],
});

export const csvBlockBaseTheme = EditorView.baseTheme({
  ".cm-csv-frame": {
    margin: "var(--space-2) 0",
    padding: "var(--space-2)",
    border: "1px solid var(--c-border-subtle)",
    borderRadius: "var(--radius-md)",
    background: "var(--c-bg-secondary)",
    overflow: "auto",
  },
});

export function csvBlockExtension(): Extension {
  return [csvBlockField, csvBlockBaseTheme];
}
