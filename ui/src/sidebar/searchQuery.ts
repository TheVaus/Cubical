import type { FieldScope, SearchQuery, SortMode } from "../api/ipc";

/**
 * Map the search panel's chip state into the wire `SearchQuery`.
 *
 * `fuzzy` is always requested; the backend only applies it to
 * single-term, ≥4-char queries under default scope, so enabling it here
 * just opts into typo tolerance where the backend allows it. The `tags`
 * scope reinterprets the query box as whitespace-separated tag names
 * (AND-matched, lowercased backend-side).
 */
export type ScopeKind =
  | "default"
  | "headings_only"
  | "body_only"
  | "code_only"
  | "tags";

export interface QueryInput {
  text: string;
  sort: SortMode;
  scope: ScopeKind;
  limit: number;
  offset: number;
}

function buildFieldScope(scope: ScopeKind, text: string): FieldScope {
  switch (scope) {
    case "headings_only":
      return { kind: "headings_only" };
    case "body_only":
      return { kind: "body_only" };
    case "code_only":
      return { kind: "code_only" };
    case "tags":
      return {
        kind: "tags",
        tags: text.split(/\s+/).filter((t) => t.length > 0),
      };
    case "default":
    default:
      return { kind: "default" };
  }
}

export function buildSearchQuery(input: QueryInput): SearchQuery {
  return {
    text: input.text,
    limit: input.limit,
    offset: input.offset,
    fields: buildFieldScope(input.scope, input.text),
    fuzzy: true,
    sort: input.sort,
  };
}
