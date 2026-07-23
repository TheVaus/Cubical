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

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import TextInput from "@ds/components/forms/TextInput/TextInput";

import {
  search,
  searchIndexStatus,
  type IndexStatus,
  type SearchHit,
  type SortMode,
} from "../api/ipc";
import { debounce } from "./debounce";
import {
  buildStableFileGroups,
  type FileGroup,
  type ResultCard,
} from "./resultGroups";
import { buildSearchQuery, type ScopeKind } from "./searchQuery";
import { formatRelativeTime } from "./relativeTime";
import { isSearchNavKey, nextSearchNavIndex } from "./searchNav";
import { errorMessage } from "../errorMessage";

export interface SearchPanelProps {
  vaultId: string | null;
  onNavigate: (path: string) => void;
  children: JSX.Element;
  refreshSignal: number;
}

const DEBOUNCE_MS = 200;
const PAGE_LIMIT = 50;
const STATUS_POLL_MS = 500;
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
  const [total, setTotal] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<IndexStatus | null>(null);
  const [showFilters, setShowFilters] = createSignal(false);

  const isSearching = () => queryText().trim().length >= MIN_QUERY_LEN;
  const filtersActive = () => sort() !== "relevance" || scope() !== "default";

  let prevGroups: FileGroup[] = [];
  const groups = createMemo(() => {
    prevGroups = buildStableFileGroups(prevGroups, hits());
    return prevGroups;
  });
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const toggleCollapsed = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const [focusedIdx, setFocusedIdx] = createSignal(-1);
  let rowEls: (HTMLButtonElement | null)[] = [];
  const tabStopIdx = () => (focusedIdx() === -1 ? 0 : focusedIdx());
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
      setCollapsed(new Set<string>());
      if (resp.still_indexing) ensurePolling();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const debouncedQuery = debounce(() => void runQuery(), DEBOUNCE_MS);

  const onInput = (value: string) => {
    setQueryText(value);
    debouncedQuery();
  };

  let inputEl: HTMLInputElement | undefined;
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
      <div style={{ position: "relative", "min-width": 0 }}>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "var(--space-1)",
            "min-width": 0,
          }}
        >
          <div style={{ position: "relative", flex: 1, "min-width": 0 }}>
            <TextInput
              ref={(el) => (inputEl = el)}
              value={queryText()}
              placeholder="Search notes…"
              ariaLabel="Search notes"
              onInput={onInput}
              style={{
                width: "100%",
                "min-width": 0,
                "box-sizing": "border-box",
                padding:
                  "0 calc(var(--space-3) + 2.25rem) 0 var(--space-3)",
              }}
            />
            <Show when={queryText().length > 0}>
              <span
                style={{
                  position: "absolute",
                  top: "50%",
                  right: "var(--space-1)",
                  transform: "translateY(-50%)",
                }}
              >
                <IconButton label="Clear search" onClick={onClear}>
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
                </IconButton>
              </span>
            </Show>
          </div>
          <IconButton
            label="Search filters"
            title="Filters (sort & scope)"
            ariaExpanded={showFilters()}
            active={filtersActive() || showFilters()}
            onClick={() => setShowFilters((v) => !v)}
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
          </IconButton>
        </div>

        <Show when={showFilters()}>
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
                  <Button
                    size="sm"
                    variant={sort() === s.id ? "primary" : "secondary"}
                    ariaPressed={sort() === s.id}
                    onClick={() => onSort(s.id)}
                  >
                    {s.label}
                  </Button>
                )}
              </For>
            </FilterGroup>
            <FilterGroup label="Scope">
              <For each={SCOPES}>
                {(s) => (
                  <Button
                    size="sm"
                    variant={scope() === s.id ? "primary" : "secondary"}
                    ariaPressed={scope() === s.id}
                    onClick={() => onScope(s.id)}
                  >
                    {s.label}
                  </Button>
                )}
              </For>
            </FilterGroup>
          </div>
        </Show>
      </div>

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

const FileGroupView: Component<{
  group: FileGroup;
  collapsed: boolean;
  tabStop: boolean;
  registerRef: (el: HTMLButtonElement | null) => void;
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
      <IconButton
        label={props.collapsed ? "Expand file" : "Collapse file"}
        ariaExpanded={!props.collapsed}
        onClick={props.onToggle}
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
      </IconButton>
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
