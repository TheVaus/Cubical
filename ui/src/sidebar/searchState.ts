import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Accessor } from "solid-js";

import {
  search as defaultSearch,
  searchIndexStatus as defaultSearchIndexStatus,
  type IndexStatus,
  type SearchHit,
  type SortMode,
} from "../api/ipc";
import { debounce } from "./debounce";
import { buildSearchQuery, type ScopeKind } from "./searchQuery";
import { errorMessage } from "../errorMessage";

const DEBOUNCE_MS = 200;
const STATUS_POLL_MS = 500;
const MIN_QUERY_LEN = 3;

export const SEARCH_PAGE_LIMIT = 50;

export const SEARCH_SORTS: { id: SortMode; label: string }[] = [
  { id: "relevance", label: "Relevance" },
  { id: "recency_desc", label: "Recent" },
];

export const SEARCH_SCOPES: { id: ScopeKind; label: string }[] = [
  { id: "default", label: "All" },
  { id: "headings_only", label: "Headings" },
  { id: "body_only", label: "Body" },
  { id: "code_only", label: "Code" },
  { id: "tags", label: "Tags" },
];

export interface SearchStateDeps {
  vaultId: () => string | null;
  refreshSignal: () => number;
  runSearch?: typeof defaultSearch;
  readStatus?: typeof defaultSearchIndexStatus;
}

export interface SearchState {
  queryText: Accessor<string>;
  sort: Accessor<SortMode>;
  scope: Accessor<ScopeKind>;
  hits: Accessor<SearchHit[]>;
  total: Accessor<number>;
  error: Accessor<string | null>;
  status: Accessor<IndexStatus | null>;
  isSearching: Accessor<boolean>;
  filtersActive: Accessor<boolean>;
  input(value: string): void;
  clear(): void;
  chooseSort(id: SortMode): void;
  chooseScope(id: ScopeKind): void;
}

export function createSearchState(deps: SearchStateDeps): SearchState {
  const runSearch = deps.runSearch ?? defaultSearch;
  const readStatus = deps.readStatus ?? defaultSearchIndexStatus;

  const [queryText, setQueryText] = createSignal("");
  const [sort, setSort] = createSignal<SortMode>("relevance");
  const [scope, setScope] = createSignal<ScopeKind>("default");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [total, setTotal] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<IndexStatus | null>(null);

  const isSearching = () => queryText().trim().length >= MIN_QUERY_LEN;
  const filtersActive = () => sort() !== "relevance" || scope() !== "default";

  let statusTimer: ReturnType<typeof setInterval> | undefined;

  const pollStatus = async () => {
    const id = deps.vaultId();
    if (!id) return;
    try {
      const s = await readStatus({ vault_id: id });
      setStatus(s);
      if (s.state !== "building" && statusTimer !== undefined) {
        clearInterval(statusTimer);
        statusTimer = undefined;
      }
    } catch (e) {
      console.error("searchIndexStatus failed", e);
    }
  };

  const ensurePolling = () => {
    if (statusTimer === undefined) {
      statusTimer = setInterval(() => void pollStatus(), STATUS_POLL_MS);
    }
  };

  const reset = () => {
    setHits([]);
    setTotal(0);
    setError(null);
  };

  const runQuery = async () => {
    const id = deps.vaultId();
    const text = queryText().trim();
    if (!id) return;
    if (text.length < MIN_QUERY_LEN) {
      reset();
      return;
    }
    try {
      const resp = await runSearch({
        vault_id: id,
        query: buildSearchQuery({
          text,
          sort: sort(),
          scope: scope(),
          limit: SEARCH_PAGE_LIMIT,
          offset: 0,
        }),
      });
      setHits(resp.hits);
      setTotal(resp.total_estimated);
      setError(null);
      if (resp.still_indexing) ensurePolling();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const debouncedQuery = debounce(() => void runQuery(), DEBOUNCE_MS);

  createEffect(
    on(deps.refreshSignal, () => {
      if (isSearching()) void runQuery();
    }, { defer: true }),
  );

  onMount(() => {
    if (deps.vaultId()) {
      void pollStatus();
      ensurePolling();
    }
  });

  onCleanup(() => {
    debouncedQuery.cancel();
    if (statusTimer !== undefined) clearInterval(statusTimer);
  });

  return {
    queryText,
    sort,
    scope,
    hits,
    total,
    error,
    status,
    isSearching,
    filtersActive,
    input(value) {
      setQueryText(value);
      debouncedQuery();
    },
    clear() {
      debouncedQuery.cancel();
      setQueryText("");
      reset();
    },
    chooseSort(id) {
      setSort(id);
      void runQuery();
    },
    chooseScope(id) {
      setScope(id);
      void runQuery();
    },
  };
}
