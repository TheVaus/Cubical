import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import {
  search,
  searchIndexStatus,
  type IndexStatus,
  type SearchHit,
  type SortMode,
} from "../api/ipc";
import { computeWindow } from "../virtualList";
import { debounce } from "./debounce";
import { parseHighlights, pickSnippet } from "./snippet";
import { buildSearchQuery, type ScopeKind } from "./searchQuery";
import { formatRelativeTime } from "./relativeTime";

/**
 * L4-B search surface for the left column. A persistent search bar sits
 * above the file tree (passed as `children`); a filter popover to the
 * right of the bar holds the sort + scope controls. Once the query
 * reaches `MIN_QUERY_LEN` characters the file tree is replaced by a
 * virtualised, `<mark>`-highlighted result list (debounced into the
 * L4-A `search` IPC); below that threshold the file tree shows. A polled
 * `search_index_status` banner appears above results while the index is
 * still building. The column width is fixed by the parent — every text
 * surface here truncates (`min-width: 0` + ellipsis) so a long path or
 * snippet never widens the sidebar.
 */
export interface SearchPanelProps {
  vaultId: string | null;
  onNavigate: (path: string) => void;
  /** The file tree, shown when the query is below the search threshold. */
  children: JSX.Element;
  /**
   * Monotonic counter bumped by the parent when vault content changes.
   * The active query re-runs on each change so an edit that now matches
   * (or no longer matches) is reflected without re-typing.
   */
  refreshSignal: number;
}

const DEBOUNCE_MS = 200;
const PAGE_LIMIT = 50;
const RESULT_ROW_HEIGHT = 80;
// 80px rows fit fewer per viewport than the 32px file list, so a
// smaller overscan than App.tsx's FILE_LIST_OVERSCAN (8) suffices.
const RESULT_OVERSCAN = 6;
const STATUS_POLL_MS = 500;
/** Minimum characters before a search fires; below this the tree shows. */
const MIN_QUERY_LEN = 3;

const SORTS: { id: SortMode; label: string }[] = [
  { id: "relevance", label: "Relevance" },
  { id: "recency_desc", label: "Recent" },
];

const SCOPES: { id: ScopeKind; label: string }[] = [
  { id: "default", label: "All" },
  { id: "headings_only", label: "Headings" },
  { id: "body_only", label: "Body" },
  { id: "code_only", label: "Code" },
  { id: "tags", label: "Tags" },
];

const SearchPanel: Component<SearchPanelProps> = (props) => {
  const [queryText, setQueryText] = createSignal("");
  const [sort, setSort] = createSignal<SortMode>("relevance");
  const [scope, setScope] = createSignal<ScopeKind>("default");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<IndexStatus | null>(null);
  const [showFilters, setShowFilters] = createSignal(false);

  /** True once the query is long enough to search (drives tree↔results). */
  const isSearching = () => queryText().trim().length >= MIN_QUERY_LEN;
  /** Non-default sort/scope → badge the filter button. */
  const filtersActive = () => sort() !== "relevance" || scope() !== "default";

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(400);
  const resultWindow = createMemo(() =>
    computeWindow(
      scrollTop(),
      viewportHeight(),
      RESULT_ROW_HEIGHT,
      hits().length,
      RESULT_OVERSCAN,
    ),
  );
  const visibleHits = createMemo(() =>
    hits().slice(resultWindow().startIndex, resultWindow().endIndex),
  );

  let statusTimer: ReturnType<typeof setInterval> | undefined;

  const pollStatus = async () => {
    const id = props.vaultId;
    if (!id) return;
    try {
      const s = await searchIndexStatus({ vault_id: id });
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

  const runQuery = async () => {
    const id = props.vaultId;
    const text = queryText().trim();
    if (!id) return;
    // Below the threshold we show the file tree, not results — clear any
    // stale hits and issue no IPC (comment: ≥3 chars to search).
    if (text.length < MIN_QUERY_LEN) {
      setHits([]);
      setError(null);
      return;
    }
    try {
      const resp = await search({
        vault_id: id,
        query: buildSearchQuery({
          text,
          sort: sort(),
          scope: scope(),
          limit: PAGE_LIMIT,
          offset: 0,
        }),
      });
      setHits(resp.hits);
      setError(null);
      setScrollTop(0);
      if (resp.still_indexing) ensurePolling();
    } catch (e) {
      setError(messageOf(e));
      // Keep prior hits visible rather than flashing empty.
    }
  };

  const debouncedQuery = debounce(() => void runQuery(), DEBOUNCE_MS);

  const onInput = (value: string) => {
    setQueryText(value);
    debouncedQuery();
  };

  const onSort = (id: SortMode) => {
    setSort(id);
    void runQuery();
  };

  const onScope = (id: ScopeKind) => {
    setScope(id);
    void runQuery();
  };

  // Re-run the active query when the parent signals a vault content
  // change. `defer: true` skips the initial run (nothing to refresh yet);
  // only re-query while actually searching (≥ MIN_QUERY_LEN).
  createEffect(
    on(
      () => props.refreshSignal,
      () => {
        if (isSearching()) void runQuery();
      },
      { defer: true },
    ),
  );

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowFilters(false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));

    if (props.vaultId) {
      void pollStatus();
      ensurePolling();
    }
  });

  onCleanup(() => {
    debouncedQuery.cancel();
    if (statusTimer !== undefined) clearInterval(statusTimer);
  });

  return (
    <div
      style={{
        flex: 1,
        "min-height": 0,
        "min-width": 0,
        display: "flex",
        "flex-direction": "column",
        gap: "var(--space-2)",
      }}
    >
      {/* Search bar + filter popover trigger. */}
      <div style={{ position: "relative", "min-width": 0 }}>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "var(--space-1)",
            "min-width": 0,
          }}
        >
          <input
            type="text"
            value={queryText()}
            placeholder="Search notes…"
            aria-label="Search notes"
            onInput={(e) => onInput(e.currentTarget.value)}
            style={{
              flex: 1,
              "min-width": 0,
              "box-sizing": "border-box",
              padding: "var(--space-2) var(--space-3)",
              "font-family": "var(--font-body)",
              "font-size": "var(--text-sm)",
              color: "var(--c-fg-primary)",
              background: "var(--c-bg-primary)",
              border: "1px solid var(--c-border-subtle)",
              "border-radius": "var(--radius-sm, var(--radius-md))",
            }}
          />
          <button
            type="button"
            aria-label="Search filters"
            aria-expanded={showFilters()}
            title="Filters (sort & scope)"
            onClick={() => setShowFilters((v) => !v)}
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              "flex-shrink": 0,
              width: "2rem",
              height: "2rem",
              color:
                filtersActive() || showFilters()
                  ? "var(--c-fg-inverse)"
                  : "var(--c-fg-secondary)",
              background:
                filtersActive() || showFilters()
                  ? "var(--c-accent)"
                  : "var(--c-bg-secondary)",
              border: "1px solid var(--c-border-subtle)",
              "border-radius": "var(--radius-sm, var(--radius-md))",
              cursor: "pointer",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M1.5 2.5h13l-5 6v4.5l-3 1.5V8.5z" />
            </svg>
          </button>
        </div>

        <Show when={showFilters()}>
          {/* Click-away backdrop (mirrors App.tsx's context-menu pattern). */}
          <div
            onClick={() => setShowFilters(false)}
            style={{
              position: "fixed",
              inset: 0,
              "z-index": 12,
              background: "transparent",
            }}
          />
          <div
            role="group"
            aria-label="Search filters"
            style={{
              position: "absolute",
              top: "calc(100% + var(--space-1))",
              right: 0,
              "z-index": 13,
              "min-width": "12rem",
              padding: "var(--space-3)",
              display: "flex",
              "flex-direction": "column",
              gap: "var(--space-3)",
              background: "var(--c-bg-primary)",
              border: "1px solid var(--c-border-subtle)",
              "border-radius": "var(--radius-md)",
              "box-shadow": "var(--shadow-md, 0 6px 24px rgba(0,0,0,0.2))",
            }}
          >
            <FilterGroup label="Sort">
              <For each={SORTS}>
                {(s) => (
                  <Chip
                    label={s.label}
                    selected={sort() === s.id}
                    onClick={() => onSort(s.id)}
                  />
                )}
              </For>
            </FilterGroup>
            <FilterGroup label="Scope">
              <For each={SCOPES}>
                {(s) => (
                  <Chip
                    label={s.label}
                    selected={scope() === s.id}
                    onClick={() => onScope(s.id)}
                  />
                )}
              </For>
            </FilterGroup>
          </div>
        </Show>
      </div>

      {/* Below threshold → file tree; at/over → results. */}
      <Show when={isSearching()} fallback={props.children}>
        <div
          style={{
            flex: 1,
            "min-height": 0,
            "min-width": 0,
            display: "flex",
            "flex-direction": "column",
            border: "1px solid var(--c-border-subtle)",
            "border-radius": "var(--radius-md)",
            background: "var(--c-bg-secondary)",
            overflow: "hidden",
          }}
        >
          <Show when={status()?.state === "building" ? status() : undefined}>
            {(s) => (
              <div
                role="status"
                style={{
                  padding: "var(--space-1) var(--space-3)",
                  "font-size": "var(--text-xs)",
                  color: "var(--c-fg-secondary)",
                  "border-bottom": "1px solid var(--c-border-subtle)",
                }}
              >
                Indexing… {s().indexed_files} / {s().total_files}
              </div>
            )}
          </Show>

          <Show when={error()}>
            <div
              role="alert"
              style={{
                padding: "var(--space-1) var(--space-3)",
                "font-size": "var(--text-xs)",
                color: "var(--c-error)",
              }}
            >
              {error()}
            </div>
          </Show>

          <div
            role="listbox"
            aria-label="Search results"
            ref={(el) => setViewportHeight(el.clientHeight || 400)}
            onScroll={(e) => {
              setScrollTop(e.currentTarget.scrollTop);
              setViewportHeight(e.currentTarget.clientHeight);
            }}
            style={{
              flex: 1,
              "min-height": 0,
              "min-width": 0,
              "overflow-y": "auto",
              position: "relative",
            }}
          >
            <Show
              when={hits().length > 0}
              fallback={
                <div
                  style={{
                    padding: "var(--space-3)",
                    "font-size": "var(--text-sm)",
                    color: "var(--c-fg-muted)",
                  }}
                >
                  No matches
                </div>
              }
            >
              <div
                style={{
                  height: `${resultWindow().totalHeight}px`,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    transform: `translateY(${resultWindow().offsetY}px)`,
                  }}
                >
                  <For each={visibleHits()}>
                    {(hit) => (
                      <ResultRow
                        hit={hit}
                        onClick={() => props.onNavigate(hit.path)}
                      />
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

const FilterGroup: Component<{ label: string; children: JSX.Element }> = (
  props,
) => (
  <div style={{ display: "flex", "flex-direction": "column", gap: "var(--space-1)" }}>
    <span
      style={{
        "font-size": "var(--text-xs)",
        "text-transform": "uppercase",
        "letter-spacing": "0.05em",
        color: "var(--c-fg-muted)",
      }}
    >
      {props.label}
    </span>
    <div style={{ display: "flex", "flex-wrap": "wrap", gap: "var(--space-1)" }}>
      {props.children}
    </div>
  </div>
);

const Chip: Component<{
  label: string;
  selected: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    aria-pressed={props.selected}
    onClick={props.onClick}
    style={{
      padding: "var(--space-1) var(--space-2)",
      "font-family": "var(--font-body)",
      "font-size": "var(--text-xs)",
      color: props.selected ? "var(--c-fg-inverse)" : "var(--c-fg-secondary)",
      background: props.selected ? "var(--c-accent)" : "transparent",
      border: "1px solid var(--c-border-subtle)",
      "border-radius": "var(--radius-sm, var(--radius-md))",
      cursor: "pointer",
    }}
  >
    {props.label}
  </button>
);

const ResultRow: Component<{ hit: SearchHit; onClick: () => void }> = (
  props,
) => {
  const snippet = () => pickSnippet(props.hit.matched_fields);
  return (
    <div
      role="option"
      aria-selected={false}
      onClick={props.onClick}
      style={{
        height: `${RESULT_ROW_HEIGHT}px`,
        "box-sizing": "border-box",
        "min-width": 0,
        padding: "var(--space-2) var(--space-3)",
        "border-bottom": "1px solid var(--c-border-subtle)",
        display: "flex",
        "flex-direction": "column",
        gap: "var(--space-1)",
        cursor: "pointer",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          "font-size": "var(--text-sm)",
          color: "var(--c-fg-primary)",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.hit.title}
      </span>
      <Show when={snippet()}>
        {(s) => (
          <span
            style={{
              "font-size": "var(--text-xs)",
              color: "var(--c-fg-secondary)",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
            }}
          >
            <For each={parseHighlights(s().snippet)}>
              {(seg) =>
                seg.mark ? (
                  <mark
                    style={{
                      background: "var(--c-accent)",
                      color: "var(--c-fg-inverse)",
                      "border-radius": "var(--radius-sm, 2px)",
                      padding: "0 2px",
                    }}
                  >
                    {seg.text}
                  </mark>
                ) : (
                  <span>{seg.text}</span>
                )
              }
            </For>
          </span>
        )}
      </Show>
      <span
        style={{
          display: "flex",
          "justify-content": "space-between",
          gap: "var(--space-2)",
          "min-width": 0,
          "font-family": "var(--font-mono)",
          "font-size": "var(--text-xs)",
          color: "var(--c-fg-muted)",
        }}
      >
        <span
          style={{
            "min-width": 0,
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          {props.hit.path}
        </span>
        <span style={{ "flex-shrink": 0 }}>
          {formatRelativeTime(props.hit.mtime_secs)}
        </span>
      </span>
    </div>
  );
};

function messageOf(e: unknown): string {
  return typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

export default SearchPanel;
