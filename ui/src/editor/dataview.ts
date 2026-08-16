import { EditorView } from "@codemirror/view";
import { Facet, StateEffect, type EditorState } from "@codemirror/state";

import {
  dataviewQuery as defaultDataviewQuery,
  type DataviewQueryRequest,
  type DataviewResult,
} from "../api/ipc";
import { renderDataview } from "../dataview/dataviewRender";
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

