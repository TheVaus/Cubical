import type { FieldScope, SearchQuery, SortMode } from "../api/ipc";

/**
 * Map the search panel's chip state into the wire `SearchQuery`.
 *
 * `fuzzy` is ON: a single-term, ≥4-char query gets an edit-distance-1
 * clause spanning ALL scope fields, OR'd with the exact + prefix query
 * (see cubical-search query.rs `build_fuzzy_query` /
 * `single_term_fuzzy_spans_all_fields`), so typos like `ricj` → `rich`
 * still match. This used to be OFF because L4-A's fuzzy was `title`-only
 * and discarded the multi-field query; that limitation was fixed in the
 * L4-A revisit (task_256abd1c). The `tags` scope reinterprets the query
 * box as whitespace-separated tag names (AND-matched, lowercased
 * backend-side).
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
    fuzzy: true,
    sort: input.sort,
  };
}
