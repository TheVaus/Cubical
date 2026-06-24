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
import { debounce } from "./debounce";
import {
  buildFileGroups,
  type FileGroup,
  type ResultCard,
} from "./resultGroups";
import { buildSearchQuery, type ScopeKind } from "./searchQuery";
import { formatRelativeTime } from "./relativeTime";
import { isSearchNavKey, nextSearchNavIndex } from "./searchNav";
import { errorMessage } from "../errorMessage";

/**
 * L4-B search surface for the left column. A persistent search bar sits
 * above the file tree (passed as `children`); a filter popover to the
 * right of the bar holds the sort + scope controls. Once the query
 * reaches `MIN_QUERY_LEN` characters the file tree is replaced by a
 * `<mark>`-highlighted result list (debounced into the L4-A `search`
 * IPC); below that threshold the file tree shows. Results are grouped by
 * file (Obsidian-core-search style): each hit is a collapsible group
 * with its title, a match-count badge, and one snippet card per matched
 * field. A polled `search_index_status` banner appears above results
 * while the index is still building. The column width is fixed by the
 * parent — every text surface here truncates (`min-width: 0` + ellipsis,
 * snippets wrap) so a long path or title never widens the sidebar.
 *
 * The result list is capped at `PAGE_LIMIT` files and rendered directly
 * (not windowed): variable-height collapsible groups don't fit the
 * fixed-row virtualisation L4-B shipped, and 50 groups of a few cards is
 * a small DOM. Per-occurrence cards (one field hit several times) and
 * windowed grouped scrolling are deferred to the L4-A search revisit.
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
  // Size of the top-K window the backend pulled (min(matches, limit)) —
  // a "are there more?" hint, never a true total (see SearchResponse).
  const [total, setTotal] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<IndexStatus | null>(null);
  const [showFilters, setShowFilters] = createSignal(false);

  /** True once the query is long enough to search (drives tree↔results). */
  const isSearching = () => queryText().trim().length >= MIN_QUERY_LEN;
  /** Non-default sort/scope → badge the filter button. */
  const filtersActive = () => sort() !== "relevance" || scope() !== "default";

  const groups = createMemo(() => buildFileGroups(hits()));
  // Collapsed file paths. Groups default to expanded (like the
  // screenshot); a path is added here only when the user collapses it.
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const toggleCollapsed = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // Roving keyboard focus over the file groups (chip task_bd4e47f4): the
  // result rows were previously mouse-only. `focusedIdx` is -1 when nothing
  // is focused yet, in which case the first row is the lone tab stop so the
  // list is Tab-reachable; arrow keys then move focus within. Native
  // <button> semantics handle Enter/Space → open, so no key handling there.
  const [focusedIdx, setFocusedIdx] = createSignal(-1);
  let rowEls: (HTMLButtonElement | null)[] = [];
  const tabStopIdx = () => (focusedIdx() === -1 ? 0 : focusedIdx());
  // A fresh result set starts with nothing focused.
  createEffect(() => {
    groups();
    setFocusedIdx(-1);
  });
  const onResultsKeyDown = (e: KeyboardEvent) => {
    if (!isSearchNavKey(e.key)) return;
    e.preventDefault();
    const next = nextSearchNavIndex(e.key, focusedIdx(), groups().length);
    if (next < 0) return;
    setFocusedIdx(next);
    rowEls[next]?.focus();
  };

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
      setTotal(0);
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
      setTotal(resp.total_estimated);
      setError(null);
      // A new result set starts fully expanded.
      setCollapsed(new Set<string>());
      if (resp.still_indexing) ensurePolling();
    } catch (e) {
      setError(errorMessage(e));
      // Keep prior hits visible rather than flashing empty.
    }
  };

  const debouncedQuery = debounce(() => void runQuery(), DEBOUNCE_MS);

  const onInput = (value: string) => {
    setQueryText(value);
    debouncedQuery();
  };

  let inputEl: HTMLInputElement | undefined;
  // Clear button: empty the query immediately (no debounce), drop any
  // results, and refocus the input so the user can keep typing.
  const onClear = () => {
    debouncedQuery.cancel();
    setQueryText("");
    setHits([]);
    setTotal(0);
    setError(null);
    inputEl?.focus();
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
          {/* Input + inline clear (X) button on its right edge. */}
          <div style={{ position: "relative", flex: 1, "min-width": 0 }}>
            <input
              ref={inputEl}
              type="text"
              value={queryText()}
              placeholder="Search notes…"
              aria-label="Search notes"
              onInput={(e) => onInput(e.currentTarget.value)}
              style={{
                width: "100%",
                "min-width": 0,
                "box-sizing": "border-box",
                // Extra right padding leaves room for the clear button.
                padding: "var(--space-2) calc(var(--space-3) + 1.5rem) var(--space-2) var(--space-3)",
                "font-family": "var(--font-body)",
                "font-size": "var(--text-sm)",
                color: "var(--c-fg-primary)",
                background: "var(--c-bg-primary)",
                border: "1px solid var(--c-border-subtle)",
                "border-radius": "var(--radius-sm, var(--radius-md))",
              }}
            />
            <Show when={queryText().length > 0}>
              <button
                type="button"
                aria-label="Clear search"
                title="Clear search"
                onClick={onClear}
                style={{
                  position: "absolute",
                  top: "50%",
                  right: "var(--space-2)",
                  transform: "translateY(-50%)",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  width: "1.25rem",
                  height: "1.25rem",
                  padding: 0,
                  color: "var(--c-fg-muted)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </Show>
          </div>
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

      {/* The file tree stays mounted; search results render as an opaque
          LAYER above it — preserving the tree's scroll position + expanded
          folders, with no unmount/reflow when a query comes and goes. */}
      <div
        style={{
          position: "relative",
          flex: 1,
          "min-height": 0,
          "min-width": 0,
          display: "flex",
          "flex-direction": "column",
        }}
      >
        {props.children}
        <Show when={isSearching()}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              "z-index": 1,
              display: "flex",
              "flex-direction": "column",
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

          {/* Result-count line, mirrors the screenshot's "N results". */}
          <Show when={hits().length > 0}>
            <div
              style={{
                padding: "var(--space-1) var(--space-3)",
                "font-size": "var(--text-xs)",
                color: "var(--c-fg-muted)",
                "border-bottom": "1px solid var(--c-border-subtle)",
              }}
            >
              {hits().length}
              {total() >= PAGE_LIMIT ? "+" : ""}{" "}
              {hits().length === 1 ? "result" : "results"}
            </div>
          </Show>

          <div
            role="list"
            aria-label="Search results"
            onKeyDown={onResultsKeyDown}
            style={{
              flex: 1,
              "min-height": 0,
              "min-width": 0,
              "overflow-y": "auto",
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
              <For each={groups()}>
                {(group, i) => (
                  <FileGroupView
                    group={group}
                    collapsed={collapsed().has(group.path)}
                    tabStop={tabStopIdx() === i()}
                    registerRef={(el) => {
                      rowEls[i()] = el;
                    }}
                    onFocus={() => setFocusedIdx(i())}
                    onToggle={() => toggleCollapsed(group.path)}
                    onOpen={() => props.onNavigate(group.path)}
                  />
                )}
              </For>
            </Show>
          </div>
          </div>
        </Show>
      </div>
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

/**
 * One file's result group: a collapsible header (title + recency + a
 * match-count badge) over its snippet cards. The chevron toggles
 * collapse; the title and each card open the file.
 */
const FileGroupView: Component<{
  group: FileGroup;
  collapsed: boolean;
  /** True when this row's title button is the list's single tab stop. */
  tabStop: boolean;
  /** Registers the title button so the parent can move focus to it. */
  registerRef: (el: HTMLButtonElement | null) => void;
  /** Fired when the title button gains focus (e.g. via Tab or click). */
  onFocus: () => void;
  onToggle: () => void;
  onOpen: () => void;
}> = (props) => (
  <div style={{ "min-width": 0, "border-bottom": "1px solid var(--c-border-subtle)" }}>
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "var(--space-2)",
        "min-width": 0,
        padding: "var(--space-2) var(--space-3)",
      }}
    >
      <button
        type="button"
        aria-label={props.collapsed ? "Expand file" : "Collapse file"}
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          "flex-shrink": 0,
          width: "1rem",
          height: "1rem",
          padding: 0,
          color: "var(--c-fg-muted)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          aria-hidden="true"
          style={{
            transform: props.collapsed ? "rotate(-90deg)" : "none",
            transition: "transform 0.1s",
          }}
        >
          <path d="M1 3l4 4 4-4z" />
        </svg>
      </button>
      <button
        type="button"
        ref={props.registerRef}
        tabindex={props.tabStop ? 0 : -1}
        onFocus={props.onFocus}
        onClick={props.onOpen}
        title={props.group.path}
        style={{
          flex: 1,
          "min-width": 0,
          "text-align": "left",
          "font-size": "var(--text-sm)",
          color: "var(--c-fg-primary)",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.group.title}
      </button>
      <span
        style={{
          "flex-shrink": 0,
          "font-family": "var(--font-mono)",
          "font-size": "var(--text-xs)",
          color: "var(--c-fg-muted)",
        }}
      >
        {formatRelativeTime(props.group.mtime_secs)}
      </span>
      <span
        style={{
          "flex-shrink": 0,
          "min-width": "1.25rem",
          "text-align": "center",
          padding: "0 var(--space-1)",
          "font-size": "var(--text-xs)",
          color: "var(--c-fg-secondary)",
          background: "var(--c-bg-secondary)",
          border: "1px solid var(--c-border-subtle)",
          "border-radius": "var(--radius-sm, var(--radius-md))",
        }}
      >
        {props.group.cards.length}
      </span>
    </div>

    <Show when={!props.collapsed}>
      <div style={{ padding: "0 var(--space-3) var(--space-2)", "min-width": 0 }}>
        <For each={props.group.cards}>
          {(card) => <SnippetCard card={card} onClick={props.onOpen} />}
        </For>
      </div>
    </Show>
  </div>
);

/** One snippet card inside a file group; clicking it opens the file. */
const SnippetCard: Component<{ card: ResultCard; onClick: () => void }> = (
  props,
) => (
  <div
    role="button"
    tabindex={-1}
    onClick={props.onClick}
    style={{
      "min-width": 0,
      padding: "var(--space-2)",
      "margin-top": "var(--space-1)",
      "font-size": "var(--text-xs)",
      "line-height": 1.5,
      color: "var(--c-fg-secondary)",
      background: "var(--c-bg-primary)",
      border: "1px solid var(--c-border-subtle)",
      "border-radius": "var(--radius-sm, var(--radius-md))",
      cursor: "pointer",
      "overflow-wrap": "anywhere",
    }}
  >
    <For each={props.card.segments}>
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
  </div>
);

export default SearchPanel;
