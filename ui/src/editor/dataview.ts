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

import {
  dataviewQuery as defaultDataviewQuery,
  type DataviewQueryRequest,
  type DataviewResult,
} from "../api/ipc";
import { renderDataview } from "../dataview/dataviewRender";

const QUERY_INFO = "query";

export interface DataviewRunner {
  get(source: string): DataviewResult | undefined;
  fetch(source: string): void;
  invalidate(): void;
  onUpdate(handler: () => void): () => void;
  version(): number;
  open(path: string): void;
}

export function createDataviewRunner(
  vaultId: string,
  onOpen: (path: string) => void,
  ipc: (req: DataviewQueryRequest) => Promise<DataviewResult> = defaultDataviewQuery,
): DataviewRunner {
  const cache = new Map<string, DataviewResult>();
  const inFlight = new Set<string>();
  const subscribers = new Set<() => void>();
  let cacheVersion = 0;

  const notify = () => {
    for (const fn of subscribers) fn();
  };

  const errorResult = (err: unknown): DataviewResult => ({
    kind: "error",
    message: err instanceof Error ? err.message : String(err),
  });

  const settle = (source: string, result: DataviewResult, notifyAlways: boolean) => {
    const prev = cache.get(source);
    const changed = prev === undefined || JSON.stringify(prev) !== JSON.stringify(result);
    cache.set(source, result);
    if (notifyAlways || changed) {
      cacheVersion++;
      notify();
    }
  };

  const run = (source: string, notifyAlways: boolean) => {
    inFlight.add(source);
    ipc({ vault_id: vaultId, source })
      .then((result) => settle(source, result, notifyAlways))
      .catch((err: unknown) => settle(source, errorResult(err), notifyAlways))
      .finally(() => {
        inFlight.delete(source);
      });
  };

  return {
    get(source) {
      return cache.get(source);
    },
    fetch(source) {
      if (cache.has(source) || inFlight.has(source)) return;
      run(source, true);
    },
    invalidate() {
      for (const source of [...cache.keys()]) {
        if (inFlight.has(source)) continue;
        run(source, false);
      }
    },
    onUpdate(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    version() {
      return cacheVersion;
    },
    open(path) {
      onOpen(path);
    },
  };
}

export const dataviewRunnerFacet = Facet.define<
  DataviewRunner | null,
  DataviewRunner | null
>({
  combine: (values) => values[0] ?? null,
});

export const dataviewRunnerUpdated = StateEffect.define<null>();

class DataviewWidget extends WidgetType {
  constructor(
    private readonly runner: DataviewRunner,
    private readonly source: string,
    private readonly version: number,
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const frame = document.createElement("div");
    frame.className = "cm-dataview-frame";
    const result = this.runner.get(this.source);
    if (result === undefined) {
      this.runner.fetch(this.source);
      const loading = document.createElement("div");
      loading.className = "cm-dataview-loading";
      loading.textContent = "Loading…";
      frame.appendChild(loading);
      return frame;
    }
    frame.appendChild(renderDataview(result));
    return frame;
  }

  override eq(other: DataviewWidget): boolean {
    return this.source === other.source && this.version === other.version;
  }

  override get estimatedHeight(): number {
    return 60;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const runner = state.facet(dataviewRunnerFacet);
  if (!runner) return Decoration.none;
  const tree = syntaxTree(state);
  const doc = state.doc;
  const head = state.selection.main.head;
  const activeLineNumber = doc.lineAt(head).number;
  const ranges: Range<Decoration>[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      if (!info) return;
      const infoText = doc.sliceString(info.from, info.to).trim().toLowerCase();
      if (infoText !== QUERY_INFO) return;

      const fromLine = doc.lineAt(node.from);
      const toLine = doc.lineAt(Math.max(node.from, node.to - 1));
      if (
        activeLineNumber >= fromLine.number &&
        activeLineNumber <= toLine.number
      ) {
        return;
      }

      const body = node.node.getChild("CodeText");
      const source = body
        ? doc.sliceString(body.from, body.to).trim()
        : "";

      const widget = new DataviewWidget(runner, source, runner.version());
      ranges.push(
        Decoration.replace({ widget, block: true }).range(
          fromLine.from,
          toLine.to,
        ),
      );
    },
  });

  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

export const dataviewBlockField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    const runnerChanged = tr.effects.some((e) => e.is(dataviewRunnerUpdated));
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const facetChanged =
      tr.startState.facet(dataviewRunnerFacet) !==
      tr.state.facet(dataviewRunnerFacet);
    const activeLineChanged =
      tr.startState.doc.lineAt(tr.startState.selection.main.head).number !==
      tr.state.doc.lineAt(tr.state.selection.main.head).number;
    if (
      !tr.docChanged &&
      !treeChanged &&
      !runnerChanged &&
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

export const dataviewBaseTheme = EditorView.baseTheme({
  ".cm-dataview-frame": {
    margin: "var(--space-2) 0",
    padding: "var(--space-2) var(--space-3)",
    background: "var(--c-bg-secondary)",
    borderRadius: "var(--radius-sm)",
    fontSize: "0.95em",
  },
  ".cm-dataview-loading": {
    color: "var(--c-fg-muted)",
    fontStyle: "italic",
  },
  ".cq-dataview-error": {
    color: "var(--c-warning, var(--c-fg-muted))",
  },
  ".cq-dataview-list": {
    margin: "0",
    paddingLeft: "var(--space-4)",
  },
  ".cq-dataview-link": {
    color: "var(--c-accent)",
    cursor: "pointer",
  },
  ".cq-dataview-table": {
    borderCollapse: "collapse",
    width: "100%",
  },
  ".cq-dataview-table th, .cq-dataview-table td": {
    border: "1px solid var(--c-border-subtle)",
    padding: "var(--space-1) var(--space-2)",
    textAlign: "left",
  },
  ".cq-dataview-count": {
    fontWeight: "600",
  },
});

export const dataviewExtension: Extension = [
  dataviewBlockField,
  dataviewBaseTheme,
];
