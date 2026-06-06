import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
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

/**
 * L4-B persistent search panel. Lives in the left column behind the
 * `Files | Search` toggle. Debounced query into the L4-A `search` IPC;
 * sort + scope chips drive the `SearchQuery`; results render as
 * fixed-height, virtualised, `<mark>`-highlighted cards. A polled
 * `search_index_status` banner shows while the index is still building.
 */
export interface SearchPanelProps {
  vaultId: string | null;
  onNavigate: (path: string) => void;
}

const DEBOUNCE_MS = 200;
const PAGE_LIMIT = 50;
const RESULT_ROW_HEIGHT = 80;
// 80px rows fit fewer per viewport than the 32px file list, so a
// smaller overscan than App.tsx's FILE_LIST_OVERSCAN (8) suffices.
const RESULT_OVERSCAN = 6;
const STATUS_POLL_MS = 500;

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
  const [hasQueried, setHasQueried] = createSignal(false);

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
    if (text.length === 0) {
      setHits([]);
      setHasQueried(false);
      setError(null);
      return;
    }
    setHasQueried(true);
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

  onMount(() => {
    if (!props.vaultId) return;
    void pollStatus();
    ensurePolling();
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
        display: "flex",
        "flex-direction": "column",
        gap: "var(--space-2)",
        border: "1px solid var(--c-border-subtle)",
        "border-radius": "var(--radius-md)",
        background: "var(--c-bg-secondary)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "var(--space-2)" }}>
        <input
          type="text"
          value={queryText()}
          placeholder="Search notes…"
          aria-label="Search notes"
          onInput={(e) => onInput(e.currentTarget.value)}
          style={{
            width: "100%",
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
        <div
          style={{
            display: "flex",
            "flex-wrap": "wrap",
            gap: "var(--space-1)",
            "margin-top": "var(--space-2)",
          }}
        >
          <For each={SORTS}>
            {(s) => (
              <Chip
                label={s.label}
                selected={sort() === s.id}
                onClick={() => onSort(s.id)}
              />
            )}
          </For>
          <span style={{ width: "var(--space-2)" }} />
          <For each={SCOPES}>
            {(s) => (
              <Chip
                label={s.label}
                selected={scope() === s.id}
                onClick={() => onScope(s.id)}
              />
            )}
          </For>
        </div>
      </div>

      <Show when={status()?.state === "building" ? status() : undefined}>
        {(s) => (
          <div
            role="status"
            style={{
              padding: "var(--space-1) var(--space-3)",
              "font-size": "var(--text-xs)",
              color: "var(--c-fg-secondary)",
              "border-top": "1px solid var(--c-border-subtle)",
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
              {hasQueried() ? "No matches" : "Type to search"}
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
              style={{ transform: `translateY(${resultWindow().offsetY}px)` }}
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
  );
};

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
          "font-family": "var(--font-mono)",
          "font-size": "var(--text-xs)",
          color: "var(--c-fg-muted)",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.hit.path}
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
