import { EditorView } from "@codemirror/view";
import { Facet, StateEffect, type EditorState } from "@codemirror/state";

import {
  dataviewQuery as defaultDataviewQuery,
  type DataviewQueryRequest,
  type DataviewResult,
} from "../api/ipc";
import { renderDataview } from "../dataview/dataviewRender";
import { createKeyedResolver } from "./keyedResolver";
import type { BlockRenderer } from "./blockRenderers";

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
  const inner = createKeyedResolver<string, DataviewResult>({
    cacheKey: (source) => source,
    load: (source) => ipc({ vault_id: vaultId, source }),
    onFailure: (err) => ({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    }),
    invalidation: "refetch",
    same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  return {
    get: (source) => inner.get(source),
    fetch: (source) => inner.fetch(source),
    invalidate: () => inner.invalidate(),
    onUpdate: (handler) => inner.onUpdate(handler),
    version: () => inner.version(),
    open: (path) => onOpen(path),
  };
}

export const dataviewRunnerFacet = Facet.define<
  DataviewRunner | null,
  DataviewRunner | null
>({
  combine: (values) => values[0] ?? null,
});

export const dataviewRunnerUpdated = StateEffect.define<null>();

const runnerIds = new WeakMap<DataviewRunner, number>();
let nextRunnerId = 0;

function runnerIdentity(runner: DataviewRunner): number {
  let id = runnerIds.get(runner);
  if (id === undefined) {
    id = nextRunnerId++;
    runnerIds.set(runner, id);
  }
  return id;
}

export const dataviewBlockRenderer: BlockRenderer = {
  id: "dataview",
  languages: ["query"],
  frameClass: "cm-dataview-frame",
  completions: [{ language: "query", detail: "Dataview query" }],
  active: (state) => state.facet(dataviewRunnerFacet) !== null,
  revision: (state: EditorState) => {
    const runner = state.facet(dataviewRunnerFacet);
    return runner ? `${runnerIdentity(runner)}:${runner.version()}` : null;
  },
  render: (source, ctx) => {
    const runner = ctx.state.facet(dataviewRunnerFacet);
    const query = source.trim();
    if (!runner) return document.createDocumentFragment();
    const result = runner.get(query);
    if (result === undefined) {
      runner.fetch(query);
      const loading = document.createElement("div");
      loading.className = "cm-dataview-loading";
      loading.textContent = "Loading…";
      return loading;
    }
    return renderDataview(result);
  },
};

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
  ".cq-dataview-scroll": {
    maxWidth: "100%",
    overflowX: "auto",
  },
  ".cq-dataview-table": {
    borderCollapse: "collapse",
    width: "max-content",
    minWidth: "100%",
  },
  ".cq-dataview-table th, .cq-dataview-table td": {
    border: "1px solid var(--c-border-subtle)",
    padding: "var(--space-1) var(--space-2)",
    textAlign: "left",
    verticalAlign: "top",
    whiteSpace: "pre-wrap",
    maxWidth: "24rem",
  },
  ".cq-dataview-table th": {
    background: "var(--c-bg-secondary)",
    fontWeight: "600",
  },
  ".cq-dataview-count": {
    fontWeight: "600",
  },
});

