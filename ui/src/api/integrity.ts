import { invoke } from "./transport";

export interface ListDanglingLinksRequest {
  vault_id: string;
  limit?: number;
}

export type RepairCandidateRank =
  | "exact_path"
  | "exact_basename"
  | "case_insensitive_path"
  | "case_insensitive_basename"
  | "frontmatter_title";

export interface RepairCandidate {
  path: string;
  rank: RepairCandidateRank;
}

export interface DanglingLinkOccurrence {
  source_path: string;
  count: number;
}

export interface DanglingLinkGroup {
  target_raw: string;
  missing_path: string | null;
  total: number;
  occurrences: DanglingLinkOccurrence[];
  candidates: RepairCandidate[];
}

export interface ListDanglingLinksResponse {
  groups: DanglingLinkGroup[];
  truncated: boolean;
}

export interface RepairDanglingLinkRequest {
  vault_id: string;
  target_raw: string;
  to_path: string;
}

export interface RepairDanglingLinkResponse {
  files_rewritten: number;
  refs_updated: number;
  pending_count: number;
}

export function listDanglingLinks(
  req: ListDanglingLinksRequest,
): Promise<ListDanglingLinksResponse> {
  return invoke("list_dangling_links", { req });
}

export function repairDanglingLink(
  req: RepairDanglingLinkRequest,
): Promise<RepairDanglingLinkResponse> {
  return invoke("repair_dangling_link", { req });
}
