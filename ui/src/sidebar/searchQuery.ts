import type { FieldScope, SearchQuery, SortMode } from "../api/ipc";

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
