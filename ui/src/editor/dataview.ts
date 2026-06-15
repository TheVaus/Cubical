/**
 * Live-Preview widget for ```query blocks (L4-D).
 *
 * Walks the Lezer tree for every `FencedCode` node whose info string is
 * `query`, and replaces the whole fenced block with an atomic BLOCK
 * widget rendering the dataview result. Cursor-line suppression: when the
 * cursor sits inside the block, the raw fence source is shown for
 * editing — the same Live-Preview convention the embed widget uses.
 *
 * Mirrors `embed.ts` structurally: a {@link dataviewRunnerFacet} supplies
 * the async runner + the note-open callback to the decoration
 * `StateField`; an `onUpdate` subscription in `Editor.tsx` dispatches the
 * {@link dataviewRunnerUpdated} `StateEffect` to trigger rebuilds.
 *
 * The query is evaluated off the editor thread via the `dataview_query`
 * IPC; results (including the `error` variant for a bad query) are cached
 * by the runner keyed on the trimmed block source. This widget is
 * operator-smoke verified (Contract E) — the tested logic lives in the
 * pure `dataviewRender.ts` and `createDataviewRunner` below.
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

import {
  dataviewQuery as defaultDataviewQuery,
  type DataviewQueryRequest,
  type DataviewResult,
} from "../api/ipc";
import { renderDataview } from "../dataview/dataviewRender";

/** Info string that marks a fenced block as a dataview query. */
const QUERY_INFO = "query";

/**
 * Per-vault async runner + note-open callback for ```query blocks.
 * Caches results keyed on the trimmed block source, dedupes concurrent
 * fetches, and notifies subscribers when the cache changes.
 */
export interface DataviewRunner {
  /** Sync lookup. `undefined` for sources not yet fetched. */
  get(source: string): DataviewResult | undefined;
  /** Kick off (or skip if pending/cached) an async evaluation. */
  fetch(source: string): void;
  /** Drop the cache and notify subscribers (e.g. on vault content change). */
  invalidate(): void;
  /** Subscribe to cache-change notifications. Returns unsubscribe. */
  onUpdate(handler: () => void): () => void;
  /** Monotonic counter bumped on every cache mutation; folded into widget identity. */
  version(): number;
  /** Open a note by vault-relative path (a result link was clicked). */
  open(path: string): void;
}

/**
 * Build a runner bound to one vault. `onOpen` routes note-link clicks to
 * the host app's navigation; `ipc` is injectable for tests.
 */
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

  // Store a settled result. `notifyAlways` is true for a first fetch (the
  // widget must remount to clear "Loading…"); for an invalidate refetch
  // it's false, so only a *changed* result bumps the version + notifies —
  // an unchanged result leaves the rendered block untouched (no flicker).
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
      // Stale-while-revalidate: keep showing the last result and re-fetch
      // every known source in place. Only a changed result triggers a
      // remount, so an unrelated vault change doesn't flash every ```query
      // block back to "Loading…" (the L4 layer-close smoke flicker).
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

/**
 * Per-editor runner supplied via the facet. `null` when no vault is open
 * — the field emits no widgets in that case.
 */
export const dataviewRunnerFacet = Facet.define<
  DataviewRunner | null,
  DataviewRunner | null
>({
  combine: (values) => values[0] ?? null,
});

/**
 * Dispatched by `Editor.tsx` whenever the runner's cache changes. The
 * StateField watches transactions for this effect and rebuilds.
 */
export const dataviewRunnerUpdated = StateEffect.define<null>();

class DataviewWidget extends WidgetType {
  constructor(
    private readonly runner: DataviewRunner,
    private readonly source: string,
    // Folded into `eq()` so any cache mutation forces a remount, clearing
    // the "Loading…" placeholder once the result settles.
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
    // Let the widget handle its own click events (note-link navigation).
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
      // Cursor-line suppression: when the cursor sits inside the block,
      // expose the raw fence source for editing.
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

/**
 * The field-managed decoration set. Rebuilds on doc/tree changes, the
 * `dataviewRunnerUpdated` effect, facet swaps, and active-line changes
 * (the cursor-suppression trigger). Widget identity folds in the
 * runner's `version()`, so a settled query remounts to clear "Loading…".
 */
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
    border: "1px solid var(--c-border, var(--c-bg-tertiary))",
    padding: "var(--space-1) var(--space-2)",
    textAlign: "left",
  },
  ".cq-dataview-count": {
    fontWeight: "600",
  },
});

/** The dataview live-preview extension: block field + theme. */
export const dataviewExtension: Extension = [
  dataviewBlockField,
  dataviewBaseTheme,
];
