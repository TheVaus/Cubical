import type { Backlink } from "../api/ipc";
import { stabilizeByKey } from "../listStability";

export function backlinkKey(b: Backlink): string {
  return `${b.source_path}@${b.position}`;
}

export function basenameWithoutExtension(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  if (base.endsWith(".md")) return base.slice(0, -3);
  return base;
}

export type BacklinksViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; backlinks: Backlink[] }
  | { kind: "error"; message: string };

export type BacklinksAction =
  | { type: "fetch:start" }
  | { type: "refresh:start" }
  | { type: "fetch:success"; backlinks: Backlink[] }
  | { type: "fetch:error"; message: string }
  | { type: "file:cleared" };

export function reduceBacklinksState(
  state: BacklinksViewState,
  action: BacklinksAction,
): BacklinksViewState {
  switch (action.type) {
    case "fetch:start":
      return { kind: "loading" };
    case "refresh:start":
      return state.kind === "loaded" || state.kind === "empty"
        ? state
        : { kind: "loading" };
    case "fetch:success": {
      const prevBacklinks = state.kind === "loaded" ? state.backlinks : [];
      const backlinks = stabilizeByKey(
        prevBacklinks,
        action.backlinks,
        backlinkKey,
        (a, b) => a.context === b.context,
      );
      return backlinks.length === 0
        ? { kind: "empty" }
        : { kind: "loaded", backlinks };
    }
    case "fetch:error":
      return { kind: "error", message: action.message };
    case "file:cleared":
      return { kind: "idle" };
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
