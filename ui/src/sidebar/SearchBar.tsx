import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
  type JSX,
} from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import TextInput from "@ds/components/forms/TextInput/TextInput";
import Icon from "@ds/components/graphics/Icon/Icon";

import {
  SEARCH_SCOPES,
  SEARCH_SORTS,
  type SearchState,
} from "./searchState";

export interface SearchBarProps {
  state: SearchState;
}

const SearchBar: Component<SearchBarProps> = (props) => {
  const [showFilters, setShowFilters] = createSignal(false);

  let inputEl: HTMLInputElement | undefined;
  const onClear = () => {
    props.state.clear();
    inputEl?.focus();
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowFilters(false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
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
            value={props.state.queryText()}
            placeholder="Search notes…"
            ariaLabel="Search notes"
            onInput={(v) => props.state.input(v)}
            style={{
              width: "100%",
              "min-width": 0,
              "box-sizing": "border-box",
              padding: "0 calc(var(--space-3) + 2.25rem) 0 var(--space-3)",
            }}
          />
          <Show when={props.state.queryText().length > 0}>
            <span
              style={{
                position: "absolute",
                top: "50%",
                right: "var(--space-1)",
                transform: "translateY(-50%)",
              }}
            >
              <IconButton label="Clear search" onClick={onClear}>
                <Icon name="close" size={12} />
              </IconButton>
            </span>
          </Show>
        </div>
        <IconButton
          label="Search filters"
          title="Filters (sort & scope)"
          ariaExpanded={showFilters()}
          active={props.state.filtersActive() || showFilters()}
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
          data-overlay="filters"
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
            <For each={SEARCH_SORTS}>
              {(s) => (
                <Button
                  size="sm"
                  variant={props.state.sort() === s.id ? "primary" : "secondary"}
                  ariaPressed={props.state.sort() === s.id}
                  onClick={() => props.state.chooseSort(s.id)}
                >
                  {s.label}
                </Button>
              )}
            </For>
          </FilterGroup>
          <FilterGroup label="Scope">
            <For each={SEARCH_SCOPES}>
              {(s) => (
                <Button
                  size="sm"
                  variant={
                    props.state.scope() === s.id ? "primary" : "secondary"
                  }
                  ariaPressed={props.state.scope() === s.id}
                  onClick={() => props.state.chooseScope(s.id)}
                >
                  {s.label}
                </Button>
              )}
            </For>
          </FilterGroup>
        </div>
      </Show>
    </div>
  );
};

const FilterGroup: Component<{ label: string; children: JSX.Element }> = (
  props,
) => (
  <div
    style={{ display: "flex", "flex-direction": "column", gap: "var(--space-1)" }}
  >
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

export default SearchBar;
