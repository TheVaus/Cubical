import { invoke } from "./transport";

export type FieldScope =
  | { kind: "default" }
  | { kind: "headings_only" }
  | { kind: "body_only" }
  | { kind: "code_only" }
  | { kind: "tags"; tags: string[] };

export type SortMode = "relevance" | "recency_desc";

export interface SearchQuery {
  text: string;
  limit: number;
  offset: number;
  fields: FieldScope;
  fuzzy: boolean;
  sort: SortMode;
}

export interface MatchedField {
  field: string;
  snippet: string;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  mtime_secs: number;
  matched_fields: MatchedField[];
  tags: string[];
}

export interface SearchResponse {
  hits: SearchHit[];
  total_estimated: number;
  took_ms: number;
  still_indexing: boolean;
}

export interface SearchRequest {
  vault_id: string;
  query: SearchQuery;
}

export interface SearchVaultRequest {
  vault_id: string;
}

export type IndexState = "building" | "ready" | "error";

export interface IndexStatus {
  state: IndexState;
  indexed_files: number;
  total_files: number;
  last_commit_secs: number | null;
}

export interface IndexHealth {
  schema_version: number;
  segments: number;
  doc_count: number;
  disk_bytes: number;
}

export function search(req: SearchRequest): Promise<SearchResponse> {
  return invoke("search", { req });
}

export function searchIndexStatus(
  req: SearchVaultRequest,
): Promise<IndexStatus> {
  return invoke("search_index_status", { req });
}

export function searchRebuildIndex(req: SearchVaultRequest): Promise<void> {
  return invoke("search_rebuild_index", { req });
}

export function searchGetHealth(req: SearchVaultRequest): Promise<IndexHealth> {
  return invoke("search_get_health", { req });
}
