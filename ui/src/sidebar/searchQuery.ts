import type { FieldScope, SearchQuery, SortMode } from "../api/ipc";

/**
 * Map the search panel's chip state into the wire `SearchQuery`.
 *
 * `fuzzy` is deliberately OFF. L4-A's backend rewrites a single-term,
 * ≥4-char, default-scope query with `fuzzy: true` into a FuzzyTermQuery
 * against `title` ONLY, discarding the multi-field parsed query — so a
 * word appearing only in body / headings / tags / frontmatter is
 * silently missed (see cubical-search query.rs
 * `single_term_default_fuzzy_is_title_only_known_limitation`). Until that
 * backend behaviour is generalised to span fields, the panel keeps fuzzy
 * off so every default-scope query searches all fields. The `tags` scope
 * reinterprets the query box as whitespace-separated tag names
 * (AND-matched, lowercased backend-side).
 */
export type ScopeKind = FieldScope["kind"];

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
      return { kind: "default" };
  }
}

export function buildSearchQuery(input: QueryInput): SearchQuery {
  return {
    text: input.text,
    limit: input.limit,
    offset: input.offset,
    fields: buildFieldScope(input.scope, input.text),
    fuzzy: false,
    sort: input.sort,
  };
}
