import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js";

import { buildStableFileGroups, type FileGroup } from "./resultGroups";
import { isSearchNavKey, nextSearchNavIndex } from "./searchNav";
import SearchResultGroup from "./SearchResultGroup";
import { SEARCH_PAGE_LIMIT, type SearchState } from "./searchState";

export interface SearchResultsProps {
  state: SearchState;
  onNavigate: (path: string) => void;
}

const SearchResults: Component<SearchResultsProps> = (props) => {
  let prevGroups: FileGroup[] = [];
  const groups = createMemo(() => {
    prevGroups = buildStableFileGroups(prevGroups, props.state.hits());
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
    setCollapsed(new Set<string>());
  });

  const onResultsKeyDown = (e: KeyboardEvent) => {
    if (!isSearchNavKey(e.key)) return;
    e.preventDefault();
    const next = nextSearchNavIndex(e.key, focusedIdx(), groups().length);
    if (next < 0) return;
    setFocusedIdx(next);
    rowEls[next]?.focus();
  };

  const hitCount = () => props.state.hits().length;

  return (
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
      <Show
        when={
          props.state.status()?.state === "building"
            ? props.state.status()
            : undefined
        }
      >
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

      <Show when={props.state.error()}>
        <div
          role="alert"
          style={{
            padding: "var(--space-1) var(--space-3)",
            "font-size": "var(--text-xs)",
            color: "var(--c-error)",
          }}
        >
          {props.state.error()}
        </div>
      </Show>

      <Show when={hitCount() > 0}>
        <div
          style={{
            padding: "var(--space-1) var(--space-3)",
            "font-size": "var(--text-xs)",
            color: "var(--c-fg-muted)",
            "border-bottom": "1px solid var(--c-border-subtle)",
          }}
        >
          {hitCount()}
          {props.state.total() >= SEARCH_PAGE_LIMIT ? "+" : ""}{" "}
          {hitCount() === 1 ? "result" : "results"}
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
          when={hitCount() > 0}
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
              <SearchResultGroup
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
  );
};

export default SearchResults;
