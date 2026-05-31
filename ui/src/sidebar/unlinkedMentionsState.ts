/**
 * Pure helpers for the L3 Session I Unlinked Mentions panel — mirrors
 * `backlinksState.ts`. Keeping the data-shape logic out of JSX lets us
 * unit-test it without a render harness.
 */

import type { Mention } from "../api/ipc";

/**
 * Stable key for a mention row. `source_path` alone is ambiguous when
 * one source file contains multiple matches; combine with `position`
 * for a tiebreaker.
 */
export function mentionKey(m: Mention): string {
  return `${m.source_path}@${m.position}`;
}

/**
 * View-state machine. `idle` is the no-file-open state; `loading` is
 * between fetch start and the first response for the current file.
 * `empty` / `loaded` / `error` are the terminal states for one fetch.
 *
 * `mention:linked` is an optimistic local update — when the "link it"
 * IPC succeeds the row is removed immediately; the next refresh tick
 * (debounced from `vault:file-changed`) is the source of truth.
 */
export type MentionsViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; mentions: Mention[] }
  | { kind: "error"; message: string };

export type MentionsAction =
  | { type: "fetch:start" }
  | { type: "fetch:success"; mentions: Mention[] }
  | { type: "fetch:error"; message: string }
  | { type: "file:cleared" }
  | { type: "mention:linked"; key: string };

export function reduceMentionsState(
  state: MentionsViewState,
  action: MentionsAction,
): MentionsViewState {
  switch (action.type) {
    case "fetch:start":
      return { kind: "loading" };
    case "fetch:success":
      return action.mentions.length === 0
        ? { kind: "empty" }
        : { kind: "loaded", mentions: action.mentions };
    case "fetch:error":
      return { kind: "error", message: action.message };
    case "file:cleared":
      return { kind: "idle" };
    case "mention:linked": {
      if (state.kind !== "loaded") return state;
      const next = state.mentions.filter((m) => mentionKey(m) !== action.key);
      return next.length === 0
        ? { kind: "empty" }
        : { kind: "loaded", mentions: next };
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
