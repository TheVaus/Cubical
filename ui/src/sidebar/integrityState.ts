import type {
  DanglingLinkGroup,
  RepairCandidate,
  RepairCandidateRank,
} from "../api/ipc";
import { stabilizeByKey } from "../listStability";

export type IntegrityViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; groups: DanglingLinkGroup[]; truncated: boolean }
  | { kind: "error"; message: string };

export type IntegrityAction =
  | { type: "fetch:start" }
  | { type: "refresh:start" }
  | { type: "fetch:success"; groups: DanglingLinkGroup[]; truncated: boolean }
  | { type: "fetch:error"; message: string }
  | { type: "vault:cleared" };

export function groupKey(group: DanglingLinkGroup): string {
  return group.target_raw;
}

function sameGroup(a: DanglingLinkGroup, b: DanglingLinkGroup): boolean {
  return (
    a.missing_path === b.missing_path &&
    a.total === b.total &&
    a.occurrences.length === b.occurrences.length &&
    a.candidates.length === b.candidates.length &&
    a.occurrences.every((o, i) => {
      const other = b.occurrences[i];
      return (
        other !== undefined &&
        o.source_path === other.source_path &&
        o.count === other.count
      );
    }) &&
    a.candidates.every((c, i) => {
      const other = b.candidates[i];
      return other !== undefined && c.path === other.path && c.rank === other.rank;
    })
  );
}

export function reduceIntegrityState(
  state: IntegrityViewState,
  action: IntegrityAction,
): IntegrityViewState {
  switch (action.type) {
    case "fetch:start":
      return { kind: "loading" };
    case "refresh:start":
      return state.kind === "loaded" || state.kind === "empty"
        ? state
        : { kind: "loading" };
    case "fetch:success": {
      const prevGroups = state.kind === "loaded" ? state.groups : [];
      const groups = stabilizeByKey(
        prevGroups,
        action.groups,
        groupKey,
        sameGroup,
      );
      return groups.length === 0
        ? { kind: "empty" }
        : { kind: "loaded", groups, truncated: action.truncated };
    }
    case "fetch:error":
      return { kind: "error", message: action.message };
    case "vault:cleared":
      return { kind: "idle" };
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

const RANK_LABELS: Record<RepairCandidateRank, string> = {
  exact_path: "same path",
  exact_basename: "same name",
  case_insensitive_path: "same path, different case",
  case_insensitive_basename: "same name, different case",
  frontmatter_title: "title matches",
};

export function candidateRankLabel(rank: RepairCandidateRank): string {
  return RANK_LABELS[rank] ?? rank;
}

export function candidateKey(
  group: DanglingLinkGroup,
  candidate: RepairCandidate,
): string {
  return `${group.target_raw}→${candidate.path}`;
}

export function occurrenceSummary(group: DanglingLinkGroup): string {
  const links = group.total === 1 ? "1 link" : `${group.total} links`;
  const notes =
    group.occurrences.length === 1
      ? "1 note"
      : `${group.occurrences.length} notes`;
  return `${links} in ${notes}`;
}

export function reattachActionLabel(
  group: DanglingLinkGroup,
  candidate: RepairCandidate,
): string {
  return `Reattach [[${group.target_raw}]] to ${candidate.path}`;
}
