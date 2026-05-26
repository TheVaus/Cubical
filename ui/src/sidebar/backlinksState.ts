/**
 * Pure helpers for the L3 Session C Backlinks panel.
 *
 * The Solid component is a thin shell around these — keeping the
 * data-shape logic out of JSX lets us unit-test it without a render
 * harness, consistent with the rest of the UI codebase (see
 * `properties/coerce.ts` and `properties/inferType.ts`).
 */

import type { Backlink } from "../api/ipc";

/**
 * Stable key for a backlink row. `source_path` alone is ambiguous
 * when one source file contains multiple links to the same target;
 * combine with `position` for a tiebreaker.
 */
export function backlinkKey(b: Backlink): string {
  return `${b.source_path}@${b.position}`;
}

/**
 * Display name for a source-file row: basename minus the `.md`
 * extension. Falls back to the empty string for a trailing-slash
 * input (which should not happen in practice, but we don't want to
 * crash if it does).
 */
export function basenameWithoutExtension(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  if (base.endsWith(".md")) return base.slice(0, -3);
  return base;
}

/**
 * View-state machine for the panel. `idle` is the no-file-open state;
 * `loading` is between fetch start and the first response for the
 * current file. `empty` / `loaded` / `error` are the terminal states
 * for one fetch.
 */
export type BacklinksViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; backlinks: Backlink[] }
  | { kind: "error"; message: string };

export type BacklinksAction =
  | { type: "fetch:start" }
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
    case "fetch:success":
      return action.backlinks.length === 0
        ? { kind: "empty" }
        : { kind: "loaded", backlinks: action.backlinks };
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
