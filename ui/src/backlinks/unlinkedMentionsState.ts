import type { Mention } from "../api/mentions";
import { stabilizeByKey } from "../core/listStability";

export function mentionKey(m: Mention): string {
  return `${m.source_path}@${m.position}`;
}

export type MentionsViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; mentions: Mention[] }
  | { kind: "error"; message: string };

export type MentionsAction =
  | { type: "fetch:start" }
  | { type: "refresh:start" }
  | { type: "fetch:success"; mentions: Mention[] }
  | { type: "fetch:error"; message: string }
  | { type: "file:cleared" }
  | { type: "mention:linked"; mention: Mention };

export function reduceMentionsState(
  state: MentionsViewState,
  action: MentionsAction,
): MentionsViewState {
  switch (action.type) {
    case "fetch:start":
      return { kind: "loading" };
    case "refresh:start":
      return state.kind === "loaded" || state.kind === "empty"
        ? state
        : { kind: "loading" };
    case "fetch:success": {
      const prevMentions = state.kind === "loaded" ? state.mentions : [];
      const mentions = stabilizeByKey(
        prevMentions,
        action.mentions,
        mentionKey,
        (a, b) => a.context === b.context && a.needle === b.needle,
      );
      return mentions.length === 0
        ? { kind: "empty" }
        : { kind: "loaded", mentions };
    }
    case "fetch:error":
      return { kind: "error", message: action.message };
    case "file:cleared":
      return { kind: "idle" };
    case "mention:linked": {
      if (state.kind !== "loaded") return state;
      const linked = action.mention;
      const next = state.mentions.filter(
        (m) =>
          m.source_path !== linked.source_path || m.position < linked.position,
      );
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
